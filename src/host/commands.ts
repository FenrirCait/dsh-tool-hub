/**
 * The /tools slash command: one thin adapter over session.switch.
 *
 * Parsing mirrors the 1.x command (list|off|on|reset, "all on" accepted, a bare target means
 * off) and the handler never writes state itself — it goes through the same op the dock and the
 * model tool use.
 */
export const TOOLS_COMMAND = 'tools'

export interface ToolsCommandInput {
  action: 'list' | 'off' | 'on' | 'reset'
  target?: string
}

export function parseToolsInput(raw: string): ToolsCommandInput {
  const text = raw.trim()
  if (text === '') return { action: 'list' }
  const parts = text.split(/\s+/u)
  const first = (parts[0] ?? '').toLowerCase()
  if (first === 'list' || first === 'off' || first === 'on' || first === 'reset') {
    const target = parts.slice(1).join(' ').trim()
    return target === '' ? { action: first } : { action: first, target }
  }
  if (first === 'all' && parts.length >= 2) {
    const verb = (parts[1] ?? '').toLowerCase()
    if (verb === 'on' || verb === 'off' || verb === 'reset' || verb === 'list') {
      return { action: verb, target: 'all' }
    }
  }
  return { action: 'off', target: text }
}

interface CommandsScope {
  commands?: { register?: (definition: Record<string, unknown>) => unknown }
  effect?: (fn: () => unknown, label?: string) => unknown
}

export interface CommandCtx {
  inject?: (services: string[], callback: (scope: CommandsScope) => void, label?: string) => void
  logger?: { warn?: (message: string) => void }
}

/** Register /tools; a host without the commands service (or a name clash) only warns. */
export function installToolsCommand(
  ctx: CommandCtx,
  execute: (op: unknown, payload: unknown) => Promise<unknown>,
): void {
  try {
    ctx.inject?.(['commands'], scope => {
      const register = (): unknown => scope.commands?.register?.({
        name: TOOLS_COMMAND,
        description: 'List or switch the tools this session lets the model call.',
        input: { hint: '[list|off|on|reset] [group|tool|prefix|all]' },
        handler: async (request: { agent?: { session?: { id?: string } }; rawInput?: unknown }) => {
          const sessionId = request.agent?.session?.id
          if (typeof sessionId !== 'string' || sessionId === '') return { kind: 'error', text: 'this command needs a session' }
          const parsed = parseToolsInput(String(request.rawInput ?? ''))
          try {
            const result = await execute('session.switch', { sessionId, action: parsed.action, target: parsed.target }) as { message?: unknown }
            return { kind: 'success', text: typeof result?.message === 'string' ? result.message : 'done' }
          }
          catch (error) {
            return { kind: 'error', text: String((error as Error)?.message ?? error) }
          }
        },
      })
      try {
        scope.effect?.(register, 'tool-hub: /tools command')
      }
      catch {
        register()
      }
    }, 'tool-hub: /tools command')
  }
  catch (error) {
    ctx.logger?.warn?.('[tool-hub] /tools command unavailable: ' + String((error as Error)?.message ?? error))
  }
}
