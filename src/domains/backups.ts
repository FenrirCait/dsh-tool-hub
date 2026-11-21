/**
 * Backups: the patch and state copies every write leaves behind, one conservative cleaner, and the
 * MCP restore path that reads a single row back out of a patch backup.
 *
 * Two folders exist and both are listed: state backups live beside the state file
 * (core/io backupDir), byte-level patch copies live under DSH_HOME/backups (mcp.ts backupsDir).
 * Nothing here writes a backup; the writers do. Cleaning is explicit, keeps the newest N by
 * default, only removes regular files, and reports what it freed.
 *
 * Restoring one MCP row never re-serializes a document: it splices the backup row's lines into the
 * current patch through mcp.ts's commit path (lock, backup, atomic write, host verification), so
 * every other row, comment and line ending survives byte for byte.
 */
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { backupDir } from '../core/io.js'
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { OpDefinition } from '../shared/types.js'
import {
  backupsDir,
  commitMcpRowSpan,
  parseMcpRows,
  patchPathFor,
  readPatchText,
  replaceMcpRowSpan,
  rowText,
  splitDocument,
  type McpRow,
} from './mcp.js'
import { asRecord, fail, failureOf } from './tool-surface.js'

/** The MCP index returns at most this many backups. */
const INDEX_LIMIT = 200

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

/** One backup as the MCP tab sees it: which rows it holds, never the row text. */
export interface McpBackupRow {
  name: string
  kind: 'state' | 'patch'
  bytes: number
  modifiedAt: number
  ids: string[]
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

async function readBackupFile(row: BackupRow): Promise<string | null> {
  try {
    return await readFile(join(row.dir, row.name), 'utf8')
  }
  catch {
    return null
  }
}

/** Every backup that carries at least one MCP row, newest first, ids deduped and in file order. */
export async function mcpBackupIndex(): Promise<{ backups: McpBackupRow[] }> {
  const scan = await scanBackups()
  const backups: McpBackupRow[] = []
  for (const row of scan.rows) {
    if (backups.length >= INDEX_LIMIT) break
    const text = await readBackupFile(row)
    // Unreadable, binary and non-patch backups are not restorable rows; they simply are not listed.
    if (text === null) continue
    const ids: string[] = []
    const seen = new Set<string>()
    for (const mcpRow of parseMcpRows(text)) {
      if (seen.has(mcpRow.id)) continue
      seen.add(mcpRow.id)
      ids.push(mcpRow.id)
    }
    if (ids.length === 0) continue
    backups.push({ name: row.name, kind: row.kind, bytes: row.bytes, modifiedAt: row.modifiedAt, ids })
  }
  return { backups }
}

/** One backup by the name the index reported; a path or an invented name is not a backup. */
async function namedBackup(name: string): Promise<{ text: string; row: BackupRow }> {
  const scan = await scanBackups()
  const row = scan.rows.find(entry => entry.name === name)
  if (row === undefined) throw fail('unknown-backup', 'no backup named "' + name + '"')
  const text = await readBackupFile(row)
  if (text === null) throw fail('backup-unreadable', 'backup "' + name + '" could not be read')
  return { text, row }
}

function findRow(text: string, id: string, where: string): McpRow {
  const row = parseMcpRows(text).find(candidate => candidate.id === id)
  if (row === undefined) throw fail('unknown-mcp', where + ' has no MCP row "' + id + '"')
  return row
}

function askedText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Longest-common-subsequence line diff; row spans are small, so the simple table is enough. */
function diffLines(before: string, after: string): Array<{ kind: 'same' | 'add' | 'del'; text: string }> {
  const left = before.split(/\r?\n/)
  const right = after.split(/\r?\n/)
  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    const row = table[i]
    const below = table[i + 1]
    if (row === undefined || below === undefined) continue
    for (let j = right.length - 1; j >= 0; j -= 1) {
      row[j] = left[i] === right[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: Array<{ kind: 'same' | 'add' | 'del'; text: string }> = []
  let i = 0
  let j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      out.push({ kind: 'same', text: left[i] ?? '' })
      i += 1
      j += 1
      continue
    }
    // Deleting first keeps a changed line pair readable as "old, then new".
    if (i < left.length && (j >= right.length || (table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0))) {
      out.push({ kind: 'del', text: left[i] ?? '' })
      i += 1
      continue
    }
    out.push({ kind: 'add', text: right[j] ?? '' })
    j += 1
  }
  return out
}

function diffHandler(): OpHandler {
  return async (payload, env) => {
    const body = asRecord(payload)
    const name = askedText(body, 'backup')
    const id = askedText(body, 'id')
    if (name === '') throw fail('bad-payload', 'backup is required')
    if (id === '') throw fail('bad-payload', 'id is required')
    const entry = await namedBackup(name)
    const backupRow = findRow(entry.text, id, 'the backup')
    const patch = patchPathFor(env)
    if (patch === null) throw fail('no-patch', 'this profile has no cordis.patch.yml to compare against')
    const current = await readPatchText(patch)
    const liveRow = findRow(current, id, 'the profile patch')
    const before = rowText(entry.text, backupRow)
    const after = rowText(current, liveRow)
    return { backup: name, id, changed: before !== after, before, after, lines: diffLines(before, after) }
  }
}

function restoreHandler(): OpHandler {
  return async (payload, env) => {
    const body = asRecord(payload)
    const name = askedText(body, 'backup')
    const id = askedText(body, 'id')
    if (name === '') throw fail('bad-payload', 'backup is required')
    if (id === '') throw fail('bad-payload', 'id is required')
    const entry = await namedBackup(name)
    const backupRow = findRow(entry.text, id, 'the backup')
    const patch = patchPathFor(env)
    if (patch === null) throw fail('no-patch', 'this profile has no cordis.patch.yml to edit')
    const doc = splitDocument(entry.text)
    const rowLines = doc.lines.slice(backupRow.startLine, backupRow.endLine)
    const expectedName = typeof backupRow.config.serverName === 'string' ? backupRow.config.serverName : backupRow.id
    const written = await commitMcpRowSpan(env, patch, id, (current) => {
      // The row has to exist in the file as it is now, not just in the backup.
      findRow(current, id, 'the profile patch')
      return { next: replaceMcpRowSpan(current, id, rowLines), expectedName }
    }, { op: 'restoreRow' })
    return { ok: true, id, backup: name, verify: written.verify }
  }
}

const OPS: OpDefinition[] = [
  { id: 'backup.list', write: false, audit: false, note: 'Lists state and patch backups with sizes, newest first; never writes.' },
  { id: 'backup.clean', write: true, audit: true, note: 'Removes backups beyond the newest keep (optionally only older than N days).' },
  { id: 'backup.mcpIndex', write: false, audit: false, note: 'Lists the backups that carry MCP rows, newest first, with the row ids each one holds.' },
  { id: 'backup.diff', write: false, audit: false, note: 'Line diff between one MCP row in a backup and the same row in the live patch.' },
  { id: 'backup.restoreRow', write: true, audit: true, note: 'Puts one MCP row back from a backup verbatim, backed up and verified; no other row or byte changes.' },
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
      'backup.mcpIndex': async () => await mcpBackupIndex(),
      'backup.diff': diffHandler(),
      'backup.restoreRow': restoreHandler(),
    },
  }
}
