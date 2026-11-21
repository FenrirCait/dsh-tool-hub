/**
 * Per-agent tool masking (the 2.0 port of 1.x lib/tool-filter.js).
 *
 * The host refuses a context-global tools.restrict() ("would mask every agent"), so the mask is a
 * tiny plugin mounted inside each agent's own scope. Two traps, learned from skill-mcp-panel
 * #59/#62, stay guarded here:
 *   - restrict() and its undo emit tools/change synchronously and this module listens to that
 *     event, so a re-entrancy flag plus a signature check keeps it from recursing.
 *   - restrict() throws for a name that is not (yet) restrictable; MCP tools arrive later, so every
 *     pass filters the list against the live view instead of trusting what it remembered.
 *
 * Deny lists are layers: applySurface installs a new list before lifting the previous one, and with
 * layers that lift removes only what it installed. Session overlays are a separate map keyed by
 * session id, inherited along the parent chain an agent announces.
 */
import { maskable } from '../core/tool-names.js'
import { onDemandDeny, onDemandToolNames, type GroupRecord } from '../domains/groups.js'
import { DISCOVERY_NAMES, restoredOpenGroups, type SessionLogLike } from '../domains/group-exposure.js'
import { agentScopeOf, resolveScopedDeny, type AgentScope, type ScopeResolution } from './scope-policy.js'

/** Public MCP tool names look like `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = 'mcp__'

interface ToolsMember {
  view?: (agent: unknown) => { knownNames?: unknown; restrictableNames?: unknown } | null | undefined
  restrict?: (request: { deny: string[] }) => (() => void) | void
}

interface PromptMember {
  section?: (section: { name: string; order: number; text: () => string; interpolate: boolean }) => (() => void) | void
  getSectionOrder?: (name: string) => number
}

interface ScopeContext {
  tools?: ToolsMember
  systemPrompt?: PromptMember
  get?: (name: string) => unknown
  on?: (event: string, callback: (...args: unknown[]) => unknown) => (() => void) | void
}

interface AgentLike {
  id?: string
  ctx?: { plugin?: (plugin: unknown) => { dispose?: () => void } | undefined }
  session?: {
    id?: string
    /** Number of events in the session log; the replay watermark. */
    seq?: number
    /** The host's event reader, used to replay which on-demand groups this session opened. */
    eventAt?: (seq: number) => unknown
    requestHeader?: () => unknown
    header?: unknown
  }
  meta?: Record<string, unknown>
}

interface MaskCtx {
  get(name: string): unknown
  on?(event: string, callback: (payload: unknown) => void): (() => void) | void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(error: unknown): string {
  return error !== null && typeof error === 'object' && 'message' in error ? String((error as Error).message) : String(error)
}

/**
 * Any maskable tool name. The reserved set (run_code and this panel's own tools) lives in
 * core/tool-names.ts, shared with the domains, so a name cannot be maskable in one layer and
 * fatal in another.
 */
function cleanNames(names: readonly unknown[]): string[] {
  return maskable(names.filter((name): name is string => typeof name === 'string'))
}

function namesFrom(view: unknown, key: 'knownNames' | 'restrictableNames'): string[] | null {
  if (!isRecord(view)) return null
  const raw = view[key]
  // The host returns Sets; older fixtures and snapshots use arrays. Both are pre-restriction.
  if (raw instanceof Set) return [...raw].filter((name): name is string => typeof name === 'string')
  if (Array.isArray(raw)) return raw.filter((name): name is string => typeof name === 'string')
  return null
}

/** Names the host currently exposes, or null when the tools service cannot answer. */
export function knownToolNames(ctx: { get(name: string): unknown }): string[] | null {
  try {
    const tools = ctx.get('tools') as ToolsMember | undefined
    if (tools === null || typeof tools !== 'object' || typeof tools.view !== 'function') return null
    const view = tools.view(undefined)
    return namesFrom(view, 'knownNames') ?? namesFrom(view, 'restrictableNames')
  }
  catch {
    return null
  }
}

function warn(ctx: MaskCtx, message: string): void {
  const line = '[tool-hub] ' + message
  try {
    const logger = ctx.get('logger') as { warn?: (text: string) => void } | undefined
    if (typeof logger?.warn === 'function') {
      logger.warn(line)
      return
    }
  }
  catch {
    /* no logger service */
  }
  try {
    console.warn(line)
  }
  catch {
    /* nothing left to report to */
  }
}

interface Mounted {
  fiber: { dispose?: () => void } | undefined
  holder: { sync: () => void }
  /** Kept so `scope.list` can report cwd/origin/layers without a second mount. */
  agent: AgentLike
}

/**
 * Where on-demand data comes from. The runtime owns state and the tools service, so the mask
 * asks instead of holding either; every call is guarded, and a failing source hides nothing.
 */
export interface OnDemandSource {
  groups(): readonly GroupRecord[]
  known(): readonly string[] | null
  /** The durable cache fallback for a session whose log cannot be replayed. */
  cached?(sessionId: string | undefined): readonly string[]
}

/** One agent's scope as `scope.list` reports it. */
export interface AgentScopeInfo {
  agentId: string
  sessionId?: string
  cwd?: string
  workspaceKey: string | null
  parentSessionId?: string
  subagent: boolean
  layers: ScopeResolution['layers']
  deny: string[]
}

/** The prompt line for one closed on-demand group; the reference keeps lines short. */
const MAX_CATALOG_LINE = 80

function onDemandLine(group: GroupRecord, count: number): string {
  const name = group.name.trim()
  const head = '- ' + name + ' (' + count + ' 个工具)'
  const call = '调用 tool_list({group:"' + name + '"}) 打开'
  const description = (group.tags ?? []).join(' · ').trim()
  let line = head + '；' + call
  if (description !== '') {
    const room = MAX_CATALOG_LINE - line.length - 2
    if (room > 4) line += '：' + (description.length <= room ? description : description.slice(0, room - 1) + '…')
  }
  return line.length <= MAX_CATALOG_LINE ? line : line.slice(0, MAX_CATALOG_LINE - 1) + '…'
}

export class ToolMask {
  readonly ctx: MaskCtx
  /** One entry per applySurface install; the union is the installation deny list. */
  private readonly layers = new Map<symbol, string[]>()
  private readonly sessionDeny = new Map<string, string[]>()
  private readonly sessionAllow = new Map<string, string[]>()
  private readonly workspaceDeny = new Map<string, string[]>()
  private subagentDeny: string[] = []
  private subagentAllow: string[] = []
  private readonly parents = new Map<string, string>()
  private readonly mounted = new Map<string, Mounted>()
  private readonly mounting = new Set<string>()
  private syncing = false
  private disposed = false
  private readonly problems: string[] = []
  /** Where on-demand groups, the live tool view and the open cache come from; null until wired. */
  private onDemand: OnDemandSource | null = null
  /** Replay results keyed by (sessionId, seq): the O(seq) walk runs once per watermark. */
  private readonly openCache = new Map<string, ReadonlySet<string>>()
  /** Opens this process applied before the session log carried their result. */
  private readonly liveOpen = new Map<string, Set<string>>()
  /** Closes this process applied; subtracted from what a replay reports. */
  private readonly liveClosed = new Map<string, Set<string>>()

  constructor(ctx: MaskCtx) {
    this.ctx = ctx
  }

  /** Installation deny: the union of every installed layer. */
  deny(): string[] {
    const names = new Set<string>()
    for (const layer of this.layers.values()) for (const name of layer) names.add(name)
    return [...names]
  }

  info(): { mounted: number; deny: string[]; sessions: Array<{ sessionId: string; deny: string[] }>; problems: string[] } {
    return {
      mounted: this.mounted.size,
      deny: this.deny(),
      sessions: [...this.sessionDeny.entries()].map(([sessionId, names]) => ({ sessionId, deny: [...names] })),
      problems: [...this.problems],
    }
  }

  /** Install one layer; the returned function lifts exactly that layer. */
  addLayer(names: readonly string[]): () => void {
    const cleaned = cleanNames(names)
    if (cleaned.length === 0) return () => {}
    const key = Symbol('layer')
    this.layers.set(key, cleaned)
    this.refresh()
    let live = true
    return () => {
      if (!live) return
      live = false
      this.layers.delete(key)
      this.refresh()
    }
  }

  private refresh(): void {
    if (this.disposed) return
    if (!this.hasWork()) {
      this.unmountAll()
      return
    }
    for (const agent of this.agents()) this.applyTo(agent)
    this.syncAll()
  }

  /** Whether any layer could hide a name; on-demand groups count even with empty layers. */
  private hasWork(): boolean {
    if (this.deny().length > 0 || this.sessionDeny.size > 0 || this.sessionAllow.size > 0) return true
    if (this.workspaceDeny.size > 0 || this.subagentAllow.length > 0 || this.subagentDeny.length > 0) return true
    return this.onDemandGroups().length > 0
  }

  private sessionIdOf(agent: AgentLike | undefined): string | undefined {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string' && sessionId !== '') return sessionId
    return typeof agent?.id === 'string' && agent.id !== '' ? agent.id : undefined
  }

  private parentSessionOf(agent: AgentLike | undefined): string | undefined {
    try {
      const header = agent?.session?.requestHeader?.() ?? agent?.session?.header
      if (isRecord(header)) {
        const parent = header.parentSession ?? header.parentSessionId
        if (typeof parent === 'string' && parent !== '') return parent
      }
    }
    catch {
      /* a host without requestHeader keeps the mask working, just not inheriting */
    }
    const meta = agent?.meta
    const parent = meta?.parentSessionId ?? meta?.parentSession
    return typeof parent === 'string' && parent !== '' ? parent : undefined
  }

  private lineageOf(sessionId: string | undefined): string[] {
    const chain: string[] = []
    const seen = new Set<string>()
    let current = sessionId
    while (typeof current === 'string' && current !== '' && !seen.has(current) && chain.length < 8) {
      seen.add(current)
      chain.push(current)
      current = this.parents.get(current)
    }
    return chain
  }

  /** One agent's scope resolution; the formula itself lives in scope-policy.ts. */
  private resolve(agent: AgentLike | undefined): { scope: AgentScope; resolution: ScopeResolution; lineage: string[] } {
    const scope = agentScopeOf(agent)
    const lineage = this.lineageOf(scope.sessionId)
    const resolution = resolveScopedDeny({
      install: this.deny(),
      workspaces: Object.fromEntries(this.workspaceDeny),
      sessionDeny: Object.fromEntries(this.sessionDeny),
      sessionAllow: Object.fromEntries(this.sessionAllow),
      subagentAllow: this.subagentAllow,
      subagentDeny: this.subagentDeny,
      lineage,
      scope,
    })
    return { scope, resolution, lineage }
  }

  /**
   * The four-layer scope plus the on-demand layer for this agent.
   *
   * The scope formula ((install ∪ workspace ∪ session deny) − session allow, then the subagent
   * deny/allow) is shared with `scope.list`; the on-demand layer is per session and is added
   * last, so a reserved name or a tool the host cannot restrict never reaches a restrict() call.
   */
  denyFor(agent: AgentLike | undefined): string[] {
    const names = new Set(this.resolve(agent).resolution.deny)
    for (const name of this.onDemandDenyFor(agent)) names.add(name)
    return [...names].sort()
  }

  // -- on-demand groups ------------------------------------------------------

  /** Wire (or unwire) the on-demand source; the runtime calls this once after mount. */
  setOnDemandSource(source: OnDemandSource | null): void {
    this.onDemand = source
    this.openCache.clear()
    this.refresh()
  }

  /** An open applied by this process: effective before the session log records its result. */
  noteOpened(sessionId: string | undefined, group: string): void {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    const name = group.trim()
    if (id === '' || name === '') return
    const set = this.liveOpen.get(id) ?? new Set<string>()
    set.add(name)
    this.liveOpen.set(id, set)
    this.liveClosed.get(id)?.delete(name)
  }

  /** A close applied by this process; it outranks what the replay still reports. */
  noteClosed(sessionId: string | undefined, group: string): void {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    const name = group.trim()
    if (id === '' || name === '') return
    const set = this.liveClosed.get(id) ?? new Set<string>()
    set.add(name)
    this.liveClosed.set(id, set)
    this.liveOpen.get(id)?.delete(name)
  }

  private onDemandGroups(): readonly GroupRecord[] {
    try {
      return this.onDemand?.groups() ?? []
    }
    catch {
      return []
    }
  }

  /** Groups this agent has opened: replay the session log when reachable, else the cache. */
  private openFor(agent: AgentLike | undefined, sessionId: string | undefined): ReadonlySet<string> {
    let base: ReadonlySet<string>
    const session = agent?.session
    const seq = typeof session?.seq === 'number' && Number.isFinite(session.seq) ? session.seq : undefined
    const eventAt = typeof session?.eventAt === 'function' ? session.eventAt : undefined
    const key = sessionId === undefined ? '' : sessionId + '\u0000' + (seq ?? -1)
    const cached = key === '' ? undefined : this.openCache.get(key)
    if (cached !== undefined) {
      base = cached
    }
    else if (eventAt !== undefined && seq !== undefined && sessionId !== undefined) {
      const log: SessionLogLike = { seq, eventAt: value => eventAt.call(session, value) }
      const result = restoredOpenGroups(log, DISCOVERY_NAMES)
      // The log is the truth even when it says "nothing open": a fork keeps what its parent had
      // opened before the fork point and stays closed for anything opened afterwards.
      if (result.events > 0) {
        base = result.open
        if (key !== '') {
          this.openCache.set(key, base)
          while (this.openCache.size > 64) {
            const oldest = this.openCache.keys().next().value
            if (oldest === undefined) break
            this.openCache.delete(oldest)
          }
        }
      }
      else {
        base = new Set(this.onDemand?.cached?.(sessionId) ?? [])
      }
    }
    else {
      base = new Set(this.onDemand?.cached?.(sessionId) ?? [])
    }
    const live = sessionId === undefined ? undefined : this.liveOpen.get(sessionId)
    const closed = sessionId === undefined ? undefined : this.liveClosed.get(sessionId)
    if ((live === undefined || live.size === 0) && (closed === undefined || closed.size === 0)) return base
    const merged = new Set(base)
    if (live !== undefined) for (const name of live) merged.add(name)
    if (closed !== undefined) {
      const drop = new Set([...closed].map(name => name.trim().toLowerCase()))
      for (const name of [...merged]) if (drop.has(name.trim().toLowerCase())) merged.delete(name)
    }
    return merged
  }

  private onDemandDenyFor(agent: AgentLike | undefined): string[] {
    const source = this.onDemand
    if (source === null) return []
    let groups: readonly GroupRecord[]
    let known: readonly string[] | null
    try {
      groups = source.groups()
      known = source.known()
    }
    catch {
      return []
    }
    // Without a live inventory a mask cannot name a tool safely; the group stays reported in the
    // catalog and takes effect once the tools service answers.
    if (groups.length === 0 || known === null) return []
    try {
      return onDemandDeny(groups, known, this.openFor(agent, this.sessionIdOf(agent)))
    }
    catch {
      return []
    }
  }

  /** The system-prompt catalog: on-demand groups this agent has not opened yet. */
  private onDemandText(agent: AgentLike): string {
    const groups = this.onDemandGroups()
    if (groups.length === 0) return ''
    const open = new Set([...this.openFor(agent, this.sessionIdOf(agent))].map(name => name.trim().toLowerCase()))
    const lines: string[] = []
    for (const group of groups) {
      if (group.onDemand !== true) continue
      if (open.has(group.name.trim().toLowerCase())) continue
      const names = onDemandToolNames([group])
      if (names.length === 0) continue
      lines.push(onDemandLine(group, names.length))
    }
    if (lines.length === 0) return ''
    return ['Tool Hub 里有按需工具组（工具定义默认不进上下文）：', ...lines].join('\n')
  }

  // -- reporting -------------------------------------------------------------

  /** The durable/process scope state, as `scope.list` reports it. */
  scopeState(): {
    workspaces: Record<string, string[]>
    subagent: { allow: string[]; deny: string[] }
    sessions: { deny: Record<string, string[]>; allow: Record<string, string[]> }
  } {
    return {
      workspaces: Object.fromEntries(this.workspaceDeny),
      subagent: { allow: [...this.subagentAllow], deny: [...this.subagentDeny] },
      sessions: { deny: Object.fromEntries(this.sessionDeny), allow: Object.fromEntries(this.sessionAllow) },
    }
  }

  scopeOf(agentId: string): AgentScopeInfo | undefined {
    const entry = this.mounted.get(agentId)
    return entry === undefined ? undefined : this.scopeInfo(agentId, entry.agent)
  }

  agentsInfo(): AgentScopeInfo[] {
    const out: AgentScopeInfo[] = []
    for (const [id, entry] of this.mounted) out.push(this.scopeInfo(id, entry.agent))
    return out
  }

  private scopeInfo(agentId: string, agent: AgentLike): AgentScopeInfo {
    const { scope, resolution } = this.resolve(agent)
    return {
      agentId,
      sessionId: scope.sessionId,
      cwd: scope.cwd,
      workspaceKey: resolution.workspaceKey,
      parentSessionId: scope.parentSessionId,
      subagent: resolution.subagent,
      layers: resolution.layers,
      deny: this.denyFor(agent),
    }
  }

  setSessionDeny(sessionId: string, names: readonly string[]): void {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const cleaned = cleanNames(names)
    if (cleaned.length === 0) this.sessionDeny.delete(sessionId)
    else this.sessionDeny.set(sessionId, cleaned)
    this.refresh()
  }

  /** Session allow list: subtracted after every deny layer along the lineage. */
  setSessionAllow(sessionId: string, names: readonly string[]): void {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const cleaned = cleanNames(names)
    if (cleaned.length === 0) this.sessionAllow.delete(sessionId)
    else this.sessionAllow.set(sessionId, cleaned)
    this.refresh()
  }

  /** Workspace deny override, keyed by the workspace root an agent reports. */
  setWorkspaceDeny(key: string, names: readonly string[]): void {
    const cleaned = cleanNames(names)
    if (key.trim() === '') return
    if (cleaned.length === 0) this.workspaceDeny.delete(key)
    else this.workspaceDeny.set(key, cleaned)
    this.refresh()
  }

  /** Policy applied to subagent sessions only. */
  setSubagentPolicy(deny: readonly string[], allow: readonly string[]): void {
    this.subagentDeny = cleanNames(deny)
    this.subagentAllow = cleanNames(allow)
    this.refresh()
  }

  /** Seed the scope maps from the durable state; no sync is triggered here. */
  hydrateScopes(scopes: {
    sessions?: unknown
    sessionAllow?: unknown
    workspaces?: unknown
    subagentAllow?: unknown
    subagentDeny?: unknown
  }): void {
    const fill = (target: Map<string, string[]>, value: unknown): void => {
      if (!isRecord(value)) return
      for (const [key, names] of Object.entries(value)) {
        if (key === '' || key.length > 400 || !Array.isArray(names)) continue
        const cleaned = cleanNames(names)
        if (cleaned.length > 0) target.set(key, cleaned)
      }
    }
    fill(this.sessionDeny, scopes.sessions)
    fill(this.sessionAllow, scopes.sessionAllow)
    fill(this.workspaceDeny, scopes.workspaces)
    this.subagentAllow = cleanNames(Array.isArray(scopes.subagentAllow) ? scopes.subagentAllow : [])
    this.subagentDeny = cleanNames(Array.isArray(scopes.subagentDeny) ? scopes.subagentDeny : [])
  }

  /** Seed overlays before any agent mounts (state.sessions is the durable copy). */
  hydrate(sessions: unknown): void {
    if (!isRecord(sessions)) return
    for (const [sessionId, names] of Object.entries(sessions)) {
      if (sessionId === '' || !Array.isArray(names)) continue
      const cleaned = cleanNames(names)
      if (cleaned.length > 0) this.sessionDeny.set(sessionId, cleaned)
    }
  }

  private note(message: string): void {
    this.problems.push(message)
    if (this.problems.length > 8) this.problems.shift()
  }

  private pluginFor(agent: AgentLike): { plugin: unknown; holder: { sync: () => void } } {
    const holder = { sync: () => {} }
    const mask = this
    const plugin = {
      name: 'dsh-tool-hub:tool-mask',
      inject: ['tools', 'systemPrompt'],
      apply(scope: ScopeContext): void {
        let undo: (() => void) | undefined
        let applied: string | null = null
        let live = true
        let inside = false
        const teardown: Array<() => void> = []
        const syncOnce = (): void => {
          const deny = mask.denyFor(agent)
          let known: Set<string>
          try {
            const tools = (scope.tools ?? scope.get?.('tools')) as ToolsMember | undefined
            const view = tools?.view?.(undefined)
            // The host documents restrictableNames; older shapes only expose knownNames. Both are
            // pre-restriction, unlike definitions(), so either is safe to filter against.
            const restrictable = namesFrom(view, 'restrictableNames') ?? namesFrom(view, 'knownNames')
            if (restrictable === null) {
              const shape = view === null || view === undefined ? 'no view' : Object.keys(view as Record<string, unknown>).join('/')
              throw new Error('tools.view() returned no names (' + shape + ', tools=' + (tools === undefined ? 'missing' : 'present') + ')')
            }
            known = new Set(restrictable)
          }
          catch (error) {
            // definitions() is post-restriction; feeding it to the mask would drop every denied
            // name and lift the mask on the next pass, so skipping is the only honest fallback.
            warn(mask.ctx, 'cannot read restrictable tools: ' + textOf(error))
            mask.note('view: ' + textOf(error) + '; mask skipped')
            return
          }
          const usable = deny.filter(name => known.has(name))
          const signature = [...usable].sort().join('\u0000')
          if (signature === applied) return
          const tools = scope.tools ?? scope.get?.('tools') as ToolsMember | undefined
          if (usable.length === 0) {
            if (undo !== undefined) {
              try {
                undo()
              }
              catch (error) {
                warn(mask.ctx, 'cannot lift the previous mask: ' + textOf(error))
              }
              undo = undefined
            }
            applied = ''
            return
          }
          // Install before lifting: restrictions intersect, so the momentary overlap over-denies.
          let next: (() => void) | void
          try {
            next = tools?.restrict?.({ deny: usable })
          }
          catch (error) {
            warn(mask.ctx, 'cannot apply the tool mask: ' + textOf(error))
            mask.note('apply: ' + textOf(error))
            return
          }
          const previous = undo
          undo = typeof next === 'function' ? next : undefined
          applied = signature
          if (previous !== undefined) {
            try {
              previous()
            }
            catch (error) {
              warn(mask.ctx, 'cannot lift the previous mask: ' + textOf(error))
            }
          }
        }
        const sync = (): void => {
          if (!live || inside) return
          inside = true
          try {
            syncOnce()
          }
          finally {
            inside = false
          }
        }
        holder.sync = sync
        // Prompt affinity without fiber reflection: the section names that advertise MCP tools
        // are derived from the live names (mcp:<server>, tool:<tool>), and a section disappears
        // once every tool it introduces is hidden. Returns the presentation untouched otherwise.
        try {
          scope.on?.('system-prompt/assemble', async (...args: unknown[]) => {
            const next = args.at(-1)
            if (typeof next !== 'function') return args[0]
            const assembly = await (next as () => Promise<unknown>)()
            let known: string[] = []
            try {
              const tools = (scope.tools ?? scope.get?.('tools')) as ToolsMember | undefined
              const view = tools?.view?.(undefined)
              known = namesFrom(view, 'knownNames') ?? namesFrom(view, 'restrictableNames') ?? []
            }
            catch {
              known = []
            }
            return filterPromptSections(assembly, mask.denyFor(agent), known)
          })
        }
        catch {
          /* a host without the prompt waterfall keeps the tool mask only */
        }
        // The on-demand catalog: agent scope, because the open set is per session. The section is
        // registered even when empty - text() answers '' and the host renders nothing.
        try {
          const prompt = scope.systemPrompt ?? (scope.get?.('systemPrompt') as PromptMember | undefined)
          if (typeof prompt?.section === 'function') {
            const base = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('MCP_SERVERS') : 3100
            const order = (typeof base === 'number' && Number.isFinite(base) ? base : 3100) + 1
            const off = prompt.section.call(prompt, {
              name: 'tools:on-demand',
              order,
              text: () => mask.onDemandText(agent),
              // Group and tool names may contain ` characters; never treat them as variables.
              interpolate: false,
            })
            if (typeof off === 'function') teardown.push(off)
          }
        }
        catch {
          /* a host without prompt sections keeps the mask */
        }
        try {
          // The host's plugin scope exposes effect(); call it through the scope object itself.
          const effect = (scope as unknown as { effect?: (fn: () => () => void) => void }).effect
          effect?.(() => () => {
            live = false
            holder.sync = () => {}
            for (const off of teardown.splice(0)) {
              try {
                off()
              }
              catch {
                /* the scope already dropped it */
              }
            }
            if (undo !== undefined) {
              try {
                undo()
              }
              catch {
                /* already gone with the scope */
              }
            }
          })
        }
        catch {
          /* a minimal host without effect: the scope still disposes the restriction */
        }
        sync()
      },
    }
    return { plugin, holder }
  }

  applyTo(agent: AgentLike | undefined): void {
    const sessionId = this.sessionIdOf(agent)
    const parent = this.parentSessionOf(agent)
    if (typeof sessionId === 'string' && typeof parent === 'string' && parent !== sessionId) {
      this.parents.set(sessionId, parent)
    }
    if (this.disposed || !this.hasWork()) return
    if (agent === undefined) return
    const id = typeof agent.id === 'string' && agent.id !== '' ? agent.id : undefined
    if (id === undefined || this.mounted.has(id) || this.mounting.has(id)) return
    const scope = agent?.ctx
    if (scope === undefined || typeof scope.plugin !== 'function') {
      this.note('agent ' + id + ' has no scoped context to plugin into')
      return
    }
    this.mounting.add(id)
    try {
      const { plugin, holder } = this.pluginFor(agent)
      const fiber = scope.plugin(plugin)
      this.mounted.set(id, { fiber, holder, agent })
    }
    catch (error) {
      warn(this.ctx, 'cannot mount the tool mask on agent ' + id + ': ' + textOf(error))
      this.note('mount ' + id + ': ' + textOf(error))
    }
    finally {
      this.mounting.delete(id)
    }
  }

  agents(): AgentLike[] {
    try {
      const agents = this.ctx.get('agents') as { list?: () => unknown } | undefined
      const rows = agents?.list?.()
      return Array.isArray(rows) ? rows.filter((row): row is AgentLike => isRecord(row)) : []
    }
    catch {
      return []
    }
  }

  syncAll(): void {
    if (this.disposed || this.syncing) return
    this.syncing = true
    try {
      for (const entry of [...this.mounted.values()]) {
        try {
          entry.holder.sync()
        }
        catch (error) {
          warn(this.ctx, 'cannot refresh the tool mask: ' + textOf(error))
        }
      }
    }
    finally {
      this.syncing = false
    }
  }

  private unmountAll(): void {
    for (const [id, entry] of [...this.mounted.entries()]) {
      this.mounted.delete(id)
      try {
        entry.fiber?.dispose?.()
      }
      catch (error) {
        warn(this.ctx, 'cannot unmount the tool mask from agent ' + id + ': ' + textOf(error))
      }
    }
  }

  /** Stop tracking an agent the host already disposed; its scope lifts the restriction itself. */
  forget(id: string): void {
    this.mounted.delete(id)
  }

  dispose(): void {
    this.disposed = true
    this.unmountAll()
  }
}

/** Bind a mask to the agent lifecycle; returns the mask. */
export function attachToolMask(
  ctx: MaskCtx,
  sessions: unknown,
  scopes?: { sessionAllow?: unknown; workspaces?: unknown; subagentAllow?: unknown; subagentDeny?: unknown },
): ToolMask {
  const mask = new ToolMask(ctx)
  mask.hydrateScopes({ sessions, ...(scopes ?? {}) })
  const offCreated = ctx.on?.('agent/created', payload => {
    const agent = isRecord(payload) ? payload.agent as AgentLike : undefined
    mask.applyTo(agent)
  })
  const offDisposed = ctx.on?.('agent/disposed', payload => {
    const agent = isRecord(payload) ? payload.agent as AgentLike : undefined
    const id = agent?.id
    if (typeof id === 'string') mask.forget(id)
  })
  const offTools = ctx.on?.('tools/change', () => {
    mask.syncAll()
  })
  // Existing agents are mounted on the next turn, not inside the plugin's own apply(): an agent
  // fiber can still be starting, and scope.plugin() then waits for it (observed as a host that
  // answers the page but never finishes Runtime.create).
  setTimeout(() => {
    for (const agent of mask.agents()) mask.applyTo(agent)
  }, 0)
  const originalDispose = mask.dispose.bind(mask)
  mask.dispose = () => {
    for (const off of [offCreated, offDisposed, offTools]) {
      try {
        off?.()
      }
      catch {
        /* subscriptions may already be gone with the scope */
      }
    }
    originalDispose()
  }
  return mask
}

/**
 * Drop prompt sections that exist only to advertise hidden tools.
 *
 * `mcp:<server>` disappears when every known tool of that server is denied;
 * `mcp-resource-servers` disappears when every known MCP tool is denied. Tool schemas are filtered
 * too on hosts whose waterfall still owns the declaration list. Other sections are untouched:
 * family sections that do not name a tool need the fiber-affinity reflection and are out of scope.
 */
export function filterPromptSections(assembly: unknown, deny: readonly string[], known: readonly string[]): unknown {
  if (!isRecord(assembly) || !Array.isArray(assembly.sections)) return assembly
  const denied = new Set(deny)
  const mcpKnown = known.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
  const serverOf = (name: string): string | null => {
    const rest = name.slice(MCP_TOOL_PREFIX.length)
    const cut = rest.indexOf('__')
    return cut <= 0 ? null : rest.slice(0, cut)
  }
  const sections = assembly.sections.filter(section => {
    if (!isRecord(section)) return true
    const name = typeof section.name === 'string' ? section.name : ''
    if (name === 'mcp-resource-servers') {
      return !(mcpKnown.length > 0 && mcpKnown.every(tool => denied.has(tool)))
    }
    if (!name.startsWith('mcp:')) return true
    const server = name.slice(4)
    const tools = mcpKnown.filter(tool => serverOf(tool) === server)
    return !(tools.length > 0 && tools.every(tool => denied.has(tool)))
  })
  const filtered: Record<string, unknown> = { ...assembly, sections }
  if (Array.isArray(assembly.tools)) {
    filtered.tools = assembly.tools.filter(schema => {
      const name = isRecord(schema) && typeof schema.name === 'string' ? schema.name : ''
      return name === '' || !denied.has(name)
    })
  }
  return filtered
}

/** The toolHub.surface port applySurface expects; each install is one mask layer. */
export function surfacePort(mask: ToolMask): {
  known(): string[] | null
  restrict(deny: string[]): () => void
} {
  return {
    known: () => knownToolNames(mask.ctx),
    restrict: (deny: string[]) => mask.addLayer(deny),
  }
}

/** Read-only control surface for ops that own a session overlay. */
export interface MaskControl {
  setSessionDeny(sessionId: string, names: string[]): void
  setSessionAllow(sessionId: string, names: string[]): void
  setWorkspaceDeny(key: string, names: string[]): void
  setSubagentPolicy(deny: string[], allow: string[]): void
  /** Record a live open/close before the session log carries its result, then re-sync. */
  noteOpened(sessionId: string, group: string): void
  noteClosed(sessionId: string, group: string): void
  /** Recompute every mounted agent's mask now (an open/close just changed the input). */
  sync(): void
  scopeState(): ReturnType<ToolMask['scopeState']>
  scopeOf(agentId: string): AgentScopeInfo | undefined
  agentsInfo(): AgentScopeInfo[]
  info(): unknown
}

export function maskControl(mask: ToolMask): MaskControl {
  return {
    setSessionDeny: (sessionId, names) => mask.setSessionDeny(sessionId, names),
    setSessionAllow: (sessionId, names) => mask.setSessionAllow(sessionId, names),
    setWorkspaceDeny: (key, names) => mask.setWorkspaceDeny(key, names),
    setSubagentPolicy: (deny, allow) => mask.setSubagentPolicy(deny, allow),
    noteOpened: (sessionId, group) => mask.noteOpened(sessionId, group),
    noteClosed: (sessionId, group) => mask.noteClosed(sessionId, group),
    sync: () => mask.syncAll(),
    scopeState: () => mask.scopeState(),
    scopeOf: agentId => mask.scopeOf(agentId),
    agentsInfo: () => mask.agentsInfo(),
    info: () => mask.info(),
  }
}

export type { MaskCtx }
