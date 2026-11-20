#!/usr/bin/env node
/**
 * hub_tools: the model's door into lazily hidden MCP tools.
 *
 * Built dist is imported so the probe exercises the same code the host registers; the
 * dispatcher is a recorder, so every branch is checked without a live host.
 */
import { createCatalogTool } from '../../dist/host/catalog-tool.js'

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
      return { ok: true, op }
    },
  }
}

const snapshot = {
  tools: [
    { name: 'mcp__alpha__one', server: 'alpha', enabled: true, lazy: false },
    { name: 'mcp__alpha__two', server: 'alpha', enabled: false, lazy: true },
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
check('list-server-total', alpha.total === 2, String(alpha.total))
check('list-loaded-count', alpha.loaded === 1, String(alpha.loaded))
check('list-tool-flags', alpha.tools.some(row => row.name === 'mcp__alpha__two' && row.lazy === true && row.enabled === false))
check('list-falls-back-to-name', listed.servers.some(row => row.server === 'beta'))

calls.length = 0
const enabled = await tool.execute({ action: 'enable', server: 'alpha' })
check('enable-server-unlazies', calls[0]?.op === 'lazy.set' && calls[0].payload.server === 'alpha' && calls[0].payload.on === false, JSON.stringify(calls[0]))

calls.length = 0
await tool.execute({ action: 'disable', server: 'alpha' })
check('disable-server-lazies', calls[0]?.op === 'lazy.set' && calls[0].payload.on === true, JSON.stringify(calls[0]))

calls.length = 0
await tool.execute({ action: 'enable', names: ['mcp__alpha__two', ''] })
check('enable-names-loads', calls[0]?.op === 'lazy.load' && calls[0].payload.load === true && calls[0].payload.names.length === 1, JSON.stringify(calls[0]))

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

if (failures.length > 0) {
  console.error('tool-catalog probe: ' + failures.length + ' failed of ' + checks)
  for (const failure of failures) console.error('  FAIL ' + failure)
  process.exit(1)
}
console.log('tool-catalog probe: ' + checks + ' checks passed')
