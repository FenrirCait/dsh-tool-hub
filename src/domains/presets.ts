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
 *
 * G11a adds one dimension that is not a snapshot of the live view: a preset can own a tool policy
 * (`disabled` plus named groups of patterns), edited per preset with preset.policy, copied between
 * presets with preset.copy and cleared with preset.policyReset. When a preset has one it wins over
 * the recorded deny list - two sources writing state.toolDeny would fork - and the apply receipt
 * says `source: 'policy'`. Groups are stored and validated but not enforced yet: hiding their
 * members needs the on-demand exposure state G10 owns, so the runtime deny list stays exactly the
 * disabled names (see src/domains/preset-policy.ts).
 */
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { StateV2 } from '../core/state.js'
import type { CatalogRow, MemberKind } from './groups.js'
import { cleanCatalogRows, resolveMemberPort } from './groups.js'
import {
  clonePolicy,
  deniedByPolicy,
  emptyPolicy,
  normalizeToolPolicy,
  policyCounts,
  policyIssues,
  projectPolicy,
  type PresetToolGroup,
  type PresetToolPolicy,
} from './preset-policy.js'
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

// The policy types live in the pure module so the panel can import them without the domain graph.
export type { PresetToolGroup, PresetToolPolicy } from './preset-policy.js'

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
  /**
   * This preset's own tool policy. Absent for a preset saved before policies existed, and absent
   * again after preset.policy { toolPolicy: null }: the apply path has to tell "no policy" from
   * "a policy that masks nothing", which is what an empty policy object means.
   */
  toolPolicy?: PresetToolPolicy
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
    // Same distinction one level down: no policy key at all, versus a policy that masks nothing.
    const policy = normalizeToolPolicy(raw.toolPolicy)
    if (policy !== undefined) preset.toolPolicy = policy
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
  toolPolicy: PresetToolPolicy
}

/** What a capture records on the policy dimension; both fields default to the live view. */
export interface PresetCapture {
  /** Installation deny list, i.e. what the panel shows as switched off. */
  disabled?: readonly string[]
  /** On-demand groups once G10 projects them; today always empty. */
  groups?: readonly PresetToolGroup[]
}

export function presetFromSnapshot(
  rows: readonly CatalogRow[],
  known: readonly string[],
  deny: readonly string[],
  capture: PresetCapture = {},
): PresetSnapshot {
  const denied = new Set(deny)
  const policy = normalizeToolPolicy({
    disabled: capture.disabled ?? deny,
    groups: capture.groups ?? [],
  }) ?? emptyPolicy()
  return {
    enabled: {
      plugin: rows.filter(row => row.kind === 'plugin' && row.enabled).map(row => row.id),
      skill: rows.filter(row => row.kind === 'skill' && row.enabled).map(row => row.id),
      tool: known.filter(name => !denied.has(name)),
    },
    toolDeny: deny.filter(name => name.startsWith(MCP_TOOL_PREFIX)),
    toolPolicy: policy,
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
  | { kind: 'deny'; deny: string[]; source: 'policy' | 'recorded' | 'live' }
  | { kind: 'leave' }
  | { kind: 'deferred'; wanted: string[] }

/**
 * Which tools a preset wants masked. A preset with its own policy answers first: the policy is the
 * user's statement of intent and the only source that covers tools no server has registered, so
 * letting the recorded list win would fork the two. Groups are deliberately not part of the answer
 * yet - G11a records them, G10 exposes them.
 *
 * Without a policy the order is 1.x's, and each step says why: recorded deny (works with the
 * servers off) > live complement (only for legacy presets) > deferred (nothing to complement
 * against yet) > leave (the preset predates the dimension).
 */
export function resolvePresetTools(
  preset: PresetRecord,
  mode: PresetMode,
  currentDeny: readonly string[],
  known: readonly string[],
): PresetToolDecision {
  if (preset.toolPolicy !== undefined) {
    return { kind: 'deny', source: 'policy', deny: deniedByPolicy(preset.toolPolicy) }
  }
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

/** On-demand groups recorded on the tool surface once G10 projects them; empty today. */
function recordedGroups(state: StateV2): PresetToolGroup[] {
  const surface = asRecord(asRecord(state.modules)['tool-surface'])
  const groups = Array.isArray(surface.groups) ? surface.groups : []
  const policy = normalizeToolPolicy({ disabled: [], groups })
  return policy === undefined ? [] : policy.groups
}

/**
 * The derived view of `enabled.tool` while a policy exists: everything live the policy does not
 * disable. Group members stay in it, because they are not hidden at runtime until G11b.
 */
function derivedTools(preset: PresetRecord, known: readonly string[]): string[] {
  const deny = new Set(preset.toolPolicy === undefined ? [] : deniedByPolicy(preset.toolPolicy))
  return known.filter(name => !deny.has(name))
}

/** `expect.updatedAt`, when the caller asked for compare-and-set. */
function expectedStamp(payload: Record<string, unknown>): number | null {
  const expect = asRecord(payload.expect)
  return typeof expect.updatedAt === 'number' && Number.isFinite(expect.updatedAt) ? expect.updatedAt : null
}

/** The target names of preset.copy: one string or a list, trimmed, deduplicated, order kept. */
function copyTargets(value: unknown): string[] {
  const raw = typeof value === 'string' ? [value] : asStringList(value)
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const name = entry.trim().slice(0, MAX_PRESET_NAME)
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * Validate a policy a client wants to store, then normalize it.
 *
 * Two mistakes are refused instead of repaired, because both make the policy unaddressable: a group
 * without a name, and two groups whose names differ only by case. A group that matches no live tool
 * is a warning, not a refusal - a preset has to stay editable while its servers are off.
 */
function readPolicy(value: unknown): PresetToolPolicy {
  const raw = asRecord(value)
  const seen = new Set<string>()
  for (const entry of Array.isArray(raw.groups) ? raw.groups : []) {
    const group = asRecord(entry)
    const name = typeof group.name === 'string' ? group.name.trim() : ''
    if (name === '') throw fail('empty-group', 'every tool group needs a name')
    const key = name.toLowerCase()
    if (seen.has(key)) throw fail('duplicate-group', 'two tool groups share the name "' + name + '"')
    seen.add(key)
    const patterns = Array.isArray(group.patterns) ? group.patterns.filter(pattern => typeof pattern === 'string' && pattern.trim() !== '') : []
    if (patterns.length === 0) throw fail('empty-group', 'tool group "' + name + '" has no patterns')
  }
  const policy = normalizeToolPolicy(raw)
  if (policy === undefined) throw fail('bad-policy', 'toolPolicy must be an object or null')
  return policy
}

interface PresetToolReport {
  decision: PresetToolDecision['kind']
  deny?: string[]
  source?: 'policy' | 'recorded' | 'live'
  wanted?: string[]
  retryAfterMs?: number
  backup?: string | null
  mask?: string
  /** What the preset's policy asked for, so the panel can say "3 disabled, 2 groups". */
  policy?: { disabled: number, groups: number }
}

const presetSave: OpHandler = async (payload, env) => {
  const name = requireName(payload)
  const body = asRecord(payload)
  const rows = await readRows(env)
  const known = resolveSurfacePort(env.services)?.known() ?? []
  const snapshot = presetFromSnapshot(rows, known, viewDeny(env.state, env.services), {
    disabled: env.state.toolDeny,
    groups: recordedGroups(env.state),
  })
  // The recorded deny list is the raw installation list, not the lazy-expanded view: it is what
  // a replay should restore, and lazy servers stay lazy across a preset apply.
  snapshot.toolDeny = env.state.toolDeny.filter(entry => entry.startsWith(MCP_TOOL_PREFIX))
  const presets = normalizePresets(env.state.presets)
  const existing = findPreset(presets, name)
  if (existing !== undefined) {
    existing.enabled = snapshot.enabled
    existing.toolDeny = snapshot.toolDeny
    existing.toolPolicy = snapshot.toolPolicy
    existing.createdAt = env.now()
    existing.note = typeof body.note === 'string' ? body.note : existing.note
  }
  else {
    presets.push({
      name,
      enabled: snapshot.enabled,
      toolDeny: snapshot.toolDeny,
      toolPolicy: snapshot.toolPolicy,
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
  const snapshot = presetFromSnapshot(rows, known, viewDeny(env.state, env.services), {
    disabled: env.state.toolDeny,
    groups: recordedGroups(env.state),
  })
  preset.enabled = snapshot.enabled
  preset.toolDeny = env.state.toolDeny.filter(entry => entry.startsWith(MCP_TOOL_PREFIX))
  preset.toolPolicy = snapshot.toolPolicy
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
  const policy = preset.toolPolicy === undefined ? undefined : policyCounts(preset.toolPolicy)
  let tools: PresetToolReport = policy === undefined ? { decision: decision.kind } : { decision: decision.kind, policy }
  if (decision.kind === 'deny') {
    env.state.toolDeny = decision.deny.filter(name => name.startsWith(MCP_TOOL_PREFIX))
    // A policy makes enabled.tool a derived view (I1): keep the record honest while saving, so the
    // panel's tool count and the next capture agree with what was just applied.
    if (preset.toolPolicy !== undefined && known.length > 0) {
      preset.enabled.tool = derivedTools(preset, known)
      env.state.presets = presets
    }
    const backup = await env.save('preset-tools')
    const mask = await applySurface({ state: env.state, services: env.services })
    if (!mask.ok) env.log('warn', '[tool-hub] preset mask refused: ' + (mask.message ?? mask.status))
    tools = {
      decision: decision.kind,
      deny: env.state.toolDeny,
      source: decision.source,
      backup,
      mask: mask.status,
      ...(policy === undefined ? {} : { policy }),
    }
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

/**
 * preset.policy: read one preset's policy, or replace it.
 *
 * The absence of the `toolPolicy` key is the read path: the panel opens the editor with one call
 * and gets the normalized policy plus the live catalog, without a second read-only op and without
 * a history line claiming a write. `toolPolicy: null` removes the policy entirely ("this preset
 * never had one"), which is a different intent from preset.policyReset's empty policy ("it has one
 * and it masks nothing"), so the two stay separate ops.
 */
const presetPolicy: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const name = requireName(payload)
  const presets = normalizePresets(env.state.presets)
  const preset = findPreset(presets, name)
  if (preset === undefined) throw fail('no-preset', 'that preset no longer exists')
  const known = resolveSurfacePort(env.services)?.known() ?? []
  if (!('toolPolicy' in body)) {
    return { name, toolPolicy: preset.toolPolicy ?? null, updatedAt: preset.updatedAt ?? null, known }
  }
  const expect = expectedStamp(body)
  if (expect !== null && preset.updatedAt !== expect) {
    throw fail('stale-preset', 'this preset changed since it was read; reopen the editor', { updatedAt: preset.updatedAt ?? null, expect })
  }
  const warnings: string[] = []
  if (body.toolPolicy === null) {
    delete preset.toolPolicy
  }
  else {
    const policy = readPolicy(body.toolPolicy)
    const issues = policyIssues(policy, known)
    if (issues.disabledMembers.length > 0) warnings.push('member-disabled')
    if (issues.duplicateMembers.length > 0) warnings.push('member-duplicate')
    if (issues.orphans.length > 0) warnings.push('disabled-orphan')
    if (issues.emptyGroups.length > 0) warnings.push('group-empty-live')
    preset.toolPolicy = policy
  }
  preset.updatedAt = env.now()
  // The derived view is refreshed only against a live catalog: with no servers on, the recorded
  // enabled.tool list is still the better record of intent than an empty list would be.
  if (known.length > 0) preset.enabled.tool = derivedTools(preset, known)
  env.state.presets = presets
  const backup = await env.save('preset-policy')
  return {
    name,
    toolPolicy: preset.toolPolicy ?? null,
    warnings,
    updatedAt: preset.updatedAt,
    backup,
    known,
  }
}

/**
 * preset.copy: copy one preset's policy (default) or its whole record onto other presets.
 *
 * Policy mode projects onto the target's tool catalog and reports which groups vanished with it,
 * so "copy" never silently imports a group whose members the target cannot name. Whole mode is the
 * escape hatch: it replaces enabled + toolDeny + toolPolicy and keeps the target's createdAt.
 */
const presetCopy: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const what: 'whole' | 'policy' = body.what === 'whole' ? 'whole' : 'policy'
  const fromName = typeof body.from === 'string' ? body.from.trim().slice(0, MAX_PRESET_NAME) : ''
  const presets = normalizePresets(env.state.presets)
  const source = findPreset(presets, fromName)
  if (source === undefined) throw fail('no-preset', 'the source preset no longer exists')
  const targets = copyTargets(body.to)
  if (targets.length === 0) throw fail('bad-target', 'preset.copy needs at least one target name')
  const known = resolveSurfacePort(env.services)?.known() ?? []
  const copied: Array<{ to: string, disabled: number, groups: number, skippedGroups: string[] }> = []
  const skipped: Array<{ to: string, reason: 'target-missing' | 'no-common-tools' }> = []
  for (const to of targets) {
    const target = findPreset(presets, to)
    if (what === 'whole') {
      const policy = source.toolPolicy === undefined ? undefined : clonePolicy(source.toolPolicy)
      if (target === undefined) {
        presets.push({
          name: to,
          enabled: {
            plugin: [...source.enabled.plugin],
            skill: [...source.enabled.skill],
            tool: [...source.enabled.tool],
          },
          ...(source.toolDeny === undefined ? {} : { toolDeny: [...source.toolDeny] }),
          ...(policy === undefined ? {} : { toolPolicy: policy }),
          note: source.note,
          createdAt: env.now(),
          updatedAt: env.now(),
        })
      }
      else {
        target.enabled = {
          plugin: [...source.enabled.plugin],
          skill: [...source.enabled.skill],
          tool: [...source.enabled.tool],
        }
        if (source.toolDeny === undefined) delete target.toolDeny
        else target.toolDeny = [...source.toolDeny]
        if (policy === undefined) delete target.toolPolicy
        else target.toolPolicy = policy
        target.note = source.note
        target.updatedAt = env.now()
      }
      copied.push({
        to,
        disabled: policy === undefined ? 0 : policy.disabled.length,
        groups: policy === undefined ? 0 : policy.groups.length,
        skippedGroups: [],
      })
      continue
    }
    if (target === undefined) {
      skipped.push({ to, reason: 'target-missing' })
      continue
    }
    const catalog = new Set<string>([...target.enabled.tool, ...known])
    const projected = projectPolicy(source.toolPolicy ?? emptyPolicy(), [...catalog])
    if (projected.entries === 0) {
      skipped.push({ to, reason: 'no-common-tools' })
      continue
    }
    target.toolPolicy = projected.policy
    target.updatedAt = env.now()
    if (known.length > 0) target.enabled.tool = derivedTools(target, known)
    copied.push({
      to,
      disabled: projected.policy.disabled.length,
      groups: projected.policy.groups.length,
      skippedGroups: projected.skippedGroups,
    })
  }
  env.state.presets = presets
  // Nothing landed: do not stamp a backup for a copy that did not happen.
  const backup = copied.length === 0 ? null : await env.save('preset-copy')
  return { what, from: source.name, copied, skipped, presets, backup }
}

/**
 * preset.policyReset: clear this preset's disabled list and groups.
 *
 * `enabled` and `toolDeny` are untouched - resetting the policy must not switch plugins or skills.
 * The panel asks first; the op itself trusts the caller the way preset.delete does.
 */
const presetPolicyReset: OpHandler = async (payload, env) => {
  const name = requireName(payload)
  const presets = normalizePresets(env.state.presets)
  const preset = findPreset(presets, name)
  if (preset === undefined) throw fail('no-preset', 'that preset no longer exists')
  preset.toolPolicy = emptyPolicy()
  preset.updatedAt = env.now()
  const known = resolveSurfacePort(env.services)?.known() ?? []
  if (known.length > 0) preset.enabled.tool = derivedTools(preset, known)
  env.state.presets = presets
  const backup = await env.save('preset-policy-reset')
  return { name, toolPolicy: preset.toolPolicy, updatedAt: preset.updatedAt, backup, presets }
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
        { id: 'preset.policy', write: true, audit: true, note: 'Reads or replaces one preset tool policy; a policy wins over the recorded deny list, groups are stored but not enforced.' },
        { id: 'preset.copy', write: true, audit: true, note: 'Copies a preset onto others: its policy projected onto each target catalog, or the whole record.' },
        { id: 'preset.policyReset', write: true, audit: true, note: 'Clears one preset disabled list and groups; plugins and skills are untouched.' },
      ],
    },
    handlers: {
      'preset.save': presetSave,
      'preset.update': presetUpdate,
      'preset.delete': presetDelete,
      'preset.apply': presetApply,
      'preset.policy': presetPolicy,
      'preset.copy': presetCopy,
      'preset.policyReset': presetPolicyReset,
    },
  }
}
