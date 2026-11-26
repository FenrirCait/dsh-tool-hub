#!/usr/bin/env node
/**
 * mcp-identity: duplicate patch ids stay addressable, and rows inside another panel's managed
 * block are marked read-only. This is the regression guard for dsh-skill-mcp-panel's #46/#70
 * ownership lesson.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const mcp = await import(pathToFileURL(join(distRoot, 'domains', 'mcp.js')).href)
const snapshotHost = await import(pathToFileURL(join(distRoot, 'host', 'snapshot.js')).href)

let pass = 0
let fail = 0
function check(name, run) {
  try {
    const detail = run()
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

const duplicate = [
  '- insert:',
  '  - id: dup',
  '    name: "@deepseek-ai/dsh-mcp-client"',
  '    config:',
  '      serverName: first',
  '  - id: dup',
  '    name: "@deepseek-ai/dsh-mcp-client"',
  '    config:',
  '      serverName: second',
].join('\n') + '\n'

const managed = [
  '# >>> dsh-skill-mcp-panel:mcp:begin',
  '- insert:',
  '  - id: panel-mcp-x',
  '    name: "@deepseek-ai/dsh-mcp-client"',
  '    config:',
  '      serverName: x',
  '# <<< dsh-skill-mcp-panel:mcp:end',
  '- id: ours',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config:',
  '    serverName: ours',
].join('\n') + '\n'

check('duplicate ids get file-order occurrences', () => {
  equal(mcp.parseMcpRows(duplicate).map(row => row.occurrence), [0, 1])
})

check('replacing occurrence 1 leaves occurrence 0 alone', () => {
  const next = mcp.replaceMcpConfig(duplicate, 'dup', { serverName: 'changed' }, 1)
  assert(next.includes('serverName: first'), 'first row must stay first')
  assert(next.includes('serverName: changed'), 'second row must change')
  assert(next.indexOf('serverName: first') < next.indexOf('serverName: changed'), 'file order changed')
})

check('removing occurrence 1 keeps occurrence 0', () => {
  const next = mcp.removeMcpRow(duplicate, 'dup', 1)
  assert(next.includes('serverName: first'), 'first row must stay')
  assert(!next.includes('serverName: second'), 'second row must be removed')
})

check('managed block marks its row and leaves the outside row ours', () => {
  const rows = mcp.parseMcpRows(managed)
  equal(rows.map(row => [row.id, row.managedBy]), [
    ['panel-mcp-x', 'dsh-skill-mcp-panel:mcp'],
    ['ours', null],
  ])
})

check('a top-level row inside a closed block is still owned', () => {
  const top = [
    '# >>> dsh-skill-mcp-panel:mcp:begin',
    '- id: panel-mcp-top',
    '  name: "@deepseek-ai/dsh-mcp-client"',
    '  config:',
    '    serverName: top',
    '# <<< dsh-skill-mcp-panel:mcp:end',
  ].join('\n') + '\n'
  equal(mcp.parseMcpRows(top).map(row => [row.id, row.managedBy]), [['panel-mcp-top', 'dsh-skill-mcp-panel:mcp']])
})

check('an unclosed managed block also marks rows read-only', () => {
  const unclosed = [
    '# >>> dsh-skill-mcp-panel:mcp:begin',
    '- insert:',
    '  - id: panel-mcp-open',
    '    name: "@deepseek-ai/dsh-mcp-client"',
    '    config:',
    '      serverName: open',
    '- id: ours-open',
    '  name: "@deepseek-ai/dsh-mcp-client"',
    '  config:',
    '    serverName: ours-open',
  ].join('\n') + '\n'
  equal(mcp.parseMcpRows(unclosed).map(row => [row.id, row.managedBy]), [
    ['panel-mcp-open', 'dsh-skill-mcp-panel:mcp'],
    ['ours-open', 'dsh-skill-mcp-panel:mcp'],
  ])
})

check('CRLF managed blocks keep their owner', () => {
  equal(mcp.parseMcpRows(managed.replace(/\n/g, '\r\n')).map(row => [row.id, row.managedBy]), [
    ['panel-mcp-x', 'dsh-skill-mcp-panel:mcp'],
    ['ours', null],
  ])
})

check('pairMcpRows resolves duplicate loader rows by occurrence', () => {
  const duplicate = [
    '# >>> dsh-skill-mcp-panel:mcp:begin',
    '- insert:',
    '  - id: dup-managed',
    '    name: "@deepseek-ai/dsh-mcp-client"',
    '    config:',
    '      serverName: inside',
    '# <<< dsh-skill-mcp-panel:mcp:end',
    '- id: dup-managed',
    '  name: "@deepseek-ai/dsh-mcp-client"',
    '  config:',
    '    serverName: outside',
  ].join('\n') + '\n'
  const rows = mcp.parseMcpRows(duplicate)
  const paired = mcp.pairMcpRows(rows, [
    { id: 'loader-inside', moduleName: '@deepseek-ai/dsh-mcp-client', patchId: 'dup-managed', enabled: true, manageable: true },
    { id: 'loader-outside', moduleName: '@deepseek-ai/dsh-mcp-client', patchId: 'dup-managed', enabled: true, manageable: true },
  ])
  equal(paired.pairs.map(pair => [pair.loader?.id, pair.row.occurrence, pair.row.managedBy]), [
    ['loader-inside', 0, 'dsh-skill-mcp-panel:mcp'],
    ['loader-outside', 1, null],
  ])
})

check('patch-only MCP rows become MCP plugin rows', () => {
  const row = { id: 'patch:x', patchId: 'x', entryId: null, occurrence: 1, managedBy: null, readOnlyReason: null, name: 'x', config: { serverName: 'x' }, secretKeys: { env: [], headers: [] }, transport: 'stdio', command: 'node', url: '', editable: true }
  const [plugin] = snapshotHost.patchOnlyMcpPlugins([row])
  equal([plugin.id, plugin.mcp, plugin.mcpPatchId, plugin.mcpOccurrence, plugin.manageable, plugin.mcpEditable], ['mcp:x:1', true, 'x', 1, false, true])
})

check('mcpRowsByEntryId never lets a patch-only display id shadow a loader entry', () => {
  const rows = [
    { id: 'patch:x', entryId: 'patch:x', patchId: 'x', occurrence: 0 },
    { id: 'patch:x', entryId: null, patchId: 'x', occurrence: 1 },
  ]
  const indexed = mcp.mcpRowsByEntryId(rows)
  equal(indexed.size, 1)
  equal(indexed.get('patch:x').entryId, 'patch:x')
})

check('mergeMcpRows carries occurrence and read-only owner', () => {
  const rows = mcp.mergeMcpRows(mcp.parseMcpRows(managed), [
    { id: 'loader-x', moduleName: '@deepseek-ai/dsh-mcp-client', patchId: 'panel-mcp-x', enabled: true, manageable: true },
    { id: 'loader-ours', moduleName: '@deepseek-ai/dsh-mcp-client', patchId: 'ours', enabled: true, manageable: true },
  ])
  equal(rows.map(row => [row.id, row.occurrence, row.managedBy, row.editable]), [
    ['loader-x', 0, 'dsh-skill-mcp-panel:mcp', false],
    ['loader-ours', 0, null, true],
  ])
})

check('invalid occurrence falls back to the first row', () => {
  equal(mcp.occurrenceOf(undefined), 0)
  equal(mcp.occurrenceOf(-2), 0)
  equal(mcp.occurrenceOf(3), 3)
})

console.log('\nmcp-identity probe: ' + pass + ' PASS / ' + fail + ' FAIL')
if (fail > 0) process.exit(1)