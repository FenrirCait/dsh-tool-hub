/**
 * Host-half smoke test: runs lib/index.js against a fake cordis context and a
 * fake pluginManager, over a real HTTP listener, so the wire format, the skill
 * file rename, the state file and the toggle paths are all exercised without
 * touching any profile on this machine.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendMcpRow, removeMcpRow, replaceMcpConfig } from '../lib/mcp.js'

const home = join(tmpdir(), `tool-hub-smoke-${Date.now()}`)
process.env.DSH_HOME = home
process.env.TOOL_HUB_LOCK_TIMEOUT_MS = '250'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// ── fixture: skills ────────────────────────────────────────────────────────
const skillsRoot = join(home, 'skills')
await mkdir(join(skillsRoot, 'alpha'), { recursive: true })
await writeFile(join(skillsRoot, 'alpha', 'SKILL.md'), '---\nname: alpha-skill\ndescription: first fixture skill\n---\n\nbody\n')
await mkdir(join(skillsRoot, 'beta'), { recursive: true })
await writeFile(join(skillsRoot, 'beta', 'SKILL.md.disabled'), '---\nname: beta-skill\ndescription: second fixture skill\n---\n\nbody\n')
await mkdir(join(skillsRoot, 'nested', 'gamma'), { recursive: true })
await writeFile(join(skillsRoot, 'nested', 'gamma', 'SKILL.md'), '---\nname: gamma-skill\ndescription: nested fixture skill\n---\n\nbody\n')

// ── fixture: tools of one MCP server, and the other panel's own deny list ──
const mcpTools = ['mcp__fixture__alpha', 'mcp__fixture__beta', 'read_file']
await mkdir(join(home, 'skills', '.system', 'skill-viewer'), { recursive: true })
await writeFile(
  join(home, 'skills', '.system', 'skill-viewer', 'tool-filter.json'),
  `${JSON.stringify({ version: 1, deny: ['mcp__fixture__beta', 'mcp__gone__x'] }, null, 2)}\n`,
)

// ── fixture: profile patch with one MCP server ─────────────────────────────
const profileDir = join(home, 'profile')
await mkdir(profileDir, { recursive: true })
const patchText = [
  '# fixture profile patch',
  '- insert:',
  '    - id: panel-mcp-fixture',
  '      name: "@deepseek-ai/dsh-mcp-client"',
  '      config:',
  '        serverName: fixture',
  '        transport: stdio',
  '        command: C:\\Program Files\\nodejs\\node.exe',
  '        args:',
  '          - C:\\tools\\server.js',
  '        env: {}',
  '        cwd: ""',
  '      disabled: true',
  '- id: agent-preset-registry',
  '  name: "@deepseek-ai/dsh-agent-preset-registry"',
  '  config:',
  '    default: fixture-default',
  '    selectedDefault: fixture-default',
  '- insert:',
  '    - id: preset-fixture-default',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: fixture-default',
  '        name: "Fixture default"',
  '        order: 5',
  '        plugins: []',
  '- id: keep-me',
  '  name: some-other-plugin',
  '',
].join('\n')
await writeFile(join(profileDir, 'cordis.patch.yml'), patchText)

// ── fixture: dshmarket groups (their own file, must stay untouched) ────────
await mkdir(join(profileDir, '.dsh-market'), { recursive: true })
const marketText = `${JSON.stringify({
  groups: {
    'fixture-group': ['@deepseek-ai/dsh-session', 'not-installed-pkg'],
    'taken-group': ['ui-theme'],
  },
  groupOrder: ['fixture-group', 'taken-group'],
}, null, 2)}\n`
await writeFile(join(profileDir, '.dsh-market', 'state.json'), marketText)

// ── fixture: plugin manager ────────────────────────────────────────────────
const enabled = new Set(['@deepseek-ai/dsh-session', 'billion-context', 'ui-theme', 'dsh-skill-mcp-panel'])
const fakePlugins = [
  { entryId: 'e1', moduleName: '@deepseek-ai/dsh-session', meta: { title: 'Session' }, fiberPhase: 'active' },
  { entryId: 'e2', moduleName: 'billion-context', meta: { title: 'Billion Context' }, fiberPhase: 'active' },
  { entryId: 'e3', moduleName: 'ui-theme', meta: { title: 'Theme' }, fiberPhase: 'active' },
  { entryId: 'e4', moduleName: 'dsh-market', meta: { title: '插件市场' }, fiberPhase: 'pending' },
  { entryId: 'e5', moduleName: 'dsh-tool-hub', meta: { title: '工具总控台' }, fiberPhase: 'active' },
  { entryId: 'e6', moduleName: 'plugin-manager', meta: { title: 'Plugin Manager' }, fiberPhase: 'active', readOnlyReason: 'management-required' },
  { entryId: 'e7', moduleName: '@deepseek-ai/dsh-mcp-client', patchId: 'panel-mcp-fixture', fiberPhase: null },
  { entryId: 'e8', moduleName: 'dsh-skill-mcp-panel', meta: { title: 'Skill / MCP' }, fiberPhase: 'active' },
  // A package that ships a second loader entry under a path — one install, two rows, one tree.
  { entryId: 'e9', moduleName: 'fixture-parent', meta: { title: 'Parent' }, fiberPhase: 'active' },
  { entryId: 'e10', moduleName: 'fixture-parent/child', meta: { title: 'Child' }, fiberPhase: 'active' },
]
// A host that fails to list bundles is a `bundleError`, not a failed snapshot.
let fakeBundlesFail = false
// A host whose plugin inventory cannot be read at all: the snapshot then rejects, which is the only
// way a post-write verification can fail for a row that parses (see section 20).
let fakePluginsFail = false
const fakeManager = {
  async listPlugins() {
    if (fakePluginsFail) throw new Error('plugin inventory is not readable right now')
    return fakePlugins.map(row => ({ ...row, enabled: enabled.has(row.moduleName) }))
  },
  async listBundles() {
    if (fakeBundlesFail) throw new Error('bundle inventory exploded')
    return [
      { name: 'fixture-bundle', version: '2.0.0', official: false, enabled: true, installed: true, rows: [{ entryId: 'e1' }, { entryId: 'e2' }] },
      { name: '@deepseek-ai/dsh-base', official: true, enabled: true, installed: false, rows: ['e3'] },
      { name: 'rowless-bundle', official: false, enabled: false, installed: true, rows: [] },
    ]
  },
  async setPluginEnabled(id, value) {
    const row = fakePlugins.find(item => item.entryId === id)
    if (row === undefined) return { changed: false, application: 'failed', error: 'unknown-plugin' }
    if (row.readOnlyReason !== undefined) return { changed: false, application: 'failed', error: row.readOnlyReason }
    if (value) enabled.add(row.moduleName)
    else enabled.delete(row.moduleName)
    return { changed: true, application: 'applied', stage: 'enable', target: id, enabled: value }
  },
}

// ── fake cordis context + real listener ────────────────────────────────────
const routes = new Map()
// A host that lists workspaces through a service rather than the environment.
let fakeWorkspaces = null
let fakeWorkspacesExplode = false
// The two fallbacks behind it, in contract order.
const registeredTools = []
let fakeRegistry = null
let fakeSessions = null
// The host's config editor normally names the patch file; tests move it around on purpose.
let fakeDocumentPath = null
// The host's browser gate (`connection.requestRejection`): 401/403 when set,
// `undefined` means "the host is happy". Missing service must not break routes.
let fakeRejection = undefined
let fakeRejectionThrows = false
const ctx = {
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      }
    }
    if (name === 'pluginManager') return fakeManager
    if (name === 'profileContext') return { dir: profileDir }
    // Three workspace sources the host may or may not expose, each with its own shape:
    // `workspaces.list()` (fixtures below), `workspaceRegistry.list()` and
    // `sessions.listWorkspaces()`. `fakeWorkspacesExplode` makes the first one throw, which the
    // contract treats as "that source knows nothing" rather than a failed snapshot.
    if (name === 'workspaces') {
      if (fakeWorkspaces === null && fakeWorkspacesExplode === false) return undefined
      return {
        list: () => {
          if (fakeWorkspacesExplode) throw new Error('workspace service exploded')
          return fakeWorkspaces
        },
      }
    }
    if (name === 'workspaceRegistry') {
      return fakeRegistry === null ? undefined : { list: () => fakeRegistry }
    }
    if (name === 'sessions') {
      return fakeSessions === null ? undefined : { listWorkspaces: () => fakeSessions }
    }
    if (name === 'configEditor') {
      return fakeDocumentPath === null ? undefined : { documentPath: fakeDocumentPath }
    }
    // The registry reloads the patch through HMR; reading the file back is the closest the fixture
    // can get to that, and it is what makes "created but broken" observable.
    if (name === 'tools') return {
      view: () => ({ knownNames: [...mcpTools, ...registeredTools], restrictableNames: mcpTools }),
      register(definition) { registeredTools.push(definition.name); return () => {} },
    }
    if (name === 'agents') return { list: () => [] }
    if (name === 'connection') return {
      requestRejection() {
        if (fakeRejectionThrows) throw new Error('gate exploded')
        return fakeRejection
      },
    }
    return undefined
  },
  on() {
    return () => {}
  },
  inject(_deps, callback) {
    return callback(ctx)
  },
  effect(fn) {
    return typeof fn === 'function' ? fn() : undefined
  },
  logger: { warn: message => console.log(`  warn: ${message}`) },
}

const mod = await import('../lib/index.js')
mod.apply(ctx)
check('routes registered', routes.has('/tool-hub/api/snapshot') && routes.has('/tool-hub/api/op'), [...routes.keys()].join(', '))

const server = createServer((request, response) => {
  const route = routes.get(request.url.split('?')[0])
  if (route === undefined) {
    response.writeHead(404).end()
    return
  }
  route.handler(request, response)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const get = async (path) => {
  const separator = path.includes("?") ? "&" : "?"
  const response = await fetch(`${base}${path}${separator}fresh=1`, { headers: { host: `127.0.0.1:${port}` } })
  return await response.json()
}
const op = async (name, payload) => {
  const response = await fetch(`${base}/tool-hub/api/op`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}` },
    body: JSON.stringify({ op: name, payload }),
  })
  return await response.json()
}

// ── 1. snapshot ────────────────────────────────────────────────────────────
let snap = await get('/tool-hub/api/snapshot')
check('snapshot ok', snap.ok === true, snap.error?.message ?? '')
check('plugins listed', snap.data.plugins.length === 10, `got ${snap.data.plugins.length}`)
check('mcp row named by server', snap.data.plugins.find(row => row.id === 'e7')?.name === 'fixture', JSON.stringify(snap.data.plugins.find(row => row.id === 'e7')))
check('mcp row editable', snap.data.plugins.find(row => row.id === 'e7')?.mcpEditable === true)
check('mcp patch path exposed', snap.data.paths.patch === join(profileDir, 'cordis.patch.yml'), snap.data.paths.patch)
check('read-only flagged', snap.data.plugins.find(row => row.moduleName === 'plugin-manager').manageable === false)
check('official flagged', snap.data.plugins.find(row => row.id === 'e1')?.official === true, JSON.stringify(snap.data.plugins.find(row => row.id === 'e1')))
check('third-party not official', snap.data.plugins.find(row => row.id === 'e2')?.official === false, JSON.stringify(snap.data.plugins.find(row => row.id === 'e2')))
check('skills never official', snap.data.skills.every(row => row.official === false))
check('skills listed with disabled one', snap.data.skills.length === 3, JSON.stringify(snap.data.skills.map(row => `${row.id}:${row.enabled}`)))
check('nested skill found', snap.data.skills.some(row => row.id === 'user|nested/gamma'))

// ── 2. skill toggle ────────────────────────────────────────────────────────
let r = await op('toggle', { kind: 'skill', id: 'user|beta', enabled: true })
check('skill on', r.ok === true && r.data.ok === true, JSON.stringify(r))
const betaOn = await stat(join(skillsRoot, 'beta', 'SKILL.md')).then(() => true, () => false)
check('skill file renamed on', betaOn)
r = await op('toggle', { kind: 'skill', id: 'user|alpha', enabled: false })
const alphaOff = await stat(join(skillsRoot, 'alpha', 'SKILL.md.disabled')).then(() => true, () => false)
check('skill file renamed off', r.ok === true && alphaOff)

// ── 2b. mcp config edit ───────────────────────────────────────────────────
const patchFile = join(profileDir, 'cordis.patch.yml')
const before = await readFile(patchFile, 'utf8')
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { serverName: 'renamed', args: ['C:\\a b\\index.js', '--flag'], env: { FOO: 'bar' }, unknownKey: 'dropped' } })
check('mcp save accepted', r.ok === true && r.data.ok === true, JSON.stringify(r))
const after = await readFile(patchFile, 'utf8')
check('mcp row rewritten', after.includes('serverName: renamed') && after.includes('--flag') && after.includes('FOO: bar'))
check('mcp unknown key dropped', !after.includes('unknownKey'))
check('mcp disabled flag survives', after.includes('      disabled: true'), after.slice(-260))
check('mcp neighbours untouched', after.includes('- id: keep-me') && after.includes('name: some-other-plugin') && after.startsWith('# fixture profile patch'))
check('mcp other rows untouched', (after.match(/dsh-mcp-client/g) ?? []).length === 1)
check('mcp save refuses unknown id', (await op('mcp.save', { id: 'nope', config: {} })).ok === false)
check('mcp save refuses garbage config', (await op('mcp.save', { id: 'panel-mcp-fixture', config: 5 })).ok === false)
const restored = await readFile(patchFile, 'utf8')
check('mcp refused writes leave file alone', restored === after, 'file changed after a refused write')

// ── 2c. mcp create + delete ───────────────────────────────────────────────
r = await op('mcp.create', { config: { serverName: 'fresh', transport: 'stdio', command: 'C:\\node.exe', args: ['-y', 'pkg'], env: { A: '1' }, toolCallTimeoutMs: 30000 } })
check('mcp create accepted', r.ok === true && r.data.created === true && r.data.id === 'tool-hub-mcp-fresh', JSON.stringify(r))
const created = await readFile(patchFile, 'utf8')
check('mcp create appends an entry', created.includes('- id: tool-hub-mcp-fresh') && created.includes('serverName: fresh') && created.includes('- "-y"') === false)
check('mcp create keeps the old entries', created.includes('- id: panel-mcp-fixture') && created.includes('- id: keep-me'))
check('mcp create starts disabled', /- id: tool-hub-mcp-fresh[\s\S]{0,400}disabled: true/.test(created), created.slice(-420))
check('mcp create refuses a duplicate name', (await op('mcp.create', { config: { serverName: 'renamed' } })).ok === false)
check('mcp create refuses a bad name', (await op('mcp.create', { config: { serverName: 'bad name' } })).ok === false)
const snap2 = await get('/tool-hub/api/snapshot')
check('created server shows up in the snapshot', (await get('/tool-hub/api/snapshot')).data.plugins.some(row => row.mcpPatchId === 'tool-hub-mcp-fresh'), 'missing created row')
r = await op('mcp.delete', { id: 'tool-hub-mcp-fresh' })
check('mcp delete accepted', r.ok === true && r.data.removed === true, JSON.stringify(r))
const deleted = await readFile(patchFile, 'utf8')
check('mcp delete removes only that entry', !deleted.includes('tool-hub-mcp-fresh') && deleted.includes('- id: panel-mcp-fixture') && deleted.includes('- id: keep-me'))
check('mcp delete refuses unknown id', (await op('mcp.delete', { id: 'nope' })).ok === false)
void snap2

// ── 2c2. mcp probe ────────────────────────────────────────────────────────
const fakeServer = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url))
r = await op('mcp.probe', { config: { transport: 'stdio', command: process.execPath, args: [fakeServer], toolCallTimeoutMs: 15000 } })
check('probe reports the tools a server offers', r.ok === true && r.data.count === 2 && r.data.tools.join(',') === 'alpha,beta', JSON.stringify(r))
check('probe reports how long it took', r.ok === true && Number.isFinite(r.data.ms), JSON.stringify(r.data ?? null))
r = await op('mcp.probe', { config: { transport: 'stdio', command: 'definitely-not-a-real-binary-xyz' } })
check('probe surfaces a spawn failure', r.ok === false && r.error.code === 'probe-spawn', JSON.stringify(r))
r = await op('mcp.probe', { config: { transport: 'sse', url: 'http://127.0.0.1:1/sse' } })
check('probe refuses a transport it cannot test', r.ok === false && r.error.code === 'probe-unsupported', JSON.stringify(r))
check('probe refuses an empty payload', (await op('mcp.probe', {})).ok === false)

// ── 2d. per-tool masking ──────────────────────────────────────────────────
let toolSnap = (await get('/tool-hub/api/snapshot')).data
check('tools listed from the live view', toolSnap.toolsKnown === true && toolSnap.tools.filter(row => row.server === 'fixture').length === 2, JSON.stringify(toolSnap.tools))
check('non-mcp names are not offered as server tools', !toolSnap.tools.some(row => row.name === 'read_file'))
check('tools start enabled', toolSnap.tools.every(row => row.enabled === true))
check('other panel list is exposed read-only', Array.isArray(toolSnap.panelDeny) && toolSnap.panelDeny.length === 2, JSON.stringify(toolSnap.panelDeny))
check('other panel entries are flagged per tool', toolSnap.tools.find(row => row.name === 'mcp__fixture__beta')?.panelDenied === true)
r = await op('tool.save', { deny: ['mcp__fixture__alpha', 'not_a_tool'] })
check('tool save drops non-mcp names', r.ok === true && JSON.stringify(r.data.deny) === '["mcp__fixture__alpha"]', JSON.stringify(r))
toolSnap = (await get('/tool-hub/api/snapshot')).data
check('denied tool shows as off', toolSnap.tools.find(row => row.name === 'mcp__fixture__alpha')?.enabled === false)
check('other tool stays on', toolSnap.tools.find(row => row.name === 'mcp__fixture__beta')?.enabled === true)
check('tool save refuses an unknown mcp tool', (await op('tool.save', { deny: ['mcp__fixture__nope'] })).ok === false)
check('tool save refuses a non-array', (await op('tool.save', { deny: 'mcp__fixture__alpha' })).ok === false)
r = await op('tool.import', {})
check('tool import merges the other panel list', r.ok === true && r.data.added === 1 && r.data.read === 1, JSON.stringify(r))
check('imported name is denied now', (await get('/tool-hub/api/snapshot')).data.tools.every(row => row.enabled === false))
const stateAfterTools = JSON.parse(await readFile(join(home, 'tool-hub', 'state.json'), 'utf8'))
check('tool deny persisted in our own state file', JSON.stringify(stateAfterTools.toolDeny) === '["mcp__fixture__alpha","mcp__fixture__beta"]', JSON.stringify(stateAfterTools.toolDeny))
r = await op('tool.save', { deny: [] })
check('clearing the list re-enables everything', r.ok === true && (await get('/tool-hub/api/snapshot')).data.tools.every(row => row.enabled === true))

// ── session overlays ───────────────────────────────────────────────────────
// A session switch is data, not a switchboard change: the installation rows must stay on, and
// the overlay has to survive a reload and stay separate per session.
r = await op('session.set', { sessionId: 'sess-a', names: ['mcp__fixture__alpha', 'not_a_tool'] })
check('session.set keeps only mcp names', r.ok === true && JSON.stringify(r.data.deny) === '["mcp__fixture__alpha"]', JSON.stringify(r))
let sessionSnap = (await get('/tool-hub/api/snapshot')).data
check('snapshot lists the session overlay', JSON.stringify(sessionSnap.sessions?.['sess-a']) === '["mcp__fixture__alpha"]', JSON.stringify(sessionSnap.sessions))
check('the mask reports the session overlay', (sessionSnap.toolMask?.sessions ?? []).some(row => row.sessionId === 'sess-a'), JSON.stringify(sessionSnap.toolMask?.sessions))
check('installation rows stay on while only a session is masked', sessionSnap.tools.every(row => row.enabled === true))
await op('session.set', { sessionId: 'sess-b', names: ['mcp__fixture__beta'] })
sessionSnap = (await get('/tool-hub/api/snapshot')).data
check('two sessions keep separate overlays',
  JSON.stringify(sessionSnap.sessions?.['sess-a']) === '["mcp__fixture__alpha"]' && JSON.stringify(sessionSnap.sessions?.['sess-b']) === '["mcp__fixture__beta"]',
  JSON.stringify(sessionSnap.sessions))
const stateAfterSessions = JSON.parse(await readFile(join(home, 'tool-hub', 'state.json'), 'utf8'))
check('session overlays persist in our own state file', Object.keys(stateAfterSessions.sessions ?? {}).join(',') === 'sess-a,sess-b', JSON.stringify(stateAfterSessions.sessions))
check('session.set refuses a missing sessionId', (await op('session.set', { names: ['mcp__fixture__alpha'] })).ok === false)
r = await op('session.clear', { sessionId: 'sess-a' })
sessionSnap = (await get('/tool-hub/api/snapshot')).data
check('session.clear drops only that session',
  r.ok === true && sessionSnap.sessions?.['sess-a'] === undefined && JSON.stringify(sessionSnap.sessions?.['sess-b']) === '["mcp__fixture__beta"]',
  JSON.stringify(sessionSnap.sessions))
await op('session.clear', { sessionId: 'sess-b' })
check('clearing every overlay leaves the mask empty', ((await get('/tool-hub/api/snapshot')).data.toolMask?.sessions ?? []).length === 0)

// ── scenes ─────────────────────────────────────────────────────────────────
// A scene is a whole environment; the MCP half of it is covered by probe/scene-smoke.mjs, which
// can inject a failing host call. Here the point is the op surface and the snapshot record.
r = await op('scene.save', { name: 'work', tools: { deny: ['mcp__fixture__alpha'] } })
check('scene.save stores a scene', r.ok === true && r.data.scenes.includes('work'), JSON.stringify(r.data ?? r.error))
let sceneSnap = (await get('/tool-hub/api/snapshot')).data
check('snapshot reports the saved scenes', (sceneSnap.scene?.names ?? []).includes('work') && sceneSnap.scene?.mode === null, JSON.stringify(sceneSnap.scene))
r = await op('scene.apply', { name: 'work' })
check('scene.apply plans the tool domain', r.ok === true && JSON.stringify(r.data.plan.tools.deny) === '["mcp__fixture__alpha"]', JSON.stringify(r.data ?? r.error))
sceneSnap = (await get('/tool-hub/api/snapshot')).data
check('the applied scene is recorded as the current mode', sceneSnap.scene?.mode === 'work', JSON.stringify(sceneSnap.scene))
check('the applied deny list is live', sceneSnap.tools.find(row => row.name === 'mcp__fixture__alpha')?.enabled === false)
r = await op('scene.exit')
check('scene.exit restores the snapshot', r.ok === true && r.data.restored === true, JSON.stringify(r.data ?? r.error))
sceneSnap = (await get('/tool-hub/api/snapshot')).data
check('the mode record is cleared after exit', sceneSnap.scene?.mode === null && sceneSnap.tools.every(row => row.enabled === true))
check('exiting twice is a no-op', (await op('scene.exit')).data?.restored === false)
check('applying an unknown scene fails', (await op('scene.apply', { name: 'nope' })).ok === false)
check('a scene without a name is refused', (await op('scene.save', { tools: { deny: [] } })).ok === false)
r = await op('preset.save', { name: 'tool-preset' })
const savedPreset = r.data.presets.find(preset => preset.name === 'tool-preset')
check('preset records the tool dimension', Array.isArray(savedPreset?.enabled?.tool) && savedPreset.enabled.tool.length === 2, JSON.stringify(savedPreset?.enabled?.tool))

// A preset must replay while the servers it mentions are switched off: the live view then
// knows none of their tools, so the recorded deny list is what has to be applied.
await op('tool.save', { deny: ['mcp__fixture__beta'] })
r = await op('preset.save', { name: 'offline-preset' })
check('preset records the deny list too', JSON.stringify(r.data.presets.find(preset => preset.name === 'offline-preset')?.toolDeny) === '["mcp__fixture__beta"]', JSON.stringify(r.data.presets.map(preset => preset.toolDeny)))
await op('tool.save', { deny: [] })
const liveTools = [...mcpTools]
mcpTools.length = 0
r = await op('preset.apply', { name: 'offline-preset', mode: 'exact' })
check('offline preset applies its tools without a second press', r.ok === true && r.data.tools?.denied === 1, JSON.stringify(r.data?.tools))
check('offline preset wrote the recorded deny', JSON.stringify(JSON.parse(await readFile(join(home, 'tool-hub', 'state.json'), 'utf8')).toolDeny) === '["mcp__fixture__beta"]')
mcpTools.push(...liveTools)
await op('tool.save', { deny: [] })

// Presets saved before `toolDeny` existed still work once the tools show up again.
const legacyState = JSON.parse(await readFile(join(home, 'tool-hub', 'state.json'), 'utf8'))
legacyState.presets.push({ name: 'legacy-preset', enabled: { plugin: [], skill: [], tool: ['mcp__fixture__alpha'] }, createdAt: Date.now() })
await writeFile(join(home, 'tool-hub', 'state.json'), JSON.stringify(legacyState, null, 2))
mcpTools.length = 0
r = await op('preset.apply', { name: 'legacy-preset', mode: 'exact' })
check('legacy preset defers while nothing is known', r.ok === true && r.data.tools?.deferred === true, JSON.stringify(r.data?.tools))
mcpTools.push(...liveTools)
await new Promise(done => setTimeout(done, 1900))
check('legacy preset finishes the job after the tools register', JSON.stringify(JSON.parse(await readFile(join(home, 'tool-hub', 'state.json'), 'utf8')).toolDeny) === '["mcp__fixture__beta"]')
await op('tool.save', { deny: [] })

// ── 3. plugin toggle + read-only refusal ───────────────────────────────────
r = await op('toggle', { kind: 'plugin', id: 'e4', enabled: true })
check('plugin on', r.ok === true && r.data.ok === true && r.data.application === 'applied', JSON.stringify(r.data))
r = await op('toggle', { kind: 'plugin', id: 'e6', enabled: true })
check('read-only plugin refuses', r.ok === true && r.data.ok === false, JSON.stringify(r.data))
check('self row flagged', snap.data.plugins.find(row => row.id === 'e5')?.self === true, JSON.stringify(snap.data.plugins.find(row => row.id === 'e5')))
r = await op('toggle', { kind: 'plugin', id: 'e5', enabled: false })
check('self disable refused', r.ok === false && r.error?.code === 'self-protected', JSON.stringify(r))

// ── 4. bulk ────────────────────────────────────────────────────────────────
r = await op('bulk', { items: [{ kind: 'plugin', id: 'e1' }, { kind: 'plugin', id: 'e2' }, { kind: 'skill', id: 'user|nested/gamma' }], enabled: false })
check('bulk disables three', r.ok === true && r.data.changed === 3, JSON.stringify(r.data))

// ── 5. auto grouping ───────────────────────────────────────────────────────
r = await op('auto.preview', {})
const plan = r.data.plan
check('auto preview buckets', plan.length >= 2, plan.map(entry => `${entry.name}:${entry.members.length}`).join(', '))
check('auto preview splits roles', plan.some(entry => entry.role === 'official') && plan.some(entry => entry.role === 'base'), plan.map(entry => `${entry.role}:${entry.name}:${entry.members.length}`).join(', '))
// Tags must be package keywords only. The fixture packages declare none, so an empty list is
// the correct answer — a made-up topic word here would be exactly the bug we removed.
check('auto tags are keywords only', plan.every(entry => Array.isArray(entry.tags) && entry.tags.length === 0), JSON.stringify(plan.map(entry => entry.tags)))
check('rows carry root and alias', (() => {
  const parent = snap.data.plugins.find(row => row.id === 'e9')
  const child = snap.data.plugins.find(row => row.id === 'e10')
  const context = snap.data.plugins.find(row => row.id === 'e2')
  return parent.root === 'fixture-parent' && child.root === 'fixture-parent' && typeof context.alias === 'string'
})(), JSON.stringify(snap.data.plugins.filter(row => row.id === 'e10' || row.id === 'e2').map(row => ({ root: row.root, alias: row.alias }))))
r = await op('auto.apply', {})
check('auto applied', r.ok === true && r.data.groups >= 2, JSON.stringify({ groups: r.data?.groups, members: r.data?.members }))
snap = await get('/tool-hub/api/snapshot')
check('auto groups in snapshot', snap.data.groups.length >= 2 && snap.data.groups.every(group => group.auto === true))

// ── 6. group toggle ────────────────────────────────────────────────────────
const foundation = snap.data.groups.find(group => group.role === 'base')
check('auto groups carry role', snap.data.groups.every(group => group.role === 'official' || group.role === 'mcp' || group.role === 'base' || group.role === 'rest'), snap.data.groups.map(group => `${group.name}:${group.role}`).join(', '))
const reordered = await op('group.reorder', { order: [...snap.data.groups].reverse().map(group => group.id) })
check('reorder persists', reordered.ok === true && reordered.data.order[0] === snap.data.groups[snap.data.groups.length - 1].id, JSON.stringify(reordered.data?.order))
r = await op('group.toggle', { id: foundation.id, enabled: true })
check('group toggled on', r.ok === true && r.data.changed === foundation.members.length, JSON.stringify({ changed: r.data?.changed, want: foundation.members.length }))

// ── 7. presets ─────────────────────────────────────────────────────────────
await op('toggle', { kind: 'plugin', id: 'e2', enabled: true })
r = await op('preset.save', { name: 'smoke' })
check('preset saved', r.ok === true && r.data.presets.some(preset => preset.name === 'smoke' && preset.enabled.plugin.length > 0), JSON.stringify(r.data?.presets?.map(preset => preset.name)))
// flip one plugin off, then apply exact
await op('toggle', { kind: 'plugin', id: 'e2', enabled: false })
r = await op('preset.apply', { name: 'smoke', mode: 'exact' })
check('preset applies exact diff', r.ok === true && r.data.requested >= 1 && r.data.applied >= 1, JSON.stringify({ requested: r.data?.requested, applied: r.data?.applied }))
snap = await get('/tool-hub/api/snapshot')
check('preset restored state', snap.data.plugins.find(row => row.id === 'e2').enabled === true)
r = await op('preset.apply', { name: 'smoke', mode: 'only-enable' })
check('only-enable mode is a no-op here', r.ok === true && r.data.requested === 0, JSON.stringify(r.data?.requested))

// ── 8b. dshmarket import ───────────────────────────────────────────────────
const marketSnap = await op('snapshot', {})
const marketInfo = marketSnap.data.market
check('market groups exposed', marketInfo.available === true && marketInfo.groups.length === 2, JSON.stringify({ available: marketInfo.available, groups: marketInfo.groups?.map(g => g.name) }))
check('market maps packages to rows', marketInfo.groups[0].members === 1 && marketInfo.groups[0].missing.length === 1, JSON.stringify(marketInfo.groups[0]))
r = await op('market.import', {})
check('market import copies groups', r.ok === true && r.data.imported === 2 && r.data.missing === 1, JSON.stringify({ imported: r.data?.imported, missing: r.data?.missing, skipped: r.data?.skipped }))
const marketGroups = (await op('snapshot', {})).data.groups.filter(group => group.auto !== true).map(group => group.name)
check('imported groups visible', marketGroups.includes('fixture-group') && marketGroups.includes('taken-group'), marketGroups.join(','))
check('imported members point at rows', (await op('snapshot', {})).data.groups.some(group => group.name === 'fixture-group' && group.members.some(member => member.id === 'e1')))
r = await op('market.import', {})
check('second import is a no-op', r.ok === true && r.data.imported === 0 && r.data.skipped.length === 2, JSON.stringify(r.data?.skipped))
await op('toggle', { kind: 'plugin', id: 'e8', enabled: true })
check('compat detected', (await op('snapshot', {})).data.compat?.active === true, JSON.stringify((await op('snapshot', {})).data.compat))
const lockFile = join(profileDir, 'cordis.patch.yml.panel.lock')
await writeFile(lockFile, '1\n' + new Date().toISOString() + '\n')
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { serverName: 'blocked' } })
check('compat lock is respected', r.ok === false && r.error.code === 'lock-timeout', JSON.stringify(r.error))
await rm(lockFile, { force: true })
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { serverName: 'after-lock' } })
check('save works once the lock is gone', r.ok === true, JSON.stringify(r.error))
check('no lock file left behind', (await readdir(profileDir)).includes('cordis.patch.yml.panel.lock') === false)
check('market file untouched', (await readFile(join(profileDir, '.dsh-market', 'state.json'), 'utf8')) === marketText)

// ── 8. state file ──────────────────────────────────────────────────────────
const raw = JSON.parse(await readFile(join(home, 'tool-hub', 'state.json'), 'utf8'))
check('state file written', raw.version === 1 && Array.isArray(raw.groups) && Array.isArray(raw.presets))
const leftovers = (await readdir(join(home, 'tool-hub'))).filter(name => name.endsWith('.tmp'))
check('no temp files left', leftovers.length === 0, leftovers.join(','))

// ── 9. origin fence ────────────────────────────────────────────────────────
const evil = await fetch(`${base}/tool-hub/api/op`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', host: 'evil.example', origin: 'http://evil.example' },
  body: JSON.stringify({ op: 'snapshot' }),
})
check('cross-origin refused', evil.status === 403)
const wrongMethod = await fetch(`${base}/tool-hub/api/op`, { method: 'GET', headers: { host: `127.0.0.1:${port}` } })
check('wrong method refused', wrongMethod.status === 405)

// The host gate runs before ours: an unauthenticated browser never reaches `sameOrigin`.
fakeRejection = 401
const gated = await fetch(`${base}/tool-hub/api/snapshot`, { headers: { host: `127.0.0.1:${port}` } })
const gatedBody = await gated.json()
check('host gate answers 401', gated.status === 401 && gatedBody.error?.code === 'unauthorized', `${gated.status} ${JSON.stringify(gatedBody)}`)
fakeRejection = 403
const gatedPost = await fetch(`${base}/tool-hub/api/op`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}` },
  body: JSON.stringify({ op: 'snapshot' }),
})
check('host gate answers 403 on ops too', gatedPost.status === 403, String(gatedPost.status))
fakeRejectionThrows = true
const gateBoom = await fetch(`${base}/tool-hub/api/snapshot`, { headers: { host: `127.0.0.1:${port}` } })
check('a throwing gate fails closed', gateBoom.status === 403, String(gateBoom.status))
fakeRejectionThrows = false
fakeRejection = undefined
check('open gate lets the snapshot through', (await get('/tool-hub/api/snapshot')).ok === true)

// ── 10. bad op ─────────────────────────────────────────────────────────────
r = await op('nope', {})
check('unknown op answers an error', r.ok === false && r.error.code === 'bad-op', JSON.stringify(r.error))

// ── 10. collections and role buckets ──────────────────────────────────────
r = await op('snapshot', {})
check('a default collection always exists', JSON.stringify((r.data.collections ?? []).map(entry => entry.id)) === '["default"]', JSON.stringify(r.data.collections))

r = await op('collection.save', { name: '写作' })
const madeCollection = (r.data.state?.collections ?? []).find(entry => entry.name === '写作')
check('collection created', r.ok === true && madeCollection !== undefined, JSON.stringify(r.data?.state?.collections ?? r.error))
check('collection id is slug safe', /^[a-z0-9][a-z0-9_-]{0,31}$/.test(madeCollection?.id ?? ''), String(madeCollection?.id))

r = await op('collection.save', { id: madeCollection.id, name: '写作与检索' })
check('collection renamed', r.ok === true && (r.data.state?.collections ?? []).some(entry => entry.id === madeCollection.id && entry.name === '写作与检索'), JSON.stringify(r.data?.state?.collections))

r = await op('group.save', { name: '检索组', members: [{ kind: 'plugin', id: 'e1' }], collection: madeCollection.id })
const shelved = (r.data.state?.groups ?? []).find(group => group.name === '检索组')
check('group lands in the chosen drawer', shelved?.collection === madeCollection.id, JSON.stringify(shelved))
check('a hand-made group is not an auto group', shelved?.auto === false)

r = await op('group.save', { name: '空分组', members: [], collection: 'no-such-drawer' })
const emptyGroup = (r.data.state?.groups ?? []).find(group => group.name === '空分组')
check('unknown drawer falls back to default', emptyGroup?.collection === 'default', JSON.stringify(emptyGroup))
check('an empty group is allowed', emptyGroup !== undefined && emptyGroup.members.length === 0)

// Picking one row of a package brings the whole package: a group must never hold half a tree.
r = await op('group.save', { name: '整棵树', members: [{ kind: 'plugin', id: 'e9' }] })
const treeGroup = (r.data.state?.groups ?? []).find(group => group.name === '整棵树')
check('group expands to the whole package', JSON.stringify(treeGroup?.members?.map(member => member.id).sort()) === JSON.stringify(['e10', 'e9']), JSON.stringify(treeGroup?.members))

r = await op('collection.delete', { id: 'default' })
check('default drawer cannot be deleted', r.ok === false && r.error.code === 'default-collection', JSON.stringify(r.error))

r = await op('collection.delete', { id: madeCollection.id })
const afterDelete = (r.data.state?.groups ?? []).find(group => group.name === '检索组')
check('deleting a drawer keeps its groups', afterDelete !== undefined, JSON.stringify(r.data?.state?.groups?.map(group => group.name)))
check('orphans move back to default', afterDelete?.collection === 'default', JSON.stringify(afterDelete))

// auto grouping: four buckets, and MCP servers get their own
r = await op('auto.preview', {})
const autoPlan = Array.isArray(r.data.plan) ? r.data.plan : []
const autoRoles = autoPlan.map(entry => entry.role)
check('auto groups carry roles', autoRoles.every(role => ['official', 'mcp', 'base', 'rest'].includes(role)), JSON.stringify(autoRoles))
check('mcp rows are their own bucket', autoPlan.some(entry => entry.role === 'mcp'), JSON.stringify(autoPlan.map(entry => [entry.name, entry.members.length])))
check('the three kept-on buckets land in the default drawer', autoPlan.filter(entry => entry.role !== 'rest').every(entry => entry.collection === 'default'), JSON.stringify(autoPlan.map(entry => [entry.role, entry.collection])))
check('the downloaded bucket starts outside every drawer', autoPlan.filter(entry => entry.role === 'rest').every(entry => entry.collection === null), JSON.stringify(autoPlan.map(entry => [entry.role, entry.collection])))

// Moving a group between drawers, and out of them.
r = await op('group.save', { name: '搬家组', members: [{ kind: 'plugin', id: 'e2' }], collection: null })
const looseGroup = (r.data.state?.groups ?? []).find(group => group.name === '搬家组')
check('a group can start with no drawer at all', looseGroup?.collection === null, JSON.stringify(looseGroup))
r = await op('group.move', { id: looseGroup.id, collection: 'default' })
const filed = (r.data.state?.groups ?? []).find(group => group.id === looseGroup.id)
check('a group moves into a drawer', filed?.collection === 'default', JSON.stringify(filed))
r = await op('group.move', { id: looseGroup.id, collection: null })
check('a group moves back out', (r.data.state?.groups ?? []).find(group => group.id === looseGroup.id)?.collection === null)
check('moving into a drawer that does not exist is refused', (await op('group.move', { id: looseGroup.id, collection: 'nope' })).ok === false)

// Rows carry the bucket the auto planner would file them under, so the client can filter by role
// without shipping a second copy of the classifier.
const roleSnap = await get('/tool-hub/api/snapshot')
const snapRows = roleSnap.data?.plugins ?? []
check('plugin rows carry a role', snapRows.every(row => ['official', 'mcp', 'base', 'rest'].includes(row.role)), JSON.stringify(snapRows.slice(0, 3).map(row => [row.moduleName, row.role])))
check('skill rows carry a role', (roleSnap.data?.skills ?? []).every(row => row.role === 'rest'), JSON.stringify(roleSnap.data?.skills))

// Two groups holding the same member: "only the ones this group owns" must leave the other alone.
await op('group.save', { name: '共有甲', members: [{ kind: 'plugin', id: 'e2' }, { kind: 'plugin', id: 'e3' }] })
await op('group.save', { name: '共有乙', members: [{ kind: 'plugin', id: 'e2' }] })
const sharedSnap = (await get('/tool-hub/api/snapshot')).data
const sharedGroup = sharedSnap.groups.find(group => group.name === '共有甲')
const elsewhere = new Set()
for (const other of sharedSnap.groups) {
  if (other.id === sharedGroup.id) continue
  for (const member of other.members) elsewhere.add(member.kind + ':' + member.id)
}
r = await op('group.toggle', { id: sharedGroup.id, enabled: false, skipShared: true })
const expectedSkipped = sharedGroup.members.filter(member => elsewhere.has(member.kind + ':' + member.id)).length
check('skipShared counts the members other groups also hold', r.ok === true && r.data.skipped === expectedSkipped, JSON.stringify({ got: r.data.skipped, expectedSkipped }))
check('skipShared leaves those members alone', (await get('/tool-hub/api/snapshot')).data.plugins.find(row => row.id === 'e2')?.enabled === true)
r = await op('group.toggle', { id: sharedGroup.id, enabled: false, skipShared: false })
check('without skipShared the shared members switch too', r.ok === true && r.data.skipped === 0 && (await get('/tool-hub/api/snapshot')).data.plugins.find(row => row.id === 'e2')?.enabled === false)

// Members whose plugin was uninstalled stay behind until someone cleans them.
const stateFile = join(home, 'tool-hub', 'state.json')
const rawState = JSON.parse(await readFile(stateFile, 'utf8'))
const cleanTarget = rawState.groups.find(group => group.name === '共有乙')
cleanTarget.members.push({ kind: 'plugin', id: 'gone-entry' })
await writeFile(stateFile, JSON.stringify(rawState, null, 2))
r = await op('group.clean', { id: cleanTarget.id })
check('cleaning drops members that no longer exist', r.ok === true && r.data.removed === 1, JSON.stringify(r.data))

// Dragging rows onto a group files them there; a sub-package drags its parent in too, and the
// same row dropped twice is not counted twice.
const addTarget = (await get('/tool-hub/api/snapshot')).data.groups.find(group => group.name === '共有乙')
r = await op('group.add', { id: addTarget.id, members: [{ kind: 'plugin', id: 'e10' }, { kind: 'plugin', id: 'e10' }] })
const addedGroup = r.ok === true ? (await get('/tool-hub/api/snapshot')).data.groups.find(group => group.id === addTarget.id) : null
const addedIds = addedGroup === null ? [] : addedGroup.members.map(member => member.id)
check('group.add files the whole package and dedupes', r.ok === true && r.data.added === 2 && addedIds.includes('e9') && addedIds.includes('e10'), JSON.stringify({ added: r.data?.added, addedIds }))

// Surface and keywords come from package.json, so a row can be filtered without guessing.
const everyRow = (await get('/tool-hub/api/snapshot')).data.plugins
check('rows carry a surface field', everyRow.every(row => Object.prototype.hasOwnProperty.call(row, 'surface')), JSON.stringify(everyRow.slice(0, 2).map(row => row.surface)))
check('rows carry keywords', everyRow.every(row => Array.isArray(row.keywords)), JSON.stringify(everyRow.slice(0, 2).map(row => row.keywords)))


// A single member can leave a group without deleting the group.
r = await op('group.remove', { id: addTarget.id, members: [{ kind: 'plugin', id: 'e10' }] })
const afterRemove = r.ok === true ? (await get('/tool-hub/api/snapshot')).data.groups.find(group => group.id === addTarget.id) : null
check('group.remove drops one member and keeps the rest', r.ok === true && r.data.removed === 1 && afterRemove.members.some(member => member.id === 'e9') && !afterRemove.members.some(member => member.id === 'e10'), JSON.stringify({ removed: r.data?.removed }))

// Overwriting a preset is its own verb, so a typo cannot silently replace one.
await op('preset.save', { name: 'probe-update', note: 'first' })
await op('toggle', { kind: 'plugin', id: 'e2', enabled: false })
r = await op('preset.update', { name: 'probe-update' })
const updated = r.ok === true ? (await get('/tool-hub/api/snapshot')).data.presets.find(preset => preset.name === 'probe-update') : null
check('preset.update rewrites the snapshot in place', r.ok === true && r.data.updated === true && updated !== null && updated.enabled.plugin.includes('e2') === false, JSON.stringify({ updated: r.data?.updated }))
const missing = await op('preset.update', { name: 'probe-no-such' })
check('preset.update refuses a name that does not exist', missing.ok === false && missing.error.code === 'no-preset', JSON.stringify(missing.error))

// The third-party sweep: it must see third-party plugins and MCP servers, keep official rows and
// itself, write a rollback point first, and be able to put everything back afterwards.
await op('toggle', { kind: 'plugin', id: 'e2', enabled: true })
await op('toggle', { kind: 'plugin', id: 'e3', enabled: true })
r = await op('thirdparty.status', {})
const targets = r.ok === true ? r.data.targets : []
check('thirdparty.status lists third-party plugins and skips official and self',
    r.ok === true
    && targets.some(row => row.id === 'e2')
    && targets.some(row => row.id === 'e3')
    && !targets.some(row => row.id === 'e1')
    && !targets.some(row => row.id === 'e5')
    && !targets.some(row => row.id === 'e6'),
    JSON.stringify(targets.map(row => row.id)))

const beforeOff = (await get('/tool-hub/api/snapshot')).data.plugins
r = await op('thirdparty.off', {})
const afterOff = (await get('/tool-hub/api/snapshot')).data.plugins
const offOk = r.ok === true && r.data.disabled > 0 && typeof r.data.snapshot === 'string'
check('thirdparty.off disables the sweep and writes a rollback file',
    offOk
    && afterOff.find(row => row.id === 'e2').enabled === false
    && afterOff.find(row => row.id === 'e3').enabled === false
    && afterOff.find(row => row.id === 'e1').enabled === beforeOff.find(row => row.id === 'e1').enabled,
    JSON.stringify({ disabled: r.data?.disabled, snapshot: r.data?.snapshot, e2: afterOff.find(row => row.id === 'e2')?.enabled, e1: afterOff.find(row => row.id === 'e1')?.enabled }))

const listed = await op('thirdparty.status', {})
check('thirdparty.status reports the rollback point', listed.ok === true && listed.data.snapshot !== null && Array.isArray(listed.data.snapshot.plugins), JSON.stringify(listed.data?.snapshot?.file))

r = await op('thirdparty.restore', {})
const afterRestore = (await get('/tool-hub/api/snapshot')).data.plugins
check('thirdparty.restore turns the same rows back on',
    r.ok === true && r.data.restored > 0
    && afterRestore.find(row => row.id === 'e2').enabled === true
    && afterRestore.find(row => row.id === 'e3').enabled === true,
    JSON.stringify({ restored: r.data?.restored }))

r = await op('thirdparty.off', {})
const twice = await op('thirdparty.off', {})
check('a second sweep finds nothing left to turn off', twice.ok === true && twice.data.disabled === 0, JSON.stringify(twice.data))
await op('thirdparty.restore', {})

// ── skill scopes: two global roots plus every workspace's .dsh/skills ──────
const workspaceA = join(home, 'workspace-a')
const workspaceB = join(home, 'workspace-b')
await mkdir(join(workspaceA, '.dsh', 'skills', 'ws-skill'), { recursive: true })
await writeFile(join(workspaceA, '.dsh', 'skills', 'ws-skill', 'SKILL.md'), '---\nname: ws-skill\ndescription: workspace skill\n---\n\nbody\n')
await mkdir(join(workspaceB, '.dsh', 'skills', 'ws-b-skill'), { recursive: true })
await writeFile(join(workspaceB, '.dsh', 'skills', 'ws-b-skill', 'SKILL.md'), '---\nname: ws-b-skill\ndescription: other workspace skill\n---\n\nbody\n')

process.env.TOOL_HUB_WORKSPACES = workspaceA
let scopeSnap = (await get('/tool-hub/api/snapshot')).data
const rootList = scopeSnap.paths.skills
check('snapshot.paths.skills lists each root with its scope',
  Array.isArray(rootList) && rootList[0]?.id === 'user' && rootList[0]?.scope === 'global'
  && rootList.every(entry => typeof entry.dir === 'string' && typeof entry.label === 'string'),
  JSON.stringify(rootList))
check('snapshot.paths.skillRoots stays for older clients',
  Array.isArray(scopeSnap.paths.skillRoots) && scopeSnap.paths.skillRoots.length === rootList.length)
const wsRow = scopeSnap.skills.find(row => row.name === 'ws-skill')
check('a workspace skill is listed', wsRow !== undefined, JSON.stringify(scopeSnap.skills.map(row => row.id)))
check('the workspace row carries scope, workspace and root label',
  wsRow?.scope === 'workspace' && wsRow?.workspace === workspaceA && wsRow?.rootLabel === 'workspace-a',
  JSON.stringify(wsRow))
check('the workspace root id is a stable hash and the row id is root|rel',
  /^ws-[0-9a-f]{8}$/.test(wsRow?.rootId ?? '') && wsRow?.id === `${wsRow.rootId}|ws-skill`,
  String(wsRow?.id))
const userRows = scopeSnap.skills.filter(row => row.rootId === 'user')
check('global rows stay global with no workspace',
  userRows.length === 3 && userRows.every(row => row.scope === 'global' && row.workspace === null && row.rootLabel === '全局 · 用户'),
  JSON.stringify(userRows.map(row => [row.scope, row.workspace, row.rootLabel])))

process.env.TOOL_HUB_WORKSPACES = workspaceB
fakeWorkspaces = [{ dir: workspaceA }]
let orderSnap = (await get('/tool-hub/api/snapshot')).data
check('the env source wins over a host service',
  orderSnap.skills.some(row => row.name === 'ws-b-skill') && !orderSnap.skills.some(row => row.name === 'ws-skill'),
  JSON.stringify(orderSnap.skills.map(row => row.name)))
process.env.TOOL_HUB_WORKSPACES = ''
orderSnap = (await get('/tool-hub/api/snapshot')).data
check('the service source is used when the env is empty',
  orderSnap.skills.some(row => row.name === 'ws-skill'), JSON.stringify(orderSnap.skills.map(row => row.name)))
delete process.env.TOOL_HUB_WORKSPACES
fakeWorkspaces = null

// ── skill.read / delete / restore / trash ─────────────────────────────────
const gammaEnabled = scopeSnap.skills.find(row => row.id === 'user|nested/gamma')?.enabled
r = await op('skill.read', { id: 'user|alpha' })
check('skill.read returns the skill file text',
  r.ok === true && typeof r.data.text === 'string' && r.data.text.includes('alpha-skill') && r.data.bytes > 0 && r.data.truncated === false,
  JSON.stringify({ bytes: r.data?.bytes, truncated: r.data?.truncated }))
check('skill.read of an unknown id is refused', (await op('skill.read', { id: 'user|nope' })).ok === false)
check('skill.read without an id is refused', (await op('skill.read', {})).ok === false)
const bigDir = join(skillsRoot, 'big-skill')
await mkdir(bigDir, { recursive: true })
await writeFile(join(bigDir, 'SKILL.md'), `---\nname: big-skill\n---\n\n${'x'.repeat(210_000)}\n`)
r = await op('skill.read', { id: 'user|big-skill' })
check('skill.read truncates at 200k characters',
  r.ok === true && r.data.truncated === true && r.data.text.length === 200_000 && r.data.bytes > 200_000,
  JSON.stringify({ length: r.data?.text?.length, bytes: r.data?.bytes, truncated: r.data?.truncated }))

r = await op('skill.delete', { id: 'user|nested/gamma' })
const trashed = r.ok === true ? r.data.trashPath : ''
check('skill.delete moves the skill into the trash',
  r.ok === true && r.data.name === 'gamma-skill' && trashed.startsWith(join(home, 'tool-hub', 'trash')),
  JSON.stringify(r.data ?? r.error))
check('the skill folder is gone from its root',
  !(await stat(join(skillsRoot, 'nested', 'gamma')).then(() => true, () => false)))
const trashMeta = JSON.parse(await readFile(join(trashed, 'meta.json'), 'utf8'))
check('trash keeps a meta.json with the original place',
  trashMeta.rootId === 'user' && trashMeta.rel === 'nested/gamma' && trashMeta.name === 'gamma-skill',
  JSON.stringify(trashMeta))
check('the whole bundle moved, the skill file included',
  await stat(join(trashed, 'SKILL.md.disabled')).then(() => true, () => false)
  || await stat(join(trashed, 'SKILL.md')).then(() => true, () => false))
check('the snapshot no longer lists the deleted skill',
  !(await get('/tool-hub/api/snapshot')).data.skills.some(row => row.id === 'user|nested/gamma'))
let trashList = await op('skill.trash', {})
check('skill.trash lists the deleted item',
  trashList.ok === true && trashList.data.items.length === 1 && trashList.data.items[0].trashPath === trashed,
  JSON.stringify(trashList.data))
const firstTrash = trashList.data.items[0] ?? {}
check('the trash item carries name, time, root and rel',
  firstTrash.name === 'gamma-skill' && typeof firstTrash.at === 'string'
  && firstTrash.rootId === 'user' && firstTrash.rel === 'nested/gamma',
  JSON.stringify(firstTrash))
check('restore refuses a path outside the trash folder',
  (await op('skill.restore', { trashPath: join(skillsRoot, 'alpha') })).error?.code === 'bad-trash')
check('restore refuses an empty path', (await op('skill.restore', {})).error?.code === 'bad-trash')

const deadItem = join(home, 'tool-hub', 'trash', '1-dead-root')
await mkdir(deadItem, { recursive: true })
await writeFile(join(deadItem, 'meta.json'), JSON.stringify({ rootId: 'ws-00000000', rel: 'gone', name: 'gone', at: new Date().toISOString(), kind: 'dir' }))
check('restore of a vanished root says root-missing',
  (await op('skill.restore', { trashPath: deadItem })).error?.code === 'root-missing')
r = await op('skill.restore', { trashPath: trashed })
check('skill.restore puts the skill back',
  r.ok === true && r.data.restored === 'user|nested/gamma', JSON.stringify(r.data ?? r.error))
const gammaBack = (await get('/tool-hub/api/snapshot')).data.skills.find(row => row.id === 'user|nested/gamma')
check('the restored skill keeps its enabled state',
  gammaBack !== undefined && gammaBack.enabled === gammaEnabled,
  JSON.stringify({ enabled: gammaBack?.enabled, was: gammaEnabled }))
check('meta.json does not travel back into the skill tree',
  !(await stat(join(skillsRoot, 'nested', 'gamma', 'meta.json')).then(() => true, () => false)))
trashList = await op('skill.trash', {})
check('a restored item leaves the trash list',
  trashList.data.items.length === 1 && trashList.data.items[0].trashPath === deadItem,
  JSON.stringify(trashList.data.items))
await rm(deadItem, { recursive: true, force: true })

// ── MCP secrets: masked in the snapshot, kept when saved empty ────────────
let secretSnap = (await get('/tool-hub/api/snapshot')).data
let mcpRow = secretSnap.plugins.find(row => row.mcpPatchId === 'panel-mcp-fixture')
check('the snapshot masks env values and lists their keys',
  mcpRow?.config?.env?.FOO === '' && Array.isArray(mcpRow?.secretKeys?.env) && mcpRow.secretKeys.env.includes('FOO'),
  JSON.stringify({ env: mcpRow?.config?.env, secretKeys: mcpRow?.secretKeys }))
check('the snapshot still keeps the key names',
  Object.prototype.hasOwnProperty.call(mcpRow?.config?.env ?? {}, 'FOO'))

const beforeKeep = await readFile(patchFile, 'utf8')
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { env: { FOO: '' } } })
let patchNow = await readFile(patchFile, 'utf8')
check('an empty value keeps the stored secret', r.ok === true && patchNow.includes('FOO: bar'), patchNow.slice(0, 400))
const backupDir = join(home, 'backups')
const backupFiles = (await readdir(backupDir).catch(() => [])).filter(name => name.endsWith('.bak')).sort()
check('a patch write lands the previous file under backups/',
  backupFiles.length > 0
  && (await readFile(join(backupDir, backupFiles[backupFiles.length - 1]), 'utf8')) === beforeKeep,
  JSON.stringify(backupFiles.slice(-3)))
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { env: { FOO: '', NOPE: '' } } })
check('an empty value for a brand-new key is refused', r.ok === false && r.error.code === 'bad-secret', JSON.stringify(r.error))
check('a refused secret write leaves the file alone', (await readFile(patchFile, 'utf8')) === patchNow)

r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { env: { TOKEN: '${MY_TOKEN}' } } })
patchNow = await readFile(patchFile, 'utf8')
check('a ${NAME} value becomes an unquoted !!js expression',
  r.ok === true && /^\s*TOKEN: !!js process\.env\.MY_TOKEN$/m.test(patchNow),
  patchNow.match(/^\s*TOKEN.*$/m)?.[0] ?? '')
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { env: { OPEN: '!!js process.env.OPENAI_KEY' } } })
patchNow = await readFile(patchFile, 'utf8')
check('an existing !!js value passes through unquoted',
  /^\s*OPEN: !!js process\.env\.OPENAI_KEY$/m.test(patchNow),
  patchNow.match(/^\s*OPEN.*$/m)?.[0] ?? '')
const { parseMcpRows } = await import('../lib/mcp.js')
const backRow = parseMcpRows(patchNow).find(row => row.id === 'panel-mcp-fixture')
check('the template reads back as an !!js string',
  typeof backRow?.config?.env?.TOKEN === 'string' && backRow.config.env.TOKEN.startsWith('!!js process.env.MY_TOKEN'),
  JSON.stringify(backRow?.config?.env))

r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { headers: { Authorization: 'Bearer abc123' } } })
secretSnap = (await get('/tool-hub/api/snapshot')).data
mcpRow = secretSnap.plugins.find(row => row.mcpPatchId === 'panel-mcp-fixture')
check('headers are masked too',
  mcpRow?.config?.headers?.Authorization === '' && mcpRow.secretKeys.headers.includes('Authorization'),
  JSON.stringify({ headers: mcpRow?.config?.headers, secretKeys: mcpRow?.secretKeys }))
check('template values count as set secrets',
  mcpRow.secretKeys.env.includes('TOKEN') && mcpRow.secretKeys.env.includes('OPEN'),
  JSON.stringify(mcpRow.secretKeys.env))
check('mcp.create refuses an empty new credential',
  (await op('mcp.create', { config: { serverName: 'secretless', transport: 'stdio', command: 'x', env: { KEY: '' } } })).error?.code === 'bad-secret')

// ── MCP raw row editing ───────────────────────────────────────────────────
r = await op('mcp.raw', { id: 'panel-mcp-fixture' })
const rawText = r.ok === true ? r.data.text : ''
check('mcp.raw returns the row as written, indent included',
  r.ok === true && rawText.trimStart().startsWith('- id: panel-mcp-fixture') && rawText.includes('serverName:'),
  JSON.stringify(rawText.slice(0, 80)))
check('the raw row parses back as exactly that one row',
  parseMcpRows(rawText).length === 1 && parseMcpRows(rawText)[0].id === 'panel-mcp-fixture',
  JSON.stringify(parseMcpRows(rawText).map(row => row.id)))
check('mcp.raw refuses an unknown row', (await op('mcp.raw', { id: 'nope' })).ok === false)

const rawEdited = rawText.replace(/serverName:[^\n]*/, 'serverName: raw-edit')
r = await op('mcp.rawSave', { id: 'panel-mcp-fixture', text: rawEdited })
check('rawSave writes the edited row', r.ok === true && r.data.saved === true, JSON.stringify(r.data ?? r.error))
const afterRaw = await readFile(patchFile, 'utf8')
check('rawSave changed only what was edited',
  afterRaw.includes('serverName: raw-edit') && afterRaw.includes('- id: keep-me') && afterRaw.includes('TOKEN: !!js'),
  afterRaw.slice(0, 400))
check('rawSave keeps a backup of the previous file',
  typeof r.data.backup === 'string' && await stat(r.data.backup).then(() => true, () => false),
  String(r.data?.backup))
check('the host picked the edited row up',
  (await get('/tool-hub/api/snapshot')).data.plugins.find(row => row.mcpPatchId === 'panel-mcp-fixture')?.name === 'raw-edit')

const beforeBadRaw = await readFile(patchFile, 'utf8')
check('rawSave refuses a changed row id',
  (await op('mcp.rawSave', { id: 'panel-mcp-fixture', text: rawEdited.replace('- id: panel-mcp-fixture', '- id: other-row') })).error?.code === 'raw-id')
check('rawSave refuses a different indent',
  (await op('mcp.rawSave', { id: 'panel-mcp-fixture', text: rawEdited.split('\n').map(line => `  ${line}`).join('\n') })).error?.code === 'raw-indent')
check('rawSave refuses more than one row',
  (await op('mcp.rawSave', { id: 'panel-mcp-fixture', text: `${rawEdited}\n- id: second-row\n  name: "@deepseek-ai/dsh-mcp-client"\n  config:\n    serverName: second\n` })).error?.code === 'raw-invalid')
check('rawSave refuses text that is not an MCP row',
  (await op('mcp.rawSave', { id: 'panel-mcp-fixture', text: 'serverName: nope\n' })).error?.code === 'raw-invalid')
check('rawSave refuses an unknown row id',
  (await op('mcp.rawSave', { id: 'nope', text: rawEdited })).error?.code === 'unknown-mcp')
check('refused raw saves do not touch the file', (await readFile(patchFile, 'utf8')) === beforeBadRaw)

// The id may be left out when the server name already picks exactly one row.
r = await op('mcp.rawSave', { name: 'raw-edit', text: rawEdited })
check('rawSave finds the row by server name when the id is omitted',
  r.ok === true && r.data.saved === true && r.data.id === 'panel-mcp-fixture', JSON.stringify(r.data ?? r.error))
check('rawSave without an id refuses a name that matches nothing',
  (await op('mcp.rawSave', { name: 'no-such-server', text: rawEdited })).error?.code === 'unknown-mcp')

// A skill that is a single .md file, not a folder, goes through the same trash flow.
const soloFile = join(skillsRoot, 'solo.md')
await writeFile(soloFile, '---\nname: solo-skill\ndescription: single-file skill\n---\n\nbody\n')
r = await op('skill.delete', { id: 'user|solo.md' })
const soloTrash = r.ok === true ? r.data.trashPath : ''
check('skill.delete wraps a single-file skill',
  r.ok === true && r.data.name === 'solo-skill'
  && await stat(join(soloTrash, 'solo.md')).then(() => true, () => false),
  JSON.stringify(r.data ?? r.error))
check('the single-file skill leaves its root',
  !(await stat(soloFile).then(() => true, () => false)))
r = await op('skill.restore', { trashPath: soloTrash })
check('restore puts the single file back where it was',
  r.ok === true && r.data.restored === 'user|solo.md' && await stat(soloFile).then(() => true, () => false),
  JSON.stringify(r.data ?? r.error))
check('the trash is empty again',
  (await op('skill.trash', {})).data.items.length === 0)

// ── 12. bundle inventory (P2) ──────────────────────────────────────────────
snap = await get('/tool-hub/api/snapshot')
const bundleRows = Array.isArray(snap.data.bundles) ? snap.data.bundles : []
check('snapshot lists bundles and no bundle error', bundleRows.length === 3 && snap.data.bundleError === null, `${bundleRows.length} / ${String(snap.data.bundleError)}`)
check('a bundle row carries name, version, flags and its entry ids',
  bundleRows[0].name === 'fixture-bundle' && bundleRows[0].version === '2.0.0'
  && bundleRows[0].enabled === true && bundleRows[0].official === false
  && bundleRows[0].rows.join(',') === 'e1,e2',
  JSON.stringify(bundleRows[0]))
check('a bundle without a version omits the key', bundleRows[1].version === undefined && bundleRows[1].official === true, JSON.stringify(bundleRows[1]))
check('bundle rows accept plain entry id strings', bundleRows[1].rows.join(',') === 'e3', JSON.stringify(bundleRows[1].rows))
fakeBundlesFail = true
snap = await get('/tool-hub/api/snapshot')
check('a failing bundle inventory is a bundleError, not a failed snapshot',
  snap.ok === true && snap.data.bundles.length === 0 && /exploded/.test(String(snap.data.bundleError)),
  String(snap.data.bundleError))
fakeBundlesFail = false

// ── 13. doctor ─────────────────────────────────────────────────────────────
const DOCTOR_IDS = ['patch-parse', 'state-writable', 'failed-rows', 'stale-lock', 'skill-roots', 'trash', 'hub-tools', 'mount-heartbeat', 'snapshot-profile']
r = await op('doctor', {})
let doctor = new Map((r.data?.checks ?? []).map(row => [row.id, row]))
check('doctor returns exactly the nine contracted checks',
  r.ok === true && doctor.size === 9 && DOCTOR_IDS.every(id => doctor.has(id)),
  JSON.stringify((r.data?.checks ?? []).map(row => row.id)))
check('doctor patch-parse passes on a readable patch', doctor.get('patch-parse')?.ok === true, doctor.get('patch-parse')?.detail)
check('doctor state-writable passes', doctor.get('state-writable')?.ok === true, doctor.get('state-writable')?.detail)
check('doctor failed-rows passes on a healthy host', doctor.get('failed-rows')?.ok === true, doctor.get('failed-rows')?.detail)
check('doctor stale-lock passes with no lock file', doctor.get('stale-lock')?.ok === true, doctor.get('stale-lock')?.detail)
check('doctor skill-roots passes', doctor.get('skill-roots')?.ok === true, doctor.get('skill-roots')?.detail)
check('doctor trash passes', doctor.get('trash')?.ok === true, doctor.get('trash')?.detail)

// The heartbeat is the only check that can tell "mounted" from "vanished without a log line".
const heartbeatFile = join(home, 'tool-hub', 'mount.json')
const heartbeat = JSON.parse(await readFile(heartbeatFile, 'utf8'))
check('apply() stamped a mount heartbeat',
  heartbeat.pid === process.pid && Array.isArray(heartbeat.injects) && heartbeat.injects.includes('webServer'),
  `pid=${heartbeat.pid} injects=${(heartbeat.injects ?? []).join(',')}`)
check('doctor mount-heartbeat passes right after apply', doctor.get('mount-heartbeat')?.ok === true, doctor.get('mount-heartbeat')?.detail)

// A heartbeat from another process is exactly the silent-failure case: same file, wrong owner.
await writeFile(heartbeatFile, JSON.stringify({ ...heartbeat, pid: heartbeat.pid + 1 }, null, 2))
r = await op('doctor', {})
doctor = new Map((r.data?.checks ?? []).map(row => [row.id, row]))
check('doctor names a heartbeat owned by another pid',
  doctor.get('mount-heartbeat')?.ok === false && /belongs to pid/.test(String(doctor.get('mount-heartbeat')?.detail)),
  doctor.get('mount-heartbeat')?.detail)
await writeFile(heartbeatFile, JSON.stringify(heartbeat, null, 2))

// The failing branches: a row the host itself reports as failed, and a lock left behind.
fakePlugins.push({ entryId: 'e-broken', moduleName: 'broken-plugin', meta: {}, fiberPhase: 'failed' })
const staleLockFile = `${patchFile}.panel.lock`
await writeFile(staleLockFile, 'stale\n')
const stale = new Date(Date.now() - 10 * 60 * 1000)
await utimes(staleLockFile, stale, stale)
r = await op('doctor', {})
doctor = new Map((r.data?.checks ?? []).map(row => [row.id, row]))
check('doctor names the failed rows by module',
  doctor.get('failed-rows')?.ok === false && /broken-plugin/.test(String(doctor.get('failed-rows')?.detail)),
  doctor.get('failed-rows')?.detail)
check('doctor reports a stale panel lock',
  doctor.get('stale-lock')?.ok === false && /stale/.test(String(doctor.get('stale-lock')?.detail)),
  doctor.get('stale-lock')?.detail)
fakePlugins.pop()
await rm(staleLockFile, { force: true })
r = await op('doctor', {})
check('doctor is green again once the lock and the failed row are gone',
  r.ok === true && (r.data?.checks ?? []).every(row => row.ok === true),
  JSON.stringify((r.data?.checks ?? []).filter(row => row.ok !== true)))

// ── 14. history ────────────────────────────────────────────────────────────
const historyPath = join(home, 'tool-hub', 'history.jsonl')
const historyLines = (await readFile(historyPath, 'utf8')).trim().split('\n').filter(line => line !== '')
check('history.jsonl has one line per dispatched op', historyLines.length >= 20, `${historyLines.length} lines`)
snap = await get('/tool-hub/api/snapshot')
const history = snap.data.history
check('snapshot history starts with the newest op', history[0]?.op === 'doctor' && history[0]?.ok === true, JSON.stringify(history[0]))
check('history records failures as well as successes',
  history.some(row => row.ok === false) && history.some(row => row.ok === true),
  JSON.stringify(history.slice(0, 3)))
check('history entries carry at / op / detail / ok',
  history.every(row => typeof row.at === 'string' && typeof row.op === 'string' && typeof row.detail === 'string' && typeof row.ok === 'boolean'))
// The flag comes straight from the op registry, so a reader can filter to the calls worth
// tracing without hard-coding a list of ops in the UI.
check('history stamps the registry audit flag on switches',
  history.some(row => row.op === 'toggle') && history.filter(row => row.op === 'toggle' || row.op === 'group.save').every(row => row.audit === true),
  JSON.stringify(history.filter(row => row.op === 'toggle').slice(0, 1)))
check('history marks reads as not audited',
  history.some(row => row.op === 'doctor') && history.filter(row => row.op === 'doctor' || row.op === 'snapshot').every(row => row.audit === false),
  JSON.stringify(history.filter(row => row.op === 'doctor').slice(0, 1)))
check('history keeps ids but never the payload',
  history.filter(row => row.op === 'mcp.save').every(row => row.detail.includes('id=') && !row.detail.includes('serverName')),
  history.find(row => row.op === 'mcp.save')?.detail)
check('history never stores a token', !(await readFile(historyPath, 'utf8')).includes('tok-smoke-123'))

// >2MB: the next append rewrites the file down to its tail instead of growing forever.
const fill = []
for (let index = 0; index < 20000; index += 1) {
  fill.push(JSON.stringify({ at: new Date().toISOString(), op: 'history.fill', detail: `n=${index} ${'x'.repeat(60)}`, ok: true }))
}
await writeFile(historyPath, `${fill.join('\n')}\n`)
const beforeTruncate = (await stat(historyPath)).size
await op('doctor', {})
const afterTruncate = (await stat(historyPath)).size
check('history over 2MB is truncated on the next append',
  beforeTruncate > 2 * 1024 * 1024 && afterTruncate < 1024 * 1024,
  `${beforeTruncate} -> ${afterTruncate}`)
const keptLines = (await readFile(historyPath, 'utf8')).trim().split('\n').filter(line => line !== '')
check('truncation keeps the newest lines', keptLines.length <= 501 && keptLines[keptLines.length - 1].includes('"op":"doctor"'), `${keptLines.length} lines`)

// ── 15. skill packs: import and move ───────────────────────────────────────
const wsPath = join(home, 'ws-one')
fakeWorkspaces = [{ path: wsPath }]
snap = await get('/tool-hub/api/snapshot')
const wsRoot = snap.data.paths.skills.find(row => row.scope === 'workspace')
check('a workspace skill root is published with a hashed id',
  wsRoot !== undefined && /^ws-[0-9a-f]{8}$/.test(wsRoot.id) && wsRoot.workspace === wsPath,
  JSON.stringify(wsRoot))

const incoming = join(home, 'incoming', 'delta')
await mkdir(incoming, { recursive: true })
await writeFile(join(incoming, 'SKILL.md'), '---\nname: delta-skill\ndescription: imported skill\n---\n\nbody\n')
r = await op('skill.import', { path: incoming, targetId: 'user' })
check('skill.import installs into the chosen root',
  r.ok === true && r.data.root === 'user' && r.data.added.join(',') === 'delta-skill' && r.data.skipped.length === 0,
  JSON.stringify(r.data ?? r.error))
check('skill.import writes SKILL.md on disk', await stat(join(skillsRoot, 'delta-skill', 'SKILL.md')).then(() => true, () => false))
check('the imported skill is listed as a global skill',
  (await get('/tool-hub/api/snapshot')).data.skills.some(row => row.id === 'user|delta-skill' && row.scope === 'global'))
r = await op('skill.import', { path: incoming, targetId: 'user' })
check('re-import without overwrite is skipped as exists',
  r.ok === true && r.data.added.length === 0 && r.data.skipped[0]?.reason === 'exists',
  JSON.stringify(r.data ?? r.error))
r = await op('skill.import', { path: incoming, targetId: 'user', overwrite: true })
check('re-import with overwrite replaces it', r.ok === true && r.data.added.join(',') === 'delta-skill', JSON.stringify(r.data ?? r.error))
check('skill.import refuses an unknown root', (await op('skill.import', { path: incoming, targetId: 'nope' })).error?.code === 'unknown-root')
check('skill.import keeps the pack code for a missing path',
  (await op('skill.import', { path: join(home, 'incoming', 'ghost'), targetId: 'user' })).error?.code === 'not-found')
await mkdir(join(home, 'incoming', 'empty'), { recursive: true })
check('skill.import refuses a source with no skill',
  (await op('skill.import', { path: join(home, 'incoming', 'empty'), targetId: 'user' })).error?.code === 'empty-source')
r = await op('skill.import', { path: incoming, targetId: wsRoot.id })
check('skill.import can target a workspace root',
  r.ok === true && r.data.root === wsRoot.id
  && await stat(join(wsPath, '.dsh', 'skills', 'delta-skill', 'SKILL.md')).then(() => true, () => false),
  JSON.stringify(r.data ?? r.error))

r = await op('skill.move', { id: 'user|beta', targetId: wsRoot.id })
check('skill.move moves the folder into the target root',
  r.ok === true && r.data.root === wsRoot.id && r.data.to === join(wsPath, '.dsh', 'skills', 'beta')
  && (await readdir(join(wsPath, '.dsh', 'skills', 'beta')).catch(() => [])).some(name => name.startsWith('SKILL.md')),
  JSON.stringify(r.data ?? r.error))
snap = await get('/tool-hub/api/snapshot')
check('the moved skill leaves the old root and joins the new one',
  !snap.data.skills.some(row => row.id === 'user|beta')
  && snap.data.skills.some(row => row.id === `${wsRoot.id}|beta` && row.scope === 'workspace'),
  JSON.stringify(snap.data.skills.map(row => row.id)))
check('skill.move refuses the root the skill is already in',
  (await op('skill.move', { id: 'user|alpha', targetId: 'user' })).error?.code === 'exists')
check('skill.move refuses an unknown root',
  (await op('skill.move', { id: 'user|alpha', targetId: 'nope' })).error?.code === 'unknown-root')
check('skill.move refuses an unknown skill',
  (await op('skill.move', { id: 'user|ghost', targetId: wsRoot.id })).error?.code === 'unknown-skill')
await mkdir(join(skillsRoot, 'beta'), { recursive: true })
await writeFile(join(skillsRoot, 'beta', 'SKILL.md'), '---\nname: blocker\n---\n\nblocker\n')
check('skill.move refuses a destination that already exists',
  (await op('skill.move', { id: `${wsRoot.id}|beta`, targetId: 'user' })).error?.code === 'exists')
await rm(join(skillsRoot, 'beta'), { recursive: true, force: true })
r = await op('skill.move', { id: `${wsRoot.id}|beta`, targetId: 'user' })
check('skill.move can move it back',
  r.ok === true && r.data.root === 'user'
  && (await readdir(join(skillsRoot, 'beta')).catch(() => [])).some(name => name.startsWith('SKILL.md')),
  JSON.stringify(r.data ?? r.error))
r = await op('skill.move', { id: 'user|solo.md', targetId: wsRoot.id })
check('skill.move handles a single-file skill',
  r.ok === true && await stat(join(wsPath, '.dsh', 'skills', 'solo.md')).then(() => true, () => false),
  JSON.stringify(r.data ?? r.error))
r = await op('skill.move', { id: `${wsRoot.id}|solo.md`, targetId: 'user' })
check('the single-file skill moves back',
  r.ok === true && await stat(join(skillsRoot, 'solo.md')).then(() => true, () => false),
  JSON.stringify(r.data ?? r.error))

// ── 16. OAuth for an MCP server (out-of-band code paste) ───────────────────
const authHits = { register: null, token: null }
let authBase = ''
const authServer = createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('utf8')
  if (request.url.startsWith('/.well-known/oauth-protected-resource')) {
    return send(200, { issuer: authBase, resource: `${authBase}/mcp`, authorization_servers: [authBase], scopes_supported: ['mcp'] })
  }
  if (request.url.startsWith('/.well-known/oauth-authorization-server')) {
    return send(200, {
      issuer: authBase,
      authorization_endpoint: `${authBase}/authorize`,
      token_endpoint: `${authBase}/token`,
      registration_endpoint: `${authBase}/register`,
      scopes_supported: ['mcp'],
    })
  }
  if (request.url === '/register') {
    authHits.register = JSON.parse(body === '' ? '{}' : body)
    return send(201, { client_id: 'smoke-client' })
  }
  if (request.url === '/token') {
    authHits.token = Object.fromEntries(new URLSearchParams(body))
    return send(200, { access_token: 'tok-smoke-123', token_type: 'Bearer', expires_in: 3600 })
  }
  return send(404, { error: 'not_found' })
})
await new Promise(done => authServer.listen(0, '127.0.0.1', done))
authBase = `http://127.0.0.1:${authServer.address().port}`

r = await op('mcp.create', { config: { serverName: 'oauth-fixture', transport: 'http', url: `${authBase}/mcp` } })
check('mcp.create makes an http server row', r.ok === true && r.data.id === 'tool-hub-mcp-oauth-fixture', JSON.stringify(r.data ?? r.error))
check('oauthStart refuses a server without an http url',
  (await op('mcp.oauthStart', { id: 'panel-mcp-fixture' })).error?.code === 'not-http')
check('oauthStart refuses an unknown row', (await op('mcp.oauthStart', { id: 'nope' })).error?.code === 'unknown-mcp')
r = await op('mcp.oauthStart', { id: 'tool-hub-mcp-oauth-fixture' })
const started = r.ok === true ? r.data : {}
check('oauthStart returns an authorize url, a state and the fixed redirect',
  r.ok === true && /^https?:/.test(String(started.authorizeUrl)) && /^[0-9a-f]{32}$/.test(String(started.state))
  && started.redirectUri === 'http://localhost/oauth/callback',
  JSON.stringify(started))
const authorize = new URL(String(started.authorizeUrl ?? 'http://invalid/'))
check('the authorize url carries PKCE, state, client and resource',
  authorize.searchParams.get('response_type') === 'code'
  && authorize.searchParams.get('code_challenge_method') === 'S256'
  && (authorize.searchParams.get('code_challenge') ?? '').length >= 43
  && authorize.searchParams.get('client_id') === 'smoke-client'
  && authorize.searchParams.get('redirect_uri') === 'http://localhost/oauth/callback'
  && authorize.searchParams.get('state') === started.state
  && authorize.searchParams.get('resource') === `${authBase}/mcp`,
  authorize.search)
check('registration used the fixed redirect', authHits.register?.redirect_uris?.[0] === 'http://localhost/oauth/callback', JSON.stringify(authHits.register))
check('oauthFinish refuses an unknown state', (await op('mcp.oauthFinish', { state: 'deadbeef', code: 'x' })).error?.code === 'bad-state')
check('oauthCancel is idempotent', (await op('mcp.oauthCancel', { state: 'deadbeef' })).data?.cancelled === true)
r = await op('mcp.oauthFinish', { state: started.state, code: 'smoke-code' })
check('oauthFinish writes the token and answers with the id only',
  r.ok === true && r.data.id === 'tool-hub-mcp-oauth-fixture' && r.data.saved === true && !JSON.stringify(r).includes('tok-smoke-123'),
  JSON.stringify(r.data ?? r.error))
const oauthPatch = await readFile(patchFile, 'utf8')
check('the token landed in the row Authorization header',
  /Authorization:\s*'?Bearer tok-smoke-123'?/.test(oauthPatch),
  oauthPatch.split('\n').filter(line => line.includes('Authorization')).join(' | '))
const oauthRow = (await get('/tool-hub/api/snapshot')).data.plugins.find(row => row.mcpPatchId === 'tool-hub-mcp-oauth-fixture')
check('the snapshot masks the new Authorization header',
  oauthRow?.config?.headers?.Authorization === '' && (oauthRow.secretKeys?.headers ?? []).includes('Authorization'),
  JSON.stringify(oauthRow?.config))
check('the exchange carried the PKCE verifier, the code and the resource',
  (authHits.token?.code_verifier ?? '').length >= 43
  && authHits.token?.code === 'smoke-code'
  && authHits.token?.resource === `${authBase}/mcp`,
  JSON.stringify(authHits.token))
check('a used state cannot be replayed',
  (await op('mcp.oauthFinish', { state: started.state, code: 'smoke-code' })).error?.code === 'bad-state')

// ── 17. config export / import ─────────────────────────────────────────────
r = await op('config.export', {})
const exportedJson = r.ok === true ? r.data.json : '{}'
const exported = r.ok === true ? JSON.parse(exportedJson) : {}
check('config.export returns parseable json', r.ok === true && exported.version === 1, r.error?.message)
check('config.export carries the four sections',
  Array.isArray(exported.groups) && Array.isArray(exported.collections) && Array.isArray(exported.presets) && Array.isArray(exported.toolDeny))
check('config.export leaks no credentials and no paths',
  !/Bearer |Authorization|tok-smoke|[A-Za-z]:[\\/]/.test(String(r.data?.json)),
  String(r.data?.json).slice(0, 120))

const groupsBefore = (await get('/tool-hub/api/snapshot')).data.groups.length
const importedConfig = JSON.stringify({
  groups: [{
    id: 'g-imported',
    name: '导入的分组',
    members: [{ kind: 'plugin', id: 'e1' }, { kind: 'skill', id: 'user|beta' }],
    role: null,
    collection: 'default',
    tags: ['imported'],
    auto: false,
    createdAt: 1,
  }],
  collections: [{ id: 'imported', name: '导入抽屉', order: 9 }],
  presets: [{ name: 'imported-preset', enabled: { plugin: ['e1'], skill: [], tool: [] }, note: '', createdAt: 1 }],
  toolDeny: [],
})
r = await op('config.import', { json: importedConfig, mode: 'merge' })
check('config.import merge accepts the file', r.ok === true, JSON.stringify(r.error))
snap = await get('/tool-hub/api/snapshot')
check('merge added the group, the drawer and the preset',
  snap.data.groups.some(row => row.id === 'g-imported' && row.members.length === 2)
  && snap.data.collections.some(row => row.id === 'imported')
  && snap.data.presets.some(row => row.name === 'imported-preset'),
  JSON.stringify({ groups: snap.data.groups.length, collections: snap.data.collections.map(row => row.id) }))
check('merge kept the groups that were already there',
  snap.data.groups.length >= groupsBefore + 1, `${groupsBefore} -> ${snap.data.groups.length}`)
const sameName = JSON.stringify({
  groups: [{ id: 'g-other-id', name: '导入的分组', members: [], role: null, collection: 'default', tags: [], auto: false, createdAt: 2 }],
  collections: [],
  presets: [],
  toolDeny: [],
})
r = await op('config.import', { json: sameName, mode: 'merge' })
snap = await get('/tool-hub/api/snapshot')
check('merge keeps the existing group when the name collides',
  r.ok === true && snap.data.groups.filter(row => row.name === '导入的分组').length === 1
  && snap.data.groups.some(row => row.id === 'g-imported') && !snap.data.groups.some(row => row.id === 'g-other-id'),
  JSON.stringify(snap.data.groups.filter(row => row.name === '导入的分组').map(row => row.id)))
r = await op('config.import', { json: exportedJson, mode: 'merge' })
check('an exported file imports back in merge mode', r.ok === true, JSON.stringify(r.error))
const replaceConfig = JSON.stringify({
  groups: [{ id: 'only-group', name: '唯一分组', members: [], role: null, collection: 'default', tags: [], auto: false, createdAt: 1 }],
  collections: [],
  presets: [],
  toolDeny: [],
})
r = await op('config.import', { json: replaceConfig, mode: 'replace' })
    check('replace without confirmation is refused', r.error?.code === 'confirm-required', JSON.stringify(r.error))
    r = await op('config.import', { json: replaceConfig, mode: 'replace', confirm: true })
snap = await get('/tool-hub/api/snapshot')
check('replace leaves exactly the imported group and the default drawer',
  r.ok === true && snap.data.groups.length === 1 && snap.data.groups[0].id === 'only-group'
  && snap.data.collections.some(row => row.id === 'default') && snap.data.presets.length === 0,
  JSON.stringify({ groups: snap.data.groups.map(row => row.id), collections: snap.data.collections.map(row => row.id) }))
        // ── lazy servers ─────────────────────────────────────────────────────────
    r = await op('lazy.set', { server: 'fixture', on: true })
    check('lazy.set marks the server', r.ok === true && r.data.lazy.includes('fixture'), JSON.stringify(r.data ?? r.error))
    check('lazy hides every tool of the server',
      (await get('/tool-hub/api/snapshot')).data.tools.filter(row => row.server === 'fixture' && row.enabled === false).length === 2)
    r = await op('lazy.load', { names: ['mcp__fixture__alpha'] })
    check('lazy.load makes one tool visible again',
      r.ok === true && (await get('/tool-hub/api/snapshot')).data.tools.some(row => row.name === 'mcp__fixture__alpha' && row.enabled === true),
      JSON.stringify(r.data ?? r.error))
    r = await op('lazy.unload', { names: ['mcp__fixture__alpha'] })
    check('lazy.unload hides it again',
      r.ok === true && (await get('/tool-hub/api/snapshot')).data.tools.some(row => row.name === 'mcp__fixture__alpha' && row.enabled === false))
    r = await op('lazy.set', { server: 'fixture', on: false })
    check('turning lazy off restores every tool',
      r.ok === true && (await get('/tool-hub/api/snapshot')).data.tools.every(row => row.enabled === true),
      JSON.stringify(r.data ?? r.error))
check('state.reset without the confirm token is refused', (await op('state.reset', {})).error?.code === 'confirm-required')
check('config.import refuses broken json', (await op('config.import', { json: '{nope', mode: 'merge' })).error?.code === 'bad-json')
check('config.import refuses a payload that is not an object', (await op('config.import', { json: '[]', mode: 'merge' })).error?.code === 'bad-config')

// ── 18. description fallback chain ─────────────────────────────────────────
await mkdir(join(profileDir, 'node_modules', 'fixture-pack-desc'), { recursive: true })
await writeFile(
  join(profileDir, 'node_modules', 'fixture-pack-desc', 'package.json'),
  JSON.stringify({ name: 'fixture-pack-desc', description: '清单里写的说明', keywords: ['demo'] }),
)
fakePlugins.push({ entryId: 'e-desc-package', moduleName: 'fixture-pack-desc', meta: {}, fiberPhase: 'active' })
fakePlugins.push({ entryId: 'e-desc-meta', moduleName: 'fixture-pack-desc', meta: { description: '行自带的说明' }, fiberPhase: 'active' })
fakePlugins.push({ entryId: 'e-desc-known', moduleName: 'dsh-cost-meter', meta: {}, fiberPhase: 'active' })
fakePlugins.push({ entryId: 'e-desc-none', moduleName: 'fixture-no-description', meta: {}, fiberPhase: 'active' })
snap = await get('/tool-hub/api/snapshot')
const descRow = id => snap.data.plugins.find(row => row.id === id)
check('a row without a description falls back to its package.json',
  descRow('e-desc-package')?.description === '清单里写的说明' && descRow('e-desc-package')?.descriptionSource === 'package',
  JSON.stringify({ description: descRow('e-desc-package')?.description, source: descRow('e-desc-package')?.descriptionSource }))
check('the row description still wins over the manifest',
  descRow('e-desc-meta')?.description === '行自带的说明' && descRow('e-desc-meta')?.descriptionSource === 'meta',
  JSON.stringify({ description: descRow('e-desc-meta')?.description, source: descRow('e-desc-meta')?.descriptionSource }))
check('a package with no manifest description falls back to the known table',
  descRow('e-desc-known')?.descriptionSource === 'known'
  && (descRow('e-desc-known')?.description ?? '') !== ''
  && typeof descRow('e-desc-known')?.descriptionEn === 'string',
  JSON.stringify({ description: descRow('e-desc-known')?.description, source: descRow('e-desc-known')?.descriptionSource }))
check('a row with no description anywhere stays an empty string',
  descRow('e-desc-none')?.description === '' && descRow('e-desc-none')?.descriptionSource === '',
  JSON.stringify({ description: descRow('e-desc-none')?.description, source: descRow('e-desc-none')?.descriptionSource }))
fakePlugins.splice(-4)

// ── 19. patch lock ownership, concurrent writes, byte-exact EOL ─────────────
// `lockFile` points at `${patchFile}.panel.lock`, the same path the writer takes.
const patchRows = () => readFile(patchFile, 'utf8')

// A documentPath that names the profile's own patch is honoured...
fakeDocumentPath = patchFile
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { cwd: '' } })
check('an in-profile documentPath is used as-is', r.ok === true && r.data.patch === patchFile, JSON.stringify(r.data ?? r.error))

// ...one that points outside the profile is not, even when the file exists and is writable.
const outsidePatch = join(home, 'outside-patch.yml')
await writeFile(outsidePatch, 'sentinel\n')
fakeDocumentPath = outsidePatch
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { cwd: '' } })
check('a documentPath outside the profile is ignored',
  r.ok === true && r.data.patch === patchFile && (await readFile(outsidePatch, 'utf8')) === 'sentinel\n',
  JSON.stringify({ patch: r.data?.patch, outside: await readFile(outsidePatch, 'utf8') }))

// ...and one with the wrong file name inside the profile falls back to the profile patch too.
fakeDocumentPath = join(profileDir, 'some-other.yml')
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { cwd: '' } })
check('a documentPath that is not cordis.patch.yml falls back to the profile path',
  r.ok === true && r.data.patch === patchFile && !(await stat(join(profileDir, 'some-other.yml')).then(() => true, () => false)),
  JSON.stringify(r.data ?? r.error))
fakeDocumentPath = null

// Two saves read-modify-write the same file at once: the lock has to serialize them so neither
// field is lost. The old code computed both edits from the same snapshot and kept only the later.
const [saveA, saveB] = await Promise.all([
  op('mcp.save', { id: 'panel-mcp-fixture', config: { cwd: 'C:\\concurrent-a' } }),
  op('mcp.save', { id: 'panel-mcp-fixture', config: { toolCallTimeoutMs: 4321 } }),
])
const raced = await patchRows()
check('two concurrent saves both succeed', saveA.ok === true && saveB.ok === true,
  JSON.stringify({ a: saveA.error, b: saveB.error }))
check('the later save did not overwrite the earlier field',
  /cwd: '?C:\\concurrent-a'?/.test(raced) && /toolCallTimeoutMs: 4321/.test(raced),
  raced.split('\n').filter(line => /cwd|toolCallTimeoutMs/.test(line)).join(' | '))
check('neither writer left its lock behind',
  !(await stat(lockFile).then(() => true, () => false))
  && (await readdir(profileDir)).every(name => !name.includes('.release')),
  (await readdir(profileDir)).join(','))

// A lock whose owner we cannot identify is not ours to delete, however old it looks. The mtime is
// two minutes back so a mtime-only reclaim would have taken it on the first poll.
await writeFile(lockFile, '')
const ancientLock = new Date(Date.now() - 120_000)
await utimes(lockFile, ancientLock, ancientLock)
const held = op('mcp.save', { id: 'panel-mcp-fixture', config: { failOnStartupError: true } })
// Long enough for one poll round (the fixture sets a 250ms lock budget), short enough that the
// writer still has time left once we free the lock ourselves.
await new Promise(done => setTimeout(done, 100))
const survived = (await readFile(lockFile, 'utf8').catch(() => null)) === ''
await rm(lockFile, { force: true })
const heldResult = await held
check('a lock with no readable token is never deleted',
  survived && heldResult.ok === true, JSON.stringify({ survived, result: heldResult.data ?? heldResult.error }))
check('the waiting writer takes the lock once it is free',
  heldResult.ok === true && !(await stat(lockFile).then(() => true, () => false)),
  JSON.stringify(heldResult.data ?? heldResult.error))

// A lock with a readable token and no heartbeat for two minutes is abandoned: reclaimable.
await writeFile(lockFile, 'dead-owner:0000\n2020-01-01T00:00:00.000Z\n')
const longAgo = new Date(Date.now() - 120_000)
await utimes(lockFile, longAgo, longAgo)
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { failOnStartupError: false } })
check('an abandoned lock with a readable token is reclaimed',
  r.ok === true && !(await stat(lockFile).then(() => true, () => false)), JSON.stringify(r.data ?? r.error))

// Byte-exact edits: a CRLF patch with no final newline must stay exactly that shape.
const MCP_NAME = '@deepseek-ai/dsh-mcp-client'
const crlfDoc = [
  '# kept: comment',
  'root:',
  '  plugins:',
  '    - id: crlf-row',
  `      name: "${MCP_NAME}"`,
  '      config:',
  '        serverName: crlf',
  '        url: http://127.0.0.1:1/mcp',
].join('\r\n')
const crlfEdited = replaceMcpConfig(crlfDoc, 'crlf-row', { serverName: 'crlf', url: 'http://127.0.0.1:2/mcp' })
check('replacing a config in a CRLF patch returns the same bytes with one line changed',
  crlfEdited === crlfDoc.replace('127.0.0.1:1', '127.0.0.1:2') && !/(^|[^\r])\n/.test(crlfEdited),
  JSON.stringify(crlfEdited.slice(-40)))
const crlfAppended = appendMcpRow(crlfDoc, 'crlf-new', { serverName: 'crlf-new' }, true)
check('appending keeps the existing bytes and does not invent a final newline',
  crlfAppended.startsWith(crlfDoc) && crlfAppended.includes('\r\n- id: crlf-new\r\n')
  && !crlfAppended.endsWith('\n') && !/(^|[^\r])\n/.test(crlfAppended),
  JSON.stringify(crlfAppended.slice(crlfDoc.length)))
const crlfRemoved = removeMcpRow(crlfDoc, 'crlf-row')
check('removing leaves the rest of a CRLF patch byte-identical',
  crlfRemoved === '# kept: comment\r\nroot:\r\n  plugins:', JSON.stringify(crlfRemoved))
const lfDoc = `${crlfDoc.replaceAll('\r\n', '\n')}\n`
const lfEdited = replaceMcpConfig(lfDoc, 'crlf-row', { serverName: 'crlf', url: 'http://127.0.0.1:3/mcp' })
check('an LF patch stays LF and keeps its final newline',
  lfEdited === lfDoc.replace('127.0.0.1:1', '127.0.0.1:3') && !lfEdited.includes('\r') && lfEdited.endsWith('\n'),
  JSON.stringify(lfEdited.slice(-30)))

// ── 20. mcp.rawSave: refused before any byte, and rolled back when the host never loads it ──
const backupsNow = async () => (await readdir(backupDir).catch(() => [])).filter(name => name.endsWith('.bak'))
const mcpRowIds = async () => parseMcpRows(await readFile(patchFile, 'utf8')).map(row => row.id).sort()

// (a) The draft is older than the disk: the row was moved two spaces deeper after `mcp.raw` read
// it. The writer re-reads inside the lock, so the edit is refused and nothing at all is written.
const staleDraft = (await op('mcp.raw', { id: 'panel-mcp-fixture' })).data.text
const freezeDoc = await readFile(patchFile, 'utf8')
const freezeRow = parseMcpRows(freezeDoc).find(row => row.id === 'panel-mcp-fixture')
const freezeLines = freezeDoc.split('\n')
for (let index = freezeRow.startLine; index < freezeRow.endLine; index += 1) {
  if (freezeLines[index].trim() !== '') freezeLines[index] = `  ${freezeLines[index]}`
}
const freezeText = freezeLines.join('\n')
await writeFile(patchFile, freezeText)
check('mcp.raw reads the row where the file actually has it',
  (await op('mcp.raw', { id: 'panel-mcp-fixture' })).data.text.startsWith('      - id: panel-mcp-fixture'),
  JSON.stringify((await op('mcp.raw', { id: 'panel-mcp-fixture' })).data.text.slice(0, 40)))
const backupsBeforeStale = new Set(await backupsNow())
r = await op('mcp.rawSave', { id: 'panel-mcp-fixture', text: staleDraft })
check('a draft the disk has moved past is refused as raw-indent',
  r.ok === false && r.error.code === 'raw-indent', JSON.stringify(r.error))
check('the refused stale draft leaves the file byte-identical',
  (await readFile(patchFile, 'utf8')) === freezeText)
check('a refusal that never wrote takes no backup',
  (await backupsNow()).filter(name => !backupsBeforeStale.has(name)).length === 0)
await writeFile(patchFile, freezeDoc)

// (b) The draft is accepted and written, but the host never loads it: the file has to come back
// exactly as it was, with the backup kept. A row that parses always comes back from the snapshot
// either as a plugin row or as an orphan, so the only way the post-write check can fail is a host
// that cannot answer at all — which is what `fakePluginsFail` simulates. The draft itself is one
// the loader has to reject anyway: it reuses a server name another row already owns, a defect the
// per-row pre-checks cannot see.
const rollbackBase = await readFile(patchFile, 'utf8')
const backupsBeforeRollback = new Set(await backupsNow())
const liveDraft = (await op('mcp.raw', { id: 'panel-mcp-fixture' })).data.text
const duplicateDraft = liveDraft.replace(/serverName:[^\n]*/, 'serverName: oauth-fixture')
check('the illegal draft passes every pre-check and only differs in its server name',
  duplicateDraft !== liveDraft && parseMcpRows(duplicateDraft).length === 1
  && parseMcpRows(duplicateDraft)[0].config.serverName === 'oauth-fixture',
  JSON.stringify(parseMcpRows(duplicateDraft).map(row => row.config)))
let rolled
try {
  const pendingRawSave = op('mcp.rawSave', { id: 'panel-mcp-fixture', text: duplicateDraft })
  await new Promise(done => setTimeout(done, 250))
  fakePluginsFail = true
  rolled = await pendingRawSave
}
finally {
  fakePluginsFail = false
}
const rolledMessage = String(rolled?.error?.message ?? '')
const rolledBackup = /\(backup: (.+)\)$/.exec(rolledMessage)?.[1] ?? ''
check('a write the host never loads answers raw-verify, code untouched',
  rolled.ok === false && rolled.error.code === 'raw-verify', JSON.stringify({ code: rolled.error?.code, message: rolledMessage }))
check('the refusal names the backup it kept',
  rolledBackup !== '' && await stat(rolledBackup).then(() => true, () => false), rolledMessage)
check('the backup holds the patch exactly as it was before the write',
  rolledBackup !== '' && (await readFile(rolledBackup, 'utf8').catch(() => null)) === rollbackBase,
  rolledBackup)
check('the patch itself is byte-identical again',
  (await readFile(patchFile, 'utf8')) === rollbackBase)
check('the host reads the old row, not the rejected draft',
  (await op('mcp.raw', { id: 'panel-mcp-fixture' })).data.text === liveDraft)
const newBackups = (await backupsNow()).filter(name => !backupsBeforeRollback.has(name))
check('the rollback left exactly one backup behind', newBackups.length === 1, JSON.stringify(newBackups))
check('the rollback left no temp file behind',
  (await readdir(profileDir)).every(name => !name.endsWith('.tmp')))
check('the patch still holds its two MCP rows',
  JSON.stringify(await mcpRowIds()) === '["panel-mcp-fixture","tool-hub-mcp-oauth-fixture"]',
  JSON.stringify(await mcpRowIds()))
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { cwd: 'C:\\after-rollback' } })
check('a normal save goes through after a rollback (no wedged lock)',
  r.ok === true && (await readFile(patchFile, 'utf8')).includes('C:\\after-rollback'),
  JSON.stringify(r.error ?? r.data?.patch))

// ── 21. panel lock: a foreign owner, and a lock that changes hands mid-write ──
const lockBytes = async () => readFile(lockFile, 'utf8').catch(() => null)
const writeForeignLock = async (token) => {
  await writeFile(lockFile, `${token}\n${new Date().toISOString()}\n`)
  return await readFile(lockFile, 'utf8')
}

// Another live writer (a different pid, heartbeat fresh) holds the lock: it is not ours to delete,
// so the write waits out its budget and reports the timeout without touching a single byte.
const foreignToken = `${process.pid + 1}:${randomUUID()}`
const foreignLockBytes = await writeForeignLock(foreignToken)
const beforeForeignSave = await readFile(patchFile, 'utf8')
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { cwd: 'C:\\foreign-owner' } })
check('a lock held by another live pid ends in lock-timeout',
  r.ok === false && r.error.code === 'lock-timeout', JSON.stringify(r.error))
check('the timed-out save wrote nothing', (await readFile(patchFile, 'utf8')) === beforeForeignSave)
check('the foreign lock is left for its owner, byte for byte', (await lockBytes()) === foreignLockBytes)
check('the timeout left no release scratch file',
  (await readdir(profileDir)).every(name => !name.includes('.release')),
  (await readdir(profileDir)).join(','))
await rm(lockFile, { force: true })
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { cwd: 'C:\\after-foreign' } })
check('the same save goes through once the foreign lock is gone',
  r.ok === true && (await readFile(patchFile, 'utf8')).includes('C:\\after-foreign'),
  JSON.stringify(r.error ?? r.data?.patch))

// The lock is deleted while the writer is in its verify sleep: a cleanup, not a conflict — the
// write stands and nothing is left behind. `mcp.rawSave` is the call that holds the lock across a
// ~900ms post-write check; `mcp.save` only takes it for a few milliseconds.
const waitForLock = async (timeout = 800) => {
  const started = Date.now()
  for (;;) {
    if ((await lockBytes()) !== null) return true
    if (Date.now() - started > timeout) return false
    await new Promise(done => setTimeout(done, 20))
  }
}
const vanishedDraft = (await op('mcp.raw', { id: 'panel-mcp-fixture' })).data.text
  .replace(/serverName:[^\n]*/, 'serverName: lock-vanished')
const vanishedPending = op('mcp.rawSave', { id: 'panel-mcp-fixture', text: vanishedDraft })
const lockHeldDuringSleep = await waitForLock()
await rm(lockFile, { force: true })
const vanishedResult = await vanishedPending
check('the lock is still held while the writer sleeps', lockHeldDuringSleep)
check('a lock deleted under the writer is a cleanup, not a failure',
  vanishedResult.ok === true && vanishedResult.data.saved === true,
  JSON.stringify(vanishedResult.error ?? vanishedResult.data))
check('the write the deleted lock guarded still landed',
  (await readFile(patchFile, 'utf8')).includes('serverName: lock-vanished'))
check('the deleted lock is not recreated', (await lockBytes()) === null)

// The lock is deleted and taken over by another writer while we sleep: the write landed, but this
// call may not claim it did, so it answers lock-lost and leaves the other writer's lock alone.
const takeoverDraft = (await op('mcp.raw', { id: 'panel-mcp-fixture' })).data.text
  .replace(/serverName:[^\n]*/, 'serverName: lock-taken-over')
const takeoverPending = op('mcp.rawSave', { id: 'panel-mcp-fixture', text: takeoverDraft })
const lockHeldBeforeTakeover = await waitForLock()
await rm(lockFile, { force: true })
const usurperBytes = await writeForeignLock(`${process.pid + 9}:${randomUUID()}`)
const takeoverResult = await takeoverPending
check('a lock taken over mid-write answers lock-lost',
  lockHeldBeforeTakeover && takeoverResult.ok === false && takeoverResult.error.code === 'lock-lost',
  JSON.stringify({ held: lockHeldBeforeTakeover, error: takeoverResult.error }))
const afterTakeover = await readFile(patchFile, 'utf8')
check('the write that lost its lock still landed in one piece',
  afterTakeover.includes('serverName: lock-taken-over')
  && afterTakeover.startsWith('# fixture profile patch')
  && afterTakeover.includes('- id: keep-me')
  && JSON.stringify(parseMcpRows(afterTakeover).map(row => row.id).sort()) === '["panel-mcp-fixture","tool-hub-mcp-oauth-fixture"]',
  afterTakeover.slice(-200))
check('the other writer still owns its lock', (await lockBytes()) === usurperBytes)
check('no temp file survived the lost lock',
  (await readdir(profileDir)).every(name => !name.endsWith('.tmp')), (await readdir(profileDir)).join(','))
await rm(lockFile, { force: true })

// ── 22. workspace discovery: env → workspaces → workspaceRegistry → sessions ──
const workspaceC = join(home, 'workspace-c')
const workspaceD = join(home, 'workspace-d')
await mkdir(join(workspaceC, '.dsh', 'skills', 'c-skill'), { recursive: true })
await writeFile(join(workspaceC, '.dsh', 'skills', 'c-skill', 'SKILL.md'), '---\nname: c-skill\ndescription: registry workspace skill\n---\n\nbody\n')
await mkdir(join(workspaceD, '.dsh', 'skills', 'd-skill'), { recursive: true })
await writeFile(join(workspaceD, '.dsh', 'skills', 'd-skill', 'SKILL.md'), '---\nname: d-skill\ndescription: sessions workspace skill\n---\n\nbody\n')
const workspaceRootsOf = (snapshot) => (snapshot?.paths?.skills ?? []).filter(entry => entry.scope === 'workspace')
const globalRootsOf = (snapshot) => (snapshot?.paths?.skills ?? []).filter(entry => entry.scope === 'global')

delete process.env.TOOL_HUB_WORKSPACES
// An empty list is an answer, but not a useful one: the chain has to keep walking.
fakeWorkspaces = []
fakeWorkspacesExplode = false
fakeRegistry = [{ root: workspaceC }]
fakeSessions = [{ path: workspaceD }]
let chainSnap = (await get('/tool-hub/api/snapshot')).data ?? {}
let chainRoots = workspaceRootsOf(chainSnap)
check('an empty workspaces list falls through to workspaceRegistry',
  chainRoots.length === 1 && chainRoots[0].workspace === workspaceC && /^ws-[0-9a-f]{8}$/.test(chainRoots[0].id),
  JSON.stringify(chainRoots))
check('the registry workspace publishes its skills under its hashed root',
  chainSnap.skills?.some(row => row.name === 'c-skill' && row.scope === 'workspace'
    && row.workspace === workspaceC && row.rootId === chainRoots[0]?.id),
  JSON.stringify((chainSnap.skills ?? []).filter(row => row.scope === 'workspace')))

// A source that throws is "that source knows nothing", never a failed snapshot.
fakeWorkspacesExplode = true
fakeRegistry = [{ dir: workspaceC }]
chainSnap = (await get('/tool-hub/api/snapshot')).data ?? {}
chainRoots = workspaceRootsOf(chainSnap)
check('a throwing workspaces service is skipped, not fatal',
  chainRoots.some(entry => entry.workspace === workspaceC)
  && chainSnap.skills?.some(row => row.name === 'c-skill'),
  JSON.stringify({ roots: chainRoots, skills: (chainSnap.skills ?? []).map(row => row.name) }))

// With no registry, the sessions service is the last thing that can name a workspace.
fakeWorkspacesExplode = false
fakeWorkspaces = null
fakeRegistry = null
fakeSessions = [{ path: workspaceD }]
chainSnap = (await get('/tool-hub/api/snapshot')).data ?? {}
chainRoots = workspaceRootsOf(chainSnap)
check('sessions.listWorkspaces is the last source in the chain',
  chainRoots.length === 1 && chainRoots[0].workspace === workspaceD
  && chainSnap.skills?.some(row => row.name === 'd-skill' && row.scope === 'workspace'),
  JSON.stringify(chainRoots))

// No source at all: the two global roots and nothing else.
fakeSessions = null
chainSnap = (await get('/tool-hub/api/snapshot')).data ?? {}
check('with no workspace source only the global roots remain',
  workspaceRootsOf(chainSnap).length === 0
  && globalRootsOf(chainSnap).length === 2
  && globalRootsOf(chainSnap)[0]?.id === 'user'
  && !(chainSnap.skills ?? []).some(row => row.scope === 'workspace'),
  JSON.stringify(chainSnap.paths?.skills))

// The sandbox escape hatch: a bare "-" means "no workspace roots", even with two services offering.
process.env.TOOL_HUB_WORKSPACES = '-'
fakeRegistry = [{ path: workspaceC }]
fakeSessions = [{ path: workspaceD }]
chainSnap = (await get('/tool-hub/api/snapshot')).data ?? {}
check('the "-" override keeps every workspace root out',
  workspaceRootsOf(chainSnap).length === 0 && globalRootsOf(chainSnap).length === 2,
  JSON.stringify(chainSnap.paths?.skills))

// A real env value still outranks both services, and only its own workspace is published.
process.env.TOOL_HUB_WORKSPACES = workspaceD
fakeRegistry = [{ path: workspaceC }]
chainSnap = (await get('/tool-hub/api/snapshot')).data ?? {}
chainRoots = workspaceRootsOf(chainSnap)
check('the env source still outranks both services',
  chainRoots.length === 1 && chainRoots[0].workspace === workspaceD
  && chainSnap.skills?.some(row => row.name === 'd-skill' && !chainSnap.skills.some(other => other.name === 'c-skill')),
  JSON.stringify(chainRoots))
delete process.env.TOOL_HUB_WORKSPACES
fakeRegistry = null
fakeSessions = null
fakeWorkspaces = null

authServer.close()

server.close()
const failed = results.filter(row => row.ok !== true)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
// A passing run used to keep its fixture, which quietly filled %TEMP% with one directory per run.
// Keep it only when someone is going to look inside.
if (failed.length > 0) {
  await rm(home, { recursive: true, force: true })
  process.exitCode = 1
}
else if (process.env.TOOL_HUB_KEEP_FIXTURE === '1') {
  console.log(`fixture kept: ${home}`)
}
else {
  await rm(home, { recursive: true, force: true })
}

