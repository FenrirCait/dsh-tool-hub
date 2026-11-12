/**
 * Host-half smoke test: runs lib/index.js against a fake cordis context and a
 * fake pluginManager, over a real HTTP listener, so the wire format, the skill
 * file rename, the state file and the toggle paths are all exercised without
 * touching any profile on this machine.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
]
const fakeManager = {
  async listPlugins() {
    return fakePlugins.map(row => ({ ...row, enabled: enabled.has(row.moduleName) }))
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
    if (name === 'tools') return { view: () => ({ knownNames: mcpTools, restrictableNames: mcpTools }) }
    if (name === 'agents') return { list: () => [] }
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
  const response = await fetch(`${base}${path}`, { headers: { host: `127.0.0.1:${port}` } })
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
check('plugins listed', snap.data.plugins.length === 8, `got ${snap.data.plugins.length}`)
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
check('auto preview splits roles', plan.some(entry => entry.role === 'base') && plan.some(entry => entry.role === 'task'), plan.map(entry => `${entry.role}:${entry.name}:${entry.members.length}`).join(', '))
check('auto preview tags every bucket', plan.every(entry => Array.isArray(entry.tags) && entry.tags.length > 0))
r = await op('auto.apply', {})
check('auto applied', r.ok === true && r.data.groups >= 2, JSON.stringify({ groups: r.data?.groups, members: r.data?.members }))
snap = await get('/tool-hub/api/snapshot')
check('auto groups in snapshot', snap.data.groups.length >= 2 && snap.data.groups.every(group => group.auto === true))

// ── 6. group toggle ────────────────────────────────────────────────────────
const foundation = snap.data.groups.find(group => group.role === 'base')
check('auto groups carry role', snap.data.groups.every(group => group.role === 'base' || group.role === 'task' || group.role === 'skill'), snap.data.groups.map(group => `${group.name}:${group.role}`).join(', '))
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

// ── 10. bad op ─────────────────────────────────────────────────────────────
r = await op('nope', {})
check('unknown op answers an error', r.ok === false && r.error.code === 'bad-op', JSON.stringify(r.error))

server.close()
const failed = results.filter(row => row.ok !== true)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  await rm(home, { recursive: true, force: true })
  process.exitCode = 1
}
else {
  console.log(`fixture kept: ${home}`)
}
