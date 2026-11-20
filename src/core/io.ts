import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { migrate, STATE_VERSION, type StateV2 } from './state.js'
import { withFileLock, writeJsonAtomic } from './atomic.js'

/**
 * State persistence: where the file lives, how it is backed up, and how a damaged file is
 * recovered.
 *
 * Invariants this module keeps:
 * - A write is a backup followed by one atomic rename, under a cross-process lock, so two writers
 *   cannot interleave and a crash leaves a readable file.
 * - A read never invents data: a corrupt file is reported, the newest backup that still parses is
 *   used, and the damaged file is moved aside instead of being overwritten in place.
 * - Nothing here throws for a foreseeable file problem (missing, unreadable, malformed); the caller
 *   gets a structured result and decides what the UI says.
 */

/** Backups kept on disk; the newest is the one recovery reaches for. */
export const BACKUP_LIMIT = 20

const BACKUP_DIR = 'backups'
/** `state-<ISO stamp with : and . replaced by ->-<label>.json`; the stamp sorts lexicographically. */
const BACKUP_NAME = /^state-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-[^/\\]*)?\.json$/

function dshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim() ?? ''
  return fromEnv === '' ? join(homedir(), '.dsh') : resolve(fromEnv)
}

/** Where the state lives. TOOL_HUB_STATE_FILE keeps the 1.x override working (sandbox profiles). */
export function stateFile(): string {
  const override = process.env.TOOL_HUB_STATE_FILE?.trim() ?? ''
  if (override !== '') return resolve(override)
  return join(dshHome(), 'tool-hub', 'state.json')
}

export function stateDir(): string {
  return dirname(stateFile())
}

export function backupDir(): string {
  return join(stateDir(), BACKUP_DIR)
}

/** The state lock. A sibling of the state file, so the sandbox override isolates it too. */
export function lockFile(): string {
  return join(stateDir(), '.state.lock')
}

export interface LoadedState {
  state: StateV2
  /** Absolute path of the backup the state came from; null on a normal load. */
  recovered: string | null
  /** Why the file could not be used as it was; null when it loaded cleanly. */
  error: string | null
  /** Where the unusable file was moved to; null when nothing was moved. */
  quarantined: string | null
}

type ParseAttempt = { ok: true; state: StateV2 } | { ok: false; reason: string }

/** Parse plus migrate, with every failure turned into a reason string instead of an exception. */
function parseState(text: string, label: string): ParseAttempt {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch (error) {
    return { ok: false, reason: `invalid JSON in ${label}: ${(error as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: `state document is not a JSON object: ${label}` }
  }
  return { ok: true, state: migrate(parsed) }
}

/** The stamp embedded in a backup name, or null for a name this build cannot date. */
function stampOf(name: string): string | null {
  const match = BACKUP_NAME.exec(name)
  return match === null ? null : match.slice(1, 8).join('')
}

/** Backups on disk, oldest first. */
async function listBackups(): Promise<Array<{ name: string; path: string; stamp: string | null }>> {
  const dir = backupDir()
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter(name => name.startsWith('state-') && name.endsWith('.json'))
  const entries = names.map(name => ({ name, path: join(dir, name), stamp: stampOf(name) }))
  entries.sort((left, right) => {
    // A dated backup always outranks an undated one, so a stray file cannot win recovery.
    const a = left.stamp === null ? `0${left.name}` : `1${left.stamp}`
    const b = right.stamp === null ? `0${right.name}` : `1${right.stamp}`
    return a < b ? -1 : a > b ? 1 : 0
  })
  return entries
}

/** Backup paths, newest first; at most `limit` of them. */
export async function recentBackups(limit = BACKUP_LIMIT): Promise<string[]> {
  const entries = await listBackups()
  const slice = limit > 0 ? entries.slice(Math.max(0, entries.length - limit)) : entries
  return slice.reverse().map(entry => entry.path)
}

/** The newest backup, or null when none exists. */
export async function latestBackup(): Promise<string | null> {
  return (await recentBackups(1))[0] ?? null
}

/** Keep only the newest BACKUP_LIMIT backups. */
async function pruneBackups(): Promise<void> {
  const entries = await listBackups()
  const extra = entries.slice(0, Math.max(0, entries.length - BACKUP_LIMIT))
  for (const entry of extra) await unlink(entry.path).catch(() => {})
}

function backupLabel(reason: string): string {
  const clean = reason.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return clean === '' ? 'manual' : clean
}

/** A backup path that does not collide with one taken in the same millisecond. */
async function uniqueBackupPath(dir: string, reason: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const label = backupLabel(reason)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`
    const candidate = join(dir, `state-${stamp}-${label}${suffix}.json`)
    const taken = await stat(candidate).then(() => true, () => false)
    if (!taken) return candidate
  }
  return join(dir, `state-${stamp}-${label}-${randomBytes(3).toString('hex')}.json`)
}

/**
 * Copy the current state into the backup directory before an operation that can replace it
 * wholesale. Returns the backup path, or null when there is no state file yet.
 *
 * The copy lands under a temp name and is renamed into place, so a half-written backup can never
 * be the one recovery picks. Old backups beyond BACKUP_LIMIT are removed afterwards.
 */
export async function backupState(reason: string): Promise<string | null> {
  const file = stateFile()
  const info = await stat(file).catch(() => null)
  if (info === null || !info.isFile()) return null
  const dir = backupDir()
  await mkdir(dir, { recursive: true })
  const target = await uniqueBackupPath(dir, reason)
  const temp = `${target}.${process.pid}.tmp`
  try {
    await copyFile(file, temp)
    await rename(temp, target)
  }
  catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  await pruneBackups()
  return target
}

/**
 * Move a damaged state file aside so it is not read again, and keep its bytes for inspection.
 * Returns the new path, or null when the move was not possible (the damage stays in place).
 */
async function quarantine(file: string): Promise<string | null> {
  const target = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    await rename(file, target)
    return target
  }
  catch {
    return null
  }
}

/**
 * Read, validate and migrate the state.
 *
 * A missing file is a fresh install, not an error. A file that is not valid JSON (or is JSON but
 * not an object) is reported, then replaced by the newest backup that still parses — the damaged
 * bytes are moved to `<state>.corrupt-<stamp>` first. When no backup parses, the damaged file is
 * left exactly where it is and the caller gets an empty state plus the reason.
 */
export async function loadState(): Promise<LoadedState> {
  const file = stateFile()
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: migrate(null), recovered: null, error: null, quarantined: null }
    return {
      state: migrate(null),
      recovered: null,
      error: `state file unreadable (${code ?? 'unknown error'}): ${file}`,
      quarantined: null,
    }
  }
  const primary = parseState(text, file)
  if (primary.ok) return { state: primary.state, recovered: null, error: null, quarantined: null }
  for (const backup of await recentBackups()) {
    const backupText = await readFile(backup, 'utf8').catch(() => null)
    if (backupText === null) continue
    const restored = parseState(backupText, backup)
    if (!restored.ok) continue
    return { state: restored.state, recovered: backup, error: primary.reason, quarantined: await quarantine(file) }
  }
  return {
    state: migrate(null),
    recovered: null,
    error: `${primary.reason}; no usable backup in ${backupDir()}`,
    quarantined: null,
  }
}

/**
 * Persist a v2 document: take the cross-process lock, back the previous file up, then replace it
 * with one atomic write. Returns the backup path (null on the first save).
 *
 * The document goes through migrate first, so a caller that hands over a partially built object
 * still writes a file this build can read back.
 */
export async function saveState(state: StateV2, reason: string): Promise<string | null> {
  return withFileLock(lockFile(), async () => {
    const backup = await backupState(reason)
    await writeJsonAtomic(stateFile(), { ...migrate(state), version: STATE_VERSION })
    return backup
  })
}
