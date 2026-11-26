#!/usr/bin/env node
/**
 * Probe for the workflow domains (task-3): scenes / tool-surface / sessions / groups / presets.
 *
 * Hand-rolled on purpose - no third-party library, PASS/FAIL lines, exit 1 on any failure.
 * It runs against dist/ (the compiled host half) and the 1.x scene engine, so it checks the
 * shipped code and the reused engine together.
 *
 * Coverage:
 *   1. scene engine: an absent section means "leave alone", an empty list means "clear";
 *   2. scene.apply / scene.exit: intent recorded first, rollback complete or honestly incomplete;
 *   3. four-source tool surface: merge order, attribution, unknown names, idempotent single restrict;
 *   4. session lineage: 8 levels including the session itself, cycle-safe, overlay union;
 *   5. groups and presets: 1.x member/package/drawer/snapshot semantics.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// The built host, or a copy when TOOL_HUB_DIST points at one (same override as tool-mask.mjs).
const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const {
  DomainFailure,
  SURFACE_SOURCES,
  applySurface,
  changeLazy,
  describeSurface,
  lazyDeny,
  lazyLoadedFor,
  lazyPrompt,
  lazyReport,
  pruneLazy,
  clearSessionLazy,
  mergeSurface,
  planSurface,
  readLazy,
  serverOf,
  writeLazy,
  toolSurfaceDomain,
} = await import(pathToFileURL(join(distRoot, 'domains', 'tool-surface.js')).href)
const { readMode, scenesDomain } = await import(pathToFileURL(join(distRoot, 'domains', 'scenes.js')).href)
const { lineageOf, overlayFor, sessionsDomain } = await import(pathToFileURL(join(distRoot, 'domains', 'sessions.js')).href)
const {
  applyCollectionDelete,
  applyGroupSave,
  expandBundles,
  groupsDomain,
  knownKeys,
  normalizeCollections,
  normalizeGroups,
  planGroupToggle,
} = await import(pathToFileURL(join(distRoot, 'domains', 'groups.js')).href)
const { normalizePresets, planPresetApply, presetsDomain, resolvePresetTools } = await import(pathToFileURL(join(distRoot, 'domains', 'presets.js')).href)
import * as engine from '../../lib/scene-engine.js'

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
  console.log('FAIL ' + name + (detail === undefined ? '' : ' -- ' + detail))
}

function equal(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function svc(map) {
  return { get: name => (map || {})[name] }
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
    scenes: {},
    mode: null,
    settings: {},
    modules: {},
  }, overrides || {})
}

function makeEnv(options) {
  const config = options || {}
  const saves = []
  const counts = new Map()
  const env = {
    state: config.state || makeState(),
    services: { get: name => (config.services || {})[name] },
    async save(reason) {
      const count = (counts.get(reason) || 0) + 1
      counts.set(reason, count)
      if (config.failSave && config.failSave(reason, count)) throw new Error('save refused: ' + reason)
      saves.push(reason)
      return '/state/backups/state-' + saves.length + '.json'
    },
    log() {},
    now: () => 1720000000000,
  }
  env.saves = saves
  return env
}

function mcpPort(rows) {
  const calls = []
  const port = {
    calls,
    fail: null,
    rows: () => rows.map(row => Object.assign({}, row)),
    setEnabled(id, enabled) {
      calls.push({ id, enabled })
      if (typeof port.fail === 'function' && port.fail(id, enabled)) {
        throw new Error('loader exploded on ' + id)
      }
      return { ok: true }
    },
  }
  return port
}

function surfacePort(known, options) {
  const config = options || {}
  const calls = []
  const port = {
    calls,
    lifted: 0,
    refuse: config.refuse === true,
    known: () => known.slice(),
    restrict(deny) {
      if (port.refuse) throw new Error('restrict refused')
      calls.push(deny.slice())
      return () => {
        port.lifted += 1
      }
    },
  }
  return port
}

function memberPort(rows, options) {
  const config = options || {}
  const enabledCalls = []
  const port = {
    enabledCalls,
    fail: config.fail || null,
    rows: () => rows.map(row => Object.assign({}, row)),
    setEnabled(kind, id, enabled) {
      enabledCalls.push({ kind, id, enabled })
      if (typeof port.fail === 'function' && port.fail(kind, id, enabled)) return { ok: false, code: 'refused', message: 'host refused ' + id }
      return { ok: true }
    },
  }
  return port
}

function expectFailure(name, action, code) {
  return action().then(
    () => check(name, false, 'resolved but should have thrown ' + code),
    error => check(name, error instanceof DomainFailure && error.code === code, 'threw ' + (error && error.code ? error.code : error)),
  )
}

// ---- 1. engine: empty section semantics -----------------------------------

const bare = engine.normalizeScene({ name: 'bare' })
check('engine: an absent section leaves its domain untouched',
  !('tools' in bare) && !('mcp' in bare))
const cleared = engine.normalizeScene({ name: 'cleared', tools: { deny: [] }, mcp: { off: [], on: [] } })
check('engine: an empty list clears its domain',
  Array.isArray(cleared.tools.deny) && cleared.tools.deny.length === 0 && 'mcp' in cleared)
const emptySnapshot = { at: 0, toolDeny: [], sessions: {}, mcp: {} }
const planBare = engine.planFromScene(bare, emptySnapshot)
check('engine: a bare scene plans no change at all', planBare.tools === null && planBare.mcp.length === 0)
const planCleared = engine.planFromScene(cleared, emptySnapshot)
check('engine: an empty-but-present list plans a change', planCleared.tools !== null && planCleared.tools.deny.length === 0)
check('engine: describePlan says the domain is untouched',
  engine.describePlan(planBare) === 'tools: untouched')

const scenes = scenesDomain()
const stateA = makeState({ toolDeny: ['mcp__old__z'] })
const saveEnv = makeEnv({ state: stateA })
const saved = await scenes.handlers['scene.save']({ name: 'work', tools: { deny: ['mcp__a__x', 'pwsh', 'run_code'] }, mcp: { off: ['srv'] } }, saveEnv)
check('scene.save: stores a normalized scene and drops reserved names',
  saved.scene.name === 'work' && equal(stateA.scenes.work.tools.deny, ['mcp__a__x', 'pwsh']) && saved.scenes.includes('work'))

// ---- 2. apply / exit: intent first, rollback, incomplete --------------------

const rowsA = [{ id: 'row-srv', serverName: 'srv', disabled: false }]
const knownA = ['mcp__a__x', 'mcp__b__y', 'pwsh']
const applyEnvState = makeState({ toolDeny: ['mcp__old__z'], scenes: { work: stateA.scenes.work } })
const applyMcp = mcpPort(rowsA)
const applySurfacePort = surfacePort(knownA)
const applyEnv = makeEnv({ state: applyEnvState, services: { 'toolHub.mcp': applyMcp, 'toolHub.surface': applySurfacePort } })
const applied = await scenes.handlers['scene.apply']({ name: 'work' }, applyEnv)
check('scene.apply: records the intent before changing anything',
  readMode(applyEnvState) !== null && readMode(applyEnvState).name === 'work')
check('scene.apply: masks tools and switches the server off',
  equal(applyEnvState.toolDeny, ['mcp__a__x', 'pwsh']) && applyMcp.calls.some(call => call.id === 'row-srv' && call.enabled === false))
check('scene.apply: exactly one restrict for the tool domain', applySurfacePort.calls.length === 1)
check('scene.apply: reports applied targets and no warning',
  applied.applied.includes('tools') && applied.applied.includes('mcp:srv') && applied.warn === null)

const restoreEnvState = makeState({ toolDeny: ['mcp__old__z'], scenes: { work: stateA.scenes.work } })
const restoreMcp = mcpPort(rowsA)
restoreMcp.fail = (id, enabled) => enabled === false
const restoreEnv = makeEnv({ state: restoreEnvState, services: { 'toolHub.mcp': restoreMcp, 'toolHub.surface': surfacePort(knownA) } })
let applyFailure = null
try {
  await scenes.handlers['scene.apply']({ name: 'work' }, restoreEnv)
}
catch (error) {
  applyFailure = error
}
check('scene.apply: a failing server write throws scene-failed',
  applyFailure instanceof DomainFailure && applyFailure.code === 'scene-failed')
check('scene.apply: the rollback restores the original deny list',
  equal(restoreEnvState.toolDeny, ['mcp__old__z']))
check('scene.apply: a complete rollback is reported as complete',
  applyFailure.detail.rollback.ok === true && applyFailure.detail.rollback.incomplete.length === 0)
check('scene.apply: the intent record is cleared after a rollback', readMode(restoreEnvState) === null)

const halfEnvState = makeState({ toolDeny: ['mcp__old__z'], scenes: { work: stateA.scenes.work } })
const halfMcp = mcpPort(rowsA)
halfMcp.fail = () => true
const halfEnv = makeEnv({
  state: halfEnvState,
  services: { 'toolHub.mcp': halfMcp, 'toolHub.surface': surfacePort(knownA) },
  failSave: (reason, count) => reason === 'scene-tools' && count >= 2,
})
let halfFailure = null
try {
  await scenes.handlers['scene.apply']({ name: 'work' }, halfEnv)
}
catch (error) {
  halfFailure = error
}
check('scene.apply: a half-restored environment is not reported as restored',
  halfFailure instanceof DomainFailure && halfFailure.code === 'scene-failed' && halfFailure.detail.rollback.ok === false)
check('scene.apply: incomplete names the still-wrong targets',
  halfFailure.detail.rollback.incomplete.some(row => row.target === 'tools')
  && halfFailure.detail.rollback.message.includes('rollback incomplete'))
check('scene.apply: incomplete targets are exposed on the failure detail',
  Array.isArray(halfFailure.detail.incomplete) && halfFailure.detail.incomplete.length > 0)

const noMcpState = makeState({ toolDeny: ['mcp__old__z'], scenes: { work: stateA.scenes.work } })
const noMcpEnv = makeEnv({ state: noMcpState, services: { 'toolHub.surface': surfacePort(knownA) } })
const noMcpApplied = await scenes.handlers['scene.apply']({ name: 'work' }, noMcpEnv)
check('scene.apply: a host without an MCP patch reports the missing servers and still masks tools',
  noMcpApplied.warn !== null && noMcpApplied.missing.includes('srv') && equal(noMcpState.toolDeny, ['mcp__a__x', 'pwsh']))
const exitEnvState = makeState({ toolDeny: ['mcp__old__z'], scenes: { work: stateA.scenes.work } })
const exitMcp = mcpPort(rowsA)
const exitEnv = makeEnv({ state: exitEnvState, services: { 'toolHub.mcp': exitMcp, 'toolHub.surface': surfacePort(knownA) } })
await scenes.handlers['scene.apply']({ name: 'work' }, exitEnv)
exitMcp.calls.length = 0
const exited = await scenes.handlers['scene.exit']({}, exitEnv)
check('scene.exit: restores the snapshot deny list', equal(exitEnvState.toolDeny, ['mcp__old__z']))
check('scene.exit: re-enables the server row', exitMcp.calls.some(call => call.enabled === true))
check('scene.exit: clears the mode record', readMode(exitEnvState) === null)
const exitAgain = await scenes.handlers['scene.exit']({}, exitEnv)
check('scene.exit: is idempotent once nothing is active', exitAgain.restored === false)

const lateEnvState = makeState({ toolDeny: ['mcp__old__z'], scenes: { work: stateA.scenes.work } })
const lateMcp = mcpPort(rowsA)
const lateEnv = makeEnv({ state: lateEnvState, services: { 'toolHub.mcp': lateMcp, 'toolHub.surface': surfacePort(knownA) } })
await scenes.handlers['scene.apply']({ name: 'work' }, lateEnv)
lateMcp.fail = () => true
let exitFailure = null
try {
  await scenes.handlers['scene.exit']({}, lateEnv)
}
catch (error) {
  exitFailure = error
}
check('scene.exit: an incomplete restore throws scene-exit-failed',
  exitFailure instanceof DomainFailure && exitFailure.code === 'scene-exit-failed')
// The 1.x engine clears the intent record even when the restore is incomplete, so the
// incomplete report - not a retry - is the only truth after such a failure.
check('scene.exit: the engine clears the intent record after an incomplete restore',
  readMode(lateEnvState) === null)
check('scene.exit: incomplete names the server that stayed wrong',
  exitFailure.detail.rollback.incomplete.some(row => row.target === 'mcp:srv'))

// ---- 2b. scene v2: members, preset, delete, lock --------------------------

const v2Scene = engine.normalizeScene({ name: ' env ', plugins: [' a ', 'a', 'b', 7], skills: ['s1'], preset: '  daily ', locked: true })
check('engine v2: member sections are trimmed, deduplicated and string-only',
  equal(v2Scene.plugins, ['a', 'b']) && equal(v2Scene.skills, ['s1']) && v2Scene.preset === 'daily' && v2Scene.locked === true && v2Scene.version === 2,
  JSON.stringify(v2Scene))
check('engine v2: a non-array member section makes the whole record unusable',
  engine.normalizeScene({ name: 'x', plugins: 'a' }) === null && engine.normalizeScene({ name: 'x', skills: {} }) === null)
check('engine v2: a non-string preset is refused, an empty one means no binding',
  engine.normalizeScene({ name: 'x', preset: 5 }) === null && engine.normalizeScene({ name: 'x', preset: '   ' }).preset === undefined)
check('engine v2: locked is strict',
  engine.normalizeScene({ name: 'x', locked: 'true' }).locked === undefined && engine.normalizeScene({ name: 'x', locked: true }).locked === true)
check('engine v2: an over-long member id is dropped rather than truncated',
  equal(engine.normalizeScene({ name: 'x', plugins: ['p'.repeat(121), 'ok'] }).plugins, ['ok']))
check('engine v2: a version 1 record still reads',
  engine.normalizeScene({ version: 1, name: 'old', tools: { deny: [] } }).tools.deny.length === 0)

const v2Rows = [
  { kind: 'plugin', id: 'p-on', enabled: true },
  { kind: 'plugin', id: 'p-off', enabled: false },
  { kind: 'skill', id: 's-on', enabled: true },
  { kind: 'bogus', id: 'nope', enabled: true },
]
const v2Snapshot = engine.captureSnapshot({ toolDeny: [], sessions: { sub: ['mcp__a__1'] }, mcpRows: [], memberRows: v2Rows, at: 7 })
check('engine v2: the snapshot captures every member row, not only the ones a scene names',
  v2Snapshot.plugins['p-on'] === true && v2Snapshot.plugins['p-off'] === false && Object.keys(v2Snapshot.plugins).length === 2
  && equal(v2Snapshot.skills, { 's-on': true }), JSON.stringify(v2Snapshot))
check('engine v2: the snapshot keeps session overlays for the report only',
  equal(v2Snapshot.sessions, { sub: ['mcp__a__1'] }) && !('sessions' in engine.planFromSnapshot(v2Snapshot)))
const bareSnapshot = engine.captureSnapshot({ toolDeny: [], sessions: {}, mcpRows: [] })
check('engine v2: a snapshot taken without member rows omits the maps instead of claiming none',
  !('plugins' in bareSnapshot) && !('skills' in bareSnapshot) && engine.planFromSnapshot(bareSnapshot).plugins.length === 0)
check('engine v2: no member map means no missing claim for a listed member',
  !engine.planFromScene(engine.normalizeScene({ name: 'x', plugins: ['ghost'] }), bareSnapshot).missing.includes('plugin:ghost'))

const v2MemberScene = engine.normalizeScene({ name: 'members', plugins: ['p-on', 'ghost'], skills: ['s-on'] })
const v2MemberPlan = engine.planFromScene(v2MemberScene, v2Snapshot, { memberPlan: { plugin: [{ id: 'p-off', enabled: false }], skill: [] } })
check('engine v2: an absent member section plans no change',
  engine.planFromScene(engine.normalizeScene({ name: 'bare' }), v2Snapshot).plugins === null)
check('engine v2: an empty member section plans a change with no items',
  equal(engine.planFromScene(engine.normalizeScene({ name: 'clear', plugins: [] }), v2Snapshot).plugins, []))
check('engine v2: the caller-planned items are the plugin plan', equal(v2MemberPlan.plugins, [{ id: 'p-off', enabled: false }]))
check('engine v2: a listed member the snapshot does not know is reported missing, the rest still plans',
  v2MemberPlan.missing.join(',') === 'plugin:ghost', JSON.stringify(v2MemberPlan.missing))
const v2PresetScene = engine.normalizeScene({ name: 'p', preset: 'daily', plugins: [], tools: { deny: [] } })
const v2PresetPlan = engine.planFromScene(v2PresetScene, v2Snapshot)
check('engine v2: the bound preset is reported with the sections that override it',
  v2PresetPlan.preset === 'daily' && equal(v2PresetPlan.presetOverridden, ['plugins', 'tools']))
check('engine v2: a scene without a preset reports null and no override',
  engine.planFromScene(engine.normalizeScene({ name: 'x' }), v2Snapshot).preset === null)
check('engine v2: describePlan names members, the preset and the overrides',
  /plugins: 1 off/.test(engine.describePlan(v2MemberPlan)) && /preset: daily/.test(engine.describePlan(v2PresetPlan))
  && /overridden: plugins, tools/.test(engine.describePlan(v2PresetPlan)), engine.describePlan(v2PresetPlan))

const v2OrderCalls = []
const v2OrderIo = {
  writeMode() {},
  clearMode() {},
  setTools() { v2OrderCalls.push('tools') },
  setServer(entry) { v2OrderCalls.push('mcp:' + entry.serverName) },
  setMember(kind, id) { v2OrderCalls.push(kind + ':' + id) },
}
const v2OrderScene = engine.normalizeScene({ name: 'all', plugins: ['p-on'], skills: ['s-on'], tools: { deny: [] }, mcp: { off: ['srv'] } })
const v2OrderSnapshot = engine.captureSnapshot({ toolDeny: ['mcp__x__1'], sessions: {}, mcpRows: [{ id: 'row-srv', serverName: 'srv', disabled: false }], memberRows: v2Rows })
const v2OrderRun = await engine.runScene({ scene: v2OrderScene, snapshot: v2OrderSnapshot, io: v2OrderIo, memberPlan: { plugin: [{ id: 'p-off', enabled: false }], skill: [{ id: 's-on', enabled: true }] } })
check('engine v2: the apply order is plugins, skills, tools, then MCP',
  equal(v2OrderCalls, ['plugin:p-off', 'skill:s-on', 'tools', 'mcp:srv']), JSON.stringify(v2OrderCalls))
check('engine v2: the applied report uses the same order', equal(v2OrderRun.applied, v2OrderCalls))

const v2RestoreCalls = []
const v2RestoreIo = {
  setTools() { v2RestoreCalls.push('tools') },
  setServer(entry) { v2RestoreCalls.push('mcp:' + entry.serverName) },
  setMember(kind, id, enabled) {
    v2RestoreCalls.push(kind + ':' + id + ':' + String(enabled))
    return id === 'gone' ? { skipped: true } : undefined
  },
}
const v2RestoreSnapshot = engine.captureSnapshot({ toolDeny: [], sessions: { s1: ['mcp__a__1'] }, mcpRows: [{ id: 'row-srv', serverName: 'srv', disabled: true }], memberRows: [{ kind: 'skill', id: 's-on', enabled: true }, { kind: 'plugin', id: 'gone', enabled: true }, { kind: 'plugin', id: 'p-off', enabled: false }] })
const v2RestoreReport = await engine.restoreSnapshot(v2RestoreSnapshot, v2RestoreIo)
check('engine v2: the restore order is plugins, skills, tools, then MCP',
  equal(v2RestoreCalls, ['plugin:gone:true', 'plugin:p-off:false', 'skill:s-on:true', 'tools', 'mcp:srv']), JSON.stringify(v2RestoreCalls))
check('engine v2: a vanished row is reported as skipped, not as a failure',
  v2RestoreReport.ok === true && v2RestoreReport.restored.includes('plugin:gone (skipped)'), JSON.stringify(v2RestoreReport))
check('engine v2: a restore never asks for a session write', !v2RestoreCalls.some(target => target.startsWith('session')))

const dailyPreset = { name: 'daily', enabled: { plugin: ['p1'], skill: [], tool: [] }, toolDeny: [], note: '', createdAt: 0 }
const v2RowsLive = [
  { kind: 'plugin', id: 'p1', enabled: true, manageable: true, moduleName: 'p1' },
  { kind: 'plugin', id: 'p2', enabled: true, manageable: true, moduleName: 'p2' },
  { kind: 'skill', id: 's1', enabled: true },
]

const saveLockState = makeState({ scenes: { work: { name: 'work', plugins: ['p1'], locked: true } } })
const saveLockEnv = makeEnv({ state: saveLockState })
const savedIgnoring = await scenes.handlers['scene.save']({ name: 'work', plugins: ['p2'], locked: false }, saveLockEnv)
check('scene.save: a lock survives a save and the field is reported ignored',
  equal(savedIgnoring.ignored, ['locked']) && saveLockState.scenes.work.locked === true && equal(savedIgnoring.scene.plugins, ['p2']))
const freshState = makeState()
const freshSaved = await scenes.handlers['scene.save']({ name: 'fresh', plugins: [], preset: 'daily' }, makeEnv({ state: freshState }))
check('scene.save: member sections and a preset round-trip',
  equal(freshSaved.scene.plugins, []) && freshSaved.scene.preset === 'daily' && freshState.scenes.fresh.preset === 'daily')

const v2PlanState = makeState({ scenes: { work: { name: 'work', preset: 'daily', plugins: ['p1'], tools: { deny: [] } } }, presets: [dailyPreset] })
const v2PlanEnv = makeEnv({ state: v2PlanState, services: { 'toolHub.members': memberPort(v2RowsLive) } })
const v2PlanReply = await scenes.handlers['scene.plan']({ name: 'work' }, v2PlanEnv)
check('scene.plan: reports the bound preset and the sections that override it',
  v2PlanReply.preset === 'daily' && equal(v2PlanReply.presetOverridden, ['plugins', 'tools']))
check('scene.plan: the description carries the preset', /preset: daily/.test(v2PlanReply.description), v2PlanReply.description)
check('scene.plan: the member plan turns the unlisted plugin off',
  v2PlanReply.plan.plugins.some(item => item.id === 'p2' && item.enabled === false), JSON.stringify(v2PlanReply.plan.plugins))

const v2ApplyState = makeState({ scenes: { work: { name: 'work', plugins: ['p1'], preset: 'daily' } }, presets: [dailyPreset] })
const v2ApplyMembers = memberPort(v2RowsLive)
const v2ApplyEnv = makeEnv({ state: v2ApplyState, services: { 'toolHub.members': v2ApplyMembers, 'toolHub.surface': surfacePort(['mcp__a__1']) } })
const v2Applied = await scenes.handlers['scene.apply']({ name: 'work' }, v2ApplyEnv)
check('scene.apply: the bound preset runs first and reports what it did',
  v2Applied.preset !== null && v2Applied.preset.name === 'daily' && v2Applied.preset.ok === true, JSON.stringify(v2Applied.preset))
check('scene.apply: member rows are switched after the preset',
  v2ApplyMembers.enabledCalls.some(call => call.id === 'p2' && call.enabled === false)
  && v2Applied.applied.includes('plugin:p2'), JSON.stringify(v2Applied.applied))
check('scene.apply: the intent record carries the member rows for the exit',
  Object.keys(readMode(v2ApplyState).snapshot.plugins).length === 2)

const v2ExitMembers = memberPort(v2RowsLive)
const v2ExitEnv = makeEnv({ state: v2ApplyState, services: { 'toolHub.members': v2ExitMembers, 'toolHub.surface': surfacePort(['mcp__a__1']) } })
const v2Exited = await scenes.handlers['scene.exit']({}, v2ExitEnv)
check('scene.exit: restores every member row and says sessions are not part of a scene',
  v2Exited.note === 'session overlays are not part of a scene'
  && v2ExitMembers.enabledCalls.some(call => call.id === 'p2' && call.enabled === true)
  && readMode(v2ApplyState) === null, JSON.stringify(v2ExitMembers.enabledCalls))

const vanishState = makeState({ scenes: { work: { name: 'work', skills: [] } } })
const vanishApplyPort = memberPort([
  { kind: 'plugin', id: 'p1', enabled: true, manageable: true, moduleName: 'p1' },
  { kind: 'skill', id: 's1', enabled: true },
])
const vanishApplyEnv = makeEnv({ state: vanishState, services: { 'toolHub.members': vanishApplyPort, 'toolHub.surface': surfacePort([]) } })
await scenes.handlers['scene.apply']({ name: 'work' }, vanishApplyEnv)
const vanishExitEnv = makeEnv({
  state: vanishState,
  services: {
    'toolHub.members': {
      rows: () => [{ kind: 'plugin', id: 'p1', enabled: true, manageable: true, moduleName: 'p1' }],
      setEnabled(kind, id) {
        if (kind === 'skill' && id === 's1') return { ok: false, code: 'unknown-skill', message: 'no skill folder answers to s1' }
        return { ok: true }
      },
    },
    'toolHub.surface': surfacePort([]),
  },
})
const vanishExited = await scenes.handlers['scene.exit']({}, vanishExitEnv)
check('scene.exit: a member row that vanished while the scene was active is skipped, not a failure',
  vanishExited.ok === true && vanishExited.targets.includes('skill:s1 (skipped)'), JSON.stringify(vanishExited.targets))

const missingPresetState = makeState({ scenes: { work: { name: 'work', preset: 'gone' } } })
const missingPresetEnv = makeEnv({ state: missingPresetState, services: { 'toolHub.members': memberPort([]), 'toolHub.surface': surfacePort([]) } })
const missingPresetApplied = await scenes.handlers['scene.apply']({ name: 'work' }, missingPresetEnv)
check('scene.apply: a preset that no longer exists is reported and the scene still applies',
  missingPresetApplied.ok === true && missingPresetApplied.missing.includes('preset:gone') && missingPresetApplied.preset.missing === true,
  JSON.stringify(missingPresetApplied.missing))

const deleteState = makeState({ scenes: { work: { name: 'work' }, other: { name: 'other' } }, mode: { name: 'work', snapshot: { at: 1, toolDeny: [], sessions: {}, mcp: {} } } })
const deleteEnv = makeEnv({ state: deleteState })
await expectFailure('scene.delete: the applied scene cannot be deleted',
  () => Promise.resolve().then(() => scenes.handlers['scene.delete']({ name: 'work' }, deleteEnv)), 'scene-active')
const deletedScene = await scenes.handlers['scene.delete']({ name: 'other' }, deleteEnv)
check('scene.delete: removes the archive, keeps the mode record and saves',
  deletedScene.deleted === 'other' && deleteState.scenes.other === undefined && deleteState.mode.name === 'work' && deleteEnv.saves.includes('scene-delete'))
await expectFailure('scene.delete: an unknown name is refused',
  () => Promise.resolve().then(() => scenes.handlers['scene.delete']({ name: 'ghost' }, deleteEnv)), 'unknown-scene')

const lockState = makeState({ scenes: { work: { name: 'work', version: 2, plugins: [] }, other: { name: 'other' } } })
const lockEnv = makeEnv({ state: lockState })
const lockedReply = await scenes.handlers['scene.lock']({ name: 'work', locked: true }, lockEnv)
check('scene.lock: sets the flag, reports the locked set and saves',
  lockedReply.locked === true && equal(lockedReply.lockedScenes, ['work']) && lockState.scenes.work.locked === true && lockEnv.saves.includes('scene-lock'))
check('scene.lock: leaves the rest of the archive alone', equal(lockState.scenes.work.plugins, []) && lockState.scenes.work.version === 2)
const unlockedReply = await scenes.handlers['scene.lock']({ name: 'work', locked: false }, lockEnv)
check('scene.lock: unlock removes the flag',
  unlockedReply.locked === false && lockState.scenes.work.locked === undefined && equal(unlockedReply.lockedScenes, []))
await expectFailure('scene.lock: a non-boolean is refused',
  () => Promise.resolve().then(() => scenes.handlers['scene.lock']({ name: 'work', locked: 'yes' }, lockEnv)), 'bad-payload')
await expectFailure('scene.lock: an unknown scene is refused',
  () => Promise.resolve().then(() => scenes.handlers['scene.lock']({ name: 'ghost', locked: true }, lockEnv)), 'unknown-scene')

const modeV2 = readMode(makeState({ mode: { version: 2, name: 'work', at: 9, snapshot: { at: 9, toolDeny: [], sessions: {}, mcp: {}, plugins: { p1: true, p2: false }, skills: { s1: true } } } }))
check('readMode: member maps survive the round trip',
  modeV2.snapshot.plugins['p1'] === true && modeV2.snapshot.plugins['p2'] === false && equal(modeV2.snapshot.skills, { s1: true }))
check('readMode: a version 1 record without member maps keeps them absent',
  readMode(makeState({ mode: { version: 1, name: 'old', at: 1, snapshot: { at: 1, toolDeny: [], sessions: {}, mcp: {} } } })).snapshot.plugins === undefined)

const brokenMembers = { rows() { throw new Error('catalog exploded') }, setEnabled() { return { ok: true } } }
const degradedState = makeState({ scenes: { work: { name: 'work', plugins: ['p1'], tools: { deny: [] } } } })
const degradedPlan = await scenes.handlers['scene.plan']({ name: 'work' }, makeEnv({ state: degradedState, services: { 'toolHub.members': brokenMembers } }))
check('scene.plan: an unreadable member catalog is reported, not called "missing"',
  degradedPlan.degraded !== null && /catalog exploded/.test(degradedPlan.degraded) && degradedPlan.missing.length === 0, JSON.stringify(degradedPlan))
const degradedApplyState = makeState({ scenes: { work: { name: 'work', plugins: ['p1'], tools: { deny: [] } } } })
const degradedApply = await scenes.handlers['scene.apply']({ name: 'work' }, makeEnv({ state: degradedApplyState, services: { 'toolHub.members': brokenMembers, 'toolHub.surface': surfacePort(['mcp__a__1']) } }))
check('scene.apply: a degraded member catalog is carried in the warning and the snapshot omits the maps',
  /member catalog unavailable/.test(String(degradedApply.warn)) && readMode(degradedApplyState).snapshot.plugins === undefined, JSON.stringify(degradedApply.warn))

// ---- 3. four sources, order, idempotent single restrict --------------------

const merged = mergeSurface({
  install: ['mcp__a__1'],
  session: ['mcp__s__2', 'mcp__a__1'],
  lazy: ['mcp__l__3'],
  onDemand: ['mcp__o__4', 'mcp__a__1', 'pwsh'],
})
check('surface: the merge order is install, session, lazy, onDemand',
  equal(SURFACE_SOURCES, ['install', 'session', 'lazy', 'onDemand']))
check('surface: every source contributes its own names',
  equal(merged.deny, ['mcp__a__1', 'mcp__l__3', 'mcp__o__4', 'mcp__s__2', 'pwsh'])
  && merged.counts.install === 1 && merged.counts.session === 1
  && merged.counts.lazy === 1 && merged.counts.onDemand === 2)
check('surface: a name denied twice belongs to the earliest source',
  merged.attributed.install.includes('mcp__a__1') && equal(merged.attributed.onDemand, ['mcp__o__4', 'pwsh']))
check('surface: a built-in tool name enters the mask like any other', merged.deny.includes('pwsh'))
check('surface: a reserved name is reported, never applied', (() => {
  const withReserved = mergeSurface({ install: ['run_code'] })
  return equal(withReserved.deny, []) && equal(withReserved.reserved, ['run_code'])
})())
check('surface: describe names the same order',
  describeSurface(merged) === 'deny: 5 (install 1 · session 1 · lazy 1 · onDemand 2)')
const knownFiltered = mergeSurface({ install: ['mcp__a__1', 'pwsh'], onDemand: ['mcp__o__4'], known: ['mcp__a__1'] })
check('surface: names the host cannot restrict are reported, not applied',
  equal(knownFiltered.deny, ['mcp__a__1']) && equal(knownFiltered.unreachable, ['mcp__o__4', 'pwsh']))
const plan = planSurface(['mcp__a__1'], mergeSurface({ install: ['mcp__a__1', 'mcp__s__2'] }))
check('surface: the plan separates add from unchanged',
  equal(plan.add, ['mcp__s__2']) && equal(plan.unchanged, ['mcp__a__1']) && plan.changed === true)

const idemState = makeState({ toolDeny: ['mcp__a__1'] })
const idemPort = surfacePort(knownA.concat('mcp__a__1', 'mcp__s__2', 'mcp__l__3'))
const idemServices = svc({ 'toolHub.surface': idemPort })
const firstPass = await applySurface({ state: idemState, services: idemServices })
const secondPass = await applySurface({ state: idemState, services: idemServices })
check('surface: one restrict per pass', idemPort.calls.length === 1)
check('surface: a repeated pass is a no-op',
  firstPass.status === 'applied' && secondPass.status === 'unchanged' && idemPort.calls.length === 1)
idemState.sessions.sub = ['mcp__s__2']
const lineageServices = svc({
  'toolHub.surface': idemPort,
  'toolHub.lineage': { parentOf: id => (id === 'child' ? 'sub' : undefined) },
})
const thirdPass = await applySurface({ state: idemState, services: lineageServices, sessionId: 'child' })
check('surface: a session overlay joins the same single restrict',
  thirdPass.status === 'applied' && idemPort.calls.length === 2 && idemPort.calls[1].includes('mcp__s__2'))
check('surface: a first pass for a new session installs without lifting anything', idemPort.lifted === 0)
idemState.sessions.sub.push('mcp__l__3')
const changedPass = await applySurface({ state: idemState, services: lineageServices, sessionId: 'child' })
check('surface: the previous restriction is lifted after the new one is installed',
  changedPass.status === 'applied' && idemPort.calls.length === 3 && idemPort.lifted === 1)
const fourthPass = await applySurface({ state: idemState, services: lineageServices, sessionId: 'child' })
check('surface: the same four sources are idempotent', fourthPass.status === 'unchanged' && idemPort.calls.length === 3)
const noPort = await applySurface({ state: makeState(), services: svc({}) })
check('surface: a missing host port degrades instead of throwing',
  noPort.ok === true && noPort.status === 'no-port' && noPort.masked === false)
const refusePort = surfacePort(knownA, { refuse: true })
const refused = await applySurface({ state: makeState({ toolDeny: ['mcp__a__x'] }), services: svc({ 'toolHub.surface': refusePort }) })
check('surface: a refused restrict is reported, not thrown',
  refused.ok === false && refused.status === 'refused')

const lazyState = makeState()
writeLazy(lazyState, { servers: ['srv', 'srv', 'bad name'], loaded: ['mcp__srv__a', 'plain'] })
check('lazy: the state key keeps valid servers and loaded MCP names',
  equal(readLazy(lazyState).servers, ['srv']) && equal(readLazy(lazyState).loaded, ['mcp__srv__a']))
const lazyKnown = ['mcp__srv__a', 'mcp__srv__b', 'mcp__other__c']
check('lazy: an unloaded tool of a lazy server stays hidden',
  equal(lazyDeny(readLazy(lazyState), lazyKnown), ['mcp__srv__b']))
changeLazy(lazyState, { names: ['mcp__srv__b'], load: true }, lazyKnown)
check('lazy: loading names makes them visible',
  equal(lazyDeny(readLazy(lazyState), lazyKnown), []))
check('lazy: the catalog prompt exists while a server is lazy',
  lazyPrompt(readLazy(lazyState), lazyKnown).includes('srv'))
changeLazy(lazyState, { server: 'srv' }, lazyKnown)
check('lazy: a server-only patch mirrors 1.x and turns lazy off', equal(readLazy(lazyState).servers, []))
check('lazy: leaving the lazy list clears that server\'s loaded names', equal(readLazy(lazyState).loaded, []))
const scoped = makeState()
changeLazy(scoped, { server: 'srv', on: true }, lazyKnown)
changeLazy(scoped, { names: ['mcp__srv__a'], load: true, sessionId: 's1' }, lazyKnown)
check('lazy: a session load is visible only in that session',
  equal(lazyDeny(readLazy(scoped), lazyKnown, 's1'), ['mcp__srv__b'])
  && equal(lazyDeny(readLazy(scoped), lazyKnown, 's2'), ['mcp__srv__a', 'mcp__srv__b']))
check('lazy: lazyReport counts session loads separately',
  lazyReport(readLazy(scoped), lazyKnown, 's1')[0].loaded === 1
  && lazyReport(readLazy(scoped), lazyKnown, 's2')[0].loaded === 0)
check('lazy: removing session loads clears the session key',
  changeLazy(scoped, { names: ['mcp__srv__a'], load: false, sessionId: 's1' }, lazyKnown) && readLazy(scoped).sessions.s1 === undefined)
changeLazy(scoped, { names: ['mcp__srv__a'], load: true, sessionId: 's1' }, lazyKnown)
check('lazy: clearSessionLazy drops that session only',
  clearSessionLazy(scoped, 's1') === true && readLazy(scoped).sessions.s1 === undefined && readLazy(scoped).servers.includes('srv'))
const aged = makeState()
changeLazy(aged, { server: 'srv', on: true }, lazyKnown, 1_000)
changeLazy(aged, { names: ['mcp__srv__a'], load: true }, lazyKnown, 1_000)
check('lazy: pruneLazy expires old loads and keeps fresh ones',
  pruneLazy(aged, 1_000 + 61 * 60_000, 60) === true
  && equal(readLazy(aged).loaded, [])
  && pruneLazy(aged, 1_000 + 61 * 60_000, 0) === false)
check('lazy: serverOf splits an MCP name and rejects the rest',
  serverOf('mcp__a__b') === 'a' && serverOf('plain') === null)

const toggleState = makeState({ toolDeny: ['mcp__a__1'] })
const toggleEnv = makeEnv({ state: toggleState, services: { 'toolHub.surface': surfacePort(['mcp__a__1', 'mcp__a__2']) } })
await toolSurfaceDomain().handlers['tool.toggle']({ name: 'mcp__a__1', enabled: false }, toggleEnv)
check('tool.toggle: disabling adds one name and re-applies the mask',
  equal(toggleState.toolDeny, ['mcp__a__1']) && toggleEnv.saves.includes('tool-toggle'))
await toolSurfaceDomain().handlers['tool.toggle']({ name: 'mcp__a__1', enabled: true }, toggleEnv)
check('tool.toggle: enabling removes that name only', equal(toggleState.toolDeny, []))
let reservedToggle = null
try { await toolSurfaceDomain().handlers['tool.toggle']({ name: 'run_code', enabled: false }, toggleEnv) } catch (error) { reservedToggle = error }
check('tool.toggle: reserved names are refused', reservedToggle?.code === 'reserved-tool')

// ---- 4. lineage: 8 levels, cycle-safe, union -------------------------------

const parents = new Map()
for (let index = 0; index < 12; index += 1) parents.set('s' + index, 's' + (index + 1))
const chain = lineageOf('s0', id => parents.get(id))
check('lineage: depth is capped at 8 including the session itself',
  chain.length === 8 && chain[0] === 's0' && chain[7] === 's7')
const cycle = new Map([['a', 'b'], ['b', 'c'], ['c', 'a']])
check('lineage: a cycle ends the walk', equal(lineageOf('a', id => cycle.get(id)), ['a', 'b', 'c']))
check('lineage: a self-parent cannot loop', equal(lineageOf('a', () => 'a'), ['a']))
check('lineage: an empty session id has no lineage', equal(lineageOf('  ', () => undefined), []))
const overlays = { s0: ['mcp__n__1'], s1: ['mcp__p__2', 'mcp__n__1'] }
check('lineage: overlays union nearest-first without duplicates',
  equal(overlayFor(['s0', 's1'], overlays), ['mcp__n__1', 'mcp__p__2']))

const sessions = sessionsDomain()
const sessionEnv = makeEnv({ state: makeState(), services: { 'toolHub.surface': surfacePort([]) } })
await sessions.handlers['session.set']({ sessionId: ' s1 ', names: ['mcp__a__1', 'pwsh', 'run_code', 'mcp__a__1'] }, sessionEnv)
check('session.set: keeps any maskable name, deduplicated, reserved names dropped',
  equal(sessionEnv.state.sessions.s1, ['mcp__a__1', 'pwsh']))
await sessions.handlers['session.set']({ sessionId: 's1', names: [] }, sessionEnv)
check('session.set: an empty list removes the entry', !('s1' in sessionEnv.state.sessions))
await sessions.handlers['session.set']({ sessionId: 's1', names: ['mcp__a__1'] }, sessionEnv)
const clearedSession = await sessions.handlers['session.clear']({ sessionId: 's1' }, sessionEnv)
check('session.clear: drops the overlay only', clearedSession.sessions.s1 === undefined)
await expectFailure('session.set: a missing session id is refused',
  () => Promise.resolve().then(() => sessions.handlers['session.set']({ names: [] }, sessionEnv)), 'bad-payload')

// ---- 5. groups and presets ------------------------------------------------

const rows = [
  { kind: 'plugin', id: 'pkg', enabled: true, root: 'pkg', moduleName: 'pkg' },
  { kind: 'plugin', id: 'pkg/sub', enabled: true, root: 'pkg', moduleName: 'pkg/sub' },
  { kind: 'plugin', id: 'other', enabled: true, root: 'other', moduleName: 'other' },
  { kind: 'skill', id: 'sk1', enabled: true },
]
check('groups: the known set is kind-prefixed',
  knownKeys(rows).has('plugin:pkg') && knownKeys(rows).has('skill:sk1'))
check('groups: a selected package expands to its whole tree',
  equal(expandBundles([{ kind: 'plugin', id: 'pkg' }], rows).map(member => member.id), ['pkg', 'pkg/sub']))
const normalized = normalizeGroups([
  { id: 'a1-x', name: '工具', role: 'official', auto: true, members: [{ kind: 'plugin', id: 'pkg' }] },
  { id: 'a2-y', name: '工具', role: 'official', auto: true, members: [{ kind: 'plugin', id: 'other' }] },
  { id: 'hand-1', name: '我的组', role: 'official', members: [{ kind: 'plugin', id: 'pkg' }] },
  { id: 'hand-2', name: '我的组', role: 'official', members: [{ kind: 'plugin', id: 'other' }] },
])
check('groups: generated buckets with the same role and name merge',
  normalized.length === 3 && normalized[0].members.length === 2)
check('groups: a hand-made group keeps its identity', normalized.filter(group => group.name === '我的组').length === 2)
const savedGroup = applyGroupSave([], {
  name: ' 工作  ',
  members: [{ kind: 'plugin', id: 'pkg' }, { kind: 'plugin', id: 'gone' }],
  tags: ['a', 'a', 'b'],
  onDemand: true,
}, { known: knownKeys(rows), rows, collections: normalizeCollections([]), now: 1 })
check('groups: save trims the name, drops unknown members and expands packages',
  savedGroup.group.name === '工作' && equal(savedGroup.group.members.map(m => m.id), ['pkg', 'pkg/sub']))
check('groups: tags are deduplicated in order', equal(savedGroup.group.tags, ['a', 'b']))
check('groups: the on-demand flag is recorded', savedGroup.group.onDemand === true)
const sharedGroups = normalizeGroups([
  { id: 'g1', name: 'A', members: [{ kind: 'plugin', id: 'pkg' }, { kind: 'plugin', id: 'other' }] },
  { id: 'g2', name: 'B', members: [{ kind: 'plugin', id: 'other' }] },
])
const sharedPlan = planGroupToggle(sharedGroups, 'g1', rows, true)
check('groups: skipShared keeps members another group also lists',
  sharedPlan.members.every(member => member.id !== 'other') && sharedPlan.skippedShared === 1)
const groupEnvState = makeState({ groups: [{ id: 'g1', name: 'A', members: [{ kind: 'plugin', id: 'pkg' }, { kind: 'skill', id: 'sk1' }] }] })
const groupPort = memberPort(rows)
const groupEnv = makeEnv({ state: groupEnvState, services: { 'toolHub.members': groupPort } })
const toggleResult = await groupsDomain().handlers['group.toggle']({ id: 'g1', enabled: false }, groupEnv)
check('group.toggle: expands packages and switches every member',
  toggleResult.requested === 3 && toggleResult.changed === 3 && groupPort.enabledCalls.length === 3)
check('group.toggle: the flip direction is carried through',
  groupPort.enabledCalls.every(call => call.enabled === false))
const withDrawer = normalizeCollections([{ id: 'c1', name: '抽屉', order: 1 }])
const collections = applyCollectionDelete(withDrawer, normalizeGroups([{ id: 'g1', name: 'A', role: 'mcp', collection: 'c1' }]), 'c1')
check('collection.delete: groups in a removed drawer fall back to default',
  collections.groups[0].collection === 'default')
const bareEnvState = makeState({ groups: [{ id: 'g1', name: 'A', members: [{ kind: 'plugin', id: 'pkg' }] }] })
const bareEnv = makeEnv({ state: bareEnvState })
const bareToggle = await groupsDomain().handlers['group.toggle']({ id: 'g1', enabled: false }, bareEnv)
check('groups: a host without a manager reports per-member refusals instead of crashing',
  bareToggle.requested === 1 && bareToggle.changed === 0 && bareToggle.results[0].ok === false)
await expectFailure('collection.delete: the default drawer cannot be removed',
  () => Promise.resolve().then(() => applyCollectionDelete(withDrawer, [], 'default')), 'default-collection')

const recordedPreset = {
  name: 'p',
  enabled: { plugin: ['pkg'], skill: [], tool: ['mcp__a__1'] },
  toolDeny: ['mcp__a__2'],
  note: '',
  createdAt: 0,
}
check('presets: the recorded deny list wins over the live complement',
  equal(resolvePresetTools(recordedPreset, 'exact', [], ['mcp__a__1', 'mcp__a__2']),
    { kind: 'deny', source: 'recorded', deny: ['mcp__a__2'] }))
check('presets: only-enable keeps the current deny list minus the wanted tools',
  equal(resolvePresetTools(recordedPreset, 'only-enable', ['mcp__a__1', 'mcp__x__9'], []).deny, ['mcp__x__9']))
check('presets: a legacy preset falls back to the live complement',
  resolvePresetTools({ name: 'old', enabled: { plugin: [], skill: [], tool: ['mcp__a__1'] }, note: '', createdAt: 0 },
    'exact', [], ['mcp__a__1', 'mcp__b__2']).source === 'live')
check('presets: a legacy preset with nothing live is deferred, not guessed',
  resolvePresetTools({ name: 'old', enabled: { plugin: [], skill: [], tool: ['mcp__a__1'] }, note: '', createdAt: 0 },
    'exact', [], []).kind === 'deferred')
check('presets: a preset with no tool dimension leaves masking alone',
  resolvePresetTools({ name: 'none', enabled: { plugin: [], skill: [], tool: [] }, note: '', createdAt: 0 },
    'exact', ['mcp__x__9'], ['mcp__x__9']).kind === 'leave')
const presetRows = [
  { kind: 'plugin', id: 'p1', enabled: false, manageable: true, moduleName: 'p1' },
  { kind: 'plugin', id: 'p2', enabled: true, manageable: true, moduleName: 'p2' },
  { kind: 'plugin', id: 'self', enabled: true, manageable: true, moduleName: 'dsh-tool-hub' },
  { kind: 'skill', id: 's1', enabled: true },
]
const presetRecord = normalizePresets([{ name: 'x', enabled: { plugin: ['p1'], skill: [], tool: [] } }])[0]
const exactPlan = planPresetApply(presetRecord, presetRows, 'exact')
const enablePlan = planPresetApply(presetRecord, presetRows, 'only-enable')
check('presets: exact flips both directions and never touches the panel itself',
  exactPlan.length === 3 && exactPlan.every(item => item.id !== 'self'))
check('presets: only-enable never turns anything off',
  enablePlan.length === 1 && enablePlan[0].id === 'p1' && enablePlan[0].enabled === true)
check('presets: normalization deduplicates by name and keeps the deny list filtered',
  normalizePresets([
    { name: 'a', enabled: { plugin: ['p1', 'p1'] }, toolDeny: ['mcp__a__1', 'plain'] },
    { name: 'a', enabled: { plugin: ['p2'] } },
  ]).length === 1
  && equal(normalizePresets([{ name: 'a', enabled: {}, toolDeny: ['mcp__a__1', 'plain'] }])[0].toolDeny, ['mcp__a__1']))
const presetEnvState = makeState({
  toolDeny: ['mcp__old__1'],
  presets: [{ name: 'restore', enabled: { plugin: ['p1'], skill: [], tool: ['mcp__a__1'] }, toolDeny: ['mcp__a__2'], note: '', createdAt: 0 }],
})
const presetMemberPort = memberPort(presetRows)
const presetSurface = surfacePort(['mcp__a__1', 'mcp__a__2', 'mcp__old__1'])
const presetEnv = makeEnv({ state: presetEnvState, services: { 'toolHub.members': presetMemberPort, 'toolHub.surface': presetSurface } })
const presetApplied = await presetsDomain().handlers['preset.apply']({ name: 'restore', mode: 'exact' }, presetEnv)
check('preset.apply: switches the members the preset lists',
  presetApplied.requested === 3 && presetApplied.applied === 3
  && presetMemberPort.enabledCalls.some(call => call.id === 'p2' && call.enabled === false))
check('preset.apply: the recorded deny list becomes the installation list',
  equal(presetEnvState.toolDeny, ['mcp__a__2']) && presetSurface.calls.length === 1)
const legacyEnvState = makeState({
  presets: [{ name: 'legacy', enabled: { plugin: [], skill: [], tool: ['mcp__a__1'] }, note: '', createdAt: 0 }],
})
const legacyEnv = makeEnv({ state: legacyEnvState, services: { 'toolHub.members': memberPort([]), 'toolHub.surface': surfacePort([]) } })
const legacyApplied = await presetsDomain().handlers['preset.apply']({ name: 'legacy', mode: 'exact' }, legacyEnv)
check('preset.apply: a legacy tool dimension is reported as deferred with a retry hint',
  legacyApplied.tools.decision === 'deferred' && legacyApplied.tools.retryAfterMs === 1500
  && equal(legacyEnvState.toolDeny, []))
await expectFailure('preset.apply: an unknown preset is refused',
  () => Promise.resolve().then(() => presetsDomain().handlers['preset.apply']({ name: 'nope' }, legacyEnv)), 'no-preset')

// ---- 6. module shape ------------------------------------------------------

const modules = [
  ['scenes', scenesDomain(), 'scenes'],
  ['tool-surface', toolSurfaceDomain(), 'tool-surface'],
  ['sessions', sessionsDomain(), 'sessions'],
  ['groups', groupsDomain(), 'groups'],
  ['presets', presetsDomain(), 'presets'],
]
check('modules: every factory reports one module', modules.length === 5)
const allOpIds = []
for (const [label, registration, id] of modules) {
  if (registration === undefined) {
    check('modules: ' + label + ' registration exists', false)
    continue
  }
  const declared = registration.module.ops.map(op => op.id)
  const handled = Object.keys(registration.handlers).sort()
  check('modules: ' + label + ' uses its own module id', registration.module.id === id)
  check('modules: ' + label + ' declares and handles the same ops', equal(declared.slice().sort(), handled))
  for (const opId of declared) allOpIds.push(opId)
}
check('modules: op ids are unique across the five domains', new Set(allOpIds).size === allOpIds.length)
check('modules: 1.x op ids kept', ['scene.save', 'scene.apply', 'scene.exit', 'tool.save', 'tool.import',
  'lazy.set', 'lazy.load', 'lazy.unload', 'session.set', 'session.clear', 'group.save', 'group.toggle',
  'group.reorder', 'group.move', 'group.clean', 'group.add', 'group.remove', 'collection.save',
  'collection.delete', 'preset.save', 'preset.update', 'preset.delete', 'preset.apply']
  .every(opId => allOpIds.includes(opId)))
check('modules: 2.x scene ops are declared', ['scene.delete', 'scene.lock'].every(opId => allOpIds.includes(opId)))

// ---- report ---------------------------------------------------------------

console.log('')
// ---- 7. preset tool policy (G11a) -----------------------------------------

const { policyIssues, projectPolicy } = await import(pathToFileURL(join(distRoot, 'domains', 'preset-policy.js')).href)

check('preset.policy: a saved policy reads back identically',
  await (async () => {
    const state = makeState({ presets: [{ name: 'p', enabled: { plugin: [], skill: [], tool: [] }, note: '', createdAt: 1 }] })
    const env = makeEnv({ state, services: { 'toolHub.members': memberPort([]), 'toolHub.surface': surfacePort(['mcp__a__1', 'mcp__b__1']) } })
    await presetsDomain().handlers['preset.policy']({
      name: 'p',
      toolPolicy: { disabled: ['mcp__b__1'], groups: [{ name: 'g', patterns: ['mcp__a__1'] }] },
    }, env)
    const read = await presetsDomain().handlers['preset.policy']({ name: 'p' }, makeEnv({ state, services: {} }))
    return equal(read.toolPolicy, { disabled: ['mcp__b__1'], groups: [{ name: 'g', patterns: ['mcp__a__1'] }] })
      && env.saves.length === 1 && env.saves[0] === 'preset-policy'
  })())
const policyEnvState = makeState({
  presets: [{ name: 'p2', enabled: { plugin: [], skill: [], tool: [] }, note: '', createdAt: 1, updatedAt: 77 }],
})
const policyEnv = makeEnv({ state: policyEnvState, services: { 'toolHub.members': memberPort([]), 'toolHub.surface': surfacePort(['mcp__a__1']) } })
await expectFailure('preset.policy: an empty group name is refused',
  () => presetsDomain().handlers['preset.policy']({ name: 'p2', toolPolicy: { disabled: [], groups: [{ name: ' ', patterns: ['mcp__a__1'] }] } }, policyEnv), 'empty-group')
await expectFailure('preset.policy: a group without patterns is refused',
  () => presetsDomain().handlers['preset.policy']({ name: 'p2', toolPolicy: { disabled: [], groups: [{ name: 'g', patterns: [] }] } }, policyEnv), 'empty-group')
await expectFailure('preset.policy: a stale expect.updatedAt is refused',
  () => presetsDomain().handlers['preset.policy']({ name: 'p2', toolPolicy: { disabled: [], groups: [] }, expect: { updatedAt: 76 } }, policyEnv), 'stale-preset')
check('preset.policy: a refused save changes nothing',
  policyEnv.saves.length === 0 && policyEnvState.presets[0].toolPolicy === undefined)

const copySourceState = makeState({
  presets: [
    { name: 'src', enabled: { plugin: [], skill: [], tool: ['mcp__a__1'] }, note: '', createdAt: 1,
      toolPolicy: { disabled: ['mcp__a__1', 'mcp__gone__1'], groups: [{ name: 'a', patterns: ['mcp__a__*'] }, { name: 'gone', patterns: ['mcp__gone__*'] }] } },
    { name: 'dst', enabled: { plugin: [], skill: [], tool: [] }, note: '', createdAt: 2 },
  ],
})
const copySourceEnv = makeEnv({ state: copySourceState, services: { 'toolHub.members': memberPort([]), 'toolHub.surface': surfacePort(['mcp__a__1']) } })
const projected = await presetsDomain().handlers['preset.copy']({ from: 'src', to: ['dst'], what: 'policy' }, copySourceEnv)
check('preset.copy: the projection shrinks to the target catalog and names the dropped group',
  projected.copied.length === 1 && projected.copied[0].disabled === 1 && projected.copied[0].groups === 1
  && equal(projected.copied[0].skippedGroups, ['gone'])
  && equal(copySourceState.presets[1].toolPolicy.groups.map(group => group.name), ['a']))
check('preset.copy: the copy is backed up once',
  equal(copySourceEnv.saves, ['preset-copy']))
check('preset.copy whole: a missing target is created from the source',
  await (async () => {
    const state = makeState({ presets: [{ name: 'src', enabled: { plugin: ['p1'], skill: [], tool: [] }, toolDeny: ['mcp__a__1'], note: 'n', createdAt: 1 }] })
    const env = makeEnv({ state, services: { 'toolHub.members': memberPort([]), 'toolHub.surface': surfacePort([]) } })
    await presetsDomain().handlers['preset.copy']({ from: 'src', to: ['fresh'], what: 'whole' }, env)
    const fresh = state.presets.find(preset => preset.name === 'fresh')
    return fresh !== undefined && equal(fresh.enabled.plugin, ['p1']) && equal(fresh.toolDeny, ['mcp__a__1']) && fresh.note === 'n'
  })())

const resetPolicyState = makeState({
  presets: [{ name: 'r', enabled: { plugin: ['p1'], skill: [], tool: [] }, toolDeny: ['mcp__a__1'], note: '', createdAt: 1,
    toolPolicy: { disabled: ['mcp__a__1'], groups: [{ name: 'g', patterns: ['mcp__a__1'] }] } }],
})
const resetPolicyEnv = makeEnv({ state: resetPolicyState, services: { 'toolHub.members': memberPort([]), 'toolHub.surface': surfacePort([]) } })
await presetsDomain().handlers['preset.policyReset']({ name: 'r' }, resetPolicyEnv)
check('preset.policyReset: clears the policy and leaves plugins, skills and the deny list alone',
  equal(resetPolicyState.presets[0].toolPolicy, { disabled: [], groups: [] })
  && equal(resetPolicyState.presets[0].enabled.plugin, ['p1'])
  && equal(resetPolicyState.presets[0].toolDeny, ['mcp__a__1'])
  && equal(resetPolicyEnv.saves, ['preset-policy-reset']))

const policyApplyState = makeState({
  toolDeny: ['mcp__b__1'],
  presets: [{ name: 'mask', enabled: { plugin: [], skill: [], tool: ['mcp__a__1'] }, toolDeny: ['mcp__a__1'], note: '', createdAt: 1,
    toolPolicy: { disabled: ['mcp__a__1'], groups: [{ name: 'g', patterns: ['mcp__a__1'] }] } }],
})
const policyApplyEnv = makeEnv({ state: policyApplyState, services: { 'toolHub.members': memberPort([]), 'toolHub.surface': surfacePort(['mcp__a__1', 'mcp__b__1']) } })
const policyApplied = await presetsDomain().handlers['preset.apply']({ name: 'mask', mode: 'exact' }, policyApplyEnv)
check('preset.apply: a policy wins over the recorded deny list and says so',
  equal(policyApplyState.toolDeny, ['mcp__a__1']) && policyApplied.tools.source === 'policy')
check('preset.apply: the receipt counts the policy',
  equal(policyApplied.tools.policy, { disabled: 1, groups: 1 }))
check('preset.apply: the derived enabled.tool view follows the policy',
  equal(policyApplyState.presets[0].enabled.tool, ['mcp__b__1']))
check('preset.apply: groups are recorded but not part of the deny list yet',
  equal(resolvePresetTools({ toolPolicy: { disabled: [], groups: [{ name: 'g', patterns: ['mcp__a__1'] }] }, enabled: { plugin: [], skill: [], tool: [] } }, 'exact', [], []),
    { kind: 'deny', source: 'policy', deny: [] }))
check('preset policy: the diagnostics and projection agree on group ownership',
  policyIssues({ disabled: [], groups: [{ name: 'a', patterns: ['mcp__*'] }, { name: 'b', patterns: ['mcp__a__1'] }] }, ['mcp__a__1']).duplicateMembers.length === 1
  && projectPolicy({ disabled: [], groups: [{ name: 'a', patterns: ['mcp__*'] }, { name: 'b', patterns: ['mcp__a__1'] }] }, ['mcp__a__1']).skippedGroups.length === 1)
check('preset policy: normalizePresets keeps a policy and never invents one',
  normalizePresets([{ name: 'k', enabled: {}, toolPolicy: { disabled: ['mcp__a__1'], groups: [] } }])[0].toolPolicy !== undefined
  && normalizePresets([{ name: 'k', enabled: {} }])[0].toolPolicy === undefined)

console.log('domain-workflows probe: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  console.log('failed: ' + failures.join('; '))
  process.exit(1)
}