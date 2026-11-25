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