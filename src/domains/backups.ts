/**
 * Backups: the patch and state copies every write leaves behind, and one conservative cleaner.
 *
 * Two folders exist and both are listed: state backups live beside the state file
 * (core/io backupDir), byte-level patch copies live under DSH_HOME/backups (mcp.ts backupsDir).
 * Nothing here writes a backup; the writers do. Cleaning is explicit, keeps the newest N by
 * default, only removes regular files, and reports what it freed.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { backupDir } from '../core/io.js'
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { OpDefinition } from '../shared/types.js'
import { asRecord, fail, failureOf } from './tool-surface.js'
import { backupsDir } from './mcp.js'

export interface BackupRow {
  name: string
  dir: string
  kind: 'state' | 'patch'
  bytes: number
  modifiedAt: number
}

export interface BackupScan {
  dirs: Array<{ kind: 'state' | 'patch'; dir: string }>
  rows: BackupRow[]
  bytes: number
  error: string | null
}

function locations(): Array<{ kind: 'state' | 'patch'; dir: string }> {
  const out: Array<{ kind: 'state' | 'patch'; dir: string }> = [
    { kind: 'state', dir: backupDir() },
    { kind: 'patch', dir: backupsDir() },
  ]
  const seen = new Set<string>()
  return out.filter(entry => {
    if (seen.has(entry.dir)) return false
    seen.add(entry.dir)
    return true
  })
}

/** Every regular file in both backup folders, newest first. A missing folder is empty, not an error. */
export async function scanBackups(): Promise<BackupScan> {
  const dirs = locations()
  const rows: BackupRow[] = []
  const problems: string[] = []
  for (const entry of dirs) {
    let names: string[]
    try {
      names = await readdir(entry.dir)
    }
    catch {
      continue
    }
    for (const name of names) {
      const path = join(entry.dir, name)
      try {
        const info = await stat(path)
        if (!info.isFile()) continue
        rows.push({ name: basename(path), dir: entry.dir, kind: entry.kind, bytes: info.size, modifiedAt: info.mtimeMs })
      }
      catch (error) {
        problems.push(name + ': ' + String((error as Error)?.message ?? error))
      }
    }
  }
  rows.sort((left, right) => right.modifiedAt - left.modifiedAt)
  return { dirs, rows, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), error: problems.length === 0 ? null : problems.slice(0, 3).join('; ') }
}

function cleanHandler(): OpHandler {
  return async (payload, env) => {
    const body = asRecord(payload)
    const keepRaw = body.keep
    const keep = typeof keepRaw === 'number' && Number.isFinite(keepRaw) ? Math.trunc(keepRaw) : 50
    if (keep < 0 || keep > 2000) throw fail('bad-payload', 'keep must be between 0 and 2000')
    const daysRaw = body.olderThanDays
    const days = typeof daysRaw === 'number' && Number.isFinite(daysRaw) ? daysRaw : 0
    if (days !== 0 && (days < 1 || days > 3650)) throw fail('bad-payload', 'olderThanDays must be 0 or between 1 and 3650')
    if (keep === 0 && days === 0) throw fail('confirm-required', 'cleaning every backup needs olderThanDays')
    const scan = await scanBackups()
    const cutoff = days === 0 ? null : Date.now() - days * 24 * 60 * 60 * 1000
    const doomed: BackupRow[] = []
    for (const [index, row] of scan.rows.entries()) {
      if (index < keep) continue
      if (cutoff !== null && row.modifiedAt >= cutoff) continue
      doomed.push(row)
    }
    // Keep destructive work inside the folders this domain just listed.
    const allowed = new Set(scan.dirs.map(entry => entry.dir))
    let freed = 0
    const deleted: string[] = []
    for (const row of doomed) {
      if (!allowed.has(row.dir)) continue
      try {
        await rm(join(row.dir, row.name), { force: true })
        freed += row.bytes
        deleted.push(row.name)
      }
      catch (error) {
        failureOf(error)
      }
    }
    const remaining = scan.rows.length - deleted.length
    return { deleted: deleted.length, freed, remaining, kept: keep, olderThanDays: days, removed: deleted.slice(0, 20) }
  }
}

const OPS: OpDefinition[] = [
  { id: 'backup.list', write: false, audit: false, note: 'Lists state and patch backups with sizes, newest first; never writes.' },
  { id: 'backup.clean', write: true, audit: true, note: 'Removes backups beyond the newest keep (optionally only older than N days).' },
]

export function backupsDomain(): DomainRegistration {
  return {
    module: {
      id: 'backup',
      title: { zh: '备份', en: 'Backups' },
      ops: OPS,
    },
    handlers: {
      'backup.list': async () => await scanBackups(),
      'backup.clean': cleanHandler(),
    },
  }
}
