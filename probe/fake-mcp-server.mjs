/**
 * Minimal MCP server over stdio, for the sandbox probe only.
 *
 * Just enough of the protocol for the host's client to connect and enumerate tools:
 * `initialize`, `tools/list`, `ping`. Newline-delimited JSON-RPC, no batching, no auth.
 */
const out = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)
const tools = [
  { name: 'alpha', description: 'fixture tool alpha', inputSchema: { type: 'object', properties: {} } },
  { name: 'beta', description: 'fixture tool beta', inputSchema: { type: 'object', properties: {} } },
]

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let cut = buffer.indexOf('\n')
  while (cut !== -1) {
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (line !== '') handle(line)
    cut = buffer.indexOf('\n')
  }
})

function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  if (id === undefined || id === null) return // notification
  if (method === 'initialize') {
    out({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tool-hub-probe', version: '0.0.1' },
      },
    })
    return
  }
  if (method === 'tools/list') {
    out({ jsonrpc: '2.0', id, result: { tools } })
    return
  }
  if (method === 'ping') {
    out({ jsonrpc: '2.0', id, result: {} })
    return
  }
  out({ jsonrpc: '2.0', id, error: { code: -32601, message: `no such method: ${method}` } })
}
