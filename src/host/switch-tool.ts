/**
 * The tool_switch model tool: the same session.switch op, exposed to the model.
 *
 * It is deliberately small: list/off/on/reset plus an optional target. The renderer returns only
 * the message because the model needs the outcome, not a second copy of the counts.
 */
export interface SwitchToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
  }
  execute: (args: { action?: unknown; target?: unknown }, exec?: { agent?: { session?: { id?: string } } }) => Promise<unknown>
}

export function createSwitchTool(execute: (op: unknown, payload: unknown) => Promise<unknown>): SwitchToolDefinition {
  return {
    name: 'tool_switch',
    description: 'List or switch the tools this session lets you call. action=off hides a tool/group/prefix, action=on shows it again, reset clears the session switches. Say "all" to target every switchable tool.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'off', 'on', 'reset'], description: 'what to do' },
      target: { type: 'string', description: 'tool name, group name, prefix or all' },
    },
    output: {
      schema: { type: 'object', properties: {} },
      render: (_args: unknown, value: unknown) => {
        const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
        const message = typeof record.message === 'string' ? record.message : JSON.stringify(value)
        return [{ type: 'text', text: message }]
      },
    },
    execute: async (args, exec) => {
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, message: 'tool_switch needs a session' }
      const action = args?.action === 'off' || args?.action === 'on' || args?.action === 'reset' || args?.action === 'list' ? args.action : 'list'
      const target = typeof args?.target === 'string' ? args.target : undefined
      const result = await execute('session.switch', { sessionId, action, target }) as Record<string, unknown>
      return {
        ok: result?.ok === true,
        action,
        enabled: result?.counts !== null && typeof result?.counts === 'object' ? (result.counts as Record<string, unknown>).enabled : undefined,
        total: result?.counts !== null && typeof result?.counts === 'object' ? (result.counts as Record<string, unknown>).total : undefined,
        message: typeof result?.message === 'string' ? result.message : 'done',
      }
    },
  }
}
