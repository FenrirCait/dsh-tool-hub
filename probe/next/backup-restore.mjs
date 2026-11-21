#!/usr/bin/env node
/**
 * backup MCP restore: index the patch backups, diff one row, put the old one back verbatim, and
 * refuse anything that would move a row or touch another one.
 *
 * The probe runs entirely in a temp DSH_HOME; no real patch or backup is touched. It loads the
 * built host (or a copy when TOOL_HUB_DIST points at one).
 */
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'hub-restore-'))
const home = join(root, 'home')
const profile = join(root, 'profile')
const stateBackups = join(root, 'backups')
const patchBackups = join(home, 'backups')
await mkdir(patchBackups, { recursive: true })
await mkdir(stateBackups, { recursive: true })
await mkdir(profile, { recursive: true })
process.env.DSH_HOME = home
process.env.TOOL_HUB_STATE_FILE = join(root, 'state.json')

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const { backupsDomain } = await import(pathToFileURL(join(distRoot, 'domains', 'backups.js')).href)
const domain = backupsDomain()
const handlers = domain.handlers
const patchPath = join(profile, 'cordis.patch.yml')

let pass = 0
let fail = 0
function check(name, run) {
  return Promise.resolve().then(run)
    .then(detail => { pass += 1; console.log('PASS ' + name + (detail === undefined ? '' : '  ' + detail)) })
    .catch(error => { fail += 1; console.log('FAIL ' + name + '  ' + (error && error.message ? error.message : String(error))) })
}
function assert(condition, message) { if (!condition) throw new Error(message) }
async function refusal(promise) {
  try { await promise; return null }
  catch (error) { return error }
}
function equal(actual, expected, label) {
  const left = JSON.stringify(actual); const right = JSON.stringify(expected)
  if (left !== right) throw new Error((label ?? 'expected') + ' ' + right + ', got ' + left)
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const BRIDGE = [
  '- id: model-bridge',
  '  name: "@deepseek-ai/dsh-model-bridge"',
  '  config:',
  '    model: gpt-5',
]
const ALPHA_NEW = [
  '- id: alpha',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config:',
  '    serverName: alpha',
  '    transport: stdio',
  '    command: node',
  '    args:',
  '      - new-server',
  '    env:',
  '      TOKEN: new',
]
const ALPHA_OLD = [
  '- id: alpha',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config:',
  '    serverName: alpha',
  '    transport: stdio',
  '    command: node',
  '    args:',
  '      - old-server',
  '    env:',
  '      TOKEN: old',
  '  disabled: true',
]
const ALPHA_INDENTED = [
  '  - id: alpha',
  '    name: "@deepseek-ai/dsh-mcp-client"',
  '    config:',
  '      serverName: alpha',
  '      command: node',
]
const BETA_LIVE = [
  '- id: beta',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config:',
  '    serverName: beta',
  '    command: node',
  '    args:',
  '      - beta-live',
]
const BETA_OLD = [
  '- id: beta',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config:',
  '    serverName: beta',
  '    command: node',
  '    args:',
  '      - beta-old',
]
const LIVE = ['# live profile patch', ...BRIDGE, '', ...ALPHA_NEW, '', ...BETA_LIVE, '', '# trailing comment', ''].join('\n')
const RESTORED = ['# live profile patch', ...BRIDGE, '', ...ALPHA_OLD, '', ...BETA_LIVE, '', '# trailing comment', ''].join('\n')
const NEW_BACKUP = ['# backup new', ...ALPHA_NEW, '', ...BETA_LIVE, ''].join('\n')
const OLD_BACKUP = ['# backup old', ...ALPHA_OLD, '', ...BETA_OLD, '', ...ALPHA_OLD, ''].join('\n')
const INDENT_BACKUP = ['# indented backup', ...ALPHA_INDENTED, ''].join('\n')
const NEW_NAME = 'cordis.patch.yml-2026-01-03T00-00-00-000Z-1000.bak'
const OLD_NAME = 'cordis.patch.yml-2026-01-02T00-00-00-000Z-1000.bak'
const INDENT_NAME = 'cordis.patch.yml-2026-01-01T00-00-00-000Z-1000.bak'
const STATE_NAME = 'state-2026-01-01T00-00-00-000Z-1000.json'

async function makeBackup(dir, name, text, ageMinutes) {
  const path = join(dir, name)
  await writeFile(path, text, 'utf8')
  const at = new Date(Date.now() - ageMinutes * 60 * 1000)
  await utimes(path, at, at)
}
await writeFile(patchPath, LIVE, 'utf8')
await makeBackup(patchBackups, NEW_NAME, NEW_BACKUP, 1)
await makeBackup(patchBackups, OLD_NAME, OLD_BACKUP, 2)
await makeBackup(patchBackups, INDENT_NAME, INDENT_BACKUP, 3)
await makeBackup(stateBackups, STATE_NAME, JSON.stringify({ version: 2 }), 4)

function makeEnv() {
  const saves = []
  return {
    state: { version: 2, modules: {}, settings: {} },
    services: { get: name => (name === 'profileContext' ? { dir: profile } : undefined) },
    save: async reason => { saves.push(reason); return null },
    log: () => {},
    now: () => Date.now(),
    saves,
  }
}

try {
  await check('ops: mcpIndex and diff are read-only, restoreRow is write+audit', () => {
    const ops = Object.fromEntries(domain.module.ops.map(op => [op.id, op]))
    assert(ops['backup.mcpIndex'].write === false && ops['backup.mcpIndex'].audit === false, 'index flags')
    assert(ops['backup.diff'].write === false && ops['backup.diff'].audit === false, 'diff flags')
    assert(ops['backup.restoreRow'].write === true && ops['backup.restoreRow'].audit === true, 'restore flags')
    return Object.keys(ops).length + ' ops'
  })

  await check('index: newest first, MCP backups only, ids deduped', async () => {
    const result = await handlers['backup.mcpIndex']({}, makeEnv())
    equal(result.backups.map(entry => entry.name), [NEW_NAME, OLD_NAME, INDENT_NAME])
    equal(result.backups.map(entry => entry.ids), [['alpha', 'beta'], ['alpha', 'beta'], ['alpha']])
    assert(result.backups.every(entry => entry.kind === 'patch'), 'kinds')
    equal(result.backups[0].bytes, Buffer.byteLength(NEW_BACKUP))
    assert(result.backups.every(entry => typeof entry.modifiedAt === 'number'), 'modifiedAt')
    return result.backups.length + ' backups'
  })

  await check('diff: reports the changed row lines', async () => {
    const result = await handlers['backup.diff']({ backup: OLD_NAME, id: 'alpha' }, makeEnv())
    assert(result.changed === true, 'changed')
    equal(result.backup, OLD_NAME)
    equal(result.id, 'alpha')
    equal(result.before.split('\n')[0], ALPHA_OLD[0])
    equal(result.after.split('\n')[0], ALPHA_NEW[0])
    const adds = result.lines.filter(line => line.kind === 'add').map(line => line.text)
    const dels = result.lines.filter(line => line.kind === 'del').map(line => line.text)
    assert(adds.includes('      - new-server'), 'added line')
    assert(dels.includes('      - old-server') && dels.includes('  disabled: true'), 'deleted lines')
    assert(result.lines.some(line => line.kind === 'same' && line.text.includes('serverName: alpha')), 'same line')
    const identical = await handlers['backup.diff']({ backup: NEW_NAME, id: 'alpha' }, makeEnv())
    equal(identical.changed, false)
    assert(identical.lines.every(line => line.kind === 'same'), 'unchanged lines')
    return result.lines.length + ' diff lines'
  })

  await check('diff: unknown backup and unknown row are refused', async () => {
    const missing = await refusal(handlers['backup.diff']({ backup: 'nope.bak', id: 'alpha' }, makeEnv()))
    equal(missing && missing.code, 'unknown-backup')
    const ghost = await refusal(handlers['backup.diff']({ backup: OLD_NAME, id: 'ghost' }, makeEnv()))
    equal(ghost && ghost.code, 'unknown-mcp')
  })

  await check('restore: writes the backup row back verbatim, with a backup and a verify', async () => {
    const beforeRestore = await readFile(patchPath, 'utf8')
    const env = makeEnv()
    const result = await handlers['backup.restoreRow']({ backup: OLD_NAME, id: 'alpha' }, env)
    equal(result.ok, true)
    equal(result.id, 'alpha')
    equal(result.backup, OLD_NAME)
    equal(result.verify.ok, true)
    const after = await readFile(patchPath, 'utf8')
    equal(after, RESTORED)
    assert(after.includes(ALPHA_OLD.join('\n')), 'old row bytes')
    equal(env.saves, ['mcp-write'])
    equal(env.state.modules.mcp.op, 'restoreRow')
    const files = await readdir(patchBackups)
    const fresh = files.filter(name => name.endsWith('.bak') && name !== NEW_NAME && name !== OLD_NAME && name !== INDENT_NAME)
    equal(fresh.length, 1)
    equal(await readFile(join(patchBackups, fresh[0]), 'utf8'), beforeRestore)
    return fresh[0]
  })

  await check('restore: every other row and byte survives', async () => {
    const after = await readFile(patchPath, 'utf8')
    assert(after.includes(BRIDGE.join('\n')), 'non-MCP row')
    assert(after.includes(BETA_LIVE.join('\n')), 'sibling MCP row')
    assert(after.includes('# live profile patch') && after.includes('# trailing comment'), 'comments')
    assert(!after.includes('beta-old'), 'the backup sibling row was not used')
    assert(after.startsWith('# live profile patch\n- id: model-bridge'), 'prefix')
    const lines = after.split('\n')
    const betaStart = lines.indexOf('- id: beta')
    equal(lines.slice(betaStart, betaStart + BETA_LIVE.length), BETA_LIVE)
  })

  await check('restore: unknown backup and unknown row are refused', async () => {
    const missing = await refusal(handlers['backup.restoreRow']({ backup: 'nope.bak', id: 'alpha' }, makeEnv()))
    equal(missing && missing.code, 'unknown-backup')
    const ghost = await refusal(handlers['backup.restoreRow']({ backup: OLD_NAME, id: 'ghost' }, makeEnv()))
    equal(ghost && ghost.code, 'unknown-mcp')
  })

  await check('restore: a different indent is refused and the file is untouched', async () => {
    const before = await readFile(patchPath, 'utf8')
    const error = await refusal(handlers['backup.restoreRow']({ backup: INDENT_NAME, id: 'alpha' }, makeEnv()))
    equal(error && error.code, 'indent')
    equal(await readFile(patchPath, 'utf8'), before)
  })
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log('\nbackup-restore probe: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
