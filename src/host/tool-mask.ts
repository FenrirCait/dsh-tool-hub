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
/** Public MCP tool names look like `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = 'mcp__'

interface ToolsMember {
  view?: (agent: unknown) => { knownNames?: unknown; restrictableNames?: unknown } | null | undefined
  restrict?: (request: { deny: string[] }) => (() => void) | void
}

interface ScopeContext {
  tools?: ToolsMember
  get?: (name: string) => unknown
}

interface AgentLike {
  id?: string
  ctx?: { plugin?: (plugin: unknown) => { dispose?: () => void } | undefined }
  session?: { id?: string; requestHeader?: () => unknown; header?: unknown }
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

function mcpOnly(names: readonly unknown[]): string[] {
  return [...new Set(names.filter((name): name is string => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)))]
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
}

export class ToolMask {
  readonly ctx: MaskCtx
  /** One entry per applySurface install; the union is the installation deny list. */
  private readonly layers = new Map<symbol, string[]>()
  private readonly sessionDeny = new Map<string, string[]>()
  private readonly parents = new Map<string, string>()
  private readonly mounted = new Map<string, Mounted>()
  private readonly mounting = new Set<string>()
  private syncing = false
  private disposed = false
  private readonly problems: string[] = []

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
    const cleaned = mcpOnly(names)
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
    if (this.deny().length === 0 && this.sessionDeny.size === 0) {
      this.unmountAll()
      return
    }
    for (const agent of this.agents()) this.applyTo(agent)
    this.syncAll()
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

  /** Installation layers plus every session on this agent's lineage. */
  denyFor(agent: AgentLike | undefined): string[] {
    const names = new Set(this.deny())
    for (const sessionId of this.lineageOf(this.sessionIdOf(agent))) {
      for (const name of this.sessionDeny.get(sessionId) ?? []) names.add(name)
    }
    return [...names]
  }

  setSessionDeny(sessionId: string, names: readonly string[]): void {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const cleaned = mcpOnly(names)
    if (cleaned.length === 0) this.sessionDeny.delete(sessionId)
    else this.sessionDeny.set(sessionId, cleaned)
    this.refresh()
  }

  /** Seed overlays before any agent mounts (state.sessions is the durable copy). */
  hydrate(sessions: unknown): void {
    if (!isRecord(sessions)) return
    for (const [sessionId, names] of Object.entries(sessions)) {
      if (sessionId === '' || !Array.isArray(names)) continue
      const cleaned = mcpOnly(names)
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
      inject: ['tools'],
      apply(scope: ScopeContext): void {
        let undo: (() => void) | undefined
        let applied: string | null = null
        let live = true
        let inside = false
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
        try {
          // The host's plugin scope exposes effect(); call it through the scope object itself.
          const effect = (scope as unknown as { effect?: (fn: () => () => void) => void }).effect
          effect?.(() => () => {
            live = false
            holder.sync = () => {}
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
    if (this.disposed || (this.deny().length === 0 && this.sessionDeny.size === 0)) return
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
      this.mounted.set(id, { fiber, holder })
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
export function attachToolMask(ctx: MaskCtx, sessions: unknown): ToolMask {
  const mask = new ToolMask(ctx)
  mask.hydrate(sessions)
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
export function maskControl(mask: ToolMask): { setSessionDeny(sessionId: string, names: string[]): void; info(): unknown } {
  return {
    setSessionDeny: (sessionId, names) => mask.setSessionDeny(sessionId, names),
    info: () => mask.info(),
  }
}

export type { MaskCtx }
