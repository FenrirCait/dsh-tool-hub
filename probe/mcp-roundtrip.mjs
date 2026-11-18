/**
 * Round-trip check for lib/mcp.js: parse a patch, rewrite one MCP row's `config`, read it back.
 *
 * Usage:
 *   node probe/mcp-roundtrip.mjs              # runs against the built-in fixture
 *   node probe/mcp-roundtrip.mjs <patch.yml>  # runs against a real patch (read-only)
 *
 * The source file is never written: the preview goes to the OS temp directory.
 */
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMcpRows, replaceMcpConfig } from '../lib/mcp.js'

let pass = 0
const check = (label, condition, detail = '') => {
  if (condition === true) {
    pass += 1
    return
  }
  console.error(`FAIL  ${label}${detail === '' ? '' : `  — ${detail}`}`)
  process.exitCode = 1
}

const FIXTURE = `# >>> dsh-tool-hub:mcp fixture
- insert:
    - id: panel-mcp-fixture
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: fixture
        transport: stdio
        command: C:\\Program Files\\nodejs\\node.exe
        args:
          - C:\\tmp\\server.js
        env:
          FOO: bar
        cwd: ""
        toolCallTimeoutMs: 15000
        failOnStartupError: false
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10
      disabled: true
# <<< dsh-tool-hub:mcp fixture
- id: keep-me
  name: some-other-plugin
`

const source = process.argv[2]
const text = source === undefined ? FIXTURE : await readFile(source, 'utf8')
const rows = parseMcpRows(text)

check('the patch yields at least one MCP row', rows.length > 0, `rows=${rows.length}`)
if (rows.length === 0) {
  console.error('nothing to round-trip')
  process.exit(1)
}

const target = rows[0]
const next = structuredClone(target.config)
next.serverName = 'fixture-renamed'
next.args = ['C:\\a b\\index.js', '--flag']
next.env = { FOO: 'bar', PATH2: 'C:\\x' }
next.failOnStartupError = true

const rewritten = replaceMcpConfig(text, target.id, next)
const again = parseMcpRows(rewritten).find((row) => row.id === target.id)

check('the row survives the rewrite', again !== undefined)
check('the renamed server reads back', again?.config?.serverName === 'fixture-renamed')
check('an argument with a space stays one string', again?.config?.args?.[0] === 'C:\\a b\\index.js')
check('a windows path in env survives', again?.config?.env?.PATH2 === 'C:\\x')
check('nested reconnect survives untouched', JSON.stringify(again?.config?.reconnect ?? null) === JSON.stringify(target.config.reconnect ?? null))
check('failOnStartupError flips', again?.config?.failOnStartupError === true)
check('disabled keeps its original value', again?.disabled === target.disabled, `before=${String(target.disabled)} after=${String(again?.disabled)}`)
check('the row count does not change', parseMcpRows(rewritten).length === rows.length)

// Everything outside the row must be byte-identical.
const before = text.split(/\r?\n/)
const after = rewritten.split(/\r?\n/)
const expected = before.length - (target.configEnd - target.configStart) + (again === undefined ? 0 : again.configEnd - again.configStart)
check('only this row changed size', after.length === expected, `before=${before.length} after=${after.length} expected=${expected}`)
const head = before.slice(0, target.configStart).join('\n')
const headAfter = after.slice(0, target.configStart).join('\n')
check('the bytes before the config block are untouched', head === headAfter)

const dir = await mkdtemp(join(tmpdir(), 'tool-hub-roundtrip-'))
const preview = join(dir, 'mcp-rewrite-preview.yml')
await writeFile(preview, rewritten, 'utf8')

console.log(`\n${pass}/${pass + (process.exitCode === 1 ? 1 : 0)} checks passed`)
console.log(`preview: ${preview}`)
if (source === undefined) console.log('ran against the built-in fixture (pass a patch path to test a real file)')
