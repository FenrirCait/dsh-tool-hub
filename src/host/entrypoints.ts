/**
 * G5 host entry points: /tools and tool_switch, both over session.switch.
 *
 * One call site in apply() keeps the two registrations together; each is independently guarded so
 * a host without commands or with a name clash loses one entry point, not the panel.
 */
import { installToolsCommand, type CommandCtx } from './commands.js'
import { createSwitchTool } from './switch-tool.js'

interface ToolScope {
  tools?: { register?: (definition: unknown) => void }
  effect?: (fn: () => unknown, label?: string) => unknown
}

export interface EntryPointCtx extends CommandCtx {
  inject?: (services: string[], callback: (scope: ToolScope) => void, label?: string) => void
  logger?: { warn?: (message: string) => void }
}

export function installEntryPoints(
  ctx: EntryPointCtx,
  execute: (op: unknown, payload: unknown) => Promise<unknown>,
): void {
  installToolsCommand(ctx, execute)
  try {
    ctx.inject?.(['tools'], scope => {
      const register = (): void => {
        try {
          scope.tools?.register?.(createSwitchTool(execute))
        }
        catch (error) {
          ctx.logger?.warn?.('[tool-hub] tool_switch unavailable: ' + String((error as Error)?.message ?? error))
        }
      }
      try {
        scope.effect?.(register, 'tool-hub: tool_switch')
      }
      catch {
        register()
      }
    }, 'tool-hub: tool_switch')
  }
  catch (error) {
    ctx.logger?.warn?.('[tool-hub] tool_switch registration failed: ' + String((error as Error)?.message ?? error))
  }
}
