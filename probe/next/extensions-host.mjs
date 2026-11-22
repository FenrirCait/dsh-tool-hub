#!/usr/bin/env node
/**
 * probe/next/extensions-host.mjs - local extensions through the real 2.0 Runtime.
 *
 * The Extensions view is only as good as the loader behind it: one folder per extension, a
 * manifest, an ESM host entry, and a hard rule that an extension may add ops under its own id
 * namespace and nothing else. This probe starts the compiled host (dist/host/index.js), points
 * TOOL_HUB_STATE_FILE at a throw-away state document, fills <state dir>/extensions with fixtures
 * and drives Runtime directly - no HTTP, no panel, no build.
 *
 * What it pins down (the acceptance list for task-25):
 *   1. discovery answers enabled / disabled / broken folders as status rows and never throws;
 *   2. enabling an extension makes its ops callable, disabling takes them away again (bad-op);
 *   3. the enabled list round-trips through state.json and survives a fresh Runtime;
 *   4. extension.reload picks up changed host code with no host restart;
 *   5. one broken extension never takes the host down - extension.list / snapshot keep working;
 *   6. the namespace, reserved-id, view-op and host-path rules reject at load time;
 *   7. a declared settings field appears in the snapshot schema with its default;
 *   8. extension.installBundled copies a compat pack into the profile, the copy wins discovery and
 *      carries overridesBundled, and a second install refuses without touching the existing copy.
 *
 * Exit 1 when any check fails. dist/host/index.js must be current; no third-party libraries.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
// The built host, or a copy when TOOL_HUB_DIST points at one (same override as core-state.mjs).
const distRoot = resolve(process.env.TOOL_HUB_DIST ?? join(repoRoot, 'dist'))

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
  settings: {},
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
// a host path that escapes the folder, and an id that breaks the regex
await writeExtension('core', manifestOf('core'), IDLE_HOST)
await writeExtension('badmanifest', { ...manifestOf('badmanifest'), apiVersion: 2 }, IDLE_HOST)
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
    return row.error
  })

  // 5. the manifest rules: apiVersion, missing manifest, host path escape, bad id
  await test('discover-manifest-rules', async () => {
    const { extensions } = await list(runtime)
    const api = oneRow(extensions, 'badmanifest')
    includes(api.error, 'apiVersion must be 1', 'apiVersion')
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
    for (const key of ['id', 'name', 'version', 'apiVersion', 'dir', 'enabled', 'loaded', 'error', 'ops', 'views', 'bundled', 'overridesBundled']) {
      assert(key in data.extensions[0], 'status row is missing ' + key)
    }
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

  // 30. copying a bundled pack into the profile: the copy wins discovery and is marked as the override
  await test('install-bundled', async () => {
    const bundledPack = oneRow((await list(runtime)).extensions, 'codex-ui-glass')
    assertEqual(bundledPack.bundled, true, 'bundled row before install')
    assertEqual(bundledPack.overridesBundled, false, 'overridesBundled before install')
    const target = join(extRoot, 'codex-ui-glass')
    const outcome = await run(runtime, 'extension.installBundled', { id: 'codex-ui-glass' })
    assert(outcome.ok === true, 'extension.installBundled failed: ' + JSON.stringify(outcome.error))
    assertEqual(outcome.data.id, 'codex-ui-glass', 'installed id')
    assertEqual(outcome.data.dir, target, 'returned dir')
    assertEqual(outcome.data.files, await countFiles(join(repoRoot, 'compat', 'codex-ui-glass')), 'copied file count')
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
    assertEqual(manifest.id, 'codex-ui-glass', 'copied manifest id')
    for (const file of ['host.mjs', 'style.css']) {
      const info = await stat(join(target, file))
      assert(info.isFile(), 'copied file missing: ' + file)
    }
    const rows = (await list(runtime)).extensions
    assertEqual(rowsOf(rows, 'codex-ui-glass').length, 1, 'one row per id after the copy')
    const localRow = oneRow(rows, 'codex-ui-glass')
    assertEqual(localRow.bundled, false, 'the copy is the row that wins')
    assertEqual(localRow.overridesBundled, true, 'the copy is marked as the local override')
    assertEqual(localRow.dir, target, 'the row points at the copy')
    const snapshot = await run(runtime, 'snapshot', { fresh: true })
    assertEqual(oneRow(snapshot.data.extensions, 'codex-ui-glass').overridesBundled, true, 'snapshot carries overridesBundled')
    const history = (await readFile(join(stateDir, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const installed = history.filter(row => row.op === 'extension.installBundled' && row.ok === true)
    assert(installed.length > 0, 'history has no successful extension.installBundled row')
    assertEqual(installed[installed.length - 1].audit, true, 'the install is audited')
    return 'copied ' + outcome.data.files + ' files, local row overrides the pack'
  })

  // 31. a second copy is refused and the existing folder is left exactly as it was
  await test('install-refuses-existing', async () => {
    const target = join(extRoot, 'codex-ui-glass')
    await writeFile(join(target, 'marker.txt'), 'keep me', 'utf8')
    const again = await run(runtime, 'extension.installBundled', { id: 'codex-ui-glass' })
    assertEqual(again.ok, false, 'second install must fail')
    assertEqual(again.error.code, 'already-installed', 'error code')
    includes(again.error.message, 'codex-ui-glass', 'message names the id')
    assertEqual(await readFile(join(target, 'marker.txt'), 'utf8'), 'keep me', 'existing copy untouched')
    sameList((await list(runtime)).enabled, ['broken', 'core', 'dangling', 'foreign', 'hello', 'idle', 'refuse', 'writeview'], 'install does not change the enabled list')
    return 'refused with already-installed, marker intact'
  })

  // 32. the op validates its payload and only copies a pack the package really ships
  await test('install-bad-payloads', async () => {
    const cases = [
      [{}, 'bad-payload', 'no id'],
      [{ id: 'Bad_Id' }, 'bad-payload', 'uppercase id'],
      [{ id: 'no-such-pack' }, 'missing-bundled', 'unknown pack'],
    ]
    for (const [payload, code, label] of cases) {
      const outcome = await run(runtime, 'extension.installBundled', payload)
      assertEqual(outcome.ok, false, label)
      assertEqual(outcome.error.code, code, label + ' code')
    }
    const ghost = await stat(join(extRoot, 'no-such-pack')).then(() => false).catch(() => true)
    assertEqual(ghost, true, 'a refused install writes nothing')
    return 'bad-payload x2, missing-bundled x1, no folder written'
  })

  // 33. the throw-away tree is removed, nothing outside it was touched
  await test('temp-tree-cleaned', async () => {
    await rm(root, { recursive: true, force: true })
    const gone = await stat(root).then(() => false).catch(() => true)
    assertEqual(gone, true, 'temp root removed')
    return 'temp root removed'
  })
}
finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

note('fixtures lived under TOOL_HUB_STATE_FILE; the shared home extension root was not used')
console.log('')
console.log('extensions-host probe: ' + passed + ' PASS / ' + failed + ' FAIL')
if (failed !== 0) {
  console.log('failed: ' + failedNames.join(', '))
  process.exitCode = 1
}
