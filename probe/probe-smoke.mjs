// Exercises lib/probe.js against real child processes: a working MCP server, a
// server that never answers, and a command that does not exist.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ProbeError, probeServer } from '../lib/probe.js'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-mcp-server.mjs')

let passed = 0
let failed = 0
function check(name, condition, detail) {
    if (condition === true) {
        passed += 1
        console.log(`  ok   ${name}`)
    }
    else {
        failed += 1
        console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
    }
}

async function expectError(name, run, code) {
    try {
        await run()
        check(name, false, 'resolved instead of throwing')
    }
    catch (error) {
        const actual = error instanceof ProbeError ? error.code : 'not-a-probe-error'
        check(name, actual === code, `code=${actual} message=${error.message}`)
    }
}

console.log('probe smoke')

const config = {
    transport: 'stdio',
    command: process.execPath,
    args: [fake],
    env: { PROBE_MARKER: 'yes' },
    toolCallTimeoutMs: 15000,
}

const good = await probeServer(config, { timeoutMs: 10000 })
check('tools/list returns two tools', Array.isArray(good.tools) && good.tools.length === 2, JSON.stringify(good.tools))
check('tool names', good.tools.join(',') === 'alpha,beta', good.tools.join(','))
check('server info', good.server?.name === 'tool-hub-probe', JSON.stringify(good.server))
check('transport echoed', good.transport === 'stdio', good.transport)
check('duration reported', Number.isFinite(good.ms) && good.ms >= 0, String(good.ms))

await expectError('a silent server times out', () => probeServer({
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60000)'],
}, { timeoutMs: 1500 }), 'probe-timeout')

await expectError('a missing command fails', () => probeServer({
    transport: 'stdio',
    command: 'definitely-not-a-real-binary-xyz',
    args: [],
}, { timeoutMs: 5000 }), 'probe-spawn')

await expectError('a server that exits fails', () => probeServer({
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', 'process.stderr.write("boom"); process.exit(3)'],
}, { timeoutMs: 5000 }), 'probe-exit')

await expectError('an empty command is refused', () => probeServer({ transport: 'stdio', command: '  ' }), 'probe-config')

await expectError('sse is not testable here', () => probeServer({ transport: 'sse', url: 'http://127.0.0.1:1/sse' }), 'probe-unsupported')

console.log(`\n${passed}/${passed + failed} passed`)
if (failed > 0) process.exitCode = 1
