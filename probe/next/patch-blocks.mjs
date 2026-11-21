#!/usr/bin/env node
/**
 * patch-blocks: read the managed-block layout of cordis.patch.yml and insert outside every block.
 * The fixtures mirror dsh-skill-mcp-panel's real markers, including the foreign rows that made it
 * warn: another editor appends a row past the end marker, and the next serialization lands inside.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const { scanPatchBlocks, insertOutsideBlocks } = await import(pathToFileURL(join(distRoot, 'core', 'patch-blocks.js')).href)

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

const BEGIN = '# >>> dsh-skill-mcp-panel:mcp:begin'
const END = '# <<< dsh-skill-mcp-panel:mcp:end'

const withBlock = [
  '# top comment',
  '- id: web',
  '  disabled: false',
  '',
  BEGIN,
  '- id: panel-mcp-one',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  disabled: false',
  '- id: ui-theme',
  '  disabled: false',
  '- id: mcp-dsh-computer-use-win',
  '  disabled: false',
  END,
  '- id: dsh-context',
  '  disabled: false',
].join('\n')

const scan = scanPatchBlocks(withBlock)
check('scan: rows and block count', () => {
  assert(scan.rows === 5, 'rows ' + scan.rows)
  assert(scan.blocks.length === 1, 'blocks ' + scan.blocks.length)
  assert(scan.unclosed.length === 0, 'unclosed')
  return scan.rows + ' rows, ' + scan.blocks.length + ' block'
})
check('scan: block rows in file order', () => equal(scan.blocks[0].rows, ['panel-mcp-one', 'ui-theme', 'mcp-dsh-computer-use-win']))
check('scan: foreign rows are the ones the owner prefix does not cover', () => equal(scan.blocks[0].foreign, ['ui-theme', 'mcp-dsh-computer-use-win']))
check('scan: a row outside the block is not foreign', () => assert(!scan.blocks[0].foreign.includes('dsh-context'), 'dsh-context is outside'))
check('scan: foreign total adds up', () => equal(scan.foreignTotal, 2))
check('scan: known owner prefix', () => assert(scan.blocks[0].known === true, 'known'))

const unknown = scanPatchBlocks(['# >>> someone-else:begin', '- id: whatever', '# <<< someone-else:end'].join('\n'))
check('scan: unknown owner lists rows but calls none foreign', () => {
  assert(unknown.blocks.length === 1)
  assert(unknown.blocks[0].known === false)
  equal(unknown.blocks[0].rows, ['whatever'])
  equal(unknown.blocks[0].foreign, [])
})

const noBlock = scanPatchBlocks('- id: a\n  disabled: true\n- id: b\n  disabled: false\n')
check('scan: a file without blocks has no foreign rows', () => {
  equal(noBlock.rows, 2)
  equal(noBlock.blocks, [])
  equal(noBlock.foreignTotal, 0)
})

const unclosed = scanPatchBlocks(BEGIN + '\n- id: panel-mcp-one\n')
check('scan: an unclosed block is reported', () => equal(unclosed.unclosed, ['dsh-skill-mcp-panel:mcp']))

const appended = insertOutsideBlocks(withBlock, '- id: "web-search-free"\n  disabled: true')
check('insert: new row goes before the first begin marker', () => {
  const lines = appended.split('\n')
  const at = lines.indexOf('- id: "web-search-free"')
  const begin = lines.indexOf(BEGIN)
  assert(at >= 0 && begin > at, 'row at ' + at + ', begin ' + begin)
  return 'line ' + at + ' < begin ' + begin
})
check('insert: foreign rows are byte-identical afterwards', () => {
  for (const row of ['- id: ui-theme', '- id: mcp-dsh-computer-use-win', '- id: dsh-context', END]) {
    assert(appended.includes(row), 'missing ' + row)
  }
  const again = scanPatchBlocks(appended)
  equal(again.blocks[0].foreign, ['ui-theme', 'mcp-dsh-computer-use-win'])
})
check('insert: no block means append at the end', () => {
  const text = '- id: a\n  disabled: false\n'
  const next = insertOutsideBlocks(text, '- id: b\n  disabled: true')
  assert(next.startsWith(text), 'original prefix kept')
  assert(next.trimEnd().endsWith('- id: b\n  disabled: true'), 'appended: ' + JSON.stringify(next))
})
check('insert: empty file gets the row alone', () => equal(insertOutsideBlocks('', '- id: x\n  disabled: true'), '- id: x\n  disabled: true\n'))

console.log('\npatch-blocks probe: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
