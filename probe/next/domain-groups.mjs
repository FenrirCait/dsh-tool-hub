#!/usr/bin/env node
/**
 * Probe for the automatic group builder (task-14): auto.preview / auto.apply in the groups domain.
 *
 * Hand-rolled on purpose - no third-party library, PASS/FAIL lines, exit 1 on any failure.
 * It runs against dist/ (the compiled host half), so it checks the shipped code.
 *
 * Coverage:
 *   1. registration: both op ids declared, handled, and flagged read-only vs write+audit;
 *   2. the pure plan: bucket order, the 1.x labels, the drawer rule, unmanageable rows, skills;
 *   3. auto.preview: plan/groups/members counts and a state file it never writes;
 *   4. auto.apply: replaces automatic groups (flag or /^a\\d-/), keeps hand-made ones, stamps
 *      appliedAt, saves once, and an empty plan is safe;
 *   5. a degraded catalog: preview degrades with a reason, apply refuses and writes nothing.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// The built host, or a copy when TOOL_HUB_DIST points at one (same override as tool-mask.mjs).
const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const {
  AUTO_ROLE_NAMES,
  AUTO_ROWS_SERVICE,
  applyAutoPlan,
  applyGroupOnDemand,
  applyGroupSave,
  applyGroupTools,
  applyGroupTransfer,
  autoRoleFor,
  buildAutoPlan,
  cleanMembers,
  expandBundles,
  groupsDomain,
  normalizeGroups,
} = await import(pathToFileURL(join(distRoot, 'domains', 'groups.js')).href)
const { DomainFailure } = await import(pathToFileURL(join(distRoot, 'domains', 'tool-surface.js')).href)

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

function expectFailure(name, action, code) {
  return action().then(
    () => check(name, false, 'resolved but should have thrown ' + code),
    error => check(name, error instanceof DomainFailure && error.code === code,
      'threw ' + (error && error.code ? error.code : error)),
  )
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
  const env = {
    state: config.state || makeState(),
    services: { get: name => (config.services || {})[name] },
    async save(reason) {
      saves.push(reason)
      return '/state/backups/state-' + saves.length + '.json'
    },
    log() {},
    now: () => (config.now === undefined ? 1720000000000 : config.now),
  }
  env.saves = saves
  return env
}

/** The rich row port the auto builder asks for; a failing source throws on its own half. */
function autoPort(spec) {
  const config = spec || {}
  const port = {
    calls: 0,
    plugins() {
      port.calls += 1
      if (config.pluginsError) throw new Error(config.pluginsError)
      return config.plugins || []
    },
    skills() {
      port.calls += 1
      if (config.skillsError) throw new Error(config.skillsError)
      return config.skills || []
    },
  }
  return port
}

function plugin(id, extra) {
  return Object.assign({
    kind: 'plugin',
    id,
    name: id,
    moduleName: id,
    description: '',
    mcp: false,
    manageable: true,
  }, extra || {})
}

// ---- fixtures -------------------------------------------------------------

const rows = [
  plugin('@deepseek-ai/dsh-memory', { name: 'Memory', description: 'context and memory' }),
  plugin('@deepseek-ai/dsh-mcp-client', { mcp: true }),
  plugin('cordis:tools'),
  plugin('dsh-tool-hub', { name: 'Tool Hub', description: 'panel to switch tools' }),
  plugin('third-party-memory', { name: 'memory layer', description: 'keep context' }),
  plugin('image-gen', { name: 'image generator', description: 'generate and edit images' }),
  plugin('locked-row', { manageable: false }),
]
const skills = [{ kind: 'skill', id: 'my-skill', name: 'my-skill', enabled: true }]
const rowsPort = autoPort({ plugins: rows, skills })
const domain = groupsDomain()
const ops = new Map(domain.module.ops.map(op => [op.id, op]))

// ---- 1. registration ------------------------------------------------------

check('auto: both op ids are declared', ops.has('auto.preview') && ops.has('auto.apply'))
check('auto: both ops are bound to handlers',
  typeof domain.handlers['auto.preview'] === 'function' && typeof domain.handlers['auto.apply'] === 'function')
check('auto: preview is read-only and apply is write+audit',
  ops.get('auto.preview').write === false && ops.get('auto.preview').audit === false
  && ops.get('auto.apply').write === true && ops.get('auto.apply').audit === true)
check('auto: every declared op has a handler and every handler a declared op',
  equal(domain.module.ops.map(op => op.id).sort(), Object.keys(domain.handlers).sort()))
check('auto: op ids stay unique inside the domain',
  new Set(domain.module.ops.map(op => op.id)).size === domain.module.ops.length)
check('batch: group.batch is declared write+audit and has a handler',
  ops.get('group.batch')?.write === true && ops.get('group.batch')?.audit === true
  && typeof domain.handlers['group.batch'] === 'function')
check('auto: the 1.x group and collection ops are untouched',
  ['group.save', 'group.delete', 'group.toggle', 'group.reorder', 'group.move', 'group.clean',
    'group.add', 'group.remove', 'collection.save', 'collection.delete'].every(id => ops.has(id)))

// ---- MCP expansion regression ---------------------------------------------
const mcpRows = [
  { kind: 'plugin', id: 'github', moduleName: '@deepseek-ai/dsh-mcp-client', root: '@deepseek-ai/dsh-mcp-client', enabled: true, manageable: true },
  { kind: 'plugin', id: 'filesystem', moduleName: '@deepseek-ai/dsh-mcp-client', root: '@deepseek-ai/dsh-mcp-client', enabled: true, manageable: true },
]
const mcpAdd = expandBundles([{ kind: 'plugin', id: 'github' }], mcpRows)
check('bundle: one MCP id does not expand to every MCP server', mcpAdd.length === 1 && mcpAdd[0].kind === 'plugin' && mcpAdd[0].id === 'github')

// ---- 2. the pure plan -----------------------------------------------------

const plan = buildAutoPlan({ plugins: rows, skills })
check('auto: buckets come out official, mcp, base, rest',
  equal(plan.map(entry => entry.role), ['official', 'mcp', 'base', 'rest']))
check('auto: generated buckets carry the 1.x labels',
  equal(plan.map(entry => entry.name), ['官方', 'MCP 服务器', '第三方底座', '用户下载'])
  && AUTO_ROLE_NAMES.rest === '用户下载')
check('auto: only the user-downloaded bucket sits outside a drawer',
  equal(plan.map(entry => entry.collection), ['default', 'default', 'default', null]))
check('auto: a row the loader cannot flip is left out',
  plan.every(entry => entry.members.every(member => member.id !== 'locked-row')))
check('auto: the user-downloaded bucket takes skills after plugins',
  equal(plan[3].members.map(member => member.kind + ':' + member.id), ['plugin:image-gen', 'skill:my-skill']))
check('auto: an MCP row is claimed before the official prefix',
  autoRoleFor({ id: 'x', moduleName: '@deepseek-ai/dsh-mcp-client', name: 'x', description: '', mcp: true, manageable: true }) === 'mcp')
check('auto: a layer word with no job word lands in the base bucket',
  autoRoleFor({ id: 'x', moduleName: 'acme-cache', name: 'x', description: 'memory and context', mcp: false, manageable: true }) === 'base')
check('auto: a job word beats a layer word',
  autoRoleFor({ id: 'x', moduleName: 'acme-cache', name: 'x', description: 'memory search', mcp: false, manageable: true }) === 'rest')
check('auto: a plan entry starts with no tags',
  plan.every(entry => Array.isArray(entry.tags) && entry.tags.length === 0))

// ---- 3. auto.preview ------------------------------------------------------

const previewState = makeState()
const previewEnv = makeEnv({ state: previewState, services: { [AUTO_ROWS_SERVICE]: rowsPort } })
const preview = await domain.handlers['auto.preview']({}, previewEnv)
check('auto.preview: reports the plan, its bucket count and its member count',
  Array.isArray(preview.plan) && preview.plan.length === 4 && preview.groups === 4 && preview.members === 7)
check('auto.preview: returns the plan shape the client renders',
  preview.plan.every(entry => typeof entry.name === 'string' && typeof entry.role === 'string'
    && 'collection' in entry && Array.isArray(entry.tags) && Array.isArray(entry.members)))
check('auto.preview: writes nothing at all',
  previewEnv.saves.length === 0 && previewState.groups.length === 0 && previewState.auto.appliedAt === null)

// ---- 4. auto.apply --------------------------------------------------------

const applyState = makeState({
  groups: [
    { id: 'mine', name: '我的常用', role: null, members: [{ kind: 'plugin', id: 'image-gen' }], auto: false, createdAt: 1 },
    { id: 'a0-old', name: '官方', role: 'official', auto: true, createdAt: 1, members: [{ kind: 'plugin', id: 'gone' }] },
    { id: 'a7-legacy', name: '第三方底座', role: 'base', auto: false, createdAt: 1, members: [{ kind: 'plugin', id: 'third-party-memory' }] },
  ],
})
const applyEnv = makeEnv({ state: applyState, services: { [AUTO_ROWS_SERVICE]: rowsPort } })
const applied = await domain.handlers['auto.apply']({}, applyEnv)
const created = applyState.groups.filter(group => group.auto === true)
check('auto.apply: creates generated groups with an a-id and the auto flag',
  created.length === 4 && created.every(group => /^a\d+-[0-9a-z]+$/.test(group.id) && group.createdAt === 1720000000000))
check('auto.apply: replaces a group that only carries the auto flag',
  applyState.groups.every(group => group.id !== 'a0-old'))
check('auto.apply: replaces a group that only carries an automatic id',
  applyState.groups.every(group => group.id !== 'a7-legacy'))
check('auto.apply: keeps hand-made groups in front of the generated ones',
  applyState.groups.length === 5 && applyState.groups[0].id === 'mine'
  && equal(applyState.groups[0].members, [{ kind: 'plugin', id: 'image-gen' }]))
check('auto.apply: writes the buckets in plan order with their labels',
  equal(created.map(group => group.role), ['official', 'mcp', 'base', 'rest'])
  && equal(created.map(group => group.name), ['官方', 'MCP 服务器', '第三方底座', '用户下载']))
check('auto.apply: the user-downloaded group sits outside a drawer',
  created[3].collection === null && created[0].collection === 'default')
check('auto.apply: reports and stamps appliedAt',
  applied.appliedAt === 1720000000000 && applyState.auto.appliedAt === 1720000000000
  && applied.groups === 4 && applied.members === 7)
check('auto.apply: writes through the one save path, once',
  equal(applyEnv.saves, ['auto-apply']) && typeof applied.backup === 'string'
  && applied.plan.length === 4 && applied.plan.every(group => group.auto === true))
const firstIds = created.map(group => group.id)
const secondEnv = makeEnv({ state: applyState, services: { [AUTO_ROWS_SERVICE]: rowsPort }, now: 1720000060000 })
await domain.handlers['auto.apply']({}, secondEnv)
check('auto.apply: a second run replaces the first plan instead of stacking',
  applyState.groups.length === 5 && applyState.groups.filter(group => group.auto === true).length === 4
  && applyState.groups.filter(group => group.auto === true).every(group => !firstIds.includes(group.id)))

const emptyState = makeState({
  groups: [{ id: 'mine', name: '手工', role: null, members: [], auto: false, createdAt: 1 }],
})
const emptyEnv = makeEnv({ state: emptyState, services: { [AUTO_ROWS_SERVICE]: autoPort({ plugins: [], skills: [] }) } })
const emptyResult = await domain.handlers['auto.apply']({}, emptyEnv)
check('auto.apply: an empty plan creates nothing and keeps every hand-made group',
  emptyResult.groups === 0 && emptyResult.members === 0
  && emptyState.groups.length === 1 && emptyState.groups[0].id === 'mine')
check('auto.apply: an empty plan still stamps appliedAt and saves',
  emptyState.auto.appliedAt === 1720000000000 && equal(emptyEnv.saves, ['auto-apply']))
const carrierState = makeState({ auto: { appliedAt: null, lastMode: 'manual' } })
const carrierEnv = makeEnv({ state: carrierState, services: { [AUTO_ROWS_SERVICE]: autoPort({ plugins: [], skills: [] }) } })
await domain.handlers['auto.apply']({}, carrierEnv)
check('auto.apply: an existing key under auto rides along',
  carrierState.auto.lastMode === 'manual' && carrierState.auto.appliedAt === 1720000000000)

// ---- 5. degraded catalog --------------------------------------------------

const brokenState = makeState({
  groups: [{ id: 'a0-old', name: '官方', role: 'official', auto: true, createdAt: 1, members: [] }],
})
const brokenEnv = makeEnv({
  state: brokenState,
  services: { [AUTO_ROWS_SERVICE]: autoPort({ pluginsError: 'no plugin manager' }) },
})
const brokenPreview = await domain.handlers['auto.preview']({}, brokenEnv)
check('auto.preview: a broken catalog answers with an empty plan and a reason',
  brokenPreview.plan.length === 0 && brokenPreview.groups === 0 && brokenPreview.members === 0
  && typeof brokenPreview.degraded === 'string' && brokenPreview.degraded.includes('no plugin manager'))
await expectFailure('auto.apply: a broken catalog is refused instead of wiping the taxonomy',
  () => domain.handlers['auto.apply']({}, brokenEnv), 'capability-missing')
check('auto.apply: a refused apply writes nothing and leaves the groups alone',
  brokenEnv.saves.length === 0 && brokenState.groups.length === 1
  && brokenState.groups[0].id === 'a0-old' && brokenState.auto.appliedAt === null)

// ---- 6. the pure writer on its own ---------------------------------------

const manual = [{ id: 'mine', name: '手工', role: null, collection: 'default', members: [], auto: false, createdAt: 1, tags: [], onDemand: false }]
const written = applyAutoPlan(manual, plan, 1720000000000)
check('auto: applyAutoPlan keeps hand-made groups and derives its own counts',
  written.groups.length === 5 && written.created.length === 4 && written.members === 7
  && written.created.every(group => group.onDemand === false && group.auto === true))
const writtenEmpty = applyAutoPlan(manual, [], 1720000000000)
check('auto: applyAutoPlan with no plan returns the hand-made list untouched',
  writtenEmpty.groups.length === 1 && writtenEmpty.created.length === 0 && writtenEmpty.members === 0)

// ---- 6b. transfer ----------------------------------------------------------
const transferCtx = { known: new Set(['plugin:p-a', 'plugin:p-b', 'skill:s-a']), rows: [], collections: [{ id: 'default', name: 'd', order: 0 }], now: 1720000000000 }
const transferBase = normalizeGroups([
  { id: 'g-a', name: 'A', members: [{ kind: 'plugin', id: 'p-a' }, { kind: 'skill', id: 's-a' }, { kind: 'tool', id: 't-1' }] },
  { id: 'g-b', name: 'B', members: [{ kind: 'plugin', id: 'p-b' }] },
])
const transfer = applyGroupTransfer(transferBase, { from: 'g-a', to: 'g-b', members: [{ kind: 'plugin', id: 'p-a' }, { kind: 'skill', id: 's-a' }] }, transferCtx)
check('group.transfer: moves live members to the target in one result',
  transfer.moved === 2
  && transfer.from.members.map(member => member.kind + ':' + member.id).join(',') === 'tool:t-1'
  && transfer.to.members.map(member => member.kind + ':' + member.id).join(',') === 'plugin:p-b,plugin:p-a,skill:s-a')
check('group.transfer: an unknown source member is refused instead of half-moving',
  (() => { try { applyGroupTransfer(transferBase, { from: 'g-b', to: 'g-a', members: [{ kind: 'plugin', id: 'missing' }] }, transferCtx); return false } catch (error) { return error?.code === 'no-members' } })())

// ---- 7. on-demand tool members (G10) --------------------------------------

const toolCtx = { known: new Set(), rows: [], collections: [{ id: 'default', name: 'd', order: 0 }], now: 1720000000000 }
check('g10: normalizeGroups keeps an explicit tool list, reserved names stripped',
  (() => {
    const loaded = normalizeGroups([{ id: 'g1', name: 'Ops', members: [], onDemand: true, tools: ['t1', 'run_code', 't1'] }])
    return loaded.length === 1 && equal(loaded[0].tools, ['t1']) && loaded[0].onDemand === true
  })())
check('g10: normalizeGroups accepts a tool member and refuses a reserved one',
  (() => {
    const loaded = normalizeGroups([{ id: 'g1', name: 'Ops', members: [{ kind: 'tool', id: ' pwsh ' }, { kind: 'tool', id: 'tool_list' }] }])
    return equal(loaded[0].members, [{ kind: 'tool', id: 'pwsh' }])
  })())
check('g10: a generated bucket that appears twice unions its tools',
  (() => {
    const loaded = normalizeGroups([
      { id: 'a1-x', name: 'MCP 服务器', role: 'mcp', auto: true, members: [{ kind: 'plugin', id: 'p' }], tools: ['t1'] },
      { id: 'a2-y', name: 'MCP 服务器', role: 'mcp', auto: true, members: [], tools: ['t2', 't1'] },
    ])
    return loaded.length === 1 && equal(loaded[0].tools, ['t1', 't2'])
  })())
check('g10: group.save keeps tools when the payload omits them',
  (() => {
    const first = applyGroupSave([], { name: 'G', members: [], tools: ['t1', 'run_code'] }, toolCtx)
    const second = applyGroupSave(first.groups, { id: first.group.id, name: 'G2', members: [] }, toolCtx)
    return equal(first.group.tools, ['t1']) && equal(second.group.tools, ['t1'])
  })())
check('g10: applyGroupTools filters to the live view and applyGroupOnDemand flips the flag',
  (() => {
    const base = normalizeGroups([{ id: 'g1', name: 'Ops', members: [], onDemand: true, tools: [] }])
    const written = applyGroupTools(base, 'g1', ['t1', 't2', 'run_code'], ['t1'])
    const flipped = applyGroupOnDemand(written.groups, 'g1', false)
    return equal(written.tools, ['t1']) && equal(written.group.tools, ['t1']) && flipped.group.onDemand === false
  })())
check('g10: cleanMembers resolves tool members against the tool inventory only',
  (() => {
    const kept = cleanMembers([{ kind: 'tool', id: 't1' }, { kind: 'tool', id: 't2' }], new Set(), new Set(['t1']))
    return equal(kept, [{ kind: 'tool', id: 't1' }])
  })())
check('g10: group.onDemand and group.tools are declared write+audit and bound',
  (() => {
    const ids = ['group.onDemand', 'group.tools']
    return ids.every(id => ops.get(id)?.write === true && ops.get(id)?.audit === true && typeof domain.handlers[id] === 'function')
  })())

// ---- report ---------------------------------------------------------------

console.log('')
console.log('domain-groups probe: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  console.log('failed: ' + failures.join('; '))
  process.exit(1)
}