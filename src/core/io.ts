import { readFile, readdir, copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { migrate, STATE_VERSION, type StateV2 } from './state.js'
import { withFileLock, writeJsonAtomic } from './atomic.js'

/** Where the state lives. TOOL_HUB_STATE_FILE keeps the existing override working. */
export function stateFile(): string {
  const override = process.env.TOOL_HUB_STATE_FILE
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'tool-hub', 'state.json')
}

export function stateDir(): string {
  return dirname(stateFile())
}

export function lockFile(): string {
  return join(stateDir(), '.state.lock')
}

export interface LoadedState { state: StateV2; recovered: string | null }

function normalize(raw: unknown): StateV2 {
  const migrated = migrate(raw)
  return { ...migrated, version: STATE_VERSION }
}

/** Read + migrate. A corrupt file is reported, not silently replaced with an empty state. */
export async function loadState(): Promise<LoadedState> {
  const file = stateFile()
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: normalize(null), recovered: null }
    throw error
  }
  try {
    return { state: normalize(JSON.parse(text)), recovered: null }
  }
  catch {
    const backup = await latestBackup()
    if (backup === null) throw new Error(`state file is not valid JSON and no backup exists: ${file}`)
    const recovered = normalize(JSON.parse(await readFile(backup, 'utf8')))
    return { state: recovered, recovered: backup }
  }
}

/** Keep the last N backups; the newest is used by corrupt-state recovery. */
const KEEP_BACKUPS = 20

export async function latestBackup(): Promise<string | null> {
  const dir = join(stateDir(), 'backups')
  const names = await readdir(dir).catch(() => [] as string[])
  const candidates = names.filter(name => /^state-.*\.json$/.test(name)).sort()
  const last = candidates[candidates.length - 1]
  return last === undefined ? null : join(dir, last)
}

export async function backupState(reason: string): Promise<string | null> {
  const file = stateFile()
  const info = await stat(file).catch(() => null)
  if (info === null || !info.isFile()) return null
  const dir = join(stateDir(), 'backups')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `state-${stamp}-${reason.replace(/[^a-z0-9-]+/gi, '-')}.json`)
  await copyFile(file, target)
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => /^state-.*\.json$/.test(name)).sort()
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) await unlink(join(dir, name)).catch(() => {})
  return target
}

/** Read-modify-write under one cross-process lock; the backup is written before the change. */
export async function saveState(state: StateV2, reason: string): Promise<string | null> {
  return withFileLock(lockFile(), async () => {
    const backup = await backupState(reason)
    await writeJsonAtomic(stateFile(), { ...state, version: STATE_VERSION })
    return backup
  })
}
