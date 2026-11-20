#!/usr/bin/env node
/**
 * probe/next/integration.mjs - end to end: apply() against a fake host.
 *
 * The other probes test one module each. This one starts the real 2.0 entry (dist/host/index.js),
 * lets it load a 1.x state.json, register every domain, dispatch through the real Dispatcher and
 * mount the real routes, then talks to it over a real node:http server.
 *
 * What it pins down (the acceptance list for task-7):
 *   1. GET /tool-hub/api/v1/snapshot answers the nine panel keys;
 *   2. the first save migrates state.json to v2 and keeps every 1.x key;
 *   3. settings.set changes state.settings and returns the backup path;
 *   4. toggle reaches pluginManager.setPluginEnabled and a fresh snapshot reflects it;
 *   5. doctor answers the ten checks, host-contract among them;
 *   6. the 401 / 403 gate still refuses through apply();
 *   7. the ctx.effect cleanup leaves zero routes mounted.
 *
 * No third-party libraries; exit 1 when any check fails. Run 'npm run build:host' first.
 */
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

let hub
try {
  hub = await import(pathToFileURL(join(repoRoot, 'dist', 'host', 'index.js')).href)
}
catch (error) {
  console.log('FAIL build  dist/host/index.js must be built - run npm run build:host')
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

function sameJson(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(label + ': expected ' + right + ', got ' + left)
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
  return { server, port: address !== null && typeof address === 'object' ? address.port : 0 }
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

const OP = '/tool-hub/api/op'
const SNAPSHOT = '/tool-hub/api/snapshot'
const V1_OP = '/tool-hub/api/v1/op'
const V1_SNAPSHOT = '/tool-hub/api/v1/snapshot'

function op(port, id, payload) {
  return request(port, V1_OP, { method: 'POST', body: payload === undefined ? { op: id } : { op: id, payload } })
}

// ── fixture: a 1.x home ────────────────────────────────────────────────────

const root = await mkdtemp(join(tmpdir(), 'tool-hub-integration-'))
const dshHome = join(root, 'dsh-home')
const stateDir = join(dshHome, 'tool-hub')
const statePath = join(stateDir, 'state.json')
const profileDir = join(dshHome, 'profiles', 'integration')
const patchPath = join(profileDir, 'cordis.patch.yml')
const skillsDir = join(root, 'skills')

await mkdir(stateDir, { recursive: true })
await mkdir(profileDir, { recursive: true })
await mkdir(join(skillsDir, 'alpha'), { recursive: true })
await writeFile(join(skillsDir, 'alpha', 'SKILL.md'), '# Alpha\n\nA fixture skill.\n', 'utf8')

process.env.DSH_HOME = dshHome
delete process.env.TOOL_HUB_STATE_FILE
process.env.TOOL_HUB_SKILL_ROOTS = skillsDir
process.env.TOOL_HUB_WORKSPACES = '-'

const legacyState = {
  version: 1,
  groups: [{ id: 'g1', name: 'Group one', role: 'task', collection: 'default', tags: ['x'], members: [{ kind: 'plugin', id: 'p1' }], auto: false, createdAt: 1, order: 0 }],
  collections: [{ id: 'default', name: '默认分组群', order: 0 }],
  presets: [{ name: 'work', enabled: { plugin: ['p1'], skill: [], tool: [] }, createdAt: 2 }],
  toolDeny: ['mcp__alpha__write'],
  auto: { appliedAt: 7 },
  sessions: { s1: ['mcp__alpha__write'] },
  scenes: { work: { name: 'work', tools: { deny: [] }, mcp: { off: [] } } },
  mode: null,
  legacyMarker: 'keep-me',
}
await writeFile(statePath, JSON.stringify(legacyState, null, 2) + '\n', 'utf8')
await writeFile(patchPath, [
  '- insert:',
  '    - id: mcp-alpha',
  '      config:',
  '        serverName: alpha',
  '    - id: mcp-beta',
  '      config:',
  '        serverName: beta',
  '',
].join('\n'), 'utf8')

// ── fake cordis context ───────────────────────────────────────────────────

const pluginRows = [
  { entryId: 'p1', moduleName: 'dsh-plugin-one', meta: { title: 'One', description: 'first plugin' }, enabled: false, fiberPhase: 'active' },
  { entryId: 'p2', moduleName: 'dsh-plugin-two', meta: { title: 'Two' }, enabled: true, fiberPhase: 'active', readOnlyReason: 'managed by a bundle' },
]
const setEnabledCalls = []
const pluginManager = {
  listPlugins: async () => pluginRows.map(row => Object.assign({}, row)),
  listBundles: async () => [],
  setPluginEnabled: async (id, enabled) => {
    setEnabledCalls.push([String(id), enabled === true])
    const row = pluginRows.find(entry => entry.entryId === id)
    if (row !== undefined) row.enabled = enabled === true
    return { application: 'applied' }
  },
}

const restrictCalls = []
const tools = {
  view: () => ({ knownNames: ['hub_tools', 'mcp__alpha__write', 'bash'] }),
  restrict: (...args) => {
    restrictCalls.push(args)
  },
  definitions: () => [{ name: 'hub_tools' }],
  register: () => ({}),
}

const connection = { requestRejection: () => undefined }
const web = fakeWebServer()
const services = {
  webServer: web.service,
  pluginManager,
  tools,
  connection,
  agents: { list: async () => [] },
  workspaces: { list: () => [] },
  workspaceRegistry: { list: () => [] },
  sessions: { listWorkspaces: () => [] },
  profileContext: { dir: profileDir },
  systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
}

const logs = []
const effects = []
let effectCalls = 0
const ctx = {
  get: name => services[name],
  logger: {
    info: message => logs.push('info:' + message),
    warn: message => logs.push('warn:' + message),
  },
  effect(fn) {
    effectCalls += 1
    effects.push(fn())
  },
}

hub.apply(ctx)
const { server, port } = await serve(web.handlers)

const DOCTOR_IDS = [
  'patch-parse',
  'state-writable',
  'failed-rows',
  'stale-lock',
  'skill-roots',
  'trash',
  'hub-tools',
  'mount-heartbeat',
  'host-contract',
  'snapshot-profile',
]

try {
  // ── mounting ────────────────────────────────────────────────────────────

  await test('apply mounts both prefixes on the host webServer', () => {
    assertEqual(web.handlers.size, 4, 'route count')
    for (const path of [SNAPSHOT, OP, V1_SNAPSHOT, V1_OP]) assert(web.handlers.has(path), 'missing route ' + path)
    return [SNAPSHOT, OP, V1_SNAPSHOT, V1_OP].join(' ')
  })

  // ── (1) snapshot ────────────────────────────────────────────────────────

  await test('(1) v1 snapshot answers the nine panel keys', async () => {
    const res = await request(port, V1_SNAPSHOT)
    assertEqual(res.status, 200, 'status')
    assertEqual(res.body.ok, true, 'ok')
    const data = res.body.data
    for (const key of ['plugins', 'skills', 'groups', 'presets', 'tools', 'scene', 'settings', 'settingsSchema', 'paths']) {
      assert(key in data, 'missing key ' + key)
    }
    assert(Array.isArray(data.plugins) && data.plugins.length === 2, 'plugin rows: ' + (data.plugins || []).length)
    assert(data.plugins.some(row => row.id === 'p1' && row.moduleName === 'dsh-plugin-one'), 'row p1')
    assert(Array.isArray(data.skills), 'skills is an array')
    assert(data.skills.some(row => row.name === 'alpha'), 'fixture skill listed')
    assert(Array.isArray(data.groups) && data.groups.length === 1, 'groups carried from 1.x')
    assert('work' in data.presets, 'preset carried from 1.x')
    assert(Array.isArray(data.tools) && data.tools.some(row => row.name === 'hub_tools'), 'tool rows')
    assertEqual(data.scene.mode, null, 'scene mode')
    assert(data.scene.names.indexOf('work') !== -1, 'scene names')
    assert(Array.isArray(data.settingsSchema) && data.settingsSchema.length >= 9, 'settings schema rows')
    assert(data.settingsSchema.some(row => row.key === 'settings.appearance.theme'), 'declared settings key')
    assertEqual(data.paths.home, dshHome, 'paths.home')
    assertEqual(data.paths.state, statePath, 'paths.state')
    assertEqual(data.paths.patch, patchPath, 'paths.patch')
    assert(data.paths.skillRoots.indexOf(skillsDir) !== -1, 'paths.skillRoots')
    assert(Array.isArray(data.history), 'history is an array')
    return data.plugins.length + ' plugins, ' + data.skills.length + ' skills, ' + data.settingsSchema.length + ' settings'
  })

  await test('apply logged its startup line from start()', () => {
    const line = logs.find(entry => entry.indexOf('dsh-tool-hub 2.0:') === 0 || entry.indexOf('info:dsh-tool-hub 2.0:') === 0)
    assert(line !== undefined, 'startup log: ' + JSON.stringify(logs))
    assert(/dsh-tool-hub 2\.0: 10 module\(s\)/.test(line), 'module count: ' + line)
    return line.replace(/^info:/, '')
  })

  // ── (3) settings.set + (2) migration on first save ──────────────────────

  await test('(2) state.json is still the 1.x document before the first save', async () => {
    const before = JSON.parse(await readFile(statePath, 'utf8'))
    assertEqual(before.version, 1, 'version before save')
    sameJson(before.groups, legacyState.groups, 'groups before save')
    return 'version 1, ' + before.groups.length + ' group(s)'
  })

  await test('(3) settings.set writes state.settings and returns the backup', async () => {
    const res = await op(port, 'settings.set', { values: { 'settings.appearance.theme': 'dark' } })
    assertEqual(res.status, 200, 'status')
    assertEqual(res.body.ok, true, 'ok')
    assertEqual(res.body.data.settings['settings.appearance.theme'], 'dark', 'settings value')
    assert(typeof res.body.data.backup === 'string' && res.body.data.backup !== '', 'backup path')
    assert(res.body.data.backup.indexOf('backups') !== -1, 'backup location: ' + res.body.data.backup)
    const backup = JSON.parse(await readFile(res.body.data.backup, 'utf8'))
    assertEqual(backup.version, 1, 'the backup is the pre-migration copy')
    return res.body.data.backup.replace(root, '<tmp>')
  })

  await test('(2) the saved state.json is v2 and keeps every 1.x key', async () => {
    const after = JSON.parse(await readFile(statePath, 'utf8'))
    assertEqual(after.version, 2, 'version after save')
    sameJson(after.groups, legacyState.groups, 'groups')
    sameJson(after.collections, legacyState.collections, 'collections')
    sameJson(after.presets, legacyState.presets, 'presets')
    sameJson(after.toolDeny, legacyState.toolDeny, 'toolDeny')
    sameJson(after.auto, legacyState.auto, 'auto')
    sameJson(after.sessions, legacyState.sessions, 'sessions')
    sameJson(after.scenes, legacyState.scenes, 'scenes')
    assertEqual(after.mode, null, 'mode')
    assertEqual(after.legacyMarker, 'keep-me', 'unknown key survives the round trip')
    assertEqual(after.settings['settings.appearance.theme'], 'dark', 'stored setting')
    assert(typeof after.settings === 'object' && after.settings !== null, 'settings object')
    return 'v2, 1.x keys + legacyMarker intact'
  })

  await test('(3) a fresh snapshot shows the saved setting', async () => {
    const res = await request(port, V1_SNAPSHOT + '?fresh=1')
    assertEqual(res.body.data.settings['settings.appearance.theme'], 'dark', 'snapshot setting')
    return 'settings.appearance.theme=dark'
  })

  // ── (4) toggle ──────────────────────────────────────────────────────────

  await test('(4) toggle reaches pluginManager.setPluginEnabled', async () => {
    const res = await op(port, 'toggle', { kind: 'plugin', id: 'p1', enabled: true })
    assertEqual(res.status, 200, 'status')
    assertEqual(res.body.ok, true, 'ok')
    assertEqual(res.body.data.id, 'p1', 'id')
    assertEqual(res.body.data.ok, true, 'toggle ok')
    assertEqual(res.body.data.application, 'applied', 'application')
    sameJson(setEnabledCalls, [['p1', true]], 'manager calls')
    return 'p1 -> enabled'
  })

  await test('(4) a fresh snapshot reflects the switch', async () => {
    const res = await request(port, V1_SNAPSHOT + '?fresh=1')
    const row = res.body.data.plugins.find(entry => entry.id === 'p1')
    assert(row !== undefined, 'row p1 present')
    assertEqual(row.enabled, true, 'p1 enabled in snapshot')
    return 'p1.enabled=true'
  })

  await test('(4) refusals come back structured, not thrown', async () => {
    const readOnly = await op(port, 'toggle', { kind: 'plugin', id: 'p2', enabled: false })
    assertEqual(readOnly.status, 200, 'read-only status')
    assertEqual(readOnly.body.ok, true, 'envelope is ok: the op answered')
    assertEqual(readOnly.body.data.code, 'read-only', 'read-only code')
    const unknown = await op(port, 'toggle', { kind: 'plugin', id: 'nope', enabled: false })
    assertEqual(unknown.body.data.code, 'unknown-plugin', 'unknown code')
    const badPayload = await op(port, 'toggle', { kind: 'plugin' })
    assertEqual(badPayload.body.data.code, 'bad-payload', 'bad payload code')
    sameJson(setEnabledCalls, [['p1', true]], 'no extra manager calls')
    return 'read-only / unknown-plugin / bad-payload'
  })

  // ── (5) doctor ──────────────────────────────────────────────────────────

  await test('(5) doctor answers the ten checks, host-contract among them', async () => {
    const res = await op(port, 'doctor')
    assertEqual(res.status, 200, 'status')
    assertEqual(res.body.ok, true, 'ok')
    const checks = res.body.data.checks
    assertEqual(checks.length, 10, 'check count')
    sameList(checks.map(row => row.id), DOCTOR_IDS, 'check ids')
    const failing = checks.filter(row => !row.ok)
    assertEqual(failing.length, 0, 'failing checks: ' + JSON.stringify(failing))
    const contract = checks.find(row => row.id === 'host-contract')
    assert(contract !== undefined, 'host-contract present')
    assertEqual(contract.detail, '15/15 host member(s)', 'host-contract detail')
    assertEqual(checks.find(row => row.id === 'mount-heartbeat').ok, true, 'mount heartbeat')
    assert(checks.find(row => row.id === 'patch-parse').detail.indexOf('2 MCP row(s)') !== -1, 'patch rows')
    return '10/10, host-contract 15/15'
  })

  // ── unknown op through apply's wrapper ──────────────────────────────────

  await test('unknown op stays structured through apply', async () => {
    const res = await op(port, 'nope.op')
    assertEqual(res.status, 200, 'status')
    assertEqual(res.body.ok, false, 'ok')
    assertEqual(res.body.error.code, 'bad-op', 'code')
    return 'ok:false bad-op'
  })

  await test('snapshot exposes the dispatch history', async () => {
    const res = await request(port, V1_SNAPSHOT + '?fresh=1')
    const history = res.body.data.history
    assert(Array.isArray(history) && history.length > 0, 'history rows: ' + JSON.stringify(history))
    assert(history.some(row => row.op === 'settings.set' && row.audit === true), 'settings.set is audited')
    assert(history.some(row => row.op === 'toggle'), 'toggle recorded')
    return history.length + ' row(s)'
  })

  // ── (6) gates ───────────────────────────────────────────────────────────

  await test('(6) 401 / 403 still refuse through apply', async () => {
    connection.requestRejection = () => 401
    const unauthorized = await request(port, V1_SNAPSHOT)
    assertEqual(unauthorized.status, 401, '401 status')
    assertEqual(unauthorized.body.error.code, 'unauthorized', '401 code')
    assertEqual(unauthorized.body.error.message, 'DSH browser authentication is required', '401 message')
    connection.requestRejection = () => 403
    const forbidden = await op(port, 'core.ping')
    assertEqual(forbidden.status, 403, '403 status')
    assertEqual(forbidden.body.error.code, 'forbidden', '403 code')
    connection.requestRejection = () => {
      throw new Error('gate exploded')
    }
    const thrown = await request(port, SNAPSHOT)
    assertEqual(thrown.status, 403, 'throwing gate refuses')
    connection.requestRejection = () => undefined
    const open = await request(port, SNAPSHOT)
    assertEqual(open.status, 200, 'open again')
    return '401 / 403 / fail-closed / open'
  })

  // ── (7) teardown ────────────────────────────────────────────────────────

  await test('(7) the ctx.effect cleanup leaves zero routes', async () => {
    assert(effects.length >= 1, 'apply registered an effect')
    assert(typeof effects[0] === 'function', 'the effect returned a disposer')
    for (const dispose of effects) dispose()
    assertEqual(web.handlers.size, 0, 'routes after cleanup')
    const after = await request(port, V1_SNAPSHOT)
    assertEqual(after.status, 404, 'the server has no route left')
    return 'effects=' + String(effectCalls) + ', routes=0'
  })
}
finally {
  web.dispose()
  await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}

console.log('integration probe: ' + passed + ' PASS / ' + failed + ' FAIL')
if (failed > 0) {
  console.log('failed: ' + failedNames.join(', '))
  process.exit(1)
}
