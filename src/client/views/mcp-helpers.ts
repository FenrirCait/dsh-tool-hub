/** Pure draft mapping for one MCP row; no React and no host calls. */
import type { PluginRow, ViewProps } from '../types.js'

export interface Draft {
  id: string
  occurrence: number
  name: string
  transport: string
  command: string
  args: string
  cwd: string
  url: string
  env: string
  headers: string
}

export interface RawState {
  id: string
  occurrence: number
  text: string
  error: string
  loading: boolean
}

export function copy(lang: ViewProps['lang'], zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** The patch row id a write needs; '' when the row only exists in the loader. */
export function patchIdOf(row: PluginRow): string {
  // An explicit null means mergeMcpRows found no patch row; falling back to the loader's stale
  // patchId would give several unmatched siblings the same key.
  const direct = row.mcpPatchId === null ? '' : row.mcpPatchId ?? row.patchId ?? ''
  return typeof direct === 'string' ? direct : ''
}

/** 0-based position among duplicate patch ids; 0 is the old, unambiguous behavior. */
export function occurrenceOf(row: PluginRow): number {
  return typeof row.mcpOccurrence === 'number' && Number.isInteger(row.mcpOccurrence) && row.mcpOccurrence >= 0 ? row.mcpOccurrence : 0
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/** Masked secret maps arrive as { KEY: '' }; the key is shown so a new value can be typed in. */
function pairsText(value: unknown, glue: string): string {
  return Object.keys(asRecord(value)).map(key => key + glue).join('\n')
}

/** A blank value is skipped: to the host, empty means "keep the one already stored". */
function parsePairs(source: string, separator: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf(separator)
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + separator.length).trim()
    if (key === '' || value === '') continue
    out[key] = value
  }
  return out
}

export function draftOf(row: PluginRow): Draft {
  const config = asRecord(row.config)
  const declared = stringOf(config, 'serverName')
  const transport = stringOf(config, 'transport')
  return {
    id: patchIdOf(row),
    occurrence: occurrenceOf(row),
    name: declared === '' ? row.name : declared,
    transport: transport === '' ? 'stdio' : transport,
    command: stringOf(config, 'command'),
    args: Array.isArray(config.args) ? config.args.filter(item => typeof item === 'string').join(' ') : '',
    cwd: stringOf(config, 'cwd'),
    url: stringOf(config, 'url'),
    env: pairsText(config.env, '='),
    headers: pairsText(config.headers, ': '),
  }
}

export function emptyDraft(): Draft {
  return { id: '', occurrence: 0, name: '', transport: 'stdio', command: '', args: '', cwd: '', url: '', env: '', headers: '' }
}

/**
 * Only the keys the domain keeps, in its shape: a filled field is written, a field the user
 * cleared on a row that still carries it becomes null (delete), anything else is left alone.
 */
export function buildConfig(draft: Draft, current: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = { serverName: draft.name.trim(), transport: draft.transport }
  for (const key of ['command', 'cwd', 'url'] as const) {
    const value = draft[key].trim()
    if (value !== '') config[key] = value
    else if (stringOf(current, key) !== '') config[key] = null
  }
  const args = draft.args.trim() === '' ? [] : draft.args.trim().split(/\s+/)
  if (args.length > 0) config.args = args
  else if (Array.isArray(current.args) && current.args.length > 0) config.args = null
  const env = parsePairs(draft.env, '=')
  if (Object.keys(env).length > 0) config.env = env
  const headers = parsePairs(draft.headers, ':')
  if (Object.keys(headers).length > 0) config.headers = headers
  return config
}