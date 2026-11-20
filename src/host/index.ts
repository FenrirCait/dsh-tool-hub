import { Registry } from '../core/registry.js'
import { loadState, stateDir } from '../core/io.js'
import { applySettingsDefaults, normalizeSettings } from '../core/settings.js'
import { registerAll } from '../domains/index.js'
import type { DomainRegistration, HostEnv } from '../shared/contract.js'
import type { HubContext } from '../shared/types.js'
import { Dispatcher, failureOf } from './dispatch.js'
import { HEARTBEAT_INJECTS, runDoctor, writeMountHeartbeat } from './diagnostics.js'
import { installApi } from './routes.js'
import { buildSnapshot } from './snapshot.js'

export const name = 'dsh-tool-hub'
export const inject = ['webServer'] as const

interface Started {
  dispatcher: Dispatcher
}

function logTo(ctx: HubContext) {
  return (level: 'info' | 'warn', message: string): void => {
    if (level === 'warn') ctx.logger?.warn(message)
    else ctx.logger?.info?.(message)
  }
}

/**
 * 2.0 entry. The 1.x entry stays in lib/index.js until the cutover; this module is compiled to
 * dist/ and only loaded when package.json points there.
 */
export function apply(ctx: HubContext): void {
  const ready = start(ctx)
  const run = async (op: unknown, payload: unknown): Promise<ReturnType<Dispatcher['run']> extends Promise<infer T> ? T : never> => {
    try {
      const started = await ready
      return await started.dispatcher.run(op, payload) as never
    }
    catch (error) {
      const failure = failureOf(error)
      return { ok: false, error: failure } as never
    }
  }
  const dispose = installApi({
    ctx,
    run,
    snapshot: async ({ fresh }) => {
      const started = await ready
      return await started.dispatcher.execute('snapshot', { fresh })
    },
  })
  ctx.effect?.(() => dispose)
}

async function start(ctx: HubContext): Promise<Started> {
  const loaded = await loadState()
  if (loaded.recovered !== null) logTo(ctx)('warn', `state was unreadable; recovered from ${loaded.recovered}`)
  const state = loaded.state
  const registry = new Registry()
  const registrations = registerAll(registry)
  const dispatcher = new Dispatcher({
    registry,
    state,
    services: { get: service => ctx.get(service) },
    log: logTo(ctx),
    save: async (next, reason) => {
      // Persist the whole document because env.state is the same object every handler mutates.
      const { saveState } = await import('../core/io.js')
      return await saveState(next, reason)
    },
  })
  for (const registration of registrations) dispatcher.bind(registration)

  const core: DomainRegistration = {
    module: {
      id: 'core',
      title: { zh: '核心', en: 'Core' },
      ops: [
        { id: 'snapshot', write: false, audit: false, note: 'Builds the panel snapshot from the registered domains.' },
        { id: 'doctor', write: false, audit: false, note: 'Runs the ten diagnostics against the live host.' },
      ],
    },
    handlers: {
      snapshot: async (payload, env: HostEnv) => buildSnapshot({
        env,
        registry,
        fresh: (payload as { fresh?: unknown } | undefined)?.fresh === true,
        history: () => dispatcher.history(),
      }),
      doctor: async () => runDoctor({ ctx, stateDir: stateDir(), expectedInjects: HEARTBEAT_INJECTS }),
    },
  }
  registry.register(core.module)
  dispatcher.bind(core)

  const modules = registry.list()
  state.settings = normalizeSettings(applySettingsDefaults(state.settings, modules), modules)
  writeMountHeartbeat({ stateDir: stateDir(), injects: [...HEARTBEAT_INJECTS] })
  logTo(ctx)('info', `dsh-tool-hub 2.0: ${modules.length} module(s), ${registry.ops().length} op(s)`)
  return { dispatcher }
}
