#!/usr/bin/env node
/**
 * hub_tools: the model's door into lazily hidden MCP tools.
 *
 * Built dist is imported so the probe exercises the same code the host registers; the
 * dispatcher is a recorder, so every branch is checked without a live host.
 *
 * The second half covers the per-tool deny reasons (task-42): the layer reader is a pure function,
 * and a fake env with only the services a snapshot reads runs the real buildSnapshot, so the rows
 * the panel receives are asserted end to end.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The built host, or a copy when TOOL_HUB_DIST points at one (same override as tool-mask.mjs).
const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const { createCatalogTool } = await import(pathToFileURL(join(distRoot, 'host', 'catalog-tool.js')).href)
const { createGroupTool } = await import(pathToFileURL(join(distRoot, 'host', 'group-tool.js')).href)

let checks = 0
const failures = []
function check(name, ok, detail) {
  checks += 1
  if (!ok) failures.push(detail === undefined ? name : name + ' — ' + detail)
}

const calls = []
function dispatcherWith(snapshot) {
  return {
    async execute(op, payload) {
      calls.push({ op, payload })
      if (op === 'snapshot') return snapshot
      if (op === 'lazy.state') return { servers: ['alpha'], loaded: ['mcp__alpha__one'], sessions: { s1: ['mcp__alpha__three'] } }
      return { ok: true, op }
    },
  }
}

const snapshot = {
  tools: [
    { name: 'mcp__alpha__one', server: 'alpha', enabled: true, lazy: false },
    { name: 'mcp__alpha__two', server: 'alpha', enabled: false, lazy: true, lazyHidden: true },
    { name: 'mcp__alpha__three', server: 'alpha', enabled: true, lazy: true, lazyHidden: true },
    { name: 'mcp__beta__one', server: null, enabled: true, lazy: false },
  ],
}
const dispatcher = dispatcherWith(snapshot)
const tool = createCatalogTool(dispatcher)

check('definition-name', tool.name === 'hub_tools', tool.name)
check('definition-description', /lazily loaded MCP tools/.test(tool.description))
check('definition-actions', JSON.stringify(tool.parameters.action.enum) === JSON.stringify(['list', 'enable', 'disable']))
check('definition-render', JSON.stringify(tool.output.render({}, { a: 1 })) === JSON.stringify([{ type: 'text', text: '{"a":1}' }]))

const listed = await tool.execute({ action: 'list' })
check('list-groups-servers', listed.servers.length === 2, String(listed.servers.length))
const alpha = listed.servers.find(row => row.server === 'alpha')
check('list-server-total', alpha.total === 3, String(alpha.total))
check('list-loaded-count', alpha.loaded === 1, String(alpha.loaded))
check('list-hidden-count', Array.isArray(alpha.hidden) && alpha.hidden.includes('mcp__alpha__two'), JSON.stringify(alpha.hidden))
check('list-effective-deny', Array.isArray(alpha.effectiveDeny) && alpha.effectiveDeny.includes('mcp__alpha__two'), JSON.stringify(alpha.effectiveDeny))
check('list-tool-flags', alpha.tools.some(row => row.name === 'mcp__alpha__two' && row.lazy === true && row.enabled === false))
check('list-falls-back-to-name', listed.servers.some(row => row.server === 'beta'))

const sessionList = await tool.execute({ action: 'list' }, { agent: { session: { id: 's1' } } })
const sessionAlpha = sessionList.servers.find(row => row.server === 'alpha')
check('list-session-scope', sessionAlpha.loaded === 2 && sessionAlpha.hidden.length === 1, JSON.stringify(sessionAlpha))

calls.length = 0
const enabled = await tool.execute({ action: 'enable', server: 'alpha' }, { agent: { session: { id: 's1' } } })
check('enable-server-loads', calls[0]?.op === 'lazy.load' && calls[0].payload.server === 'alpha' && calls[0].payload.load === true, JSON.stringify(calls[0]))

calls.length = 0
await tool.execute({ action: 'disable', server: 'alpha' })
check('disable-server-unloads', calls[0]?.op === 'lazy.unload' && calls[0].payload.server === 'alpha' && calls[0].payload.load === false, JSON.stringify(calls[0]))

calls.length = 0
await tool.execute({ action: 'enable', names: ['mcp__alpha__two', ''] }, { agent: { session: { id: 's1' } } })
check('enable-names-loads', calls[0]?.op === 'lazy.load' && calls[0].payload.load === true && calls[0].payload.names.length === 1 && calls[0].payload.sessionId === 's1', JSON.stringify(calls[0]))

calls.length = 0
await tool.execute({ action: 'disable', names: ['mcp__alpha__two'] })
check('disable-names-unloads', calls[0]?.op === 'lazy.unload' && calls[0].payload.load === false, JSON.stringify(calls[0]))

check('enable-returns-dispatch', enabled !== undefined && enableOk(enabled))
function enableOk(value) { return value !== null && typeof value === 'object' }

let missing = ''
try { await tool.execute({ action: 'enable' }) } catch (error) { missing = String(error.message) }
check('missing-target-throws', /needs a server or names/.test(missing), missing)

let bad = ''
try { await tool.execute({ action: 'nope' }) } catch (error) { bad = String(error.message) }
check('bad-action-throws', /list, enable or disable/.test(bad), bad)

// ---- tool_list: the door into an on-demand group (G10) --------------------

const groupCalls = []
const groupTool = createGroupTool({
  async execute(op, payload) {
    groupCalls.push({ op, payload })
    if (payload.group === 'Nope') throw Object.assign(new Error('no group named "Nope"'), { code: 'unknown-group' })
    return { group: payload.group, tools: ['mcp__alpha__one'], opened: true }
  },
})
check('tool_list-definition', groupTool.name === 'tool_list' && groupTool.parameters.group.required === true
  && /on-demand/.test(groupTool.description), groupTool.name)
const opened = await groupTool.execute({ group: 'Ops' }, { agent: { session: { id: 's1' } } })
check('tool_list-open', groupCalls.length === 1 && groupCalls[0].op === 'session.open'
  && groupCalls[0].payload.sessionId === 's1' && groupCalls[0].payload.group === 'Ops', JSON.stringify(groupCalls[0]))
check('tool_list-render', JSON.stringify(groupTool.output.render({}, opened)) === JSON.stringify([{ type: 'text', text: JSON.stringify(opened) }]))
let unknown = ''
try { await groupTool.execute({ group: 'Nope' }, { agent: { session: { id: 's1' } } }) } catch (error) { unknown = String(error.message) }
check('tool_list-unknown', /no group named "Nope"/.test(unknown), unknown)
let noAgent = ''
try { await groupTool.execute({ group: 'Ops' }, { agent: {} }) } catch (error) { noAgent = String(error.message) }
check('tool_list-no-agent', /needs an agent session/.test(noAgent), noAgent)
let noGroup = ''
try { await groupTool.execute({}, { agent: { session: { id: 's1' } } }) } catch (error) { noGroup = String(error.message) }
check('tool_list-no-group', /needs a group name/.test(noGroup), noGroup)
// ---- deny reasons: why a row is missing (task-42) -------------------------
// One fixture per layer: the answer must name the layer, not a label the panel invented.

const surface = await import(pathToFileURL(join(distRoot, 'domains', 'tool-surface.js')).href)

const reasonState = {
  version: 2,
  groups: [],
  collections: [],
  presets: [],
  toolDeny: ['mcp__alpha__two', 'todo_write', 'task_get'],
  auto: { appliedAt: null },
  sessions: { s1: ['mcp__beta__one', 'run_code'] },
  sessionAllow: {},
  workspaces: { 'D:/work': ['todo_write'] },
  subagentAllow: [],
  subagentDeny: ['task_get'],
  scenes: {},
  mode: null,
  settings: {},
  modules: { 'tool-surface': { servers: ['gamma'], loaded: [], sessions: {}, loadedAt: {} } },
  extensions: { enabled: [] },
}
const reasonGroups = [
  { id: 'g1', name: 'Ops', members: [], tools: ['mcp__alpha__three'], onDemand: true },
  { id: 'g2', name: 'Idle', members: [], tools: ['mcp__alpha__one'], onDemand: false },
]
const reasonPresets = [{ name: 'P', enabled: { plugin: [], skill: [], tool: [] }, toolPolicy: { disabled: ['mcp__alpha__two', 'todo_write'], groups: [] } }]
const reasonKnown = ['mcp__alpha__one', 'mcp__alpha__two', 'mcp__alpha__three', 'mcp__beta__one', 'mcp__gamma__one', 'todo_write', 'task_get', 'run_code']
const reasons = surface.toolDenyReasons({ state: reasonState, groups: reasonGroups, presets: reasonPresets, known: reasonKnown })
const reasonsOf = name => (reasons.get(name) ?? []).join(',')

check('reasons-enum-order', surface.TOOL_DENY_REASONS.join(',') === 'install,scope,preset,onDemand,lazy', surface.TOOL_DENY_REASONS.join(','))
check('reasons-install-preset', reasonsOf('mcp__alpha__two') === 'install,preset', reasonsOf('mcp__alpha__two'))
check('reasons-scope-session', reasonsOf('mcp__beta__one') === 'scope', reasonsOf('mcp__beta__one'))
check('reasons-scope-workspace', reasonsOf('todo_write') === 'install,scope', reasonsOf('todo_write'))
check('reasons-preset-needs-mcp', !reasonsOf('todo_write').includes('preset'), 'non-MCP rows never carry a preset badge: ' + reasonsOf('todo_write'))
check('reasons-scope-subagent', reasonsOf('task_get') === 'install,scope', reasonsOf('task_get'))
check('reasons-on-demand', reasonsOf('mcp__alpha__three') === 'onDemand', reasonsOf('mcp__alpha__three'))
check('reasons-lazy', reasonsOf('mcp__gamma__one') === 'lazy', reasonsOf('mcp__gamma__one'))
check('reasons-clean-row-absent', !reasons.has('mcp__alpha__one') && !reasons.has('run_code'), [...reasons.keys()].join(','))

const allState = { ...reasonState, toolDeny: ['mcp__gamma__one'], sessions: { s1: ['mcp__gamma__one'] }, workspaces: {}, subagentDeny: [] }
const all = surface.toolDenyReasons({
  state: allState,
  groups: [{ id: 'g1', name: 'Ops', members: [], tools: ['mcp__gamma__one'], onDemand: true }],
  presets: [{ name: 'P', enabled: { plugin: [], skill: [], tool: [] }, toolPolicy: { disabled: ['mcp__gamma__one'], groups: [] } }],
  known: ['mcp__gamma__one'],
})
check('reasons-all-layers', (all.get('mcp__gamma__one') ?? []).join(',') === 'install,scope,preset,onDemand,lazy', (all.get('mcp__gamma__one') ?? []).join(','))

const scopeNames = surface.scopeDenyNames({ sessions: { a: ['x', 'y'], b: ['x'] }, workspaces: { w: ['z'] }, subagentDeny: ['q', 'run_code'] })
check('reasons-scope-union', scopeNames.join(',') === 'x,y,z,q', scopeNames.join(','))
check('reasons-primitive', surface.denyReasonsOf('a', { install: ['a'], lazy: ['a'] }).join(',') === 'install,lazy'
  && surface.denyReasonsOf('', { install: [''] }).length === 0
  && surface.denyReasonsOf('b', {}).length === 0)

// The rows the panel actually receives: the real buildSnapshot over a fake env.
const { buildSnapshot } = await import(pathToFileURL(join(distRoot, 'host', 'snapshot.js')).href)
const toolsService = {
  view: () => ({ knownNames: [...reasonKnown], restrictableNames: [...reasonKnown] }),
  definitions: () => reasonKnown.map(name => ({ name })),
}
// The snapshot reads groups and presets from state, exactly as the host's state.json carries them.
const snapshotState = { ...reasonState, groups: reasonGroups, presets: reasonPresets }
const snapshotEnv = {
  state: snapshotState,
  services: {
    get(name) {
      if (name === 'pluginManager') return { listPlugins: async () => [], listBundles: async () => [] }
      if (name === 'tools') return toolsService
      return undefined
    },
  },
  save: async () => null,
  log: () => {},
  now: () => Date.now(),
}
let hubSnapshot = null
let snapshotError = ''
process.env.TOOL_HUB_SKILL_ROOTS = join(tmpdir(), 'tool-hub-probe-no-skills')
try {
  hubSnapshot = await buildSnapshot({ env: snapshotEnv, registry: { list: () => [] } })
}
catch (error) {
  snapshotError = String(error instanceof Error ? error.message : error)
}
finally {
  delete process.env.TOOL_HUB_SKILL_ROOTS
}
const rows = hubSnapshot === null ? [] : hubSnapshot.tools
const rowOf = name => rows.find(row => row.name === name) ?? { denyReasons: [], name }

check('snapshot-built', snapshotError === '' && rows.length === reasonKnown.length, snapshotError === '' ? String(rows.length) + ' rows' : snapshotError)
check('snapshot-rows-deny-reasons', rowOf('mcp__alpha__two').denyReasons.join(',') === 'install,preset'
  && rowOf('mcp__beta__one').denyReasons.join(',') === 'scope'
  && rowOf('mcp__alpha__three').denyReasons.join(',') === 'onDemand'
  && rowOf('mcp__gamma__one').denyReasons.join(',') === 'lazy', JSON.stringify(rows.map(row => [row.name, row.denyReasons])))
check('snapshot-rows-flags-unchanged', rowOf('mcp__alpha__two').enabled === false
  && rowOf('mcp__gamma__one').lazyHidden === true
  && rowOf('mcp__gamma__one').effective === false
  && rowOf('mcp__alpha__one').effective === true, JSON.stringify(rowOf('mcp__gamma__one')))
check('snapshot-rows-clean', rowOf('mcp__alpha__one').denyReasons.length === 0 && rowOf('run_code').denyReasons.length === 0, JSON.stringify(rowOf('run_code')))

if (failures.length > 0) {
  console.error('tool-catalog probe: ' + failures.length + ' failed of ' + checks)
  for (const failure of failures) console.error('  FAIL ' + failure)
  process.exit(1)
}
console.log('tool-catalog probe: ' + checks + ' checks passed')
