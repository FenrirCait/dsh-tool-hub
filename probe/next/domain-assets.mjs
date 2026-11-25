#!/usr/bin/env node
/**
 * Probe for the 2.0 resource domains: plugins, skills, mcp.
 *
 * Hand-written PASS/FAIL, no framework, no third-party library, exit 1 when anything fails.
 * Everything runs against fake services and a throwaway directory: no host, no real profile, no
 * network, and every path this probe writes is deleted again at the end.
 *
 * What it pins down (the acceptance list for task-2):
 *   - a read-only row is refused by name, not by a crash (plugin readOnlyReason, MCP row without a
 *     config block, a skill root marked readonly=)
 *   - an unknown id is a structured ok:false with a code
 *   - an empty list is an empty list, not an error
 *   - an MCP patch write changes the target block only: every other line stays byte-identical,
 *     CRLF stays CRLF, a missing final newline stays missing, and a failed host check rolls back
 *   - skill toggling renames one file and leaves its neighbours alone
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const domainsDir = process.env.TOOL_HUB_DOMAINS_DIR ?? join(repo, 'dist', 'domains')

let passed = 0
const failures = []

function record(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log('PASS  ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
    return
  }
  failures.push(name + (detail === undefined ? '' : '  [' + detail + ']'))
  console.log('FAIL  ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  record(name, a === b, a === b ? undefined : 'got ' + a + ', want ' + b)
}

function truthy(name, value, detail) {
  record(name, Boolean(value), value ? detail : 'falsy' + (detail ? ' — ' + detail : ''))
}

async function step(name, work) {
  try {
    await work()
  }
  catch (error) {
    record(name, false, 'threw ' + (error && error.stack ? error.stack.split('\n')[0] : String(error)))
  }
}

// ── tiny zip writer (store only) so the import guardrails can be exercised ───

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    value = (CRC_TABLE[(value ^ (buffer[index] ?? 0)) & 0xff] ?? 0) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

// ── fake env ────────────────────────────────────────────────────────────────

function makeEnv(services) {
  const saves = []
  const state = {
    version: 2,
    groups: [],
    collections: [],
    presets: [],
    toolDeny: [],
    auto: { appliedAt: null },
    sessions: {},
    scenes: {},
    mode: null,
    settings: {},
    modules: {},
  }
  return {
    state,
    services: { get: name => services[name] },
    save: async reason => {
      saves.push(reason)
      return null
    },
    log: () => {},
    now: () => Date.now(),
    saves,
  }
}

function pluginManager(rows) {
  const calls = []
  return {
    calls,
    async listPlugins() {
      return rows
    },
    async setPluginEnabled(id, enabled) {
      calls.push({ id, enabled })
      return { application: 'applied', warnings: [] }
    },
  }
}

// ── fixture builders ────────────────────────────────────────────────────────

function skillFile(name, description, extra) {
  return '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n# ' + name + '\n\n' + (extra ?? 'Body of ' + name + '.\n')
}

const PATCH = [
  '# hand-written profile patch: comments and ordering must survive an edit',
  '- id: model-bridge',
  '  name: "@deepseek-ai/dsh-model-bridge"',
  '  config:',
  '    model: gpt-5',
  '',
  '# the first MCP server',
  '- id: tool-hub-mcp-alpha',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config:',
  '    serverName: alpha',
  '    transport: stdio',
  '    command: npx',
  '    args:',
  '      - -y',
  '      - alpha-server',
  '    env:',
  '      TOKEN: super-secret',
  '  disabled: true',
  '',
  '# a row with an empty config block',
  '- id: tool-hub-mcp-beta',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config: {}',
  '',
  '# a legacy row with no config block at all: nothing here may be written',
  '- id: tool-hub-mcp-legacy',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  disabled: true',
  '',
].join('\n')

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'tool-hub-domains-'))
  const home = join(work, 'home')
  const profile = join(work, 'profile')
  const rootA = join(work, 'root-a')
  const rootB = join(work, 'root-b')
  const rootRO = join(work, 'root-ro')
  await mkdir(home, { recursive: true })
  await mkdir(profile, { recursive: true })
  await mkdir(join(rootA, 'alpha'), { recursive: true })
  await mkdir(join(rootA, 'beta'), { recursive: true })
  await mkdir(join(rootB, 'gamma'), { recursive: true })
  await mkdir(join(rootRO, 'locked'), { recursive: true })
  await mkdir(join(rootA, 'empty-dir'), { recursive: true })
  await writeFile(join(rootA, 'alpha', 'SKILL.md'), skillFile('alpha', 'first skill'))
  await writeFile(join(rootA, 'beta', 'SKILL.md.disabled'), skillFile('beta', 'second skill'))
  const gammaBody = skillFile('gamma', 'third skill')
  await writeFile(join(rootB, 'gamma', 'SKILL.md'), gammaBody)
  await writeFile(join(rootRO, 'locked', 'SKILL.md'), skillFile('locked', 'on a read-only root'))

  process.env.DSH_HOME = home
  delete process.env.TOOL_HUB_STATE_FILE
  process.env.TOOL_HUB_WORKSPACES = '-'
  process.env.TOOL_HUB_SKILL_ROOTS = [rootA, rootB, 'readonly=' + rootRO].join(';')

  const skills = await import(new URL('file:///' + join(domainsDir, 'skills.js').replace(/\\/g, '/')).href)
  const mcp = await import(new URL('file:///' + join(domainsDir, 'mcp.js').replace(/\\/g, '/')).href)
  const plugins = await import(new URL('file:///' + join(domainsDir, 'plugins.js').replace(/\\/g, '/')).href)

  const skillsDomain = skills.createSkillsDomain()
  const mcpDomain = mcp.createMcpDomain()
  const pluginsDomain = plugins.createPluginsDomain()
  const call = (domain, op, payload, env) => domain.handlers[op](payload, env)

  // ── registry shape ───────────────────────────────────────────────────────
  await step('registry: op ids follow 1.x and never collide', async () => {
    const ids = [...skillsDomain.module.ops, ...mcpDomain.module.ops, ...pluginsDomain.module.ops].map(op => op.id)
    const unique = new Set(ids)
    record('registry: op ids are unique', unique.size === ids.length, ids.length + ' ops')
    const want = ['toggle', 'bulk', 'skill.list', 'skill.toggle', 'skill.delete', 'skill.restore', 'skill.trash', 'skill.import', 'skill.move', 'mcp.list', 'mcp.save', 'mcp.create', 'mcp.delete', 'mcp.raw', 'mcp.rawSave']
    for (const id of want) record('registry: declares ' + id, ids.includes(id))
    for (const domain of [skillsDomain, mcpDomain, pluginsDomain]) {
      const declared = domain.module.ops.map(op => op.id).sort()
      const handled = Object.keys(domain.handlers).sort()
      eq('registry: ' + domain.module.id + ' has one handler per op', handled, declared)
    }
  })

  // ── skills: listing across roots ─────────────────────────────────────────
  const skillEnv = makeEnv({})
  await step('skills: multi-root list', async () => {
    const res = await call(skillsDomain, 'skill.list', {}, skillEnv)
    eq('skills: list ok', res.ok, true)
    eq('skills: three roots', res.roots.map(root => root.id), ['user', 'root2', 'root3'])
    eq('skills: root3 is read-only', res.roots[2].readOnly, true)
    eq('skills: four skills', res.items.map(row => row.name), ['alpha', 'beta', 'gamma', 'locked'])
    const beta = res.items.find(row => row.name === 'beta')
    eq('skills: .disabled row is off', beta.enabled, false)
    eq('skills: id is root|rel', res.items.find(row => row.name === 'gamma').id, 'root2|gamma')
  })

  await step('skills: empty list is empty, not an error', async () => {
    process.env.TOOL_HUB_SKILL_ROOTS = join(work, 'does-not-exist')
    const res = await call(skillsDomain, 'skill.list', {}, skillEnv)
    eq('skills: empty roots ok', res.ok, true)
    eq('skills: no items', res.items, [])
    eq('skills: count is zero', res.count, 0)
    process.env.TOOL_HUB_SKILL_ROOTS = [rootA, rootB, 'readonly=' + rootRO].join(';')
  })

  // ── skills: toggle renames one file, neighbours untouched ────────────────
  await step('skills: toggle renames SKILL.md only', async () => {
    const on = await call(skillsDomain, 'skill.toggle', { id: 'user|beta', enabled: true }, skillEnv)
    eq('skills: beta on', on.ok, true)
    eq('skills: beta message', on.message, 'renamed on')
    truthy('skills: beta SKILL.md exists', await exists(join(rootA, 'beta', 'SKILL.md')))
    record('skills: beta .disabled gone', !(await exists(join(rootA, 'beta', 'SKILL.md.disabled'))))

    const off = await call(skillsDomain, 'skill.toggle', { id: 'user|alpha', enabled: false }, skillEnv)
    eq('skills: alpha off', off.ok, true)
    record('skills: alpha .disabled exists', await exists(join(rootA, 'alpha', 'SKILL.md.disabled')))
    record('skills: alpha SKILL.md gone', !(await exists(join(rootA, 'alpha', 'SKILL.md'))))
    eq('skills: gamma untouched', await readFile(join(rootB, 'gamma', 'SKILL.md'), 'utf8'), gammaBody)
    record('skills: gamma still has only SKILL.md', !(await exists(join(rootB, 'gamma', 'SKILL.md.disabled'))))
  })

  await step('skills: refusals are structured', async () => {
    const unknown = await call(skillsDomain, 'skill.toggle', { id: 'user|nope', enabled: true }, skillEnv)
    eq('skills: unknown id code', unknown.code, 'unknown-skill')
    eq('skills: unknown id ok', unknown.ok, false)
    const escape = await call(skillsDomain, 'skill.toggle', { id: 'user|../outside', enabled: true }, skillEnv)
    eq('skills: path escape code', escape.code, 'unknown-skill')
    const readonly = await call(skillsDomain, 'skill.toggle', { id: 'root3|locked', enabled: false }, skillEnv)
    eq('skills: read-only root code', readonly.code, 'read-only')
    const noId = await call(skillsDomain, 'skill.toggle', {}, skillEnv)
    eq('skills: missing id code', noId.code, 'unknown-skill')
    const badRead = await call(skillsDomain, 'skill.read', { id: 'user|nope' }, skillEnv)
    eq('skills: read unknown code', badRead.code, 'unknown-skill')
    const noFile = await call(skillsDomain, 'skill.read', { id: 'user|empty-dir' }, skillEnv)
    eq('skills: folder without a skill file code', noFile.code, 'missing-skill-file')
  })

  // ── skills: delete -> trash -> restore ───────────────────────────────────
  await step('skills: delete goes to the trash and comes back', async () => {
    const del = await call(skillsDomain, 'skill.delete', { id: 'user|alpha' }, skillEnv)
    eq('skills: delete ok', del.ok, true)
    truthy('skills: trash item created', await exists(del.trashPath))
    truthy('skills: trash meta written', await exists(join(del.trashPath, 'meta.json')))
    record('skills: skill left its root', !(await exists(join(rootA, 'alpha'))))
    const rows = await call(skillsDomain, 'skill.list', {}, skillEnv)
    record('skills: deleted skill is not listed', !rows.items.some(row => row.name === 'alpha'))
    const list = await call(skillsDomain, 'skill.trash', {}, skillEnv)
    eq('skills: trash lists one item', list.items.length, 1)
    eq('skills: trash item name', list.items[0].name, 'alpha')
    const restored = await call(skillsDomain, 'skill.restore', { trashPath: del.trashPath }, skillEnv)
    eq('skills: restore ok', restored.ok, true)
    eq('skills: restore target id', restored.restored, 'user|alpha')
    record('skills: restore puts the .disabled file back', await exists(join(rootA, 'alpha', 'SKILL.md.disabled')))
    const again = await call(skillsDomain, 'skill.restore', { trashPath: del.trashPath }, skillEnv)
    eq('skills: second restore is bad-trash', again.code, 'bad-trash')
    const outside = await call(skillsDomain, 'skill.restore', { trashPath: join(work, 'nowhere') }, skillEnv)
    eq('skills: restore outside trash refused', outside.code, 'bad-trash')
  })

  // ── skills: import guardrails ────────────────────────────────────────────
  await step('skills: import from a directory, then refuse to overwrite', async () => {
    const source = join(work, 'bundle')
    await mkdir(join(source, 'delta'), { recursive: true })
    await writeFile(join(source, 'delta', 'SKILL.md'), skillFile('delta', 'imported skill'))
    const first = await call(skillsDomain, 'skill.import', { path: source, targetId: 'user' }, skillEnv)
    eq('skills: import added', first.added, ['delta'])
    truthy('skills: imported file on disk', await exists(join(rootA, 'delta', 'SKILL.md')))
    const second = await call(skillsDomain, 'skill.import', { path: source, targetId: 'user' }, skillEnv)
    eq('skills: second import skipped', second.skipped, [{ name: 'delta', reason: 'exists' }])
    const overwrite = await call(skillsDomain, 'skill.import', { path: source, targetId: 'user', overwrite: true }, skillEnv)
    eq('skills: overwrite import added', overwrite.added, ['delta'])
  })

  await step('skills: import guardrails refuse a traversal zip and a bad name', async () => {
    const zipPath = join(work, 'evil.zip')
    await writeFile(zipPath, makeZip([{ name: '../evil/SKILL.md', data: skillFile('evil', 'escape') }]))
    const evil = await call(skillsDomain, 'skill.import', { path: zipPath, targetId: 'user' }, skillEnv)
    eq('skills: traversal zip refused', evil.code, 'unsafe-entry')
    record('skills: nothing escaped the root', !(await exists(join(work, 'evil'))))

    const goodZip = join(work, 'good.zip')
    await writeFile(goodZip, makeZip([{ name: 'SKILL.md', data: skillFile('zipped', 'from a zip') }]))
    const good = await call(skillsDomain, 'skill.import', { path: goodZip, targetId: 'root2' }, skillEnv)
    eq('skills: zip import added', good.added, ['zipped'])
    truthy('skills: zip skill landed under root2', await exists(join(rootB, 'zipped', 'SKILL.md')))

    const bundle = await skills.inspectSource(join(work, 'bundle'))
    eq('skills: inspectSource kind', bundle.kind, 'dir')
    const installed = await skills.installSkills(
      [{ name: 'Bad Name!', description: '', files: new Map([['SKILL.md', Buffer.from(skillFile('x', 'y'))]]) }],
      join(work, 'invalid-target'),
    )
    eq('skills: bad name skipped', installed.skipped[0].reason, 'invalid')
    const missing = await skills.installSkills([{ name: 'nofile', description: '', files: new Map() }], join(work, 'invalid-target'))
    eq('skills: missing SKILL.md skipped', missing.skipped[0].reason, 'invalid')
  })

  await step('skills: move between roots, refuse a duplicate move', async () => {
    const moved = await call(skillsDomain, 'skill.move', { id: 'user|delta', targetId: 'root2' }, skillEnv)
    eq('skills: move ok', moved.ok, true)
    record('skills: moved folder left the source root', !(await exists(join(rootA, 'delta'))))
    truthy('skills: moved folder is in the target root', await exists(join(rootB, 'delta', 'SKILL.md')))
    const same = await call(skillsDomain, 'skill.move', { id: 'root2|delta', targetId: 'root2' }, skillEnv)
    eq('skills: same-root move refused', same.code, 'exists')
    const unknownRoot = await call(skillsDomain, 'skill.move', { id: 'root2|delta', targetId: 'nope' }, skillEnv)
    eq('skills: unknown root code', unknownRoot.code, 'unknown-root')
    const readonlyTarget = await call(skillsDomain, 'skill.move', { id: 'root2|delta', targetId: 'root3' }, skillEnv)
    eq('skills: read-only target code', readonlyTarget.code, 'read-only')
  })

  // ── mcp: parse and byte fidelity ─────────────────────────────────────────
  const patchPath = join(profile, 'cordis.patch.yml')
  const mcpEnv = () => makeEnv({ profileContext: { dir: profile } })

  await step('mcp: parse finds every row and keeps its shape', async () => {
    await writeFile(patchPath, PATCH, 'utf8')
    const rows = mcp.parseMcpRows(PATCH)
    eq('mcp: three MCP rows', rows.map(row => row.id), ['tool-hub-mcp-alpha', 'tool-hub-mcp-beta', 'tool-hub-mcp-legacy'])
    eq('mcp: alpha serverName', rows[0].config.serverName, 'alpha')
    eq('mcp: alpha args parsed', rows[0].config.args, ['-y', 'alpha-server'])
    eq('mcp: alpha disabled', rows[0].disabled, true)
    eq('mcp: beta has empty config', rows[1].config, {})
    eq('mcp: legacy has no config block', rows[2].configStart, -1)
    eq('mcp: unrelated row ignored', mcp.parseMcpRows(PATCH).length, 3)
  })

  await step('mcp: list masks secrets and flags what cannot be edited', async () => {
    const res = await call(mcpDomain, 'mcp.list', {}, mcpEnv())
    eq('mcp: list ok', res.ok, true)
    eq('mcp: patch path', res.patchPath, patchPath)
    eq('mcp: three rows listed', res.count, 3)
    const alpha = res.rows.find(row => row.patchId === 'tool-hub-mcp-alpha')
    eq('mcp: secret value masked', alpha.config.env.TOKEN, '')
    eq('mcp: secret key reported', alpha.secretKeys.env, ['TOKEN'])
    eq('mcp: alpha editable', alpha.editable, true)
    const legacy = res.rows.find(row => row.patchId === 'tool-hub-mcp-legacy')
    eq('mcp: legacy not editable', legacy.editable, false)
  })

  await step('mcp: save rewrites the target block only', async () => {
    const env = mcpEnv()
    const before = await readFile(patchPath, 'utf8')
    const res = await call(mcpDomain, 'mcp.save', { id: 'tool-hub-mcp-alpha', config: { url: 'http://127.0.0.1:9/mcp' } }, env)
    eq('mcp: save ok', res.ok, true)
    eq('mcp: save route', res.route, 'hmr')
    const after = await readFile(patchPath, 'utf8')
    record('mcp: file actually changed', before !== after)
    const row = mcp.parseMcpRows(before)[0]
    const start = row.configStart - 1
    const prefix = before.split('\n').slice(0, start).join('\n')
    const suffix = before.split('\n').slice(row.configEnd).join('\n')
    record('mcp: everything before the config block is byte-identical', after.startsWith(prefix), 'prefix ' + start + ' lines')
    record('mcp: everything after the config block is byte-identical', after.endsWith(suffix))
    const beta = mcp.parseMcpRows(before)[1]
    const betaText = before.split('\n').slice(beta.startLine, beta.endLine).join('\n')
    record('mcp: the other MCP row is byte-identical', after.includes(betaText))
    const bridge = '- id: model-bridge\n  name: "@deepseek-ai/dsh-model-bridge"\n  config:\n    model: gpt-5'
    record('mcp: a non-MCP row is byte-identical', after.includes(bridge))
    const written = mcp.parseMcpRows(after)[0]
    eq('mcp: saved url landed', written.config.url, 'http://127.0.0.1:9/mcp')
    eq('mcp: untouched key kept', written.config.serverName, 'alpha')
    eq('mcp: disabled flag kept', written.disabled, true)
    eq('mcp: save reports a backup', (await exists(res.backup)), true)
  })

  await step('mcp: backup keeps the pre-write bytes', async () => {
    const env = mcpEnv()
    await writeFile(patchPath, PATCH, 'utf8')
    const res = await call(mcpDomain, 'mcp.save', { id: 'tool-hub-mcp-beta', config: { serverName: 'beta' } }, env)
    eq('mcp: beta save ok', res.ok, true)
    eq('mcp: backup content is the previous text', await readFile(res.backup, 'utf8'), PATCH)
    const backups = await readdir(join(home, 'backups'))
    truthy('mcp: backup landed under <dshHome>/backups', backups.some(name => name.startsWith('cordis.patch.yml-')))
    eq('mcp: state bookkeeping went through env.save', env.saves, ['mcp-write'])
    eq('mcp: state.modules.mcp.op', env.state.modules.mcp.op, 'save')
  })

  await step('mcp: refusals are structured', async () => {
    await writeFile(patchPath, PATCH, 'utf8')
    const unknown = await call(mcpDomain, 'mcp.save', { id: 'tool-hub-mcp-nope', config: {} }, mcpEnv())
    eq('mcp: unknown id code', unknown.code, 'unknown-mcp')
    eq('mcp: unknown id ok', unknown.ok, false)
    const readonly = await call(mcpDomain, 'mcp.save', { id: 'tool-hub-mcp-legacy', config: { command: 'x' } }, mcpEnv())
    eq('mcp: read-only row code', readonly.code, 'read-only')
    const badId = await call(mcpDomain, 'mcp.save', { id: 'bad id!!', config: {} }, mcpEnv())
    eq('mcp: bad id code', badId.code, 'bad-id')
    const badConfig = await call(mcpDomain, 'mcp.save', { id: 'tool-hub-mcp-alpha' }, mcpEnv())
    eq('mcp: bad config code', badConfig.code, 'bad-config')
    const noPatch = await call(mcpDomain, 'mcp.save', { id: 'x', config: {} }, makeEnv({}))
    eq('mcp: missing profile code', noPatch.code, 'no-patch')
  })

  await step('mcp: duplicate ids write the requested occurrence only', async () => {
    const duplicate = [
      '- insert:',
      '  - id: dup-mcp',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: first',
      '  - id: dup-mcp',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: second',
    ].join('\n') + '\n'
    await writeFile(patchPath, duplicate, 'utf8')
    const res = await call(mcpDomain, 'mcp.save', { id: 'dup-mcp', occurrence: 1, config: { serverName: 'second-changed' } }, mcpEnv())
    eq('mcp: duplicate save ok', res.ok, true)
    const rows = mcp.parseMcpRows(await readFile(patchPath, 'utf8'))
    eq('mcp: duplicate first untouched', rows[0].config.serverName, 'first')
    eq('mcp: duplicate second changed', rows[1].config.serverName, 'second-changed')
  })

  await step('mcp: host verification selects the requested duplicate occurrence', async () => {
    const duplicate = [
      '- insert:',
      '  - id: dup-mcp',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: first',
      '  - id: dup-mcp',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: second',
    ].join('\n') + '\n'
    await writeFile(patchPath, duplicate, 'utf8')
    const host = pluginManager([
      { entryId: 'loader-first', patchId: 'dup-mcp', name: 'first', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true },
      { entryId: 'loader-second', patchId: 'dup-mcp', name: 'second-changed', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true },
    ])
    const res = await call(mcpDomain, 'mcp.save', { id: 'dup-mcp', occurrence: 1, config: { serverName: 'second-changed' } }, makeEnv({ profileContext: { dir: profile }, pluginManager: host }))
    eq('mcp: host duplicate save ok', res.ok, true)
    const rows = mcp.parseMcpRows(await readFile(patchPath, 'utf8'))
    eq('mcp: host duplicate first untouched', rows[0].config.serverName, 'first')
    eq('mcp: host duplicate second changed', rows[1].config.serverName, 'second-changed')
  })

  await step('mcp: ambiguous duplicate names use the occurrence on the host path', async () => {
    const duplicate = [
      '- insert:',
      '  - id: dup-name',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: same-name',
      '  - id: dup-name',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: same-name',
    ].join('\n') + '\n'
    await writeFile(patchPath, duplicate, 'utf8')
    const host = pluginManager([
      { entryId: 'loader-one', patchId: 'dup-name', name: 'same-name', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true },
      { entryId: 'loader-two', patchId: 'dup-name', name: 'same-name', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true },
    ])
    const res = await call(mcpDomain, 'mcp.save', { id: 'dup-name', occurrence: 1, config: { serverName: 'same-name', url: 'http://second/mcp' } }, makeEnv({ profileContext: { dir: profile }, pluginManager: host }))
    eq('mcp: ambiguous host save ok', res.ok, true)
    const rows = mcp.parseMcpRows(await readFile(patchPath, 'utf8'))
    eq('mcp: ambiguous host second row changed', rows[1].config.url, 'http://second/mcp')
  })

  await step('mcp: a stale duplicate is not rescued by a sibling name', async () => {
    const duplicate = [
      '- insert:',
      '  - id: dup-stale',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: target-name',
      '  - id: dup-stale',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: other-name',
    ].join('\n') + '\n'
    await writeFile(patchPath, duplicate, 'utf8')
    // Only the first sibling is live under the requested name; occurrence 1 was not reloaded.
    const host = pluginManager([
      { entryId: 'loader-one', patchId: 'dup-stale', name: 'target-name', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true },
    ])
    const before = await readFile(patchPath, 'utf8')
    const res = await call(mcpDomain, 'mcp.save', { id: 'dup-stale', occurrence: 1, config: { serverName: 'target-name' } }, makeEnv({ profileContext: { dir: profile }, pluginManager: host }))
    eq('mcp: stale duplicate is refused', res.ok, false)
    eq('mcp: stale duplicate rolled back', await readFile(patchPath, 'utf8'), before)
  })

  await step('mcp: a missing earlier duplicate cannot be verified by a later sibling', async () => {
    const duplicate = [
      '- insert:',
      '  - id: dup-reverse',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: first',
      '  - id: dup-reverse',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: second',
    ].join('\n') + '\n'
    await writeFile(patchPath, duplicate, 'utf8')
    const host = pluginManager([
      { entryId: 'loader-second', patchId: 'dup-reverse', name: 'second', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true },
    ])
    const before = await readFile(patchPath, 'utf8')
    const res = await call(mcpDomain, 'mcp.save', { id: 'dup-reverse', occurrence: 0, config: { serverName: 'first' } }, makeEnv({ profileContext: { dir: profile }, pluginManager: host }))
    eq('mcp: missing earlier duplicate refused', res.ok, false)
    eq('mcp: missing earlier duplicate rolled back', await readFile(patchPath, 'utf8'), before)
  })

  await step('mcp: a managed-block row is read-only for host writes', async () => {
    const managed = [
      '# >>> dsh-skill-mcp-panel:mcp:begin',
      '- insert:',
      '  - id: panel-mcp-owned',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      serverName: owned',
      '# <<< dsh-skill-mcp-panel:mcp:end',
    ].join('\n') + '\n'
    await writeFile(patchPath, managed, 'utf8')
    const res = await call(mcpDomain, 'mcp.save', { id: 'panel-mcp-owned', config: { serverName: 'changed' } }, mcpEnv())
    eq('mcp: managed save refused', res.ok, false)
    eq('mcp: managed save code', res.code, 'read-only')
    const listed = await call(mcpDomain, 'mcp.list', {}, mcpEnv())
    eq('mcp: managed owner visible', listed.rows[0].managedBy, 'dsh-skill-mcp-panel:mcp')
    eq('mcp: managed not editable', listed.rows[0].editable, false)
  })

  await step('mcp: empty state is an empty list', async () => {
    const missing = await call(mcpDomain, 'mcp.list', {}, makeEnv({ profileContext: { dir: join(work, 'no-profile') } }))
    eq('mcp: empty list ok', missing.ok, true)
    eq('mcp: empty list rows', missing.rows, [])
    eq('mcp: empty list count', missing.count, 0)
    const noProfile = await call(mcpDomain, 'mcp.list', {}, makeEnv({}))
    eq('mcp: no profile still lists', noProfile.ok, true)
    eq('mcp: no profile reports why', typeof noProfile.error, 'string')
  })

  await step('mcp: CRLF and a missing final newline survive a write', async () => {
    const crlf = PATCH.replace(/\n/g, '\r\n').replace(/\r\n$/, '')
    await writeFile(patchPath, crlf, 'utf8')
    const res = await call(mcpDomain, 'mcp.save', { id: 'tool-hub-mcp-beta', config: { command: 'node' } }, mcpEnv())
    eq('mcp: crlf save ok', res.ok, true)
    const after = await readFile(patchPath, 'utf8')
    const loneLf = after.split('\n').filter((line, index, all) => index < all.length - 1 && !line.endsWith('\r'))
    eq('mcp: every line keeps CRLF', loneLf, [])
    record('mcp: no final newline was added', !after.endsWith('\r\n') && !after.endsWith('\n'))
    await writeFile(patchPath, PATCH, 'utf8')
  })

  await step('mcp: raw read and raw save keep the rest of the file', async () => {
    await writeFile(patchPath, PATCH, 'utf8')
    const raw = await call(mcpDomain, 'mcp.raw', { id: 'tool-hub-mcp-alpha' }, mcpEnv())
    eq('mcp: raw ok', raw.ok, true)
    record('mcp: raw starts at the id line', raw.text.startsWith('- id: tool-hub-mcp-alpha'))
    record('mcp: raw keeps indentation', raw.text.includes('\n    serverName: alpha'))
    const changedId = await call(mcpDomain, 'mcp.rawSave', { id: 'tool-hub-mcp-alpha', text: raw.text.replace('tool-hub-mcp-alpha', 'other-id') }, mcpEnv())
    eq('mcp: raw id change refused', changedId.code, 'raw-id')
    const stray = await call(mcpDomain, 'mcp.rawSave', { id: 'tool-hub-mcp-alpha', text: raw.text + '\n- id: extra' }, mcpEnv())
    eq('mcp: stray line refused', stray.code, 'raw-invalid')
    const empty = await call(mcpDomain, 'mcp.rawSave', { id: 'tool-hub-mcp-alpha', text: '   ' }, mcpEnv())
    eq('mcp: empty snippet refused', empty.code, 'raw-invalid')
    const renamed = raw.text.replace('serverName: alpha', 'serverName: alpha-renamed')
    const saved = await call(mcpDomain, 'mcp.rawSave', { id: 'tool-hub-mcp-alpha', text: renamed }, mcpEnv())
    eq('mcp: raw save ok', saved.ok, true)
    const after = await readFile(patchPath, 'utf8')
    record('mcp: raw save kept the comment', after.includes('# hand-written profile patch'))
    record('mcp: raw save kept the legacy row', after.includes('- id: tool-hub-mcp-legacy'))
    eq('mcp: raw save wrote the new name', mcp.parseMcpRows(after)[0].config.serverName, 'alpha-renamed')
    await writeFile(patchPath, PATCH, 'utf8')
  })

  await step('mcp: create appends, delete removes, other bytes stay', async () => {
    await writeFile(patchPath, PATCH, 'utf8')
    const created = await call(mcpDomain, 'mcp.create', { config: { serverName: 'new-one', transport: 'stdio', command: 'npx' } }, mcpEnv())
    eq('mcp: create ok', created.ok, true)
    eq('mcp: create id', created.id, 'tool-hub-mcp-new-one')
    const afterCreate = await readFile(patchPath, 'utf8')
    record('mcp: create keeps the old document as a prefix', afterCreate.startsWith(PATCH))
    record('mcp: new row arrives disabled', afterCreate.includes('  disabled: true'))
    const dup = await call(mcpDomain, 'mcp.create', { config: { serverName: 'new-one' } }, mcpEnv())
    eq('mcp: duplicate name refused', dup.code, 'duplicate-mcp')
    const removed = await call(mcpDomain, 'mcp.delete', { id: 'tool-hub-mcp-new-one' }, mcpEnv())
    eq('mcp: delete ok', removed.ok, true)
    eq('mcp: delete restored the original bytes', await readFile(patchPath, 'utf8'), PATCH)
    const unknownDelete = await call(mcpDomain, 'mcp.delete', { id: 'tool-hub-mcp-none' }, mcpEnv())
    eq('mcp: delete unknown code', unknownDelete.code, 'unknown-mcp')
  })

  await step('mcp: a host that never loads the row triggers a rollback', async () => {
    await writeFile(patchPath, PATCH, 'utf8')
    const blind = { async listPlugins() { return [] } }
    const res = await call(mcpDomain, 'mcp.save', { id: 'tool-hub-mcp-alpha', config: { url: 'http://x/mcp' } }, makeEnv({ profileContext: { dir: profile }, pluginManager: blind }))
    eq('mcp: unverified write reports verify', res.code, 'verify')
    eq('mcp: unverified write was rolled back', await readFile(patchPath, 'utf8'), PATCH)
  })

  // ── plugins ──────────────────────────────────────────────────────────────
  const pluginRows = [
    { entryId: 'p-normal', moduleName: 'dsh-demo', meta: { title: 'Demo', description: 'a demo plugin' }, enabled: true, fiberPhase: 'active', patchId: 'p-normal' },
    { entryId: 'p-bundled', moduleName: '@deepseek-ai/dsh-ui-thing', meta: { title: 'UI thing' }, enabled: true, readOnlyReason: 'ships in the client bundle', surface: 'ui' },
    { entryId: 'p-self', moduleName: 'dsh-tool-hub', meta: { title: 'Tool hub' }, enabled: true },
    { entryId: 'p-mcp', moduleName: '@deepseek-ai/dsh-mcp-client', meta: { title: 'alpha' }, enabled: true, patchId: 'tool-hub-mcp-alpha' },
  ]

  await step('plugins: list maps the loader rows', async () => {
    plugins.invalidatePluginCache()
    const env = makeEnv({ pluginManager: pluginManager(pluginRows) })
    const res = await call(pluginsDomain, 'plugin.list', {}, env)
    eq('plugins: list ok', res.ok, true)
    eq('plugins: four rows', res.rows.map(row => row.id), ['p-normal', 'p-bundled', 'p-self', 'p-mcp'])
    const normal = res.rows[0]
    eq('plugins: description source', normal.descriptionSource, 'meta')
    eq('plugins: manageable', normal.manageable, true)
    eq('plugins: self flag', res.rows[2].self, true)
    eq('plugins: mcp flag', res.rows[3].mcp, true)
    eq('plugins: builtin ui flag', res.rows[1].builtinUi, true)
    eq('plugins: bundles error is named', res.bundlesError, 'this host has no pluginManager.listBundles')
  })

  await step('plugins: read-only, self and unknown rows are refused', async () => {
    const env = makeEnv({ pluginManager: pluginManager(pluginRows) })
    const readonly = await call(pluginsDomain, 'toggle', { kind: 'plugin', id: 'p-bundled', enabled: false }, env)
    eq('plugins: read-only row code', readonly.code, 'read-only')
    eq('plugins: read-only row ok', readonly.ok, false)
    const self = await call(pluginsDomain, 'toggle', { kind: 'plugin', id: 'p-self', enabled: false }, env)
    eq('plugins: self protection code', self.code, 'self-protected')
    const unknown = await call(pluginsDomain, 'toggle', { kind: 'plugin', id: 'p-nope', enabled: false }, env)
    eq('plugins: unknown row code', unknown.code, 'unknown-plugin')
    const badKind = await call(pluginsDomain, 'toggle', { kind: 'nope', id: 'p-normal', enabled: true }, env)
    eq('plugins: bad kind code', badKind.code, 'bad-kind')
    const badPayload = await call(pluginsDomain, 'toggle', {}, env)
    eq('plugins: bad payload code', badPayload.code, 'bad-payload')
    plugins.invalidatePluginCache()
    const noManager = await call(pluginsDomain, 'plugin.list', {}, makeEnv({}))
    eq('plugins: no manager code', noManager.code, 'no-plugin-manager')
  })

  await step('plugins: toggle delegates to the manager, bulk delegates to skills', async () => {
    plugins.invalidatePluginCache()
    const manager = pluginManager(pluginRows)
    const env = makeEnv({ pluginManager: manager })
    const on = await call(pluginsDomain, 'toggle', { kind: 'plugin', id: 'p-normal', enabled: true }, env)
    eq('plugins: toggle ok', on.ok, true)
    eq('plugins: toggle application', on.application, 'applied')
    eq('plugins: manager was called', manager.calls, [{ id: 'p-normal', enabled: true }])

    const empty = await call(pluginsDomain, 'bulk', { items: [], enabled: false }, env)
    eq('plugins: empty bulk ok', empty.ok, true)
    eq('plugins: empty bulk results', empty.results, [])
    eq('plugins: empty bulk changed', empty.changed, 0)

    const mixed = await call(pluginsDomain, 'bulk', { items: [{ kind: 'plugin', id: 'p-bundled' }, { kind: 'plugin', id: 'p-normal' }, { kind: 'skill', id: 'root2|gamma' }], enabled: false }, env)
    eq('plugins: bulk ok', mixed.ok, true)
    eq('plugins: bulk changed', mixed.changed, 2)
    eq('plugins: bulk skipped the unwritable row', mixed.skippedBuiltin, 1)
    eq('plugins: bulk answered every writable member', mixed.results.length, 2)
    truthy('plugins: bulk turned gamma off through skills.ts', await exists(join(rootB, 'gamma', 'SKILL.md.disabled')))
    record('plugins: gamma SKILL.md is gone', !(await exists(join(rootB, 'gamma', 'SKILL.md'))))
    const badMember = await call(pluginsDomain, 'bulk', { items: [{ id: 'x' }], enabled: true }, env)
    eq('plugins: non-member reported', badMember.results[0].code, 'not-a-member')
    const bundles = await call(pluginsDomain, 'plugin.bundles', {}, env)
    eq('plugins: bundles ok', bundles.ok, true)
    eq('plugins: bundles rows empty', bundles.rows, [])
    eq('plugins: bundles error named', bundles.error, 'this host has no pluginManager.listBundles')
  })

  await rm(work, { recursive: true, force: true })

  console.log('')
  console.log(passed + ' passed, ' + failures.length + ' failed')
  if (failures.length > 0) {
    for (const failure of failures) console.log('  - ' + failure)
    process.exitCode = 1
  }
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  }
  catch {
    try {
      await readdir(path)
      return true
    }
    catch {
      return false
    }
  }
}

main().catch(error => {
  console.log('FAIL  probe crashed: ' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
})