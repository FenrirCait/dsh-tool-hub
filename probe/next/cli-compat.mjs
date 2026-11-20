#!/usr/bin/env node
/**
 * The 1.x CLI must keep working against a 2.0 state file.
 *
 * The 2.0 host writes version 2 with extra keys (settings, modules, legacy keys kept). The
 * CLI is still shipped for headless owners, so this probe drives it against a v2 fixture and
 * checks it neither loses the new keys nor rewrites the old ones.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CLI = join(ROOT, 'bin', 'dsh-tool-hub.mjs')
let checks = 0
const failures = []
function check(name, ok, detail) {
  checks += 1
  if (!ok) failures.push(detail === undefined ? name : name + ' — ' + detail)
}

const home = await mkdtemp(join(tmpdir(), 'tool-hub-cli-'))
const stateFile = join(home, 'tool-hub', 'state.json')
await mkdir(join(home, 'tool-hub'), { recursive: true })
const seed = {
  version: 2,
  groups: [{ id: 'g1', name: 'Demo group', members: [], collection: 'default' }],
  collections: [{ id: 'default', name: 'Default', order: 0 }],
  presets: [{ name: 'p1', enabled: { plugin: ['a'], skill: [], tool: [] }, deny: [] }],
  toolDeny: ['mcp__alpha__one'],
  auto: null,
  sessions: {},
  scenes: { demo: { version: 1, name: 'demo', tools: { deny: ['mcp__alpha__two'] }, mcp: { off: [], on: [] } } },
  mode: null,
  settings: { 'plugins.skipBuiltinUi': false, 'mcp.backupKeep': 30 },
  modules: { 'tool-surface': { lazy: [] } },
  legacyKey: 'keep-me',
}
await writeFile(stateFile, JSON.stringify(seed, null, 2) + '\n')

function run(args) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, DSH_HOME: home }, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1), stdout, stderr })
    })
  })
}
const read = async () => JSON.parse(await readFile(stateFile, 'utf8'))

try {
  const help = await run(['--help'])
  check('help exits 0', help.code === 0, 'exit ' + help.code)
  check('help documents scene', /scene\s+list/.test(help.stdout), help.stdout.slice(0, 80))

  const list = await run(['scene', 'list'])
  check('scene list reads a v2 state', list.code === 0 && /demo/.test(list.stdout), 'exit ' + list.code + ' ' + list.stderr.slice(0, 80))

  const save = await run(['scene', 'save', 'demo2', '--tools-deny', 'mcp__alpha__two'])
  const afterSave = await read()
  check('scene save exits 0', save.code === 0, save.stderr.slice(0, 120))
  check('scene save adds the scene', afterSave.scenes !== undefined && afterSave.scenes.demo2 !== undefined)
  check('scene save keeps v2 settings', afterSave.settings?.['mcp.backupKeep'] === 30)
  check('scene save keeps the module block', afterSave.modules?.['tool-surface'] !== undefined)
  check('scene save keeps an unknown legacy key', afterSave.legacyKey === 'keep-me')
  check('scene save keeps the version', afterSave.version === 2)

  const apply = await run(['scene', 'apply', 'demo', '--force'])
  const afterApply = await read()
  check('scene apply exits 0', apply.code === 0, apply.stderr.slice(0, 120))
  check('scene apply records the mode', afterApply.mode !== null && afterApply.mode.name === 'demo')
  check('scene apply writes the scene deny list', JSON.stringify(afterApply.toolDeny) === JSON.stringify(['mcp__alpha__two']))
  check('scene apply keeps groups', afterApply.groups?.[0]?.id === 'g1')

  const exit = await run(['scene', 'exit'])
  const afterExit = await read()
  check('scene exit exits 0', exit.code === 0, exit.stderr.slice(0, 120))
  check('scene exit clears the mode', afterExit.mode === null)
  check('scene exit restores the deny list', JSON.stringify(afterExit.toolDeny) === JSON.stringify(['mcp__alpha__one']))
  check('scene exit keeps presets', afterExit.presets?.[0]?.name === 'p1' && afterExit.presets.length === 1)
}
finally {
  await rm(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('cli-compat probe: ' + failures.length + ' failed of ' + checks)
  for (const failure of failures) console.error('  FAIL ' + failure)
  process.exit(1)
}
console.log('cli-compat probe: ' + checks + ' checks passed')
