#!/usr/bin/env node
/**
 * Probe for host portability (task-19): market.status, market.import, third.status, third.off and
 * third.restore.
 *
 * Hand-rolled like the rest of probe/next: PASS/FAIL lines, exit 1 on any failure. It imports the
 * built host half (dist/), so TOOL_HUB_PROBE_DIST can point at another build root. The mapping and
 * filtering helpers run on plain fixtures; the handlers run end to end against a throwaway state
 * dir, a fake pluginManager and one real skill folder, so no live host is involved.
 *
 * Coverage:
 *   1. market.status mapping: groupOrder and fallback order, package/member counts, one package
 *      with several rows, missing packages, shapes that are not a dshmarket document;
 *   2. market.import merge: id m<source index>-<base36 now>, collection null, name-taken and
 *      no-installed-members skips, one save, a second import that saves nothing;
 *   3. market handler refusals: no file is market-empty, broken JSON is market-unreadable, and a
 *      status call never writes or saves;
 *   4. third-party filter: self, official, disabled and read-only rows stay out, MCP rows come in
 *      after ordinary plugins, skills last, projections carry the 1.x fields;
 *   5. third.off/restore: rollback file content and location, plugins and a real skill switched
 *      off, no-op off leaves no rollback point, restore re-enables both, all-failed off deletes
 *      its dead rollback point, no snapshot is a reported failure;
 *   6. registration: the five ops live in the core domain with the right write/audit flags and a
 *      handler each, and the registry accepts the module.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

async function exists(path) {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

async function expectCode(name, action, code) {
  try {
    await action()
    check(name, false, 'resolved but should have thrown ' + code)
  }
  catch (error) {
    check(
      name,
      error !== null && typeof error === 'object' && error.code === code,
      'threw ' + (error && error.code ? error.code : error),
    )
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
  PORTABILITY_OPS,
  latestRollback,
  marketFileFor,
  marketGroupsFrom,
  mergeMarketGroups,
  normalizeRollback,
  rollbackDir,
  rollbackName,
  thirdPartyTargetsFrom,
} = await import(new URL('host/portability.js', distHref))
const { createCoreDomain } = await import(new URL('host/index.js', distHref))
const { Registry } = await import(new URL('core/registry.js', distHref))
const { invalidatePluginCache } = await import(new URL('domains/plugins.js', distHref))

// ---- fixtures -------------------------------------------------------------

const NOW = 1700000000000
const STAMP = NOW.toString(36)

const root = await mkdtemp(join(tmpdir(), 'tool-hub-portability-'))
const statePath = join(root, 'state', 'state.json')
const patchPath = join(root, 'profile', 'cordis.patch.yml')
const marketPath = join(root, 'profile', '.dsh-market', 'state.json')
const skillsRoot = join(root, 'skills')
const emptySkillsRoot = join(root, 'skills-empty')
process.env.TOOL_HUB_STATE_FILE = statePath
process.env.TOOL_HUB_SKILL_ROOTS = skillsRoot
process.env.TOOL_HUB_WORKSPACES = '-'

const skillOn = join(skillsRoot, 'demo', 'SKILL.md')
const skillOff = skillOn + '.disabled'
await mkdir(join(skillsRoot, 'demo'), { recursive: true })
await writeFile(skillOn, '---\nname: demo\ndescription: demo skill\n---\nDemo body.\n')

function freshRows() {
  return [
    { entryId: 'self', moduleName: 'dsh-tool-hub', meta: { title: 'Tool Hub' }, enabled: true },
    { entryId: 'official', moduleName: '@deepseek-ai/dsh-web', meta: { title: 'Web' }, enabled: true },
    { entryId: 'p1', moduleName: 'pkg-one', meta: { title: 'One' }, enabled: true },
    { entryId: 'p2', moduleName: 'pkg-two', meta: { title: 'Two' }, enabled: false },
    { entryId: 'mcp1', moduleName: '@deepseek-ai/dsh-mcp-client', meta: { title: 'MCP' }, enabled: true },
    { entryId: 'ro', moduleName: 'pkg-readonly', meta: { title: 'Read only' }, enabled: true, readOnlyReason: 'locked by the profile' },
  ]
}

let rows = freshRows()
const managerCalls = []
const manager = {
  async listPlugins() {
    return rows
  },
  async setPluginEnabled(entryId, enabled) {
    managerCalls.push({ entryId, enabled })
    const row = rows.find(item => item.entryId === entryId)
    if (row === undefined) throw new Error('no loader entry ' + entryId)
    row.enabled = enabled
    return { application: 'ok' }
  },
}

function emptyState() {
  return {
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
  }
}

function makeEnv(state, pluginManager) {
  const saves = []
  const env = {
    state,
    services: {
      get(name) {
        if (name === 'pluginManager') return pluginManager === undefined ? manager : pluginManager
        if (name === 'configEditor') return { documentPath: patchPath }
        return undefined
      },
    },
    save: async reason => {
      saves.push(reason)
      return null
    },
    log: () => {},
    now: () => NOW,
  }
  return { env, saves }
}

const marketDoc = {
  groups: {
    Taken: ['pkg-one'],
    Fresh: ['pkg-one', 'pkg-two'],
    Empty: [],
    Missing: ['pkg-gone'],
    NotAnArray: 'not a package list',
  },
  groupOrder: ['Taken', 'Fresh', 'Empty', 'Missing', 'Absent', 42],
}

// ---- 1. market.status mapping ---------------------------------------------

check('market-file-beside-profile', marketFileFor(patchPath) === marketPath, marketFileFor(patchPath))
check('market-file-without-profile', marketFileFor(null) === null)

const mapped = marketGroupsFrom(marketDoc, [
  { id: 'p1', moduleName: 'pkg-one' },
  { id: 'p2', moduleName: 'pkg-two' },
  { id: 'p3', moduleName: 'pkg-one' },
  { id: 'blank', moduleName: '' },
], 'market.json')

check('market-mapping-present', mapped.available === true && mapped.file === 'market.json')
check('market-mapping-order', equal(mapped.groups.map(group => group.name), ['Taken', 'Fresh', 'Empty', 'Missing']))
check('market-mapping-package-count', mapped.groups[0].packages === 1 && mapped.groups[1].packages === 2)
check('market-mapping-members-expand', equal(mapped.groups[0].ids, ['p1', 'p3']) && mapped.groups[0].members === 2)
check('market-mapping-members-dedupe', equal(mapped.groups[1].ids, ['p1', 'p3', 'p2']))
check('market-mapping-missing', equal(mapped.groups[3].missing, ['pkg-gone']) && mapped.groups[3].members === 0)

const fallback = marketGroupsFrom({ groups: { B: ['pkg-two'], A: 'not an array' } }, [{ id: 'p2', moduleName: 'pkg-two' }], null)
check('market-mapping-fallback-order', equal(fallback.groups.map(group => group.name), ['B', 'A']))
check('market-mapping-non-list-group', fallback.groups[1].packages === 0 && fallback.groups[1].members === 0)
check('market-mapping-shapeless', marketGroupsFrom({ nope: true }, [], null).available === false)
check('market-mapping-array-doc', marketGroupsFrom([], [], null).available === false)
check('market-mapping-empty-groups', marketGroupsFrom({ groups: { Solo: [] } }, [], null).available === true)

// ---- 2. market.import merge ------------------------------------------------

const merge = mergeMarketGroups(
  [{ id: 'g1', name: 'Taken', members: [], role: null, collection: null, tags: [], auto: false, createdAt: 1, onDemand: false }],
  mapped.groups,
  NOW,
)
check('market-merge-count', merge.created.length === 1 && merge.summaries.length === 1)
check('market-merge-id', merge.created[0].id === 'm1-' + STAMP, merge.created[0].id)
check('market-merge-collection', merge.created[0].collection === null && merge.created[0].role === null)
check('market-merge-flags', merge.created[0].auto === false && merge.created[0].onDemand === false && merge.created[0].createdAt === NOW)
check('market-merge-members', equal(merge.created[0].members, [
  { kind: 'plugin', id: 'p1' },
  { kind: 'plugin', id: 'p3' },
  { kind: 'plugin', id: 'p2' },
]))
check('market-merge-skips', equal(merge.skipped, [
  { name: 'Taken', reason: 'name-taken' },
  { name: 'Empty', reason: 'no-installed-members' },
  { name: 'Missing', reason: 'no-installed-members' },
]))
check('market-merge-summary', equal(merge.summaries, [{ name: 'Fresh', members: 3, missing: 0 }]))
check('market-merge-keeps-current', merge.groups.length === 2 && merge.groups[0].id === 'g1')

const nothing = mergeMarketGroups([], [{ name: 'Empty', packages: 0, members: 0, ids: [], missing: [] }], NOW)
check('market-merge-nothing-created', nothing.created.length === 0 && nothing.groups.length === 0)
const nameless = mergeMarketGroups([], [{ name: '   ', packages: 1, members: 1, ids: ['p1'], missing: [] }], NOW)
check('market-merge-empty-name', equal(nameless.skipped, [{ name: '   ', reason: 'empty-name' }]))

// ---- 3. third-party filter -------------------------------------------------

const purePlugins = [
  { id: 'self', moduleName: 'dsh-tool-hub', name: 'Self', enabled: true, self: true, official: false, manageable: true },
  { id: 'off', moduleName: 'pkg-off', name: 'Off', enabled: false },
  { id: 'official', moduleName: '@deepseek-ai/dsh-web', name: 'Official', enabled: true, official: true },
  { id: 'ro', moduleName: 'pkg-ro', name: 'Read only', enabled: true, manageable: false },
  { id: 'p1', moduleName: 'pkg-one', name: 'One', enabled: true, role: 'rest' },
  { id: 'bare', enabled: true },
  { id: 'mcp', moduleName: '@deepseek-ai/dsh-mcp-client', name: 'MCP', enabled: true, mcp: true, official: true, role: 'mcp' },
]
const pureSkills = [
  { id: 'user|demo', name: 'demo', enabled: true },
  { id: 'user|off', name: 'off', enabled: false },
]
const targets = thirdPartyTargetsFrom(purePlugins, pureSkills)
check('third-filter-order', equal(targets.map(target => target.kind + ':' + target.id), [
  'plugin:p1',
  'plugin:bare',
  'plugin:mcp',
  'skill:user|demo',
]))
check('third-filter-excludes', !targets.some(target => ['self', 'off', 'official', 'ro'].includes(target.id)))
check('third-filter-plugin-fields', targets[0].moduleName === 'pkg-one' && targets[0].mcp === false && targets[0].role === 'rest')
check('third-filter-name-fallback', targets[1].name === 'bare' && targets[1].moduleName === null)
check('third-filter-mcp-fields', targets[2].mcp === true && targets[2].role === 'mcp' && targets[2].moduleName === '@deepseek-ai/dsh-mcp-client')
check('third-filter-skill-fields', targets[3].name === 'demo' && targets[3].moduleName === null && targets[3].mcp === false && targets[3].role === 'rest')

// ---- 4. rollback helpers ---------------------------------------------------

check('rollback-name-sorts', /^[0-9T-]+Z\.json$/.test(rollbackName(NOW)) && !rollbackName(NOW).slice(0, -5).includes(':'))
check('rollback-normalize-filters', equal(normalizeRollback({ version: 'x', plugins: ['a', 2], skills: 'nope' }), {
  version: 1,
  at: '',
  patch: null,
  plugins: ['a'],
  skills: [],
}))
check('rollback-normalize-record', normalizeRollback(null) === null && normalizeRollback('nope') === null)

// ---- 5. registration -------------------------------------------------------

const core = createCoreDomain({ snapshot: async () => ({}), doctor: async () => ({}) })
check('registration-op-order', equal(core.module.ops.map(op => op.id), [
  'snapshot',
  'doctor',
  'history.clear',
  'market.status',
  'market.import',
  'third.status',
  'third.off',
  'third.restore',
]))
check('registration-handlers', core.module.ops.every(op => typeof core.handlers[op.id] === 'function'))
check('registration-ops-table', equal(PORTABILITY_OPS.map(op => op.id), [
  'market.status',
  'market.import',
  'third.status',
  'third.off',
  'third.restore',
]))
const registry = new Registry()
registry.register(core.module)
check('registration-market-status-read-only', registry.findOp('market.status').write === false && registry.findOp('market.status').audit === false)
check('registration-third-status-read-only', registry.findOp('third.status').write === false && registry.findOp('third.status').audit === false)
check('registration-writes-audited', ['market.import', 'third.off', 'third.restore'].every(id => {
  const op = registry.findOp(id)
  return op !== undefined && op.write === true && op.audit === true
}))

// ---- 6. market handlers ----------------------------------------------------

const marketState = emptyState()
marketState.groups = [{ id: 'g1', name: 'Taken', members: [], role: null, collection: null, tags: [], auto: false, createdAt: 1, onDemand: false }]
const market = makeEnv(marketState)
const marketEnv = market.env
const marketSaves = market.saves

await mkdir(dirname(marketPath), { recursive: true })
await writeFile(marketPath, JSON.stringify(marketDoc))
const marketText = await readFile(marketPath, 'utf8')

const status = await core.handlers['market.status'](undefined, marketEnv)
check('market-status-groups', status.available === true && status.groups.length === 4, JSON.stringify(status.groups.map(group => group.name)))
check('market-status-file', status.file === marketPath)
check('market-status-read-only', marketSaves.length === 0 && await readFile(marketPath, 'utf8') === marketText)

const imported = await core.handlers['market.import'](undefined, marketEnv)
check('market-import-count', imported.imported === 1 && imported.total === 4 && imported.missing === 0)
check('market-import-skip', equal(imported.skipped.map(skip => skip.reason), ['name-taken', 'no-installed-members', 'no-installed-members']))
check('market-import-state', marketEnv.state.groups.length === 2 && marketEnv.state.groups[1].id === 'm1-' + STAMP)
check('market-import-shape', marketEnv.state.groups[1].collection === null
  && marketEnv.state.groups[1].role === null
  && marketEnv.state.groups[1].auto === false
  && equal(marketEnv.state.groups[1].members, [
    { kind: 'plugin', id: 'p1' },
    { kind: 'plugin', id: 'p2' },
  ]), JSON.stringify(marketEnv.state.groups[1]))
check('market-import-save-once', marketSaves.length === 1 && marketSaves[0] === 'portability:market-import')

const again = await core.handlers['market.import'](undefined, marketEnv)
check('market-import-idempotent', again.imported === 0 && again.skipped.length === 4)
check('market-import-no-extra-save', marketSaves.length === 1)

await rm(marketPath, { force: true })
const missing = await core.handlers['market.status'](undefined, marketEnv)
check('market-status-missing', missing.available === false && missing.error === null && missing.file === marketPath)
await expectCode('market-import-missing-throws', () => core.handlers['market.import'](undefined, marketEnv), 'market-empty')

await writeFile(marketPath, '{ not json')
const broken = await core.handlers['market.status'](undefined, marketEnv)
check('market-status-unreadable', broken.available === false
  && typeof broken.error === 'string'
  && broken.error.startsWith('cannot read dshmarket state'))
await expectCode('market-import-unreadable-throws', () => core.handlers['market.import'](undefined, marketEnv), 'market-unreadable')

// ---- 7. third-party handlers ----------------------------------------------

rows = freshRows()
invalidatePluginCache()
const thirdState = emptyState()
const third = makeEnv(thirdState)
const thirdEnv = third.env
const thirdSaves = third.saves

const before = await core.handlers['third.status'](undefined, thirdEnv)
check('third-status-targets', equal(before.targets.map(target => target.kind + ':' + target.id), [
  'plugin:p1',
  'plugin:mcp1',
  'skill:user|demo',
]), JSON.stringify(before.targets))
check('third-status-no-snapshot', before.snapshot === null)

const off = await core.handlers['third.off'](undefined, thirdEnv)
check('third-off-counts', off.disabled === 3 && off.failed === 0 && off.snapshot === rollbackName(NOW), JSON.stringify(off))
check('third-off-snapshot-location', off.snapshot !== null && await exists(join(rollbackDir(), off.snapshot)))
const rollbackDoc = JSON.parse(await readFile(join(rollbackDir(), off.snapshot), 'utf8'))
check('third-off-rollback-content', rollbackDoc.version === 1
  && rollbackDoc.patch === patchPath
  && equal(rollbackDoc.plugins, ['p1', 'mcp1'])
  && equal(rollbackDoc.skills, ['user|demo']))
check('third-off-plugins', rows.find(row => row.entryId === 'p1').enabled === false
  && rows.find(row => row.entryId === 'mcp1').enabled === false
  && rows.find(row => row.entryId === 'official').enabled === true)
check('third-off-skill', await exists(skillOff) && !(await exists(skillOn)))
check('third-off-saves', thirdSaves.length === 1 && thirdSaves[0] === 'portability:third-off')

const after = await core.handlers['third.status'](undefined, thirdEnv)
check('third-status-off-empty', after.targets.length === 0)
check('third-status-snapshot', after.snapshot !== null && after.snapshot.file === off.snapshot)

const rollbackCount = (await readdir(rollbackDir())).length
const noop = await core.handlers['third.off'](undefined, thirdEnv)
check('third-off-noop', noop.disabled === 0 && noop.failed === 0 && noop.snapshot === null)
check('third-off-noop-no-file', (await readdir(rollbackDir())).length === rollbackCount)

const olderFile = '2000-01-01T00-00-00-000Z.json'
await writeFile(join(rollbackDir(), olderFile), JSON.stringify({ version: 1, at: '', patch: null, plugins: ['ghost'], skills: [] }))
const latest = await latestRollback()
check('rollback-latest-picks-newest', latest !== null && latest.file === off.snapshot && equal(latest.plugins, ['p1', 'mcp1']))
await rm(join(rollbackDir(), olderFile), { force: true })

const restored = await core.handlers['third.restore'](undefined, thirdEnv)
check('third-restore-counts', restored.restored === 3 && restored.failed === 0 && restored.snapshot === off.snapshot)
check('third-restore-plugins', rows.find(row => row.entryId === 'p1').enabled === true
  && rows.find(row => row.entryId === 'mcp1').enabled === true)
check('third-restore-skill', await exists(skillOn) && !(await exists(skillOff)))
check('third-restore-saves', thirdSaves[thirdSaves.length - 1] === 'portability:third-restore')

await rm(rollbackDir(), { recursive: true, force: true })
await expectCode('third-restore-no-snapshot', () => core.handlers['third.restore'](undefined, thirdEnv), 'no-snapshot')

process.env.TOOL_HUB_SKILL_ROOTS = emptySkillsRoot
const failingManager = {
  async listPlugins() {
    return [{ entryId: 'p9', moduleName: 'pkg-nine', meta: { title: 'Nine' }, enabled: true }]
  },
  async setPluginEnabled() {
    throw new Error('refused by the profile')
  },
}
invalidatePluginCache()
const failing = makeEnv(emptyState(), failingManager)
const failedOff = await core.handlers['third.off'](undefined, failing.env)
check('third-off-all-failed', failedOff.disabled === 0 && failedOff.failed === 1 && failedOff.snapshot === null)
const leftovers = await readdir(rollbackDir()).catch(() => [])
check('third-off-dead-point-removed', leftovers.filter(name => name.endsWith('.json')).length === 0)
process.env.TOOL_HUB_SKILL_ROOTS = skillsRoot

// ---- result ----------------------------------------------------------------

await rm(root, { recursive: true, force: true }).catch(() => {})
if (failed > 0) {
  console.error('portability probe: ' + failed + ' failed of ' + (passed + failed))
  for (const failure of failures) console.error('  FAIL ' + failure)
  process.exitCode = 1
}
else {
  console.log('portability probe: ' + passed + ' checks passed')
}
