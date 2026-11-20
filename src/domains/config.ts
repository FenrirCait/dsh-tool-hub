/**
 * Config portability: the four sections a user may carry between installations, and nothing else.
 *
 * 1.x implemented the same import twice. The CLI (bin/dsh-tool-hub.mjs) validated a file and
 * merged or replaced groups, drawers, presets and the tool deny list; the panel (lib/index.js)
 * normalised the same four sections, merged them by id/name and re-applied the live mask
 * afterwards. This module is the single 2.0 implementation of both halves: the CLI's validation
 * and merge/replace rules, plus the panel's mask replay.
 *
 * What never travels is the point of the format. Sessions, scenes, settings, auto and mode
 * describe this installation's live state, so neither mode reads them from a file nor writes
 * them: an import replaces exactly the four sections and leaves every other key in place. That is
 * also why a bundle is safe to hand to someone else - there is no slot for a path, a token or a
 * per-machine preference.
 *
 * Bundle shape:
 *
 *   { kind: 'tool-hub-config', version: 1, exportedAt: <ISO>, data: { groups, collections, presets, toolDeny } }
 *
 * An import also accepts the 1.x file (the same four sections at the top level, no envelope) as an
 * object or as pasted JSON text, because that is what users already have on disk.
 *
 * Failure contract: coded DomainFailures (`bad-payload`, `bad-json`, `bad-config`,
 * `confirm-required`); nothing here throws past the dispatcher boundary.
 */
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { StateV2 } from '../core/state.js'
import { DEFAULT_COLLECTION } from '../core/state.js'
import {
  cleanRole,
  cleanTags,
  MAX_COLLECTION_NAME,
  MAX_GROUP_NAME,
  memberKey,
  normalizeCollections,
  normalizeGroups,
  type CollectionRecord,
  type GroupRecord,
  type Member,
} from './groups.js'
import { MAX_PRESET_NAME, normalizePresets, type PresetRecord } from './presets.js'
import {
  applySurface,
  asRecord,
  asStringList,
  fail,
  MCP_TOOL_PREFIX,
  type SurfaceApplyResult,
} from './tool-surface.js'

/** The tag a 2.0 export carries, so an import can refuse a file that is not one. */
export const CONFIG_KIND = 'tool-hub-config'

/** Bundle schema version. A 1.x file (no envelope) is read as the same four sections. */
export const CONFIG_VERSION = 1

export type ConfigMode = 'merge' | 'replace'

/** The portable half of a state document; the five live sections never appear here. */
export interface ConfigSections {
  groups: GroupRecord[]
  collections: CollectionRecord[]
  presets: PresetRecord[]
  toolDeny: string[]
}

export interface ConfigBundle {
  kind: typeof CONFIG_KIND
  version: typeof CONFIG_VERSION
  exportedAt: string
  data: ConfigSections
}

export interface ConfigExportResult extends ConfigBundle {
  /** The bundle as the file text a download button writes; one trailing newline, like the CLI. */
  json: string
  counts: { groups: number; collections: number; presets: number; toolDeny: number }
}

/**
 * What one import did, and what the two portable collections now hold.
 *
 * `addedGroups` / `mergedGroups` / `presets` describe the file's effect; `total`, `collections`
 * and `deny` describe the state after the write. `totalPresets` exists because `presets` is the
 * number the file wrote (added or overwritten), not the size of the resulting list.
 */
export interface ConfigCounts {
  mode: ConfigMode
  addedGroups: number
  mergedGroups: number
  presets: number
  totalPresets: number
  addedCollections: number
  collections: number
  deny: number
  total: number
}

export interface ConfigPlan {
  sections: ConfigSections
  counts: ConfigCounts
}

// -- small readers -----------------------------------------------------------

/** The drawer id shape of the 2.0 state schema (core/state.ts reads drawers with the same rule). */
const DRAWER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Unique strings, first-seen order; the preset helper's rule, kept identical. */
function cleanIds(value: unknown): string[] {
  return [...new Set(asStringList(value))]
}

/**
 * The installation deny list, normalised to what the mask can use: MCP tool names only, trimmed,
 * deduplicated, first-seen order. The mask itself filters and sorts, so the stored list stays
 * human-readable and the signature stays stable.
 */
function cleanDeny(value: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of asStringList(value)) {
    const name = entry.trim()
    if (!name.startsWith(MCP_TOOL_PREFIX) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

// -- validation (the CLI's validateConfig, 2.0 record shapes) -----------------

function toCollection(entry: Record<string, unknown>, index: number): CollectionRecord {
  const id = typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : ''
  const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, MAX_COLLECTION_NAME) : ''
  if (id === '' || name === '') throw fail('bad-config', 'every collection needs a string id and name')
  if (!DRAWER_ID.test(id)) throw fail('bad-config', `drawer "${id}": ids are lowercase letters, digits, - and _ (max 32)`)
  return { id, name, order: finiteNumber(entry.order, index) }
}

function toMember(entry: unknown, groupName: string): Member {
  if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.trim() === '') {
    throw fail('bad-config', `group "${groupName}" has a member without an id`)
  }
  const kind: Member['kind'] | null = entry.kind === 'skill' ? 'skill' : entry.kind === 'plugin' ? 'plugin' : null
  if (kind === null) throw fail('bad-config', `group "${groupName}" has a member of unknown kind`)
  return { kind, id: entry.id.trim() }
}

function toGroup(entry: unknown, fallbackId: string, now: number): GroupRecord {
  if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.trim() === '') {
    throw fail('bad-config', 'every group needs a name')
  }
  const name = entry.name.trim().slice(0, MAX_GROUP_NAME)
  const members: Member[] = []
  const seen = new Set<string>()
  for (const candidate of arrayOf(entry.members)) {
    const member = toMember(candidate, name)
    if (seen.has(memberKey(member))) continue
    seen.add(memberKey(member))
    members.push(member)
  }
  return {
    id: typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : fallbackId,
    name,
    members,
    role: cleanRole(entry.role),
    // A drawer reference is resolved against the drawers the merge ends up with; null means none.
    collection: entry.collection === null
      ? null
      : typeof entry.collection === 'string' && entry.collection.trim() !== ''
        ? entry.collection.trim()
        : DEFAULT_COLLECTION.id,
    tags: cleanTags(entry.tags),
    auto: entry.auto === true,
    createdAt: finiteNumber(entry.createdAt, now),
    onDemand: entry.onDemand === true,
  }
}

function toPreset(entry: unknown, now: number): PresetRecord {
  if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.trim() === '') {
    throw fail('bad-config', 'every preset needs a name')
  }
  const enabled = asRecord(entry.enabled)
  const preset: PresetRecord = {
    name: entry.name.trim().slice(0, MAX_PRESET_NAME),
    enabled: {
      plugin: cleanIds(enabled.plugin),
      skill: cleanIds(enabled.skill),
      tool: cleanIds(enabled.tool),
    },
    note: typeof entry.note === 'string' ? entry.note : '',
    createdAt: finiteNumber(entry.createdAt, now),
  }
  // Absent stays absent: a preset that predates the tool dimension must not read as "deny nothing".
  if (Array.isArray(entry.toolDeny)) preset.toolDeny = cleanDeny(entry.toolDeny)
  if (typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)) preset.updatedAt = entry.updatedAt
  return preset
}

/**
 * Validate one bundle's four sections and build typed 2.0 records.
 *
 * The refusals are the CLI's (a non-object, a section that is not an array, a group without a
 * name, a member without an id or with an unknown kind, a drawer without id/name, a preset
 * without a name or with a name twice). The normalisation is the panel's (trim, dedupe members,
 * default ids, drawer ids lowercased to the state schema), plus one 2.0-only refusal: a drawer id
 * the state schema cannot store is an error rather than a drawer that silently disappears.
 *
 * `now` is the import time used for records that carry no createdAt of their own.
 */
export function validateConfig(raw: unknown, now = 0): ConfigSections {
  if (!isRecord(raw)) throw fail('bad-config', 'an imported config must be a JSON object')
  for (const key of ['groups', 'collections', 'presets', 'toolDeny'] as const) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) throw fail('bad-config', `"${key}" must be an array`)
  }

  const collections: CollectionRecord[] = []
  const collectionIds = new Set<string>()
  for (const [index, entry] of arrayOf(raw.collections).entries()) {
    if (!isRecord(entry)) throw fail('bad-config', 'every collection needs a string id and name')
    const collection = toCollection(entry, index)
    if (collectionIds.has(collection.id)) continue
    collectionIds.add(collection.id)
    collections.push(collection)
  }

  const groups: GroupRecord[] = []
  const groupIds = new Set<string>()
  for (const entry of arrayOf(raw.groups)) {
    const group = toGroup(entry, 'g' + (groups.length + 1), now)
    if (groupIds.has(group.id)) continue
    groupIds.add(group.id)
    groups.push(group)
  }

  const presets: PresetRecord[] = []
  const presetNames = new Set<string>()
  for (const entry of arrayOf(raw.presets)) {
    const preset = toPreset(entry, now)
    if (presetNames.has(preset.name)) throw fail('bad-config', `preset "${preset.name}" appears twice`)
    presetNames.add(preset.name)
    presets.push(preset)
  }

  return { groups, collections, presets, toolDeny: cleanDeny(raw.toolDeny) }
}

// -- merge / replace (the CLI's mergeState / replaceState) --------------------

/** Point every group at a drawer that exists; the read path treats an unknown one as default. */
function resolveDrawers(groups: GroupRecord[], collections: readonly CollectionRecord[]): void {
  const ids = new Set(collections.map(entry => entry.id))
  for (const group of groups) {
    if (group.collection !== null && !ids.has(group.collection)) group.collection = DEFAULT_COLLECTION.id
  }
}

/**
 * Merge a bundle into this installation, the CLI's way: drawers by id, groups by id then by name
 * (a name collision folds into the existing group, the user's own group wins), presets by name
 * (the file overwrites the stored one), and the deny list as a union. Nothing outside the four
 * sections is read or written.
 */
export function mergeConfigState(state: StateV2, incoming: ConfigSections): ConfigPlan {
  const collections = normalizeCollections(state.collections)
  const collectionIds = new Set(collections.map(entry => entry.id))
  let addedCollections = 0
  for (const entry of incoming.collections) {
    if (collectionIds.has(entry.id)) continue
    collections.push({ ...entry })
    collectionIds.add(entry.id)
    addedCollections += 1
  }
  collections.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))

  const groups = normalizeGroups(state.groups)
  const byId = new Map(groups.map(group => [group.id, group]))
  const byName = new Map(groups.map(group => [group.name, group]))
  let addedGroups = 0
  let mergedGroups = 0
  for (const incomingGroup of incoming.groups) {
    const target = byId.get(incomingGroup.id) ?? byName.get(incomingGroup.name)
    if (target === undefined) {
      const group = { ...incomingGroup, members: [...incomingGroup.members] }
      groups.push(group)
      byId.set(group.id, group)
      byName.set(group.name, group)
      addedGroups += 1
      continue
    }
    const keys = new Set(target.members.map(memberKey))
    for (const member of incomingGroup.members) {
      if (keys.has(memberKey(member))) continue
      keys.add(memberKey(member))
      target.members.push(member)
    }
    mergedGroups += 1
  }

  const presets = normalizePresets(state.presets)
  const byPreset = new Map(presets.map(preset => [preset.name, preset]))
  let written = 0
  for (const incomingPreset of incoming.presets) {
    const target = byPreset.get(incomingPreset.name)
    if (target === undefined) {
      const preset = { ...incomingPreset, enabled: { ...incomingPreset.enabled } }
      presets.push(preset)
      byPreset.set(preset.name, preset)
    }
    else Object.assign(target, incomingPreset)
    written += 1
  }

  const toolDeny = cleanDeny([...state.toolDeny, ...incoming.toolDeny])
  resolveDrawers(groups, collections)
  return {
    sections: { groups, collections, presets, toolDeny },
    counts: {
      mode: 'merge',
      addedGroups,
      mergedGroups,
      presets: written,
      totalPresets: presets.length,
      addedCollections,
      collections: collections.length,
      deny: toolDeny.length,
      total: groups.length,
    },
  }
}

/**
 * Replace the four sections, the CLI's way: the file's groups and presets, the file's deny list,
 * and a drawer list that always keeps the default drawer (a group needs a home). Every drawer and
 * group is new, which is why the counts report them as added rather than merged.
 */
export function replaceConfigState(incoming: ConfigSections): ConfigPlan {
  const collections = incoming.collections.length === 0
    ? [{ ...DEFAULT_COLLECTION }]
    : incoming.collections.map(entry => ({ ...entry }))
  if (!collections.some(entry => entry.id === DEFAULT_COLLECTION.id)) collections.unshift({ ...DEFAULT_COLLECTION })
  collections.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))

  const groups: GroupRecord[] = incoming.groups.map(group => ({
    ...group,
    members: group.members.map(member => ({ ...member })),
    tags: [...group.tags],
  }))
  resolveDrawers(groups, collections)
  const presets: PresetRecord[] = incoming.presets.map(preset => ({
    ...preset,
    enabled: { plugin: [...preset.enabled.plugin], skill: [...preset.enabled.skill], tool: [...preset.enabled.tool] },
    ...(preset.toolDeny === undefined ? {} : { toolDeny: [...preset.toolDeny] }),
  }))
  const toolDeny = [...incoming.toolDeny]
  return {
    sections: { groups, collections, presets, toolDeny },
    counts: {
      mode: 'replace',
      addedGroups: groups.length,
      mergedGroups: 0,
      presets: presets.length,
      totalPresets: presets.length,
      addedCollections: collections.length,
      collections: collections.length,
      deny: toolDeny.length,
      total: groups.length,
    },
  }
}

// -- ops ---------------------------------------------------------------------

/** Where an import takes its file from: a bundle object, or JSON text under `bundle`/`json`. */
function readConfigPayload(body: Record<string, unknown>): unknown {
  if (body.bundle === undefined && body.json === undefined) {
    throw fail('bad-payload', 'config.import needs bundle: an exported bundle object or its JSON text')
  }
  let raw: unknown = body.bundle !== undefined ? body.bundle : body.json
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    }
    catch {
      throw fail('bad-json', 'that config file is not valid JSON')
    }
  }
  if (!isRecord(raw)) throw fail('bad-config', 'config must be an object')
  if (typeof raw.kind === 'string' && raw.kind !== CONFIG_KIND) {
    throw fail('bad-config', `not a ${CONFIG_KIND} bundle (kind: ${raw.kind})`)
  }
  if ('data' in raw) {
    if (!isRecord(raw.data)) throw fail('bad-config', 'a config bundle needs data: an object holding the four sections')
    return raw.data
  }
  return raw
}

/** Replace exactly the four portable sections; every other key of the state stays as it was. */
function applySections(state: StateV2, sections: ConfigSections): void {
  state.groups = sections.groups
  state.collections = sections.collections
  state.presets = sections.presets
  state.toolDeny = sections.toolDeny
}

/**
 * Re-apply the live tool mask after the deny list changed. This is the same pass `tool.save` runs
 * (tool-surface.ts's private maskAfter is exactly this call plus the same warn line), so an import
 * cannot leave the stored deny list and the model's view out of step.
 */
async function maskAfterImport(env: HostEnv): Promise<SurfaceApplyResult> {
  const result = await applySurface({ state: env.state, services: env.services })
  if (!result.ok) env.log('warn', '[tool-hub] tool mask refused: ' + (result.message ?? result.status))
  return result
}

const configExport: OpHandler = async (payload, env) => {
  void payload
  const data: ConfigSections = {
    groups: normalizeGroups(env.state.groups),
    collections: normalizeCollections(env.state.collections),
    presets: normalizePresets(env.state.presets),
    toolDeny: cleanDeny(env.state.toolDeny),
  }
  const bundle: ConfigBundle = {
    kind: CONFIG_KIND,
    version: CONFIG_VERSION,
    exportedAt: new Date(env.now()).toISOString(),
    data,
  }
  return {
    ...bundle,
    json: `${JSON.stringify(bundle, null, 2)}\n`,
    counts: {
      groups: data.groups.length,
      collections: data.collections.length,
      presets: data.presets.length,
      toolDeny: data.toolDeny.length,
    },
  } satisfies ConfigExportResult
}

const configImport: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  // Anything that is not "replace" merges: an unrecognised mode must never widen the blast radius.
  const mode: ConfigMode = body.mode === 'replace' ? 'replace' : 'merge'
  if (mode === 'replace' && body.confirm !== true) {
    throw fail('confirm-required', 'replacing the config overwrites groups, collections and presets; pass confirm:true')
  }
  const incoming = validateConfig(readConfigPayload(body), env.now())
  const plan = mode === 'replace' ? replaceConfigState(incoming) : mergeConfigState(env.state, incoming)
  applySections(env.state, plan.sections)
  const backup = await env.save(mode === 'replace' ? 'config-replace' : 'config-merge')
  const mask = await maskAfterImport(env)
  return { ...plan.counts, backup, mask }
}

/** The config domain: one export, one import, and no third way to move state around. */
export function configDomain(): DomainRegistration {
  return {
    module: {
      id: 'config',
      title: { zh: '配置迁移', en: 'Config' },
      ops: [
        {
          id: 'config.export',
          write: false,
          audit: false,
          note: 'Serializes groups, drawers, presets and the tool deny list; never settings, sessions, scenes or credentials.',
        },
        {
          id: 'config.import',
          write: true,
          audit: true,
          note: 'Conditional gate: replace mode needs confirm:true and is enforced in the handler; merge needs none. Saves once and re-applies the tool mask.',
        },
      ],
    },
    handlers: {
      'config.export': configExport,
      'config.import': configImport,
    },
  }
}
