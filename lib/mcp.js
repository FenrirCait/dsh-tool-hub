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
import { join } from 'node:path'

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

/** The patch file the running profile actually reads. */
export function patchPathFor(ctx) {
  const editor = ctx.get('configEditor')
  if (editor !== undefined && editor !== null && typeof editor.documentPath === 'string' && editor.documentPath !== '') {
    return editor.documentPath
  }
  const profile = ctx.get('profileContext') ?? ctx.profileContext
  if (profile !== undefined && profile !== null && typeof profile.dir === 'string' && profile.dir !== '') {
    return join(profile.dir, 'cordis.patch.yml')
  }
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
  const lines = text.split(/\r?\n/)
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

/** Serialize a config object as YAML lines at the given indentation. */
export function configLines(config, indent) {
  const pad = ' '.repeat(indent)
  const out = []
  const walk = (value, depth) => {
    const lead = ' '.repeat(depth)
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
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
  const lines = text.split(/\r?\n/)
  const block = Object.keys(config).length === 0 ? [`${' '.repeat(row.indent + 4)}{}`] : configLines(config, row.indent + 4)
  const body = block.length === 1 && block[0].trim() === '{}'
    ? [`${' '.repeat(row.indent + 2)}config: {}`]
    : [`${' '.repeat(row.indent + 2)}config:`, ...block]
  const start = row.configStart - 1
  const next = [...lines.slice(0, start), ...body, ...lines.slice(row.configEnd)]
  return next.join('\n')
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

export async function writePatchText(path, text) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
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
