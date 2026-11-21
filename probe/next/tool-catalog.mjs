#!/usr/bin/env node
/**
 * hub_tools: the model's door into lazily hidden MCP tools.
 *
 * Built dist is imported so the probe exercises the same code the host registers; the
 * dispatcher is a recorder, so every branch is checked without a live host.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

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

if (failures.length > 0) {
  console.error('tool-catalog probe: ' + failures.length + ' failed of ' + checks)
  for (const failure of failures) console.error('  FAIL ' + failure)
  process.exit(1)
}
console.log('tool-catalog probe: ' + checks + ' checks passed')
