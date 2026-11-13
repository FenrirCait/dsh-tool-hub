import { readFile, writeFile } from 'node:fs/promises'

const path = 'probe/host-smoke.mjs'
let text = await readFile(path, 'utf8')
const apply = (from, to, label) => {
  if (!text.includes(from)) {
    console.log('MISS', label)
    return
  }
  text = text.replace(from, to)
  console.log('ok  ', label)
}

apply(
`// ── fixture: plugin manager ────────────────────────────────────────────────
const enabled = new Set(['@deepseek-ai/dsh-session', 'billion-context', 'ui-theme'])`,
`// ── fixture: profile patch with one MCP server ─────────────────────────────
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
  '        command: C:\\\\Program Files\\\\nodejs\\\\node.exe',
  '        args:',
  '          - C:\\\\tools\\\\server.js',
  '        env: {}',
  '        cwd: ""',
  '      disabled: true',
  '- id: keep-me',
  '  name: some-other-plugin',
  '',
].join('\\n')
await writeFile(join(profileDir, 'cordis.patch.yml'), patchText)

// ── fixture: plugin manager ────────────────────────────────────────────────
const enabled = new Set(['@deepseek-ai/dsh-session', 'billion-context', 'ui-theme'])`,
  'mcp fixture',
)

apply(
`  { entryId: 'e6', moduleName: 'plugin-manager', meta: { title: 'Plugin Manager' }, fiberPhase: 'active', readOnlyReason: 'management-required' },
]`,
`  { entryId: 'e6', moduleName: 'plugin-manager', meta: { title: 'Plugin Manager' }, fiberPhase: 'active', readOnlyReason: 'management-required' },
  { entryId: 'e7', moduleName: '@deepseek-ai/dsh-mcp-client', patchId: 'panel-mcp-fixture', fiberPhase: null },
]`,
  'mcp plugin row',
)

apply(
`    if (name === 'pluginManager') return fakeManager`,
`    if (name === 'pluginManager') return fakeManager
    if (name === 'profileContext') return { dir: profileDir }`,
  'profile context',
)

apply(
`check('plugins listed', snap.data.plugins.length === 6, \`got \${snap.data.plugins.length}\`)`,
`check('plugins listed', snap.data.plugins.length === 7, \`got \${snap.data.plugins.length}\`)
check('mcp row named by server', snap.data.plugins.find(row => row.id === 'e7')?.name === 'fixture', JSON.stringify(snap.data.plugins.find(row => row.id === 'e7')))
check('mcp row editable', snap.data.plugins.find(row => row.id === 'e7')?.mcpEditable === true)
check('mcp patch path exposed', snap.data.paths.patch === join(profileDir, 'cordis.patch.yml'), snap.data.paths.patch)`,
  'mcp snapshot checks',
)

apply(
`// ── 3. plugin toggle + read-only refusal ───────────────────────────────────`,
`// ── 2b. mcp config edit ───────────────────────────────────────────────────
const patchFile = join(profileDir, 'cordis.patch.yml')
const before = await readFile(patchFile, 'utf8')
r = await op('mcp.save', { id: 'panel-mcp-fixture', config: { serverName: 'renamed', args: ['C:\\\\a b\\\\index.js', '--flag'], env: { FOO: 'bar' }, unknownKey: 'dropped' } })
check('mcp save accepted', r.ok === true && r.data.ok === true, JSON.stringify(r))
const after = await readFile(patchFile, 'utf8')
check('mcp row rewritten', after.includes('serverName: renamed') && after.includes('--flag') && after.includes('FOO: bar'))
check('mcp unknown key dropped', !after.includes('unknownKey'))
check('mcp neighbours untouched', after.includes('- id: keep-me') && after.includes('name: some-other-plugin') && after.startsWith('# fixture profile patch'))
check('mcp other rows untouched', (after.match(/dsh-mcp-client/g) ?? []).length === 1)
check('mcp save refuses unknown id', (await op('mcp.save', { id: 'nope', config: {} })).data?.ok === false)
check('mcp save refuses garbage config', (await op('mcp.save', { id: 'panel-mcp-fixture', config: 5 })).data?.ok === false)
const restored = await readFile(patchFile, 'utf8')
check('mcp refused writes leave file alone', restored === after, 'file changed after a refused write')

// ── 3. plugin toggle + read-only refusal ───────────────────────────────────`,
  'mcp save checks',
)

await writeFile(path, text, 'utf8')
