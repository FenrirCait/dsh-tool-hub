/**
 * MCP servers live in the profile's `cordis.patch.yml` as ordinary rows whose
 * `name` is `@deepseek-ai/dsh-mcp-client`. This module reads those rows and
 * writes a single row's `config` block back without touching any other byte of
 * the file, so hand-written comments and ordering survive an edit.
 *
 * Only the config keys this panel understands are rewritten; everything else in
 * the row (id, name, disabled, comments around the row) is preserved verbatim.
 */
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

export const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Text fields the panel can edit, in form order. */
export const SCALAR_KEYS = [
  'serverName',
  'transport',
  'command',
  'cwd',
  'url',
  'toolCallTimeoutMs',
  'failOnStartupError',
]

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when `child` really sits inside `parent` (a prefix check would accept `../patch`). */
function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  // `relative` answers with an absolute path when the two are on different Windows drives.
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The patch file the running profile actually reads.
 *
 * `configEditor.documentPath` is host-supplied and cannot be trusted as-is: a wrong or hostile
 * value would point every MCP write at an arbitrary file. It is accepted only when it resolves
 * inside the profile directory and still names `cordis.patch.yml`; otherwise the profile's own
 * patch path is used. With no profile context at all, the editor path survives only if it looks
 * like a patch file.
 */
export function patchPathFor(ctx) {
  const profile = ctx.get('profileContext') ?? ctx.profileContext
  const profileDir = typeof profile?.dir === 'string' && profile.dir !== '' ? resolve(profile.dir) : null
  const editor = ctx.get('configEditor')
  const candidate = editor !== undefined && editor !== null && typeof editor.documentPath === 'string' && editor.documentPath !== ''
    ? resolve(editor.documentPath)
    : null
  if (candidate !== null && basename(candidate) === 'cordis.patch.yml') {
    if (profileDir === null || inside(profileDir, candidate)) return candidate
  }
  if (profileDir !== null) return join(profileDir, 'cordis.patch.yml')
  return null
}

function unquote(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function parseScalar(raw) {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === '{}') return {}
  if (value === '[]') return []
  if (value === '""' || value === "''") return ''
  if (/^-?\d+$/.test(value)) return Number(value)
  return unquote(value)
}

function leadOf(line) {
  return line.length - line.trimStart().length
}

/**
 * A patch file as lines, plus the facts an edit must not change: which line ending it uses,
 * whether it ended with one, and which ending that was. Every writer goes back through
 * `finishDocument`, so a CRLF file stays CRLF and a file without a final newline keeps it that way.
 */
export function splitDocument(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const total = (text.match(/\n/g) ?? []).length
  // Dominant ending: a stray CRLF in an LF file must not flip the whole file.
  const eol = crlf > total - crlf ? '\r\n' : '\n'
  // Drop the final newline as one whole EOL, not one character. Slicing a lone `\n` off a CRLF
  // file leaves the `\r` behind as a line of its own, and the next join turns that into a stray
  // (or doubled) `\r` — which is what ate the blank line at the end of a CRLF patch.
  const tail = text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : ''
  const body = tail === '' ? text : text.slice(0, -tail.length)
  return { lines: body === '' ? [] : body.split(/\r?\n/), eol, trailing: tail !== '', tail }
}

/** Join edited lines back with the document's own ending and final-newline habit. */
export function finishDocument(doc, lines) {
  // Removing the last row empties the file; a lone newline is not a document.
  if (lines.length === 0) return ''
  const body = lines.join(doc.eol)
  return doc.trailing ? `${body}${doc.tail ?? doc.eol}` : body
}

function parseSeq(rawLines) {
  const out = []
  for (const line of rawLines) {
    const body = line.trimStart()
    if (!body.startsWith('- ')) continue
    out.push(parseScalar(body.slice(2)))
  }
  return out
}

function parseBlock(lines, from, to, indent) {
  const out = {}
  let index = from
  while (index < to) {
    const line = lines[index]
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
    const key = match[1].trim()
    const rest = match[2].trim()
    if (rest !== '') {
      out[key] = parseScalar(rest)
      index += 1
      continue
    }
    let end = index + 1
    while (end < to) {
      const next = lines[end]
      if (next.trim() === '') {
        end += 1
        continue
      }
      if (leadOf(next) <= lead) break
      end += 1
    }
    const nested = lines.slice(index + 1, end).filter(line => line.trim() !== '')
    if (nested.length === 0) out[key] = null
    else if (nested[0].trimStart().startsWith('- ')) out[key] = parseSeq(nested)
    else out[key] = parseBlock(lines, index + 1, end, leadOf(nested[0]))
    index = end
  }
  return out
}

/**
 * Every `@deepseek-ai/dsh-mcp-client` row in a patch file, in file order.
 * @returns {{ id: string, disabled: boolean, config: Record<string, unknown>, startLine: number, endLine: number, configStart: number, configEnd: number, indent: number }[]}
 */
export function parseMcpRows(text) {
  const lines = splitDocument(text).lines
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const head = /^(\s*)- id:\s*(.*?)\s*$/.exec(lines[index])
    if (head === null) continue
    const indent = head[1].length
    const id = unquote(head[2])
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') continue
      const lead = leadOf(line)
      if (lead < indent) {
        end = cursor
        break
      }
      if (lead === indent && /^-\s/.test(line.trimStart())) {
        end = cursor
        break
      }
    }
    const row = { id, name: null, disabled: false, config: {}, startLine: index, endLine: end, configStart: -1, configEnd: -1, indent }
    let configLine = -1
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const body = lines[cursor].trimStart()
      const lead = leadOf(lines[cursor])
      if (lead !== indent + 2) continue
      const pair = /^([^:#]+):\s*(.*)$/.exec(body)
      if (pair === null) continue
      const key = pair[1].trim()
      if (key === 'name') row.name = unquote(pair[2])
      else if (key === 'disabled') row.disabled = parseScalar(pair[2]) === true
      else if (key === 'config') configLine = cursor
    }
    if (row.name !== MCP_MODULE) continue
    if (configLine >= 0) {
      const rest = lines[configLine].slice(lines[configLine].indexOf(':') + 1).trim()
      if (rest === '{}') {
        row.config = {}
        row.configStart = configLine + 1
        row.configEnd = configLine + 1
      }
      else {
        row.config = parseBlock(lines, configLine + 1, end, indent + 4)
        row.configStart = configLine + 1
        // The config subtree ends at the first line that is not a child of it:
        // sibling keys like `disabled:` sit at indent + 2, not inside config.
        let configEnd = configLine + 1
        for (let cursor = configLine + 1; cursor < end; cursor += 1) {
          const line = lines[cursor]
          if (line.trim() === '') continue
          if (leadOf(line) <= indent + 2) break
          configEnd = cursor + 1
        }
        row.configEnd = configEnd
      }
    }
    rows.push(row)
  }
  return rows
}

function scalarText(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  if (text === '') return '""'
  if (/[\n\r]/.test(text)) return JSON.stringify(text)
  const plain = /^[A-Za-z0-9_./\\@$+~-][^^\s]*$/.test(text) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(text) && !text.includes(': ') && !text.includes(' #')
  if (plain) return text
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * A value the loader should evaluate instead of reading as text.
 *
 * `{ __js: 'process.env.TOKEN' }` is the internal marker the host hands us for a `${TOKEN}`
 * template; `!!js …` is the same thing already written out, seen again on a re-read. Both
 * have to reach the file unquoted, because quoting them would turn the expression into a
 * literal string the MCP client would send as-is.
 */
function jsExpression(value) {
  if (typeof value === 'string') return value.startsWith('!!js ') ? value : null
  if (!isRecord(value)) return null
  if (typeof value.__js !== 'string') return null
  const keys = Object.keys(value)
  if (keys.length !== 1) return null
  return `!!js ${value.__js}`
}

/** Serialize a config object as YAML lines at the given indentation. */
export function configLines(config, indent) {
  const pad = ' '.repeat(indent)
  const out = []
  const walk = (value, depth) => {
    const lead = ' '.repeat(depth)
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      const expression = jsExpression(item)
      if (expression !== null) {
        out.push(`${lead}${key}: ${expression}`)
        continue
      }
      if (Array.isArray(item)) {
        if (item.length === 0) {
          out.push(`${lead}${key}: []`)
          continue
        }
        out.push(`${lead}${key}:`)
        for (const entry of item) out.push(`${lead}  - ${scalarText(entry)}`)
        continue
      }
      if (isRecord(item)) {
        if (Object.keys(item).length === 0) {
          out.push(`${lead}${key}: {}`)
          continue
        }
        out.push(`${lead}${key}:`)
        walk(item, depth + 2)
        continue
      }
      out.push(`${lead}${key}: ${scalarText(item)}`)
    }
  }
  walk(config, indent)
  return out
}

/** Replace one row's config block, keeping every other byte of the file. */
export function replaceMcpConfig(text, id, config) {
  const row = parseMcpRows(text).find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`mcp row "${id}" is not in this profile patch`)
  if (row.configStart < 0) throw new Error(`mcp row "${id}" has no config block`)
  const doc = splitDocument(text)
  const lines = doc.lines
  const block = Object.keys(config).length === 0 ? [`${' '.repeat(row.indent + 4)}{}`] : configLines(config, row.indent + 4)
  const body = block.length === 1 && block[0].trim() === '{}'
    ? [`${' '.repeat(row.indent + 2)}config: {}`]
    : [`${' '.repeat(row.indent + 2)}config:`, ...block]
  const start = row.configStart - 1
  return finishDocument(doc, [...lines.slice(0, start), ...body, ...lines.slice(row.configEnd)])
}

/** Append a new MCP entry at the end of the patch list; every existing byte stays put. */
export function appendMcpRow(text, id, config, disabled) {
  const doc = splitDocument(text)
  const body = [
    `- id: ${scalarText(id)}`,
    `  name: "${MCP_MODULE}"`,
    '  config:',
    ...(Object.keys(config).length === 0 ? ['    {}'] : configLines(config, 4)),
  ]
  if (disabled === true) body.push('  disabled: true')
  // No trimming: leading comments, blank separators and the file's own ending all survive. The
  // new row is its own line because joining inserts the document's EOL before it.
  return finishDocument(doc, [...doc.lines, ...body])
}

/** Remove one MCP entry by id, keeping every other byte of the file. */
export function removeMcpRow(text, id) {
  const row = parseMcpRows(text).find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`mcp row "${id}" is not in this profile patch`)
  const doc = splitDocument(text)
  return finishDocument(doc, [...doc.lines.slice(0, row.startLine), ...doc.lines.slice(row.endLine)])
}

export async function readPatchText(path) {
  try {
    return await readFile(path, 'utf8')
  }
  catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Temporary-name counter.
 *
 * pid alone separates processes, but two writes from one process inside the same millisecond used
 * to land on the same `.tmp` name: the second `writeFile` truncated the first writer's file and
 * both renamed it, so one of them published a half-written patch. A per-process counter makes the
 * name unique inside the process, and the random tail keeps a run from colliding with a `.tmp`
 * left behind by an earlier run.
 */
let tempSeq = 0

function tempPathFor(path) {
  tempSeq += 1
  return `${path}.${process.pid}.${tempSeq}.${Math.random().toString(36).slice(2, 10)}.tmp`
}

export async function writePatchText(path, text) {
  const temp = tempPathFor(path)
  const mode = await stat(path).then(info => info.mode & 0o777).catch(() => 0o600)
  await writeFile(temp, text, { encoding: 'utf8', mode })
  await rename(temp, path)
}

/**
 * Merge patch rows with the loader's own view, so a row keeps its `entryId`
 * (needed for the enable switch) and its on-disk config (needed for editing).
 */
export function mergeMcpRows(patchRows, pluginRows) {
  const byPatchId = new Map()
  for (const row of pluginRows) {
    if (row.mcp !== true) continue
    if (typeof row.patchId === 'string') byPatchId.set(row.patchId, row)
  }
  const merged = patchRows.map((row) => {
    const plugin = byPatchId.get(row.id)
    byPatchId.delete(row.id)
    return {
      id: plugin?.id ?? `patch:${row.id}`,
      patchId: row.id,
      entryId: plugin?.id ?? null,
      name: typeof row.config.serverName === 'string' ? row.config.serverName : row.id,
      transport: typeof row.config.transport === 'string' ? row.config.transport : 'stdio',
      command: typeof row.config.command === 'string' ? row.config.command : '',
      url: typeof row.config.url === 'string' ? row.config.url : '',
      enabled: plugin?.enabled === true,
      phase: plugin?.phase ?? null,
      manageable: plugin !== undefined && plugin.manageable === true,
      config: row.config,
      disabled: row.disabled,
    }
  })
  for (const leftover of byPatchId.values()) {
    merged.push({
      id: leftover.id,
      patchId: null,
      entryId: leftover.id,
      name: leftover.moduleName,
      transport: 'stdio',
      command: '',
      url: '',
      enabled: leftover.enabled === true,
      phase: leftover.phase ?? null,
      manageable: false,
      config: null,
      disabled: false,
    })
  }
  return merged
}
