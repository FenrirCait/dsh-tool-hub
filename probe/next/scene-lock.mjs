#!/usr/bin/env node
/**
 * probe/next/scene-lock.mjs - the scene lock, checked from outside through the dispatcher.
 *
 * A lock has exactly one job: refuse the ops that would change the environment a locked scene
 * describes, and let everything else through. That makes it a table-shaped feature, so the probe
 * is table-shaped too:
 *
 *   1. scope: the freeze table is the designed one, and the ops it names are unique to it;
 *   2. refusal: every 'all' op throws scene-locked, with a message that states the fact and
 *      never points at the UI (the reader can be a model, which has no pointer);
 *   3. the allowed set: scene.lock, session.*, settings.set, scene.plan and the reads still pass,
 *      because unlocking has to stay reachable or a lock is a deadlock;
 *   4. per-scene scopes: scene.save/scene.delete only refuse their own locked scene;
 *      scene.apply refuses switching away but allows a re-submit; scene.exit refuses;
 *   5. no lock: nothing is refused at all.
 *
 * No third-party libraries. Run 'npm run build:host' (or an out-of-tree emit) first: the 2.x
 * sources are TypeScript and this probe imports dist/.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The built host, or a copy when TOOL_HUB_DIST points at one (same override as tool-mask.mjs).
const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const dist = (...parts) => pathToFileURL(join(distRoot, ...parts)).href

let FROZEN_OPS
let frozenRejection
let lockedSceneNames
let activeSceneName
let Dispatcher
let Failure
let Registry
let scenesDomain
try {
  const lock = await import(dist('domains', 'scene-lock.js'))
  FROZEN_OPS = lock.FROZEN_OPS
  frozenRejection = lock.frozenRejection
  lockedSceneNames = lock.lockedSceneNames
  activeSceneName = lock.activeSceneName
  const dispatch = await import(dist('host', 'dispatch.js'))
  Dispatcher = dispatch.Dispatcher
  Failure = dispatch.Failure
  Registry = (await import(dist('core', 'registry.js'))).Registry
  scenesDomain = (await import(dist('domains', 'scenes.js'))).scenesDomain
}
catch (error) {
  console.log('FAIL build  dist/domains/scene-lock.js and dist/host/dispatch.js must be built')
  console.log('  ' + String(error && error.message ? error.message : error))
  process.exit(1)
}

// ── harness ────────────────────────────────────────────────────────────────

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
    extensions: { enabled: [] },
  }, overrides || {})
}

/**
 * A dispatcher over a table of stand-in ops. Every handler records its call, so "refused" can be
 * proved by the handler never running rather than by the failure alone.
 */
function makeDispatcher(state) {
  const calls = []
  const ids = Object.keys(FROZEN_OPS).concat([
    'scene.lock',
    'scene.plan',
    'mcp.list',
    'mcp.raw',
    'session.set',
    'session.clear',
    'session.allow',
    'scope.workspace',
    'settings.set',
    'backup.list',
    'group.toggle',
    'auto.apply',
    'skill.list',
  ])
  const seen = new Set()
  const unique = ids.filter(id => (seen.has(id) ? false : (seen.add(id), true)))
  const registry = new Registry()
  const module = { id: 'probe-lock', title: { zh: '锁探针', en: 'lock probe' }, ops: unique.map(id => ({ id, write: true, audit: false, note: 'probe stand-in' })) }
  registry.register(module)
  const handlers = {}
  for (const id of unique) {
    handlers[id] = async payload => {
      calls.push({ op: id, payload })
      return { ok: true, op: id }
    }
  }
  const tmp = globalThis.__lockProbeDir
  const dispatcher = new Dispatcher({ registry, state, services: { get: () => undefined }, historyFile: join(tmp, 'history.jsonl'), save: async () => null, log: () => {} })
  dispatcher.bind({ module, handlers })
  return { dispatcher, calls }
}

async function outcome(dispatcher, op, payload) {
  try {
    const data = await dispatcher.execute(op, payload)
    return { ok: true, data }
  }
  catch (error) {
    return { ok: false, code: error instanceof Failure ? error.code : 'not-a-failure', message: String(error && error.message ? error.message : error) }
  }
}

/** No pointer, no product words: the refusal is read by whoever called the op. */
function isFactOnly(message) {
  const banned = ['page', 'click', 'button', 'go to', 'open the', 'scenarios page', 'UI', '点击', '页面', '按钮', '请去']
  const lower = message.toLowerCase()
  return banned.every(word => !lower.includes(word.toLowerCase())) && !/[\u4e00-\u9fff]/.test(message)
}

globalThis.__lockProbeDir = await mkdtemp(join(tmpdir(), 'scene-lock-'))

// ── 1. the table ───────────────────────────────────────────────────────────

const ALL_OPS = [
  'mcp.save', 'mcp.create', 'mcp.delete', 'mcp.rawSave', 'toggle', 'bulk',
  'skill.toggle', 'skill.delete', 'skill.import', 'skill.move', 'skill.restore', 'skill.trashClean',
  'preset.save', 'preset.update', 'preset.delete', 'preset.apply',
  'tool.save', 'tool.toggle', 'tool.import', 'lazy.set', 'lazy.load', 'lazy.unload',
]
check('table: the environment ops are exactly the designed list, all scope "all"',
  equal(ALL_OPS.every(op => FROZEN_OPS[op] === 'all') && Object.values(FROZEN_OPS).filter(scope => scope === 'all').length, ALL_OPS.length),
  JSON.stringify(Object.entries(FROZEN_OPS).filter(([, scope]) => scope === 'all').map(([op]) => op)))
check('table: scene.save and scene.delete are per-archive',
  FROZEN_OPS['scene.save'] === 'self-scene' && FROZEN_OPS['scene.delete'] === 'self-scene')
check('table: scene.apply and scene.exit belong to the applied scene',
  FROZEN_OPS['scene.apply'] === 'active-scene' && FROZEN_OPS['scene.exit'] === 'active-scene')
check('table: scene.lock is never frozen', FROZEN_OPS['scene.lock'] === undefined)
check('table: sessions, scopes, settings, reads and backups are never frozen',
  ['session.set', 'session.clear', 'session.allow', 'scope.workspace', 'settings.set', 'scene.plan', 'mcp.list', 'backup.list']
    .every(op => FROZEN_OPS[op] === undefined))
const sceneOps = new Set(scenesDomain().module.ops.map(op => op.id))
check('table: every frozen scene.* op is declared by the scenes domain',
  Object.keys(FROZEN_OPS).filter(op => op.startsWith('scene.')).every(op => sceneOps.has(op)),
  Object.keys(FROZEN_OPS).filter(op => op.startsWith('scene.')).join(','))
check('domain: scene.delete and scene.lock are declared and handled',
  sceneOps.has('scene.delete') && sceneOps.has('scene.lock'))

// ── 2. scope helpers ───────────────────────────────────────────────────────

const twoLocked = makeState({ scenes: { beta: { name: 'beta', locked: true }, alpha: { name: 'alpha', locked: true }, calm: { name: 'calm' } }, mode: { name: ' calm ', snapshot: { at: 1 } } })
check('helpers: locked names are stable-sorted and ignore unlocked records',
  equal(lockedSceneNames(twoLocked), ['alpha', 'beta']))
check('helpers: the active scene name is trimmed off the mode record',
  activeSceneName(twoLocked) === 'calm', String(activeSceneName(twoLocked)))
check('helpers: no mode record means no active scene',
  activeSceneName(makeState()) === null && activeSceneName(makeState({ mode: { name: '  ' } })) === null)
check('helpers: nothing is refused when no scene is locked',
  frozenRejection(makeState({ scenes: { calm: { name: 'calm' } }, mode: { name: 'calm', snapshot: { at: 1 } } }), 'mcp.save', {}) === null)

// ── 3. the refusal, through the dispatcher ─────────────────────────────────

const lockedAll = makeState({ scenes: { work: { name: 'work', locked: true } }, mode: null })
const allGate = makeDispatcher(lockedAll)
const expectedAll = 'scene "work" is locked: this write was refused because it would change the environment that scene defines; unlock that scene first.'
for (const op of ALL_OPS) {
  const result = await outcome(allGate.dispatcher, op, {})
  check('refused: ' + op, result.ok === false && result.code === 'scene-locked', JSON.stringify(result))
}
check('refused: every "all" op, once each, through one dispatcher', allGate.calls.length === 0, JSON.stringify(allGate.calls.map(call => call.op)))
const oneRefusal = await outcome(allGate.dispatcher, 'mcp.save', { id: 'row-1' })
check('refused: the message is the designed sentence', oneRefusal.message === expectedAll, oneRefusal.message)
check('refused: the message names the scene and points at nothing', oneRefusal.message.includes('"work"') && isFactOnly(oneRefusal.message))

const twoGate = makeDispatcher(makeState({ scenes: { beta: { name: 'beta', locked: true }, alpha: { name: 'alpha', locked: true } }, mode: null }))
const plural = await outcome(twoGate.dispatcher, 'toggle', { kind: 'plugin', id: 'x' })
check('refused: every locked scene is named in the plural message',
  plural.ok === false && /scenes "alpha", "beta" are locked/.test(plural.message) && isFactOnly(plural.message), plural.message)

// ── 4. what a lock does not freeze ─────────────────────────────────────────

const allowedGate = makeDispatcher(lockedAll)
const allowed = ['scene.lock', 'session.set', 'session.clear', 'session.allow', 'scope.workspace', 'settings.set', 'scene.plan', 'mcp.list', 'mcp.raw', 'skill.list', 'backup.list', 'group.toggle', 'auto.apply']
for (const op of allowed) {
  const result = await outcome(allowedGate.dispatcher, op, { name: 'work', locked: false })
  check('allowed: ' + op, result.ok === true, JSON.stringify(result))
}
check('allowed: the handler really ran for every allowed op', allowedGate.calls.length === allowed.length)

// ── 5. per-scene scopes ────────────────────────────────────────────────────

const selfState = makeState({ scenes: { work: { name: 'work', locked: true }, other: { name: 'other' } }, mode: null })
const selfGate = makeDispatcher(selfState)
const saveLocked = await outcome(selfGate.dispatcher, 'scene.save', { name: ' work ', plugins: [] })
check('self-scene: saving the locked scene is refused, even with a padded name',
  saveLocked.ok === false && saveLocked.code === 'scene-locked' && saveLocked.message === 'scene "work" is locked: its archive cannot be modified or deleted; unlock it first.', saveLocked.message)
const deleteLocked = await outcome(selfGate.dispatcher, 'scene.delete', { name: 'work' })
check('self-scene: deleting the locked scene is refused', deleteLocked.ok === false && deleteLocked.code === 'scene-locked')
const saveOther = await outcome(selfGate.dispatcher, 'scene.save', { name: 'other', plugins: [] })
check('self-scene: another scene is still writable', saveOther.ok === true)
const saveNew = await outcome(selfGate.dispatcher, 'scene.save', { name: 'fresh' })
check('self-scene: a brand-new scene is still writable', saveNew.ok === true)

const activeState = makeState({ scenes: { work: { name: 'work', locked: true }, other: { name: 'other' } }, mode: { name: 'work', snapshot: { at: 1 } } })
const activeGate = makeDispatcher(activeState)
const expectedActive = 'scene "work" is locked and currently active: switching away or exiting is refused; unlock it first.'
const exitLocked = await outcome(activeGate.dispatcher, 'scene.exit', {})
check('active-scene: exiting the applied locked scene is refused with the designed sentence',
  exitLocked.ok === false && exitLocked.code === 'scene-locked' && exitLocked.message === expectedActive, exitLocked.message)
check('active-scene: the sentence points at nothing', isFactOnly(exitLocked.message))
const switchAway = await outcome(activeGate.dispatcher, 'scene.apply', { name: 'other' })
check('active-scene: switching to another scene is refused', switchAway.ok === false && switchAway.code === 'scene-locked')
const resubmit = await outcome(activeGate.dispatcher, 'scene.apply', { name: 'work' })
check('active-scene: re-applying the applied scene is allowed (it changes nothing)', resubmit.ok === true, JSON.stringify(resubmit))
const applyNew = await outcome(activeGate.dispatcher, 'scene.apply', { name: '' })
check('active-scene: an unnamed apply is refused too', applyNew.ok === false && applyNew.code === 'scene-locked')

// A lock on a scene that is not applied does not fence the applied one.
const elsewhere = makeDispatcher(makeState({ scenes: { work: { name: 'work' }, quiet: { name: 'quiet', locked: true } }, mode: { name: 'work', snapshot: { at: 1 } } }))
check('active-scene: a lock elsewhere does not fence exiting the applied scene', (await outcome(elsewhere.dispatcher, 'scene.exit', {})).ok === true)
check('active-scene: a lock elsewhere does not fence switching between unlocked scenes', (await outcome(elsewhere.dispatcher, 'scene.apply', { name: 'quiet' })).ok === true)

// ── 6. unlock restores the whole surface ───────────────────────────────────

const reopen = makeDispatcher(lockedAll)
await outcome(reopen.dispatcher, 'scene.lock', { name: 'work', locked: false })
check('unlock: scene.lock itself ran through the locked gate', reopen.calls.some(call => call.op === 'scene.lock'))
lockedAll.scenes.work.locked = false
const afterUnlock = []
for (const op of ALL_OPS) afterUnlock.push((await outcome(reopen.dispatcher, op, {})).ok)
check('unlock: every environment op passes again', afterUnlock.every(Boolean), JSON.stringify(afterUnlock))

console.log('')
console.log('scene-lock probe: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  console.log('failed: ' + failures.join('; '))
  process.exitCode = 1
}
await rm(globalThis.__lockProbeDir, { recursive: true, force: true })