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
    this.mounted = new Map()
    this.mounting = new Set()
    this.syncing = false
    this.disposed = false
    this.problems = []
  }

  /** What the mask believes it has done, for the panel's snapshot. */
  info() {
    return { mounted: this.mounted.size, deny: [...this.deny], problems: [...this.problems] }
  }

  note(message) {
    this.problems.push(message)
    if (this.problems.length > 8) this.problems.shift()
  }

  pluginFor(deny) {
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
            let known
            try {
              known = new Set(c.tools.view(undefined).restrictableNames)
            } catch (error) {
              warn(c, `cannot read restrictable tools: ${errorText(error)}`)
              holder.mask?.note?.(`view: ${errorText(error)}`)
              return
            }
            const usable = deny.filter(name => known.has(name))
            const signature = usable.slice().sort().join('\u0000')
            if (signature === applied) return
            if (undo !== undefined) {
              try {
                undo()
              } catch (error) {
                warn(c, `cannot lift the previous mask: ${errorText(error)}`)
              }
              undo = undefined
              applied = null
            }
            if (usable.length === 0) {
              applied = ''
              return
            }
            try {
              undo = c.tools.restrict({ deny: usable })
              applied = signature
            } catch (error) {
              warn(c, `cannot apply the tool mask: ${errorText(error)}`)
              holder.mask?.note?.(`apply: ${errorText(error)}`)
              undo = undefined
              applied = null
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
    if (this.disposed || this.deny.length === 0) return
    const id = typeof agent?.id === 'string' ? agent.id : undefined
    if (id === undefined || this.mounted.has(id) || this.mounting.has(id)) return
    const scopeCtx = agent.ctx
    if (scopeCtx === undefined || typeof scopeCtx.plugin !== 'function') {
      this.note(`agent ${id} has no scoped context to plugin into`)
      return
    }
    this.mounting.add(id)
    try {
      const { plugin, holder } = this.pluginFor(this.deny)
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

  setDeny(deny) {
    this.deny = deny.filter(name => name.startsWith(MCP_TOOL_PREFIX))
    this.unmountAll()
    if (this.deny.length === 0) return
    for (const agent of this.listAgents()) this.applyTo(agent)
  }

  dispose() {
    this.disposed = true
    this.unmountAll()
  }
}

/** Wire a mask to the agent lifecycle; returns a disposer. */
export function attachToolMask(ctx, deny) {
  const mask = new ToolMask(ctx, deny)
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
