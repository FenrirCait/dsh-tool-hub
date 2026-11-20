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
import {
  DomainFailure,
  SURFACE_SOURCES,
  applySurface,
  changeLazy,
  describeSurface,
  lazyDeny,
  lazyPrompt,
  mergeSurface,
  planSurface,
  readLazy,
  serverOf,
  writeLazy,
  toolSurfaceDomain,
} from '../../dist/domains/tool-surface.js'
import { readMode, scenesDomain } from '../../dist/domains/scenes.js'
import { lineageOf, overlayFor, sessionsDomain } from '../../dist/domains/sessions.js'
import {
  applyCollectionDelete,
  applyGroupSave,
  expandBundles,
  groupsDomain,
  knownKeys,
  normalizeCollections,
  normalizeGroups,
  planGroupToggle,
} from '../../dist/domains/groups.js'
import { normalizePresets, planPresetApply, presetsDomain, resolvePresetTools } from '../../dist/domains/presets.js'
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
    onDemandTools: () => (config.onDemand || []).slice(),
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
const saved = await scenes.handlers['scene.save']({ name: 'work', tools: { deny: ['mcp__a__x', 'not-mcp'] }, mcp: { off: ['srv'] } }, saveEnv)
check('scene.save: stores a normalized scene and filters the deny list',
  saved.scene.name === 'work' && equal(stateA.scenes.work.tools.deny, ['mcp__a__x']) && saved.scenes.includes('work'))

// ---- 2. apply / exit: intent first, rollback, incomplete --------------------

const rowsA = [{ id: 'row-srv', serverName: 'srv', disabled: false }]
const knownA = ['mcp__a__x', 'mcp__b__y']
const applyEnvState = makeState({ toolDeny: ['mcp__old__z'], scenes: { work: stateA.scenes.work } })
const applyMcp = mcpPort(rowsA)
const applySurfacePort = surfacePort(knownA)
const applyEnv = makeEnv({ state: applyEnvState, services: { 'toolHub.mcp': applyMcp, 'toolHub.surface': applySurfacePort } })
const applied = await scenes.handlers['scene.apply']({ name: 'work' }, applyEnv)
check('scene.apply: records the intent before changing anything',
  readMode(applyEnvState) !== null && readMode(applyEnvState).name === 'work')
check('scene.apply: masks tools and switches the server off',
  equal(applyEnvState.toolDeny, ['mcp__a__x']) && applyMcp.calls.some(call => call.id === 'row-srv' && call.enabled === false))
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
  noMcpApplied.warn !== null && noMcpApplied.missing.includes('srv') && equal(noMcpState.toolDeny, ['mcp__a__x']))
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

// ---- 3. four sources, order, idempotent single restrict --------------------

const merged = mergeSurface({
  install: ['mcp__a__1'],
  session: ['mcp__s__2', 'mcp__a__1', 'plain-name'],
  lazy: ['mcp__l__3'],
  onDemand: ['mcp__o__4', 'mcp__a__1'],
})
check('surface: the merge order is install, session, lazy, onDemand',
  equal(SURFACE_SOURCES, ['install', 'session', 'lazy', 'onDemand']))
check('surface: every source contributes its own names',
  equal(merged.deny, ['mcp__a__1', 'mcp__l__3', 'mcp__o__4', 'mcp__s__2'])
  && merged.counts.install === 1 && merged.counts.session === 1
  && merged.counts.lazy === 1 && merged.counts.onDemand === 1)
check('surface: a name denied twice belongs to the earliest source',
  merged.attributed.install.includes('mcp__a__1') && equal(merged.attributed.onDemand, ['mcp__o__4']))
check('surface: non-MCP names never enter the mask', !merged.deny.includes('plain-name'))
check('surface: describe names the same order',
  describeSurface(merged) === 'deny: 4 (install 1 · session 1 · lazy 1 · onDemand 1)')
const knownFiltered = mergeSurface({ install: ['mcp__a__1'], onDemand: ['mcp__o__4'], known: ['mcp__a__1'] })
check('surface: names the host cannot restrict are reported, not applied',
  equal(knownFiltered.deny, ['mcp__a__1']) && equal(knownFiltered.unreachable, ['mcp__o__4']))
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
check('lazy: serverOf splits an MCP name and rejects the rest',
  serverOf('mcp__a__b') === 'a' && serverOf('plain') === null)

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
await sessions.handlers['session.set']({ sessionId: ' s1 ', names: ['mcp__a__1', 'plain', 'mcp__a__1'] }, sessionEnv)
check('session.set: keeps only MCP names, deduplicated',
  equal(sessionEnv.state.sessions.s1, ['mcp__a__1']))
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

// ---- report ---------------------------------------------------------------

console.log('')
console.log('domain-workflows probe: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  console.log('failed: ' + failures.join('; '))
  process.exit(1)
}
