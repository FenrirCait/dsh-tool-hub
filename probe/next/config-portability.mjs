#!/usr/bin/env node
/**
 * Probe for config portability (task-17): config.export / config.import in the config domain.
 *
 * Hand-rolled on purpose - no third-party library, PASS/FAIL lines, exit 1 on any failure.
 * It runs against dist/ (the compiled host half), so it checks the shipped code. Set
 * TOOL_HUB_PROBE_DIST to another build root when dist/ has not been rebuilt yet; the default is
 * exactly what the rest of probe/next uses.
 *
 * Coverage:
 *   1. registration: both op ids declared and bound, read-only export vs write+audit import;
 *   2. export: envelope shape, exactly the four sections, parseable file text, no state leakage;
 *   3. validation: every 1.x refusal (bad shapes, missing names, unknown member kind, duplicate
 *      preset, drawer id outside the schema) and the normalisation it shares with the panel;
 *   4. merge: add, fold by id and by name, overwrite a preset by name, union the deny list, report
 *      counts, save once, re-apply the mask exactly once, and leave the live sections untouched;
 *   5. replace: needs confirm:true, keeps the default drawer, drops what the file omits, applies
 *      the mask once, and still leaves the live sections alone;
 *   6. compatibility: a 1.x flat file, pasted JSON text, a foreign kind, broken JSON and a missing
 *      bundle; an exported file re-imports without growing the state.
 */
import { pathToFileURL } from 'node:url'

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

function pick(source, keys) {
  const out = {}
  for (const key of keys) out[key] = source[key]
  return out
}

function expectThrow(name, action, code) {
  try {
    action()
    check(name, false, 'resolved but should have thrown ' + code)
  }
  catch (error) {
    check(name, error instanceof DomainFailure && error.code === code, 'threw ' + (error && error.code ? error.code : error))
  }
}

async function expectFailure(name, action, code) {
  try {
    await action()
    check(name, false, 'resolved but should have thrown ' + code)
  }
  catch (error) {
    check(name, error instanceof DomainFailure && error.code === code, 'threw ' + (error && error.code ? error.code : error))
  }
}

function distHrefFor(root) {
  const href = pathToFileURL(root).href
  return new URL(href.endsWith('/') ? href : href + '/')
}

const distHref = process.env.TOOL_HUB_PROBE_DIST === undefined
  ? new URL('../../dist/', import.meta.url)
  : distHrefFor(process.env.TOOL_HUB_PROBE_DIST)

const {
  CONFIG_KIND,
  CONFIG_VERSION,
  configDomain,
  mergeConfigState,
  replaceConfigState,
  validateConfig,
} = await import(new URL('domains/config.js', distHref))
const { DomainFailure } = await import(new URL('domains/tool-surface.js', distHref))

// ---- fixtures -------------------------------------------------------------

function makeState(overrides) {
  return Object.assign({
    version: 2,
    groups: [],
    collections: [{ id: 'default', name: '默认分组群', order: 0 }],
    presets: [],
    toolDeny: [],
    auto: { appliedAt: 7 },
    sessions: { 'sess-1': ['mcp__legacy__x'] },
    scenes: { night: { tools: ['mcp__legacy__x'] } },
    mode: { scene: 'night' },
    settings: { 'appearance.theme': 'dark' },
    modules: { 'tool-surface': { servers: [], loaded: [] } },
  }, overrides || {})
}

function makeEnv(options) {
  const config = options || {}
  const saves = []
  const logs = []
  const env = {
    state: config.state || makeState(),
    services: { get: name => (config.services || {})[name] },
    async save(reason) {
      saves.push(reason)
      return '/state/backups/state-' + saves.length + '.json'
    },
    log(level, message) {
      logs.push(level + ': ' + message)
    },
    now: () => (config.now === undefined ? 1720000000000 : config.now),
  }
  env.saves = saves
  env.logs = logs
  return env
}

/** A surface port that records what the mask was asked to deny; known:null means no inventory. */
function surfacePort() {
  const port = {
    calls: [],
    known: () => null,
    restrict(deny) {
      port.calls.push(deny.slice())
      return () => {}
    },
  }
  return port
}

const LIVE_KEYS = ['sessions', 'scenes', 'settings', 'mode', 'auto']
function liveSections(state) {
  return JSON.parse(JSON.stringify(pick(state, LIVE_KEYS)))
}

const domain = configDomain()
const ops = new Map(domain.module.ops.map(op => [op.id, op]))
const call = (id, payload, env) => domain.handlers[id](payload, env)

// ---- 1. registration ------------------------------------------------------

check('config: both op ids are declared', ops.has('config.export') && ops.has('config.import'))
check('config: both ops are bound to handlers',
  typeof domain.handlers['config.export'] === 'function' && typeof domain.handlers['config.import'] === 'function')
check('config: export is read-only, import writes and audits, neither gate is static',
  ops.get('config.export').write === false && ops.get('config.export').audit === false
  && ops.get('config.import').write === true && ops.get('config.import').audit === true
  && ops.get('config.export').confirm === undefined && ops.get('config.import').confirm === undefined)

// ---- 2. export ------------------------------------------------------------

const exportEnv = makeEnv({
  state: makeState({
    groups: [{
      id: 'g-a',
      name: 'Alpha',
      members: [{ kind: 'plugin', id: 'e1' }, { kind: 'skill', id: 'user|beta' }],
      role: null,
      collection: 'default',
      tags: ['imported'],
      auto: false,
      createdAt: 1,
      onDemand: false,
    }],
    collections: [{ id: 'default', name: '默认分组群', order: 0 }, { id: 'work', name: 'Work', order: 1 }],
    presets: [{ name: 'p1', enabled: { plugin: ['e1'], skill: [], tool: [] }, note: 'note', createdAt: 2 }],
    toolDeny: ['mcp__srv__one'],
  }),
})
const exported = await call('config.export', {}, exportEnv)
const exportedJson = exported.json
const exportedBundle = JSON.parse(exportedJson)

check('export: the envelope is kind/version/exportedAt/data',
  exported.kind === CONFIG_KIND && exported.version === CONFIG_VERSION
  && exported.exportedAt === new Date(exportEnv.now()).toISOString(),
  JSON.stringify({ kind: exported.kind, version: exported.version, exportedAt: exported.exportedAt }))
check('export: data holds exactly the four sections',
  Object.keys(exported.data).sort().join(',') === 'collections,groups,presets,toolDeny',
  Object.keys(exported.data).join(','))
check('export: the file text parses back to the same bundle',
  equal(exportedBundle, { kind: exported.kind, version: exported.version, exportedAt: exported.exportedAt, data: exported.data }))
check('export: counts match the sections',
  equal(exported.counts, { groups: 1, collections: 2, presets: 1, toolDeny: 1 }),
  JSON.stringify(exported.counts))
check('export: the group keeps its members, tags and onDemand flag',
  equal(exported.data.groups[0].members, [{ kind: 'plugin', id: 'e1' }, { kind: 'skill', id: 'user|beta' }])
  && equal(exported.data.groups[0].tags, ['imported']) && exported.data.groups[0].onDemand === false)
check('export: no settings, sessions, scenes or mode leak into the file',
  !/"(settings|sessions|scenes|mode)"/.test(exportedJson) && !exportedJson.includes('legacy'),
  exportedJson.slice(0, 120))
check('export: no credential or local path leak into the file',
  !/Bearer |Authorization|[A-Za-z]:[\\/]/.test(exportedJson), exportedJson.slice(0, 120))

// ---- 3. validation --------------------------------------------------------

expectThrow('validate: a non-object is refused', () => validateConfig([]), 'bad-config')
expectThrow('validate: a section that is not an array is refused', () => validateConfig({ groups: 'nope' }), 'bad-config')
expectThrow('validate: a group without a name is refused', () => validateConfig({ groups: [{ id: 'x' }] }), 'bad-config')
expectThrow('validate: a member without an id is refused',
  () => validateConfig({ groups: [{ name: 'g', members: [{ kind: 'plugin' }] }] }), 'bad-config')
expectThrow('validate: a member of unknown kind is refused',
  () => validateConfig({ groups: [{ name: 'g', members: [{ kind: 'widget', id: 'w' }] }] }), 'bad-config')
expectThrow('validate: a collection without an id and name is refused',
  () => validateConfig({ collections: [{ id: 'drawer' }] }), 'bad-config')
expectThrow('validate: a drawer id outside the state schema is refused',
  () => validateConfig({ collections: [{ id: 'Bad Drawer', name: 'x' }] }), 'bad-config')
expectThrow('validate: a preset without a name is refused', () => validateConfig({ presets: [{}] }), 'bad-config')
expectThrow('validate: a preset name that appears twice is refused',
  () => validateConfig({ presets: [{ name: 'same' }, { name: ' same ' }] }), 'bad-config')

const normalized = validateConfig({
  groups: [{
    name: '  Padded  ',
    members: [{ kind: 'plugin', id: ' e1 ' }, { kind: 'plugin', id: 'e1' }, { kind: 'skill', id: 'user|beta' }],
  }],
  collections: [{ id: 'Work', name: '  Work  ' }],
  presets: [{ name: '  p  ' }],
  toolDeny: ['mcp__srv__a', 'mcp__srv__a', 'not-a-tool', 7],
})
check('validate: names are trimmed and a missing group id defaults to g1',
  normalized.groups.length === 1 && normalized.groups[0].name === 'Padded' && normalized.groups[0].id === 'g1',
  JSON.stringify(normalized.groups[0]))
check('validate: duplicate members collapse to one kind:id',
  equal(normalized.groups[0].members, [{ kind: 'plugin', id: 'e1' }, { kind: 'skill', id: 'user|beta' }]),
  JSON.stringify(normalized.groups[0].members))
check('validate: drawer ids are lowercased and names trimmed',
  equal(normalized.collections, [{ id: 'work', name: 'Work', order: 0 }]), JSON.stringify(normalized.collections))
check('validate: the deny list keeps only unique MCP tool names',
  equal(normalized.toolDeny, ['mcp__srv__a']), JSON.stringify(normalized.toolDeny))
check('validate: a record without createdAt takes the import time, and onDemand defaults to false',
  normalized.groups[0].createdAt === 0 && normalized.groups[0].onDemand === false,
  JSON.stringify({ createdAt: normalized.groups[0].createdAt, onDemand: normalized.groups[0].onDemand }))

const kept = validateConfig({ groups: [{ id: 'g-k', name: 'K', createdAt: 1234, onDemand: true }] }, 999)
check('validate: a 1.x group keeps createdAt and gains onDemand',
  kept.groups[0].createdAt === 1234 && kept.groups[0].onDemand === true, JSON.stringify(kept.groups[0]))

// ---- 4. merge -------------------------------------------------------------

const mergeEnv = makeEnv({
  services: { 'toolHub.surface': surfacePort() },
  state: makeState({
    groups: [{
      id: 'g-old',
      name: 'Existing',
      members: [{ kind: 'plugin', id: 'e1' }],
      role: null,
      collection: 'default',
      tags: ['keep'],
      auto: false,
      createdAt: 11,
      onDemand: false,
    }],
    presets: [{ name: 'p1', enabled: { plugin: ['e1'], skill: [], tool: [] }, note: 'old', createdAt: 12 }],
    toolDeny: ['mcp__a__one'],
  }),
})
const mergeLive = liveSections(mergeEnv.state)
const mergePort = mergeEnv.services.get('toolHub.surface')
const merged = await call('config.import', {
  mode: 'merge',
  bundle: {
    kind: CONFIG_KIND,
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    data: {
      groups: [
        { id: 'g-old', name: 'Existing', members: [{ kind: 'plugin', id: 'e1' }, { kind: 'skill', id: 'user|beta' }] },
        { id: 'g-new', name: 'Fresh', members: [{ kind: 'plugin', id: 'e2' }] },
      ],
      collections: [{ id: 'Work', name: 'Work', order: 3 }, { id: 'work', name: 'duplicate', order: 4 }],
      presets: [{ name: 'p1', enabled: { plugin: ['e2'], skill: [], tool: [] }, note: 'new' }, { name: 'p2' }],
      toolDeny: ['mcp__a__one', 'mcp__b__two', 'not-a-tool'],
    },
  },
}, mergeEnv)

check('merge: counts describe the file and the resulting state',
  equal(pick(merged, ['mode', 'addedGroups', 'mergedGroups', 'presets', 'totalPresets', 'addedCollections', 'collections', 'deny', 'total']),
    { mode: 'merge', addedGroups: 1, mergedGroups: 1, presets: 2, totalPresets: 2, addedCollections: 1, collections: 2, deny: 2, total: 2 }),
  JSON.stringify(pick(merged, ['mode', 'addedGroups', 'mergedGroups', 'presets', 'totalPresets', 'addedCollections', 'collections', 'deny', 'total'])))
check('merge: a same-id group folds into the existing one and unions its members',
  mergeEnv.state.groups.length === 2
  && mergeEnv.state.groups[0].id === 'g-old' && mergeEnv.state.groups[0].name === 'Existing'
  && equal(mergeEnv.state.groups[0].members, [{ kind: 'plugin', id: 'e1' }, { kind: 'skill', id: 'user|beta' }])
  && equal(mergeEnv.state.groups[0].tags, ['keep']),
  JSON.stringify(mergeEnv.state.groups))
check('merge: the new group keeps its id and takes the import time',
  mergeEnv.state.groups[1].id === 'g-new' && mergeEnv.state.groups[1].createdAt === mergeEnv.now(),
  JSON.stringify(mergeEnv.state.groups[1]))
check('merge: a preset with the same name is overwritten, not duplicated',
  mergeEnv.state.presets.length === 2
  && mergeEnv.state.presets.filter(preset => preset.name === 'p1').length === 1
  && mergeEnv.state.presets[0].note === 'new' && equal(mergeEnv.state.presets[0].enabled.plugin, ['e2']),
  JSON.stringify(mergeEnv.state.presets))
check('merge: the deny list is the union, in first-seen order, without foreign names',
  equal(mergeEnv.state.toolDeny, ['mcp__a__one', 'mcp__b__two']), JSON.stringify(mergeEnv.state.toolDeny))
check('merge: sessions, scenes, settings, mode and auto survive untouched',
  equal(liveSections(mergeEnv.state), mergeLive), JSON.stringify(liveSections(mergeEnv.state)))
check('merge: one save with a merge reason',
  equal(mergeEnv.saves, ['config-merge']), JSON.stringify(mergeEnv.saves))
check('merge: the mask is applied exactly once with the union deny list',
  mergePort.calls.length === 1 && equal(mergePort.calls[0], ['mcp__a__one', 'mcp__b__two']),
  JSON.stringify(mergePort.calls))
check('merge: the report names the applied mask',
  merged.mask.ok === true && merged.mask.status === 'applied' && merged.mask.masked === true,
  JSON.stringify(merged.mask))
check('merge: no confirmation is required and the backup is reported',
  merged.mode === 'merge' && merged.backup === '/state/backups/state-1.json',
  JSON.stringify({ mode: merged.mode, backup: merged.backup }))

const sameNameGroup = mergeConfigState(
  makeState({
    groups: [{ id: 'g-kept', name: 'Collision', members: [], role: null, collection: 'default', tags: [], auto: false, createdAt: 1, onDemand: false }],
  }),
  validateConfig({ groups: [{ id: 'g-other', name: 'Collision', members: [{ kind: 'plugin', id: 'e9' }] }] }),
)
check('merge: a name collision keeps the existing id and absorbs the members',
  sameNameGroup.sections.groups.length === 1 && sameNameGroup.sections.groups[0].id === 'g-kept'
  && sameNameGroup.sections.groups[0].members.length === 1,
  JSON.stringify(sameNameGroup.sections.groups))

const dangling = mergeConfigState(
  makeState(),
  validateConfig({ groups: [{ id: 'gx', name: 'X', collection: 'gone', members: [] }] }),
)
check('merge: a group whose drawer is missing falls back to the default drawer',
  dangling.sections.groups[0].collection === 'default', JSON.stringify(dangling.sections.groups[0]))

const quietEnv = makeEnv({ services: { 'toolHub.surface': surfacePort() } })
const quiet = await call('config.import', {
  mode: 'merge',
  bundle: { kind: CONFIG_KIND, version: 1, data: { groups: [], collections: [], presets: [], toolDeny: [] } },
}, quietEnv)
check('merge: an empty deny list stores nothing and never calls restrict',
  quietEnv.services.get('toolHub.surface').calls.length === 0 && quietEnv.state.toolDeny.length === 0
  && quiet.mask.status === 'unchanged' && quiet.mask.masked === false,
  JSON.stringify({ mask: quiet.mask.status, deny: quietEnv.state.toolDeny }))

const bareEnv = makeEnv()
const bare = await call('config.import', { bundle: { data: { toolDeny: ['mcp__srv__z'] } }, mode: 'merge' }, bareEnv)
check('merge: without a surface service the deny list is stored and reported as no-port',
  bare.mask.status === 'no-port' && bare.mask.masked === false
  && equal(bareEnv.state.toolDeny, ['mcp__srv__z']), JSON.stringify(bare.mask))

const oddModeEnv = makeEnv()
const oddMode = await call('config.import', { bundle: { data: { toolDeny: ['mcp__srv__y'] } }, mode: 'wipe' }, oddModeEnv)
check('merge: an unrecognised mode falls back to merge instead of replacing',
  oddMode.mode === 'merge' && oddModeEnv.state.toolDeny.length === 1, JSON.stringify(oddMode))

// ---- 5. replace -----------------------------------------------------------

const replaceEnv = makeEnv({
  services: { 'toolHub.surface': surfacePort() },
  state: makeState({
    groups: [{ id: 'g-old', name: 'Existing', members: [{ kind: 'plugin', id: 'e1' }], role: null, collection: 'default', tags: [], auto: false, createdAt: 11, onDemand: false }],
    presets: [{ name: 'p1', enabled: { plugin: ['e1'], skill: [], tool: [] }, note: 'old', createdAt: 12 }],
    toolDeny: ['mcp__old__x'],
  }),
})
const replaceLive = liveSections(replaceEnv.state)
const replacePort = replaceEnv.services.get('toolHub.surface')
const replaceBundle = {
  kind: CONFIG_KIND,
  version: 1,
  data: {
    groups: [{ id: 'only', name: '唯一', members: [] }],
    collections: [{ id: 'only-drawer', name: 'Only', order: 5 }],
    presets: [],
    toolDeny: ['mcp__c__three'],
  },
}
await expectFailure('replace: without confirm:true it is refused',
  () => call('config.import', { bundle: replaceBundle, mode: 'replace' }, replaceEnv), 'confirm-required')
check('replace: a refused replace writes nothing and leaves the mask alone',
  replaceEnv.saves.length === 0 && replacePort.calls.length === 0
  && equal(liveSections(replaceEnv.state), replaceLive)
  && replaceEnv.state.groups.length === 1 && equal(replaceEnv.state.toolDeny, ['mcp__old__x']),
  JSON.stringify({ saves: replaceEnv.saves, deny: replaceEnv.state.toolDeny }))

const replaced = await call('config.import', { bundle: replaceBundle, mode: 'replace', confirm: true }, replaceEnv)
check('replace: exactly the four sections are replaced',
  equal(replaceEnv.state.groups.map(group => group.id), ['only'])
  && equal(replaceEnv.state.collections.map(entry => entry.id), ['default', 'only-drawer'])
  && replaceEnv.state.presets.length === 0
  && equal(replaceEnv.state.toolDeny, ['mcp__c__three']),
  JSON.stringify({ groups: replaceEnv.state.groups.map(group => group.id), collections: replaceEnv.state.collections.map(entry => entry.id), deny: replaceEnv.state.toolDeny }))
check('replace: the imported group takes the import time and the default drawer',
  replaceEnv.state.groups[0].createdAt === replaceEnv.now()
  && replaceEnv.state.groups[0].collection === 'default',
  JSON.stringify(replaceEnv.state.groups[0]))
check('replace: counts report every group as added and none merged',
  equal(pick(replaced, ['mode', 'addedGroups', 'mergedGroups', 'presets', 'totalPresets', 'addedCollections', 'collections', 'deny', 'total']),
    { mode: 'replace', addedGroups: 1, mergedGroups: 0, presets: 0, totalPresets: 0, addedCollections: 2, collections: 2, deny: 1, total: 1 }),
  JSON.stringify(pick(replaced, ['mode', 'addedGroups', 'mergedGroups', 'presets', 'totalPresets', 'addedCollections', 'collections', 'deny', 'total'])))
check('replace: sessions, scenes, settings, mode and auto survive untouched',
  equal(liveSections(replaceEnv.state), replaceLive), JSON.stringify(liveSections(replaceEnv.state)))
check('replace: one save with a replace reason and one mask application',
  equal(replaceEnv.saves, ['config-replace']) && replacePort.calls.length === 1
  && equal(replacePort.calls[0], ['mcp__c__three']),
  JSON.stringify({ saves: replaceEnv.saves, calls: replacePort.calls }))

const fileDefault = replaceConfigState(validateConfig({
  groups: [],
  collections: [{ id: 'default', name: '主抽屉', order: 0 }],
  presets: [],
  toolDeny: [],
}))
check('replace: a file that names the default drawer keeps that drawer, not a copy',
  fileDefault.sections.collections.length === 1 && fileDefault.sections.collections[0].name === '主抽屉',
  JSON.stringify(fileDefault.sections.collections))

// ---- 6. compatibility -----------------------------------------------------

const flatEnv = makeEnv()
const flat = await call('config.import', {
  mode: 'merge',
  json: JSON.stringify({
    version: 1,
    exportedAt: '2025-05-05T00:00:00.000Z',
    groups: [{ id: 'flat', name: 'Flat', members: [], role: null, collection: 'default', tags: [], auto: false, createdAt: 5 }],
    collections: [],
    presets: [],
    toolDeny: [],
  }),
}, flatEnv)
check('import: a 1.x flat file without an envelope is accepted',
  flat.mode === 'merge' && flatEnv.state.groups.length === 1 && flatEnv.state.groups[0].id === 'flat',
  JSON.stringify(flatEnv.state.groups))

const textEnv = makeEnv()
const asText = await call('config.import', {
  mode: 'merge',
  bundle: JSON.stringify({ kind: CONFIG_KIND, version: 1, data: { groups: [], collections: [], presets: [], toolDeny: [] } }),
}, textEnv)
check('import: bundle may be JSON text instead of an object',
  asText.mode === 'merge' && textEnv.saves.length === 1, JSON.stringify(asText))

await expectFailure('import: a payload without a bundle is refused as bad-payload',
  () => call('config.import', { mode: 'merge' }, makeEnv()), 'bad-payload')
await expectFailure('import: broken JSON is refused as bad-json',
  () => call('config.import', { json: '{nope', mode: 'merge' }, makeEnv()), 'bad-json')
await expectFailure('import: a JSON array is refused as bad-config',
  () => call('config.import', { json: '[]', mode: 'merge' }, makeEnv()), 'bad-config')
await expectFailure('import: a foreign bundle kind is refused',
  () => call('config.import', { bundle: { kind: 'dsh-scene', data: {} }, mode: 'merge' }, makeEnv()), 'bad-config')
await expectFailure('import: a bundle whose data is not an object is refused',
  () => call('config.import', { bundle: { kind: CONFIG_KIND, data: [] }, mode: 'merge' }, makeEnv()), 'bad-config')

const roundEnv = makeEnv()
await call('config.import', { json: exportedJson, mode: 'merge' }, roundEnv)
const second = await call('config.import', { json: exportedJson, mode: 'merge' }, roundEnv)
check('import: an exported file re-imports without growing the state',
  second.addedGroups === 0 && second.mergedGroups === 1 && second.total === 1
  && second.collections === 2 && roundEnv.state.groups.length === 1 && roundEnv.state.presets.length === 1,
  JSON.stringify({ second: pick(second, ['addedGroups', 'mergedGroups', 'total', 'collections']), groups: roundEnv.state.groups.length }))

// ---- summary --------------------------------------------------------------

console.log('')
console.log(failed === 0 ? 'OK ' + passed + ' checks passed' : 'FAILED ' + failed + ' of ' + (passed + failed) + ' checks')
if (failed > 0) {
  console.log('failed: ' + failures.join(' | '))
  process.exit(1)
}
