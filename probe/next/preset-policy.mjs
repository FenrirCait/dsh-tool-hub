#!/usr/bin/env node
/**
 * probe/next/preset-policy.mjs — G11a, checked from outside.
 *
 * Three layers, all hand-rolled (`check` + PASS/FAIL + exit 1 on any failure):
 *   1. the pure policy module: normalization, signatures, membership, diagnostics, projection;
 *   2. the domain ops: preset.policy (read and write), preset.copy, preset.policyReset, and the
 *      policy-first branch of preset.apply, run against the compiled handlers;
 *   3. static gates on the two view files and the i18n catalogs they draw copy from.
 *
 * It imports the compiled module, not the sources, so it can be pointed at any emit directory:
 *   TOOL_HUB_DIST=<dir> runs the behavior half against an out-of-tree build,
 *   TOOL_HUB_ROOT=<dir> keeps the static gates on the real sources while doing so.
 * With neither set it behaves like every other probe in this folder (../../dist).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TOOL_HUB_ROOT ? resolve(process.env.TOOL_HUB_ROOT) : join(HERE, '..', '..')
const DIST = process.env.TOOL_HUB_DIST ? resolve(process.env.TOOL_HUB_DIST) : join(ROOT, 'dist')
const load = name => import(pathToFileURL(join(DIST, 'domains', name)).href)

const policyModule = await load('preset-policy.js')
const presets = await load('presets.js')
const surface = await load('tool-surface.js')
const { DomainFailure } = surface

const {
  MAX_POLICY_GROUPS,
  MAX_POLICY_DISABLED,
  POLICY_TOOL_PREFIX,
  cleanToolNames,
  clonePolicy,
  deniedByPolicy,
  emptyPolicy,
  memberOf,
  normalizeToolPolicy,
  patternMatch,
  policyChangeCount,
  policyCounts,
  policyDirty,
  policyIssues,
  policySignature,
  projectPolicy,
} = policyModule
const { normalizePresets, presetFromSnapshot, presetsDomain, resolvePresetTools } = presets

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('PASS ' + name)
    return
  }
  failed += 1
  failures.push(name)
  console.log('FAIL ' + name + (detail === undefined ? '' : ' -- ' + JSON.stringify(detail)))
}

function equal(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function makeState(overrides) {
  return Object.assign({
    version: 2,
    groups: [],
    collections: [{ id: 'default', name: '默认分组群', order: 0 }],
    presets: [],
    toolDeny: [],
    auto: { appliedAt: null },
    sessions: {},
    sessionAllow: {},
    workspaces: {},
    subagentAllow: [],
    subagentDeny: [],
    scenes: {},
    mode: null,
    settings: {},
    modules: {},
  }, overrides || {})
}

function makeEnv(options) {
  const config = options || {}
  const saves = []
  const env = {
    state: config.state || makeState(),
    services: { get: name => (config.services || {})[name] },
    async save(reason) {
      saves.push(reason)
      return '/state/backups/state-' + saves.length + '.json'
    },
    log() {},
    now: () => 1720000000000,
  }
  env.saves = saves
  return env
}

function memberPort(rows) {
  const calls = []
  return {
    calls,
    rows: () => rows.map(row => Object.assign({}, row)),
    setEnabled(kind, id, enabled) {
      calls.push({ kind, id, enabled })
      return { ok: true }
    },
  }
}

function surfacePort(known) {
  const calls = []
  return {
    calls,
    known: () => known.slice(),
    restrict(deny) {
      calls.push(deny.slice())
      return () => {}
    },
  }
}

async function expectFailure(name, action, code) {
  try {
    await action()
    check(name, false, 'resolved but should have thrown ' + code)
  }
  catch (error) {
    check(name, error instanceof DomainFailure && error.code === code, 'threw ' + (error && error.code ? error.code : String(error)))
  }
}

const HOST = { 'toolHub.members': memberPort([{ kind: 'plugin', id: 'p1', enabled: true }]), 'toolHub.surface': surfacePort(['mcp__a__1', 'mcp__b__1']) }

// ---- 1. pure: normalization ------------------------------------------------

check('normalize: no value at all means "this preset has no policy"',
  normalizeToolPolicy(undefined) === undefined && normalizeToolPolicy(null) === undefined)
check('normalize: an empty object is a policy that masks nothing',
  equal(normalizeToolPolicy({}), { disabled: [], groups: [] }))
check('normalize: disabled keeps only mcp names, trimmed, deduplicated and sorted',
  equal(normalizeToolPolicy({ disabled: ['mcp__b__1', ' plain ', 'mcp__a__1', 'mcp__b__1'] }).disabled, ['mcp__a__1', 'mcp__b__1']))
const manyNames = Array.from({ length: MAX_POLICY_DISABLED + 50 }, (_, index) => 'mcp__s__' + String(index).padStart(5, '0'))
check('normalize: the disabled list is capped',
  cleanToolNames(manyNames).length === MAX_POLICY_DISABLED)
check('normalize: an empty group name is dropped',
  equal(normalizeToolPolicy({ groups: [{ name: '   ', patterns: ['mcp__a__1'] }] }).groups, []))
check('normalize: group names dedupe case-insensitively, first one wins',
  equal(normalizeToolPolicy({ groups: [{ name: 'GH', patterns: ['x'] }, { name: 'gh', patterns: ['y'] }] }).groups.map(group => group.name), ['GH']))
check('normalize: patterns are trimmed, deduplicated and empty ones dropped',
  equal(normalizeToolPolicy({ groups: [{ name: 'g', patterns: [' a ', 'a', '', '  '] }] }).groups[0].patterns, ['a']))
check('normalize: a blank description is stored as absent',
  !('description' in normalizeToolPolicy({ groups: [{ name: 'g', description: '  ' }] }).groups[0]))
check('normalize: a description is trimmed and kept',
  normalizeToolPolicy({ groups: [{ name: 'g', description: '  prod tools ' }] }).groups[0].description === 'prod tools')
const manyGroups = Array.from({ length: MAX_POLICY_GROUPS + 10 }, (_, index) => ({ name: 'g' + String(index), patterns: ['mcp__a__' + String(index)] }))
check('normalize: the group count is capped', normalizeToolPolicy({ groups: manyGroups }).groups.length === MAX_POLICY_GROUPS)
check('normalize: a live catalog value does not become a policy',
  normalizeToolPolicy(['mcp__a__1']) === undefined && normalizeToolPolicy('mcp__a__1') === undefined)

// ---- 2. pure: signatures, membership, diagnostics, projection --------------

check('signature: disabled order and pattern order do not make a policy dirty',
  !policyDirty({ disabled: ['mcp__a__1', 'mcp__b__1'], groups: [{ name: 'g', patterns: ['b', 'a'] }] },
    { disabled: ['mcp__b__1', 'mcp__a__1'], groups: [{ name: 'g', patterns: ['a', 'b'] }] }))
check('signature: a renamed group is dirty',
  policyDirty({ disabled: [], groups: [{ name: 'g', patterns: [] }] }, { disabled: [], groups: [{ name: 'h', patterns: [] }] }))
check('signature: no policy and an empty policy differ',
  policySignature(undefined) !== policySignature(emptyPolicy()) && policyDirty(undefined, emptyPolicy()))
check('signature: the same policy is never dirty', !policyDirty(emptyPolicy(), emptyPolicy()) && policyChangeCount(undefined, undefined) === 0)
check('changeCount: counts one per changed entry and one per new group',
  policyChangeCount(undefined, { disabled: ['mcp__a__1'], groups: [{ name: 'g', patterns: [] }] }) === 2
  && policyChangeCount({ disabled: [], groups: [{ name: 'g', patterns: [] }] }, { disabled: [], groups: [] }) === 1)
check('clone: a copy is not the same object graph',
  (() => {
    const source = { disabled: ['mcp__a__1'], groups: [{ name: 'g', patterns: ['mcp__a__1'] }] }
    const copy = clonePolicy(source)
    copy.disabled.push('mcp__b__1')
    copy.groups[0].patterns.push('mcp__b__1')
    return source.disabled.length === 1 && source.groups[0].patterns.length === 1
  })())
check('match: an exact pattern is an equality test',
  patternMatch('mcp__a__1', 'mcp__a__1') && !patternMatch('mcp__a__1', 'mcp__a__2'))
check('match: a trailing * covers the rest of the name',
  patternMatch('mcp__gh__*', 'mcp__gh__list') && !patternMatch('mcp__gh__*', 'mcp__gh'))
check('match: * also matches the empty string and survives regex characters',
  patternMatch('mcp__a*', 'mcp__a') && patternMatch('mcp__(a)', 'mcp__(a)') && !patternMatch('mcp__.*', 'mcp__a__1'))
const owned = memberOf({ disabled: [], groups: [{ name: 'first', patterns: ['mcp__a__*'] }, { name: 'second', patterns: ['mcp__a__1', 'mcp__b__*'] }] },
  ['mcp__a__1', 'mcp__b__1', 'mcp__c__1'])
check('membership: the first matching group owns a tool',
  owned.get('mcp__a__1') === 'first' && owned.get('mcp__b__1') === 'second' && !owned.has('mcp__c__1'))
const issuePolicy = {
  disabled: ['mcp__a__1', 'mcp__gone__1'],
  groups: [
    { name: 'a', patterns: ['mcp__a__*'] },
    { name: 'b', patterns: ['mcp__a__1'] },
    { name: 'empty', patterns: ['mcp__zz__*'] },
  ],
}
const issues = policyIssues(issuePolicy, ['mcp__a__1', 'mcp__b__1'])
check('issues: a group that matches nothing is reported',
  equal(issues.emptyGroups, ['empty']))
check('issues: a member that is also disabled is reported once, with its first group',
  equal(issues.disabledMembers, [{ tool: 'mcp__a__1', group: 'a' }]))
check('issues: a member matched by two groups is reported with both',
  equal(issues.duplicateMembers, [{ tool: 'mcp__a__1', groups: ['a', 'b'] }]))
check('issues: a disabled name the catalog lost is an orphan',
  equal(issues.orphans, ['mcp__gone__1']))
const projected = projectPolicy(issuePolicy, ['mcp__a__1', 'mcp__b__1'])
check('projection: unknown disabled names do not travel',
  equal(projected.policy.disabled, ['mcp__a__1']))
check('projection: a group matched by nothing is skipped and named, and so is one an earlier group emptied',
  equal(projected.skippedGroups, ['b', 'empty']) && equal(projected.policy.groups.map(group => group.name), ['a']))
const takenProjection = projectPolicy({
  disabled: [],
  groups: [{ name: 'wide', patterns: ['mcp__*'] }, { name: 'narrow', patterns: ['mcp__a__1'] }],
}, ['mcp__a__1'])
check('projection: a group whose members an earlier group took is skipped',
  takenProjection.policy.groups.length === 1 && equal(takenProjection.skippedGroups, ['narrow']))
check('projection: nothing in common is entry-free',
  projectPolicy({ disabled: ['mcp__gone__1'], groups: [{ name: 'g', patterns: ['mcp__gone__*'] }] }, ['mcp__a__1']).entries === 0)
check('projection: wildcards survive as authored so the target keeps the rule',
  equal(projectPolicy({ disabled: [], groups: [{ name: 'g', patterns: ['mcp__a__*'] }] }, ['mcp__a__1', 'mcp__a__2']).policy.groups[0].patterns, ['mcp__a__*']))
check('counts: disabled and groups are reported separately',
  equal(policyCounts(issuePolicy), { disabled: 2, groups: 3 }))
check('deny: groups are not part of the runtime deny list yet',
  equal(deniedByPolicy(issuePolicy), ['mcp__a__1', 'mcp__gone__1']))

// ---- 3. domain: records and captures --------------------------------------

const withPolicy = normalizePresets([{
  name: 'policy',
  enabled: { plugin: [], skill: [], tool: [] },
  toolDeny: ['mcp__a__1'],
  toolPolicy: { disabled: ['mcp__a__1'], groups: [{ name: 'G', patterns: ['mcp__a__1'] }] },
}])[0]
check('record: normalizePresets keeps a valid toolPolicy', withPolicy.toolPolicy !== undefined && withPolicy.toolPolicy.groups[0].name === 'G')
check('record: a preset without the key keeps no policy',
  normalizePresets([{ name: 'old', enabled: {} }])[0].toolPolicy === undefined)
check('record: an explicit null is "no policy", not an empty one',
  normalizePresets([{ name: 'null', enabled: {}, toolPolicy: null }])[0].toolPolicy === undefined)
check('record: a broken policy is dropped, not repaired into something else',
  normalizePresets([{ name: 'bad', enabled: {}, toolPolicy: 'nope' }])[0].toolPolicy === undefined)
const captured = presetFromSnapshot([{ kind: 'plugin', id: 'p1', enabled: true }], ['mcp__a__1', 'mcp__b__1'], ['mcp__b__1', 'plain'], {
  disabled: ['mcp__b__1'],
  groups: [{ name: 'keep', patterns: ['mcp__b__*'] }],
})
check('capture: the policy records the installation deny list and the groups',
  equal(captured.toolPolicy, { disabled: ['mcp__b__1'], groups: [{ name: 'keep', patterns: ['mcp__b__*'] }] }))
check('capture: the legacy fields are still recorded',
  equal(captured.enabled.tool, ['mcp__a__1']) && equal(captured.toolDeny, ['mcp__b__1']))
check('capture: without a policy input the capture still has an empty one',
  equal(presetFromSnapshot([], ['mcp__a__1'], []).toolPolicy, { disabled: [], groups: [] }))

// ---- 4. domain: preset.policy --------------------------------------------

const basePreset = { name: 'work', enabled: { plugin: [], skill: [], tool: [] }, toolDeny: ['mcp__a__1'], note: '', createdAt: 1 }
const readState = makeState({ presets: [{ ...basePreset, toolPolicy: { disabled: ['mcp__a__1'], groups: [] }, updatedAt: 5 }] })
const readEnv = makeEnv({ state: readState, services: HOST })
const read = await presetsDomain().handlers['preset.policy']({ name: 'work' }, readEnv)
check('preset.policy: a payload without toolPolicy reads and writes nothing',
  readEnv.saves.length === 0 && equal(read.toolPolicy, { disabled: ['mcp__a__1'], groups: [] }) && read.updatedAt === 5)
check('preset.policy: the read answer carries the live catalog for the editor',
  equal(read.known, ['mcp__a__1', 'mcp__b__1']))

const writeState = makeState({ presets: [{ ...basePreset }] })
const writeEnv = makeEnv({ state: writeState, services: HOST })
const written = await presetsDomain().handlers['preset.policy']({
  name: 'work',
  toolPolicy: { disabled: ['mcp__b__1', 'mcp__b__1', 'plain'], groups: [{ name: ' gh ', patterns: ['mcp__b__1', 'mcp__b__1'] }] },
}, writeEnv)
check('preset.policy: a save normalizes and stores the policy',
  equal(writeState.presets[0].toolPolicy, { disabled: ['mcp__b__1'], groups: [{ name: 'gh', patterns: ['mcp__b__1'] }] }))
check('preset.policy: a save backs up once under its own reason',
  equal(writeEnv.saves, ['preset-policy']) && written.backup === '/state/backups/state-1.json')
check('preset.policy: a save stamps updatedAt for the next compare-and-set',
  written.updatedAt === 1720000000000 && writeState.presets[0].updatedAt === 1720000000000)
check('preset.policy: a save refreshes the derived enabled.tool view',
  equal(writeState.presets[0].enabled.tool, ['mcp__a__1']))
const readBack = await presetsDomain().handlers['preset.policy']({ name: 'work' }, makeEnv({ state: writeState, services: HOST }))
check('preset.policy: what was stored reads back byte-identical',
  equal(readBack.toolPolicy, writeState.presets[0].toolPolicy))

const validationState = makeState({ presets: [{ ...basePreset, updatedAt: 9 }] })
const validationEnv = makeEnv({ state: validationState, services: HOST })
await expectFailure('preset.policy: an empty group name is refused',
  () => presetsDomain().handlers['preset.policy']({ name: 'work', toolPolicy: { disabled: [], groups: [{ name: '  ', patterns: ['mcp__a__1'] }] } }, validationEnv), 'empty-group')
await expectFailure('preset.policy: a group without patterns is refused',
  () => presetsDomain().handlers['preset.policy']({ name: 'work', toolPolicy: { disabled: [], groups: [{ name: 'g', patterns: [] }] } }, validationEnv), 'empty-group')
await expectFailure('preset.policy: two groups with one name are refused',
  () => presetsDomain().handlers['preset.policy']({ name: 'work', toolPolicy: { disabled: [], groups: [{ name: 'G', patterns: ['mcp__a__1'] }, { name: 'g', patterns: ['mcp__b__1'] }] } }, validationEnv), 'duplicate-group')
await expectFailure('preset.policy: a stale expect.updatedAt is refused',
  () => presetsDomain().handlers['preset.policy']({ name: 'work', toolPolicy: emptyPolicy(), expect: { updatedAt: 8 } }, validationEnv), 'stale-preset')
await expectFailure('preset.policy: an unknown preset is refused',
  () => presetsDomain().handlers['preset.policy']({ name: 'nope', toolPolicy: emptyPolicy() }, validationEnv), 'no-preset')
check('preset.policy: a refused save leaves no backup and no state change',
  validationEnv.saves.length === 0 && validationState.presets[0].toolPolicy === undefined)
const matched = await presetsDomain().handlers['preset.policy']({ name: 'work', toolPolicy: emptyPolicy(), expect: { updatedAt: 9 } }, validationEnv)
check('preset.policy: a matching expect.updatedAt goes through',
  matched.toolPolicy !== null && equal(validationEnv.saves, ['preset-policy']))
const overlapState = makeState({ presets: [{ ...basePreset, toolPolicy: emptyPolicy() }] })
const overlap = await presetsDomain().handlers['preset.policy']({
  name: 'work',
  toolPolicy: { disabled: ['mcp__a__1'], groups: [{ name: 'g', patterns: ['mcp__a__*'] }, { name: 'empty', patterns: ['mcp__zz__*'] }] },
}, makeEnv({ state: overlapState, services: HOST }))
check('preset.policy: an overlap is a warning, not a refusal',
  overlap.warnings.includes('member-disabled') && overlap.warnings.includes('group-empty-live'))
const removed = await presetsDomain().handlers['preset.policy']({ name: 'work', toolPolicy: null }, makeEnv({ state: overlapState, services: HOST }))
check('preset.policy: toolPolicy null removes the policy and keeps the rest',
  removed.toolPolicy === null && overlapState.presets[0].toolPolicy === undefined
  && equal(overlapState.presets[0].toolDeny, ['mcp__a__1']) && equal(overlapState.presets[0].enabled.plugin, [])
  && equal(overlapState.presets[0].enabled.skill, []))

// ---- 5. domain: preset.copy ----------------------------------------------

function copyState(extra) {
  return makeState({
    presets: [
      { name: 'source', enabled: { plugin: ['p1'], skill: ['s1'], tool: ['mcp__a__1'] }, toolDeny: ['mcp__a__1'], note: 'n', createdAt: 3, updatedAt: 4,
        toolPolicy: { disabled: ['mcp__a__1', 'mcp__gone__1'], groups: [{ name: 'a', patterns: ['mcp__a__*'] }, { name: 'gone', patterns: ['mcp__gone__*'] }] } },
      { name: 'partial', enabled: { plugin: [], skill: [], tool: [] }, note: '', createdAt: 7 },
      { name: 'unrelated', enabled: { plugin: [], skill: [], tool: ['mcp__zz__1'] }, note: '', createdAt: 8 },
      ...(extra || []),
    ],
  })
}
const copyEnvState = copyState()
const copyEnv = makeEnv({ state: copyEnvState, services: { 'toolHub.surface': surfacePort(['mcp__a__1']) } })
const copied = await presetsDomain().handlers['preset.copy']({ from: 'source', to: ['partial', 'missing'], what: 'policy' }, copyEnv)
check('preset.copy: the projection keeps only names the target can hold',
  copied.copied.length === 1 && copied.copied[0].to === 'partial' && copied.copied[0].disabled === 1)
check('preset.copy: a group whose members all vanished is reported, not imported',
  equal(copied.copied[0].skippedGroups, ['gone']) && equal(copyEnvState.presets[1].toolPolicy.groups.map(group => group.name), ['a']))
check('preset.copy: a missing target is skipped, not created',
  equal(copied.skipped, [{ to: 'missing', reason: 'target-missing' }]))
check('preset.copy: one backup covers the whole call', equal(copyEnv.saves, ['preset-copy']))
const emptyState = makeState({
  presets: [
    { name: 'goneOnly', enabled: { plugin: [], skill: [], tool: [] }, note: '', createdAt: 1, toolPolicy: { disabled: ['mcp__gone__1'], groups: [{ name: 'gone', patterns: ['mcp__gone__*'] }] } },
    { name: 'unrelated', enabled: { plugin: [], skill: [], tool: ['mcp__zz__1'] }, note: '', createdAt: 2 },
  ],
})
const emptyEnv = makeEnv({ state: emptyState, services: { 'toolHub.surface': surfacePort(['mcp__a__1']) } })
const nothing = await presetsDomain().handlers['preset.copy']({ from: 'goneOnly', to: ['unrelated'], what: 'policy' }, emptyEnv)
check('preset.copy: a target with nothing in common is skipped and nothing is written',
  equal(nothing.skipped, [{ to: 'unrelated', reason: 'no-common-tools' }]) && nothing.backup === null
  && emptyEnv.saves.length === 0 && emptyState.presets[1].toolPolicy === undefined)
const wholeState = copyState()
const wholeEnv = makeEnv({ state: wholeState, services: { 'toolHub.surface': surfacePort([]) } })
const whole = await presetsDomain().handlers['preset.copy']({ from: 'source', to: ['partial', 'fresh'], what: 'whole' }, wholeEnv)
const fresh = wholeState.presets.find(preset => preset.name === 'fresh')
check('preset.copy whole: a missing target is created from the source',
  fresh !== undefined && equal(fresh.enabled, { plugin: ['p1'], skill: ['s1'], tool: ['mcp__a__1'] }) && equal(fresh.toolDeny, ['mcp__a__1']))
check('preset.copy whole: an existing target keeps its createdAt and takes the source policy',
  wholeState.presets[1].createdAt === 7 && wholeState.presets[1].toolPolicy !== undefined
  && wholeState.presets[1].toolPolicy.groups.length === 2)
check('preset.copy whole: the clone does not share arrays with the source',
  wholeState.presets[1].enabled.plugin.push('x') && equal(wholeState.presets[0].enabled.plugin, ['p1']))
check('preset.copy: the receipt counts what each target received',
  whole.copied.length === 2 && whole.copied[0].disabled === 2 && whole.copied[0].groups === 2)

// ---- 6. domain: reset and apply ------------------------------------------

const resetState = makeState({
  presets: [{ ...basePreset, createdAt: 2, toolPolicy: { disabled: ['mcp__a__1'], groups: [{ name: 'g', patterns: ['mcp__a__1'] }] } }],
})
const resetEnv = makeEnv({ state: resetState, services: HOST })
const reset = await presetsDomain().handlers['preset.policyReset']({ name: 'work' }, resetEnv)
check('preset.policyReset: clears the policy to an empty one',
  equal(resetState.presets[0].toolPolicy, { disabled: [], groups: [] }) && reset.toolPolicy !== null)
check('preset.policyReset: plugins, skills and the deny list are untouched',
  equal(resetState.presets[0].enabled.plugin, []) && equal(resetState.presets[0].enabled.skill, [])
  && equal(resetState.presets[0].toolDeny, ['mcp__a__1']))
check('preset.policyReset: the derived enabled.tool view follows the empty policy',
  equal(resetState.presets[0].enabled.tool, ['mcp__a__1', 'mcp__b__1']))
check('preset.policyReset: backs up under its own reason', equal(resetEnv.saves, ['preset-policy-reset']))
await expectFailure('preset.policyReset: an unknown preset is refused',
  () => presetsDomain().handlers['preset.policyReset']({ name: 'nope' }, resetEnv), 'no-preset')
check('resolvePresetTools: a policy wins over the recorded deny list',
  equal(resolvePresetTools({ ...basePreset, toolPolicy: { disabled: ['mcp__b__1'], groups: [{ name: 'g', patterns: ['mcp__a__1'] }] } }, 'exact', ['mcp__a__1'], ['mcp__a__1', 'mcp__b__1']),
    { kind: 'deny', source: 'policy', deny: ['mcp__b__1'] }))
check('resolvePresetTools: groups are not part of the decision yet',
  resolvePresetTools({ ...basePreset, toolPolicy: { disabled: [], groups: [{ name: 'g', patterns: ['mcp__a__1'] }] } }, 'exact', [], []).deny.length === 0)
check('resolvePresetTools: without a policy the recorded list still wins',
  equal(resolvePresetTools(basePreset, 'exact', [], ['mcp__a__1']), { kind: 'deny', source: 'recorded', deny: ['mcp__a__1'] }))
const applyState = makeState({
  toolDeny: ['mcp__b__1'],
  presets: [{ name: 'work', enabled: { plugin: [], skill: [], tool: ['mcp__a__1'] }, toolDeny: ['mcp__a__1'], note: '', createdAt: 1,
    toolPolicy: { disabled: ['mcp__a__1'], groups: [{ name: 'g', patterns: ['mcp__a__1'] }] } }],
})
const applyEnv = makeEnv({ state: applyState, services: { 'toolHub.members': memberPort([]), 'toolHub.surface': surfacePort(['mcp__a__1', 'mcp__b__1']) } })
const applied = await presetsDomain().handlers['preset.apply']({ name: 'work', mode: 'exact' }, applyEnv)
check('preset.apply: a policy becomes the installation deny list and the recorded list is ignored',
  equal(applyState.toolDeny, ['mcp__a__1']) && applied.tools.source === 'policy')
check('preset.apply: the receipt names the policy counts',
  equal(applied.tools.policy, { disabled: 1, groups: 1 }))
check('preset.apply: the policy path still re-applies the mask once',
  applied.tools.mask === 'applied' && applyEnv.saves.includes('preset-tools'))
const captureState = makeState({ toolDeny: ['mcp__b__1'] })
const captureEnv = makeEnv({ state: captureState, services: HOST })
const capturedPreset = await presetsDomain().handlers['preset.save']({ name: 'now' }, captureEnv)
check('preset.save: the capture records the live policy',
  equal(captureState.presets[0].toolPolicy, { disabled: ['mcp__b__1'], groups: [] }) && capturedPreset.backup !== null)
const recaptureState = makeState({ presets: [{ ...basePreset, toolPolicy: emptyPolicy() }] })
await presetsDomain().handlers['preset.save']({ name: 'work' }, makeEnv({ state: recaptureState, services: HOST }))
check('preset.save: an existing preset is re-captured with the new policy',
  equal(recaptureState.presets[0].toolPolicy, { disabled: [], groups: [] }))

// ---- 7. registration and static gates ------------------------------------

const domain = presetsDomain()
check('registration: the presets module declares seven ops',
  domain.module.ops.length === 7 && ['preset.policy', 'preset.copy', 'preset.policyReset'].every(id => domain.module.ops.some(op => op.id === id)))
check('registration: every declared op has a handler and every handler is declared',
  Object.keys(domain.handlers).length === domain.module.ops.length
  && domain.module.ops.every(op => typeof domain.handlers[op.id] === 'function'))
check('registration: the new ops are writes and audited',
  ['preset.policy', 'preset.copy', 'preset.policyReset'].every(id => {
    const op = domain.module.ops.find(entry => entry.id === id)
    return op.write === true && op.audit === true
  }))
check('registration: op notes carry no CJK', domain.module.ops.every(op => !/[\u4e00-\u9fff]/.test(op.note ?? '')))

const readFileText = file => readFileSync(file, 'utf8')
const lineCount = file => readFileText(file).split('\n').length
const VIEW = join(ROOT, 'src', 'client', 'views', 'presets.tsx')
const POLICY_VIEW = join(ROOT, 'src', 'client', 'views', 'presets-policy.tsx')
const GROUPS_VIEW = join(ROOT, 'src', 'client', 'views', 'presets-policy-groups.tsx')
const I18N = join(ROOT, 'src', 'client', 'i18n.ts')
const DOMAIN = join(ROOT, 'src', 'domains', 'presets.ts')
const SURFACE = join(ROOT, 'src', 'domains', 'tool-surface.ts')

check('static: the present view stays under its line budget', lineCount(VIEW) < 450, lineCount(VIEW))
check('static: the policy dialog stays under its line budget', lineCount(POLICY_VIEW) < 450, lineCount(POLICY_VIEW))
check('static: the group editor stays under its line budget', lineCount(GROUPS_VIEW) < 450, lineCount(GROUPS_VIEW))
check('static: the policy dialog is a sibling of the view and is rendered from it',
  existsSync(POLICY_VIEW) && readFileText(VIEW).includes("from './presets-policy.js'") && readFileText(VIEW).includes('<PresetPolicyDialog'))
check('static: the group editor is imported by the dialog',
  existsSync(GROUPS_VIEW) && readFileText(POLICY_VIEW).includes("from './presets-policy-groups.js'") && readFileText(POLICY_VIEW).includes('<PolicyGroupsEditor'))
const shadowed = readFileText(POLICY_VIEW).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')
const policyOps = [...shadowed.matchAll(/'preset\.([a-zA-Z]+)'/g)].map(match => match[1])
check('static: the dialog names exactly the three policy ops, once each',
  equal([...new Set(policyOps)].sort(), ['copy', 'policy', 'policyReset']) && policyOps.length === 3)
check('static: the save path carries the compare-and-set stamp',
  shadowed.includes('expect: { updatedAt: stamp }') && shadowed.includes('stale-preset'))
check('static: the reset and the remove path are different calls',
  shadowed.includes('applyOp(OP.reset,') && shadowed.includes('toolPolicy: null'))
check('static: the dirty draft is counted through the pure module',
  shadowed.includes('policyChangeCount(saved ?? undefined, draft ?? undefined)'))
const presentOps = [...readFileText(VIEW).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/'preset\.([a-z]+)'/g)].map(match => match[1])
check('static: the present view still names only its four 1.x ops',
  equal([...presentOps].sort(), ['apply', 'delete', 'save', 'update']))
check('static: the policy prefix matches the host mask prefix',
  readFileText(SURFACE).includes("MCP_TOOL_PREFIX = '" + POLICY_TOOL_PREFIX + "'"), POLICY_TOOL_PREFIX)

/** One catalog from i18n.ts, read by brace matching (same reading as client-presets.mjs). */
function catalog(name) {
  const text = readFileText(I18N)
  const found = new RegExp('const ' + name + ': Catalog = \\{').exec(text)
  if (found === null) throw new Error('i18n.ts has no ' + name + ' catalog')
  const open = found.index + found[0].length - 1
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return new Set([...text.slice(open + 1, index).matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1]))
    }
  }
  throw new Error(name + ' catalog is not closed')
}
const zh = catalog('zh')
const en = catalog('en')
const keysOf = file => [...readFileText(file).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\bt\('([^']+)'/g)].map(match => match[1])
const missing = []
for (const file of [POLICY_VIEW, GROUPS_VIEW]) {
  for (const key of keysOf(file)) {
    if (!zh.has(key)) missing.push('zh:' + key)
    if (!en.has(key)) missing.push('en:' + key)
  }
}
check('static: every t() key in the policy files exists in both catalogs', missing.length === 0, missing.slice(0, 6))
check('static: the two new keys the present view uses are declared on both sides',
  zh.has('presets.policy') && en.has('presets.policy') && zh.has('presets.policyBadge') && en.has('presets.policyBadge'))
check('static: the dialog takes its masking prefix from one constant',
  /const MASKABLE = 'mcp__'/.test(shadowed))

// ---- report ---------------------------------------------------------------

console.log('')
console.log(passed + '/' + (passed + failed) + ' checks passed')
if (failed > 0) {
  console.log('failed: ' + failures.join(', '))
  process.exit(1)
}
