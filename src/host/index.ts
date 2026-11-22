import { join } from 'node:path'
import { Registry } from '../core/registry.js'
import { backupDir, loadState, saveState, stateDir } from '../core/io.js'
import { applySettingsDefaults, normalizeSettings } from '../core/settings.js'
import { registerAll } from '../domains/index.js'
import { cleanupTrash } from '../domains/skills.js'
import { createCatalogTool } from './catalog-tool.js'
import type { DomainRegistration, OpHandler } from '../shared/contract.js'
import type { HubContext, SettingsField } from '../shared/types.js'
import type { StateV2 } from '../core/state.js'
import { Dispatcher, Failure, failureOf, historyFile } from './dispatch.js'
import { writeFileAtomic } from '../core/atomic.js'
import { clearStalePanelLock, HEARTBEAT_INJECTS, patchPathFor, runDoctor, writeMountHeartbeat } from './diagnostics.js'
import { installApi } from './routes.js'
import { installEntryPoints, type EntryPointCtx } from './entrypoints.js'
import { PORTABILITY_OPS, portabilityHandlers } from './portability.js'
import { buildSnapshot } from './snapshot.js'
import { ExtensionManager, extensionRoots, type ExtensionStatus } from './extensions.js'
import {
  CompatCatalog,
  CompatFailure,
  DEFAULT_CACHE_MINUTES,
  DEFAULT_INDEX_URL,
  DEFAULT_MIRROR_URL,
  installCompatPack,
  uninstallCompatPack,
  type CompatPack,
} from './compat-catalog.js'
import { attachToolMask, knownToolNames, maskControl, surfacePort, type ToolMask } from './tool-mask.js'
import { applySurface, clearSessionLazy, pruneLazy, readLazy, readOpen } from '../domains/tool-surface.js'
import { normalizeGroups } from '../domains/groups.js'
import { createGroupTool } from './group-tool.js'

export const name = 'dsh-tool-hub'
export const inject = ['webServer'] as const

function logTo(ctx: HubContext) {
  return (level: 'info' | 'warn', message: string): void => {
    if (level === 'warn') ctx.logger?.warn(message)
    else ctx.logger?.info?.(message)
  }
}

interface Build {
  registry: Registry
  dispatcher: Dispatcher
  statuses: ExtensionStatus[]
  modules: number
  ops: number
}

const EXTENSION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * The official pack catalog's settings, declared under the "compat" module id so the stored keys
 * are exactly compat.indexUrl / compat.mirrorUrl / compat.cacheMinutes. The two URLs default to the
 * constants the catalog itself falls back to, so the published contract lives in one place.
 */
const COMPAT_SETTINGS: SettingsField[] = [
  {
    key: 'indexUrl', type: 'string', default: DEFAULT_INDEX_URL,
    label: { zh: '官方配套索引', en: 'Official pack index' },
    hint: { zh: '只接受 https，或本机回环 http（本地镜像 / 测试用）。', en: 'https only, or http on loopback for a local mirror or a fixture.' },
  },
  {
    key: 'mirrorUrl', type: 'string', default: DEFAULT_MIRROR_URL,
    label: { zh: '官方配套镜像', en: 'Official pack mirror' },
    hint: { zh: '索引读不到时才会尝试；留空表示不设镜像。', en: 'Tried only when the index cannot be read; empty disables it.' },
  },
  {
    key: 'cacheMinutes', type: 'number', default: DEFAULT_CACHE_MINUTES, min: 0, max: 1440,
    label: { zh: '配套索引缓存（分钟）', en: 'Cache the pack index (minutes)' },
    hint: { zh: '0 = 每次都读网络；面板的「刷新索引」始终强制读取。', en: '0 reads the network every time; the panel refresh always bypasses the cache.' },
  },
]

/**
 * The live host: one state document, a build (registry + dispatcher + extension statuses) that
 * can be replaced atomically. Routes and the catalog tool hold this object, not a dispatcher, so
 * enabling an extension swaps the build without remounting anything.
 */
export class Runtime {
  private build!: Build
  private mask: ToolMask | null = null
  private lazyTimer: ReturnType<typeof setInterval> | null = null
  private chain: Promise<void> = Promise.resolve()
  private readonly manager: ExtensionManager
  private readonly catalog = new CompatCatalog()

  private constructor(private readonly ctx: HubContext, private readonly state: StateV2) {
    this.manager = new ExtensionManager({
      roots: extensionRoots(),
      services: { get: service => ctx.get(service) },
      log: logTo(ctx),
    })
  }

  static async create(ctx: HubContext): Promise<Runtime> {
    const loaded = await loadState()
    if (loaded.recovered !== null) logTo(ctx)('warn', `state was unreadable; recovered from ${loaded.recovered}`)
    const runtime = new Runtime(ctx, loaded.state)
    runtime.build = await runtime.buildOnce()
    // Fire-and-forget: a trash sweep must never delay or fail a host start. The build above ran
    // applySettingsDefaults, so the retention setting is readable here; 0 (or a 0 setting) turns
    // the sweep off, and it only ever removes entries past the retention.
    void cleanupTrash(Number(runtime.state.settings['skills.trashKeepDays'] ?? 30))
      .catch(error => logTo(ctx)('warn', '[tool-hub] trash cleanup failed: ' + String((error as Error)?.message ?? error)))
    // Never block the host on the mask: mounting a plugin inside a live agent can wait for that
    // agent's fiber during startup. Services are published synchronously; the first recompute and
    // the existing-agent mounts run on the next turns instead.
    void runtime.installMask().catch(error => logTo(ctx)('warn', '[tool-hub] tool mask install failed: ' + String((error as Error)?.message ?? error)))
    writeMountHeartbeat({ stateDir: stateDir(), injects: [...HEARTBEAT_INJECTS] })
    logTo(ctx)('info', `dsh-tool-hub 2.0: ${runtime.build.modules} module(s), ${runtime.build.ops} op(s)`)
    return runtime
  }

  get dispatcher(): Dispatcher {
    return this.build.dispatcher
  }

  get statuses(): ExtensionStatus[] {
    return this.build.statuses
  }

  async run(op: unknown, payload: unknown): Promise<ReturnType<Dispatcher['run']> extends Promise<infer T> ? T : never> {
    return await this.build.dispatcher.run(op, payload) as never
  }

  async execute(op: unknown, payload: unknown): Promise<unknown> {
    return await this.build.dispatcher.execute(op, payload)
  }

  /** Serialised: two toggles cannot interleave their builds. */
  async rebuild(reason: string): Promise<void> {
    // A failed build must not poison the queue: the next attempt starts from a settled promise.
    const attempt = this.chain.catch(() => undefined).then(async () => {
      const next = await this.buildOnce()
      this.build = next
      logTo(this.ctx)('info', `[tool-hub] runtime rebuilt (${reason}): ${next.modules} module(s), ${next.ops} op(s)`)
    })
    this.chain = attempt.catch(() => undefined)
    await attempt
  }

  /** Sweep expired lazy loads and clear a session's loads when its agent is disposed. */
  private startLazyMaintenance(mask: ToolMask): void {
    const ttl = (): number => Number(this.state.settings['tools.lazyLoadTtlMinutes'] ?? 60)
    const refresh = (): void => {
      mask.setLazySource(readLazy(this.state), knownToolNames(this.ctx as unknown as { get(name: string): unknown }))
    }
    try {
      if (pruneLazy(this.state, Date.now(), ttl())) void saveState(this.state, 'lazy-ttl')
    }
    catch (error) {
      logTo(this.ctx)('warn', '[tool-hub] lazy ttl sweep failed: ' + String((error as Error)?.message ?? error))
    }
    if (this.lazyTimer === null) {
      this.lazyTimer = setInterval(() => {
        try {
          if (pruneLazy(this.state, Date.now(), ttl())) {
            void saveState(this.state, 'lazy-ttl')
            refresh()
          }
        }
        catch (error) {
          logTo(this.ctx)('warn', '[tool-hub] lazy ttl sweep failed: ' + String((error as Error)?.message ?? error))
        }
      }, 60_000)
      this.lazyTimer.unref?.()
    }
    const on = (this.ctx as unknown as { on?: (event: string, callback: (payload: unknown) => void) => (() => void) | void }).on
    on?.('agent/turn-stopping', payload => {
      try {
        if (this.state.settings['tools.lazyUnloadEachTurn'] !== true) return
        const agent = payload !== null && typeof payload === 'object' ? (payload as { agent?: { id?: unknown; session?: { id?: unknown } } }).agent : undefined
        const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : typeof agent?.id === 'string' ? agent.id : ''
        if (sessionId === '' || !clearSessionLazy(this.state, sessionId)) return
        void saveState(this.state, 'lazy-turn-unload')
        refresh()
      }
      catch (error) {
        logTo(this.ctx)('warn', '[tool-hub] lazy turn unload failed: ' + String((error as Error)?.message ?? error))
      }
    })
    on?.('agent/disposed', payload => {
      try {
        const agent = payload !== null && typeof payload === 'object' ? (payload as { agent?: { id?: unknown; session?: { id?: unknown } } }).agent : undefined
        const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : typeof agent?.id === 'string' ? agent.id : ''
        if (sessionId === '' || !clearSessionLazy(this.state, sessionId)) return
        void saveState(this.state, 'lazy-session-disposed')
        refresh()
      }
      catch (error) {
        logTo(this.ctx)('warn', '[tool-hub] lazy session cleanup failed: ' + String((error as Error)?.message ?? error))
      }
    })
  }

  /**
   * Mount the per-agent tool mask and publish it as toolHub.surface. This is what makes the deny
   * list real after a restart: agents that already exist get a scope plugin, later ones are
   * caught by agent/created, and every tools/change re-syncs the mounted plugins.
   */
  private async installMask(): Promise<void> {
    if (this.mask !== null) return
    const mask = attachToolMask(this.ctx as unknown as { get(name: string): unknown }, this.state.sessions, {
      sessionAllow: this.state.sessionAllow,
      workspaces: this.state.workspaces,
      subagentAllow: this.state.subagentAllow,
      subagentDeny: this.state.subagentDeny,
    })
    this.mask = mask
    // The on-demand layer is per agent, so the mask asks for groups/inventory/cache instead of
    // holding state: a reload (extension toggle, external edit) is seen without a remount.
    mask.setOnDemandSource({
      groups: () => normalizeGroups(this.state.groups),
      known: () => knownToolNames(this.ctx as unknown as { get(name: string): unknown }),
      cached: sessionId => (sessionId === undefined || sessionId === '' ? [] : readOpen(this.state)[sessionId] ?? []),
    })
    mask.setLazySource(readLazy(this.state), knownToolNames(this.ctx as unknown as { get(name: string): unknown }))
    this.startLazyMaintenance(mask)
    const provide = (this.ctx as unknown as { provide?: (name: string, value: unknown) => void }).provide
    if (typeof provide !== 'function') {
      logTo(this.ctx)('warn', '[tool-hub] this host has no ctx.provide(); the tool mask cannot be published')
      return
    }
    provide.call(this.ctx, 'toolHub.surface', surfacePort(mask))
    provide.call(this.ctx, 'toolHub.mask', maskControl(mask))
    const recompute = async (): Promise<void> => {
      const result = await applySurface({ state: this.state, services: { get: service => this.ctx.get(service) } })
      if (!result.ok) logTo(this.ctx)('warn', '[tool-hub] tool mask refused: ' + (result.message ?? result.status))
    }
    // Deferred: a startup-time recompute can wait on agent fibers that are still being built.
    setTimeout(() => { void recompute() }, 250)
    // MCP tools arrive asynchronously and the deny list is filtered against the live view, so a
    // tools/change must re-run applySurface — otherwise a stale deny stays uninstalled until the
    // next user op. Debounced: a server registers dozens of tools in one burst.
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void recompute()
      }, 120)
    }
    const off = (this.ctx as unknown as { on?: (event: string, callback: () => void) => (() => void) | void }).on?.('tools/change', refresh)
    if (typeof off === 'function') (this.ctx as unknown as { effect?: (fn: () => () => void) => void }).effect?.(() => () => {
      if (timer !== null) clearTimeout(timer)
      off()
    })
  }

  /** The three catalog settings; an absent or non-string key falls back to its default. */
  private catalogSettings(): { indexUrl: string; mirrorUrl: string; cacheMinutes: number } {
    const settings = this.state.settings
    const text = (key: string, fallback: string): string => {
      const value = settings[key]
      return typeof value === 'string' ? value.trim() : fallback
    }
    const minutes = Number(settings['compat.cacheMinutes'])
    return {
      indexUrl: text('compat.indexUrl', DEFAULT_INDEX_URL),
      mirrorUrl: text('compat.mirrorUrl', DEFAULT_MIRROR_URL),
      cacheMinutes: Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_CACHE_MINUTES,
    }
  }

  private async buildOnce(): Promise<Build> {
    const registry = new Registry()
    const builtins = registerAll(registry)
    const extensions = await this.manager.load(this.state.extensions.enabled)
    const holder: { dispatcher: Dispatcher | null; statuses: ExtensionStatus[] } = {
      dispatcher: null,
      statuses: extensions.statuses,
    }

    // Register each extension on its own: a duplicate op id or a bad handler marks that one
    // extension failed and leaves the rest of the host untouched.
    const bindable: DomainRegistration[] = []
    for (const item of extensions.registrations) {
      try {
        registry.register(item.registration.module)
        bindable.push(item.registration)
      }
      catch (error) {
        item.status.loaded = false
        item.status.ops = []
        item.status.error = String((error as Error)?.message ?? error).slice(0, 300)
      }
    }

    const extensionOps: DomainRegistration = {
      module: {
        id: 'extensions',
        title: { zh: '扩展', en: 'Extensions' },
        ops: [
          { id: 'extension.list', write: false, audit: false, note: 'Lists installed local extensions with their load state and views.' },
          { id: 'extension.set', write: true, audit: true, note: 'Switches one extension on or off, saves the enabled list and rebuilds the runtime.' },
          { id: 'extension.reload', write: true, audit: true, note: 'Re-imports extension code and rebuilds the runtime; no host restart.' },
        ],
      },
      handlers: {
        'extension.list': async () => ({ extensions: holder.statuses, enabled: [...this.state.extensions.enabled] }),
        'extension.set': async (payload, env) => {
          const body = payload as { id?: unknown; enabled?: unknown } | null
          const id = typeof body?.id === 'string' ? body.id : ''
          if (!EXTENSION_ID.test(id)) throw new Failure('bad-payload', 'extension.set needs an id')
          if (typeof body?.enabled !== 'boolean') throw new Failure('bad-payload', 'extension.set needs enabled:boolean')
          const known = holder.statuses.some(status => status.id === id)
          if (!known && body.enabled) throw new Failure('missing-extension', `no extension "${id}" is installed`)
          const enabled = new Set(this.state.extensions.enabled)
          if (body.enabled) enabled.add(id)
          else enabled.delete(id)
          this.state.extensions.enabled = [...enabled].sort()
          await env.save('extension-set')
          await this.rebuild('extension-set')
          return { enabled: [...this.state.extensions.enabled], extensions: this.statuses }
        },
        'extension.reload': async (payload) => {
          const body = payload as { id?: unknown } | null
          const id = typeof body?.id === 'string' && EXTENSION_ID.test(body.id) ? body.id : undefined
          this.manager.invalidate(id)
          await this.rebuild('extension-reload')
          return { extensions: this.statuses, reloaded: id ?? '*' }
        },
      },
    }

    // Official packs: a remote catalog plus a verified installer. The module id gives the settings
    // their stored keys (compat.indexUrl / compat.mirrorUrl / compat.cacheMinutes) and keeps the
    // two ops out of the extensions namespace.
    const compatOps: DomainRegistration = {
      module: {
        id: 'compat',
        title: { zh: '官方配套', en: 'Official packs' },
        ops: [
          { id: 'compat.index', write: false, audit: false, note: 'Reads the official pack catalog from compat.indexUrl (then compat.mirrorUrl), reuses it for compat.cacheMinutes, and matches each pack against the local extension rows.' },
          { id: 'compat.install', write: true, audit: true, confirm: true, note: 'Downloads one pack from the official catalog, verifies every file byte count and sha256, backs up an existing local copy and rebuilds the runtime.' },
          { id: 'compat.uninstall', write: true, audit: true, confirm: true, note: 'Backs up the installed copy of one official pack, removes it from the profile extension root, drops it from the enabled list, saves and rebuilds; the pack stays in the catalog.' },
        ],
        settings: COMPAT_SETTINGS,
      },
      handlers: {
        // The catalog read is the card's refresh: no audit line, and a cache hit is the normal
        // answer right after a write. Every row is matched against the live rows above, so
        // installedVersion / enabled / updateAvailable are current even on a cached document.
        'compat.index': async (payload) => {
          const force = (payload as { force?: unknown } | null)?.force === true
          let loaded
          try {
            loaded = await this.catalog.load(this.catalogSettings(), force)
          }
          catch (error) {
            throw compatFailure(error)
          }
          const packs = loaded.index.packs.map(pack => {
            const status = holder.statuses.find(entry => entry.id === pack.id)
            const installedVersion = status === undefined ? '' : status.version
            return {
              id: pack.id,
              name: pack.name,
              version: pack.version,
              ...(pack.description === undefined ? {} : { description: pack.description }),
              fileCount: pack.files.length,
              installedVersion,
              installedDir: status === undefined ? '' : status.dir,
              enabled: status !== undefined && status.enabled,
              updateAvailable: installedVersion !== '' && installedVersion !== pack.version,
            }
          })
          return { packs, source: loaded.source, fetchedAt: loaded.fetchedAt, warnings: loaded.warnings }
        },
        'compat.install': async (payload) => {
          const body = payload as { id?: unknown } | null
          const id = typeof body?.id === 'string' ? body.id : ''
          if (!EXTENSION_ID.test(id)) throw new Failure('bad-payload', 'compat.install needs an id')
          let pack: CompatPack | undefined
          try {
            const loaded = await this.catalog.load(this.catalogSettings())
            pack = loaded.index.packs.find(entry => entry.id === id)
          }
          catch (error) {
            throw compatFailure(error)
          }
          if (pack === undefined) throw new Failure('unknown-pack', `the official catalog has no pack "${id}"`)
          let installed
          try {
            installed = await installCompatPack({ pack, root: join(stateDir(), 'extensions'), backupRoot: backupDir() })
          }
          catch (error) {
            throw compatFailure(error)
          }
          // The new folder only shows up in a snapshot after a build, so rebuild before answering:
          // the reload the panel does next already carries the row the install created.
          await this.rebuild('compat-install')
          return installed
        },
        // Uninstalling has no catalog document to consult: the local folder is the whole subject,
        // so the handler works from <stateDir>/extensions/<id> and the pack stays installable.
        'compat.uninstall': async (payload, env) => {
          const body = payload as { id?: unknown } | null
          const id = typeof body?.id === 'string' ? body.id : ''
          if (!EXTENSION_ID.test(id)) throw new Failure('bad-payload', 'compat.uninstall needs an id')
          let removed
          try {
            removed = await uninstallCompatPack({ id, root: join(stateDir(), 'extensions'), backupRoot: backupDir() })
          }
          catch (error) {
            throw compatFailure(error)
          }
          // An enabled id whose folder is gone would sit in state as a phantom entry the next
          // build reports as an error row; drop it before the rebuild reads the list.
          const enabled = this.state.extensions.enabled.filter(entry => entry !== id)
          if (enabled.length !== this.state.extensions.enabled.length) {
            this.state.extensions.enabled = enabled
            await env.save('compat-uninstall')
          }
          await this.rebuild('compat-uninstall')
          return removed
        },
      },
    }

    const coreBase = createCoreDomain({
      snapshot: async (payload, env) => buildSnapshot({
        env,
        registry,
        fresh: (payload as { fresh?: unknown } | undefined)?.fresh === true,
        history: async () => (holder.dispatcher === null ? [] : await holder.dispatcher.history()),
        extensions: holder.statuses,
      }),
      doctor: async () => runDoctor({ ctx: this.ctx, stateDir: stateDir(), expectedInjects: HEARTBEAT_INJECTS }),
      clearLock: async (payload) => clearStalePanelLock({
        patchPath: patchPathFor(this.ctx),
        backupDir: backupDir(),
        confirm: (payload as { confirm?: unknown } | null)?.confirm === true,
      }),
    })
    const core: DomainRegistration = {
      module: { ...coreBase.module, ops: [...coreBase.module.ops, ...extensionOps.module.ops] },
      handlers: { ...coreBase.handlers, ...extensionOps.handlers },
    }
    registry.register(core.module)
    registry.register(compatOps.module)

    const dispatcher = new Dispatcher({
      registry,
      state: this.state,
      services: { get: service => this.ctx.get(service) },
      log: logTo(this.ctx),
      save: async (next, reason) => await saveState(next, reason),
    })
    holder.dispatcher = dispatcher
    for (const registration of builtins) dispatcher.bind(registration)
    for (const registration of bindable) {
      try {
        dispatcher.bind(registration)
      }
      catch (error) {
        registry.remove(registration.module.id)
        const status = holder.statuses.find(entry => entry.id === registration.module.id)
        if (status !== undefined) {
          status.loaded = false
          status.ops = []
          status.error = String((error as Error)?.message ?? error).slice(0, 300)
        }
      }
    }
    dispatcher.bind(core)
    dispatcher.bind(compatOps)

    // Settings fields a new extension declares become visible with their defaults immediately;
    // the next settings save persists them.
    try {
      const modules = registry.list()
      this.state.settings = normalizeSettings(applySettingsDefaults(this.state.settings, modules), modules)
    }
    catch {
      // A malformed settings field must not take the host down; the settings page shows what it can.
    }

    return { registry, dispatcher, statuses: holder.statuses, modules: registry.list().length, ops: registry.ops().length }
  }
}

/** A catalog failure keeps its stable code; anything else is reported as one compat failure. */
function compatFailure(error: unknown): Failure {
  if (error instanceof CompatFailure) return new Failure(error.code, error.message)
  return new Failure('compat-failed', String((error as Error)?.message ?? error).slice(0, 300))
}

/** The core domain: snapshot/doctor plus the portability ops (dshmarket, third-party). */
export function createCoreDomain(handlers: { snapshot: OpHandler; doctor: OpHandler; clearLock: OpHandler }): DomainRegistration {
  return {
    module: {
      id: 'core',
      title: { zh: '核心', en: 'Core' },
      ops: [
        { id: 'snapshot', write: false, audit: false, note: 'Builds the panel snapshot from the registered domains.' },
        { id: 'doctor', write: false, audit: false, note: 'Runs the diagnostics against the live host.' },
        { id: 'doctor.clearLock', write: true, audit: true, confirm: true, note: 'Backs up a stale profile patch lock to the backups folder, then removes it; the patch file is never touched.' },
        { id: 'history.clear', write: true, audit: true, note: 'Truncates this profile audit log; the clear itself is recorded afterwards.' },
        ...PORTABILITY_OPS,
      ],
    },
    handlers: {
      snapshot: handlers.snapshot,
      doctor: handlers.doctor,
      'doctor.clearLock': handlers.clearLock,
      'history.clear': async () => {
        await writeFileAtomic(historyFile(), '')
        return { cleared: true }
      },
      ...portabilityHandlers(),
    },
  }
}

/**
 * 2.0 entry. The 1.x entry stays in lib/index.js until the cutover; this module is compiled to
 * dist and only loaded when package.json points there.
 */
export function apply(ctx: HubContext): void {
  const ready = Runtime.create(ctx)
  const run = async (op: unknown, payload: unknown): Promise<ReturnType<Dispatcher['run']> extends Promise<infer T> ? T : never> => {
    try {
      const runtime = await ready
      return await runtime.run(op, payload) as never
    }
    catch (error) {
      return { ok: false, error: failureOf(error) } as never
    }
  }
  installApi({
    ctx,
    run,
    snapshot: async ({ fresh }) => {
      const runtime = await ready
      const outcome = await runtime.run('snapshot', { fresh })
      if (!outcome.ok) throw new Error(outcome.error.message)
      return outcome.data
    },
  })

  // G5: /tools and tool_switch, both over session.switch; one adapter unwraps the op result.
  void ready.then(runtime => {
    installEntryPoints(ctx as unknown as EntryPointCtx, async (op, payload) => {
      const outcome = await runtime.run(op, payload) as { ok: boolean; data?: unknown; error?: { message: string } }
      if (!outcome.ok) throw new Error(outcome.error?.message ?? 'operation failed')
      return outcome.data
    })
  })

  // The catalog tool is the model's only door into a lazily hidden server; it follows rebuilds.
  void ready.then(runtime => {
    try {
      const inject = (ctx as unknown as {
        inject?: (services: string[], callback: (scope: unknown) => void, label?: string) => void
      }).inject
      inject?.(['tools'], (scope: unknown) => {
        const hostCtx = scope as { tools?: { register?: (definition: unknown) => void }; get?: (name: string) => unknown }
        const tools = hostCtx.tools ?? hostCtx.get?.('tools') as { register?: (definition: unknown) => void } | undefined
        if (tools?.register === undefined) return
        try {
          const adapter = { execute: (op: unknown, payload: unknown) => runtime.execute(op, payload) }
          tools.register(createCatalogTool(adapter as never))
          // Registered next to hub_tools and for the same reason: a reserved name is the model's
          // only way back into a masked group, so it is registered globally and never masked.
          tools.register(createGroupTool(adapter as never))
        }
        catch (error) {
          ctx.logger?.warn('[tool-hub] catalog tools unavailable: ' + String((error as Error)?.message ?? error))
        }
      }, 'tool-hub: hub_tools')
    }
    catch (error) {
      ctx.logger?.warn('[tool-hub] tools service unavailable: ' + String((error as Error)?.message ?? error))
    }
  })
}
