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
 * The panel also explains a row: toolDenyReasons() reads the same layers under the names the client
 * renders (install / scope / preset / onDemand / lazy), so a badge never claims a layer the mask
 * does not implement.
 *
 * Failure contract (shared with the other workflow domains): op failures throw a coded
 * DomainFailure and the dispatcher turns it into the error envelope; per-item outcomes are
 * returned as structured rows. Nothing here throws past its caller boundary.
 */
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { StateV2 } from '../core/state.js'
import { maskable, reservedAmong, RESERVED_TOOLS, toolName, toolNames } from '../core/tool-names.js'
import { normalizeGroups, onDemandDeny, onDemandToolNames, type GroupRecord } from './groups.js'

// Re-exported so every layer shares one predicate and one reserved set (core/tool-names.ts owns
// the implementation; this module is where the domains and probes have always imported it).
export { maskable, RESERVED_TOOLS, toolName, toolNames } from '../core/tool-names.js'

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

/**
 * Union of name lists in first-seen order; duplicates collapse and reserved names are dropped.
 * Any model-callable tool name survives, not only MCP ones - that is what lets a session switch
 * off a built-in tool such as `pwsh`.
 */
export function unionNames(lists: Iterable<readonly string[]>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const name of list) {
      if (typeof name !== 'string' || seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return maskable(out)
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
  /** Sorted, deduplicated tool names the mask should deny. */
  deny: string[]
  attributed: Record<SurfaceSource, string[]>
  counts: Record<SurfaceSource, number>
  /** Names some source denied but the host cannot restrict (only filled when known was given). */
  unreachable: string[]
  /** Reserved names a source tried to deny; they are never applied, the panel shows them. */
  reserved: string[]
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
    for (const name of maskable(asStringList(input[source]))) {
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
    reserved: reservedAmong(SURFACE_SOURCES.map(source => asStringList(input[source]))),
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
  /** Loads the panel applied: visible in every session. */
  loaded: string[]
  /** Loads applied from a session (hub_tools): visible only there. */
  sessions: Record<string, string[]>
  /** Load timestamps keyed by tool name (global) or `<sessionId>\u0000<name>`. */
  loadedAt: Record<string, number>
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
    sessions: cleanLazySessions(record.sessions),
    loadedAt: cleanLoadedAt(record.loadedAt),
  }
}

/**
 * Persist the lazy lists under the module's own state key.
 *
 * The same key also carries the on-demand open cache (`open`), so the record is patched instead
 * of replaced: a lazy toggle must never drop which groups a session has opened.
 */
export function writeLazy(state: StateV2, next: LazyState): LazyState {
  const cleaned: LazyState = {
    servers: cleanServers(next.servers),
    loaded: mcpNames(next.loaded),
    sessions: cleanLazySessions(next.sessions),
    loadedAt: cleanLoadedAt(next.loadedAt),
  }
  state.modules[LAZY_STATE_KEY] = {
    ...asRecord(state.modules[LAZY_STATE_KEY]),
    servers: cleaned.servers,
    loaded: cleaned.loaded,
    sessions: cleaned.sessions,
    loadedAt: cleaned.loadedAt,
  }
  return cleaned
}

function cleanLazySessions(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [rawId, names] of Object.entries(asRecord(value))) {
    const sessionId = rawId.trim()
    if (sessionId === '' || sessionId.length > 400) continue
    const cleaned = mcpNames(names)
    if (cleaned.length > 0) out[sessionId] = cleaned
  }
  return out
}

function cleanLoadedAt(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, stamp] of Object.entries(asRecord(value))) {
    if (key === '' || key.length > 600 || typeof stamp !== 'number' || !Number.isFinite(stamp)) continue
    out[key] = stamp
  }
  return out
}

/** Session id to the on-demand groups it has opened; the durable cache behind the log replay. */
export type OpenGroups = Record<string, string[]>

const MAX_OPEN_GROUP = 200

function cleanOpen(value: unknown): OpenGroups {
  const out: OpenGroups = {}
  for (const [rawId, names] of Object.entries(asRecord(value))) {
    const sessionId = rawId.trim()
    if (sessionId === '' || sessionId.length > 400) continue
    const groups: string[] = []
    const seen = new Set<string>()
    for (const entry of asStringList(names)) {
      const name = entry.trim()
      if (name === '' || name.length > MAX_OPEN_GROUP || seen.has(name)) continue
      seen.add(name)
      groups.push(name)
    }
    if (groups.length > 0) out[sessionId] = groups
  }
  return out
}

/** Groups each session has opened, from state.modules['tool-surface'].open. */
export function readOpen(state: StateV2): OpenGroups {
  return cleanOpen(asRecord(state.modules[LAZY_STATE_KEY]).open)
}

/** Persist the open cache without touching the lazy lists that share the module key. */
export function writeOpen(state: StateV2, next: OpenGroups): OpenGroups {
  const cleaned = cleanOpen(next)
  state.modules[LAZY_STATE_KEY] = { ...asRecord(state.modules[LAZY_STATE_KEY]), open: cleaned }
  return cleaned
}

/** Names one session has opened, from the durable cache; empty without a session. */
export function openFor(state: StateV2, sessionId: string | undefined): Set<string> {
  if (sessionId === undefined || sessionId === '') return new Set()
  return new Set(readOpen(state)[sessionId] ?? [])
}

/** Tool name to its server, or null when the name is not shaped like an MCP tool. */
export function serverOf(name: unknown): string | null {
  if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const cut = rest.indexOf('__')
  return cut <= 0 ? null : rest.slice(0, cut)
}

/** Global loads plus one session's own loads. */
export function lazyLoadedFor(lazy: LazyState, sessionId?: string): Set<string> {
  const loaded = new Set(lazy.loaded)
  if (typeof sessionId === 'string' && sessionId !== '') {
    for (const name of lazy.sessions[sessionId] ?? []) loaded.add(name)
  }
  return loaded
}

/** Tools of lazy servers the user has not loaded; 1.x effectiveDeny minus the explicit list. */
export function lazyDeny(lazy: LazyState, known: readonly string[], sessionId?: string): string[] {
  const servers = new Set(lazy.servers)
  if (servers.size === 0) return []
  const loaded = lazyLoadedFor(lazy, sessionId)
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
export function lazyReport(lazy: LazyState, known: readonly string[], sessionId?: string): LazyServerReport[] {
  const rows = new Map<string, LazyServerReport>()
  for (const server of lazy.servers) rows.set(server, { server, total: 0, loaded: 0, tools: [] })
  const loaded = lazyLoadedFor(lazy, sessionId)
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
 * Apply one lazy patch. A patch with names and a sessionId loads for that session only; without a
 * session it is the panel's global load. Turning lazy on/off clears every scope for the server.
 */
export interface LazyPatch {
  server?: string
  on?: boolean
  load?: boolean
  names?: string[]
  sessionId?: string
}

function loadedKey(sessionId: string | undefined, name: string): string {
  return sessionId === undefined || sessionId === '' ? name : sessionId + '\u0000' + name
}

function addLoaded(lazy: LazyState, names: readonly string[], sessionId: string | undefined, now: number): void {
  const key = sessionId === undefined || sessionId === '' ? null : sessionId
  const current = key === null ? lazy.loaded : (lazy.sessions[key] ?? [])
  const merged = [...new Set([...current, ...names])]
  if (key === null) lazy.loaded = merged
  else lazy.sessions[key] = merged
  for (const name of names) lazy.loadedAt[loadedKey(key ?? undefined, name)] = now
}

function removeLoaded(lazy: LazyState, names: readonly string[], sessionId: string | undefined): void {
  const key = sessionId === undefined || sessionId === '' ? null : sessionId
  if (key === null) lazy.loaded = lazy.loaded.filter(name => !names.includes(name))
  else lazy.sessions[key] = (lazy.sessions[key] ?? []).filter(name => !names.includes(name))
  for (const name of names) delete lazy.loadedAt[loadedKey(key ?? undefined, name)]
}

function clearServerLazy(lazy: LazyState, server: string): void {
  const names = new Set([...lazy.loaded, ...Object.values(lazy.sessions).flat()].filter(name => serverOf(name) === server))
  lazy.loaded = lazy.loaded.filter(name => serverOf(name) !== server)
  for (const [sessionId, list] of Object.entries(lazy.sessions)) {
    const kept = list.filter(name => serverOf(name) !== server)
    if (kept.length === 0) delete lazy.sessions[sessionId]
    else lazy.sessions[sessionId] = kept
  }
  for (const key of Object.keys(lazy.loadedAt)) {
    const name = key.includes('\u0000') ? key.slice(key.indexOf('\u0000') + 1) : key
    if (names.has(name) || serverOf(name) === server) delete lazy.loadedAt[key]
  }
}

export function changeLazy(state: StateV2, patch: LazyPatch, known: readonly string[], now = Date.now()): LazyState {
  const lazy = readLazy(state)
  const sessionId = typeof patch.sessionId === 'string' && patch.sessionId.trim() !== '' ? patch.sessionId.trim() : undefined
  if (typeof patch.server === 'string') {
    const server = patch.server.trim()
    if (!SERVER_NAME.test(server)) throw fail('bad-server', 'server names are letters, digits, - and _')
    if (patch.on === true) {
      if (!lazy.servers.includes(server)) lazy.servers.push(server)
      // Turning lazy on hides everything loaded before, in every scope.
      clearServerLazy(lazy, server)
    }
    else {
      lazy.servers = lazy.servers.filter(name => name !== server)
      // Leaving the lazy list makes the server fully visible again; stale entries would otherwise
      // resurrect as "loaded" if the server is marked lazy later.
      clearServerLazy(lazy, server)
    }
  }
  if (!Array.isArray(patch.names) && typeof patch.server === 'string' && typeof patch.load === 'boolean') {
    const server = patch.server.trim()
    const names = known.filter(name => serverOf(name) === server)
    if (patch.load) addLoaded(lazy, names, sessionId, now)
    else removeLoaded(lazy, names, sessionId)
  }
  if (Array.isArray(patch.names)) {
    const wanted = patch.names.filter((name): name is string => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
    const lazyServers = new Set(lazy.servers)
    const usable = wanted.filter(name => lazyServers.has(serverOf(name) ?? ''))
    if (patch.load === true) addLoaded(lazy, usable, sessionId, now)
    else removeLoaded(lazy, usable, sessionId)
  }
  return writeLazy(state, lazy)
}

/** Remove session loads and their timestamps; called when the host disposes the agent. */
export function clearSessionLazy(state: StateV2, sessionId: string): boolean {
  const id = sessionId.trim()
  if (id === '') return false
  const lazy = readLazy(state)
  if (lazy.sessions[id] === undefined) return false
  delete lazy.sessions[id]
  const prefix = id + '\u0000'
  for (const key of Object.keys(lazy.loadedAt)) if (key.startsWith(prefix)) delete lazy.loadedAt[key]
  writeLazy(state, lazy)
  return true
}

/** Drop loads older than ttlMinutes; 0 disables expiry. Returns true when anything changed. */
export function pruneLazy(state: StateV2, now: number, ttlMinutes: number): boolean {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return false
  const lazy = readLazy(state)
  const cutoff = now - ttlMinutes * 60_000
  let changed = false
  const expired = (name: string, key: string): boolean => {
    const stamp = lazy.loadedAt[key]
    if (stamp !== undefined && stamp >= cutoff) return false
    return true
  }
  const keptGlobal: string[] = []
  for (const name of lazy.loaded) {
    if (expired(name, name)) { delete lazy.loadedAt[name]; changed = true }
    else keptGlobal.push(name)
  }
  lazy.loaded = keptGlobal
  for (const [sessionId, list] of Object.entries(lazy.sessions)) {
    const kept: string[] = []
    for (const name of list) {
      const key = sessionId + '\u0000' + name
      if (expired(name, key)) { delete lazy.loadedAt[key]; changed = true }
      else kept.push(name)
    }
    if (kept.length === 0) delete lazy.sessions[sessionId]
    else lazy.sessions[sessionId] = kept
  }
  if (changed) writeLazy(state, lazy)
  return changed
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
  /** Groups as the caller normalized them; omitted means read from state for the report. */
  groups?: readonly GroupRecord[]
}

export interface SurfaceInputOptions {
  /**
   * false when the caller installs the *installation* mask. On-demand tools are per session and
   * live only in the per-agent deny (ToolMask.denyFor); folding them into the installation layer
   * would hide them from every session at once.
   */
  onDemand?: boolean
  /** false for the installation mask: lazy loads are resolved per agent in ToolMask. */
  lazy?: boolean
}

/** The four sources as the state currently holds them, ready for mergeSurface. */
export function surfaceInputFor(
  ctx: SurfaceContext,
  sessionId: string | undefined,
  port: SurfacePort | null,
  options?: SurfaceInputOptions,
): SurfaceInput {
  const known = port?.known() ?? null
  const lineage = ctx.lineage ?? resolveLineage(ctx.services)
  const lists: string[][] = []
  if (sessionId !== undefined && sessionId !== '') {
    for (const id of lineage(sessionId)) lists.push(ctx.state.sessions[id] ?? [])
  }
  const onDemand = options?.onDemand === false
    ? []
    : onDemandDeny(ctx.groups ?? normalizeGroups(ctx.state.groups), known ?? [], openFor(ctx.state, sessionId))
  return {
    install: ctx.state.toolDeny,
    session: unionNames(lists),
    lazy: options?.lazy === false ? [] : lazyDeny(readLazy(ctx.state), known ?? []),
    onDemand,
    known,
  }
}

// -- why a row is missing ----------------------------------------------------

/**
 * The layers that can keep a tool out of the model view, in the order a row reports them.
 *
 * Four of these are the merge sources under their user-facing names: install is state.toolDeny,
 * scope is the session/workspace/subagent overlays (host/scope-policy.ts), lazy is an unloaded
 * lazy server and onDemand is a group that has not been opened. `preset` has no runtime layer of
 * its own - applying a preset policy rewrites state.toolDeny (presets.ts resolvePresetTools) - so
 * it is reported as provenance next to an install denial, never as a separate gate.
 *
 * The values are a stable contract with the client (types.ts ToolDenyReason) and its probe: a new
 * layer is appended, an existing value is never renamed.
 */
export type ToolDenyReason = 'install' | 'scope' | 'preset' | 'onDemand' | 'lazy'

/** The reporting order; the client renders badges in this order and the probe asserts it. */
export const TOOL_DENY_REASONS: readonly ToolDenyReason[] = ['install', 'scope', 'preset', 'onDemand', 'lazy']

/** The name list behind each reason; a layer the caller does not know about denies nothing. */
export type DenyReasonSources = Partial<Record<ToolDenyReason, readonly string[]>>

/** One row's reasons, in TOOL_DENY_REASONS order. A name may be denied by several layers. */
export function denyReasonsOf(name: string, sources: DenyReasonSources): ToolDenyReason[] {
  if (typeof name !== 'string' || name === '') return []
  const out: ToolDenyReason[] = []
  for (const reason of TOOL_DENY_REASONS) {
    const names = sources[reason]
    if (names !== undefined && names.includes(name)) out.push(reason)
  }
  return out
}

/**
 * Every name a scope overlay disables: per-session denies, per-workspace denies and the subagent
 * deny list. Allow lists are deliberately not consulted: this answers "which scope rule names the
 * tool", while the scope formula in host/scope-policy.ts stays the authority on what one agent
 * actually loses (an allow list in the same scope could lift it there).
 */
export function scopeDenyNames(state: StateV2): string[] {
  const lists: string[][] = []
  for (const names of Object.values(state.sessions)) lists.push(names)
  for (const names of Object.values(state.workspaces)) lists.push(names)
  lists.push(state.subagentDeny)
  return unionNames(lists)
}

/** The part of a preset a reason read needs: the names its tool policy disables (G11). */
export interface PresetDenySource {
  toolPolicy?: { disabled?: readonly string[] }
}

export interface DenyReasonInput {
  state: StateV2
  /** Groups as the caller normalized them; on-demand ones hide their tools until opened. */
  groups: readonly GroupRecord[]
  /** Presets as the caller normalized them; only their policies are read here. */
  presets: readonly PresetDenySource[]
  /** Live tool inventory: neither an on-demand group nor a lazy server can hide an unknown name. */
  known: readonly string[]
}

/**
 * Every tool the panel can explain, with its reasons. Names no layer names are absent from the map.
 *
 * The on-demand answer is the mask's own: a group that nothing has opened yet hides its tools, so
 * the badge describes the group ("hidden until opened") rather than one session's current view.
 * Lazy names come from the same lazyDeny() the installation mask reads, which is why the lazy
 * reason and the row's lazyHidden flag cannot disagree.
 */
export function toolDenyReasons(input: DenyReasonInput): Map<string, ToolDenyReason[]> {
  const install = input.state.toolDeny
  const denied = new Set(install)
  const scope = scopeDenyNames(input.state)
  const preset: string[] = []
  for (const entry of input.presets) for (const name of entry.toolPolicy?.disabled ?? []) preset.push(name)
  const onDemand = onDemandDeny(input.groups, input.known, new Set())
  const lazy = lazyDeny(readLazy(input.state), input.known)
  const out = new Map<string, ToolDenyReason[]>()
  for (const name of input.known) {
    const reasons = denyReasonsOf(name, {
      install,
      scope,
      // Only the mask a policy installed can carry its provenance: apply rewrites state.toolDeny
      // and keeps MCP names only, so a policy that never ran never badges a visible row.
      preset: denied.has(name) && serverOf(name) !== null ? preset : [],
      onDemand,
      lazy,
    })
    if (reasons.length > 0) out.set(name, reasons)
  }
  return out
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
  // The installation layer owns install/session/lazy only; on-demand denial is per agent and is
  // merged in ToolMask.denyFor, never here.
  const merged = mergeSurface(surfaceInputFor(options, options.sessionId, port, { onDemand: false, lazy: false }))
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

// -- schema cost -------------------------------------------------------------

/** The tools service that answers definitions(); the mask port and this reader stay separate. */
export const TOOLS_SERVICE = 'tools'

/**
 * The one cost unit this panel reports: the tool's schema JSON, four characters per token.
 * It is a floor, not a measurement - the PTC view adds its own render overhead on top.
 */
export const TOOL_COST_MODE = 'schema-json-4'

export interface ToolCostRow {
  name: string
  /** Serialized schema length; the same string the token divisor reads, so the two agree. */
  bytes: number
  /** Estimated prompt tokens; never below 1, so even a stub schema shows a cost. */
  tokens: number
}

export interface ToolCostReport {
  tools: ToolCostRow[]
  /** Estimated tokens for the named tools (sum of the rows), not a row count. */
  total: number
  mode: typeof TOOL_COST_MODE
}

/** One definition measured the way the mode declares. */
export function costOfDefinition(definition: unknown): { bytes: number; tokens: number } {
  const text = JSON.stringify(definition) ?? ''
  const bytes = text.length
  return { bytes, tokens: Math.max(1, Math.ceil(bytes / 4)) }
}

/**
 * Every definition as a cost row. A definition without a name is dropped: the panel keys costs by
 * tool name, so a row that cannot be attributed would only inflate the total.
 */
export function toolCostReport(definitions: readonly unknown[]): ToolCostReport {
  const tools: ToolCostRow[] = []
  for (const definition of definitions) {
    const record = asRecord(definition)
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (name === '') continue
    const cost = costOfDefinition(definition)
    tools.push({ name, bytes: cost.bytes, tokens: cost.tokens })
  }
  const total = tools.reduce((sum, row) => sum + row.tokens, 0)
  return { tools, total, mode: TOOL_COST_MODE }
}

type DefinitionsCall = (this: unknown, ...args: unknown[]) => unknown

/**
 * The host's tool definitions, or a capability-missing failure.
 *
 * definitions() is optional on the tools service and its arity is not part of the contract: the
 * panel first asks for the two-argument form (agent scope, filter) and retries with one argument
 * when the host refuses that call. A host without the service, or whose call fails both ways,
 * degrades to capability-missing - the tools page still works, it just shows no costs.
 */
export async function readToolDefinitions(services: { get(name: string): unknown }): Promise<unknown[]> {
  const raw = services.get(TOOLS_SERVICE)
  if (raw === null || typeof raw !== 'object') {
    throw fail('capability-missing', 'no ' + TOOLS_SERVICE + ' service: cannot estimate tool schema cost')
  }
  const definitions = (raw as { definitions?: unknown }).definitions
  if (typeof definitions !== 'function') {
    throw fail('capability-missing', TOOLS_SERVICE + '.definitions() is not available: cannot estimate tool schema cost')
  }
  const call = definitions as DefinitionsCall
  let list: unknown
  try {
    list = await call.call(raw, undefined, undefined)
  }
  catch {
    try {
      list = await call.call(raw, undefined)
    }
    catch (error) {
      throw fail('capability-missing', TOOLS_SERVICE + '.definitions() failed: ' + errorText(error))
    }
  }
  return Array.isArray(list) ? list : []
}

// -- ops ---------------------------------------------------------------------

/**
 * The installation deny list from a payload: any tool name the host knows, never a reserved one.
 * A reserved name would make the whole restrict() call fail (the host refuses run_code), so it is
 * refused up front with a code the panel can render.
 */
function requireDeny(payload: unknown): string[] {
  const body = asRecord(payload)
  if (!Array.isArray(body.deny)) throw fail('bad-payload', 'deny must be an array of tool names')
  const names = toolNames(body.deny)
  const reserved = names.filter(name => RESERVED_TOOLS.has(name))
  if (reserved.length > 0) {
    throw fail('reserved-tool', 'these names are reserved and cannot be masked: ' + reserved.slice(0, 3).join(', '), { names: reserved })
  }
  return names
}

async function maskAfter(state: StateV2, env: HostEnv, sessionId?: string): Promise<SurfaceApplyResult> {
  const port = resolveSurfacePort(env.services)
  const mask = env.services.get('toolHub.mask') as { setLazy?: (lazy: LazyState, known: readonly string[] | null) => void } | undefined
  mask?.setLazy?.(readLazy(state), port?.known() ?? null)
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
    if (unknown.length > 0) throw fail('unknown-tool', 'not a tool of this host: ' + unknown.slice(0, 3).join(', '))
  }
  env.state.toolDeny = request
  const backup = await env.save('tool-save')
  return { deny: request, backup, mask: await maskAfter(env.state, env) }
}

const toolToggle: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const name = toolNames([body.name])[0] ?? ''
  if (name === '') throw fail('bad-payload', 'name is required')
  if (RESERVED_TOOLS.has(name)) throw fail('reserved-tool', 'this name is reserved and cannot be masked: ' + name)
  const port = resolveSurfacePort(env.services)
  const known = port?.known() ?? null
  if (known !== null && !known.includes(name)) throw fail('unknown-tool', 'not a tool of this host: ' + name)
  const next = new Set(env.state.toolDeny)
  if (body.enabled === true) next.delete(name)
  else next.add(name)
  env.state.toolDeny = [...next]
  const backup = await env.save('tool-toggle')
  return { name, enabled: body.enabled === true, deny: env.state.toolDeny, backup, mask: await maskAfter(env.state, env) }
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

const toolCosts: OpHandler = async (payload, env) => {
  void payload
  return toolCostReport(await readToolDefinitions(env.services))
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

const lazyStateOp: OpHandler = async (_payload, env) => {
  const lazy = readLazy(env.state)
  return { servers: lazy.servers, loaded: lazy.loaded, sessions: lazy.sessions }
}

const lazyReset: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const server = typeof body.server === 'string' && body.server.trim() !== '' ? body.server.trim() : null
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId.trim() : null
  const lazy = readLazy(env.state)
  const matches = (name: string): boolean => server === null || serverOf(name) === server
  if (sessionId === null) {
    lazy.loaded = lazy.loaded.filter(name => !matches(name))
    for (const [id, list] of Object.entries(lazy.sessions)) {
      const kept = list.filter(name => !matches(name))
      if (kept.length === 0) delete lazy.sessions[id]
      else lazy.sessions[id] = kept
    }
  }
  else {
    lazy.sessions[sessionId] = (lazy.sessions[sessionId] ?? []).filter(name => !matches(name))
    if (lazy.sessions[sessionId]?.length === 0) delete lazy.sessions[sessionId]
  }
  for (const key of Object.keys(lazy.loadedAt)) {
    if (sessionId !== null && !key.startsWith(sessionId + '\u0000')) continue
    const name = key.includes('\u0000') ? key.slice(key.indexOf('\u0000') + 1) : key
    if (sessionId === null || key.startsWith(sessionId + '\u0000')) {
      if (matches(name)) delete lazy.loadedAt[key]
    }
  }
  writeLazy(env.state, lazy)
  const backup = await env.save('lazy-reset')
  const next = readLazy(env.state)
  return { lazy: next.servers, loaded: next.loaded, sessions: next.sessions, backup, mask: await maskAfter(env.state, env) }
}

const lazyToggle: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const patch: LazyPatch = { load: body.load === true }
  if (typeof body.server === 'string' && body.server.trim() !== '') patch.server = body.server
  if (typeof body.sessionId === 'string' && body.sessionId.trim() !== '') patch.sessionId = body.sessionId.trim()
  if (Array.isArray(body.names)) patch.names = asStringList(body.names)
  if (patch.server === undefined && patch.names === undefined) throw fail('bad-payload', 'pass server or names')
  const known = resolveSurfacePort(env.services)?.known() ?? []
  changeLazy(env.state, patch, known)
  const backup = await env.save(patch.load === true ? 'lazy-load' : 'lazy-unload')
  const lazy = readLazy(env.state)
  return { lazy: lazy.servers, loaded: lazy.loaded, backup, mask: await maskAfter(env.state, env) }
}

// -- on-demand groups: open / close / catalog --------------------------------

/** Service that refreshes the per-agent masks after an open or close. */
export const MASK_SERVICE = 'toolHub.mask'

const MAX_SESSION_ID = 200

function requireSessionId(payload: Record<string, unknown>): string {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
  if (sessionId === '') throw fail('bad-payload', 'sessionId is required')
  if (sessionId.length > MAX_SESSION_ID) throw fail('bad-payload', 'sessionId is required (max ' + MAX_SESSION_ID + ' characters)')
  return sessionId
}

/** A group by id first, then by name (case-insensitive); the model only ever sends the name. */
function findGroupByName(groups: readonly GroupRecord[], wanted: string): GroupRecord | undefined {
  const needle = wanted.trim().toLowerCase()
  return groups.find(group => group.id === wanted)
    ?? groups.find(group => group.name.trim().toLowerCase() === needle)
}

/**
 * Tell the live mask what changed, then refresh the mounts.
 *
 * The session log is the truth, but the tool result that proves this open is not in it yet when
 * the op runs; without the live hint the group would only unmask on the next unrelated
 * tools/change. The hint is process-local and the replay takes over once the log catches up.
 */
function refreshAgentMasks(env: HostEnv, sessionId: string, group: string, opened: boolean): void {
  const mask = env.services.get(MASK_SERVICE) as {
    noteOpened?: (id: string, name: string) => void
    noteClosed?: (id: string, name: string) => void
    sync?: () => void
  } | undefined
  if (opened) mask?.noteOpened?.(sessionId, group)
  else mask?.noteClosed?.(sessionId, group)
  mask?.sync?.()
}

const sessionOpen: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const sessionId = requireSessionId(body)
  const wanted = typeof body.group === 'string' ? body.group.trim() : ''
  if (wanted === '') throw fail('bad-payload', 'group is required')
  const groups = normalizeGroups(env.state.groups)
  const group = findGroupByName(groups, wanted)
  if (group === undefined) throw fail('unknown-group', 'no group named "' + wanted + '"')
  if (group.onDemand !== true) throw fail('not-on-demand', 'group "' + group.name + '" is not an on-demand group')
  const known = resolveSurfacePort(env.services)?.known() ?? null
  const tools = onDemandToolNames([group], known)
  const open = readOpen(env.state)
  const canonical = new Map(groups.map(entry => [entry.name.trim().toLowerCase(), entry.name]))
  const names = new Set((open[sessionId] ?? []).map(name => name.trim().toLowerCase()))
  const added = !names.has(group.name.trim().toLowerCase())
  names.add(group.name.trim().toLowerCase())
  open[sessionId] = [...names].map(name => canonical.get(name) ?? name)
  writeOpen(env.state, open)
  const backup = await env.save('session-open')
  refreshAgentMasks(env, sessionId, group.name, true)
  return { group: group.name, id: group.id, tools, opened: true, added, backup }
}

const sessionClose: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const sessionId = requireSessionId(body)
  const wanted = typeof body.group === 'string' ? body.group.trim() : ''
  if (wanted === '') throw fail('bad-payload', 'group is required')
  const groups = normalizeGroups(env.state.groups)
  const group = findGroupByName(groups, wanted)
  if (group === undefined) throw fail('unknown-group', 'no group named "' + wanted + '"')
  const open = readOpen(env.state)
  const needle = group.name.trim().toLowerCase()
  const remaining = (open[sessionId] ?? []).filter(name => name.trim().toLowerCase() !== needle)
  if (remaining.length === 0) delete open[sessionId]
  else open[sessionId] = remaining
  writeOpen(env.state, open)
  const backup = await env.save('session-close')
  refreshAgentMasks(env, sessionId, group.name, false)
  return { group: group.name, id: group.id, opened: false, backup }
}

const toolCatalog: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId.trim() : undefined
  const groups = normalizeGroups(env.state.groups)
  const port = resolveSurfacePort(env.services)
  const known = port?.known() ?? null
  const merged = mergeSurface(surfaceInputFor({ state: env.state, services: env.services, groups }, sessionId, port))
  const open = openFor(env.state, sessionId)
  const opened = new Set([...open].map(name => name.trim().toLowerCase()))
  return {
    groups: groups.map(group => ({
      id: group.id,
      name: group.name,
      description: group.tags.join(' · '),
      tools: onDemandToolNames([group], known),
      onDemand: group.onDemand === true,
      open: opened.has(group.name.trim().toLowerCase()),
    })),
    open: [...open],
    lazy: lazyReport(readLazy(env.state), known ?? []),
    reserved: merged.reserved,
  }
}

/** `scope.list`: what the four layers currently hold, and how each mounted agent resolves. */
const scopeList: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const mask = env.services.get(MASK_SERVICE) as {
    scopeState?: () => {
      workspaces: Record<string, string[]>
      subagent: { allow: string[]; deny: string[] }
      sessions: { deny: Record<string, string[]>; allow: Record<string, string[]> }
    }
    agentsInfo?: () => Array<Record<string, unknown>>
    scopeOf?: (id: string) => Record<string, unknown> | undefined
  } | undefined
  const live = mask?.scopeState?.()
  const agents = agentId === '' ? mask?.agentsInfo?.() ?? [] : [mask?.scopeOf?.(agentId) ?? null].filter((row): row is Record<string, unknown> => row !== null)
  const narrowed = sessionId === '' ? agents : agents.filter(row => row.sessionId === sessionId)
  return {
    workspaces: live?.workspaces ?? env.state.workspaces,
    subagent: live?.subagent ?? { allow: env.state.subagentAllow, deny: env.state.subagentDeny },
    sessions: live?.sessions ?? { deny: env.state.sessions, allow: env.state.sessionAllow },
    agents: narrowed,
  }
}

/** The tool surface domain: mask storage, lazy servers, and the single merged restriction. */
export function toolSurfaceDomain(): DomainRegistration {
  return {
    module: {
      id: 'tool-surface',
      title: { zh: '工具面', en: 'Tool surface' },
      ops: [
        { id: 'tool.save', write: true, audit: false, note: 'Replaces the installation tool deny list and re-applies the one merged mask.' },
        { id: 'tool.toggle', write: true, audit: false, note: 'Adds or removes one installation tool name and re-applies the merged mask.' },
        { id: 'tool.import', write: true, audit: false, note: 'Merges another panel tool deny list into state.json, filtered to tools this host can restrict.' },
        { id: 'tool.plan', write: false, audit: false, note: 'Reports the merged deny list and its per-source attribution; touches nothing.' },
        { id: 'tool.describe', write: false, audit: false, note: 'Renders the surface report plus the lazy catalog prompt; touches nothing.' },
        { id: 'tool.costs', write: false, audit: false, note: 'Estimates each tool schema as JSON ÷4 tokens and sums the catalog; reads tools.definitions() and writes nothing.' },
        { id: 'session.open', write: true, audit: true, note: 'Opens one on-demand group for a session: writes the cache and refreshes the per-agent masks.' },
        { id: 'session.close', write: true, audit: true, note: 'Closes one on-demand group for a session; the panel uses this, the model never needs it.' },
        { id: 'tool.catalog', write: false, audit: false, note: 'Reports groups with their on-demand flag and open state, the lazy catalog and the reserved names.' },
        { id: 'scope.list', write: false, audit: false, note: 'Reports the four scope layers and every mounted agent resolution; touches nothing.' },
        { id: 'lazy.set', write: true, audit: false, note: 'Turns lazy mode on or off for one MCP server and re-applies the mask.' },
        { id: 'lazy.load', write: true, audit: false, note: 'Loads tool names back into the model view and re-applies the mask.' },
        { id: 'lazy.unload', write: true, audit: false, note: 'Unloads tool names from the model view and re-applies the mask.' },
        { id: 'lazy.reset', write: true, audit: false, note: 'Clears lazily loaded names (one server or all) so they start hidden again.' },
        { id: 'lazy.state', write: false, audit: false, note: 'Reports lazy servers and the global/per-session loaded lists; touches nothing.' },
      ],
    },
    handlers: {
      'tool.save': toolSave,
      'tool.toggle': toolToggle,
      'tool.import': toolImport,
      'tool.plan': toolPlan,
      'tool.describe': toolDescribe,
      'tool.costs': toolCosts,
      'session.open': sessionOpen,
      'session.close': sessionClose,
      'tool.catalog': toolCatalog,
      'scope.list': scopeList,
      'lazy.set': lazySet,
      'lazy.load': lazyToggle,
      'lazy.unload': lazyToggle,
      'lazy.reset': lazyReset,
      'lazy.state': lazyStateOp,
    },
  }
}