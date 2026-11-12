// A deliberately small MCP client used only for "test connection".
//
// It speaks just enough of the protocol to know whether a server starts and
// what tools it offers: initialize -> notifications/initialized -> tools/list.
// The real client is the host's @deepseek-ai/dsh-mcp-client; this file must not
// try to replace it, and it must never register anything with the host.

import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'dsh-tool-hub-probe', version: '1.3.0' }

export class ProbeError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

function killTree(child) {
  if (child === null || child === undefined) return
  try {
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      // child.kill() leaves grandchildren (npx, wrappers) behind on Windows.
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {})
      return
    }
    child.kill('SIGTERM')
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, 500).unref?.()
  } catch {}
}

function withTimeout(promise, ms, onTimeout) {
  let timer = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout()
      } catch {}
      reject(new ProbeError('probe-timeout', `the server did not answer within ${ms} ms`))
    }, ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

class StdioSession {
  constructor(child, timeoutMs) {
    this.child = child
    this.timeoutMs = timeoutMs
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    this.stderr = ''
    this.closed = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4096)
    })
    child.on('exit', (code, signal) => this.onExit(code, signal))
    child.on('error', (error) => this.fail(new ProbeError('probe-spawn', error.message)))
  }

  onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  onLine(line) {
    let message = null
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    if (message.id === undefined || message.id === null) return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    if (message.error !== undefined) {
      entry.reject(
        new ProbeError('probe-rpc', message.error?.message ?? 'the server returned an error', {
          rpc: message.error,
        }),
      )
      return
    }
    entry.resolve(message.result ?? {})
  }

  onExit(code, signal) {
    this.closed = true
    const tail = this.stderr.trim()
    const reason =
      tail === ''
        ? `the server exited before answering (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`
        : `the server exited before answering: ${tail.split('\n').slice(-4).join(' ')}`
    this.fail(new ProbeError('probe-exit', reason))
  }

  fail(error) {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }

  request(method, params) {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return withTimeout(
      new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        try {
          this.child.stdin.write(payload)
        } catch (error) {
          this.pending.delete(id)
          reject(new ProbeError('probe-write', error.message))
        }
      }),
      this.timeoutMs,
      () => killTree(this.child),
    )
  }

  notify(method, params) {
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch {}
  }

  close() {
    killTree(this.child)
  }
}

function normalizeEnv(env) {
  if (env === undefined || env === null) return process.env
  return { ...process.env, ...env }
}

function stdioTarget(config) {
  const command = typeof config.command === 'string' ? config.command.trim() : ''
  if (command === '') throw new ProbeError('probe-config', 'start command is empty')
  const args = Array.isArray(config.args) ? config.args.map((item) => String(item)) : []
  return {
    command,
    args,
    env: normalizeEnv(config.env),
    cwd: typeof config.cwd === 'string' && config.cwd.trim() !== '' ? config.cwd.trim() : undefined,
  }
}

async function probeStdio(config, timeoutMs) {
  const target = stdioTarget(config)
  let child = null
  try {
    child = spawn(target.command, target.args, {
      env: target.env,
      cwd: target.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    throw new ProbeError('probe-spawn', error.message)
  }
  const session = new StdioSession(child, timeoutMs)
  try {
    const init = await session.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    session.notify('notifications/initialized', {})
    const list = await session.request('tools/list', {})
    const tools = Array.isArray(list.tools) ? list.tools : []
    return {
      transport: 'stdio',
      protocolVersion: typeof init.protocolVersion === 'string' ? init.protocolVersion : PROTOCOL_VERSION,
      server: init.serverInfo ?? null,
      tools: tools.map((tool) => (typeof tool?.name === 'string' ? tool.name : '')).filter((name) => name !== ''),
    }
  } finally {
    session.close()
  }
}

// Streamable HTTP: one POST per JSON-RPC message; the reply is either JSON or
// an SSE stream whose `data:` lines carry the messages.
async function probeHttp(config, timeoutMs) {
  const url = typeof config.url === 'string' ? config.url.trim() : ''
  if (url === '') throw new ProbeError('probe-config', 'server URL is empty')
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (config.headers !== undefined && config.headers !== null && typeof config.headers === 'object') {
    for (const [key, value] of Object.entries(config.headers)) headers[key] = String(value)
  }
  let nextId = 1
  const send = async (method, params, notifyOnly = false) => {
    const id = nextId++
    const body = notifyOnly
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id, method, params }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (notifyOnly) return {}
    if (!response.ok) {
      throw new ProbeError('probe-http', `HTTP ${response.status} ${response.statusText}`.trim())
    }
    const type = response.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream')) {
      const text = await response.text()
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '') continue
        let message = null
        try {
          message = JSON.parse(data)
        } catch {
          continue
        }
        if (message?.id !== id) continue
        if (message.error !== undefined) {
          throw new ProbeError('probe-rpc', message.error?.message ?? 'the server returned an error', {
            rpc: message.error,
          })
        }
        return message.result ?? {}
      }
      throw new ProbeError('probe-http', 'the event stream ended without a reply')
    }
    const message = await response.json()
    if (message?.error !== undefined) {
      throw new ProbeError('probe-rpc', message.error?.message ?? 'the server returned an error', {
        rpc: message.error,
      })
    }
    return message?.result ?? {}
  }
  const init = await send('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  })
  await send('notifications/initialized', {}, true)
  const list = await send('tools/list', {})
  const tools = Array.isArray(list.tools) ? list.tools : []
  return {
    transport: 'http',
    protocolVersion: typeof init.protocolVersion === 'string' ? init.protocolVersion : PROTOCOL_VERSION,
    server: init.serverInfo ?? null,
    tools: tools.map((tool) => (typeof tool?.name === 'string' ? tool.name : '')).filter((name) => name !== ''),
  }
}

// `transport` accepts the values the panel writes: stdio, sse, streamable-http.
export async function probeServer(config, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 12000
  const started = Date.now()
  const transport = typeof config?.transport === 'string' ? config.transport : 'stdio'
  if (transport === 'stdio') {
    const result = await probeStdio(config, timeoutMs)
    return { ...result, ms: Date.now() - started }
  }
  if (transport === 'streamable-http' || transport === 'http') {
    const result = await probeHttp(config, timeoutMs)
    return { ...result, ms: Date.now() - started }
  }
  throw new ProbeError('probe-unsupported', `transport "${transport}" cannot be tested from here`, {
    transport,
  })
}

