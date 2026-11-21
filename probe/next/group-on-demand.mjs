#!/usr/bin/env node
/**
 * G10 probe: on-demand groups past MCP only.
 *
 * One plane per section: the name universe, the group data, the replay, the cache, the ops, and
 * the per-agent mask with the prompt catalog. Runs against a built tree selected by
 * TOOL_HUB_DIST (default `dist`), so it can be pointed at an out-of-tree emit.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const load = async (text) => import(pathToFileURL(join(distRoot, text)).href)
const groupsModule = await load('domains/groups.js')
const exposure = await load('domains/group-exposure.js')
const surface = await load('domains/tool-surface.js')
const maskModule = await load('host/tool-mask.js')
const groupToolModule = await load('host/group-tool.js')

const {
  applyGroupOnDemand, applyGroupSave, applyGroupTools, cleanMembers, groupToolNames,
  groupsDomain, normalizeGroups, normalizeMember, onDemandDeny, onDemandToolNames,
} = groupsModule
const { DISCOVERY_NAMES, groupFromInput, restoredOpenGroups } = exposure
const {
  DomainFailure, mergeSurface, readLazy, readOpen, toolSurfaceDomain, unionNames, writeLazy, writeOpen,
} = surface
const { attachToolMask, maskControl } = maskModule
const { createGroupTool } = groupToolModule

let pass = 0
let fail = 0
async function check(name, run) {
  try {
    const detail = await run()
    pass += 1
    console.log('PASS ' + name + (detail === undefined ? '' : '  ' + detail))
  }
  catch (error) {
    fail += 1
    console.log('FAIL ' + name + '  ' + (error && error.message ? error.message : String(error)))
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function equal(actual, expected, message) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error((message ?? 'expected') + ' ' + right + ', got ' + left)
}
async function expectFailure(name, action, code) {
  try {
    await action()
    throw new Error('resolved but should have thrown ' + code)
  }
  catch (error) {
    if (!(error instanceof DomainFailure) || error.code !== code) {
      throw new Error('threw ' + (error && error.code ? error.code : String(error)))
    }
    return undefined
  }
}

/** One group record with everything normalizeGroups would fill. */
function group(overrides) {
  return {
    id: 'g1',
    name: 'Ops',
    members: [],
    role: null,
    collection: 'default',
    tags: [],
    auto: false,
    createdAt: 1,
    onDemand: true,
    tools: [],
    ...(overrides ?? {}),
  }
}

function makeState(overrides) {
  return {
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
    ...(overrides ?? {}),
  }
}

function makeEnv(options) {
  const config = options ?? {}
  const saves = []
  const syncs = { count: 0 }
  const env = {
    state: config.state ?? makeState(),
    services: {
      get: name => {
        if (name === 'toolHub.mask' && config.mask !== undefined) return config.mask
        return (config.services ?? {})[name]
      },
    },
    async save(reason) {
      saves.push(reason)
      return '/state/backups/state-' + saves.length + '.json'
    },
    log() {},
    now: () => 1720000000000,
  }
  env.saves = saves
  env.syncs = syncs
  return env
}

/** A host with one agent per addAgent() call and a session log the agent can replay. */
function makeHost(options) {
  const config = options ?? {}
  const known = config.known ?? ['pwsh', 't1', 't2', 'mcp__a__x']
  const handlers = new Map()
  const restrictCalls = []
  const agents = []
  const prompt = { registered: null, orderCalls: 0 }
  const tools = {
    view() {
      return { knownNames: [...known], restrictableNames: [...known] }
    },
    restrict(request) {
      restrictCalls.push([...request.deny])
      for (const callback of handlers.get('tools/change') ?? []) callback({})
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      if (name === 'tools') return tools
      if (name === 'agents') return { list: () => agents }
      if (name === 'logger') return { warn: () => {} }
      return undefined
    },
    on(event, callback) {
      const list = handlers.get(event) ?? []
      list.push(callback)
      handlers.set(event, list)
      return () => handlers.set(event, (handlers.get(event) ?? []).filter(item => item !== callback))
    },
  }
  function addAgent(id, session) {
    const agent = {
      id,
      session: { id, ...(session ?? {}) },
      ctx: {
        plugin(plugin) {
          const scope = {
            tools,
            systemPrompt: {
              getSectionOrder(name) {
                prompt.orderCalls += 1
                return name === 'MCP_SERVERS' ? 3100 : 0
              },
              section(section) {
                prompt.registered = section
                return () => { prompt.registered = null }
              },
            },
            get: name => ctx.get(name),
            on() { return () => {} },
            effect(fn) { return fn() },
          }
          plugin.apply(scope)
          return { dispose() {} }
        },
      },
    }
    agents.push(agent)
    for (const callback of handlers.get('agent/created') ?? []) callback({ agent })
    return agent
  }
  return { ctx, known, handlers, restrictCalls, agents, prompt, addAgent }
}

// ---- 1. onDemandDeny: closed, open, case-insensitive -----------------------

await check('onDemand: a closed group denies its tools', () => {
  const groups = [group({ tools: ['t1', 't2'] })]
  equal(onDemandDeny(groups, ['t1', 't2'], new Set()), ['t1', 't2'])
})
await check('onDemand: an open group denies nothing', () => {
  const groups = [group({ tools: ['t1', 't2'] })]
  equal(onDemandDeny(groups, ['t1', 't2'], new Set(['Ops'])), [])
})
await check('onDemand: group names compare case-insensitively', () => {
  const groups = [group({ tools: ['t1'] })]
  equal(onDemandDeny(groups, ['t1'], new Set(['ops'])), [])
})
await check('onDemand: a group that is not on demand never denies', () => {
  const groups = [group({ onDemand: false, tools: ['t1'] })]
  equal(onDemandDeny(groups, ['t1'], new Set()), [])
})
await check('onDemand: a tool shared by an open and a closed group stays hidden', () => {
  const groups = [group({ id: 'g1', name: 'Open', tools: ['t1', 't2'] }), group({ id: 'g2', name: 'Shut', tools: ['t2'] })]
  equal(onDemandDeny(groups, ['t1', 't2'], new Set(['Open'])), ['t2'])
})

// ---- 2. reserved names -----------------------------------------------------

await check('reserved: run_code, tool_switch, tool_list and hub_tools never enter a deny', () => {
  const groups = [group({ tools: ['run_code', 'tool_switch', 'tool_list', 'hub_tools', 't1'] })]
  equal(onDemandDeny(groups, ['run_code', 'tool_switch', 'tool_list', 'hub_tools', 't1'], new Set()), ['t1'])
})
await check('reserved: a reserved tool member is dropped at normalization', () => {
  equal(normalizeMember({ kind: 'tool', id: 'run_code' }), null)
  equal(normalizeMember({ kind: 'tool', id: ' tool_list ' }), null)
})
await check('reserved: maskable union drops reserved names but keeps built-in tools', () => {
  equal(unionNames([['pwsh', 'run_code', 'pwsh', 'tool_list']]), ['pwsh'])
})

// ---- 3. empty inputs -------------------------------------------------------

await check('empty: no groups means no deny', () => equal(onDemandDeny([], ['t1'], new Set()), []))
await check('empty: a group with no tools means no deny', () => {
  equal(onDemandDeny([group({ tools: [] })], ['t1'], new Set()), [])
})
await check('empty: no known inventory means no deny and no panic', () => {
  equal(onDemandDeny([group({ tools: ['t1'] })], [], new Set()), [])
  equal(onDemandToolNames([group({ tools: ['t1'] })], null), ['t1'])
})

// ---- 4. replay: call/result pairing ---------------------------------------

function logOf(events) {
  return { seq: events.length, eventAt: seq => events[seq] }
}
function call(name, callId, args) {
  return { type: 'tool/call', data: { name, callId, arguments: args } }
}
function result(callId, extra) {
  return { type: 'tool/result', data: { toolCallId: callId, ...(extra ?? {}) } }
}

await check('replay: a successful call/result pair opens the group', () => {
  const events = [call('tool_list', 'c1', { group: 'Ops' }), result('c1')]
  equal([...restoredOpenGroups(logOf(events), DISCOVERY_NAMES).open], ['Ops'])
})
await check('replay: an error result leaves the group closed', () => {
  const events = [call('tool_list', 'c1', { group: 'Ops' }), result('c1', { isError: true })]
  equal([...restoredOpenGroups(logOf(events), DISCOVERY_NAMES).open], [])
})
await check('replay: a call with no result stays pending', () => {
  const events = [call('tool_list', 'c1', { group: 'Ops' })]
  equal([...restoredOpenGroups(logOf(events), DISCOVERY_NAMES).open], [])
})
await check('replay: an unrelated tool call opens nothing', () => {
  const events = [call('pwsh', 'c1', { group: 'Ops' }), result('c1')]
  equal([...restoredOpenGroups(logOf(events), DISCOVERY_NAMES).open], [])
})
await check('replay: a result without its call opens nothing', () => {
  const events = [result('c9')]
  equal([...restoredOpenGroups(logOf(events), DISCOVERY_NAMES).open], [])
})

// ---- 5. replay: PTC dispatch ----------------------------------------------

await check('replay: a successful ptc-dispatch opens the group', () => {
  const events = [{ type: 'tool/ptc-dispatch', data: { name: 'tool_list', arguments: { group: 'Ops' } } }]
  equal([...restoredOpenGroups(logOf(events), DISCOVERY_NAMES).open], ['Ops'])
})
await check('replay: a failed ptc-dispatch opens nothing', () => {
  const events = [{ type: 'tool/ptc-dispatch', data: { name: 'tool_list', arguments: { group: 'Ops' }, isError: true } }]
  equal([...restoredOpenGroups(logOf(events), DISCOVERY_NAMES).open], [])
})

// ---- 6. replay: arguments as a JSON string --------------------------------

await check('replay: arguments as a JSON string parse like an object', () => {
  const events = [
    call('tool_list', 'c1', JSON.stringify({ group: 'Ops' })),
    result('c1'),
  ]
  equal([...restoredOpenGroups(logOf(events), DISCOVERY_NAMES).open], ['Ops'])
  assert(groupFromInput('{"group":"Ops"}') === 'Ops', 'string form')
  assert(groupFromInput('not json') === null, 'non-JSON ignored')
  assert(groupFromInput('{"group":""}') === null, 'empty group ignored')
})
await check('replay: the call id may live on the source or a tool-result block', () => {
  const fromSource = [{ type: 'tool/call', data: { name: 'tool_list', callId: 'c1', arguments: { group: 'A' } } }, { type: 'tool/result', data: { source: { callId: 'c1' } } }]
  equal([...restoredOpenGroups(logOf(fromSource), DISCOVERY_NAMES).open], ['A'])
  const fromBlock = [{ type: 'tool/call', data: { name: 'tool_list', callId: 'c2', arguments: { group: 'B' } } }, { type: 'tool/result', data: { content: [{ type: 'tool-result', toolCallId: 'c2' }] } }]
  equal([...restoredOpenGroups(logOf(fromBlock), DISCOVERY_NAMES).open], ['B'])
})

// ---- 7. fork: the inherited prefix counts, later opens do not -------------

await check('fork: a child log replays its inherited prefix only', () => {
  const parentPrefix = [call('tool_list', 'p1', { group: 'Early' }), result('p1')]
  const childTail = [call('tool_list', 'c1', { group: 'Late' }), result('c1')]
  const child = [...parentPrefix, ...childTail]
  const opened = [...restoredOpenGroups(logOf(child), DISCOVERY_NAMES).open]
  equal(opened, ['Early', 'Late'], 'the child log itself holds both events')
  const afterFork = [...restoredOpenGroups(logOf(parentPrefix), DISCOVERY_NAMES).open]
  equal(afterFork, ['Early'], 'the parent log never gains the post-fork open')
})
await check('replay: the optional command channel records "/tools on <group>"', () => {
  const events = [{ type: 'command/run', data: { name: 'tools', rawInput: 'on Ops' } }]
  equal([...restoredOpenGroups(logOf(events), DISCOVERY_NAMES, new Set(['tools'])).open], ['Ops'])
  equal([...restoredOpenGroups(logOf(events), DISCOVERY_NAMES).open], [], 'opt-in only')
})

// ---- 8. replay degrades ----------------------------------------------------

await check('replay: a throwing eventAt yields an empty result and no error', () => {
  const log = { seq: 3, eventAt() { throw new Error('gone') } }
  const out = restoredOpenGroups(log, DISCOVERY_NAMES)
  equal([...out.open], [])
  equal(out.events, 0)
})
await check('replay: a missing log is empty, not a crash', () => {
  equal([...restoredOpenGroups(undefined, DISCOVERY_NAMES).open], [])
  equal([...restoredOpenGroups(null, DISCOVERY_NAMES).open], [])
})

// ---- 9. cache: writeRead round trip, lazy coexistence, log wins -----------

await check('cache: writeOpen/readOpen round-trip and normalize', () => {
  const state = makeState()
  writeOpen(state, { s1: ['Ops', 'ops', '', 'Ops'], ' ': ['x'] })
  equal(readOpen(state), { s1: ['Ops', 'ops'] })
})
await check('cache: a lazy toggle keeps the open cache in the same module record', () => {
  const state = makeState()
  writeLazy(state, { servers: ['srv'], loaded: [] })
  writeOpen(state, { s1: ['Ops'] })
  writeLazy(state, { servers: [], loaded: ['mcp__srv__a'] })
  equal(readOpen(state), { s1: ['Ops'] })
  equal(readLazy(state).loaded, ['mcp__srv__a'])
})
await check('cache: with no active agent the mask falls back to the cache', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({
    groups: () => [group({ tools: ['t1'] })],
    known: () => host.known,
    cached: () => ['Ops'],
  })
  equal(mask.denyFor(host.agents[0]), [])
})
await check('cache: a replayable log wins over a stale cache', () => {
  const events = [call('tool_list', 'c1', { group: 'Ops' }), result('c1', { isError: true })]
  const host = makeHost()
  host.addAgent('a1', { seq: events.length, eventAt: seq => events[seq] })
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({
    groups: () => [group({ tools: ['t1'] })],
    known: () => host.known,
    cached: () => ['Ops'],
  })
  equal(mask.denyFor(host.agents[0]), ['t1'], 'the cache said open, the log says closed')
})

// ---- 10. the mask: per agent, closed vs open, reserved --------------------

await check('mask: a closed on-demand group is denied for the agent', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({ groups: () => [group({ tools: ['t1', 'run_code'] })], known: () => host.known })
  equal(mask.denyFor(host.agents[0]), ['t1'])
  equal(host.restrictCalls.at(-1), ['t1'])
})
await check('mask: opening the group through the live hint lifts the deny', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({ groups: () => [group({ tools: ['t1'] })], known: () => host.known })
  equal(mask.denyFor(host.agents[0]), ['t1'])
  mask.noteOpened('a1', 'Ops')
  mask.syncAll()
  equal(mask.denyFor(host.agents[0]), [])
})
await check('mask: a successful tool_list event in the log lifts the deny', () => {
  const events = [call('tool_list', 'c1', { group: 'Ops' }), result('c1')]
  const host = makeHost()
  host.addAgent('a1', { seq: events.length, eventAt: seq => events[seq] })
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({ groups: () => [group({ tools: ['t1'] })], known: () => host.known })
  equal(mask.denyFor(host.agents[0]), [])
})
await check('mask: closing again re-applies the deny', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({ groups: () => [group({ tools: ['t1'] })], known: () => host.known })
  mask.noteOpened('a1', 'Ops')
  mask.noteClosed('a1', 'Ops')
  equal(mask.denyFor(host.agents[0]), ['t1'])
})
await check('mask: on-demand alone mounts a plugin even with no install layer', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  equal(mask.info().mounted, 0, 'nothing to do yet')
  mask.setOnDemandSource({ groups: () => [group({ tools: ['t1'] })], known: () => host.known })
  equal(mask.info().mounted, 1)
})
await check('mask: a known inventory of null hides nothing', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({ groups: () => [group({ tools: ['t1'] })], known: () => null })
  equal(mask.denyFor(host.agents[0]), [])
})

// ---- 11. the prompt catalog ------------------------------------------------

await check('prompt: the agent scope registers tools:on-demand after MCP_SERVERS', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({ groups: () => [group({ tools: ['t1'] })], known: () => host.known })
  assert(host.prompt.registered !== null, 'no section registered')
  assert(host.prompt.registered.name === 'tools:on-demand', host.prompt.registered.name)
  assert(host.prompt.registered.order === 3101, String(host.prompt.registered.order))
  assert(host.prompt.registered.interpolate === false, 'interpolate must be off')
})
await check('prompt: the catalog lists a closed group with its tool count', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({ groups: () => [group({ tools: ['t1', 't2'], tags: ['运维'] })], known: () => host.known })
  const text = host.prompt.registered.text()
  assert(text.includes('Ops'), text)
  assert(text.includes('2 个工具'), text)
  assert(text.includes('tool_list({group:"Ops"})'), text)
  assert(text.includes('运维'), text)
})
await check('prompt: the catalog drops an opened group and is empty when nothing is closed', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({ groups: () => [group({ tools: ['t1'] })], known: () => host.known })
  mask.noteOpened('a1', 'Ops')
  equal(host.prompt.registered.text(), '')
})
await check('prompt: no on-demand group means an empty section text', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({ groups: () => [group({ onDemand: false, tools: ['t1'] })], known: () => host.known })
  equal(host.prompt.registered.text(), '')
})

// ---- 12. the tool_list tool ----------------------------------------------

await check('tool_list: opens the group through session.open for the calling agent', async () => {
  const calls = []
  const tool = createGroupTool({ async execute(op, payload) { calls.push({ op, payload }); return { opened: true } } })
  equal(tool.name, 'tool_list')
  const value = await tool.execute({ group: 'Ops' }, { agent: { session: { id: 's1' } } })
  equal(calls, [{ op: 'session.open', payload: { sessionId: 's1', group: 'Ops' } }])
  equal(value, { opened: true })
  equal(tool.output.render({}, value), [{ type: 'text', text: '{"opened":true}' }])
})
await check('tool_list: a missing group or session throws', async () => {
  const tool = createGroupTool({ async execute() { return {} } })
  let first = ''
  try { await tool.execute({}, { agent: { session: { id: 's1' } } }) } catch (error) { first = error.message }
  assert(/needs a group name/.test(first), first)
  let second = ''
  try { await tool.execute({ group: 'Ops' }, { agent: {} }) } catch (error) { second = error.message }
  assert(/needs an agent session/.test(second), second)
})

// ---- 13. group data: members, tools, normalization ------------------------

await check('groups: a tool member normalizes and reserved names are refused', () => {
  equal(normalizeMember({ kind: 'tool', id: ' pwsh ' }), { kind: 'tool', id: 'pwsh' })
  equal(normalizeMember({ kind: 'nope', id: 'x' }), null)
})
await check('groups: normalizeGroups keeps tools and unions them across a generated merge', () => {
  const loaded = normalizeGroups([
    group({ id: 'a1-x', name: 'Bucket', role: 'base', auto: true, tools: ['t1', 'run_code'] }),
    group({ id: 'a2-y', name: 'Bucket', role: 'base', auto: true, tools: ['t2', 't1'] }),
  ])
  equal(loaded.length, 1)
  equal(loaded[0].tools, ['t1', 't2'])
})
await check('groups: groupToolNames unions the explicit list and tool members', () => {
  equal(groupToolNames(group({ tools: ['t1'], members: [{ kind: 'tool', id: 't2' }, { kind: 'plugin', id: 'p' }] })), ['t1', 't2'])
})
await check('groups: cleanMembers filters tool members when the live view is known', () => {
  const members = cleanMembers([{ kind: 'tool', id: 't1' }, { kind: 'tool', id: 't2' }], new Set(), new Set(['t1']))
  equal(members, [{ kind: 'tool', id: 't1' }])
})
await check('groups: group.save writes tools, strips reserved names, keeps them when omitted', () => {
  const ctx = { known: new Set(), rows: [], collections: [{ id: 'default', name: 'd', order: 0 }], now: 5 }
  const first = applyGroupSave([], { name: 'G', members: [], tools: ['t1', 'run_code', 't1'] }, ctx)
  equal(first.group.tools, ['t1'])
  const second = applyGroupSave(first.groups, { id: first.group.id, name: 'G2', members: [] }, ctx)
  equal(second.group.tools, ['t1'])
})
await check('groups: applyGroupTools filters to the live view, applyGroupOnDemand flips the flag', () => {
  const base = [group({ tools: [] })]
  const written = applyGroupTools(base, 'g1', ['t1', 't2', 'run_code'], ['t1'])
  equal(written.tools, ['t1'])
  equal(written.group.tools, ['t1'])
  const flipped = applyGroupOnDemand(written.groups, 'g1', false)
  equal(flipped.group.onDemand, false)
  let missing = ''
  try { applyGroupOnDemand([], 'gone', true) } catch (error) { missing = error.code }
  assert(missing === 'no-group', missing)
})

// ---- 14. ops: session.open / close / tool.catalog -------------------------

await check('ops: the four G10 ops are declared and bound', () => {
  const domain = toolSurfaceDomain()
  const ops = new Map(domain.module.ops.map(op => [op.id, op]))
  for (const id of ['session.open', 'session.close', 'tool.catalog', 'scope.list']) {
    assert(ops.has(id), 'missing op ' + id)
    assert(typeof domain.handlers[id] === 'function', 'missing handler ' + id)
  }
  assert(ops.get('session.open').write === true && ops.get('session.open').audit === true, 'session.open write+audit')
  assert(ops.get('tool.catalog').write === false && ops.get('tool.catalog').audit === false, 'tool.catalog read-only')
  const groupsOps = new Map(groupsDomain().module.ops.map(op => [op.id, op]))
  assert(groupsOps.has('group.onDemand') && groupsOps.has('group.tools'), 'group ops declared')
})

await check('session.open: refuses an unknown group', async () => {
  const env = makeEnv({ state: makeState({ groups: [group()] }) })
  await expectFailure('session.open unknown-group', () => toolSurfaceDomain().handlers['session.open']({ sessionId: 's1', group: 'Nope' }, env), 'unknown-group')
})
await check('session.open: refuses a group that is not on demand', async () => {
  const env = makeEnv({ state: makeState({ groups: [group({ onDemand: false, tools: ['t1'] })] }) })
  await expectFailure('session.open not-on-demand', () => toolSurfaceDomain().handlers['session.open']({ sessionId: 's1', group: 'Ops' }, env), 'not-on-demand')
})
await check('session.open: writes the cache, reports the tools, hints the mask and syncs', async () => {
  const mask = {
    count: 0,
    notes: [],
    sync() { mask.count += 1 },
    noteOpened(id, name) { mask.notes.push(['open', id, name]) },
    noteClosed(id, name) { mask.notes.push(['close', id, name]) },
  }
  const env = makeEnv({
    state: makeState({ groups: [group({ tools: ['t1', 't2', 'run_code'] })] }),
    mask,
    services: { 'toolHub.surface': { known: () => ['t1', 't2'], restrict: () => () => {} } },
  })
  const opened = await toolSurfaceDomain().handlers['session.open']({ sessionId: 's1', group: 'ops' }, env)
  equal(opened.tools, ['t1', 't2'])
  equal(opened.opened, true)
  equal(readOpen(env.state), { s1: ['Ops'] })
  equal(mask.notes, [['open', 's1', 'Ops']])
  equal(mask.count, 1)
  equal(env.saves, ['session-open'])
})
await check('session.open: a second open is idempotent across case', async () => {
  const env = makeEnv({ state: makeState({ groups: [group({ tools: ['t1'] })] }) })
  const domain = toolSurfaceDomain()
  await domain.handlers['session.open']({ sessionId: 's1', group: 'Ops' }, env)
  const again = await domain.handlers['session.open']({ sessionId: 's1', group: 'ops' }, env)
  equal(again.added, false)
  equal(readOpen(env.state), { s1: ['Ops'] })
})
await check('session.close: removes the group and keeps an unrelated one', async () => {
  const env = makeEnv({ state: makeState({ groups: [group({ tools: ['t1'] }), group({ id: 'g2', name: 'Other', tools: ['t2'] })] }) })
  const domain = toolSurfaceDomain()
  await domain.handlers['session.open']({ sessionId: 's1', group: 'Ops' }, env)
  await domain.handlers['session.open']({ sessionId: 's1', group: 'Other' }, env)
  const closed = await domain.handlers['session.close']({ sessionId: 's1', group: 'ops' }, env)
  equal(closed.opened, false)
  equal(readOpen(env.state), { s1: ['Other'] })
})
check('session.open through the real mask: the group unmasks on the same turn', async () => {
  const state = makeState({ groups: [group({ tools: ['t1', 't2'] })] })
  const host = makeHost({ known: ['t1', 't2'] })
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.setOnDemandSource({ groups: () => normalizeGroups(state.groups), known: () => host.known, cached: () => [] })
  equal(mask.denyFor(host.agents[0]), ['t1', 't2'], 'closed at first')
  const env = makeEnv({ state, mask: maskControl(mask), services: { 'toolHub.surface': { known: () => host.known, restrict: () => () => {} } } })
  await toolSurfaceDomain().handlers['session.open']({ sessionId: 'a1', group: 'Ops' }, env)
  equal(mask.denyFor(host.agents[0]), [], 'the live hint carries the open before the log does')
})
await check('tool.catalog: reports groups, open state, lazy servers and reserved names', async () => {
  const env = makeEnv({
    state: makeState({
      groups: [group({ tools: ['t1'], tags: ['运维'] }), group({ id: 'g2', name: 'Plain', onDemand: false, tools: [] })],
      toolDeny: ['run_code'],
      modules: { 'tool-surface': { servers: ['srv'], loaded: [''], open: { s1: ['Ops'] } } },
    }),
    services: { 'toolHub.surface': { known: () => ['t1', 't2'], restrict: () => () => {} } },
  })
  const catalog = await toolSurfaceDomain().handlers['tool.catalog']({ sessionId: 's1' }, env)
  const ops = catalog.groups.find(row => row.name === 'Ops')
  equal(ops.tools, ['t1'])
  equal(ops.onDemand, true)
  equal(ops.open, true)
  equal(ops.description, '运维')
  equal(catalog.open, ['Ops'])
  equal(catalog.lazy.map(row => row.server), ['srv'])
  equal(catalog.reserved, ['run_code'])
  equal(catalog.groups.find(row => row.name === 'Plain').onDemand, false)
})

// ---- 15. mergeSurface keeps non-MCP names ---------------------------------

await check('merge: a built-in tool name survives merge and counts as unreachable', () => {
  const merged = mergeSurface({ install: ['pwsh', 'run_code'], session: ['plain'], onDemand: ['t9'], known: ['pwsh', 't9'] })
  equal(merged.deny, ['pwsh', 't9'])
  equal(merged.unreachable, ['plain'])
  equal(merged.reserved, ['run_code'])
  assert(merged.counts.install === 1, 'install counted')
})
await check('merge: no known inventory keeps every maskable name', () => {
  equal(mergeSurface({ install: ['pwsh', 'run_code', 'tool_list'] }).deny, ['pwsh'])
})

// ---- report ---------------------------------------------------------------

console.log('')
console.log('group-on-demand probe: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
