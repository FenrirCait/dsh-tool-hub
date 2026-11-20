/**
 * Presets: a named snapshot of what is switched on, replayed later.
 *
 * 1.x semantics, kept because presets outlive upgrades:
 *   - the snapshot has four dimensions (plugins, skills, tools, and the recorded deny list);
 *   - a preset saved before the deny list existed is left alone on the tool dimension, so an old
 *     preset never silently re-enables tools someone disabled by hand;
 *   - a recorded deny list is name-based and needs no live view, so it is used whenever the
 *     preset has one - that is what makes a preset replayable while its servers are off;
 *   - only a legacy preset without that list falls back to complementing "what should be on"
 *     against the live view.
 *
 * One deliberate 2.0 change: the 1.x delayed retry (setTimeout 1500ms when no tool is known yet)
 * is reported as \`deferred\` instead of scheduling a timer inside a domain. The caller re-applies
 * once the servers it just switched on have registered; the report says so.
 *
 * Failure contract: op failures throw a coded DomainFailure; per-item toggle outcomes are rows.
 */
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { StateV2 } from '../core/state.js'
import type { CatalogRow, MemberKind } from './groups.js'
import { cleanCatalogRows, resolveMemberPort } from './groups.js'
import {
  applySurface,
  asRecord,
  asStringList,
  errorText,
  fail,
  failureOf,
  lazyDeny,
  MCP_TOOL_PREFIX,
  mergeSurface,
  readLazy,
  resolveSurfacePort,
  type ToggleOutcome,
} from './tool-surface.js'

export interface PresetEnabled {
  plugin: string[]
  skill: string[]
  tool: string[]
}

export interface PresetRecord {
  name: string
  enabled: PresetEnabled
  /** Null/absent for presets saved before the deny list was recorded. */
  toolDeny?: string[]
  note: string
  createdAt: number
  updatedAt?: number
}

export type PresetMode = 'exact' | 'only-enable'

export const MAX_PRESET_NAME = 60

/** The panel itself never gets switched off by a preset that predates it. */
export const SELF_MODULE = 'dsh-tool-hub'

function cleanIds(value: unknown): string[] {
  return [...new Set(asStringList(value))]
}

/** Presets from a state file, deduplicated by name; a broken entry is dropped, not repaired. */
export function normalizePresets(value: unknown): PresetRecord[] {
  const out: PresetRecord[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(value) ? value : []) {
    const raw = asRecord(entry)
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_PRESET_NAME) : ''
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    const enabled = asRecord(raw.enabled)
    const preset: PresetRecord = {
      name,
      enabled: {
        plugin: cleanIds(enabled.plugin),
        skill: cleanIds(enabled.skill),
        tool: cleanIds(enabled.tool),
      },
      note: typeof raw.note === 'string' ? raw.note : '',
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    }
    // Kept as-is when absent: the apply path has to tell "no deny list recorded" from "empty".
    if (Array.isArray(raw.toolDeny)) {
      preset.toolDeny = [...new Set(asStringList(raw.toolDeny).filter(name => name.startsWith(MCP_TOOL_PREFIX)))]
    }
    if (typeof raw.updatedAt === 'number') preset.updatedAt = raw.updatedAt
    out.push(preset)
  }
  return out
}

export function findPreset(presets: readonly PresetRecord[], name: unknown): PresetRecord | undefined {
  return typeof name === 'string' ? presets.find(preset => preset.name === name) : undefined
}

/** What the live view says is on, split the way a preset records it. */
export interface PresetSnapshot {
  enabled: PresetEnabled
  toolDeny: string[]
}

export function presetFromSnapshot(rows: readonly CatalogRow[], known: readonly string[], deny: readonly string[]): PresetSnapshot {
  const denied = new Set(deny)
  return {
    enabled: {
      plugin: rows.filter(row => row.kind === 'plugin' && row.enabled).map(row => row.id),
      skill: rows.filter(row => row.kind === 'skill' && row.enabled).map(row => row.id),
      tool: known.filter(name => !denied.has(name)),
    },
    toolDeny: deny.filter(name => name.startsWith(MCP_TOOL_PREFIX)),
  }
}

/** The deny list the panel shows: installation list plus lazy servers, without a session overlay. */
export function viewDeny(state: StateV2, services: { get(name: string): unknown }): string[] {
  const known = resolveSurfacePort(services)?.known() ?? []
  return mergeSurface({
    install: state.toolDeny,
    lazy: lazyDeny(readLazy(state), known),
    known,
  }).deny
}

export interface PresetItem {
  kind: MemberKind
  id: string
  enabled: boolean
}

/** The switches one apply would flip; exact mode turns things off, only-enable never does. */
export function planPresetApply(
  preset: PresetRecord,
  rows: readonly CatalogRow[],
  mode: PresetMode,
  selfModule = SELF_MODULE,
): PresetItem[] {
  const wantPlugin = new Set(preset.enabled.plugin)
  const wantSkill = new Set(preset.enabled.skill)
  const items: PresetItem[] = []
  for (const row of rows) {
    if (row.kind === 'plugin') {
      if (row.manageable === false) continue
      if (row.moduleName === selfModule) continue
    }
    const want = row.kind === 'plugin' ? wantPlugin.has(row.id) : wantSkill.has(row.id)
    if (row.enabled !== want && (mode === 'exact' || want)) items.push({ kind: row.kind, id: row.id, enabled: want })
  }
  return items
}

export type PresetToolDecision =
  | { kind: 'deny'; deny: string[]; source: 'recorded' | 'live' }
  | { kind: 'leave' }
  | { kind: 'deferred'; wanted: string[] }

/**
 * Which tools a preset wants masked. Preference order is 1.x's, and each step says why:
 * recorded deny (works with the servers off) > live complement (only for legacy presets) >
 * deferred (nothing to complement against yet) > leave (the preset predates the dimension).
 */
export function resolvePresetTools(
  preset: PresetRecord,
  mode: PresetMode,
  currentDeny: readonly string[],
  known: readonly string[],
): PresetToolDecision {
  const wanted = preset.enabled.tool
  const recorded = preset.toolDeny
  if (recorded !== undefined) {
    return {
      kind: 'deny',
      source: 'recorded',
      deny: mode === 'exact' ? [...recorded] : currentDeny.filter(name => !wanted.includes(name)),
    }
  }
  if (wanted.length > 0 && known.length > 0) {
    return {
      kind: 'deny',
      source: 'live',
      deny: mode === 'exact' ? known.filter(name => !wanted.includes(name)) : currentDeny.filter(name => !wanted.includes(name)),
    }
  }
  if (wanted.length > 0) return { kind: 'deferred', wanted: [...wanted] }
  return { kind: 'leave' }
}

function requireName(payload: unknown): string {
  const body = asRecord(payload)
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_PRESET_NAME) : ''
  if (name === '') throw fail('bad-name', 'a preset needs a name')
  return name
}

function requireMode(value: unknown): PresetMode {
  return value === 'only-enable' ? 'only-enable' : 'exact'
}

async function readRows(env: HostEnv): Promise<CatalogRow[]> {
  try {
    return cleanCatalogRows(await resolveMemberPort(env).rows())
  }
  catch (error) {
    throw fail('capability-missing', 'member catalog unavailable: ' + errorText(error))
  }
}

interface PresetToolReport {
  decision: PresetToolDecision['kind']
  deny?: string[]
  source?: 'recorded' | 'live'
  wanted?: string[]
  retryAfterMs?: number
  backup?: string | null
  mask?: string
}

const presetSave: OpHandler = async (payload, env) => {
  const name = requireName(payload)
  const body = asRecord(payload)
  const rows = await readRows(env)
  const known = resolveSurfacePort(env.services)?.known() ?? []
  const snapshot = presetFromSnapshot(rows, known, viewDeny(env.state, env.services))
  // The recorded deny list is the raw installation list, not the lazy-expanded view: it is what
  // a replay should restore, and lazy servers stay lazy across a preset apply.
  snapshot.toolDeny = env.state.toolDeny.filter(entry => entry.startsWith(MCP_TOOL_PREFIX))
  const presets = normalizePresets(env.state.presets)
  const existing = findPreset(presets, name)
  if (existing !== undefined) {
    existing.enabled = snapshot.enabled
    existing.toolDeny = snapshot.toolDeny
    existing.createdAt = env.now()
    existing.note = typeof body.note === 'string' ? body.note : existing.note
  }
  else {
    presets.push({
      name,
      enabled: snapshot.enabled,
      toolDeny: snapshot.toolDeny,
      note: typeof body.note === 'string' ? body.note : '',
      createdAt: env.now(),
    })
  }
  env.state.presets = presets
  const backup = await env.save('preset-save')
  return { presets, snapshot, backup }
}

const presetUpdate: OpHandler = async (payload, env) => {
  const name = requireName(payload)
  const rows = await readRows(env)
  const presets = normalizePresets(env.state.presets)
  const preset = findPreset(presets, name)
  if (preset === undefined) throw fail('no-preset', 'that preset no longer exists')
  const known = resolveSurfacePort(env.services)?.known() ?? []
  const snapshot = presetFromSnapshot(rows, known, viewDeny(env.state, env.services))
  preset.enabled = snapshot.enabled
  preset.toolDeny = env.state.toolDeny.filter(entry => entry.startsWith(MCP_TOOL_PREFIX))
  preset.updatedAt = env.now()
  env.state.presets = presets
  const backup = await env.save('preset-update')
  return { presets, updated: true, name, backup }
}

const presetDelete: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const presets = normalizePresets(env.state.presets).filter(preset => preset.name !== name)
  env.state.presets = presets
  const backup = await env.save('preset-delete')
  return { presets, backup }
}

const presetApply: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const mode = requireMode(body.mode)
  const presets = normalizePresets(env.state.presets)
  const preset = findPreset(presets, name)
  if (preset === undefined) throw fail('no-preset', 'that preset no longer exists')
  const rows = await readRows(env)
  const port = resolveMemberPort(env)
  const items = planPresetApply(preset, rows, mode)
  const results: Array<{ kind: MemberKind; id: string; ok: boolean; code?: string; message?: string }> = []
  for (const item of items) {
    try {
      const outcome: ToggleOutcome = await port.setEnabled(item.kind, item.id, item.enabled)
      results.push({ kind: item.kind, id: item.id, ok: outcome.ok === true, ...(outcome.ok === true ? {} : failureOf(new Error(outcome.message ?? 'refused'))) })
    }
    catch (error) {
      results.push({ kind: item.kind, id: item.id, ok: false, ...failureOf(error) })
    }
    // The plugin manager persists and reloads per call; a small gap keeps the loader from
    // seeing two writes to the same layer inside one tick.
    await new Promise(done => setTimeout(done, 60))
  }
  const known = resolveSurfacePort(env.services)?.known() ?? []
  const decision = resolvePresetTools(preset, mode, env.state.toolDeny, known)
  let tools: PresetToolReport = { decision: decision.kind }
  if (decision.kind === 'deny') {
    env.state.toolDeny = decision.deny.filter(name => name.startsWith(MCP_TOOL_PREFIX))
    const backup = await env.save('preset-tools')
    const mask = await applySurface({ state: env.state, services: env.services })
    if (!mask.ok) env.log('warn', '[tool-hub] preset mask refused: ' + (mask.message ?? mask.status))
    tools = { decision: decision.kind, deny: env.state.toolDeny, source: decision.source, backup, mask: mask.status }
  }
  else if (decision.kind === 'deferred') {
    // No timer in a domain: the panel re-applies once the servers it just switched on register.
    tools = { decision: decision.kind, wanted: decision.wanted, retryAfterMs: 1500 }
  }
  return {
    preset: preset.name,
    mode,
    requested: items.length,
    applied: results.filter(row => row.ok).length,
    results,
    tools,
  }
}

/** The presets domain: snapshot, replay, and the tool dimension that outlives server state. */
export function presetsDomain(): DomainRegistration {
  return {
    module: {
      id: 'presets',
      title: { zh: '预设', en: 'Presets' },
      ops: [
        { id: 'preset.save', write: true, audit: true, note: 'Creates or overwrites a preset from the current live view, recording the deny list.' },
        { id: 'preset.update', write: true, audit: true, note: 'Overwrites an existing preset snapshot; a typo cannot create a new one.' },
        { id: 'preset.delete', write: true, audit: true, note: 'Removes a preset from state.json.' },
        { id: 'preset.apply', write: true, audit: true, note: 'Switches plugins, skills and tool masking to match a preset; a legacy tool dimension may report deferred.' },
      ],
    },
    handlers: {
      'preset.save': presetSave,
      'preset.update': presetUpdate,
      'preset.delete': presetDelete,
      'preset.apply': presetApply,
    },
  }
}
