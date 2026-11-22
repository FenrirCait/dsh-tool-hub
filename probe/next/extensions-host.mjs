#!/usr/bin/env node
/**
 * probe/next/extensions-host.mjs - local extensions through the real 2.0 Runtime.
 *
 * The Extensions view is only as good as the loader behind it: one folder per extension, a
 * manifest, an ESM host entry, and a hard rule that an extension may add ops under its own id
 * namespace and nothing else. This probe starts the compiled host (dist/host/index.js), points
 * TOOL_HUB_STATE_FILE at a throw-away state document, fills <state dir>/extensions with fixtures,
 * serves the official catalog from a 127.0.0.1 fixture server and drives Runtime directly - no
 * panel, no build, and never the public network.
 *
 * What it pins down (the acceptance list for task-25):
 *   1. discovery answers enabled / disabled / broken folders as status rows and never throws;
 *   2. enabling an extension makes its ops callable, disabling takes them away again (bad-op);
 *   3. the enabled list round-trips through state.json and survives a fresh Runtime;
 *   4. extension.reload picks up changed host code with no host restart;
 *   5. one broken extension never takes the host down - extension.list / snapshot keep working;
 *   6. the namespace, reserved-id, view-op and host-path rules reject at load time;
 *   7. a declared settings field appears in the snapshot schema with its default;
 *   8. compat.index reads the fixture catalog, caches it for compat.cacheMinutes, refreshes on
 *      force, falls back to the mirror and refuses a plain-http URL before any request leaves;
 *   9. compat.install verifies every file's bytes and sha256, refuses traversal and oversized
 *      entries while parsing, backs an existing copy up into the backups folder and replaces it,
 *      and the installed folder is a normal local extension the switch can enable.
 *
 * Exit 1 when any check fails. dist/host/index.js must be current; no third-party libraries.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
// The built host, or a copy when TOOL_HUB_DIST points at one (same override as core-state.mjs).
const distRoot = resolve(process.env.TOOL_HUB_DIST ?? join(repoRoot, 'dist'))
// The built catalog module: its pure rules and constants are what the host runs, so the probe
// checks them directly instead of restating them.
const catalog = await import(pathToFileURL(join(distRoot, 'host', 'compat-catalog.js')).href)

// -- harness ----------------------------------------------------------------

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

function note(message) {
  console.log('NOTE ' + message)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
  }
}

function sameList(actual, expected, label) {
  assert(Array.isArray(actual), label + ': expected an array, got ' + typeof actual)
  assertEqual(actual.join(','), expected.join(','), label)
}

function sameJson(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(label + ': expected ' + right + ', got ' + left)
}

function includes(text, needle, label) {
  assert(typeof text === 'string' && text.includes(needle), label + ': ' + JSON.stringify(text) + ' does not contain ' + JSON.stringify(needle))
}

// -- fixture: a throw-away state dir, so the real ~/.dsh is never touched ---

const root = await mkdtemp(join(tmpdir(), 'tool-hub-extensions-'))
const dshHome = join(root, 'dsh-home')
const stateDir = join(dshHome, 'tool-hub')
const statePath = join(stateDir, 'state.json')
const extRoot = join(stateDir, 'extensions')
const skillsDir = join(root, 'skills')
const profileDir = join(dshHome, 'profiles', 'probe')

await mkdir(extRoot, { recursive: true })
await mkdir(skillsDir, { recursive: true })
await mkdir(profileDir, { recursive: true })

// -- fixture: a local catalog over HTTP (127.0.0.1 only) ---------------------

const DEMO_HOST_V1 = [
  'export default () => ({',
  "  module: { id: 'compat-demo', title: { zh: '演示配套', en: 'Demo pack' }, ops: [{ id: 'compat-demo.status', write: false, note: 'a read op' }] },",
  "  handlers: { 'compat-demo.status': async () => ({ marker: 'v1' }) },",
  '})',
  '',
].join('\n')

const DEMO_HOST_V2 = [
  'export default () => ({',
  "  module: { id: 'compat-demo', title: { zh: '演示配套', en: 'Demo pack' }, ops: [{ id: 'compat-demo.status', write: false, note: 'a read op' }] },",
  "  handlers: { 'compat-demo.status': async () => ({ marker: 'v2' }) },",
  '})',
  '',
].join('\n')

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** What the fixture catalog serves right now; the update test flips the version. */
const catalogState = { version: '1.0.0', indexBroken: false, mirrorBroken: false }
const hits = { index: 0, mirror: 0 }

function demoFiles() {
  return [
    { path: 'manifest.json', body: JSON.stringify({ id: 'compat-demo', name: { zh: '演示配套', en: 'Demo pack' }, version: catalogState.version, apiVersion: 1, host: 'host.mjs' }, null, 2) + '\n' },
    { path: 'host.mjs', body: catalogState.version === '2.0.0' ? DEMO_HOST_V2 : DEMO_HOST_V1 },
    { path: 'style.css', body: '.compat-demo { color: var(--th-text); }\n' },
  ]
}

function extraFiles() {
  return [
    { path: 'manifest.json', body: JSON.stringify({ id: 'compat-extra', name: { zh: '额外配套', en: 'Extra pack' }, version: '0.9.0', apiVersion: 1, host: 'host.mjs' }, null, 2) + '\n' },
    { path: 'host.mjs', body: "export default () => ({ module: { id: 'compat-extra', title: { zh: '额外', en: 'Extra' }, ops: [] }, handlers: {} })\n" },
  ]
}

/** Bodies for one id; the two deliberately broken packs serve the demo bytes. */
function filesOf(id) {
  if (id === 'compat-extra') return extraFiles()
  if (id === 'compat-demo' || id.startsWith('compat-bad-')) return demoFiles()
  return []
}

function packEntry(id, files, version = '1.0.0') {
  return {
    id,
    name: { zh: id + ' 配套', en: id + ' pack' },
    version,
    description: { zh: id + ' 的描述', en: 'Description of ' + id },
    files: files.map(file => ({
      path: file.path,
      url: BASE + '/files/' + id + '/' + file.path,
      bytes: Buffer.byteLength(file.body),
      sha256: sha256(file.body),
    })),
  }
}

/** A pack whose first file fails verification at install time. */
function brokenVerificationPack(id, patch) {
  const pack = packEntry(id, demoFiles())
  patch(pack.files[0])
  return pack
}

/** Packs the parser must drop; each one breaks exactly one rule. */
function droppedPacks() {
  const base = packEntry('compat-evil', demoFiles()).files[0]
  const url = BASE + '/files/compat-demo/manifest.json'
  return [
    { ...packEntry('compat-traversal', demoFiles()), files: [{ ...base, path: '../escape.txt', url }] },
    { ...packEntry('compat-plain-http', demoFiles()), files: [{ ...base, path: 'payload.txt', url: 'http://example.com/payload.txt' }] },
    { ...packEntry('compat-too-big', demoFiles()), files: [{ ...base, bytes: catalog.MAX_FILE_BYTES + 1 }] },
    {
      ...packEntry('compat-huge', demoFiles()),
      files: Array.from({ length: 5 }, (_, index) => ({ ...base, path: 'big-' + index + '.bin', bytes: Math.ceil(catalog.MAX_PACK_BYTES / 5) + 1 })),
    },
  ]
}

function indexDocument() {
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    packs: [
      packEntry('compat-demo', demoFiles(), catalogState.version),
      packEntry('compat-extra', extraFiles()),
      brokenVerificationPack('compat-bad-hash', file => { file.sha256 = '0'.repeat(64) }),
      brokenVerificationPack('compat-bad-bytes', file => { file.bytes = 1 }),
      ...droppedPacks(),
    ],
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const send = (status, body, type) => {
    response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
    response.end(body)
  }
  if (url.pathname === '/index.json') {
    hits.index += 1
    if (catalogState.indexBroken) return send(503, 'index down', 'text/plain')
    return send(200, JSON.stringify(indexDocument()), 'application/json')
  }
  if (url.pathname === '/mirror.json') {
    hits.mirror += 1
    if (catalogState.mirrorBroken) return send(503, 'mirror down', 'text/plain')
    return send(200, JSON.stringify(indexDocument()), 'application/json')
  }
  const match = /^\/files\/([^/]+)\/(.+)$/.exec(url.pathname)
  if (match !== null) {
    const id = decodeURIComponent(match[1])
    const file = decodeURIComponent(match[2])
    const found = filesOf(id).find(entry => entry.path === file)
    if (found === undefined) return send(404, 'no file', 'text/plain')
    return send(200, found.body, 'application/octet-stream')
  }
  send(404, 'no route', 'text/plain')
})
await new Promise(resolveListen => {
  server.listen(0, '127.0.0.1', resolveListen)
})
const BASE = 'http://127.0.0.1:' + server.address().port

process.env.DSH_HOME = dshHome
process.env.TOOL_HUB_STATE_FILE = statePath
process.env.TOOL_HUB_SKILL_ROOTS = skillsDir
process.env.TOOL_HUB_WORKSPACES = '-'

const v2State = {
  version: 2,
  groups: [],
  collections: [{ id: 'default', name: '\u9ed8\u8ba4\u5206\u7ec4\u7fa4', order: 0 }],
  presets: [],
  toolDeny: [],
  auto: { appliedAt: null },
  sessions: {},
  scenes: {},
  mode: null,
  settings: {
    'compat.indexUrl': BASE + '/index.json',
    'compat.mirrorUrl': BASE + '/mirror.json',
    'compat.cacheMinutes': 60,
  },
  modules: {},
  extensions: { enabled: ['hello'] },
}
await writeFile(statePath, JSON.stringify(v2State, null, 2) + '\n', 'utf8')

// -- fixture: extension folders ---------------------------------------------

function manifestOf(id, extra = {}) {
  return {
    id,
    name: { zh: id + ' \u6d4b\u8bd5\u6269\u5c55', en: id + ' fixture' },
    version: '1.0.0',
    apiVersion: 1,
    host: 'host.mjs',
    ...extra,
  }
}

async function writeExtension(folder, manifest, host) {
  const dir = join(extRoot, folder)
  await mkdir(dir, { recursive: true })
  if (manifest !== null) await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  if (host !== null) await writeFile(join(dir, 'host.mjs'), host, 'utf8')
  return dir
}

// A valid extension: one read op, one audited write op, one view, one settings field.
const HELLO_V1 = `export default (api) => ({
  module: {
    id: 'hello',
    title: { zh: 'Hello zh', en: 'Hello' },
    ops: [
      { id: 'hello.status', write: false, audit: false, note: 'reports the loaded code marker' },
      { id: 'hello.echo', write: true, audit: true, note: 'echoes the payload back' },
    ],
    settings: [
      { key: 'greeting', type: 'string', default: 'hi', label: { zh: 'Greeting zh', en: 'Greeting' } },
    ],
  },
  handlers: {
    'hello.status': async () => ({ marker: 'v1', apiVersion: api.version, id: api.id, hasDir: typeof api.dir === 'string' && api.dir.length > 0 }),
    'hello.echo': async (payload) => ({ echoed: payload }),
  },
})
`

// The same extension after a code change: a new op and a new marker, in a longer file so the
// loader's mtime:size cache key has to change.
const HELLO_V2 = `// reloaded fixture build: answers v2 and declares one more op
export default (api) => ({
  module: {
    id: 'hello',
    title: { zh: 'Hello zh', en: 'Hello' },
    ops: [
      { id: 'hello.status', write: false, audit: false, note: 'reports the loaded code marker' },
      { id: 'hello.echo', write: true, audit: true, note: 'echoes the payload back' },
      { id: 'hello.extra', write: false, audit: false, note: 'only the reloaded build declares this' },
    ],
    settings: [
      { key: 'greeting', type: 'string', default: 'hi', label: { zh: 'Greeting zh', en: 'Greeting' } },
    ],
  },
  handlers: {
    'hello.status': async () => ({ marker: 'v2', apiVersion: api.version, id: api.id, hasDir: typeof api.dir === 'string' && api.dir.length > 0 }),
    'hello.echo': async (payload) => ({ echoed: payload }),
    'hello.extra': async () => ({ extra: true }),
  },
})
`

const IDLE_HOST = `export default () => ({
  module: {
    id: 'idle',
    title: { zh: 'Idle zh', en: 'Idle' },
    ops: [{ id: 'idle.ping', write: false, note: 'a read op' }],
  },
  handlers: { 'idle.ping': async () => ({ pong: true }) },
})
`

const helloDir = await writeExtension('hello', manifestOf('hello', {
  views: [{ id: 'greet', title: { zh: '\u95ee\u5019', en: 'Greeting' }, kind: 'table', op: 'hello.status' }],
}), HELLO_V1)

// A second valid extension, disabled at start. Its view declares neither title nor kind, so the
// manifest normaliser has to fill both in.
await writeExtension('idle', manifestOf('idle', { views: [{ id: 'ping', op: 'idle.ping' }] }), IDLE_HOST)

// import-time failure and activate-time failure
await writeExtension('broken', manifestOf('broken'), `throw new Error('import boom')
export default () => ({})
`)
await writeExtension('refuse', manifestOf('refuse'), `export default () => { throw new Error('activate boom') }
`)

// namespace violation: an op outside the extension id namespace
await writeExtension('foreign', manifestOf('foreign'), `export default () => ({
  module: {
    id: 'foreign',
    title: { zh: 'Foreign zh', en: 'Foreign' },
    ops: [
      { id: 'foreign.status', write: false, note: 'own namespace' },
      { id: 'other.status', write: false, note: 'wrong namespace' },
    ],
  },
  handlers: { 'foreign.status': async () => ({}), 'other.status': async () => ({}) },
})
`)

// a view bound to a write op
await writeExtension('writeview', manifestOf('writeview', {
  views: [{ id: 'edit', title: { zh: '\u7f16\u8f91', en: 'Edit' }, kind: 'table', op: 'writeview.touch' }],
}), `export default () => ({
  module: {
    id: 'writeview',
    title: { zh: 'Writeview zh', en: 'Writeview' },
    ops: [{ id: 'writeview.touch', write: true, note: 'a write op' }],
  },
  handlers: { 'writeview.touch': async () => ({ touched: true }) },
})
`)

// a view pointing at an op the extension never declares
await writeExtension('dangling', manifestOf('dangling', {
  views: [{ id: 'ghost', title: { zh: '\u5e7b\u5f71', en: 'Ghost' }, kind: 'list', op: 'dangling.absent' }],
}), `export default () => ({
  module: {
    id: 'dangling',
    title: { zh: 'Dangling zh', en: 'Dangling' },
    ops: [{ id: 'dangling.status', write: false, note: 'the only real op' }],
  },
  handlers: { 'dangling.status': async () => ({}) },
})
`)

// a reserved id, a manifest from a future api version, a folder without a manifest,
// a host path that escapes the folder, and an id that breaks the regex. "compat" is reserved by
// the official-pack module (a folder of that name would clash with the compat domain).
await writeExtension('core', manifestOf('core'), IDLE_HOST)
await writeExtension('compat', manifestOf('compat'), IDLE_HOST)
await writeExtension('badmanifest', { ...manifestOf('badmanifest'), apiVersion: 3 }, IDLE_HOST)
await writeExtension('nomanifest', null, IDLE_HOST)
await writeExtension('escape', manifestOf('escape', { host: '../escape.mjs' }), IDLE_HOST)
await writeExtension('invalid', { ...manifestOf('Bad_Id') }, IDLE_HOST)

// -- load the compiled host --------------------------------------------------

let hub
try {
  hub = await import(pathToFileURL(join(distRoot, 'host', 'index.js')).href)
}
catch (error) {
  console.log('FAIL build  ' + join(distRoot, 'host', 'index.js') + ' is missing or broken - run npm run build:host')
  console.log('  ' + String(error && error.message ? error.message : error))
  process.exit(1)
}

// -- fake cordis context: only the services the host reads -------------------

const logs = []
const services = {
  pluginManager: {
    listPlugins: async () => [],
    listBundles: async () => [],
    setPluginEnabled: async () => ({ application: 'applied' }),
  },
  tools: { view: () => ({ knownNames: [] }), restrict: () => undefined },
  connection: { requestRejection: () => undefined },
  agents: { list: async () => [] },
  workspaces: { list: () => [] },
  workspaceRegistry: { list: () => [] },
  sessions: { listWorkspaces: () => [] },
  profileContext: { dir: profileDir },
}
const ctx = {
  get: name => services[name],
  logger: {
    info: message => logs.push('info:' + message),
    warn: message => logs.push('warn:' + message),
  },
}

// -- small readers over the runtime -----------------------------------------

async function run(runtime, op, payload) {
  return await runtime.run(op, payload)
}

async function list(runtime) {
  const outcome = await run(runtime, 'extension.list', {})
  assert(outcome.ok === true, 'extension.list failed: ' + JSON.stringify(outcome.error))
  return outcome.data
}

function rowsOf(rows, id) {
  return rows.filter(row => row && row.id === id)
}

function oneRow(rows, id) {
  const found = rowsOf(rows, id)
  assert(found.length > 0, 'no status row for ' + id + ' (rows: ' + rows.map(row => row && row.id).join(',') + ')')
  return found[0]
}

async function statusOf(runtime, id) {
  return oneRow((await list(runtime)).extensions, id)
}

async function setExtension(runtime, id, enabled) {
  return await run(runtime, 'extension.set', { id, enabled })
}

/** Regular files under a folder, so the copy can be compared with its source tree. */
async function countFiles(dir) {
  let files = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) files += await countFiles(join(dir, entry.name))
    else if (entry.isFile()) files += 1
  }
  return files
}

// -- checks ------------------------------------------------------------------

let runtime = null

try {
  // 1. the host builds with an extension enabled
  await test('runtime-create', async () => {
    runtime = await hub.Runtime.create(ctx)
    assert(typeof runtime.run === 'function', 'Runtime.create returned no run()')
    const created = logs.filter(line => line.startsWith('info:dsh-tool-hub 2.0:'))
    assert(created.length === 1, 'startup log: ' + JSON.stringify(created))
    return created[0].replace('info:', '')
  })

  // 2. an enabled extension is discovered, loaded and reports its ops and view
  await test('discover-loaded', async () => {
    const row = await statusOf(runtime, 'hello')
    assertEqual(row.enabled, true, 'hello.enabled')
    assertEqual(row.loaded, true, 'hello.loaded')
    assertEqual(row.error, null, 'hello.error')
    assertEqual(row.version, '1.0.0', 'hello.version')
    assertEqual(row.apiVersion, 1, 'hello.apiVersion')
    assertEqual(row.dir, helloDir, 'hello.dir')
    sameList(row.ops, ['hello.status', 'hello.echo'], 'hello.ops')
    assertEqual(row.views.length, 1, 'hello.views')
    assertEqual(row.views[0].id, 'greet', 'view id')
    assertEqual(row.views[0].kind, 'table', 'view kind')
    assertEqual(row.views[0].op, 'hello.status', 'view op')
    return row.ops.join(' ') + ' | view ' + row.views[0].id
  })

  // 3. a discovered but disabled extension is a quiet row with no ops, and its view defaults fill in
  await test('discover-disabled', async () => {
    const row = await statusOf(runtime, 'idle')
    assertEqual(row.enabled, false, 'idle.enabled')
    assertEqual(row.loaded, false, 'idle.loaded')
    assertEqual(row.error, null, 'idle.error')
    sameList(row.ops, [], 'idle.ops')
    assertEqual(row.views.length, 1, 'idle.views')
    assertEqual(row.views[0].id, 'ping', 'default view id')
    sameJson(row.views[0].title, { zh: 'ping', en: 'ping' }, 'default view title')
    assertEqual(row.views[0].kind, 'json', 'default view kind')
    return 'disabled row, view ' + row.views[0].id + '/' + row.views[0].kind
  })

  // 4. a reserved id is refused at discovery, before any code runs
  await test('discover-reserved-id', async () => {
    const row = await statusOf(runtime, 'core')
    assertEqual(row.loaded, false, 'core.loaded')
    assertEqual(row.enabled, false, 'core.enabled')
    assertEqual(row.error, 'id "core" is reserved', 'core.error')
    const compat = await statusOf(runtime, 'compat')
    assertEqual(compat.error, 'id "compat" is reserved', 'compat.error')
    return row.error + '; compat reserved too'
  })

  // 5. the manifest rules: apiVersion, missing manifest, host path escape, bad id
  await test('discover-manifest-rules', async () => {
    const { extensions } = await list(runtime)
    const api = oneRow(extensions, 'badmanifest')
    includes(api.error, 'apiVersion must be 1 or 2', 'apiVersion')
    const missing = oneRow(extensions, 'nomanifest')
    includes(missing.error, 'manifest.json:', 'missing manifest')
    const escape = oneRow(extensions, 'escape')
    includes(escape.error, 'host must be a relative path inside the extension folder', 'host escape')
    const invalid = oneRow(extensions, 'invalid')
    includes(invalid.error, 'id must match', 'invalid id')
    for (const row of [api, missing, escape, invalid]) {
      assertEqual(row.loaded, false, row.id + '.loaded')
      sameList(row.ops, [], row.id + '.ops')
    }
    return 'apiVersion / missing / escape / bad id all refused'
  })

  // 6. extension.list is the panel's one read: sorted rows, the enabled list, the documented fields
  await test('extension-list-shape', async () => {
    const data = await list(runtime)
    sameList(data.enabled, ['hello'], 'enabled list')
    assert(data.extensions.length >= 12, 'status rows: ' + data.extensions.length)
    for (let index = 1; index < data.extensions.length; index += 1) {
      const previous = data.extensions[index - 1].id
      const current = data.extensions[index].id
      assert(previous.localeCompare(current) <= 0, 'rows are not sorted: ' + previous + ' > ' + current)
    }
    for (const key of ['id', 'name', 'version', 'apiVersion', 'dir', 'enabled', 'loaded', 'error', 'ops', 'views']) {
      assert(key in data.extensions[0], 'status row is missing ' + key)
    }
    // The package ships no pack any more, so a row must not carry the bundled flags at all.
    assert(!('bundled' in data.extensions[0]), 'a status row still carries bundled')
    assert(!('overridesBundled' in data.extensions[0]), 'a status row still carries overridesBundled')
    assert(!('bundledVersion' in data.extensions[0]), 'a status row still carries bundledVersion')
    return data.extensions.length + ' rows, enabled ' + JSON.stringify(data.enabled)
  })

  // 7. an enabled extension's read op is callable, and it saw the api object
  await test('op-callable', async () => {
    const outcome = await run(runtime, 'hello.status', {})
    assert(outcome.ok === true, 'hello.status failed: ' + JSON.stringify(outcome.error))
    assertEqual(outcome.data.marker, 'v1', 'marker')
    assertEqual(outcome.data.apiVersion, 1, 'api.version')
    assertEqual(outcome.data.id, 'hello', 'api.id')
    assertEqual(outcome.data.hasDir, true, 'api.dir')
    return 'marker v1, api id hello, dir passed through'
  })

  // 8. a declared write op runs through run() and round-trips its payload
  await test('write-op-roundtrip', async () => {
    const payload = { text: '\u4f60\u597d', n: 7, nested: { ok: true } }
    const outcome = await run(runtime, 'hello.echo', payload)
    assert(outcome.ok === true, 'hello.echo failed: ' + JSON.stringify(outcome.error))
    sameJson(outcome.data.echoed, payload, 'echoed payload')
    return 'payload round-tripped'
  })

  // 9. audit comes from the op declaration: the write op is audited, the read op is not
  await test('history-audit-flags', async () => {
    const history = await runtime.dispatcher.history()
    const echo = history.filter(row => row.op === 'hello.echo' && row.ok === true)
    const status = history.filter(row => row.op === 'hello.status' && row.ok === true)
    assert(echo.length > 0 && status.length > 0, 'history rows missing: ' + JSON.stringify(history.map(row => row.op)))
    assertEqual(echo[0].audit, true, 'hello.echo.audit')
    assertEqual(status[0].audit, false, 'hello.status.audit')
    return echo[0].op + ' audit=true, ' + status[0].op + ' audit=false'
  })

  // 10. snapshot carries the extension rows and the settings field the extension declared
  await test('snapshot-extension-settings', async () => {
    const outcome = await run(runtime, 'snapshot', { fresh: true })
    assert(outcome.ok === true, 'snapshot failed: ' + JSON.stringify(outcome.error))
    const data = outcome.data
    const rows = data.extensions.filter(row => row && row.id === 'hello')
    assertEqual(rows.length, 1, 'hello rows in snapshot')
    assertEqual(rows[0].loaded, true, 'snapshot hello.loaded')
    const field = data.settingsSchema.find(row => row.key === 'hello.greeting')
    assert(field !== undefined, 'settingsSchema has no hello.greeting: ' + JSON.stringify(data.settingsSchema.map(row => row.key)))
    assertEqual(field.type, 'string', 'hello.greeting type')
    assertEqual(field.default, 'hi', 'hello.greeting default')
    assertEqual(data.settings['hello.greeting'], 'hi', 'settings default applied')
    assertEqual(data.paths.state, statePath, 'paths.state')
    return 'hello row + hello.greeting=hi'
  })

  // 11. disabling takes the ops away: the next call is a bad-op, the row says disabled
  await test('disable-then-bad-op', async () => {
    const set = await setExtension(runtime, 'hello', false)
    assert(set.ok === true, 'extension.set failed: ' + JSON.stringify(set.error))
    sameList(set.data.enabled, [], 'enabled after disable')
    const gone = await run(runtime, 'hello.status', {})
    assertEqual(gone.ok, false, 'hello.status after disable')
    assertEqual(gone.error.code, 'bad-op', 'error code')
    const row = await statusOf(runtime, 'hello')
    assertEqual(row.enabled, false, 'hello.enabled')
    assertEqual(row.loaded, false, 'hello.loaded')
    assertEqual(row.error, null, 'hello.error')
    sameList(row.ops, [], 'hello.ops')
    return 'bad-op ' + JSON.stringify(gone.error.message)
  })

  // 12. enabling a second extension adds exactly its ops
  await test('enable-idle', async () => {
    const set = await setExtension(runtime, 'idle', true)
    assert(set.ok === true, 'extension.set failed: ' + JSON.stringify(set.error))
    sameList(set.data.enabled, ['idle'], 'enabled after enable')
    const outcome = await run(runtime, 'idle.ping', {})
    assert(outcome.ok === true, 'idle.ping failed: ' + JSON.stringify(outcome.error))
    assertEqual(outcome.data.pong, true, 'pong')
    const row = await statusOf(runtime, 'idle')
    assertEqual(row.loaded, true, 'idle.loaded')
    sameList(row.ops, ['idle.ping'], 'idle.ops')
    return 'idle.ping answered'
  })

  // 13. extension.set validates its payload before touching state
  await test('set-bad-payloads', async () => {
    const cases = [
      [{}, 'no id'],
      [{ id: 'idle' }, 'no enabled'],
      [{ id: 'IDLE', enabled: true }, 'uppercase id'],
      [{ id: 'idle', enabled: 'yes' }, 'enabled is not a boolean'],
    ]
    const codes = []
    for (const [payload, label] of cases) {
      const outcome = await run(runtime, 'extension.set', payload)
      assertEqual(outcome.ok, false, label)
      codes.push(outcome.error.code)
    }
    sameList(codes, ['bad-payload', 'bad-payload', 'bad-payload', 'bad-payload'], 'codes')
    sameList((await list(runtime)).enabled, ['idle'], 'enabled unchanged')
    return '4 rejected payloads, state untouched'
  })

  // 14. enabling something that is not installed is refused by name
  await test('set-unknown-missing', async () => {
    const outcome = await setExtension(runtime, 'ghost', true)
    assertEqual(outcome.ok, false, 'ghost enable')
    assertEqual(outcome.error.code, 'missing-extension', 'error code')
    includes(outcome.error.message, 'ghost', 'message names the id')
    sameList((await list(runtime)).enabled, ['idle'], 'enabled unchanged')
    return outcome.error.message
  })

  // 15. the enabled list is persisted into state.json and the op leaves an audit line
  await test('persist-enabled-list', async () => {
    const text = await readFile(statePath, 'utf8')
    const state = JSON.parse(text)
    assertEqual(state.version, 2, 'state version')
    sameList(state.extensions.enabled, ['idle'], 'state.extensions.enabled')
    const history = await readFile(join(stateDir, 'history.jsonl'), 'utf8')
    includes(history, 'extension.set', 'history records the set')
    return 'state v2, enabled ["idle"], history has extension.set'
  })

  // 16. a fresh Runtime reads that list back: the enabling survives a restart
  await test('restart-persistence', async () => {
    const restarted = await hub.Runtime.create(ctx)
    const data = await list(restarted)
    sameList(data.enabled, ['idle'], 'restarted enabled list')
    assertEqual(oneRow(data.extensions, 'idle').loaded, true, 'restarted idle.loaded')
    assertEqual(oneRow(data.extensions, 'hello').loaded, false, 'restarted hello.loaded')
    const pong = await run(restarted, 'idle.ping', {})
    assertEqual(pong.ok, true, 'restarted idle.ping')
    const gone = await run(restarted, 'hello.status', {})
    assertEqual(gone.error.code, 'bad-op', 'restarted hello.status')
    return 'second Runtime: idle callable, hello bad-op'
  })

  // 17. re-enabling hello, still on the original build
  await test('enable-hello-again', async () => {
    const set = await setExtension(runtime, 'hello', true)
    assert(set.ok === true, 'extension.set failed: ' + JSON.stringify(set.error))
    sameList(set.data.enabled, ['hello', 'idle'], 'enabled list')
    const status = await run(runtime, 'hello.status', {})
    assertEqual(status.data.marker, 'v1', 'marker before any code change')
    return 'enabled, still v1'
  })

  // 18. changing host.mjs alone changes nothing until a reload is asked for
  await test('code-change-needs-reload', async () => {
    await writeFile(join(helloDir, 'host.mjs'), HELLO_V2, 'utf8')
    const before = await readFile(join(helloDir, 'host.mjs'), 'utf8')
    includes(before, 'hello.extra', 'fixture file rewritten')
    const status = await run(runtime, 'hello.status', {})
    assertEqual(status.data.marker, 'v1', 'marker without a reload')
    const row = await statusOf(runtime, 'hello')
    sameList(row.ops, ['hello.status', 'hello.echo'], 'ops without a reload')
    return 'v1 and 2 ops until reload'
  })

  // 19. any rebuild (not just reload) re-imports because the cache key is mtime:size
  await test('rebuild-reimports-changed-code', async () => {
    const off = await setExtension(runtime, 'idle', false)
    assert(off.ok === true, 'extension.set failed: ' + JSON.stringify(off.error))
    const status = await run(runtime, 'hello.status', {})
    assertEqual(status.data.marker, 'v2', 'marker after a rebuild')
    const row = await statusOf(runtime, 'hello')
    sameList(row.ops, ['hello.status', 'hello.echo', 'hello.extra'], 'ops after a rebuild')
    const on = await setExtension(runtime, 'idle', true)
    assert(on.ok === true, 're-enabling idle failed: ' + JSON.stringify(on.error))
    const again = await run(runtime, 'hello.status', {})
    assertEqual(again.data.marker, 'v2', 'marker after two rebuilds')
    return 'v2 and 3 ops after a plain rebuild'
  })

  // 21. reload re-imports the code: new marker, the new op, the new op count
  await test('reload-picks-up-code', async () => {
    const reload = await run(runtime, 'extension.reload', { id: 'hello' })
    assert(reload.ok === true, 'extension.reload failed: ' + JSON.stringify(reload.error))
    assertEqual(reload.data.reloaded, 'hello', 'reloaded id')
    const status = await run(runtime, 'hello.status', {})
    assertEqual(status.data.marker, 'v2', 'marker after reload')
    const extra = await run(runtime, 'hello.extra', {})
    assertEqual(extra.ok, true, 'hello.extra after reload')
    assertEqual(extra.data.extra, true, 'extra payload')
    const row = await statusOf(runtime, 'hello')
    sameList(row.ops, ['hello.status', 'hello.echo', 'hello.extra'], 'ops after reload')
    assertEqual(row.loaded, true, 'hello.loaded')
    return 'v2, 3 ops'
  })

  // 22. a reload with no id invalidates every extension and keeps the build healthy
  await test('reload-all', async () => {
    const reload = await run(runtime, 'extension.reload', {})
    assert(reload.ok === true, 'extension.reload failed: ' + JSON.stringify(reload.error))
    assertEqual(reload.data.reloaded, '*', 'reloaded marker')
    const status = await run(runtime, 'hello.status', {})
    assertEqual(status.data.marker, 'v2', 'marker after reload all')
    return 'reloaded *, still v2'
  })

  // 23. an extension whose import throws is a failed row, and the host keeps answering
  await test('broken-import-isolated', async () => {
    const set = await setExtension(runtime, 'broken', true)
    assert(set.ok === true, 'the enable itself failed: ' + JSON.stringify(set.error))
    const row = await statusOf(runtime, 'broken')
    assertEqual(row.loaded, false, 'broken.loaded')
    includes(row.error, 'import boom', 'broken.error')
    sameList(row.ops, [], 'broken.ops')
    const hello = await run(runtime, 'hello.status', {})
    assertEqual(hello.ok, true, 'hello.status with a broken extension present')
    const snapshot = await run(runtime, 'snapshot', {})
    assertEqual(snapshot.ok, true, 'snapshot with a broken extension present')
    return 'import boom contained, host healthy'
  })

  // 24. an extension whose activate() throws is contained the same way
  await test('broken-activate-isolated', async () => {
    const set = await setExtension(runtime, 'refuse', true)
    assert(set.ok === true, 'the enable itself failed: ' + JSON.stringify(set.error))
    const row = await statusOf(runtime, 'refuse')
    assertEqual(row.loaded, false, 'refuse.loaded')
    includes(row.error, 'activate boom', 'refuse.error')
    const data = await list(runtime)
    assert(data.extensions.some(entry => entry.id === 'refuse' && entry.error !== null), 'refuse row missing')
    const hello = await run(runtime, 'hello.status', {})
    assertEqual(hello.data.marker, 'v2', 'hello.status after a failed activate')
    return 'activate boom contained'
  })

  // 25. an op outside the extension namespace is refused before it can reach the registry
  await test('namespace-violation', async () => {
    const set = await setExtension(runtime, 'foreign', true)
    assert(set.ok === true, 'the enable itself failed: ' + JSON.stringify(set.error))
    const row = await statusOf(runtime, 'foreign')
    assertEqual(row.loaded, false, 'foreign.loaded')
    includes(row.error, 'must start with "foreign."', 'foreign.error')
    const stolen = await run(runtime, 'other.status', {})
    assertEqual(stolen.ok, false, 'other.status')
    assertEqual(stolen.error.code, 'bad-op', 'other.status code')
    const hello = await run(runtime, 'hello.status', {})
    assertEqual(hello.ok, true, 'hello.status after a namespace violation')
    return row.error
  })

  // 26. a view bound to a write op is refused
  await test('view-write-rejected', async () => {
    const set = await setExtension(runtime, 'writeview', true)
    assert(set.ok === true, 'the enable itself failed: ' + JSON.stringify(set.error))
    const row = await statusOf(runtime, 'writeview')
    assertEqual(row.loaded, false, 'writeview.loaded')
    includes(row.error, 'must point at a read op', 'writeview.error')
    const touch = await run(runtime, 'writeview.touch', {})
    assertEqual(touch.ok, false, 'writeview.touch')
    assertEqual(touch.error.code, 'bad-op', 'writeview.touch code')
    return row.error
  })

  // 27. a view pointing at an undeclared op is refused
  await test('view-undeclared-op', async () => {
    const set = await setExtension(runtime, 'dangling', true)
    assert(set.ok === true, 'the enable itself failed: ' + JSON.stringify(set.error))
    const row = await statusOf(runtime, 'dangling')
    assertEqual(row.loaded, false, 'dangling.loaded')
    includes(row.error, 'points at undeclared op', 'dangling.error')
    return row.error
  })

  // 28. enabling a reserved folder is accepted into the list but can never register an op
  await test('reserved-enable-registers-nothing', async () => {
    const set = await setExtension(runtime, 'core', true)
    assert(set.ok === true, 'the enable itself threw: ' + JSON.stringify(set.error))
    const rows = rowsOf((await list(runtime)).extensions, 'core')
    assert(rows.length > 0, 'no core rows after enabling')
    for (const row of rows) {
      assertEqual(row.loaded, false, row.id + '.loaded')
      assert(typeof row.error === 'string' && row.error !== '', 'core row without an error: ' + JSON.stringify(row))
    }
    assert(rows.some(row => row.error.includes('reserved')), 'no reserved row: ' + JSON.stringify(rows.map(row => row.error)))
    const op = await run(runtime, 'core.list', {})
    assertEqual(op.ok, false, 'core.list')
    assertEqual(op.error.code, 'bad-op', 'core.list code')
    return rows.length + ' failed core rows, no core op registered'
  })

  // 29. after all of that the host still answers both of its own reads
  await test('host-healthy-after-failures', async () => {
    const snapshot = await run(runtime, 'snapshot', { fresh: true })
    assertEqual(snapshot.ok, true, 'snapshot after every failure')
    const data = await list(runtime)
    sameList(data.enabled, ['broken', 'core', 'dangling', 'foreign', 'hello', 'idle', 'refuse', 'writeview'], 'final enabled list')
    const hello = await run(runtime, 'hello.status', {})
    assertEqual(hello.data.marker, 'v2', 'hello.status at the end')
    return data.enabled.length + ' enabled, snapshot ok, hello v2'
  })

  // 30. the settings schema publishes the catalog contract, equal to the module constants
  await test('compat-settings-schema', async () => {
    const snapshot = await run(runtime, 'snapshot', { fresh: true })
    assertEqual(snapshot.ok, true, 'snapshot failed')
    const schema = snapshot.data.settingsSchema
    const index = schema.find(field => field.key === 'compat.indexUrl')
    const mirror = schema.find(field => field.key === 'compat.mirrorUrl')
    const cache = schema.find(field => field.key === 'compat.cacheMinutes')
    assert(index !== undefined && mirror !== undefined && cache !== undefined, 'compat settings missing: ' + JSON.stringify(schema.map(field => field.key)))
    assertEqual(index.default, catalog.DEFAULT_INDEX_URL, 'compat.indexUrl default')
    assertEqual(mirror.default, catalog.DEFAULT_MIRROR_URL, 'compat.mirrorUrl default')
    assertEqual(cache.default, catalog.DEFAULT_CACHE_MINUTES, 'compat.cacheMinutes default')
    assertEqual(index.type, 'string', 'index url is a string setting')
    return 'schema defaults match the catalog module'
  })

  // 31. the catalog read lists the packs and the local state each one has
  await test('compat-index-catalog', async () => {
    const outcome = await run(runtime, 'compat.index', {})
    assert(outcome.ok === true, 'compat.index failed: ' + JSON.stringify(outcome.error))
    const data = outcome.data
    assertEqual(data.source, 'index', 'first read comes from the index')
    // The two bad-verification packs parse fine and are listed; only their install fails.
    sameList(data.packs.map(pack => pack.id), ['compat-demo', 'compat-extra', 'compat-bad-hash', 'compat-bad-bytes'], 'catalog rows')
    const demo = data.packs[0]
    assertEqual(demo.version, '1.0.0', 'demo version')
    assertEqual(demo.installedVersion, '', 'nothing installed yet')
    assertEqual(demo.installedDir, '', 'no folder yet')
    assertEqual(demo.enabled, false, 'not enabled')
    assertEqual(demo.updateAvailable, false, 'no update before an install')
    assertEqual(demo.fileCount, 3, 'demo file count')
    sameJson(demo.name, { zh: 'compat-demo 配套', en: 'compat-demo pack' }, 'localized name')
    assert(data.warnings.length >= 4, 'the parser must report the packs it dropped: ' + JSON.stringify(data.warnings))
    for (const needle of ['unsafe file path', 'needs an https URL', 'larger than', 'files total more than']) {
      assert(data.warnings.some(warning => warning.includes(needle)), 'no warning about ' + needle + ': ' + JSON.stringify(data.warnings))
    }
    assertEqual(hits.index, 1, 'one index read')
    return data.packs.length + ' packs, ' + data.warnings.length + ' warnings'
  })

  // 32. a second read inside the cache window does not touch the network
  await test('compat-index-cache', async () => {
    const outcome = await run(runtime, 'compat.index', {})
    assert(outcome.ok === true, 'compat.index failed: ' + JSON.stringify(outcome.error))
    assertEqual(outcome.data.source, 'cache', 'cache hit')
    assertEqual(hits.index, 1, 'no extra index read')
    return 'source cache, ' + hits.index + ' index reads'
  })

  // 33. force is the panel refresh: it reads the network again
  await test('compat-index-refresh', async () => {
    const outcome = await run(runtime, 'compat.index', { force: true })
    assert(outcome.ok === true, 'compat.index failed: ' + JSON.stringify(outcome.error))
    assertEqual(outcome.data.source, 'index', 'a forced read is not a cache hit')
    assertEqual(hits.index, 2, 'the forced read hit the index')
    return 'source index, ' + hits.index + ' index reads'
  })

  // 34. an unreadable index falls back to the mirror, and says so
  await test('compat-index-mirror-fallback', async () => {
    catalogState.indexBroken = true
    try {
      const outcome = await run(runtime, 'compat.index', { force: true })
      assert(outcome.ok === true, 'compat.index failed: ' + JSON.stringify(outcome.error))
      assertEqual(outcome.data.source, 'mirror', 'mirror fallback')
      assertEqual(hits.mirror, 1, 'the mirror was read')
    }
    finally {
      catalogState.indexBroken = false
    }
    return 'index 503 -> source mirror'
  })

  // 35. both endpoints down is a reported failure, never an empty catalog
  await test('compat-index-unavailable', async () => {
    catalogState.indexBroken = true
    catalogState.mirrorBroken = true
    try {
      const outcome = await run(runtime, 'compat.index', { force: true })
      assertEqual(outcome.ok, false, 'both endpoints down must fail')
      assertEqual(outcome.error.code, 'index-unavailable', 'error code')
      includes(outcome.error.message, 'index:', 'the message names the first attempt')
      includes(outcome.error.message, 'mirror:', 'the message names the fallback')
    }
    finally {
      catalogState.indexBroken = false
      catalogState.mirrorBroken = false
    }
    return 'index-unavailable with both attempts named'
  })

  // 36. the URL rule: https or loopback http only, checked before any request
  await test('compat-index-url-policy', async () => {
    assert(catalog.parsePackUrl('https://example.com/index.json') !== null, 'https is allowed')
    assert(catalog.parsePackUrl('http://127.0.0.1:9/index.json') !== null, 'loopback http is allowed')
    assert(catalog.parsePackUrl('http://example.com/index.json') === null, 'plain http elsewhere is refused')
    assert(catalog.parsePackUrl('http://localhost:9/index.json') !== null, 'localhost is loopback')
    assert(catalog.parsePackUrl('ftp://example.com/index.json') === null, 'other protocols are refused')
    assert(catalog.parsePackUrl('not a url') === null, 'garbage is refused')
    const before = hits.index
    const set = await run(runtime, 'settings.set', { values: { 'compat.indexUrl': 'http://example.com/index.json' } })
    assertEqual(set.ok, true, 'settings.set failed')
    try {
      const outcome = await run(runtime, 'compat.index', { force: true })
      assertEqual(outcome.ok, false, 'a plain-http index must be refused')
      assertEqual(outcome.error.code, 'bad-url', 'error code')
      assertEqual(hits.index, before, 'a refused URL never reaches the network')
    }
    finally {
      const restore = await run(runtime, 'settings.set', { values: { 'compat.indexUrl': BASE + '/index.json' } })
      assertEqual(restore.ok, true, 'restoring the index URL failed')
    }
    return 'https/loopback only, no request for a refused URL'
  })

  // 37. the file-path rule is one pure function
  await test('compat-path-policy', async () => {
    assertEqual(catalog.safeRelativePath('style.css'), 'style.css', 'a plain file')
    assertEqual(catalog.safeRelativePath('sub/dir/app.js'), 'sub/dir/app.js', 'a nested file')
    assertEqual(catalog.safeRelativePath('..\\escape.txt'), null, 'a parent traversal')
    assertEqual(catalog.safeRelativePath('/etc/passwd'), null, 'an absolute path')
    assertEqual(catalog.safeRelativePath('C:/Windows/system.ini'), null, 'a drive path')
    assertEqual(catalog.safeRelativePath('a/../../b'), null, 'a nested traversal')
    assertEqual(catalog.safeRelativePath(''), null, 'an empty path')
    return 'plain and nested ok, traversal/absolute/drive refused'
  })

  // 38. cacheMinutes 0 disables the cache
  await test('compat-cache-off', async () => {
    const set = await run(runtime, 'settings.set', { values: { 'compat.cacheMinutes': 0 } })
    assertEqual(set.ok, true, 'settings.set failed')
    try {
      const before = hits.index
      const outcome = await run(runtime, 'compat.index', {})
      assert(outcome.ok === true, 'compat.index failed: ' + JSON.stringify(outcome.error))
      assertEqual(outcome.data.source, 'index', '0 minutes never serves the cache')
      assertEqual(hits.index, before + 1, '0 minutes reads the network')
    }
    finally {
      const restore = await run(runtime, 'settings.set', { values: { 'compat.cacheMinutes': 60 } })
      assertEqual(restore.ok, true, 'restoring cacheMinutes failed')
    }
    return 'cacheMinutes 0 reads the index every time'
  })

  // 39. install: payload gates and confirm:true, before anything is downloaded or written
  await test('compat-install-payloads', async () => {
    const target = join(extRoot, 'compat-demo')
    // The dispatcher's confirm gate runs before the handler, so a missing confirm wins over a
    // missing id; the id checks are exercised with confirm:true.
    const cases = [
      [{}, 'confirm-required', 'no payload at all'],
      [{ id: 'compat-demo' }, 'confirm-required', 'no confirmation'],
      [{ confirm: true }, 'bad-payload', 'confirmed but no id'],
      [{ id: 'Bad_Id', confirm: true }, 'bad-payload', 'uppercase id'],
      [{ id: 'no-such-pack', confirm: true }, 'unknown-pack', 'unknown pack'],
    ]
    for (const [payload, code, label] of cases) {
      const outcome = await run(runtime, 'compat.install', payload)
      assertEqual(outcome.ok, false, label)
      assertEqual(outcome.error.code, code, label + ' code')
    }
    assertEqual(await stat(target).then(() => false).catch(() => true), true, 'a refused install writes no folder')
    return 'confirm-required, bad-payload x2, unknown-pack; nothing written'
  })

  // 40. install: every file verified, then the folder appears and the row follows
  await test('compat-install-pack', async () => {
    const target = join(extRoot, 'compat-demo')
    const outcome = await run(runtime, 'compat.install', { id: 'compat-demo', confirm: true })
    assert(outcome.ok === true, 'compat.install failed: ' + JSON.stringify(outcome.error))
    assertEqual(outcome.data.id, 'compat-demo', 'installed id')
    assertEqual(outcome.data.version, '1.0.0', 'installed version')
    assertEqual(outcome.data.dir, target, 'installed dir')
    assertEqual(outcome.data.backup, '', 'a first install has nothing to back up')
    assertEqual(outcome.data.files, 3, 'installed file count')
    assertEqual(await readFile(join(target, 'host.mjs'), 'utf8'), demoFiles()[1].body, 'the host entry matches the index')
    for (const name of ['manifest.json', 'host.mjs', 'style.css']) {
      assert((await stat(join(target, name))).isFile(), 'installed file missing: ' + name)
    }
    const row = await statusOf(runtime, 'compat-demo')
    assertEqual(row.version, '1.0.0', 'the row reports the installed version')
    assertEqual(row.enabled, false, 'install never enables anything')
    assertEqual(row.dir, target, 'the row points at the folder')
    const index = await run(runtime, 'compat.index', {})
    const pack = oneRow(index.data.packs, 'compat-demo')
    assertEqual(pack.installedVersion, '1.0.0', 'index row installedVersion')
    assertEqual(pack.installedDir, target, 'index row installedDir')
    assertEqual(pack.updateAvailable, false, 'the same version is not an update')
    assertEqual(pack.enabled, false, 'not enabled yet')
    const history = (await readFile(join(stateDir, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const installed = history.filter(entry => entry.op === 'compat.install' && entry.ok === true)
    assert(installed.length > 0, 'history has no successful compat.install row')
    assertEqual(installed[installed.length - 1].audit, true, 'the install is audited')
    return '3 files verified and written, row installed but disabled'
  })

  // 41. a verification failure writes nothing and leaves no staging folder
  await test('compat-install-verify-failed', async () => {
    const badHash = await run(runtime, 'compat.install', { id: 'compat-bad-hash', confirm: true })
    assertEqual(badHash.ok, false, 'a wrong sha256 must fail')
    assertEqual(badHash.error.code, 'verify-failed', 'hash error code')
    includes(badHash.error.message, 'sha256', 'the message names the hash check')
    const badBytes = await run(runtime, 'compat.install', { id: 'compat-bad-bytes', confirm: true })
    assertEqual(badBytes.ok, false, 'a wrong byte count must fail')
    assertEqual(badBytes.error.code, 'verify-failed', 'bytes error code')
    includes(badBytes.error.message, 'bytes', 'the message names the byte check')
    for (const id of ['compat-bad-hash', 'compat-bad-bytes']) {
      assertEqual(await stat(join(extRoot, id)).then(() => false).catch(() => true), true, 'no folder after a failed verification: ' + id)
    }
    const leftovers = (await readdir(extRoot)).filter(name => name.startsWith('.'))
    sameList(leftovers, [], 'staging or retired folders')
    const backups = (await readdir(join(stateDir, 'backups')).catch(() => [])).filter(name => name.startsWith('extensions-compat-bad-'))
    sameList(backups, [], 'backups after a failed verification')
    return 'verify-failed x2, no folder, no staging, no backup'
  })

  // 42. update: the current copy is backed up, then replaced by the verified files
  await test('compat-install-update', async () => {
    const target = join(extRoot, 'compat-demo')
    let backupName = ''
    catalogState.version = '2.0.0'
    try {
      const index = await run(runtime, 'compat.index', { force: true })
      const pack = oneRow(index.data.packs, 'compat-demo')
      assertEqual(pack.version, '2.0.0', 'the catalog moved to 2.0.0')
      assertEqual(pack.installedVersion, '1.0.0', 'the local copy is still 1.0.0')
      assertEqual(pack.updateAvailable, true, 'a different version is an update')
      const outcome = await run(runtime, 'compat.install', { id: 'compat-demo', confirm: true })
      assert(outcome.ok === true, 'compat.install failed: ' + JSON.stringify(outcome.error))
      assertEqual(outcome.data.version, '2.0.0', 'updated version')
      const backup = outcome.data.backup
      assert(backup.startsWith(join(stateDir, 'backups') + sep), 'the backup is under backupDir: ' + backup)
      includes(basename(backup), 'extensions-compat-demo-', 'the backup folder is extensions-<id>-<stamp>')
      assertEqual(JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')).version, '1.0.0', 'the backup kept the old copy')
      const hostEntry = await readFile(join(target, 'host.mjs'), 'utf8')
      assertEqual(hostEntry, DEMO_HOST_V2, 'the target carries the new host entry')
      includes(hostEntry, 'v2', 'the new build really landed')
      const row = await statusOf(runtime, 'compat-demo')
      assertEqual(row.version, '2.0.0', 'the row reports the new version')
      backupName = basename(backup)
    }
    finally {
      catalogState.version = '1.0.0'
    }
    return 'backup ' + backupName + ', copy replaced at 2.0.0'
  })

  // 43. the enable switch works on an installed pack, and the catalog row follows it
  await test('compat-enable-installed', async () => {
    const set = await setExtension(runtime, 'compat-demo', true)
    assert(set.ok === true, 'extension.set failed: ' + JSON.stringify(set.error))
    const row = await statusOf(runtime, 'compat-demo')
    assertEqual(row.enabled, true, 'the installed pack is enabled')
    assertEqual(row.loaded, true, 'the installed pack loads')
    const op = await run(runtime, 'compat-demo.status', {})
    assertEqual(op.ok, true, 'the pack op is callable: ' + JSON.stringify(op.error))
    assertEqual(op.data.marker, 'v2', 'the op comes from the 2.0.0 build')
    const index = await run(runtime, 'compat.index', {})
    const pack = oneRow(index.data.packs, 'compat-demo')
    assertEqual(pack.enabled, true, 'the catalog row reports the switch')
    return 'enabled, op answers v2, catalog row enabled'
  })

  // 44. a pack the parser dropped can never be installed, and no traversal file appears
  await test('compat-dropped-packs-unreachable', async () => {
    for (const id of ['compat-traversal', 'compat-plain-http', 'compat-too-big', 'compat-huge']) {
      const outcome = await run(runtime, 'compat.install', { id, confirm: true })
      assertEqual(outcome.ok, false, id + ' must not be installable')
      assertEqual(outcome.error.code, 'unknown-pack', id + ' code')
    }
    assertEqual(await stat(join(stateDir, 'escape.txt')).then(() => false).catch(() => true), true, 'no file escaped the pack folder')
    assertEqual(await stat(join(root, 'escape.txt')).then(() => false).catch(() => true), true, 'no file escaped the fixture root')
    return '4 dropped packs unreachable, nothing escaped'
  })

  // 45. uninstall: payload gates, the confirm gate, and only an installed copy can go
  await test('compat-uninstall-payloads', async () => {
    const target = join(extRoot, 'compat-demo')
    // The dispatcher's confirm gate runs before the handler, exactly as for compat.install.
    const cases = [
      [{}, 'confirm-required', 'no payload at all'],
      [{ id: 'compat-demo' }, 'confirm-required', 'no confirmation'],
      [{ confirm: true }, 'bad-payload', 'confirmed but no id'],
      [{ id: 'Bad_Id', confirm: true }, 'bad-payload', 'uppercase id'],
      [{ id: 'compat-extra', confirm: true }, 'not-installed', 'a pack that was never installed'],
      [{ id: 'compat-nope', confirm: true }, 'not-installed', 'an id nothing installed'],
    ]
    for (const [payload, code, label] of cases) {
      const outcome = await run(runtime, 'compat.uninstall', payload)
      assertEqual(outcome.ok, false, label)
      assertEqual(outcome.error.code, code, label + ' code')
    }
    assertEqual(await stat(join(target, 'host.mjs')).then(info => info.isFile(), () => false), true, 'a refused uninstall leaves the installed copy alone')
    return 'confirm-required x2, bad-payload x2, not-installed x2; copy intact'
  })

  // 46. uninstall: backed up, removed, dropped from enabled, and the catalog row goes back to "not installed"
  await test('compat-uninstall-pack', async () => {
    const target = join(extRoot, 'compat-demo')
    await writeFile(join(target, 'marker.txt'), 'local only', 'utf8')
    const enabledBefore = JSON.parse(await readFile(statePath, 'utf8')).extensions.enabled
    assert(enabledBefore.includes('compat-demo'), 'the pack is enabled before the uninstall: ' + JSON.stringify(enabledBefore))
    const backupsBefore = (await readdir(join(stateDir, 'backups'))).filter(name => name.startsWith('extensions-compat-demo-')).length
    const outcome = await run(runtime, 'compat.uninstall', { id: 'compat-demo', confirm: true })
    assert(outcome.ok === true, 'compat.uninstall failed: ' + JSON.stringify(outcome.error))
    assertEqual(outcome.data.id, 'compat-demo', 'uninstalled id')
    const backup = outcome.data.backup
    assert(backup.startsWith(join(stateDir, 'backups') + sep), 'the backup is under backupDir: ' + backup)
    includes(basename(backup), 'extensions-compat-demo-', 'the backup folder is extensions-<id>-<stamp>')
    assertEqual(await readFile(join(backup, 'marker.txt'), 'utf8'), 'local only', 'the backup kept the local file')
    assertEqual(JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')).version, '2.0.0', 'the backup kept the installed version')
    const backupsAfter = (await readdir(join(stateDir, 'backups'))).filter(name => name.startsWith('extensions-compat-demo-')).length
    assertEqual(backupsAfter, backupsBefore + 1, 'exactly one backup was added')
    assertEqual(await stat(target).then(() => false).catch(() => true), true, 'the folder is gone')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    assertEqual(state.extensions.enabled.includes('compat-demo'), false, 'the id was dropped from the enabled list')
    const rows = (await list(runtime)).extensions
    assertEqual(rowsOf(rows, 'compat-demo').length, 0, 'no row for the removed pack (rows: ' + rows.map(row => row.id).join(',') + ')')
    const gone = await run(runtime, 'compat-demo.status', {})
    assertEqual(gone.ok, false, 'the pack op is gone')
    assertEqual(gone.error.code, 'bad-op', 'op code')
    const index = await run(runtime, 'compat.index', {})
    const pack = oneRow(index.data.packs, 'compat-demo')
    assertEqual(pack.installedVersion, '', 'the catalog row says not installed')
    assertEqual(pack.installedDir, '', 'no installed dir')
    assertEqual(pack.enabled, false, 'not enabled')
    assertEqual(pack.updateAvailable, false, 'nothing to update')
    const history = (await readFile(join(stateDir, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const removed = history.filter(entry => entry.op === 'compat.uninstall' && entry.ok === true)
    assert(removed.length > 0, 'history has no successful compat.uninstall row')
    assertEqual(removed[removed.length - 1].audit, true, 'the uninstall is audited')
    assertEqual(await stat(join(profileDir, 'cordis.patch.yml')).then(() => false).catch(() => true), true, 'no patch file was created in the profile')
    const again = await run(runtime, 'compat.uninstall', { id: 'compat-demo', confirm: true })
    assertEqual(again.ok, false, 'a second uninstall must fail')
    assertEqual(again.error.code, 'not-installed', 'second uninstall code')
    return 'backup ' + basename(backup) + ', folder gone, enabled cleared, catalog row reset'
  })

  // 47. uninstall refuses a folder that is not this extension: no manifest, or another id inside it
  await test('compat-uninstall-folder-guards', async () => {
    const stray = join(extRoot, 'stray-folder')
    await mkdir(stray, { recursive: true })
    await writeFile(join(stray, 'notes.txt'), 'not an extension', 'utf8')
    const strayOutcome = await run(runtime, 'compat.uninstall', { id: 'stray-folder', confirm: true })
    assertEqual(strayOutcome.ok, false, 'a folder without a manifest is refused')
    assertEqual(strayOutcome.error.code, 'not-extension', 'stray code')
    includes(strayOutcome.error.message, 'manifest.json', 'the message names the missing manifest')
    assertEqual(await stat(join(stray, 'notes.txt')).then(info => info.isFile(), () => false), true, 'the refused folder was not touched')
    const aliased = join(extRoot, 'aliased')
    await mkdir(aliased, { recursive: true })
    await writeFile(join(aliased, 'manifest.json'), JSON.stringify(manifestOf('compat-alias'), null, 2) + '\n', 'utf8')
    const aliasOutcome = await run(runtime, 'compat.uninstall', { id: 'aliased', confirm: true })
    assertEqual(aliasOutcome.ok, false, 'a folder registered as another id is refused')
    assertEqual(aliasOutcome.error.code, 'not-extension', 'alias code')
    includes(aliasOutcome.error.message, 'compat-alias', 'the message names the registered id')
    assertEqual(await stat(join(aliased, 'manifest.json')).then(info => info.isFile(), () => false), true, 'the refused folder still has its manifest')
    const backups = (await readdir(join(stateDir, 'backups'))).filter(name => name.startsWith('extensions-stray-folder-') || name.startsWith('extensions-aliased-'))
    sameList(backups, [], 'a refused uninstall makes no backup')
    return 'no manifest and foreign manifest both refused, nothing written'
  })

  // 48. the throw-away tree is removed, nothing outside it was touched
  await test('temp-tree-cleaned', async () => {
    await rm(root, { recursive: true, force: true })
    const gone = await stat(root).then(() => false).catch(() => true)
    assertEqual(gone, true, 'temp root removed')
    return 'temp root removed'
  })
}
finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
  await new Promise(resolveClose => {
    server.close(resolveClose)
  })
}

note('fixtures lived under TOOL_HUB_STATE_FILE; the shared home extension root was not used')
console.log('')
console.log('extensions-host probe: ' + passed + ' PASS / ' + failed + ' FAIL')
if (failed !== 0) {
  console.log('failed: ' + failedNames.join(', '))
  process.exitCode = 1
}
