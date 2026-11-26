/**
 * Plugins domain: the list of loader entries, the one switch that flips them, and the bulk switch.
 *
 * Toggling goes through the host's own pluginManager — this panel keeps no second opinion about
 * what is on — and a client-bundled UI plugin is refused up front with a reason instead of coming
 * back as a bare "failed", because it has no profile row for the loader to write.
 *
 * The `toggle` / `bulk` op ids are the 1.x switchboard ids and stay here: the registry refuses a
 * duplicate op id, so one module has to own them. The skill half of `toggle` delegates to
 * skills.ts (`setSkillEnabled`), which is the SKILL.md ↔ SKILL.md.disabled rename. skills.ts declares
 * its own `skill.toggle` as an explicit, skill-only entry point.
 *
 * Every op answers with a structured result; a failure is `{ ok: false, code, message }` and never an
 * exception thrown across the process boundary.
 */
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { OpDefinition } from '../shared/types.js'
import { pairMcpRows, parseMcpRows, patchPathFor, readPatchText } from './mcp.js'
import { setSkillEnabled } from './skills.js'

/** This plugin's own module name: the one entry a panel must not switch off (it is the panel). */
const SELF_MODULE = 'dsh-tool-hub'
/** The 1.x cap on one bulk request. */
const MAX_BULK = 400
const PLUGIN_ROWS_TTL_MS = 5000
const BUNDLES_TTL_MS = 60_000
/** The plugin manager persists and reloads per call; a small gap keeps two writes out of one tick. */
const BULK_GAP_MS = 60

export interface PluginRow {
  kind: 'plugin'
  id: string
  name: string
  moduleName: string
  description: string
  descriptionSource: '' | 'meta'
  enabled: boolean
  phase: string | null
  patchId: string | null
  readOnlyReason: string | null
  manageable: boolean
  mcp: boolean
  /** Present for MCP rows: patch config + occurrence + managed-block owner, joined by snapshot. */
  mcpPatchId?: string | null
  mcpOccurrence?: number
  mcpEditable?: boolean
  mcpManagedBy?: string | null
  mcpReadOnlyReason?: string | null
  config?: Record<string, unknown> | null
  secretKeys?: { env: string[]; headers: string[] }
  transport?: string | null
  command?: string | null
  url?: string | null
  self: boolean
  official: boolean
  /** A UI plugin that ships inside the client bundle: no profile row, so the loader cannot flip it. */
  builtinUi: boolean
  role: 'official' | 'base' | 'rest' | 'mcp'
  surface: string | null
}

export interface BundleRow {
  name: string
  version?: string
  enabled: boolean
  official: boolean
  rows: string[]
}

export interface DomainFailure {
  ok: false
  code: string
  message: string
}

export class PluginError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PluginError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new PluginError(code, message)
}

export function failureOf(error: unknown): DomainFailure {
  if (error instanceof PluginError) return { ok: false, code: error.code, message: error.message }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, code: typeof code === 'string' ? code : 'internal', message: error.message }
  }
  return { ok: false, code: 'internal', message: String(error) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isOfficial(moduleName: string): boolean {
  const value = moduleName.toLowerCase()
  return value.startsWith('cordis:') || value.startsWith('@deepseek-ai/')
}

/**
 * The rail's coarse role, from the module name alone: official entries stay official, an MCP client
 * row is an MCP server, and everything else is what the user installed. Automatic topic grouping
 * lives in the groups domain, which owns state; this module only reports what a row declares.
 */
function roleOf(moduleName: string): PluginRow['role'] {
  if (moduleName === '@deepseek-ai/dsh-mcp-client') return 'mcp'
  return isOfficial(moduleName) ? 'official' : 'rest'
}

interface ManagerLike {
  listPlugins?: unknown
  listBundles?: unknown
  setPluginEnabled?: unknown
}

function managerOf(env: HostEnv): ManagerLike {
  let manager: unknown
  try {
    manager = env.services.get('pluginManager')
  }
  catch (error) {
    fail('no-plugin-manager', 'reading pluginManager failed: ' + (error as Error).message)
  }
  if (manager === undefined || manager === null) {
    fail('no-plugin-manager', 'this host exposes no pluginManager service, so plugins cannot be listed')
  }
  return manager as ManagerLike
}

let rowsCache: { at: number; value: PluginRow[] } | null = null
let bundlesCache: { at: number; value: { rows: BundleRow[]; error: string | null } } | null = null

/** Clear the short-lived caches; a switch always invalidates them so the next list is fresh. */
export function invalidatePluginCache(): void {
  rowsCache = null
}

/**
 * Every loader entry as one row. Description comes from the row's own meta and nowhere else:
 * a package.json lookup is a separate concern (doctor), and inventing a source name would make a
 * missing description look like a rendering bug.
 */
export async function listPluginRows(env: HostEnv, fresh = false): Promise<PluginRow[]> {
  const now = env.now()
  if (!fresh && rowsCache !== null && now - rowsCache.at < PLUGIN_ROWS_TTL_MS) return rowsCache.value
  const manager = managerOf(env)
  const list = manager.listPlugins
  if (typeof list !== 'function') fail('no-plugin-manager', 'pluginManager has no listPlugins()')
  let rows: unknown
  try {
    rows = await (list as () => Promise<unknown>).call(manager)
  }
  catch (error) {
    fail('list-failed', 'pluginManager.listPlugins() failed: ' + (error as Error).message)
  }
  if (!Array.isArray(rows)) fail('list-failed', 'pluginManager.listPlugins() did not return an array')
  const value: PluginRow[] = []
  for (const raw of rows) {
    if (!isRecord(raw)) continue
    const meta = isRecord(raw.meta) ? raw.meta : {}
    const moduleName = typeof raw.moduleName === 'string' ? raw.moduleName : typeof raw.entryId === 'string' ? raw.entryId : ''
    const id = typeof raw.entryId === 'string' ? raw.entryId : ''
    if (id === '') continue
    const readOnlyReason = typeof raw.readOnlyReason === 'string' ? raw.readOnlyReason : null
    const metaDescription = typeof meta.description === 'string' ? meta.description.trim() : ''
    const surface = typeof raw.surface === 'string' ? raw.surface : typeof meta.surface === 'string' ? meta.surface : null
    value.push({
      kind: 'plugin',
      id,
      name: typeof meta.title === 'string' && meta.title !== '' ? meta.title : moduleName === '' ? id : moduleName,
      moduleName: moduleName === '' ? id : moduleName,
      description: metaDescription,
      descriptionSource: metaDescription === '' ? '' : 'meta',
      enabled: raw.enabled === true,
      phase: typeof raw.fiberPhase === 'string' ? raw.fiberPhase : null,
      patchId: typeof raw.patchId === 'string' ? raw.patchId : null,
      readOnlyReason,
      manageable: readOnlyReason === null,
      mcp: moduleName === '@deepseek-ai/dsh-mcp-client',
      self: moduleName === SELF_MODULE,
      official: isOfficial(moduleName),
      builtinUi: isOfficial(moduleName) && surface === 'ui',
      role: roleOf(moduleName),
      surface,
    })
  }
  rowsCache = { at: now, value }
  return value
}

/** Bundles are optional: a host without `listBundles` reports that by name, not by throwing. */
export async function listBundles(env: HostEnv, fresh = false): Promise<{ rows: BundleRow[]; error: string | null }> {
  const now = env.now()
  if (!fresh && bundlesCache !== null && now - bundlesCache.at < BUNDLES_TTL_MS) return bundlesCache.value
  let manager: ManagerLike | null = null
  try {
    manager = managerOf(env)
  }
  catch (error) {
    const value = { rows: [], error: failureOf(error).message }
    bundlesCache = { at: now, value }
    return value
  }
  const list = manager.listBundles
  if (typeof list !== 'function') {
    const value = { rows: [], error: 'this host has no pluginManager.listBundles' }
    bundlesCache = { at: now, value }
    return value
  }
  try {
    const raw = await (list as () => Promise<unknown>).call(manager)
    const rows: BundleRow[] = []
    for (const entry of Array.isArray(raw) ? raw : []) {
      const row = isRecord(entry) ? entry : {}
      const members = Array.isArray(row.rows)
        ? row.rows
            .map(item => (typeof item === 'string' ? item : isRecord(item) && typeof item.entryId === 'string' ? item.entryId : undefined))
            .filter((item): item is string => typeof item === 'string')
        : []
      const name = typeof row.name === 'string' ? row.name : ''
      if (name === '') continue
      rows.push({
        name,
        ...(typeof row.version === 'string' ? { version: row.version } : {}),
        enabled: row.enabled === true,
        official: row.official === true,
        rows: members,
      })
    }
    const value = { rows, error: null }
    bundlesCache = { at: now, value }
    return value
  }
  catch (error) {
    const value = { rows: [], error: (error as Error).message }
    bundlesCache = { at: now, value }
    return value
  }
}

/** Whether this entry is the panel itself — the one row it must not switch off. */
async function isSelfEntry(env: HostEnv, id: string): Promise<boolean> {
  if (typeof id !== 'string' || id === '') return false
  try {
    const rows = await listPluginRows(env, true)
    return rows.some(row => row.id === id && row.moduleName === SELF_MODULE)
  }
  catch {
    return false
  }
}

/** The owner of a managed block containing this loader row, or null when it is ours. */
async function managedMcpOwner(env: HostEnv, row: PluginRow, listed: PluginRow[]): Promise<string | null> {
  if (row.mcp !== true || row.patchId === null) return null
  const patch = patchPathFor(env)
  if (patch === null) return null
  try {
    const patchRows = parseMcpRows(await readPatchText(patch))
    // The same pairing mergeMcpRows() uses: a duplicate patch id is resolved by loader order,
    // not by id alone, so an outside row is not rejected because its sibling is managed.
    const loaderRows = listed
      .filter(item => item.mcp === true && typeof item.patchId === 'string')
      .map(item => ({ id: item.id, moduleName: item.moduleName, patchId: item.patchId, enabled: item.enabled, manageable: item.manageable }))
    const pair = pairMcpRows(patchRows, loaderRows).pairs.find(item => item.loader?.id === row.id)
    const target = pair?.row ?? patchRows.find(candidate => candidate.id === row.patchId && candidate.managedBy !== null)
    return target?.managedBy ?? null
  }
  catch {
    return null
  }
}

/** Flip one loader entry through the host's own manager, with the guards 1.x had. */
export async function setPluginEnabled(
  env: HostEnv,
  id: string,
  enabled: boolean,
): Promise<{ id: string; ok: boolean; application: string; message: string; warnings: unknown[] }> {
  const manager = managerOf(env)
  if (typeof manager.setPluginEnabled !== 'function') {
    fail('no-plugin-manager', 'pluginManager has no setPluginEnabled()')
  }
  const listed = await listPluginRows(env, true).catch(() => [] as PluginRow[])
  const listedRow = listed.find(item => item.id === id)
  if (listedRow !== undefined && listedRow.mcp) {
    const owner = await managedMcpOwner(env, listedRow, listed)
    if (owner !== null) fail('read-only', 'mcp row "' + id + '" is inside ' + owner + "'s managed block")
  }
  if (!enabled) {
    const row = listedRow
    if (row === undefined) fail('unknown-plugin', 'no plugin entry answers to ' + id)
    if (row.readOnlyReason !== null) fail('read-only', row.readOnlyReason)
    if (row.builtinUi) {
      fail('builtin-ui', row.moduleName + ' ships inside the client UI bundle; override it in the profile cordis.patch.yml instead')
    }
    // A panel that can switch itself off is a trap: the next click has nowhere to land.
    if (await isSelfEntry(env, id)) fail('self-protected', 'this panel cannot disable itself')
  }
  const result: unknown = await (manager.setPluginEnabled as (entryId: string, on: boolean) => Promise<unknown>)
    .call(manager, id, enabled)
  const record = isRecord(result) ? result : {}
  const application = typeof record.application === 'string' ? record.application : 'unknown'
  const ok = application !== 'failed' && application !== 'cancelled'
  invalidatePluginCache()
  return {
    id,
    ok,
    application,
    message: typeof record.error === 'string' ? record.error : application,
    warnings: Array.isArray(record.warnings) ? record.warnings : [],
  }
}

/** One member of a `toggle` / `bulk` request, or null when the payload is not a member. */
function normalizeMember(raw: unknown): { kind: 'plugin' | 'skill'; id: string } | null {
  if (!isRecord(raw)) return null
  const kind = raw.kind === 'skill' ? 'skill' : raw.kind === 'plugin' ? 'plugin' : null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (kind === null || id === '') return null
  return { kind, id }
}

/** The switchboard: a plugin goes through the manager, a skill through its SKILL.md rename. */
export async function toggleOne(env: HostEnv, kind: string, id: string, enabled: boolean): Promise<unknown> {
  if (kind === 'plugin') return await setPluginEnabled(env, id, enabled)
  if (kind === 'skill') return await setSkillEnabled(env, id, enabled)
  fail('bad-kind', 'unknown kind ' + String(kind))
}

/** Switch up to MAX_BULK members, one structured result each; one failure never stops the rest. */
export async function toggleMany(
  env: HostEnv,
  items: unknown,
  enabled: boolean,
): Promise<{ ok: true; enabled: boolean; results: unknown[]; changed: number; skippedBuiltin: number; truncated: boolean }> {
  const list = Array.isArray(items) ? items.slice(0, MAX_BULK) : []
  const truncated = Array.isArray(items) && items.length > MAX_BULK
  // Turning things off: client-bundled and read-only entries cannot be written, so skip them instead
  // of collecting dozens of identical failures when a whole group is switched off.
  let unwritable = new Set<string>()
  if (!enabled) {
    try {
      const rows = await listPluginRows(env)
      unwritable = new Set(rows.filter(row => row.builtinUi || row.readOnlyReason !== null).map(row => row.id))
    }
    catch {
      // A list failure just means no skip list; each member then reports its own refusal.
    }
  }
  const results: unknown[] = []
  const skippedBuiltin: string[] = []
  for (const item of list) {
    const member = normalizeMember(item)
    if (member === null) {
      results.push({ id: isRecord(item) && typeof item.id === 'string' ? item.id : '', ok: false, code: 'not-a-member', message: 'not a member' })
      continue
    }
    if (member.kind === 'plugin' && unwritable.has(member.id)) {
      skippedBuiltin.push(member.id)
      continue
    }
    try {
      results.push(await toggleOne(env, member.kind, member.id, enabled))
    }
    catch (error) {
      results.push({ id: member.id, ...failureOf(error) })
    }
    await new Promise(done => setTimeout(done, BULK_GAP_MS))
  }
  const changed = results.filter(row => isRecord(row) && row.ok === true).length
  return { ok: true, enabled, results, changed, skippedBuiltin: skippedBuiltin.length, truncated }
}

// ── ops ──────────────────────────────────────────────────────────────────────

const OPS: OpDefinition[] = [
  { id: 'toggle', write: true, audit: true, note: 'Switches one plugin (through the host) or one skill (SKILL.md rename) on or off.' },
  { id: 'bulk', write: true, audit: true, note: 'Switches up to 400 plugins or skills at once; the panel confirms past 20.' },
  { id: 'plugin.list', write: false, audit: false, note: 'Lists the loader entries the host reports; reading only.' },
  { id: 'plugin.bundles', write: false, audit: false, note: 'Lists the loader bundles the host can name, or says it cannot.' },
]

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

/** Settings the plugins tab exposes; the client renders them generically from here. */
function pluginsSettings() {
  return [
    {
      key: 'plugins.skipBuiltinUi',
      type: 'boolean' as const,
      default: true,
      label: { zh: '批量关闭时跳过内建 UI 插件', en: 'Skip bundled UI plugins in a bulk switch-off' },
      hint: { zh: '这类插件没有 profile 行，写入只会失败；跳过并按数量报告。', en: 'They have no profile row, so the write can only fail; skip them and report the count.' },
    },
  ]
}

/** One handler per declared op; every failure comes back as ok:false with a code. */
export function createPluginsDomain(): DomainRegistration {
  return {
    module: {
      id: 'plugins',
      title: { zh: '插件', en: 'Plugins' },
      ops: OPS,
      panels: [{ slot: 'plugins.tab', id: 'plugins', order: 10 }],
      settings: pluginsSettings(),
    },
    handlers: {
      'plugin.list': guarded(async (payload, env) => {
        const rows = await listPluginRows(env, payload.fresh === true)
        const bundles = await listBundles(env, payload.fresh === true)
        return { ok: true, rows, count: rows.length, bundles: bundles.rows, bundlesError: bundles.error }
      }),
      'plugin.bundles': guarded(async (payload, env) => {
        const bundles = await listBundles(env, payload.fresh === true)
        return { ok: true, rows: bundles.rows, count: bundles.rows.length, error: bundles.error }
      }),
      'toggle': guarded(async (payload, env) => {
        const kind = field(payload, 'kind')
        const id = field(payload, 'id')
        if (kind === '' || id === '') fail('bad-payload', 'toggle needs kind and id')
        return await toggleOne(env, kind, id, payload.enabled === true)
      }),
      'bulk': guarded(async (payload, env) => await toggleMany(env, payload.items, payload.enabled === true)),
    },
  }
}

/** Alias so a registrar can pick either naming style. */
export const pluginsDomain = createPluginsDomain