/**
 * Client-side lazy loading for MCP tools.
 *
 * The MCP client always advertises every tool it knows, so the only lever a panel
 * has is `tools.restrict`: a masked tool disappears from the model-visible schema
 * without touching the server. This module computes that mask from two lists the
 * user owns — the servers marked lazy, and the tools they explicitly loaded — and
 * renders the one paragraph of prompt that tells a model the catalog exists.
 */

export const LAZY_PREFIX = 'mcp__'

/** Tool name to its server, or null when the name is not an MCP tool. */
export function serverOf(name) {
  if (typeof name !== 'string' || !name.startsWith(LAZY_PREFIX)) return null
  const rest = name.slice(LAZY_PREFIX.length)
  const cut = rest.indexOf('__')
  return cut <= 0 ? null : rest.slice(0, cut)
}

/**
 * Names that must stay hidden: every tool of a lazy server the user has not
 * loaded, plus the explicit deny list. `known` is the live tool inventory, so a
 * server that connects later is covered without re-saving anything.
 */
export function effectiveDeny(state, known) {
  const lazy = new Set(Array.isArray(state?.lazyServers) ? state.lazyServers : [])
  const loaded = new Set(Array.isArray(state?.lazyLoaded) ? state.lazyLoaded : [])
  const deny = new Set(Array.isArray(state?.toolDeny) ? state.toolDeny : [])
  if (lazy.size > 0) {
    for (const name of known) {
      const server = serverOf(name)
      if (server !== null && lazy.has(server) && !loaded.has(name)) deny.add(name)
    }
  }
  return [...deny]
}

/** Lazy servers with how many of their tools are currently visible. */
export function lazyReport(state, known) {
  const lazy = Array.isArray(state?.lazyServers) ? state.lazyServers : []
  const loaded = new Set(Array.isArray(state?.lazyLoaded) ? state.lazyLoaded : [])
  const seen = new Map(lazy.map(server => [server, { server, total: 0, loaded: 0, tools: [] }]))
  for (const name of known) {
    const server = serverOf(name)
    const row = seen.get(server)
    if (row === undefined) continue
    row.total += 1
    row.tools.push(name)
    if (loaded.has(name)) row.loaded += 1
  }
  return [...seen.values()]
}

/**
 * The prompt paragraph that makes a masked catalog discoverable. Empty string
 * when nothing is lazy, so the section can stay registered without costing a
 * token in the common case.
 */
export function lazyPrompt(state, known) {
  const report = lazyReport(state, known).filter(row => row.total > 0)
  if (report.length === 0) return ''
  const lines = report.map(row => `- ${row.server}: ${row.total} 个工具，已加载 ${row.loaded} 个`)
  return [
    'Tool Hub 里有懒加载的 MCP 服务器（工具定义默认不进上下文）：',
    ...lines,
    '要用它们时先调用 hub_tools：action="list" 看清单，action="enable" 加 names 或 server 加载；加载后下一轮即可直接调用。',
  ].join('\n')
}
