/**
 * Per-tool masking for MCP servers.
 *
 * The host refuses a context-global `tools.restrict()` ("would mask every agent"), so the mask
 * has to be installed per agent: on `agent/created` we mount a tiny plugin inside that agent's
 * scope and let it register the restriction there. A restricted tool then disappears from that
 * scope's model-visible schema, which is the whole point — a `tools.guard()` would only reject
 * calls and still pay the context.
 *
 * Two traps, both learned the hard way by dsh-skill-mcp-panel (their issues #59 / #62):
 *   - `restrict()` and the undo function emit `tools/change` synchronously, and we listen to that
 *     event ourselves. Without a re-entrancy guard plus a signature check this recurses forever
 *     and pins a core at 100%.
 *   - `restrict()` throws when a name is not (yet) in `restrictableNames`. MCP tools arrive
 *     asynchronously, so names have to be filtered against the live view on every pass.
 */
import { readFile } from 'node:fs/promises'

/** Public MCP tool names look like `mcp__<serverName>__<toolName>`. */
export const MCP_TOOL_PREFIX = 'mcp__'

/** Read the deny list another panel keeps, without ever writing to it. */
export async function readPanelFilter(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.deny)) {
      return parsed.deny.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
    }
  } catch {
    /* missing or broken file: no extra information, not an error */
  }
  return []
}

/** Split `mcp__server__tool` into its parts; null when the name is not shaped like one. */
export function splitToolName(name) {
  if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const cut = rest.indexOf('__')
  if (cut <= 0 || cut + 2 >= rest.length) return null
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) }
}

/** Names the host currently exposes, or null when the tools service cannot answer. */
export function knownToolNames(ctx) {
  try {
    const tools = ctx.get('tools')
    const view = tools?.view?.(undefined)
    if (view === undefined || view === null) return null
    const names = view.knownNames ?? view.restrictableNames
    if (names === undefined || names === null) return null
    return [...names].filter(name => typeof name === 'string')
  } catch {
    return null
  }
}

function warn(ctx, message) {
  const line = `[tool-hub] ${message}`
  try {
    const logger = ctx.get('logger')
    if (logger !== null && typeof logger?.warn === 'function') {
      logger.warn(line)
      return
    }
  } catch {
    /* no logger service */
  }
  try {
    console.warn(line)
  } catch {
    /* nothing left to report to */
  }
}

function errorText(error) {
  return error !== null && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : String(error)
}

/**
 * Keeps one restriction plugin mounted per live agent and re-applies the deny list whenever the
 * tool set changes. See the file header for the two guards this needs.
 */
export class ToolMask {
  constructor(ctx, deny) {
    this.ctx = ctx
    this.deny = deny.filter(name => name.startsWith(MCP_TOOL_PREFIX))
    /** Session id -> names that session switched off. Empty lists are pruned on write. */
    this.sessionDeny = new Map()
    /** Session id -> its parent session, learned from every agent we mount on. */
    this.parents = new Map()
    this.mounted = new Map()
    this.mounting = new Set()
    this.syncing = false
    this.disposed = false
    this.problems = []
  }

  /** What the mask believes it has done, for the panel's snapshot. */
  info() {
    return {
      mounted: this.mounted.size,
      deny: [...this.deny],
      sessions: [...this.sessionDeny.entries()].map(([sessionId, names]) => ({ sessionId, deny: [...names] })),
      problems: [...this.problems],
    }
  }

  /** The session an agent belongs to; the agent id is the fallback the host itself uses. */
  sessionIdOf(agent) {
    const sessionId = agent?.session?.id
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : typeof agent?.id === 'string' ? agent.id : undefined
  }

  /**
   * The parent session of an agent, if the host exposes the lineage. Three shapes are tried
   * because the field moved between host generations; a missing lineage simply means the agent
   * inherits nothing, which is the pre-overlay behaviour.
   */
  parentSessionOf(agent) {
    try {
      const header = agent?.session?.requestHeader?.() ?? agent?.session?.header ?? null
      const parent = header?.parentSession ?? header?.parentSessionId
      if (typeof parent === 'string' && parent !== '') return parent
    } catch {
      /* a host without requestHeader keeps the mask working, just not inheriting */
    }
    const meta = agent?.meta?.parentSessionId ?? agent?.meta?.parentSession
    return typeof meta === 'string' && meta !== '' ? meta : undefined
  }

  /** Ancestor session ids, nearest first. Depth-capped and cycle-safe: lineage is host data. */
  lineageOf(sessionId) {
    const chain = []
    const seen = new Set()
    let current = sessionId
    while (typeof current === 'string' && current !== '' && !seen.has(current) && chain.length < 8) {
      seen.add(current)
      chain.push(current)
      current = this.parents.get(current)
    }
    return chain
  }

  /**
   * The deny list one agent should live under: the installation list plus every session on its
   * lineage. A subagent is a separate session, so nothing reaches it unless the parent is on the
   * chain — which is exactly the propagation this exists for.
   */
  denyFor(agent) {
    const names = new Set(this.deny)
    for (const sessionId of this.lineageOf(this.sessionIdOf(agent))) {
      for (const name of this.sessionDeny.get(sessionId) ?? []) names.add(name)
    }
    return [...names]
  }

  note(message) {
    this.problems.push(message)
    if (this.problems.length > 8) this.problems.shift()
  }

  pluginFor(denyOf) {
    const holder = { sync: () => {}, mask: this }
    return {
      holder,
      plugin: {
        name: 'dsh-tool-hub:tool-mask',
        inject: ['tools'],
        apply(c) {
          let undo
          let applied = null
          let live = true
          let inside = false
          const syncOnce = () => {
            // Resolved per pass, not captured at mount: a session switch changes the list a
            // mounted agent lives under, and the signature below decides whether the host sees
            // a new restriction at all.
            const deny = denyOf()
            let known
            try {
              known = new Set(c.tools.view(undefined).restrictableNames)
            } catch (error) {
              // `knownToolNames` falls back to `definitions()` for display, but that list is
              // post-restriction: feeding it to the mask would drop every currently-denied name
              // and lift the mask on the next pass. Skipping is the only honest fallback.
              warn(c, `cannot read restrictable tools: ${errorText(error)}`)
              holder.mask?.note?.(`view: ${errorText(error)}; mask skipped — definitions() is post-restriction and cannot replace it`)
              return
            }
            const usable = deny.filter(name => known.has(name))
            const signature = usable.slice().sort().join('\u0000')
            if (signature === applied) return
            if (usable.length === 0) {
              if (undo !== undefined) {
                try {
                  undo()
                } catch (error) {
                  warn(c, `cannot lift the previous mask: ${errorText(error)}`)
                }
                undo = undefined
              }
              applied = ''
              return
            }
            // Install before lifting. Restrictions intersect, so the momentary overlap
            // over-denies (the safe direction); lifting first would leave the agent with no
            // mask at all if this `restrict()` throws, and `applied` would still claim the old
            // list is in force.
            let next
            try {
              next = c.tools.restrict({ deny: usable })
            } catch (error) {
              warn(c, `cannot apply the tool mask: ${errorText(error)}`)
              holder.mask?.note?.(`apply: ${errorText(error)}`)
              return
            }
            const previous = undo
            undo = next
            applied = signature
            if (previous !== undefined) {
              try {
                previous()
              } catch (error) {
                warn(c, `cannot lift the previous mask: ${errorText(error)}`)
                holder.mask?.note?.(`lift: ${errorText(error)}`)
              }
            }
          }
          const sync = () => {
            if (!live || inside) return
            inside = true
            try {
              syncOnce()
            } finally {
              inside = false
            }
          }
          holder.sync = sync
          try {
            c.effect(() => () => {
              live = false
              holder.sync = () => {}
              // The host usually reverts a restriction when its scope dies, but not every
              // host does that for a plugin mounted mid-flight; lifting it here makes the
              // unmount safe wherever it runs.
              if (undo !== undefined) {
                try {
                  undo()
                } catch {
                  /* already gone with the scope */
                }
                undo = undefined
                applied = null
              }
            })
          } catch {
            /* minimal host without effect: nothing to unregister */
          }
          sync()
        },
      },
    }
  }

  applyTo(agent) {
    const sessionId = this.sessionIdOf(agent)
    // Remember the lineage before deciding anything: a subagent announces itself after its
    // parent did, so the parent link is available exactly when it is needed.
    const parent = this.parentSessionOf(agent)
    if (typeof sessionId === 'string' && typeof parent === 'string' && parent !== sessionId) {
      this.parents.set(sessionId, parent)
    }
    if (this.disposed || (this.deny.length === 0 && this.sessionDeny.size === 0)) return
    const id = typeof agent?.id === 'string' ? agent.id : undefined
    if (id === undefined || this.mounted.has(id) || this.mounting.has(id)) return
    const scopeCtx = agent.ctx
    if (scopeCtx === undefined || typeof scopeCtx.plugin !== 'function') {
      this.note(`agent ${id} has no scoped context to plugin into`)
      return
    }
    this.mounting.add(id)
    try {
      const { plugin, holder } = this.pluginFor(() => this.denyFor(agent))
      const fiber = scopeCtx.plugin(plugin)
      this.mounted.set(id, { fiber, holder })
    } catch (error) {
      warn(this.ctx, `cannot mount the tool mask on agent ${id}: ${errorText(error)}`)
      this.note(`mount ${id}: ${errorText(error)}`)
    } finally {
      this.mounting.delete(id)
    }
  }

  listAgents() {
    try {
      const rows = this.ctx.get('agents')?.list?.()
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  syncAll() {
    if (this.disposed || this.syncing) return
    this.syncing = true
    try {
      for (const entry of [...this.mounted.values()]) {
        try {
          entry.holder.sync()
        } catch (error) {
          warn(this.ctx, `cannot refresh the tool mask: ${errorText(error)}`)
        }
      }
    } finally {
      this.syncing = false
    }
  }

  unmountAll() {
    for (const [id, entry] of [...this.mounted.entries()]) {
      this.mounted.delete(id)
      try {
        entry.fiber?.dispose?.()
      } catch (error) {
        warn(this.ctx, `cannot unmount the tool mask from agent ${id}: ${errorText(error)}`)
      }
    }
  }

  /** Fill the session map without triggering a sync (used when mounting, before any agent). */
  hydrate(sessions) {
    if (sessions === null || typeof sessions !== 'object') return
    for (const [sessionId, names] of Object.entries(sessions)) {
      if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(names)) continue
      const cleaned = [...new Set(names.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)))]
      if (cleaned.length > 0) this.sessionDeny.set(sessionId, cleaned)
    }
  }

  setDeny(deny) {
    this.deny = deny.filter(name => name.startsWith(MCP_TOOL_PREFIX))
    // Mounted plugins resolve their own list per pass, so a base change is a refresh, not a
    // remount — the signature check inside each plugin keeps unaffected agents off the host.
    if (this.deny.length === 0 && this.sessionDeny.size === 0) {
      this.unmountAll()
      return
    }
    for (const agent of this.listAgents()) this.applyTo(agent)
    this.syncAll()
  }

  /**
   * Replace one session's deny list. Empty lists are removed, so the map only ever holds
   * sessions that actually switched something off; nothing is pruned on session end because a
   * session can be resumed and its switches should still be there.
   */
  setSessionDeny(sessionId, names) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const cleaned = [...new Set((Array.isArray(names) ? names : []).filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)))]
    if (cleaned.length === 0) this.sessionDeny.delete(sessionId)
    else this.sessionDeny.set(sessionId, cleaned)
    if (this.deny.length === 0 && this.sessionDeny.size === 0) {
      this.unmountAll()
      return
    }
    for (const agent of this.listAgents()) this.applyTo(agent)
    this.syncAll()
  }

  dispose() {
    this.disposed = true
    this.unmountAll()
  }
}

/** Wire a mask to the agent lifecycle; returns a disposer. `sessions` seeds the overlay map. */
export function attachToolMask(ctx, deny, sessions) {
  const mask = new ToolMask(ctx, deny)
  mask.hydrate(sessions)
  const offCreated = ctx.on('agent/created', payload => mask.applyTo(payload?.agent))
  const offDisposed = ctx.on('agent/disposed', payload => {
    const id = payload?.agent?.id
    if (typeof id === 'string') mask.mounted.delete(id)
  })
  const offTools = ctx.on('tools/change', () => mask.syncAll())
  for (const agent of mask.listAgents()) mask.applyTo(agent)
  mask.dispose = ((original) => () => {
    for (const off of [offCreated, offDisposed, offTools]) {
      try {
        off?.()
      } catch {
        /* subscriptions may already be gone with the scope */
      }
    }
    original.call(mask)
  })(mask.dispose)
  return mask
}
