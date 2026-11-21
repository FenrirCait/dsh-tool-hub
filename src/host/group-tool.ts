/**
 * `tool_list`: the model's door into an on-demand group.
 *
 * Registered globally on purpose - PTC only projects inherited tools into the SDK, so a
 * per-agent registration would never reach the model - and the name is reserved in
 * core/tool-names.ts, so no mask can hide the door itself. The tool reuses the `session.open`
 * op the panel uses, so the two paths cannot drift apart.
 */
import type { Dispatcher } from './dispatch.js'

export interface GroupToolArgs {
  group?: unknown
}

export interface GroupToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: GroupToolArgs, exec?: unknown) => Promise<unknown>
}

/** The only method the tool needs from the dispatcher. */
export interface GroupToolAdapter {
  execute(op: string, payload: unknown): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The calling agent's session id, however the host hands the execution context over. */
function sessionIdOf(exec: unknown): string {
  const agent = isRecord(exec) ? exec.agent : undefined
  const session = isRecord(agent) ? agent.session : undefined
  const id = isRecord(session) && typeof session.id === 'string' ? session.id.trim() : ''
  return id
}

/** One call: open the named group for the calling session through the same op the panel uses. */
async function handle(adapter: GroupToolAdapter, args: GroupToolArgs, exec: unknown): Promise<unknown> {
  const group = typeof args?.group === 'string' ? args.group.trim() : ''
  if (group === '') throw new Error('tool_list needs a group name')
  const sessionId = sessionIdOf(exec)
  if (sessionId === '') throw new Error('tool_list needs an agent session')
  return await adapter.execute('session.open', { sessionId, group })
}

export function createGroupTool(adapter: GroupToolAdapter): GroupToolDefinition {
  return {
    name: 'tool_list',
    description: 'Open one on-demand tool group so its tools become callable. Call it with a group name from the on-demand catalog; the tools show up on the next turn.',
    parameters: {
      group: { type: 'string', required: true, description: 'group name from the on-demand catalog' },
    },
    output: {
      schema: { type: 'object', properties: {} },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: GroupToolArgs, exec?: unknown) => await handle(adapter, args, exec),
  }
}
