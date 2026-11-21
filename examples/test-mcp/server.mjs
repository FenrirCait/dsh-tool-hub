#!/usr/bin/env node
/**
 * Tiny dependency-free MCP server for testing lazy loading.
 *
 * Run: node server.mjs <demo-fs|demo-math|demo-sys>
 * Speaks newline-delimited JSON-RPC on stdio (MCP stdio transport).
 */
import { createInterface } from 'node:readline'
import { hostname, platform } from 'node:os'

const mode = process.argv[2] ?? 'demo-sys'
const NAME = mode
const VERSION = '1.0.0'
const protocolVersion = '2024-11-05'

const TOOLS = {
  'demo-fs': [
    {
      name: 'demo_files',
      description: 'List three fake demo files (no real filesystem access).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => 'demo/a.txt\ndemo/b.md\ndemo/c.json',
    },
    {
      name: 'demo_read',
      description: 'Read one fake demo file by name.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'a.txt, b.md or c.json' } }, required: ['name'], additionalProperties: false },
      run: args => ({ 'a.txt': 'alpha', 'b.md': '# beta', 'c.json': '{ "gamma": 3 }' })[args.name] ?? 'unknown demo file: ' + String(args.name),
    },
  ],
  'demo-math': [
    {
      name: 'demo_add',
      description: 'Add two numbers.',
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
      run: args => String(Number(args.a) + Number(args.b)),
    },
    {
      name: 'demo_slow_add',
      description: 'Add two numbers after a 1 second delay (tests loading feedback).',
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
      slow: true,
      run: args => String(Number(args.a) + Number(args.b)),
    },
  ],
  'demo-sys': [
    {
      name: 'demo_time',
      description: 'Current time in ISO 8601.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => new Date().toISOString(),
    },
    {
      name: 'demo_host',
      description: 'Hostname and platform of the machine running this MCP server.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => JSON.stringify({ hostname: hostname(), platform: platform(), pid: process.pid }),
    },
  ],
}[mode]

if (TOOLS === undefined) {
  process.stderr.write('unknown demo mode: ' + mode + '\n')
  process.exit(2)
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function callTool(name, args) {
  const tool = TOOLS.find(item => item.name === name)
  if (tool === undefined) return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true }
  const value = tool.run(args ?? {})
  if (tool.slow === true) await new Promise(resolve => { setTimeout(resolve, 1000) })
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  }
  catch {
    return
  }
  const { id, method, params } = message
  if (method === 'initialize') {
    result(id, {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: NAME, version: VERSION },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') {
    result(id, {})
    return
  }
  if (method === 'tools/list') {
    result(id, { tools: TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) })
    return
  }
  if (method === 'tools/call') {
    void callTool(params?.name, params?.arguments).then(value => { result(id, value) })
    return
  }
  if (typeof id !== 'undefined') error(id, -32601, 'method not found: ' + String(method))
})
lines.on('close', () => { process.exit(0) })
