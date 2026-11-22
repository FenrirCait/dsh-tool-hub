/**
 * Official plugin baseline: read the shipped profile tree, compare it with the live loader rows,
 * and (on explicit confirmation) restore official switches while disabling third-party rows.
 *
 * The baseline is the profile's bundle layers without its user layer: the same input
 * "dsh --profile <name> --dump-default-config" prints. It is not "all official plugins enabled";
 * entries that ship disabled stay disabled, and conditional entries are reported but left alone.
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { backupDir, stateFile } from '../core/io.js'
import type { DomainRegistration, HostEnv } from '../shared/contract.js'
import { listPluginRows, setPluginEnabled, type PluginRow } from './plugins.js'

interface ProfileCtx {
  name?: string
  dir?: string
  patchPath?: string
  installAnchor?: string
  home?: string
}

interface DefaultEntry {
  id?: unknown
  name?: unknown
  disabled?: unknown
  config?: unknown
}

interface BaselineEntry {
  id: string
  name: string
  moduleName: string
  official: boolean
  onBaseline: boolean
  defaultEnabled: boolean | null
  conditional: boolean
  requiresConfig: boolean
  currentEnabled: boolean | null
  action: 'enable' | 'disable' | 'leave' | 'skip'
  reason: string
}

interface ResetPlan {
  available: boolean
  profile: string
  entries: BaselineEntry[]
  official: number
  defaultOff: number
  conditional: number
  changes: number
  disableThirdParty: Array<{ id: string; name: string; moduleName: string }>
  warnings: string[]
}

const OFFICIAL_PREFIXES = ['@deepseek-ai/', 'cordis:']
const KEEP_MODULES = new Set(['dsh-tool-hub', 'dshmarket'])

function isOfficial(name: string): boolean {
  const value = name.toLowerCase()
  return OFFICIAL_PREFIXES.some(prefix => value.startsWith(prefix))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function defaultState(raw: DefaultEntry): { enabled: boolean | null; conditional: boolean; requiresConfig: boolean } {
  const disabled = raw.disabled
  const conditional = disabled !== undefined && disabled !== true && disabled !== false
  const enabled = disabled === true ? false : conditional ? null : true
  return { enabled, conditional, requiresConfig: raw.config !== undefined }
}

function appBootPath(profile: ProfileCtx): string | null {
  const anchor = text(profile.installAnchor)
  if (anchor !== '') return join(dirname(anchor), '..', 'dsh-app-boot', 'lib', 'index.js')
  const install = text(process.env.DSH_INSTALL_DIR)
  if (install !== '') return join(dirname(install), 'dsh-app-boot', 'lib', 'index.js')
  return null
}

async function shippedEntries(profile: ProfileCtx): Promise<{ available: boolean; entries: DefaultEntry[]; warning: string }> {
  const boot = appBootPath(profile)
  if (boot === null) return { available: false, entries: [], warning: 'profile install anchor is unavailable' }
  try {
    const mod = await import(pathToFileURL(boot).href) as {
      loadProfile?: (bin: string, name: string, installAnchor: string, home: string, options: { userLayer: false }) => unknown
      composeEntries?: (patches: unknown[]) => DefaultEntry[]
    }
    if (typeof mod.loadProfile !== 'function' || typeof mod.composeEntries !== 'function') {
      return { available: false, entries: [], warning: 'dsh-app-boot does not expose loadProfile/composeEntries' }
    }
    const name = text(profile.name)
    const anchor = text(profile.installAnchor)
    const home = text(profile.home)
    if (name === '' || anchor === '' || home === '') return { available: false, entries: [], warning: 'profileContext is incomplete' }
    const loaded = mod.loadProfile('dsh', name, anchor, home, { userLayer: false }) as {
      layers?: Array<{ patches?: unknown[] }>
      skippedBundles?: unknown[]
    }
    const layers = Array.isArray(loaded.layers) ? loaded.layers : []
    const patches = layers.flatMap(layer => Array.isArray(layer.patches) ? layer.patches : [])
    const entries = mod.composeEntries(patches)
    return { available: true, entries: Array.isArray(entries) ? entries : [], warning: '' }
  }
  catch (error) {
    return { available: false, entries: [], warning: String((error as Error)?.message ?? error) }
  }
}

function collectDefaults(raw: DefaultEntry[]): Map<string, DefaultEntry> {
  const map = new Map<string, DefaultEntry>()
  for (const entry of raw) {
    const id = text(entry.id)
    const name = text(entry.name)
    if (id === '' || name === '') continue
    map.set(id, entry)
  }
  return map
}

function buildPlan(profile: ProfileCtx, defaults: Map<string, DefaultEntry>, rows: PluginRow[], available: boolean): ResetPlan {
  const officialRows = rows.filter(row => row.official)
  const thirdParty = rows.filter(row => !row.official && !row.self && !KEEP_MODULES.has(row.moduleName) && row.readOnlyReason === null && row.enabled)
  const byName = new Map<string, DefaultEntry>()
  for (const raw of defaults.values()) {
    const name = text(raw.name)
    if (name !== '') byName.set(name, raw)
  }
  const entries: BaselineEntry[] = []
  const seen = new Set<string>()
  const seenNames = new Set<string>()
  for (const row of officialRows) {
    const raw = byName.get(row.moduleName) ?? defaults.get(row.id)
    const state = raw === undefined ? { enabled: null, conditional: false, requiresConfig: false } : defaultState(raw)
    let action: BaselineEntry['action'] = 'skip'
    let reason = raw === undefined ? 'not in the shipped profile' : 'unchanged'
    if (raw !== undefined) {
      if (state.conditional) { action = 'leave'; reason = 'conditional default (left unchanged)' }
      else if (row.readOnlyReason !== null) { action = 'skip'; reason = row.readOnlyReason }
      else if (state.enabled === true) { action = row.enabled ? 'leave' : 'enable'; reason = row.enabled ? 'already at default' : 'shipped default is enabled' }
      else if (state.enabled === false) { action = row.enabled ? 'disable' : 'leave'; reason = row.enabled ? 'shipped default is disabled' : 'already at default' }
    }
    entries.push({
      id: row.id,
      name: row.name,
      moduleName: row.moduleName,
      official: true,
      onBaseline: raw !== undefined,
      defaultEnabled: state.enabled,
      conditional: state.conditional,
      requiresConfig: state.requiresConfig,
      currentEnabled: row.enabled,
      action,
      reason,
    })
    seen.add(row.id)
    seenNames.add(row.moduleName)
  }
  for (const [id, raw] of defaults) {
    if (seen.has(id)) continue
    const moduleName = text(raw.name)
    if (!isOfficial(moduleName) || seenNames.has(moduleName)) continue
    const state = defaultState(raw)
    entries.push({
      id,
      name: moduleName,
      moduleName,
      official: true,
      onBaseline: true,
      defaultEnabled: state.enabled,
      conditional: state.conditional,
      requiresConfig: state.requiresConfig,
      currentEnabled: null,
      action: 'skip',
      reason: 'not mounted in the current profile',
    })
  }
  entries.sort((a, b) => a.id.localeCompare(b.id))
  const changes = entries.filter(entry => entry.action === 'enable' || entry.action === 'disable').length
  const warnings: string[] = []
  if (!available) warnings.push('shipped default config is unavailable; only the live list can be shown')
  return {
    available,
    profile: text(profile.name),
    entries,
    official: entries.length,
    defaultOff: entries.filter(entry => entry.defaultEnabled === false).length,
    conditional: entries.filter(entry => entry.conditional).length,
    changes,
    disableThirdParty: thirdParty.map(row => ({ id: row.id, name: row.name, moduleName: row.moduleName })),
    warnings,
  }
}

async function planFor(env: HostEnv): Promise<{ plan: ResetPlan; rows: PluginRow[] }> {
  const profile = (env.services.get('profileContext') ?? {}) as ProfileCtx
  const loaded = await shippedEntries(profile)
  const rows = await listPluginRows(env, true)
  return { plan: buildPlan(profile, collectDefaults(loaded.entries), rows, loaded.available), rows }
}

export function officialDomain(): DomainRegistration {
  return {
    module: {
      id: 'official',
      title: { zh: '官方插件基线', en: 'Official plugin baseline' },
      ops: [
        { id: 'official.baseline', write: false, audit: false, note: 'Reads shipped profile defaults and compares them with the live plugin rows.' },
        { id: 'official.reset', write: true, audit: true, confirm: true, note: 'Backs up the profile, restores official rows to shipped defaults and disables third-party rows, with optional exemptions.' },
      ],
    },
    handlers: {
      'official.baseline': async (_payload, env) => {
        const { plan } = await planFor(env)
        return plan
      },
      'official.reset': async (payload, env) => {
        const body = (payload ?? {}) as { confirm?: unknown; exempt?: unknown }
        if (body.confirm !== true) throw new Error('official.reset needs confirm:true')
        const exempt = new Set(Array.isArray(body.exempt) ? body.exempt.filter((id): id is string => typeof id === 'string') : [])
        const { plan, rows } = await planFor(env)
        const profile = (env.services.get('profileContext') ?? {}) as ProfileCtx
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const target = join(backupDir(), 'official-baseline-' + stamp)
        await mkdir(target, { recursive: true })
        const patch = text(profile.patchPath)
        if (patch !== '') await copyFile(patch, join(target, 'cordis.patch.yml')).catch(() => undefined)
        await copyFile(stateFile(), join(target, 'tool-hub-state.json')).catch(() => undefined)
        await writeFile(join(target, 'plan.json'), JSON.stringify({ plan, exempt: [...exempt] }, null, 2) + '\n', 'utf8')
        const byId = new Map(rows.map(row => [row.id, row]))
        const applied: Array<{ id: string; enabled: boolean }> = []
        const skipped: Array<{ id: string; reason: string }> = []
        const failed: Array<{ id: string; error: string }> = []
        const actions = plan.entries.filter(entry => entry.action === 'enable' || entry.action === 'disable')
        for (const entry of actions) {
          if (exempt.has(entry.id)) { skipped.push({ id: entry.id, reason: 'exempted by user' }); continue }
          const row = byId.get(entry.id)
          if (row === undefined || row.readOnlyReason !== null) { skipped.push({ id: entry.id, reason: 'not switchable' }); continue }
          try {
            await setPluginEnabled(env, entry.id, entry.action === 'enable')
            applied.push({ id: entry.id, enabled: entry.action === 'enable' })
          }
          catch (error) {
            failed.push({ id: entry.id, error: String((error as Error)?.message ?? error) })
            break
          }
        }
        for (const row of rows) {
          if (row.official || row.self || KEEP_MODULES.has(row.moduleName) || row.readOnlyReason !== null || !row.enabled) continue
          if (exempt.has(row.id)) { skipped.push({ id: row.id, reason: 'exempted by user' }); continue }
          try {
            await setPluginEnabled(env, row.id, false)
            applied.push({ id: row.id, enabled: false })
          }
          catch (error) {
            failed.push({ id: row.id, error: String((error as Error)?.message ?? error) })
            break
          }
        }
        return { ok: failed.length === 0, backup: target, applied, skipped, failed, plan }
      },
    },
  }
}