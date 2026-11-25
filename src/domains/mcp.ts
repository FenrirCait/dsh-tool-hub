/**
 * MCP domain: the servers a profile declares as `@deepseek-ai/dsh-mcp-client` rows in its
 * `cordis.patch.yml`, with one row's `config` block editable at a time.
 *
 * The whole point of this file is byte fidelity. A patch file is hand-written YAML carrying
 * comments, ordering and someone's careful indentation, so a writer here never re-serializes the
 * document: it locates one row, replaces the lines of that row's `config` block (or splices the
 * whole row for `rawSave`), and joins the rest back with the file's own line ending and
 * final-newline habit. Everything else — comments, blank lines, sibling rows — comes out identical.
 *
 * Writes follow one path: parse, back up, take `<patch>.panel.lock` (the same lock name
 * dsh-skill-mcp-panel takes, so two panels cannot interleave), write through a temp file, then ask
 * the host whether it loaded the row. If the host says no, the previous text goes back — but only
 * while the file still holds exactly what this call wrote.
 *
 * State bookkeeping (which backup the last write produced) goes through env.save(reason); this
 * module never opens state.json itself.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '../core/atomic.js'
import { scanPatchBlocks } from '../core/patch-blocks.js'
import { stateDir } from '../core/io.js'
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { OpDefinition } from '../shared/types.js'

export const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
/** Text fields the panel can edit, in form order. */
export const SCALAR_KEYS = ['serverName', 'transport', 'command', 'cwd', 'url', 'toolCallTimeoutMs', 'failOnStartupError'] as const
/** The config keys that carry credentials; their values never leave the host unmasked. */
const SECRET_FIELDS = ['env', 'headers'] as const
const MCP_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,120}$/
/** A `${NAME}` template becomes an expression the loader evaluates, not a literal string. */
const SECRET_TEMPLATE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
/** `rawSave` waits this long before asking the host whether it loaded the row. */
const RAW_VERIFY_DELAY_MS = 900
const VERIFY_RETRY_MS = 300
const LOCK_TIMEOUT_MS = 5000

export interface PatchDoc {
  lines: string[]
  eol: string
  trailing: boolean
  tail: string
}

export interface McpRow {
  id: string
  name: string | null
  disabled: boolean
  config: Record<string, unknown>
  startLine: number
  endLine: number
  configStart: number
  configEnd: number
  indent: number
  /** 0-based position among rows that share this id, in file order. */
  occurrence: number
  /** The other panel that owns this row's managed block, or null. */
  managedBy: string | null
}

/** What the loader knows about one MCP entry; the join half of mergeMcpRows. */
export interface LoaderRow {
  id: string
  moduleName: string
  patchId: string | null
  enabled: boolean
  manageable: boolean
}

/** One server as the panel shows it: patch truth plus loader truth. */
export interface McpServerRow {
  id: string
  patchId: string | null
  entryId: string | null
  occurrence: number
  managedBy: string | null
  readOnlyReason: string | null
  name: string
  transport: string
  command: string
  url: string
  enabled: boolean
  manageable: boolean
  editable: boolean
  config: Record<string, unknown> | null
  secretKeys: { env: string[]; headers: string[] }
  disabled: boolean
}

export interface DomainFailure {
  ok: false
  code: string
  message: string
}

export class McpError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'McpError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new McpError(code, message)
}

export function failureOf(error: unknown): DomainFailure {
  if (error instanceof McpError) return { ok: false, code: error.code, message: error.message }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, code: typeof code === 'string' ? code : 'internal', message: error.message }
  }
  return { ok: false, code: 'internal', message: String(error) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when child really sits inside parent (a prefix check would accept ../patch). */
function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  // relative answers with an absolute path when the two are on different Windows drives.
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function envText(name: string): string {
  const value = process.env[name]
  return typeof value === 'string' ? value.trim() : ''
}

function dshHomeDir(): string {
  const fromEnv = envText('DSH_HOME')
  return fromEnv === '' ? dirname(stateDir()) : fromEnv
}

/** Every byte-level edit lands a copy here first (1.x used the same folder and name shape). */
export function backupsDir(): string {
  return join(dshHomeDir(), 'backups')
}

/**
 * The patch file the running profile actually reads.
 *
 * configEditor.documentPath is host-supplied and cannot be trusted as-is: a wrong or hostile value
 * would point every MCP write at an arbitrary file. It is accepted only when it resolves inside the
 * profile directory and still names cordis.patch.yml; otherwise the profile's own patch path is used.
 */
export function patchPathFor(env: HostEnv): string | null {
  const profile = env.services.get('profileContext') as { dir?: unknown } | undefined
  const profileDir = typeof profile?.dir === 'string' && profile.dir !== '' ? resolve(profile.dir) : null
  const editor = env.services.get('configEditor') as { documentPath?: unknown } | undefined
  const candidate = typeof editor?.documentPath === 'string' && editor.documentPath !== '' ? resolve(editor.documentPath) : null
  if (candidate !== null && basename(candidate) === 'cordis.patch.yml') {
    if (profileDir === null || inside(profileDir, candidate)) return candidate
  }
  if (profileDir !== null) return join(profileDir, 'cordis.patch.yml')
  return null
}

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function parseScalar(raw: string): unknown {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === '{}') return {}
  if (value === '[]') return []
  if (value === '""' || value === "''") return ''
  if (/^-?\d+$/.test(value)) return Number(value)
  return unquote(value)
}

function leadOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * A patch file as lines, plus the facts an edit must not change: which line ending it uses, whether
 * it ended with one, and which ending that was. Every writer goes back through finishDocument, so a
 * CRLF file stays CRLF and a file without a final newline keeps it that way.
 */
export function splitDocument(text: string): PatchDoc {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const total = (text.match(/\n/g) ?? []).length
  // Dominant ending: a stray CRLF in an LF file must not flip the whole file.
  const eol = crlf > total - crlf ? '\r\n' : '\n'
  // Drop the final newline as one whole EOL, not one character: slicing a lone \n off a CRLF file
  // leaves the \r behind as a line of its own.
  const tail = text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : ''
  const body = tail === '' ? text : text.slice(0, -tail.length)
  return { lines: body === '' ? [] : body.split(/\r?\n/), eol, trailing: tail !== '', tail }
}

/** Join edited lines back with the document's own ending and final-newline habit. */
export function finishDocument(doc: PatchDoc, lines: string[]): string {
  // Removing the last row leaves an empty sequence; `[]` is still a valid patch document, while
  // an empty file reads as YAML null and looks like a corrupt profile to other panels.
  if (lines.length === 0) return '[]' + doc.eol
  const body = lines.join(doc.eol)
  return doc.trailing ? body + (doc.tail === '' ? doc.eol : doc.tail) : body
}

function parseSeq(rawLines: string[]): unknown[] {
  const out: unknown[] = []
  for (const line of rawLines) {
    const body = line.trimStart()
    if (!body.startsWith('- ')) continue
    out.push(parseScalar(body.slice(2)))
  }
  return out
}

function parseBlock(lines: string[], from: number, to: number, indent: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let index = from
  while (index < to) {
    const line = lines[index]
    if (line === undefined) break
    if (line.trim() === '') {
      index += 1
      continue
    }
    const lead = leadOf(line)
    if (lead < indent) break
    const body = line.trimStart()
    if (body.startsWith('- ')) break
    const match = /^([^:#]+):\s*(.*)$/.exec(body)
    if (match === null) {
      index += 1
      continue
    }
    const key = (match[1] ?? '').trim()
    const rest = (match[2] ?? '').trim()
    if (key === '') {
      index += 1
      continue
    }
    if (rest !== '') {
      out[key] = parseScalar(rest)
      index += 1
      continue
    }
    let end = index + 1
    while (end < to) {
      const next = lines[end]
      if (next === undefined) break
      if (next.trim() === '') {
        end += 1
        continue
      }
      if (leadOf(next) <= lead) break
      end += 1
    }
    const nested = lines.slice(index + 1, end).filter(item => item.trim() !== '')
    const first = nested[0]
    if (first === undefined) out[key] = null
    else if (first.trimStart().startsWith('- ')) out[key] = parseSeq(nested)
    else out[key] = parseBlock(lines, index + 1, end, leadOf(first))
    index = end
  }
  return out
}

/** Every @deepseek-ai/dsh-mcp-client row in a patch file, in file order. */
export function parseMcpRows(text: string): McpRow[] {
  const lines = splitDocument(text).lines
  const rows: McpRow[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    const head = /^(\s*)- id:\s*(.*?)\s*$/.exec(line)
    if (head === null) continue
    const indent = (head[1] ?? '').length
    const id = unquote(head[2] ?? '')
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor]
      if (next === undefined) continue
      if (next.trim() === '') continue
      const lead = leadOf(next)
      if (lead < indent) {
        end = cursor
        break
      }
      if (lead === indent && /^-\s/.test(next.trimStart())) {
        end = cursor
        break
      }
    }
    const row: McpRow = {
      id,
      name: null,
      disabled: false,
      config: {},
      startLine: index,
      endLine: end,
      configStart: -1,
      configEnd: -1,
      indent,
      occurrence: 0,
      managedBy: null,
    }
    let configLine = -1
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const current = lines[cursor]
      if (current === undefined) continue
      const body = current.trimStart()
      const lead = leadOf(current)
      if (lead !== indent + 2) continue
      const pair = /^([^:#]+):\s*(.*)$/.exec(body)
      if (pair === null) continue
      const key = (pair[1] ?? '').trim()
      if (key === 'name') row.name = unquote(pair[2] ?? '')
      else if (key === 'disabled') row.disabled = parseScalar(pair[2] ?? '') === true
      else if (key === 'config') configLine = cursor
    }
    if (row.name !== MCP_MODULE) continue
    if (configLine >= 0) {
      const configText = lines[configLine]
      const rest = configText === undefined ? '' : configText.slice(configText.indexOf(':') + 1).trim()
      if (rest === '{}') {
        row.config = {}
        row.configStart = configLine + 1
        row.configEnd = configLine + 1
      }
      else {
        row.config = parseBlock(lines, configLine + 1, end, indent + 4)
        row.configStart = configLine + 1
        // The config subtree ends at the first line that is not a child of it: sibling keys like
        // disabled sit at indent + 2, not inside config.
        let configEnd = configLine + 1
        for (let cursor = configLine + 1; cursor < end; cursor += 1) {
          const current = lines[cursor]
          if (current === undefined) continue
          if (current.trim() === '') continue
          if (leadOf(current) <= indent + 2) break
          configEnd = cursor + 1
        }
        row.configEnd = configEnd
      }
    }
    rows.push(row)
  }
  const seen = new Map<string, number>()
  for (const row of rows) {
    const occurrence = seen.get(row.id) ?? 0
    row.occurrence = occurrence
    seen.set(row.id, occurrence + 1)
  }
  try {
    const blocks = scanPatchBlocks(text).blocks
    for (const row of rows) {
      const block = blocks.find(candidate => row.startLine > candidate.beginLine && row.endLine <= candidate.endLine)
      row.managedBy = block?.name ?? null
    }
  }
  catch {
    // A document the block scanner cannot read still yields the rows; they just lose the owner hint.
  }
  return rows
}

/** A 0-based occurrence among duplicate ids; anything invalid means the first row. */
export function occurrenceOf(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/** Select one row by id plus its file-order occurrence, not just the first id match. */
export function findMcpRow(rows: readonly McpRow[], id: string, occurrence = 0): McpRow | undefined {
  return rows.filter(row => row.id === id)[occurrence]
}

function scalarText(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  if (text === '') return '""'
  if (/[\n\r]/.test(text)) return JSON.stringify(text)
  const plain = /^[A-Za-z0-9_./\\@$+~-][^^\s]*$/.test(text) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(text) && !text.includes(': ') && !text.includes(' #')
  if (plain) return text
  return "'" + text.replace(/'/g, "''") + "'"
}

/**
 * A value the loader should evaluate instead of reading as text.
 *
 * The internal marker { __js: 'process.env.TOKEN' } is what a template arrives as; a leading
 * "!!js " is the same thing already written out, seen again on a re-read. Both have to reach the
 * file unquoted, because quoting them would turn the expression into a literal string the MCP
 * client would send as-is.
 */
function jsExpression(value: unknown): string | null {
  if (typeof value === 'string') return value.startsWith('!!js ') ? value : null
  if (!isRecord(value)) return null
  if (typeof value.__js !== 'string') return null
  if (Object.keys(value).length !== 1) return null
  return '!!js ' + value.__js
}

/** Serialize a config object as YAML lines at the given indentation. */
export function configLines(config: Record<string, unknown>, indent: number): string[] {
  const out: string[] = []
  const walk = (value: Record<string, unknown>, depth: number): void => {
    const lead = ' '.repeat(depth)
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      const expression = jsExpression(item)
      if (expression !== null) {
        out.push(lead + key + ': ' + expression)
        continue
      }
      if (Array.isArray(item)) {
        if (item.length === 0) {
          out.push(lead + key + ': []')
          continue
        }
        out.push(lead + key + ':')
        for (const entry of item) out.push(lead + '  - ' + scalarText(entry))
        continue
      }
      if (isRecord(item)) {
        if (Object.keys(item).length === 0) {
          out.push(lead + key + ': {}')
          continue
        }
        out.push(lead + key + ':')
        walk(item, depth + 2)
        continue
      }
      out.push(lead + key + ': ' + scalarText(item))
    }
  }
  walk(config, indent)
  return out
}

/** Replace one row's config block, keeping every other byte of the file. */
export function replaceMcpConfig(text: string, id: string, config: Record<string, unknown>, occurrence = 0): string {
  const row = findMcpRow(parseMcpRows(text), id, occurrence)
  if (row === undefined) fail('unknown-mcp', 'mcp row "' + id + '" is not in this profile patch')
  if (row.configStart < 0) fail('read-only', 'mcp row "' + id + '" has no config block to edit')
  const doc = splitDocument(text)
  const lines = doc.lines
  const block = Object.keys(config).length === 0 ? [' '.repeat(row.indent + 4) + '{}'] : configLines(config, row.indent + 4)
  const body = block.length === 1 && block[0]?.trim() === '{}'
    ? [' '.repeat(row.indent + 2) + 'config: {}']
    : [' '.repeat(row.indent + 2) + 'config:', ...block]
  const start = row.configStart - 1
  return finishDocument(doc, [...lines.slice(0, start), ...body, ...lines.slice(row.configEnd)])
}

/**
 * Add a new MCP entry outside every managed block: before the first begin marker when the file
 * has one, at the end otherwise. Appending at EOF once landed a row inside another panel's block,
 * where the owner's next rewrite would silently drop it.
 */
export function appendMcpRow(text: string, id: string, config: Record<string, unknown>, disabled: boolean): string {
  const doc = splitDocument(text)
  // A top-level `- id:` entry only overrides an existing module; new modules must be nested in an
  // `- insert:` list or the loader never starts them.
  const body = [
    '- insert:',
    '  - id: ' + scalarText(id),
    '    name: "' + MCP_MODULE + '"',
    '    config:',
    ...(Object.keys(config).length === 0 ? ['      {}'] : configLines(config, 6)),
  ]
  if (disabled) body.push('    disabled: true')
  const firstBegin = doc.lines.findIndex(line => /^[ \t]*#[ \t]*>>>.*:begin[ \t]*$/.test(line))
  const at = firstBegin >= 0 ? firstBegin : doc.lines.length
  // No trimming: leading comments, blank separators and the file's own ending all survive.
  return finishDocument(doc, [...doc.lines.slice(0, at), ...body, ...doc.lines.slice(at)])
}

/** Remove one MCP entry by id, keeping every other byte of the file. */
export function removeMcpRow(text: string, id: string, occurrence = 0): string {
  const row = findMcpRow(parseMcpRows(text), id, occurrence)
  if (row === undefined) fail('unknown-mcp', 'mcp row "' + id + '" is not in this profile patch')
  const doc = splitDocument(text)
  let lines = [...doc.lines.slice(0, row.startLine), ...doc.lines.slice(row.endLine)]
  // Drop the `- insert:` header when its last row is gone, so create+delete restores the bytes.
  if (row.indent > 0) {
    let header = row.startLine - 1
    while (header >= 0 && lines[header]?.trim() === '') header -= 1
    if (header >= 0 && /^- insert:\s*$/.test(lines[header] ?? '')) {
      let remaining = false
      for (let cursor = header + 1; cursor < lines.length; cursor += 1) {
        const current = lines[cursor]
        if (current === undefined) break
        if (current.trim() === '') continue
        if (!/^\s/.test(current)) break
        remaining = true
        break
      }
      if (!remaining) lines = [...lines.slice(0, header), ...lines.slice(header + 1)]
    }
  }
  return finishDocument(doc, lines)
}

export async function readPatchText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Temporary-name counter: pid alone collides inside one millisecond. */
let tempSeq = 0

function tempPathFor(path: string): string {
  tempSeq += 1
  return path + '.' + String(process.pid) + '.' + String(tempSeq) + '.' + Math.random().toString(36).slice(2, 10) + '.tmp'
}

export async function writePatchText(path: string, text: string): Promise<void> {
  const mode = await stat(path).then(info => info.mode & 0o777).catch(() => 0o600)
  // The shared writer adds fsync, Windows rename retries and temp cleanup; one commit path for both files.
  await writeFileAtomic(path, text, mode)
}

/** The file as it was, kept under <dshHome>/backups/ before any byte-level edit. */
export async function backupPatch(patch: string, text: string): Promise<string> {
  const dir = backupsDir()
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, basename(patch) + '-' + stamp + '-' + String(process.pid) + '.bak')
  await copyFile(patch, file).catch(async () => {
    // The patch may not exist yet (a fresh profile); write what we read instead.
    await writeFile(file, text, 'utf8')
  })
  return file
}

/** Join patch rows with the loader's view, so a row keeps its entry id (needed for the switch). */
export function mergeMcpRows(patchRows: McpRow[], loaderRows: LoaderRow[]): McpServerRow[] {
  // Duplicate patch ids are legal in a hand-written file. Keep the loader rows in order and
  // consume one per patch row; a Map of one value would attach both rows to the same loader entry.
  const byPatchId = new Map<string, LoaderRow[]>()
  for (const row of loaderRows) {
    if (row.moduleName !== MCP_MODULE) continue
    if (typeof row.patchId === 'string') {
      const list = byPatchId.get(row.patchId) ?? []
      list.push(row)
      byPatchId.set(row.patchId, list)
    }
  }
  const merged: McpServerRow[] = patchRows.map((row) => {
    const loader = byPatchId.get(row.id)?.shift()
    const config = row.config
    const name = typeof config.serverName === 'string' ? config.serverName : row.id
    const transport = typeof config.transport === 'string' ? config.transport : 'stdio'
    const command = typeof config.command === 'string' ? config.command : ''
    const url = typeof config.url === 'string' ? config.url : ''
    const masked = maskConfigSecrets(config)
    return {
      id: loader?.id ?? 'patch:' + row.id,
      patchId: row.id,
      entryId: loader?.id ?? null,
      occurrence: row.occurrence,
      managedBy: row.managedBy,
      readOnlyReason: row.managedBy !== null ? 'managed by ' + row.managedBy : row.configStart < 0 ? 'no config block' : null,
      name,
      transport,
      command,
      url,
      enabled: loader?.enabled === true,
      manageable: loader?.manageable === true,
      // A row without a config block, or inside another panel's managed block, is not ours to write.
      editable: row.configStart >= 0 && row.managedBy === null,
      config: masked.config,
      secretKeys: masked.secretKeys,
      disabled: row.disabled,
    }
  })
  for (const leftovers of byPatchId.values()) {
    for (const leftover of leftovers) {
      merged.push({
        id: leftover.id,
        patchId: null,
        entryId: leftover.id,
        occurrence: 0,
        managedBy: null,
        readOnlyReason: 'no patch row',
        name: leftover.id,
        transport: 'stdio',
        command: '',
        url: '',
        enabled: leftover.enabled === true,
        manageable: leftover.manageable,
        editable: false,
        config: null,
        secretKeys: { env: [], headers: [] },
        disabled: false,
      })
    }
  }
  return merged
}

/**
 * Snapshot-side secret masking: the keys stay, the values never leave the host.
 *
 * secretKeys is what the panel needs to say "2 keys set" and to send the key back empty (meaning
 * "keep it") without ever holding the value. Everything else is copied untouched.
 */
export function maskConfigSecrets(config: Record<string, unknown> | null): {
  config: Record<string, unknown> | null
  secretKeys: { env: string[]; headers: string[] }
} {
  const secretKeys: { env: string[]; headers: string[] } = { env: [], headers: [] }
  if (!isRecord(config)) return { config: config ?? null, secretKeys }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if ((SECRET_FIELDS as readonly string[]).includes(key) && isRecord(value)) {
      const masked: Record<string, unknown> = {}
      for (const [name, item] of Object.entries(value)) {
        masked[name] = ''
        if (item !== null && item !== undefined && item !== '') secretKeys[key === 'env' ? 'env' : 'headers'].push(name)
      }
      out[key] = masked
      continue
    }
    out[key] = value
  }
  return { config: out, secretKeys }
}

/**
 * Values are strings; anything else is not a value the loader can carry. A value that is exactly a
 * single template becomes the internal marker, an existing "!!js ..." value passes through
 * untouched, and an empty value keeps the stored one — or fails loudly when nothing is stored.
 */
function secretPairs(fieldName: string, asked: Record<string, unknown>, existing: unknown): Record<string, unknown> {
  const stored = isRecord(existing) ? existing : {}
  const pairs: Record<string, unknown> = {}
  for (const [name, item] of Object.entries(stored)) {
    if (typeof item === 'string') pairs[name] = item
    else if (isRecord(item) && typeof item.__js === 'string') pairs[name] = { __js: item.__js }
  }
  for (const [name, item] of Object.entries(asked)) {
    if (typeof item !== 'string') continue
    if (item === '') {
      if (!Object.prototype.hasOwnProperty.call(pairs, name)) {
        fail('bad-secret', fieldName + '.' + name + ' is empty and has no stored value to keep')
      }
      continue
    }
    if (item.startsWith('!!js ')) {
      pairs[name] = item
      continue
    }
    const template = SECRET_TEMPLATE.exec(item)
    pairs[name] = template === null ? item : { __js: 'process.env.' + (template[1] ?? '') }
  }
  return pairs
}

/**
 * Keep only the config keys this panel understands and coerce them to the shape the host's MCP
 * client expects. Anything unknown is dropped, null means delete.
 */
export function cleanMcpConfig(asked: Record<string, unknown>, existing: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const scalar = (key: string): void => {
    const value = asked[key]
    if (value === null) out[key] = null
    else if (typeof value === 'string') out[key] = value
  }
  for (const key of SCALAR_KEYS) {
    if (key === 'toolCallTimeoutMs' || key === 'failOnStartupError') continue
    scalar(key)
  }
  if (Array.isArray(asked.args) && asked.args.every(item => typeof item === 'string')) out.args = asked.args
  else if (asked.args === null) out.args = null
  for (const key of SECRET_FIELDS) {
    const value = asked[key]
    if (value === null) out[key] = null
    else if (isRecord(value)) out[key] = secretPairs(key, value, isRecord(existing) ? existing[key] : null)
  }
  const timeout = asked.toolCallTimeoutMs
  if (timeout === null) out.toolCallTimeoutMs = null
  else if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) out.toolCallTimeoutMs = Math.round(timeout)
  if (typeof asked.failOnStartupError === 'boolean') out.failOnStartupError = asked.failOnStartupError
  const reconnect = asked.reconnect
  if (reconnect === null) out.reconnect = null
  else if (isRecord(reconnect)) {
    const next: Record<string, unknown> = {}
    if (typeof reconnect.enabled === 'boolean') next.enabled = reconnect.enabled
    for (const key of ['initialDelayMs', 'maxDelayMs', 'maxAttempts']) {
      const value = reconnect[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) next[key] = Math.round(value)
    }
    out.reconnect = next
  }
  return out
}

/** One row's bytes exactly as the file holds them, indentation and line ending included. */
export function rowText(text: string, row: McpRow): string {
  const doc = splitDocument(text)
  return doc.lines.slice(row.startLine, row.endLine).join(doc.eol)
}

/** Run work holding <patch>.panel.lock: the same lock name dsh-skill-mcp-panel takes. */
async function withPatchLock<T>(patch: string, work: () => Promise<T>): Promise<T> {
  try {
    return await withFileLock(patch + '.panel.lock', work, { timeoutMs: LOCK_TIMEOUT_MS })
  }
  catch (error) {
    if (error instanceof Error && /lock timeout/i.test(error.message)) {
      fail('lock-timeout', 'another writer holds ' + patch + '.panel.lock')
    }
    throw error
  }
}

/** What the loader knows about the profile's MCP entries, or an empty list when nothing answers. */
async function loaderRows(env: HostEnv): Promise<LoaderRow[]> {
  let manager: unknown
  try {
    manager = env.services.get('pluginManager')
  }
  catch {
    return []
  }
  const list = (manager as { listPlugins?: unknown } | undefined)?.listPlugins
  if (typeof list !== 'function') return []
  let rows: unknown
  try {
    rows = await (list as () => Promise<unknown>).call(manager)
  }
  catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: LoaderRow[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const moduleName = typeof row.moduleName === 'string' ? row.moduleName : typeof row.entryId === 'string' ? row.entryId : ''
    if (moduleName !== MCP_MODULE) continue
    const id = typeof row.entryId === 'string' ? row.entryId : ''
    if (id === '') continue
    out.push({
      id,
      moduleName,
      patchId: typeof row.patchId === 'string' ? row.patchId : null,
      enabled: row.enabled === true,
      manageable: row.readOnlyReason === undefined || row.readOnlyReason === null,
    })
  }
  return out
}

/**
 * Ask the host whether it actually loaded the row we wrote.
 *
 * With no pluginManager there is no oracle, so the check degrades to re-parsing the file: the row
 * must still be there, under the id we wrote, carrying the server name we wrote. Three host
 * attempts, because an HMR reload is not synchronous.
 */
async function verifyWritten(
  env: HostEnv,
  patch: string,
  id: string,
  expectedName: string,
  occurrence = 0,
): Promise<{ mode: 'host' | 'parse'; ok: boolean; detail: string }> {
  let manager: { listPlugins?: unknown } | undefined
  try {
    manager = env.services.get('pluginManager') as { listPlugins?: unknown } | undefined
  }
  catch {
    manager = undefined
  }
  const hasHost = typeof manager?.listPlugins === 'function'
  if (hasHost) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise(done => setTimeout(done, attempt === 0 ? RAW_VERIFY_DELAY_MS : VERIFY_RETRY_MS))
      try {
        const rows = await (manager?.listPlugins as () => Promise<unknown>).call(manager)
        if (!Array.isArray(rows)) continue
        const live = rows.find(row => isRecord(row) && row.patchId === id)
        if (live === undefined || !isRecord(live)) continue
        const name = typeof live.name === 'string' ? live.name : expectedName
        if (expectedName !== '' && name !== expectedName) continue
        return { mode: 'host', ok: true, detail: 'the host lists the row' }
      }
      catch {
        // A host read that throws is not an answer; try once more.
      }
    }
    return { mode: 'host', ok: false, detail: 'the host did not list the row after three attempts' }
  }
  const rows = parseMcpRows(await readPatchText(patch))
  const row = findMcpRow(rows, id, occurrence)
  if (row === undefined) return { mode: 'parse', ok: false, detail: 'the written row is not in the patch' }
  const name = typeof row.config.serverName === 'string' ? row.config.serverName : row.id
  if (expectedName !== '' && name !== expectedName) {
    return { mode: 'parse', ok: false, detail: 'the written row carries "' + name + '", expected "' + expectedName + '"' }
  }
  return { mode: 'parse', ok: true, detail: 'the patch parses back to the row we wrote' }
}

/** Record what the last write did in state.modules.mcp, through the one save path. */
async function noteWrite(env: HostEnv, detail: Record<string, unknown>): Promise<{ saved: boolean; warn: string | null }> {
  env.state.modules.mcp = { lastWriteAt: env.now(), ...detail }
  try {
    await env.save('mcp-write')
    return { saved: true, warn: null }
  }
  catch (error) {
    // The patch is already correct; a state-write failure must not turn that into a failure.
    return { saved: false, warn: 'state not saved: ' + (error as Error).message }
  }
}

/**
 * Write next under the lock, back it up first, then verify; a failed verification puts the previous
 * text back while the file still holds exactly what this call wrote.
 */
async function commitPatch(
  env: HostEnv,
  patch: string,
  id: string,
  next: string,
  previous: string,
  expectedName: string,
  occurrence = 0,
): Promise<{ backup: string; verify: { mode: 'host' | 'parse'; ok: boolean; detail: string } }> {
  const backup = await backupPatch(patch, previous)
  await writePatchText(patch, next)
  const verify = await verifyWritten(env, patch, id, expectedName, occurrence)
  if (!verify.ok) {
    const current = await readPatchText(patch)
    if (current !== next) {
      fail('verify', 'the written row was not loaded and the patch changed meanwhile; left as-is (backup: ' + backup + ')')
    }
    try {
      await writePatchText(patch, previous)
    }
    catch (error) {
      fail('verify-rollback', 'the written row was not loaded and the previous text could not be restored: ' + (error as Error).message + ' (backup: ' + backup + ')')
    }
    fail('verify', 'the written row was not loaded; the file was put back (backup: ' + backup + ')')
  }
  return { backup, verify }
}

/**
 * Replace one MCP row's lines in place, keeping every other byte of the document.
 *
 * `rowLines` is the replacement exactly as it should land (a backup row read back verbatim). The
 * row's own indentation is part of the document's shape, so a replacement that would move the row
 * is refused instead of being re-indented: a caller that wants a different indent is editing, not
 * restoring.
 */
export function replaceMcpRowSpan(text: string, id: string, rowLines: string[], occurrence = 0): string {
  const row = findMcpRow(parseMcpRows(text), id, occurrence)
  if (row === undefined) fail('unknown-mcp', 'mcp row "' + id + '" is not in this profile patch')
  const first = rowLines[0]
  if (first === undefined) fail('bad-payload', 'a restored row needs at least one line')
  const indent = leadOf(first)
  if (indent !== row.indent) {
    fail('indent', 'the restored row is indented by ' + String(indent) + ' spaces, the current row by ' + String(row.indent))
  }
  const doc = splitDocument(text)
  const parsed = parseMcpRows(rowLines.join(doc.eol))
  if (parsed.length !== 1 || parsed[0]?.id !== id) {
    fail('raw-invalid', 'the replacement is not exactly the MCP row "' + id + '"')
  }
  return finishDocument(doc, [...doc.lines.slice(0, row.startLine), ...rowLines, ...doc.lines.slice(row.endLine)])
}

/**
 * Commit a row-span replacement through the one write path: take the patch lock, re-read the file
 * that is actually on disk, let the caller build the new text from it, then back up, write, verify
 * against the host and record the write. The builder runs inside the lock, so a concurrent edit
 * cannot be overwritten with text computed before it landed.
 */
export async function commitMcpRowSpan(
  env: HostEnv,
  patch: string,
  id: string,
  build: (current: string) => { next: string; expectedName: string },
  note: Record<string, unknown> = {},
): Promise<{ backup: string; verify: { mode: 'host' | 'parse'; ok: boolean; detail: string }; stateSaved: boolean; warn: string | null }> {
  return await withPatchLock(patch, async () => {
    const current = await readPatchText(patch)
    const built = build(current)
    const written = await commitPatch(env, patch, id, built.next, current, built.expectedName)
    const noted = await noteWrite(env, { id, backup: written.backup, patch, ...note })
    return { backup: written.backup, verify: written.verify, stateSaved: noted.saved, warn: noted.warn }
  })
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

/** Where the authorization server sends the browser back; the panel asks for that URL. */
export const OAUTH_REDIRECT_URI = 'http://localhost/oauth/callback'
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000
const OAUTH_PENDING_LIMIT = 20

interface OauthPending {
  at: number
  id: string
  occurrence: number
  verifier: string
  meta: Record<string, unknown>
  clientId: string
  clientSecret: string | null
  redirectUri: string
}

const OAUTH_PENDING = new Map<string, OauthPending>()

function pruneOauthPending(): void {
  const now = Date.now()
  for (const [state, item] of [...OAUTH_PENDING.entries()]) {
    if (now - item.at > OAUTH_PENDING_TTL_MS) OAUTH_PENDING.delete(state)
  }
  while (OAUTH_PENDING.size >= OAUTH_PENDING_LIMIT) {
    const oldest = OAUTH_PENDING.keys().next()
    if (oldest.done === true) break
    OAUTH_PENDING.delete(oldest.value)
  }
}

function oauthPending(state: string): OauthPending | null {
  const item = OAUTH_PENDING.get(state)
  if (item === undefined) return null
  if (Date.now() - item.at > OAUTH_PENDING_TTL_MS) {
    OAUTH_PENDING.delete(state)
    return null
  }
  return item
}

/** Pull the code out of a pasted callback URL, or accept a bare code. */
export function oauthCodeOf(input: string): string {
  const text = input.trim()
  if (text === '') return ''
  try {
    const parsed = new URL(text)
    return (parsed.searchParams.get('code') ?? '').trim()
  }
  catch {
    return text
  }
}

// ── ops ──────────────────────────────────────────────────────────────────────

const OPS: OpDefinition[] = [
  { id: 'mcp.list', write: false, audit: false, note: 'Lists the profile patch MCP rows joined with the loader view; secrets stay masked.' },
  { id: 'mcp.save', write: true, audit: true, note: 'Rewrites one MCP row config block in the profile patch, backed up and verified.' },
  { id: 'mcp.create', write: true, audit: true, note: 'Appends a new MCP row to the profile patch, disabled until someone switches it on.' },
  { id: 'mcp.delete', write: true, audit: true, note: 'Removes one MCP row from the profile patch, backed up first.' },
  { id: 'mcp.raw', write: false, audit: false, note: 'Returns one MCP row raw text exactly as the patch holds it.' },
  { id: 'mcp.rawSave', write: true, audit: true, note: 'Writes an edited MCP row back verbatim, backed up and verified against the host.' },
  { id: 'mcp.oauthStart', write: false, audit: false, note: 'Discovers the server OAuth metadata, registers a client and returns the authorize URL.' },
  { id: 'mcp.oauthFinish', write: true, audit: true, note: 'Exchanges the pasted code and stores the bearer token in that row Authorization header.' },
  { id: 'mcp.oauthCancel', write: false, audit: false, note: 'Drops one pending OAuth login.' },
]

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function guarded(work: (payload: Record<string, unknown>, env: HostEnv) => Promise<unknown>): OpHandler {
  return async (payload, env): Promise<unknown> => {
    try {
      return await work(asRecord(payload), env)
    }
    catch (error) {
      return failureOf(error)
    }
  }
}

function field(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Settings the MCP tab exposes; the client renders them generically from here. */
function mcpSettings() {
  return [
    {
      key: 'mcp.confirmDelete',
      type: 'boolean' as const,
      default: true,
      label: { zh: '删除 MCP 服务器前确认', en: 'Confirm before deleting an MCP server' },
      hint: { zh: '整行删除不可撤销；面板按此设置决定是否先问一次。', en: 'Deleting a row is not undoable; the panel asks first when this is on.' },
    },
    {
      key: 'mcp.backupKeep',
      type: 'number' as const,
      default: 30,
      min: 1,
      max: 500,
      label: { zh: '保留的补丁备份份数', en: 'Patch backups to keep' },
      hint: { zh: '每次写入前复制一份到 <dshHome>/backups/。', en: 'Every write copies the patch to <dshHome>/backups/ first.' },
    },
  ]
}

/** One handler per declared op; every failure comes back as ok:false with a code. */
export function createMcpDomain(): DomainRegistration {
  return {
    module: {
      id: 'mcp',
      title: { zh: 'MCP 服务器', en: 'MCP servers' },
      ops: OPS,
      panels: [{ slot: 'plugins.tab', id: 'mcp', order: 30 }],
      settings: mcpSettings(),
    },
    handlers: {
      'mcp.list': guarded(async (_payload, env) => {
        const patch = patchPathFor(env)
        const loader = await loaderRows(env)
        if (patch === null) {
          return {
            ok: true,
            patchPath: null,
            rows: mergeMcpRows([], loader),
            error: 'no profile patch found; the panel can list but not edit MCP rows',
          }
        }
        let text = ''
        try {
          text = await readPatchText(patch)
        }
        catch (error) {
          return { ok: true, patchPath: patch, rows: mergeMcpRows([], loader), error: failureOf(error).message }
        }
        const rows = mergeMcpRows(parseMcpRows(text), loader)
        return { ok: true, patchPath: patch, rows, count: rows.length, error: null }
      }),
      'mcp.create': guarded(async (payload, env) => {
        const patch = patchPathFor(env)
        if (patch === null) fail('no-patch', 'this profile has no cordis.patch.yml to edit')
        const asked = payload.config
        if (!isRecord(asked)) fail('bad-config', 'config must be an object')
        const cleaned = cleanMcpConfig(asked, null)
        const name = typeof cleaned.serverName === 'string' ? cleaned.serverName : ''
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) fail('bad-name', 'server name must be 1-32 letters, digits, - or _')
        return await withPatchLock(patch, async () => {
          const text = await readPatchText(patch)
          const rows = parseMcpRows(text)
          if (rows.some(item => item.config.serverName === name)) fail('duplicate-mcp', 'an MCP server named "' + name + '" already exists')
          const ids = new Set(rows.map(item => item.id))
          let fresh = 'tool-hub-mcp-' + name
          let suffix = 1
          while (ids.has(fresh)) {
            suffix += 1
            fresh = 'tool-hub-mcp-' + name + '-' + String(suffix)
          }
          // A new row arrives disabled: nothing starts talking to a server before someone asks.
          const next = appendMcpRow(text, fresh, cleaned, true)
          const written = await commitPatch(env, patch, fresh, next, text, name)
          const note = await noteWrite(env, { op: 'create', id: fresh, backup: written.backup, patch })
          return { ok: true, id: fresh, patch, route: 'hmr', config: cleaned, created: true, backup: written.backup, verify: written.verify, stateSaved: note.saved, warn: note.warn }
        })
      }),
      'mcp.save': guarded(async (payload, env) => {
        const patch = patchPathFor(env)
        if (patch === null) fail('no-patch', 'this profile has no cordis.patch.yml to edit')
        const id = field(payload, 'id')
        if (!MCP_ID_PATTERN.test(id)) fail('bad-id', 'mcp row id cannot be used')
        const asked = payload.config
        if (!isRecord(asked)) fail('bad-config', 'config must be an object')
        return await withPatchLock(patch, async () => {
          const text = await readPatchText(patch)
          const occurrence = occurrenceOf(payload.occurrence)
          const row = findMcpRow(parseMcpRows(text), id, occurrence)
          if (row === undefined) fail('unknown-mcp', 'no MCP server "' + id + '" in the profile patch')
          if (row.managedBy !== null) fail('read-only', 'mcp row "' + id + '" is inside ' + row.managedBy + "'s managed block")
          if (row.configStart < 0) fail('read-only', 'mcp row "' + id + '" has no config block to edit')
          // The existing config is what makes an empty credential mean "keep it" instead of "erase it".
          const cleaned = cleanMcpConfig(asked, row.config)
          const config: Record<string, unknown> = { ...row.config }
          for (const [key, value] of Object.entries(cleaned)) {
            if (value === null) delete config[key]
            else config[key] = value
          }
          const next = replaceMcpConfig(text, id, config, occurrence)
          const expectedName = typeof config.serverName === 'string' ? config.serverName : id
          const written = await commitPatch(env, patch, id, next, text, expectedName, occurrence)
          const note = await noteWrite(env, { op: 'save', id, backup: written.backup, patch })
          return { ok: true, id, patch, route: 'hmr', config, backup: written.backup, verify: written.verify, stateSaved: note.saved, warn: note.warn }
        })
      }),
      'mcp.delete': guarded(async (payload, env) => {
        const patch = patchPathFor(env)
        if (patch === null) fail('no-patch', 'this profile has no cordis.patch.yml to edit')
        const id = field(payload, 'id')
        if (!MCP_ID_PATTERN.test(id)) fail('bad-id', 'mcp row id cannot be used')
        return await withPatchLock(patch, async () => {
          const text = await readPatchText(patch)
          const occurrence = occurrenceOf(payload.occurrence)
          const row = findMcpRow(parseMcpRows(text), id, occurrence)
          if (row === undefined) fail('unknown-mcp', 'no MCP server "' + id + '" in the profile patch')
          if (row.managedBy !== null) fail('read-only', 'mcp row "' + id + '" is inside ' + row.managedBy + "'s managed block")
          const next = removeMcpRow(text, id, occurrence)
          const backup = await backupPatch(patch, text)
          await writePatchText(patch, next)
          const note = await noteWrite(env, { op: 'delete', id, backup, patch })
          return { ok: true, id, patch, route: 'hmr', removed: true, backup, stateSaved: note.saved, warn: note.warn }
        })
      }),
      'mcp.raw': guarded(async (payload, env) => {
        const patch = patchPathFor(env)
        if (patch === null) fail('no-patch', 'this profile has no cordis.patch.yml to edit')
        const id = field(payload, 'id')
        if (!MCP_ID_PATTERN.test(id)) fail('bad-id', 'mcp row id cannot be used')
        const text = await readPatchText(patch)
        const row = findMcpRow(parseMcpRows(text), id, occurrenceOf(payload.occurrence))
        if (row === undefined) fail('unknown-mcp', 'no MCP server "' + id + '" in the profile patch')
        return { ok: true, id, occurrence: row.occurrence, text: rowText(text, row) }
      }),
      'mcp.rawSave': guarded(async (payload, env) => {
        const patch = patchPathFor(env)
        if (patch === null) fail('no-patch', 'this profile has no cordis.patch.yml to edit')
        const askedId = field(payload, 'id')
        const askedOccurrence = occurrenceOf(payload.occurrence)
        if (askedId !== '' && !MCP_ID_PATTERN.test(askedId)) fail('bad-id', 'mcp row id cannot be used')
        const snippet = typeof payload.text === 'string' ? payload.text : ''
        if (snippet.trim() === '') fail('raw-invalid', 'the edited text is empty')
        // Parse and validate the snippet before touching the patch: a request that cannot possibly
        // be written should not sit in the lock queue behind a slow writer.
        const parsed = parseMcpRows(snippet)
        if (parsed.length !== 1) fail('raw-invalid', 'expected exactly one MCP row, found ' + String(parsed.length))
        const nextRow = parsed[0]
        if (nextRow === undefined) fail('raw-invalid', 'expected exactly one MCP row')
        if (nextRow.name !== MCP_MODULE) fail('raw-invalid', 'that row is not an MCP server')
        if (nextRow.startLine !== 0) fail('raw-invalid', 'the text must start with its "- id:" line')
        const wantedName = field(payload, 'name')

        return await withPatchLock(patch, async () => {
          // Re-read inside the lock: the row this edit replaces is located from the file as it is
          // now, never from the copy the request happened to see.
          const text = await readPatchText(patch)
          const rows = parseMcpRows(text)
          let existing: McpRow | null = null
          if (askedId !== '') {
            existing = findMcpRow(rows, askedId, askedOccurrence) ?? null
          }
          else {
            // No id: the server name has to pick exactly one row, otherwise "which row" is a guess.
            const matches = wantedName === '' ? [] : rows.filter(item => item.config.serverName === wantedName)
            if (matches.length > 1) fail('bad-id', 'more than one MCP server is named "' + wantedName + '"')
            if (matches.length === 1) existing = matches[0] ?? null
          }
          if (existing === null) fail('unknown-mcp', 'no MCP server matches that id')
          if (existing.managedBy !== null) fail('read-only', 'mcp row "' + existing.id + '" is inside ' + existing.managedBy + "'s managed block")
          if (nextRow.id !== existing.id) fail('raw-id', 'the row id must stay "' + existing.id + '"')
          if (nextRow.indent !== existing.indent) fail('raw-indent', 'the row must stay indented by ' + String(existing.indent) + ' spaces')
          const doc = splitDocument(text)
          const snippetLines = splitDocument(snippet).lines
          const stray = snippetLines.findIndex((line, index) => line.trim() !== '' && (index < nextRow.startLine || index >= nextRow.endLine))
          if (stray >= 0) fail('raw-invalid', 'line ' + String(stray + 1) + ' is outside the MCP row')

          const expectedName = typeof nextRow.config.serverName === 'string' ? nextRow.config.serverName : nextRow.id
          const merged = finishDocument(doc, [...doc.lines.slice(0, existing.startLine), ...snippetLines, ...doc.lines.slice(existing.endLine)])
          const written = await commitPatch(env, patch, existing.id, merged, text, expectedName, existing.occurrence)
          const note = await noteWrite(env, { op: 'rawSave', id: existing.id, backup: written.backup, patch })
          return { ok: true, id: existing.id, saved: true, backup: written.backup, verify: written.verify, stateSaved: note.saved, warn: note.warn }
        })
      }),
      'mcp.oauthStart': guarded(async (payload, env) => {
        const patch = patchPathFor(env)
        if (patch === null) fail('no-patch', 'this profile has no cordis.patch.yml to edit')
        const id = field(payload, 'id')
        if (!MCP_ID_PATTERN.test(id)) fail('bad-id', 'mcp row id cannot be used')
        const text = await readPatchText(patch)
        const row = findMcpRow(parseMcpRows(text), id, occurrenceOf(payload.occurrence))
        if (row === undefined) fail('unknown-mcp', 'no MCP server "' + id + '" in the profile patch')
        if (row.managedBy !== null) fail('read-only', 'mcp row "' + id + '" is inside ' + row.managedBy + "'s managed block")
        const raw = typeof row.config.url === 'string' ? row.config.url.trim() : ''
        let endpoint: URL
        try {
          endpoint = new URL(raw)
        }
        catch {
          fail('not-http', 'this server has no http(s) url to authorize against')
        }
        if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') fail('not-http', 'this server has no http(s) url to authorize against')
        const oauth = await import('../../lib/oauth.js') as {
          discover: (url: string) => Promise<Record<string, unknown>>
          register: (meta: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown>>
          authorizeUrl: (input: Record<string, unknown>) => string
          createPkce: () => { verifier: string; challenge: string }
        }
        let meta: Record<string, unknown>
        let client: Record<string, unknown>
        try {
          meta = await oauth.discover(raw)
          client = await oauth.register(meta, { clientName: 'dsh-tool-hub', redirectUri: OAUTH_REDIRECT_URI })
        }
        catch (error) {
          fail('oauth-failed', String((error as Error)?.message ?? error))
        }
        const clientId = typeof client.clientId === 'string' ? client.clientId : ''
        if (clientId === '') fail('oauth-failed', 'the authorization server issued no client id')
        const pkce = oauth.createPkce()
        const state = randomBytes(16).toString('hex')
        const authorizeUrl = oauth.authorizeUrl({
          meta,
          clientId,
          redirectUri: OAUTH_REDIRECT_URI,
          state,
          codeChallenge: pkce.challenge,
          scopes: meta.scopes,
        })
        pruneOauthPending()
        OAUTH_PENDING.set(state, {
          at: Date.now(),
          id,
          occurrence: row.occurrence,
          verifier: pkce.verifier,
          meta,
          clientId,
          clientSecret: typeof client.clientSecret === 'string' ? client.clientSecret : null,
          redirectUri: OAUTH_REDIRECT_URI,
        })
        return { ok: true, id, name: typeof row.config.serverName === 'string' ? row.config.serverName : id, authorizeUrl, state, redirectUri: OAUTH_REDIRECT_URI }
      }),
      'mcp.oauthFinish': guarded(async (payload, env) => {
        const state = field(payload, 'state')
        const code = oauthCodeOf(typeof payload.code === 'string' ? payload.code : '')
        const pending = state === '' ? null : oauthPending(state)
        if (pending === null) fail('bad-state', 'that login is unknown or has expired')
        if (code === '') fail('oauth-failed', 'the authorization code is empty')
        const oauth = await import('../../lib/oauth.js') as {
          exchangeCode: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
        }
        let token: Record<string, unknown>
        try {
          token = await oauth.exchangeCode({
            meta: pending.meta,
            clientId: pending.clientId,
            clientSecret: pending.clientSecret ?? undefined,
            code,
            codeVerifier: pending.verifier,
            redirectUri: pending.redirectUri,
          })
        }
        catch (error) {
          // A code is single-use: after a failed exchange this pending login cannot be retried.
          OAUTH_PENDING.delete(state)
          fail('oauth-failed', String((error as Error)?.message ?? error))
        }
        OAUTH_PENDING.delete(state)
        const accessToken = typeof token.accessToken === 'string' ? token.accessToken : ''
        if (accessToken === '') fail('oauth-failed', 'the authorization server issued no access token')
        const patch = patchPathFor(env)
        if (patch === null) fail('no-patch', 'this profile has no cordis.patch.yml to edit')
        return await withPatchLock(patch, async () => {
          const text = await readPatchText(patch)
          const row = findMcpRow(parseMcpRows(text), pending.id, pending.occurrence)
          if (row === undefined) fail('unknown-mcp', 'no MCP server "' + pending.id + '" in the profile patch')
          if (row.managedBy !== null) fail('read-only', 'mcp row "' + pending.id + '" is inside ' + row.managedBy + "'s managed block")
          const headers = isRecord(row.config.headers) ? row.config.headers : {}
          const config: Record<string, unknown> = { ...row.config, headers: { ...headers, Authorization: 'Bearer ' + accessToken } }
          const next = replaceMcpConfig(text, pending.id, config, pending.occurrence)
          const expectedName = typeof config.serverName === 'string' ? config.serverName : pending.id
          const written = await commitPatch(env, patch, pending.id, next, text, expectedName)
          const note = await noteWrite(env, { op: 'oauth', id: pending.id, backup: written.backup, patch })
          return { ok: true, id: pending.id, saved: true, backup: written.backup, verify: written.verify, stateSaved: note.saved, warn: note.warn }
        })
      }),
      'mcp.oauthCancel': guarded(async (payload) => {
        const state = field(payload, 'state')
        if (state !== '') OAUTH_PENDING.delete(state)
        return { ok: true, cancelled: true }
      }),
    },
  }
}

/** Alias so a registrar can pick either naming style. */
export const mcpDomain = createMcpDomain