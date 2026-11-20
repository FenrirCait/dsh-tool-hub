/**
 * The tool surface: every reason a tool is masked, merged into one deny list and one host call.
 *
 * 1.x derived the mask in three places (lib/tool-filter.js per agent, lib/lazy.js for lazy
 * servers, and lib/index.js for the session overlays) and re-derived it per mount. 2.0 keeps
 * one merger instead: four name sources, one fixed order, one deny list, one restrict().
 *
 * Source order (the first source that denies a name owns it in the report):
 *
 *   1. install  - state.toolDeny: the installation list, applies everywhere.
 *   2. session  - this session's overlay, already unioned over its lineage (see sessions.ts).
 *   3. lazy     - tools of a lazy server the user has not loaded, from state.modules['tool-surface'].
 *   4. onDemand - tools an on-demand group keeps out of the model until the group is switched on.
 *
 * Masking is a union, so the order never changes *what* is hidden; it decides attribution in
 * attributed / describe, and the sorted output makes the signature - and therefore applySurface -
 * idempotent.
 *
 * Failure contract (shared with the other workflow domains): op failures throw a coded
 * DomainFailure and the dispatcher turns it into the error envelope; per-item outcomes are
 * returned as structured rows. Nothing here throws past its caller boundary.
 */
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { StateV2 } from '../core/state.js'

/** Public MCP tool names look like mcp__<serverName>__<toolName>. */
export const MCP_TOOL_PREFIX = 'mcp__'

/** serverName shape shared by scenes and lazy servers. */
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

// -- failures ----------------------------------------------------------------

/** One coded domain failure. The dispatcher maps code/message into the error envelope. */
export class DomainFailure extends Error {
  readonly code: string
  readonly detail: Record<string, unknown>

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DomainFailure'
    this.code = code
    this.detail = detail
  }
}

export function fail(code: string, message: string, detail: Record<string, unknown> = {}): DomainFailure {
  return new DomainFailure(code, message, detail)
}

export function errorText(error: unknown): string {
  return error !== null && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)
}

/** A thrown value flattened for a per-item result row. */
export function failureOf(error: unknown): { code: string; message: string } {
  if (error instanceof DomainFailure) return { code: error.code, message: error.message }
  return { code: 'internal', message: errorText(error) }
}

// -- small readers -----------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function mcpNames(value: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of asStringList(value)) {
    if (!name.startsWith(MCP_TOOL_PREFIX) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** Union of name lists in first-seen order; only MCP names survive, duplicates collapse. */
export function unionNames(lists: Iterable<readonly string[]>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const name of list) {
      if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX) || seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

// -- the merger --------------------------------------------------------------

export type SurfaceSource = 'install' | 'session' | 'lazy' | 'onDemand'

/** The merge order, named once so the probe and the report cannot drift apart. */
export const SURFACE_SOURCES: readonly SurfaceSource[] = ['install', 'session', 'lazy', 'onDemand']

export type SurfaceInput = Partial<Record<SurfaceSource, readonly string[]>> & {
  /** Live tool inventory; when given, names the host cannot restrict are reported, not applied. */
  known?: readonly string[] | null
}

export interface MergedSurface {
  /** Sorted, deduplicated MCP names the mask should deny. */
  deny: string[]
  attributed: Record<SurfaceSource, string[]>
  counts: Record<SurfaceSource, number>
  /** Names some source denied but the host cannot restrict (only filled when known was given). */
  unreachable: string[]
  /** True when a live inventory was supplied. */
  known: boolean
  /** Stable identity of the deny list; '' for an empty surface. */
  signature: string
}

/**
 * Merge the four sources into the one list a single restrict() accepts.
 *
 * A name denied by several sources is attributed to the earliest source in SURFACE_SOURCES,
 * which is why the order is part of the contract rather than an implementation detail.
 */
export function mergeSurface(input: SurfaceInput): MergedSurface {
  const attributed: Record<SurfaceSource, string[]> = { install: [], session: [], lazy: [], onDemand: [] }
  const owner = new Map<string, SurfaceSource>()
  const all: string[] = []
  for (const source of SURFACE_SOURCES) {
    for (const name of mcpNames(input[source])) {
      const previous = owner.get(name)
      if (previous === undefined) {
        owner.set(name, source)
        all.push(name)
        attributed[source].push(name)
      }
    }
  }
  const knownList = input.known ?? null
  let deny = all.slice().sort(compare)
  let unreachable: string[] = []
  if (knownList !== null) {
    const allowed = new Set(knownList)
    unreachable = deny.filter(name => !allowed.has(name)).sort(compare)
    deny = deny.filter(name => allowed.has(name))
  }
  const counts: Record<SurfaceSource, number> = {
    install: attributed.install.length,
    session: attributed.session.length,
    lazy: attributed.lazy.length,
    onDemand: attributed.onDemand.length,
  }
  return {
    deny,
    attributed,
    counts,
    unreachable,
    known: knownList !== null,
    signature: deny.join('\u0000'),
  }
}

/** One line for the panel: what the surface hides, and which source hid it. */
export function describeSurface(merged: MergedSurface): string {
  const detail = SURFACE_SOURCES.map(source => source + ' ' + merged.counts[source]).join(' · ')
  const base = 'deny: ' + merged.deny.length + ' (' + detail + ')'
  return merged.unreachable.length === 0 ? base : base + ' · not in view: ' + merged.unreachable.join(', ')
}

export interface SurfacePlan {
  add: string[]
  remove: string[]
  unchanged: string[]
  changed: boolean
}

/** What applying merged would change relative to the list currently installed. */
export function planSurface(previous: readonly string[] | null, merged: MergedSurface): SurfacePlan {
  const before = new Set(previous ?? [])
  const next = new Set(merged.deny)
  const add = merged.deny.filter(name => !before.has(name))
  const remove = previous === null ? [] : [...before].filter(name => !next.has(name)).sort(compare)
  const unchanged = merged.deny.filter(name => before.has(name))
  return { add, remove, unchanged, changed: add.length > 0 || remove.length > 0 }
}

// -- lazy servers ------------------------------------------------------------

export interface LazyState {
  servers: string[]
  loaded: string[]
}

/** Where 2.0 keeps the lazy lists. 1.x kept them at the state top level. */
export const LAZY_STATE_KEY = 'tool-surface'

function cleanServers(value: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of asStringList(value)) {
    const name = entry.trim()
    if (!SERVER_NAME.test(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** Read the lazy lists, falling back to the 1.x top-level keys for a file not yet re-saved. */
export function readLazy(state: StateV2): LazyState {
  const record = asRecord(state.modules[LAZY_STATE_KEY])
  const legacy = state as unknown as { lazyServers?: unknown; lazyLoaded?: unknown }
  return {
    servers: cleanServers(record.servers ?? legacy.lazyServers),
    loaded: mcpNames(record.loaded ?? legacy.lazyLoaded),
  }
}

/** Persist the lazy lists under the module's own state key. */
export function writeLazy(state: StateV2, next: LazyState): LazyState {
  const cleaned: LazyState = { servers: cleanServers(next.servers), loaded: mcpNames(next.loaded) }
  state.modules[LAZY_STATE_KEY] = { servers: cleaned.servers, loaded: cleaned.loaded }
  return cleaned
}

/** Tool name to its server, or null when the name is not shaped like an MCP tool. */
export function serverOf(name: unknown): string | null {
  if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const cut = rest.indexOf('__')
  return cut <= 0 ? null : rest.slice(0, cut)
}

/** Tools of lazy servers the user has not loaded; 1.x effectiveDeny minus the explicit list. */
export function lazyDeny(lazy: LazyState, known: readonly string[]): string[] {
  const servers = new Set(lazy.servers)
  if (servers.size === 0) return []
  const loaded = new Set(lazy.loaded)
  const out: string[] = []
  for (const name of known) {
    const server = serverOf(name)
    if (server !== null && servers.has(server) && !loaded.has(name)) out.push(name)
  }
  return out
}

export interface LazyServerReport {
  server: string
  total: number
  loaded: number
  tools: string[]
}

/** Lazy servers with how many of their tools are currently visible. */
export function lazyReport(lazy: LazyState, known: readonly string[]): LazyServerReport[] {
  const rows = new Map<string, LazyServerReport>()
  for (const server of lazy.servers) rows.set(server, { server, total: 0, loaded: 0, tools: [] })
  const loaded = new Set(lazy.loaded)
  for (const name of known) {
    const server = serverOf(name)
    const row = server === null ? undefined : rows.get(server)
    if (row === undefined) continue
    row.total += 1
    row.tools.push(name)
    if (loaded.has(name)) row.loaded += 1
  }
  return [...rows.values()]
}

/**
 * The prompt paragraph that makes a masked catalog discoverable. Empty when nothing is lazy, so
 * the section can stay registered without costing a token in the common case.
 */
export function lazyPrompt(lazy: LazyState, known: readonly string[]): string {
  const rows = lazyReport(lazy, known).filter(row => row.total > 0)
  if (rows.length === 0) return ''
  return [
    'Tool Hub 里有懒加载的 MCP 服务器（工具定义默认不进上下文）：',
    ...rows.map(row => '- ' + row.server + ': ' + row.total + ' 个工具，已加载 ' + row.loaded + ' 个'),
    '要用它们时先调用 hub_tools：action="list" 看清单，action="enable" 加 names 或 server 加载；加载后下一轮即可直接调用。',
  ].join('\n')
}

/**
 * Apply one lazy patch, mirroring 1.x changeLazy exactly - including its quirk: a patch that
 * carries only server and no on turns lazy off for that server and loads all its tools.
 */
export interface LazyPatch {
  server?: string
  on?: boolean
  load?: boolean
  names?: string[]
}

export function changeLazy(state: StateV2, patch: LazyPatch, known: readonly string[]): LazyState {
  const lazy = readLazy(state)
  if (typeof patch.server === 'string') {
    const server = patch.server.trim()
    if (!SERVER_NAME.test(server)) throw fail('bad-server', 'server names are letters, digits, - and _')
    const listed = lazyReport({ ...lazy, servers: [server] }, known)[0]
    if (patch.on === true) {
      if (!lazy.servers.includes(server)) lazy.servers.push(server)
      // Turning lazy on hides everything that was loaded before: the user asked for a quiet server.
      lazy.loaded = lazy.loaded.filter(name => serverOf(name) !== server)
      if (listed !== undefined) lazy.loaded = lazy.loaded.filter(name => !listed.tools.includes(name))
    }
    else {
      lazy.servers = lazy.servers.filter(name => name !== server)
      if (listed !== undefined) lazy.loaded = [...new Set([...lazy.loaded, ...listed.tools])]
    }
  }
  if (Array.isArray(patch.names)) {
    const wanted = patch.names.filter((name): name is string => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
    const lazyServers = new Set(lazy.servers)
    const usable = wanted.filter(name => lazyServers.has(serverOf(name) ?? ''))
    if (patch.load === true) lazy.loaded = [...new Set([...lazy.loaded, ...usable])]
    else lazy.loaded = lazy.loaded.filter(name => !usable.includes(name))
  }
  return writeLazy(state, lazy)
}

// -- host ports --------------------------------------------------------------

/** Service that installs the mask for one agent scope. */
export const SURFACE_SERVICE = 'toolHub.surface'
/** Service that answers session lineage (lineage(id) or parentOf(id)). */
export const LINEAGE_SERVICE = 'toolHub.lineage'

/**
 * The narrow host surface this domain needs. One restrict per pass; the returned function lifts
 * exactly the restriction it installed.
 */
export interface SurfacePort {
  known(): string[] | null
  restrict(deny: string[]): (() => void) | void
  /** Optional: tools an on-demand group keeps out of the model. */
  onDemandTools?(): string[]
  /** Optional: another panel's deny list, for tool.import. */
  readForeignDeny?(): Promise<string[]>
}

export function resolveSurfacePort(services: { get(name: string): unknown }): SurfacePort | null {
  const raw = services.get(SURFACE_SERVICE)
  if (raw === null || typeof raw !== 'object') return null
  const port = raw as Partial<SurfacePort>
  if (typeof port.known !== 'function' || typeof port.restrict !== 'function') return null
  return raw as SurfacePort
}

/** The outcome shape every host switch returns; shared by groups, presets and scenes. */
export interface ToggleOutcome {
  ok: boolean
  code?: string
  message?: string
}

export type LineageFn = (sessionId: string) => string[]

export const MAX_LINEAGE_DEPTH = 8

/** Walk a parent chain without leaving it: depth-capped and cycle-safe (lineage is host data). */
function walkLineage(sessionId: string, parentOf: (id: string) => string | undefined, maxDepth = MAX_LINEAGE_DEPTH): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let current = sessionId
  while (current !== '' && !seen.has(current) && chain.length < maxDepth) {
    seen.add(current)
    chain.push(current)
    current = parentOf(current) ?? ''
  }
  return chain
}

/**
 * Resolve lineage from the host. sessions.ts owns the canonical walk; this copy only serves a
 * foreign port that exposes parentOf itself, and a missing service degrades to "self only".
 */
export function resolveLineage(services: { get(name: string): unknown }): LineageFn {
  const raw = services.get(LINEAGE_SERVICE)
  if (raw !== null && typeof raw === 'object') {
    const port = raw as { lineage?: unknown; parentOf?: unknown }
    if (typeof port.lineage === 'function') {
      const lineage = port.lineage as (id: string) => unknown
      return sessionId => asStringList(lineage(sessionId)).filter(name => name !== '')
    }
    if (typeof port.parentOf === 'function') {
      const parentOf = port.parentOf as (id: string) => unknown
      return sessionId => walkLineage(sessionId, id => {
        const parent = parentOf(id)
        return typeof parent === 'string' && parent !== '' ? parent : undefined
      })
    }
  }
  return sessionId => (sessionId === '' ? [] : [sessionId])
}

// -- sources from state ------------------------------------------------------

export interface SurfaceContext {
  state: StateV2
  services: { get(name: string): unknown }
  lineage?: LineageFn
}

/** The four sources as the state currently holds them, ready for mergeSurface. */
export function surfaceInputFor(ctx: SurfaceContext, sessionId: string | undefined, port: SurfacePort | null): SurfaceInput {
  const known = port?.known() ?? null
  const lineage = ctx.lineage ?? resolveLineage(ctx.services)
  const lists: string[][] = []
  if (sessionId !== undefined && sessionId !== '') {
    for (const id of lineage(sessionId)) lists.push(ctx.state.sessions[id] ?? [])
  }
  return {
    install: ctx.state.toolDeny,
    session: unionNames(lists),
    lazy: lazyDeny(readLazy(ctx.state), known ?? []),
    onDemand: port?.onDemandTools?.() ?? [],
    known,
  }
}

// -- the one restrict --------------------------------------------------------

interface AppliedEntry {
  signature: string
  undo: (() => void) | undefined
}

/** Per-state, per-session memory of what was installed; a state object is one dispatch's view. */
const applied = new WeakMap<StateV2, Map<string, AppliedEntry>>()

export function forgetSurface(state: StateV2): void {
  applied.delete(state)
}

export type SurfaceStatus = 'applied' | 'unchanged' | 'no-port' | 'refused'

export interface SurfaceApplyResult {
  ok: boolean
  status: SurfaceStatus
  /** True when a live mask is in force after this call. */
  masked: boolean
  deny: string[]
  description: string
  message?: string
}

export interface SurfaceApplyOptions extends SurfaceContext {
  sessionId?: string | undefined
}

/**
 * Merge, then call the host exactly once.
 *
 * Ordering follows 1.x's two hard-won rules: install the new restriction before lifting the old
 * one (restrictions intersect, so the momentary overlap over-denies - the safe direction), and
 * lift when the merged list becomes empty instead of restricting to nothing.
 */
export async function applySurface(options: SurfaceApplyOptions): Promise<SurfaceApplyResult> {
  const port = resolveSurfacePort(options.services)
  const merged = mergeSurface(surfaceInputFor(options, options.sessionId, port))
  const description = describeSurface(merged)
  const key = options.sessionId ?? '*'
  const records = applied.get(options.state) ?? new Map<string, AppliedEntry>()
  applied.set(options.state, records)
  const previous = records.get(key)
  if (port === null) {
    return {
      ok: true,
      status: 'no-port',
      masked: false,
      deny: merged.deny,
      description,
      message: 'no ' + SURFACE_SERVICE + ' service: the deny list is stored but no mask was installed',
    }
  }
  if (merged.deny.length === 0) {
    if (previous === undefined) {
      records.set(key, { signature: '', undo: undefined })
      return { ok: true, status: 'unchanged', masked: false, deny: [], description }
    }
    try {
      previous.undo?.()
    }
    catch {
      /* the scope is gone; there is nothing left to lift */
    }
    records.set(key, { signature: '', undo: undefined })
    return { ok: true, status: 'applied', masked: false, deny: [], description }
  }
  if (previous !== undefined && previous.signature === merged.signature) {
    return { ok: true, status: 'unchanged', masked: true, deny: merged.deny, description }
  }
  let undo: (() => void) | undefined
  try {
    const outcome = port.restrict(merged.deny.slice())
    undo = typeof outcome === 'function' ? outcome : undefined
  }
  catch (error) {
    return {
      ok: false,
      status: 'refused',
      masked: false,
      deny: merged.deny,
      description,
      message: errorText(error),
    }
  }
  const prior = previous?.undo
  records.set(key, { signature: merged.signature, undo })
  if (prior !== undefined) {
    try {
      prior()
    }
    catch {
      /* over-masking is the safe direction; the fresh restriction above is the truth */
    }
  }
  return { ok: true, status: 'applied', masked: true, deny: merged.deny, description }
}

// -- ops ---------------------------------------------------------------------

function requireDeny(payload: unknown): string[] {
  const body = asRecord(payload)
  if (!Array.isArray(body.deny)) throw fail('bad-payload', 'deny must be an array of tool names')
  return mcpNames(body.deny)
}

async function maskAfter(state: StateV2, env: HostEnv, sessionId?: string): Promise<SurfaceApplyResult> {
  const result = await applySurface({ state, services: env.services, sessionId })
  if (!result.ok) env.log('warn', '[tool-hub] tool mask refused: ' + (result.message ?? result.status))
  return result
}

const toolSave: OpHandler = async (payload, env) => {
  const request = requireDeny(payload)
  const port = resolveSurfacePort(env.services)
  const known = port?.known() ?? null
  if (known !== null) {
    const allowed = new Set(known)
    const unknown = request.filter(name => !allowed.has(name))
    if (unknown.length > 0) throw fail('unknown-tool', 'not an MCP tool of this host: ' + unknown.slice(0, 3).join(', '))
  }
  env.state.toolDeny = request
  const backup = await env.save('tool-save')
  return { deny: request, backup, mask: await maskAfter(env.state, env) }
}

const toolImport: OpHandler = async (payload, env) => {
  void payload
  const port = resolveSurfacePort(env.services)
  const readForeignDeny = port?.readForeignDeny
  if (port === null || readForeignDeny === undefined) {
    throw fail('capability-missing', 'no ' + SURFACE_SERVICE + '.readForeignDeny service: cannot read the other panel deny list')
  }
  const foreign = mcpNames(await readForeignDeny.call(port))
  const known = port.known()
  // The other panel keeps names it saw once; a server that is gone leaves stale entries behind.
  const usable = known === null ? foreign : foreign.filter(name => known.includes(name))
  const before = new Set(env.state.toolDeny)
  const merged = mcpNames([...env.state.toolDeny, ...usable])
  env.state.toolDeny = merged
  const backup = await env.save('tool-import')
  return {
    deny: merged,
    added: merged.filter(name => !before.has(name)).length,
    read: usable.length,
    backup,
    mask: await maskAfter(env.state, env),
  }
}

const toolPlan: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
  const port = resolveSurfacePort(env.services)
  const merged = mergeSurface(surfaceInputFor({ state: env.state, services: env.services }, sessionId, port))
  return {
    deny: merged.deny,
    attributed: merged.attributed,
    counts: merged.counts,
    unreachable: merged.unreachable,
    description: describeSurface(merged),
    plan: planSurface(null, merged),
  }
}

const toolDescribe: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
  const port = resolveSurfacePort(env.services)
  const known = port?.known() ?? []
  const lazy = readLazy(env.state)
  const merged = mergeSurface(surfaceInputFor({ state: env.state, services: env.services }, sessionId, port))
  return {
    description: describeSurface(merged),
    prompt: lazyPrompt(lazy, known),
    lazy: lazyReport(lazy, known),
    deny: merged.deny,
  }
}

const lazySet: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  if (typeof body.server !== 'string' || body.server.trim() === '') throw fail('bad-payload', 'server is required')
  const known = resolveSurfacePort(env.services)?.known() ?? []
  changeLazy(env.state, { server: body.server, on: body.on === true }, known)
  const backup = await env.save('lazy-set')
  const lazy = readLazy(env.state)
  return { lazy: lazy.servers, loaded: lazy.loaded, backup, mask: await maskAfter(env.state, env) }
}

const lazyToggle: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const patch: LazyPatch = { load: body.load === true }
  if (typeof body.server === 'string' && body.server.trim() !== '') patch.server = body.server
  if (Array.isArray(body.names)) patch.names = asStringList(body.names)
  if (patch.server === undefined && patch.names === undefined) throw fail('bad-payload', 'pass server or names')
  const known = resolveSurfacePort(env.services)?.known() ?? []
  changeLazy(env.state, patch, known)
  const backup = await env.save(patch.load === true ? 'lazy-load' : 'lazy-unload')
  const lazy = readLazy(env.state)
  return { lazy: lazy.servers, loaded: lazy.loaded, backup, mask: await maskAfter(env.state, env) }
}

/** The tool surface domain: mask storage, lazy servers, and the single merged restriction. */
export function toolSurfaceDomain(): DomainRegistration {
  return {
    module: {
      id: 'tool-surface',
      title: { zh: '工具面', en: 'Tool surface' },
      ops: [
        { id: 'tool.save', write: true, audit: false, note: 'Replaces the installation tool deny list and re-applies the one merged mask.' },
        { id: 'tool.import', write: true, audit: false, note: 'Merges another panel tool deny list into state.json, filtered to tools this host can restrict.' },
        { id: 'tool.plan', write: false, audit: false, note: 'Reports the merged deny list and its per-source attribution; touches nothing.' },
        { id: 'tool.describe', write: false, audit: false, note: 'Renders the surface report plus the lazy catalog prompt; touches nothing.' },
        { id: 'lazy.set', write: true, audit: false, note: 'Turns lazy mode on or off for one MCP server and re-applies the mask.' },
        { id: 'lazy.load', write: true, audit: false, note: 'Loads tool names back into the model view and re-applies the mask.' },
        { id: 'lazy.unload', write: true, audit: false, note: 'Unloads tool names from the model view and re-applies the mask.' },
      ],
    },
    handlers: {
      'tool.save': toolSave,
      'tool.import': toolImport,
      'tool.plan': toolPlan,
      'tool.describe': toolDescribe,
      'lazy.set': lazySet,
      'lazy.load': lazyToggle,
      'lazy.unload': lazyToggle,
    },
  }
}
