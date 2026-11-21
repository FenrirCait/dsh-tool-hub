import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { HostEnv } from '../shared/contract.js'
import type { Registry } from '../core/registry.js'
import { stateFile } from '../core/io.js'
import { applySettingsDefaults, normalizeSettings, settingsFields } from '../core/settings.js'
import { normalizeGroups } from '../domains/groups.js'
import { normalizePresets } from '../domains/presets.js'
import { listBundles, listPluginRows } from '../domains/plugins.js'
import { listSkills, skillRoots } from '../domains/skills.js'
import { patchPathFor } from '../domains/mcp.js'
import { scanPatchBlocks } from '../core/patch-blocks.js'
import { readMode } from '../domains/scenes.js'
import { readLazy, serverOf } from '../domains/tool-surface.js'
import type { ExtensionStatus } from './extensions.js'

export interface SnapshotDeps {
  env: HostEnv
  registry: Registry
  fresh?: boolean
  history?: () => Promise<unknown[]>
  /** The build's extension rows; the client renders them in the Extensions view. */
  extensions?: ExtensionStatus[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function maskInfo(env: HostEnv): unknown {
  try {
    const mask = env.services.get('toolHub.mask') as { info?: () => unknown } | undefined
    if (typeof mask?.info !== 'function') return { available: false, mounted: 0, deny: [], sessions: [], problems: [] }
    const info = mask.info()
    return info !== null && typeof info === 'object' ? { available: true, ...info } : { available: true, mounted: 0, deny: [], sessions: [], problems: [] }
  }
  catch {
    return { available: false, mounted: 0, deny: [], sessions: [], problems: [] }
  }
}

function settingsSchema(registry: Registry): unknown[] {
  const modules = registry.list()
  return settingsFields(modules).map(({ key, field }) => ({ ...field, key }))
}

/** The tool rows the panel toggles: known names, live deny list, lazy servers. */
function toolRows(env: HostEnv): Array<{ name: string; enabled: boolean; server: string | null; lazy: boolean }> {
  const tools = env.services.get('tools') as Record<string, unknown> | null | undefined
  const view = typeof tools?.view === 'function' ? (tools.view as (arg: unknown) => unknown)(undefined) : null
  const record = asRecord(view)
  const names = [...new Set([...stringList(record.knownNames), ...stringList(record.restrictableNames)])]
  const deny = new Set(env.state.toolDeny)
  const lazy = readLazy(env.state)
  return names.sort().map(name => {
    const server = serverOf(name)
    return { name, enabled: !deny.has(name), server, lazy: server !== null && lazy.servers.includes(server) }
  })
}

/**
 * One read for the whole panel. Domains own their readers; this file only arranges the answer in
 * the shape the client normalises, so no view has to know where a field came from.
 */
export async function buildSnapshot(deps: SnapshotDeps): Promise<Record<string, unknown>> {
  const { env, registry } = deps
  const fresh = deps.fresh === true
  const [plugins, bundles, skills] = await Promise.all([
    listPluginRows(env, fresh),
    listBundles(env, fresh),
    listSkills(env),
  ])
  const modules = registry.list()
  const settings = normalizeSettings(applySettingsDefaults(env.state.settings, modules), modules)
  const mode = readMode(env.state)
  const roots = skillRoots(env)
  const patch = patchPathFor(env)
  // Managed blocks belong to other panels; the client shows their foreign rows without touching them.
  const patchInfo = patch === null
    ? { path: null, rows: 0, blocks: [], unclosed: [], foreignTotal: 0 }
    : await readFile(patch, 'utf8').then(text => ({ path: patch, ...scanPatchBlocks(text) })).catch(() => ({ path: patch, rows: 0, blocks: [], unclosed: [], error: 'unreadable' }))
  const home = process.env.DSH_HOME?.trim() || dirname(dirname(stateFile())) || homedir()

  return {
    plugins,
    skills,
    bundles: bundles.rows,
    bundleError: bundles.error,
    groups: normalizeGroups(env.state.groups),
    // Drawers are part of state but were never in the snapshot; the groups view needs names.
    collections: Array.isArray(env.state.collections) ? env.state.collections : [],
    presets: Object.fromEntries(normalizePresets(env.state.presets).map(preset => [preset.name, {
      plugin: preset.enabled.plugin,
      skill: preset.enabled.skill,
      tool: preset.enabled.tool,
    }])),
    tools: toolRows(env),
    sessions: env.state.sessions,
    scene: {
      mode: mode === null ? null : mode.name,
      since: mode?.at ?? null,
      names: Object.keys(env.state.scenes).sort(),
      scenes: env.state.scenes,
    },
    settings,
    settingsSchema: settingsSchema(registry),
    paths: {
      home,
      state: stateFile(),
      patch,
      skillRoots: roots.map(root => root.dir),
      skills: roots.map(root => ({ id: root.id, label: root.label, dir: root.dir, scope: root.scope, workspace: root.workspace ?? null })),
    },
    limits: { bulk: 100 },
    mcpError: null,
    history: deps.history === undefined ? [] : await deps.history(),
    extensions: deps.extensions ?? [],
    patchInfo,
    mask: maskInfo(env),
    fetchedAt: Date.now(),
  }
}
