import { Registry } from '../core/registry.js'
import type { HubContext } from '../shared/types.js'

export const name = 'dsh-tool-hub'
export const inject = ['webServer'] as const

/** One registry per process; domains register into it from apply(). */
export const registry = new Registry()

/**
 * 2.0 entry. Deliberately thin: the 1.x entry stays in lib/index.js until the cutover, so a
 * half-built 2.0 can never be what the host loads.
 */
export function apply(ctx: HubContext): void {
  registry.register({
    id: 'core',
    title: { zh: '核心', en: 'Core' },
    ops: [{ id: 'core.ping', write: false, audit: false, note: 'Reports the registry size; the first smoke target.' }],
  })
  ctx.logger?.info?.(`dsh-tool-hub 2.0 skeleton: ${registry.list().length} module(s), ${registry.ops().length} op(s)`)
}
