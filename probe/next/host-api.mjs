#!/usr/bin/env node
/**
 * probe/next/host-api.mjs - the 2.0 host half, checked from outside.
 *
 * Three surfaces, all through the compiled output:
 *   1. the HTTP gates on both path prefixes, with a fake cordis context in front of a real
 *      node:http server (the fake webServer service holds the handlers, the server dispatches);
 *   2. the dispatch contract: registry lookup, unknown ops, both confirmation gates, the audit
 *      line in history.jsonl, the 2MB truncation, and env.save going through core/io;
 *   3. the ten doctor checks, including a real mount heartbeat and the host-contract report.
 *
 * No third-party libraries. Run 'npm run build:host' first: the 2.0 sources are TypeScript, and
 * this probe imports dist/. Exit code is 1 when any check fails; every line is PASS or FAIL.
 */
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = (...parts) => pathToFileURL(join(here, '..', '..', 'dist', ...parts)).href

let routes
let dispatchModule
let diagnostics
let Registry
let emptyState
try {
  routes = await import(dist('host', 'routes.js'))
  dispatchModule = await import(dist('host', 'dispatch.js'))
  diagnostics = await import(dist('host', 'diagnostics.js'))
  const registryModule = await import(dist('core', 'registry.js'))
  const stateModule = await import(dist('core', 'state.js'))
  Registry = registryModule.Registry
  emptyState = stateModule.emptyState
}
catch (error) {
  console.log('FAIL build  dist/host/{routes,dispatch,diagnostics}.js must be built - run npm run build:host')
  console.log('  ' + String(error && error.message ? error.message : error))
  process.exit(1)
}

// ── harness ─────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failedNames = []

function check(name, ok, detail) {
  const suffix = detail === undefined || detail === '' ? '' : '  ' + detail
  if (ok) {
    passed += 1
    console.log('PASS ' + name + suffix)
    return
  }
  failed += 1
  failedNames.push(name)
  console.log('FAIL ' + name + suffix)
}

async function test(name, fn) {
  try {
    const detail = await fn()
    check(name, true, typeof detail === 'string' ? detail : '')
  }
  catch (error) {
    check(name, false, String(error && error.message ? error.message : error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
}

function sameList(actual, expected, label) {
  assertEqual(actual.join(','), expected.join(','), label)
}

// ── fake host ──────────────────────────────────────────────────────────────

function fakeWebServer() {
  const handlers = new Map()
  const disposers = []
  return {
    service: {
      register(route) {
        handlers.set(route.path, route.handler)
        const dispose = () => handlers.delete(route.path)
        disposers.push(dispose)
        return dispose
      },
    },
    handlers,
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}

async function serve(handlers) {
  const server = createServer((request, response) => {
    const path = String(request.url || '').split('?')[0]
    const handler = handlers.get(path)
    if (handler === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('no route')
      return
    }
    handler(request, response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  return { server, port }
}

function request(port, path, options = {}) {
  const method = options.method || 'GET'
  const headers = options.headers || {}
  const payload = options.body === undefined ? null : typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: Object.assign(
        payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        headers,
      ),
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body = null
        try {
          body = text === '' ? null : JSON.parse(text)
        }
        catch {
          body = null
        }
        resolve({ status: response.statusCode, headers: response.headers, body, text })
      })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

function requestSafe(port, path, options) {
  return request(port, path, options).catch(error => ({ error: String(error && error.code ? error.code : error) }))
}

const OP = '/tool-hub/api/op'
const SNAPSHOT = '/tool-hub/api/snapshot'
const V1_OP = '/tool-hub/api/v1/op'
const V1_SNAPSHOT = '/tool-hub/api/v1/snapshot'

// ── fixture ────────────────────────────────────────────────────────────────

const root = await mkdtemp(join(tmpdir(), 'tool-hub-hostapi-'))
const statePath = join(root, 'state.json')
const historyPath = join(root, 'history.jsonl')
process.env.TOOL_HUB_STATE_FILE = statePath
process.env.TOOL_HUB_WORKSPACES = '-'
process.env.TOOL_HUB_SKILL_ROOTS = join(root, 'skills')
await mkdir(join(root, 'skills'), { recursive: true })

const profileDir = join(root, 'profile')
const patchPath = join(profileDir, 'cordis.patch.yml')
await mkdir(profileDir, { recursive: true })
await writeFile(patchPath, [
  '- insert:',
  '    - id: mcp-one',
  '      config:',
  '        serverName: alpha',
  '    - id: mcp-two',
  '      config:',
  '        serverName: beta',
  '',
].join('\n'), 'utf8')
await writeFile(join(root, 'snapshot-profile.log'), 'plugins=3 modules=12\n', 'utf8')

const services = {
  connection: undefined,
  pluginManager: {
    listPlugins: async () => [],
    setPluginEnabled: async () => ({ ok: true }),
    listBundles: async () => [],
  },
  tools: {
    view: () => ({ knownNames: ['hub_tools', 'bash'] }),
    definitions: () => [{ name: 'hub_tools' }],
    register: () => ({}),
    restrict: () => {},
  },
  systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
  agents: { list: async () => [] },
  workspaces: { list: () => [] },
  workspaceRegistry: { list: () => [] },
  sessions: { listWorkspaces: () => [] },
  profileContext: { dir: profileDir },
  configEditor: { documentPath: patchPath },
}

const FAIL_CODES = new Set()
function failCode(code) {
  FAIL_CODES.add(code)
}

const ctx = {
  get: name => services[name],
  logger: { info() {}, warn() {} },
}

const FIXED_NOW = 1700000000000
const registry = new Registry()
const coreModule = {
  id: 'core',
  title: { zh: '核心', en: 'Core' },
  ops: [
    { id: 'core.ping', write: false, audit: false, note: 'no side effects' },
    { id: 'core.audit', write: true, audit: true, note: 'writes, audited' },
    { id: 'core.writable', write: true, audit: true, confirm: true, note: 'needs confirm:true' },
    { id: 'core.reset', write: true, audit: true, confirm: 'reset', note: 'needs the reset token' },
    { id: 'core.save', write: true, audit: true, note: 'persists through env.save' },
    { id: 'core.failure', write: false, audit: false, note: 'throws a coded failure' },
    { id: 'core.boom', write: false, audit: false, note: 'throws a plain error' },
  ],
}
registry.register(coreModule)

const observedLog = []
const dispatcher = new dispatchModule.Dispatcher({
  registry,
  state: emptyState(),
  services: ctx,
  log: (level, message) => observedLog.push(level + ':' + message),
  now: () => FIXED_NOW,
})
dispatcher.bind({
  module: coreModule,
  handlers: {
    'core.ping': async () => ({ modules: registry.list().length, ops: registry.ops().length }),
    'core.audit': async payload => ({ received: payload }),
    'core.writable': async () => ({ written: true }),
    'core.reset': async () => ({ reset: true }),
    'core.save': async (payload, env) => {
      env.log('warn', 'probe save')
      const saved = await env.save('probe-save')
      return { saved, version: env.state.version, now: env.now() }
    },
    'core.failure': async () => {
      throw new dispatchModule.Failure('bad-payload', 'nope')
    },
    'core.boom': async () => {
      throw new Error('kaboom')
    },
  },
})

const web = fakeWebServer()
services.webServer = web.service
// The revision tests move this on purpose: a changed payload must change the fingerprint.
let fixtureTick = 0
const disposeApi = routes.mountApi({
  ctx,
  run: (op, payload) => dispatcher.run(op, payload),
  snapshot: async ({ fresh }) => ({ modules: registry.list().length, ops: registry.ops().length, fresh, tick: fixtureTick, state: 'fixture' }),
})
const { server, port } = await serve(web.handlers)

try {
  // ── routes: paths and gates ──────────────────────────────────────────────

  await test('mount registers both prefixes', () => {
    assertEqual(web.handlers.size, 4, 'route count')
    for (const path of routes.API_PATHS) assert(web.handlers.has(path), 'missing route ' + path)
    return [...web.handlers.keys()].join(' ')
  })

  await test('legacy snapshot answers 200 ok:true', async () => {
    const res = await request(port, SNAPSHOT)
    assertEqual(res.status, 200, 'status')
    assertEqual(res.body && res.body.ok, true, 'ok')
    assertEqual(res.body && res.body.data && res.body.data.modules, 1, 'data.modules')
    return 'data.fresh=' + String(res.body.data.fresh)
  })

  await test('v1 alias shares the handler', async () => {
    const legacy = await request(port, SNAPSHOT)
    const v1 = await request(port, V1_SNAPSHOT)
    assertEqual(v1.status, 200, 'status')
    assertEqual(JSON.stringify(v1.body), JSON.stringify(legacy.body), 'body')
    return V1_SNAPSHOT
  })

  await test('snapshot revision ignores fetchedAt and key order', () => {
    const a = routes.snapshotRevision({ b: 1, fetchedAt: 1, nested: { y: [1, 2], x: 'v' } })
    const b = routes.snapshotRevision({ nested: { x: 'v', y: [1, 2] }, fetchedAt: 2, b: 1 })
    assertEqual(a, b, 'the fingerprint must not depend on fetchedAt or key order')
    assert(/^[0-9a-f]{16}$/.test(a), 'revision shape: ' + a)
    assert(a !== routes.snapshotRevision({ b: 1, nested: { x: 'v', y: [1, 3] } }), 'a changed payload must change the revision')
    return a
  })

  await test('a full snapshot carries a stable revision beside data', async () => {
    const first = await request(port, SNAPSHOT)
    const second = await request(port, SNAPSHOT)
    assertEqual(first.body.ok, true, 'ok')
    assertEqual(typeof first.body.revision, 'string', 'revision type')
    assertEqual(first.body.revision.length, 16, 'revision length')
    assertEqual(second.body.revision, first.body.revision, 'two builds of one state must agree')
    assert(first.body.data !== undefined, 'a full answer carries data')
    assert(!('revision' in first.body.data), 'revision belongs beside data, not inside it')
    return 'revision ' + first.body.revision
  })

  await test('since matching the revision answers unchanged without data', async () => {
    const full = await request(port, SNAPSHOT)
    const res = await request(port, SNAPSHOT + '?since=' + full.body.revision)
    assertEqual(res.status, 200, 'status')
    assertEqual(res.body.ok, true, 'ok')
    assertEqual(res.body.unchanged, true, 'unchanged')
    assertEqual(res.body.revision, full.body.revision, 'revision')
    assert(!('data' in res.body), 'an unchanged answer must not carry data')
    return 'unchanged at ' + res.body.revision
  })

  await test('a changed payload defeats since and returns the full snapshot', async () => {
    const before = await request(port, SNAPSHOT)
    fixtureTick += 1
    const res = await request(port, SNAPSHOT + '?since=' + before.body.revision)
    assertEqual(res.body.unchanged, undefined, 'must not report unchanged')
    assert(res.body.data !== undefined && res.body.data.tick === fixtureTick, 'data.tick must be ' + fixtureTick)
    assert(res.body.revision !== before.body.revision, 'a changed payload needs a new revision')
    return 'revision moved ' + before.body.revision + ' -> ' + res.body.revision
  })

  await test('fresh=1 ignores since and rebuilds', async () => {
    const full = await request(port, SNAPSHOT)
    const res = await request(port, SNAPSHOT + '?fresh=1&since=' + full.body.revision)
    assertEqual(res.body.unchanged, undefined, 'a forced read is always answered in full')
    assertEqual(res.body.data.fresh, true, 'the builder must see fresh')
    assert(/^[0-9a-f]{16}$/.test(res.body.revision), 'a full answer still carries a revision: ' + res.body.revision)
    return 'fresh answered in full (' + full.body.revision + ' -> ' + res.body.revision + ')'
  })

  await test('an unknown since is answered in full', async () => {
    const res = await request(port, SNAPSHOT + '?since=deadbeefdeadbeef')
    assertEqual(res.body.ok, true, 'ok')
    assertEqual(res.body.unchanged, undefined, 'not unchanged')
    assert(res.body.data !== undefined, 'data present')
    return 'unknown revision ignored'
  })

  await test('401 gate uses the 1.x body shape', async () => {
    services.connection = { requestRejection: () => 401 }
    const res = await request(port, SNAPSHOT)
    assertEqual(res.status, 401, 'status')
    assertEqual(res.body.error.code, 'unauthorized', 'code')
    assertEqual(res.body.error.message, 'DSH browser authentication is required', 'message')
    assertEqual(res.body.ok, false, 'ok')
    return '401 unauthorized'
  })

  await test('403 gate reports forbidden', async () => {
    services.connection = { requestRejection: () => 403 }
    const res = await request(port, OP, { method: 'POST', body: { op: 'core.ping' } })
    assertEqual(res.status, 403, 'status')
    assertEqual(res.body.error.code, 'forbidden', 'code')
    assertEqual(res.body.error.message, 'DSH browser authentication is required', 'message')
    assertEqual(res.headers['cache-control'], 'no-store', 'cache-control')
    return '403 forbidden'
  })

  await test('gate is re-read per request', async () => {
    services.connection = undefined
    const open = await request(port, SNAPSHOT)
    assertEqual(open.status, 200, 'open status')
    services.connection = { requestRejection: () => 401 }
    const closed = await request(port, SNAPSHOT)
    assertEqual(closed.status, 401, 'closed status')
    services.connection = undefined
    const reopened = await request(port, SNAPSHOT)
    assertEqual(reopened.status, 200, 'reopened status')
    return '401 -> open -> 401 -> open'
  })

  await test('a throwing gate fails closed (403)', async () => {
    services.connection = {
      requestRejection: () => {
        throw new Error('gate exploded')
      },
    }
    const res = await request(port, SNAPSHOT)
    assertEqual(res.status, 403, 'status')
    assertEqual(res.body.error.code, 'forbidden', 'code')
    services.connection = { requestRejection: () => undefined }
    return 'throwing gate refused'
  })

  await test('cross-site fetch is refused', async () => {
    const res = await request(port, OP, {
      method: 'POST',
      body: { op: 'core.ping' },
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assertEqual(res.status, 403, 'status')
    assertEqual(res.body.error.code, 'origin', 'code')
    assertEqual(res.body.error.message, 'refused: cross-origin request', 'message')
    return 'sec-fetch-site: cross-site'
  })

  await test('foreign Origin is refused, matching Origin is allowed', async () => {
    const foreign = await request(port, OP, {
      method: 'POST',
      body: { op: 'core.ping' },
      headers: { origin: 'http://evil.example' },
    })
    assertEqual(foreign.status, 403, 'foreign status')
    assertEqual(foreign.body.error.code, 'origin', 'foreign code')
    const same = await request(port, OP, {
      method: 'POST',
      body: { op: 'core.ping' },
      headers: { origin: 'http://127.0.0.1:' + port },
    })
    assertEqual(same.status, 200, 'same-origin status')
    assertEqual(same.body.ok, true, 'same-origin ok')
    return 'origin checked against Host'
  })

  await test('snapshot rejects POST with 405 and allow:GET', async () => {
    const res = await request(port, SNAPSHOT, { method: 'POST', body: {} })
    assertEqual(res.status, 405, 'status')
    assertEqual(res.headers.allow, 'GET', 'allow')
    assertEqual(res.text, '', 'empty body')
    return '405 allow:GET'
  })

  await test('op rejects GET with 405 and allow:POST', async () => {
    const res = await request(port, OP)
    assertEqual(res.status, 405, 'status')
    assertEqual(res.headers.allow, 'POST', 'allow')
    assertEqual(res.text, '', 'empty body')
    return '405 allow:POST'
  })

  // ── dispatch through the routes ──────────────────────────────────────────

  await test('op core.ping answers 200 ok:true', async () => {
    const res = await request(port, OP, { method: 'POST', body: { op: 'core.ping' } })
    assertEqual(res.status, 200, 'status')
    assertEqual(res.body.ok, true, 'ok')
    assertEqual(res.body.data.ops, coreModule.ops.length, 'ops')
    const alias = await request(port, V1_OP, { method: 'POST', body: { op: 'core.ping' } })
    assertEqual(alias.status, 200, 'alias status')
    assertEqual(JSON.stringify(alias.body), JSON.stringify(res.body), 'alias body')
    return 'ops=' + String(res.body.data.ops)
  })

  await test('unknown op is refused with bad-op', async () => {
    const res = await request(port, OP, { method: 'POST', body: { op: 'nope.op' } })
    assertEqual(res.status, 200, 'status')
    assertEqual(res.body.ok, false, 'ok')
    assertEqual(res.body.error.code, 'bad-op', 'code')
    assertEqual(res.body.error.message, 'unknown op nope.op', 'message')
    let thrown = null
    try {
      await dispatcher.execute('nope.op', {})
    }
    catch (error) {
      thrown = error
    }
    assert(thrown !== null, 'execute() throws')
    assertEqual(thrown.code, 'bad-op', 'execute code')
    return 'route + execute'
  })

  await test('confirm:true is enforced before the handler', async () => {
    const blocked = await request(port, OP, { method: 'POST', body: { op: 'core.writable' } })
    assertEqual(blocked.body.ok, false, 'blocked ok')
    assertEqual(blocked.body.error.code, 'confirm-required', 'blocked code')
    const passedRes = await request(port, OP, { method: 'POST', body: { op: 'core.writable', payload: { confirm: true } } })
    assertEqual(passedRes.body.ok, true, 'confirmed ok')
    assertEqual(passedRes.body.data.written, true, 'confirmed data')
    const wrongToken = await request(port, OP, { method: 'POST', body: { op: 'core.writable', payload: { confirm: 'reset' } } })
    assertEqual(wrongToken.body.error.code, 'confirm-required', 'confirm:reset is not confirm:true')
    return 'confirm:true'
  })

  await test('confirm:"reset" needs the literal token', async () => {
    const blocked = await request(port, OP, { method: 'POST', body: { op: 'core.reset', payload: { confirm: true } } })
    assertEqual(blocked.body.error.code, 'confirm-required', 'blocked code')
    assert(blocked.body.error.message.indexOf('"reset"') !== -1, 'message names the token')
    const allowed = await request(port, OP, { method: 'POST', body: { op: 'core.reset', payload: { confirm: 'reset' } } })
    assertEqual(allowed.body.ok, true, 'reset ok')
    assertEqual(allowed.body.data.reset, true, 'reset data')
    return 'confirm:"reset"'
  })

  await test('coded failure keeps its code, plain throw becomes internal', async () => {
    const coded = await request(port, OP, { method: 'POST', body: { op: 'core.failure' } })
    assertEqual(coded.status, 200, 'coded status')
    assertEqual(coded.body.error.code, 'bad-payload', 'coded code')
    assertEqual(coded.body.error.message, 'nope', 'coded message')
    const plain = await request(port, OP, { method: 'POST', body: { op: 'core.boom' } })
    assertEqual(plain.body.error.code, 'internal', 'plain code')
    assertEqual(plain.body.error.message, 'kaboom', 'plain message')
    return 'bad-payload / internal'
  })

  await test('bad JSON body answers 400 bad-json', async () => {
    const res = await request(port, OP, { method: 'POST', body: '{not json' })
    assertEqual(res.status, 400, 'status')
    assertEqual(res.body.error.code, 'bad-json', 'code')
    assertEqual(res.body.ok, false, 'ok')
    return '400 bad-json'
  })

  await test('oversized body is refused and the server survives', async () => {
    let code = null
    try {
      await routes.readJson({
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.alloc(150 * 1024)
          yield Buffer.alloc(150 * 1024)
        },
      })
    }
    catch (error) {
      code = error && error.code ? error.code : null
    }
    assertEqual(code, 'too-large', 'readJson code')
    const tooLarge = await requestSafe(port, OP, { method: 'POST', body: 'x'.repeat(300 * 1024) })
    assert(tooLarge !== undefined, 'request settled')
    const after = await request(port, OP, { method: 'POST', body: { op: 'core.ping' } })
    assertEqual(after.status, 200, 'server still answers')
    assertEqual(after.body.ok, true, 'still ok')
    return 'readJson too-large; server alive'
  })

  await test('snapshot default provider dispatches the snapshot op', async () => {
    const bare = fakeWebServer()
    const bareCtx = { get: name => (name === 'webServer' ? bare.service : undefined), logger: { warn() {}, info() {} } }
    const dispose = routes.mountApi({ ctx: bareCtx, run: (op, payload) => dispatcher.run(op, payload) })
    const bareServer = await serve(bare.handlers)
    try {
      const res = await request(bareServer.port, SNAPSHOT)
      assertEqual(res.status, 200, 'status')
      assertEqual(res.body.ok, false, 'no snapshot op registered')
      assertEqual(res.body.error.code, 'bad-op', 'code')
      return 'bad-op inside 200'
    }
    finally {
      await new Promise(resolve => bareServer.server.close(resolve))
      dispose()
      bare.dispose()
    }
  })

  // ── history ─────────────────────────────────────────────────────────────

  await test('history records ok/audit flags and hides payload secrets', async () => {
    await request(port, OP, { method: 'POST', body: { op: 'core.audit', payload: { id: 'abc', secret: 'topsecret' } } })
    await request(port, OP, { method: 'POST', body: { op: 'nope.op' } })
    const text = await readFile(historyPath, 'utf8')
    const lines = text.trim().split('\n').filter(line => line !== '')
    const last = JSON.parse(lines[lines.length - 1])
    const before = JSON.parse(lines[lines.length - 2])
    assertEqual(last.op, 'nope.op', 'last op')
    assertEqual(last.ok, false, 'last ok')
    assertEqual(last.audit, false, 'last audit')
    assertEqual(before.op, 'core.audit', 'previous op')
    assertEqual(before.ok, true, 'previous ok')
    assertEqual(before.audit, true, 'previous audit')
    assert(before.detail.indexOf('id=abc') !== -1, 'detail keeps id: ' + before.detail)
    assert(before.detail.indexOf('topsecret') === -1, 'detail hides payload text')
    return 'audit=true, ok=false line for unknown op'
  })

  await test('history truncates to the tail past 2MB', async () => {
    const filler = 'x'.repeat(2000)
    const seeded = []
    for (let index = 0; index < 1100; index += 1) {
      seeded.push(JSON.stringify({ at: '2020-01-01T00:00:00.000Z', op: 'seed.' + index, detail: filler, ok: true, audit: false }))
    }
    await writeFile(historyPath, seeded.join('\n') + '\n', 'utf8')
    const before = await stat(historyPath)
    assert(before.size > 2 * 1024 * 1024, 'seeded over budget: ' + before.size)
    await dispatcher.run('core.ping', {})
    const after = await stat(historyPath)
    assert(after.size < 2 * 1024 * 1024, 'truncated: ' + after.size)
    const kept = (await readFile(historyPath, 'utf8')).trim().split('\n')
    assert(kept.length <= 501, 'kept lines: ' + kept.length)
    assert(kept.length >= 400, 'kept the tail, not nothing: ' + kept.length)
    const tail = JSON.parse(kept[kept.length - 1])
    assertEqual(tail.op, 'core.ping', 'tail op')
    const recent = await dispatcher.history(5)
    assertEqual(recent.length, 5, 'history(5)')
    assertEqual(recent[0].op, 'core.ping', 'newest first')
    return before.size + ' -> ' + after.size + ' bytes, ' + kept.length + ' line(s)'
  })

  // ── env.save ────────────────────────────────────────────────────────────

  await test('env.save persists through core/io with a backup on the second write', async () => {
    const first = await dispatcher.run('core.save', {})
    assertEqual(first.ok, true, 'first ok')
    assertEqual(first.data.saved, null, 'first save has nothing to back up')
    assertEqual(first.data.version, 2, 'state version')
    assertEqual(first.data.now, FIXED_NOW, 'env.now')
    const written = JSON.parse(await readFile(statePath, 'utf8'))
    assertEqual(written.version, 2, 'file version')
    assert(Array.isArray(written.groups) && written.groups.length === 0, 'default groups')
    const second = await dispatcher.run('core.save', {})
    assertEqual(second.ok, true, 'second ok')
    assert(typeof second.data.saved === 'string', 'second save returns a backup path')
    assert(second.data.saved.indexOf('state-') !== -1, 'backup name: ' + second.data.saved)
    assert(observedLog.indexOf('warn:probe save') !== -1, 'env.log reached the dispatcher log')
    return 'backup=' + second.data.saved.replace(root, '<state>')
  })

  await test('bind rejects undeclared, missing and duplicate handlers', async () => {
    const bindModule = {
      id: 'bindtest',
      title: { zh: '绑定', en: 'Bind' },
      ops: [
        { id: 'bind.a', write: false, audit: false, note: 'first' },
        { id: 'bind.b', write: false, audit: false, note: 'second' },
      ],
    }
    registry.register(bindModule)
    let missing = ''
    try {
      dispatcher.bind({ module: bindModule, handlers: { 'bind.a': async () => ({ a: true }) } })
    }
    catch (error) {
      missing = error.message
    }
    assert(missing.indexOf('op bind.b has no handler') !== -1, 'missing handler: ' + missing)
    // Two-phase bind: the half-bound op must not be dispatchable after the throw.
    const partial = await dispatcher.run('bind.a', {})
    assertEqual(partial.ok, false, 'partial bind refused')
    assertEqual(partial.error.code, 'no-handler', 'partial bind code')
    const stillWorking = await dispatcher.run('core.ping', {})
    assertEqual(stillWorking.ok, true, 'previous handlers untouched')
    let undeclared = ''
    try {
      dispatcher.bind({ module: { id: 'x', title: { zh: 'x', en: 'x' }, ops: [] }, handlers: { 'x.op': async () => ({}) } })
    }
    catch (error) {
      undeclared = error.message
    }
    assert(undeclared.indexOf('handler for undeclared op: x.op') !== -1, 'undeclared: ' + undeclared)
    dispatcher.bind({
      module: bindModule,
      handlers: { 'bind.a': async () => ({ a: true }), 'bind.b': async () => ({ b: true }) },
    })
    const bound = await dispatcher.run('bind.b', {})
    assertEqual(bound.ok, true, 'bound after a clean bind')
    let duplicate = ''
    try {
      dispatcher.bind({
        module: bindModule,
        handlers: { 'bind.a': async () => ({}), 'bind.b': async () => ({}) },
      })
    }
    catch (error) {
      duplicate = error.message
    }
    assert(duplicate.indexOf('duplicate op handler') !== -1, 'duplicate: ' + duplicate)
    return 'missing / undeclared / duplicate, no partial bind'
  })

  // ── doctor ──────────────────────────────────────────────────────────────

  const hostStartedAt = Date.now() - Math.round(process.uptime() * 1000)
  diagnostics.writeMountHeartbeat({ stateDir: root, hostStartedAt, injects: ['tools', 'systemPrompt', 'webServer'] })

  await test('doctor runs every declared check in order', async () => {
    const report = await diagnostics.runDoctor({ ctx, stateDir: root, patchPath, hostStartedAt })
    sameList(report.checks.map(row => row.id), [...diagnostics.DOCTOR_CHECK_IDS], 'ids')
    assertEqual(report.checks.length, diagnostics.DOCTOR_CHECK_IDS.length, 'check count')
    return diagnostics.DOCTOR_CHECK_IDS.join(', ')
  })

  await test('doctor passes all checks on a healthy fake host', async () => {
    const report = await diagnostics.runDoctor({ ctx, stateDir: root, patchPath, hostStartedAt })
    const failing = report.checks.filter(row => !row.ok)
    assertEqual(failing.length, 0, 'failing checks: ' + JSON.stringify(failing))
    const byId = Object.fromEntries(report.checks.map(row => [row.id, row]))
    assert(byId['patch-parse'].detail.indexOf('2 MCP row(s)') !== -1, 'patch rows: ' + byId['patch-parse'].detail)
    assert(byId['mount-heartbeat'].detail.indexOf('pid ' + process.pid) !== -1, 'heartbeat: ' + byId['mount-heartbeat'].detail)
    assertEqual(byId['host-contract'].detail, '15/15 host member(s)', 'host-contract detail')
    assert(byId['hub-tools'].ok, 'hub_tools found')
    assert(byId['snapshot-profile'].detail.indexOf('plugins 3ms') !== -1, 'profile log: ' + byId['snapshot-profile'].detail)
    assertEqual(diagnostics.patchPathFor(ctx), patchPath, 'patchPathFor')
    assert(byId['patch-managed'].ok, 'patch-managed: ' + byId['patch-managed'].detail)
    return report.checks.length + '/' + report.checks.length
  })

  await test('doctor answers a missing capability from the table', async () => {
    const original = services.pluginManager.listPlugins
    delete services.pluginManager.listPlugins
    try {
      const report = await diagnostics.runDoctor({ ctx, stateDir: root, patchPath, hostStartedAt })
      const rows = Object.fromEntries(report.checks.map(row => [row.id, row]))
      assertEqual(report.checks.length, diagnostics.DOCTOR_CHECK_IDS.length, 'still every row')
      assertEqual(rows['failed-rows'].ok, false, 'failed-rows can not run')
      assert(rows['failed-rows'].detail.indexOf('missing pluginManager.listPlugins:') === 0, 'table prefix: ' + rows['failed-rows'].detail)
      assert(rows['failed-rows'].detail.indexOf('plugins cannot be listed or toggled') !== -1, 'table fallback text')
      assertEqual(rows['host-contract'].ok, false, 'host-contract notices')
      assert(rows['host-contract'].detail.indexOf('pluginManager.listPlugins') !== -1, 'names the member: ' + rows['host-contract'].detail)
      assertEqual(rows['state-writable'].ok, true, 'other checks still run')
      return rows['host-contract'].detail
    }
    finally {
      services.pluginManager.listPlugins = original
    }
  })

  await test('doctor keeps the other checks when one probe throws', async () => {
    const original = services.pluginManager.listPlugins
    services.pluginManager.listPlugins = async () => {
      throw new Error('loader exploded')
    }
    try {
      const report = await diagnostics.runDoctor({ ctx, stateDir: root, patchPath, hostStartedAt })
      const rows = Object.fromEntries(report.checks.map(row => [row.id, row]))
      assertEqual(rows['failed-rows'].ok, false, 'failed-rows failed')
      assertEqual(rows['failed-rows'].detail, 'loader exploded', 'error text')
      assertEqual(rows['state-writable'].ok, true, 'state-writable still runs')
      assertEqual(rows['host-contract'].ok, true, 'contract still ok')
      assertEqual(report.ok, false, 'report is not ok')
      return 'independent checks'
    }
    finally {
      services.pluginManager.listPlugins = original
    }
  })

  await test('mount heartbeat failures are named', async () => {
    diagnostics.writeMountHeartbeat({ stateDir: root, pid: process.pid + 1, hostStartedAt })
    const wrongPid = await diagnostics.runDoctor({ ctx, stateDir: root, patchPath, hostStartedAt })
    const pidRow = wrongPid.checks.find(row => row.id === 'mount-heartbeat')
    assertEqual(pidRow.ok, false, 'wrong pid detected')
    assert(pidRow.detail.indexOf('belongs to pid') !== -1, 'pid detail: ' + pidRow.detail)
    diagnostics.writeMountHeartbeat({ stateDir: root, hostStartedAt, injects: ['tools'] })
    const noInject = await diagnostics.runDoctor({ ctx, stateDir: root, patchPath, hostStartedAt })
    const injectRow = noInject.checks.find(row => row.id === 'mount-heartbeat')
    assertEqual(injectRow.ok, false, 'missing inject detected')
    assert(injectRow.detail.indexOf('missing inject: webServer') !== -1, 'inject detail: ' + injectRow.detail)
    await rm(join(root, 'mount.json'), { force: true })
    const noFile = await diagnostics.runDoctor({ ctx, stateDir: root, patchPath, hostStartedAt })
    const fileRow = noFile.checks.find(row => row.id === 'mount-heartbeat')
    assertEqual(fileRow.detail, 'no heartbeat file', 'missing file detail')
    diagnostics.writeMountHeartbeat({ stateDir: root, hostStartedAt, injects: ['tools', 'systemPrompt', 'webServer'] })
    const healed = await diagnostics.runDoctor({ ctx, stateDir: root, patchPath, hostStartedAt })
    assertEqual(healed.checks.find(row => row.id === 'mount-heartbeat').ok, true, 'heartbeat healed')
    return 'pid / inject / missing-file'
  })

  await test('capability table is the contract the settings page reads', async () => {
    assertEqual(diagnostics.CAPABILITIES.length, 19, 'table rows')
    const hostRows = diagnostics.CAPABILITIES.filter(row => (row.surface || 'host') === 'host')
    const clientRows = diagnostics.CAPABILITIES.filter(row => row.surface === 'client')
    assertEqual(hostRows.length, 15, 'host rows')
    assertEqual(clientRows.length, 4, 'client rows')
    for (const row of diagnostics.CAPABILITIES) {
      assert(typeof row.id === 'string' && row.id.length > 0, 'row id')
      assert(typeof row.fallback === 'string' && row.fallback.length > 0, 'fallback text for ' + row.id)
      assert(typeof row.usedFor === 'string' && row.usedFor.length > 0, 'usedFor text for ' + row.id)
    }
    assert(diagnostics.CAPABILITIES.some(row => row.id === 'connection.requestRejection'), 'gate row')
    const report = diagnostics.hostCapabilities(ctx)
    assertEqual(report.total, 15, 'host report total')
    assertEqual(report.ok, true, 'host report ok')
    assertEqual(report.degraded, false, 'nothing optional missing')
    sameList(diagnostics.validateDoctorTable(), [], 'doctor table consistency')
    return '19 rows / 15 host / 4 client'
  })

  await test('installApi hands cleanup to ctx.effect', async () => {
    const fake = fakeWebServer()
    let cleanup = null
    const effectCtx = {
      get: name => (name === 'webServer' ? fake.service : undefined),
      logger: { warn() {}, info() {} },
      effect(fn) {
        cleanup = fn()
      },
    }
    const dispose = routes.installApi({ ctx: effectCtx, run: (op, payload) => dispatcher.run(op, payload) })
    assertEqual(fake.handlers.size, 4, 'mounted before cleanup')
    assert(typeof cleanup === 'function', 'effect captured a disposer')
    cleanup()
    assertEqual(fake.handlers.size, 0, 'cleanup removed the routes')
    dispose()
    return 'effect -> disposer -> 0 routes'
  })
}
finally {
  disposeApi()
  web.dispose()
  await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}

console.log('host-api probe: ' + passed + ' PASS / ' + failed + ' FAIL')
if (failed > 0) {
  console.log('failed: ' + failedNames.join(', '))
  process.exit(1)
}
