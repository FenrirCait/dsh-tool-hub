/**
 * The panel's only door to the host.
 *
 * Two endpoints, one envelope: GET snapshot and POST op. Every failure leaves this module as a
 * value ({ ok: false, code, message }), never as a rejection, so a view can render an error
 * banner instead of relying on a catch somewhere up the tree.
 */
import type { CollectionRow, ExtensionStatus, ExtensionViewRow, GroupRow, HistoryEntry, HostMeta, HubSnapshot, MaskInfo, PatchInfo, PluginRow, PresetRow, SceneState, SecretKeys, SkillRootInfo, SkillRow, ToolRow } from './types.js'
import type { SettingsField } from '../shared/types.js'

/** Op ids the panel sends. Kept in one table: a host rename is a one-line change here. */
export const OPS = {
  toggle: 'toggle',
  bulk: 'bulk',
  sceneSave: 'scene.save',
  sceneApply: 'scene.apply',
  sceneExit: 'scene.exit',
  sceneDelete: 'scene.delete',
  sceneLock: 'scene.lock',
  doctor: 'doctor',
} as const

export type OpId = (typeof OPS)[keyof typeof OPS] | string

export interface ApiOk<T> {
  ok: true
  data: T
}

export interface ApiFail {
  ok: false
  code: string
  message: string
  status: number
}

export type ApiResult<T> = ApiOk<T> | ApiFail

const BASE = '/tool-hub/api'
const TIMEOUT_MS = 15000
/** A write can legitimately take a minute: a loader reload follows a patch write. */
export const WRITE_TIMEOUT_MS = 120000

function fail(code: string, message: string, status = 0): ApiFail {
  return { ok: false, code, message, status }
}

interface RawAnswer {
  status: number
  payload: unknown
}

/** One fetch, decoded as JSON when it is JSON. Network and timeout failures become ApiFail. */
async function send(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<ApiResult<RawAnswer>> {
  if (typeof fetch !== 'function') return fail('network', 'fetch is unavailable in this host', 0)
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, controller === null ? init : { ...init, signal: controller.signal })
    const text = await response.text()
    let payload: unknown = null
    if (text !== '') {
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        payload = null
      }
    }
    return { ok: true, data: { status: response.status, payload } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = error instanceof Error && error.name === 'AbortError'
    return fail(aborted ? 'timeout' : 'network', message, 0)
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Unwrap the { ok, data } envelope; anything else is reported as such. */
function unwrap(answer: RawAnswer): ApiResult<unknown> {
  if (answer.status === 401 || answer.status === 403) {
    return fail('forbidden', 'the host refused this request', answer.status)
  }
  const body = asRecord(answer.payload)
  if (body.ok === true) return { ok: true, data: body.data }
  const error = asRecord(body.error)
  const code = asString(error.code, answer.status >= 400 ? 'http' : 'envelope')
  const message = asString(error.message, answer.status >= 400 ? 'request rejected' : 'unexpected response')
  return fail(code, message, answer.status)
}

/**
 * v1 first, the 1.x path second.
 *
 * During the cutover a host may only have the old routes mounted; a 404 on v1 is not an error
 * the user should see, it is a fallback.
 */
async function call(path: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<ApiResult<unknown>> {
  const first = await send(BASE + '/v1' + path, init, timeoutMs)
  if (!first.ok) return first
  if (first.data.status !== 404) return unwrap(first.data)
  const legacy = await send(BASE + path, init, timeoutMs)
  if (!legacy.ok) return legacy
  return unwrap(legacy.data)
}

/** Read the snapshot and normalise it; a partial host answer still yields renderable arrays. */
export async function getSnapshot(): Promise<ApiResult<HubSnapshot>> {
  const result = await call('/snapshot', { method: 'GET', headers: { accept: 'application/json' } })
  if (!result.ok) return result
  return { ok: true, data: normalizeSnapshot(result.data) }
}

/** Send one op. The host is the only writer; the caller re-reads the snapshot afterwards. */
export async function runOp(op: string, payload?: unknown, timeoutMs = TIMEOUT_MS): Promise<ApiResult<unknown>> {
  const result = await call('/op', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ op, payload: payload ?? {} }),
  }, timeoutMs)
  return result
}

// ── narrowing helpers ────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function asRows<T>(value: unknown, map: (row: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const mapped = map(item as Record<string, unknown>)
    if (mapped !== null) out.push(mapped)
  }
  return out
}

function secretKeysOf(value: unknown): SecretKeys {
  const record = asRecord(value)
  return { env: asStringList(record.env), headers: asStringList(record.headers) }
}

function pluginOf(row: Record<string, unknown>): PluginRow | null {
  const id = asString(row.id)
  if (id === '') return null
  return {
    id,
    name: asString(row.name, id),
    kind: asString(row.kind, 'plugin'),
    moduleName: asStringOrNull(row.moduleName),
    description: asString(row.description),
    enabled: asBoolean(row.enabled),
    phase: asStringOrNull(row.phase),
    patchId: asStringOrNull(row.patchId),
    manageable: row.manageable === undefined ? true : asBoolean(row.manageable),
    readOnlyReason: asStringOrNull(row.readOnlyReason),
    self: asBoolean(row.self),
    official: asBoolean(row.official),
    builtinUi: asBoolean(row.builtinUi),
    mcp: asBoolean(row.mcp),
    mcpPatchId: asStringOrNull(row.mcpPatchId),
    mcpEditable: asBoolean(row.mcpEditable),
    transport: asStringOrNull(row.transport),
    command: asStringOrNull(row.command),
    url: asStringOrNull(row.url),
    config: row.config === null || row.config === undefined ? null : asRecord(row.config),
    secretKeys: secretKeysOf(row.secretKeys),
    root: asStringOrNull(row.root),
  }
}

function skillOf(row: Record<string, unknown>): SkillRow | null {
  const id = asString(row.id)
  if (id === '') return null
  return {
    id,
    name: asString(row.name, id),
    enabled: asBoolean(row.enabled),
    rootId: asString(row.rootId, ''),
    root: asStringOrNull(row.root),
    description: asString(row.description),
    entry: asString(row.entry, ''),
    packs: typeof row.packs === 'number' ? row.packs : 0,
  }
}

function groupOf(row: Record<string, unknown>): GroupRow | null {
  const id = asString(row.id)
  if (id === '') return null
  const members = Array.isArray(row.members)
    ? row.members
        .map(member => asRecord(member))
        .filter(member => asString(member.id) !== '')
        .map(member => ({ kind: asString(member.kind, 'plugin'), id: asString(member.id) }))
    : []
  return {
    id,
    name: asString(row.name, id),
    members,
    onDemand: asBoolean(row.onDemand),
    tools: asStringList(row.tools),
    collection: asStringOrNull(row.collection),
    enabled: asBoolean(row.enabled),
    stale: typeof row.stale === 'number' ? row.stale : 0,
  }
}

function maskInfoOf(row: Record<string, unknown>): MaskInfo {
  return {
    available: row.available === true,
    mounted: typeof row.mounted === 'number' ? row.mounted : 0,
    deny: Array.isArray(row.deny) ? row.deny.filter((name): name is string => typeof name === 'string') : [],
    sessions: Array.isArray(row.sessions)
      ? row.sessions.map(item => asRecord(item)).filter(item => asString(item.sessionId) !== '').map(item => ({
          sessionId: asString(item.sessionId),
          deny: Array.isArray(item.deny) ? item.deny.filter((name): name is string => typeof name === 'string') : [],
        }))
      : [],
    problems: Array.isArray(row.problems) ? row.problems.filter((line): line is string => typeof line === 'string') : [],
  }
}

/** A host that predates this field still yields a readable card: the version says so, the rest is blank. */
function metaOf(value: unknown): HostMeta {
  const row = asRecord(value)
  return {
    pluginVersion: asString(row.pluginVersion, 'unknown'),
    node: asString(row.node),
    platform: asString(row.platform),
    pid: typeof row.pid === 'number' && Number.isFinite(row.pid) ? Math.trunc(row.pid) : 0,
  }
}

function patchInfoOf(row: Record<string, unknown>): PatchInfo {
  const blocks = Array.isArray(row.blocks) ? row.blocks.map(item => asRecord(item)).filter(item => asString(item.name) !== '').map(item => ({
    name: asString(item.name),
    beginLine: typeof item.beginLine === 'number' ? item.beginLine : 0,
    endLine: typeof item.endLine === 'number' ? item.endLine : 0,
    rows: Array.isArray(item.rows) ? item.rows.filter((id): id is string => typeof id === 'string') : [],
    foreign: Array.isArray(item.foreign) ? item.foreign.filter((id): id is string => typeof id === 'string') : [],
    known: item.known === true,
  })) : []
  return {
    path: asStringOrNull(row.path),
    rows: typeof row.rows === 'number' ? row.rows : 0,
    blocks,
    unclosed: Array.isArray(row.unclosed) ? row.unclosed.filter((id): id is string => typeof id === 'string') : [],
    foreignTotal: typeof row.foreignTotal === 'number' ? row.foreignTotal : 0,
  }
}

function extensionOf(row: Record<string, unknown>): ExtensionStatus | null {
  const id = asString(row.id)
  if (id === '') return null
  const name = asRecord(row.name)
  const views = Array.isArray(row.views)
    ? row.views.map(view => asRecord(view)).filter(view => asString(view.id) !== '' && asString(view.op) !== '').map(view => ({
        id: asString(view.id),
        title: { zh: asString(asRecord(view.title).zh, asString(view.id)), en: asString(asRecord(view.title).en, asString(view.id)) },
        kind: asString(view.kind, 'json') as ExtensionViewRow['kind'],
        op: asString(view.op),
      }))
    : []
  return {
    id,
    name: { zh: asString(name.zh, id), en: asString(name.en, id) },
    version: asString(row.version),
    apiVersion: typeof row.apiVersion === 'number' ? row.apiVersion : 1,
    dir: asString(row.dir),
    enabled: asBoolean(row.enabled),
    loaded: asBoolean(row.loaded),
    error: asStringOrNull(row.error),
    ops: Array.isArray(row.ops) ? row.ops.filter((op): op is string => typeof op === 'string') : [],
    views,
  }
}

function historyOf(row: Record<string, unknown>): HistoryEntry | null {
  const op = asString(row.op)
  if (op === '') return null
  return {
    at: asString(row.at),
    op,
    detail: asString(row.detail),
    ok: asBoolean(row.ok),
    audit: asBoolean(row.audit),
  }
}

function collectionOf(row: Record<string, unknown>): CollectionRow | null {
  const id = asString(row.id)
  if (id === '') return null
  return { id, name: asString(row.name, id) }
}

function toolOf(row: Record<string, unknown>): ToolRow | null {
  const name = asString(row.name)
  if (name === '') return null
  return { name, enabled: asBoolean(row.enabled), server: asStringOrNull(row.server), lazy: asBoolean(row.lazy), lazyHidden: asBoolean(row.lazyHidden), effective: asBoolean(row.effective), fixed: asBoolean(row.fixed) }
}

function rootOf(row: Record<string, unknown>): SkillRootInfo | null {
  const id = asString(row.id)
  if (id === '') return null
  return {
    id,
    label: asString(row.label, id),
    dir: asString(row.dir),
    scope: asString(row.scope),
    workspace: asStringOrNull(row.workspace),
  }
}

function presetsOf(value: unknown): Record<string, PresetRow> {
  const out: Record<string, PresetRow> = {}
  for (const [name, entry] of Object.entries(asRecord(value))) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const rawPolicy = asRecord(row.toolPolicy)
    const policy = Array.isArray(rawPolicy.groups) || Array.isArray(rawPolicy.disabled)
      ? {
          disabled: asStringList(rawPolicy.disabled),
          groups: (Array.isArray(rawPolicy.groups) ? rawPolicy.groups : []).map(group => asRecord(group)).filter(group => asString(group.name) !== '').map(group => ({
            name: asString(group.name),
            description: asString(group.description),
            patterns: asStringList(group.patterns),
          })),
        }
      : undefined
    out[name] = { plugin: asStringList(row.plugin), skill: asStringList(row.skill), tool: asStringList(row.tool), ...(policy === undefined ? {} : { toolPolicy: policy }) }
  }
  return out
}

function sessionsOf(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [id, names] of Object.entries(asRecord(value))) out[id] = asStringList(names)
  return out
}

const SETTING_TYPES = new Set(['boolean', 'number', 'string', 'select'])

/** Keep only declarations a form can render; a malformed row is dropped, not guessed at. */
function settingsFieldsOf(value: unknown): SettingsField[] {
  return asRows(value, (row) => {
    const key = asString(row.key)
    const type = asString(row.type)
    const label = asRecord(row.label)
    if (key === '' || !SETTING_TYPES.has(type)) return null
    const field = { key, type, default: row.default, label: { zh: asString(label.zh), en: asString(label.en) } } as SettingsField
    if (row.hint !== null && typeof row.hint === 'object') {
      const hint = asRecord(row.hint)
      field.hint = { zh: asString(hint.zh), en: asString(hint.en) }
    }
    if (Array.isArray(row.options)) {
      field.options = row.options.flatMap(option => {
        const entry = asRecord(option)
        const value = asString(entry.value)
        if (value === '') return []
        const text = asRecord(entry.label)
        return [{ value, label: { zh: asString(text.zh), en: asString(text.en) } }]
      })
    }
    if (typeof row.min === 'number') field.min = row.min
    if (typeof row.max === 'number') field.max = row.max
    return field
  })
}

function sceneOf(value: unknown): SceneState {
  const record = asRecord(value)
  const scenes = asRecord(record.scenes)
  const names = asStringList(record.names)
  return {
    mode: asStringOrNull(record.mode),
    since: asNumberOrNull(record.since),
    names: names.length > 0 ? names : Object.keys(scenes),
    scenes,
  }
}

/** A host answer, made total: no field a view reads can be undefined afterwards. */
export function normalizeSnapshot(raw: unknown): HubSnapshot {
  const record = asRecord(raw)
  const paths = asRecord(record.paths)
  const limits = asRecord(record.limits)
  return {
    plugins: asRows(record.plugins, pluginOf),
    skills: asRows(record.skills, skillOf),
    groups: asRows(record.groups, groupOf),
    collections: asRows(record.collections, collectionOf),
    presets: presetsOf(record.presets),
    tools: asRows(record.tools, toolOf),
    sessions: sessionsOf(record.sessions),
    scene: sceneOf(record.scene),
    paths: {
      home: asString(paths.home),
      state: asString(paths.state),
      patch: asStringOrNull(paths.patch),
      skillRoots: asStringList(paths.skillRoots),
      skills: asRows(paths.skills, rootOf),
    },
    settings: asRecord(record.settings) as Record<string, unknown>,
    history: asRows(record.history, historyOf),
    extensions: asRows(record.extensions, extensionOf),
    patchInfo: patchInfoOf(asRecord(record.patchInfo)),
    mask: maskInfoOf(asRecord(record.mask)),
    meta: metaOf(record.meta),
    settingsSchema: settingsFieldsOf(record.settingsSchema),
    mcpError: asStringOrNull(record.mcpError),
    limits: typeof limits.bulk === 'number' ? { bulk: limits.bulk } : null,
    fetchedAt: Date.now(),
  }
}
