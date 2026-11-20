/**
 * The catalog tool the model gets: list, load and unload lazily hidden MCP tools.
 *
 * 1.x registered this as `hub_tools`; the 2.0 host dropped it, so a lazy server had no door
 * back and the doctor reported the registry entry missing. It reuses the dispatcher ops the
 * panel uses, so the two paths cannot drift apart.
 */
import type { Dispatcher } from './dispatch.js'

export interface CatalogToolArgs {
  action?: unknown
  server?: unknown
  names?: unknown
}

export interface CatalogToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: CatalogToolArgs) => Promise<unknown>
}

interface SnapshotTool {
  name?: unknown
  server?: unknown
  enabled?: unknown
  lazy?: unknown
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
}

function serverOf(name: string): string | null {
  const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(name)
  return match === null ? null : match[1] ?? null
}

/** One call: the catalog, or a load/unload that goes through the same lazy ops as the panel. */
async function handle(dispatcher: Pick<Dispatcher, 'execute'>, args: CatalogToolArgs): Promise<unknown> {
  const action = args?.action
  if (action === 'list') {
    const snapshot = await dispatcher.execute('snapshot', {}) as { tools?: SnapshotTool[] }
    const rows = Array.isArray(snapshot?.tools) ? snapshot.tools : []
    const byServer = new Map<string, Array<{ name: string; enabled: boolean; lazy: boolean }>>()
    for (const row of rows) {
      const name = typeof row.name === 'string' ? row.name : ''
      const server = (typeof row.server === 'string' ? row.server : null) ?? serverOf(name) ?? 'unknown'
      const list = byServer.get(server) ?? []
      list.push({ name, enabled: row.enabled !== false, lazy: row.lazy === true })
      byServer.set(server, list)
    }
    return {
      action,
      servers: [...byServer.entries()].map(([server, tools]) => ({
        server,
        total: tools.length,
        loaded: tools.filter(tool => tool.enabled).length,
        tools,
      })),
    }
  }
  if (action === 'enable' || action === 'disable') {
    const load = action === 'enable'
    const names = listOf(args?.names)
    const server = typeof args?.server === 'string' ? args.server.trim() : ''
    if (server !== '' && names.length === 0) {
      return await dispatcher.execute('lazy.set', { server, on: !load })
    }
    if (names.length === 0) throw new Error('action ' + action + ' needs a server or names')
    return await dispatcher.execute(load ? 'lazy.load' : 'lazy.unload', { names, load })
  }
  throw new Error('action must be list, enable or disable')
}

export function createCatalogTool(dispatcher: Pick<Dispatcher, 'execute'>): CatalogToolDefinition {
  return {
    name: 'hub_tools',
    description: 'List and load lazily loaded MCP tools. Call action="list" to see the catalog, then action="enable" with names or a server to make those tools callable on the next turn.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'enable', 'disable'], description: 'list the catalog, or load/unload tools' },
      server: { type: 'string', description: 'MCP server name; with enable/disable it applies to every tool of that server' },
      names: { type: 'array', items: { type: 'string' }, description: 'exact tool names such as mcp__demo__alpha' },
    },
    output: {
      schema: { type: 'object', properties: {} },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: CatalogToolArgs) => await handle(dispatcher, args),
  }
}
