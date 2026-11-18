#!/usr/bin/env node
/**
 * End-to-end smoke test for `bin/dsh-tool-hub.mjs`.
 *
 * Everything runs against a throwaway `DSH_HOME` (and a throwaway `USERPROFILE`,
 * so `~/.agents/skills` is inside the sandbox too): the real profiles, the real
 * state file and the real skills are never touched. The CLI is spawned with
 * `execFileSync`, exactly as a user or a script would.
 *
 * What it proves, per command:
 *   - the exit code contract: 0 success, 1 usage, 2 not found, 3 validation;
 *   - an edit changes the targeted row only — every other line is compared
 *     byte for byte against the fixture, so a stray re-serialization shows up;
 *   - writes leave a backup in `<dshHome>/backups/` and land through a rename;
 *   - `--profile desktop` is refused before anything is written;
 *   - a `--set` file is validated (one row, MCP module, id unchanged) and is
 *     re-indented into the target row's own indentation.
 *
 * Run: node probe/cli-smoke.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { parseRows, removeRow, setRowDisabled } from '../lib/patch-rows.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = join(ROOT, 'bin', 'dsh-tool-hub.mjs')

const home = join(tmpdir(), `tool-hub-cli-smoke-${Date.now()}-${process.pid}`)
const workspace = join(home, 'workspace')
const scratch = join(home, 'scratch')

// ── fixture ──────────────────────────────────────────────────────────────────

/**
 * The patch fixture. It mixes everything a real profile file carries: rows
 * nested under `- insert:`, rows at the top level, a comment between rows, an
 * empty `- insert:`, quoted names in both styles, `!!js`, a `#` inside quotes,
 * a blank line and a trailing comment.
 */
const PATCH_LINES = [
  '# managed by dsh-tool-hub cli-smoke — do not edit by hand', // 0
  '- insert:', // 1
  '    - id: ui-theme', // 2
  "      name: 'dsh-ui-theme'", // 3
  '      config:', // 4
  '        scheme: dark', // 5
  '    # a comment between rows, quoted: "keep me"', // 6
  '    - id: panel-mcp-illustrator', // 7
  '      name: "dsh-panel-mcp-illustrator"', // 8
  '      config:', // 9
  '        serverName: illustrator', // 10
  '        transport: stdio', // 11
  '        command: node', // 12
  '      disabled: true', // 13
  '- id: top-row', // 14
  '  name: dsh-top-row', // 15
  '  config:', // 16
  "    expression: !!js process.env.TOOL_HUB_SMOKE === '1'", // 17
  "    note: 'value with # hash and: colon'", // 18
  '', // 19
  '# trailing comment, stays', // 20
  '- insert:', // 21
  '- id: mcp-alpha', // 22
  "  name: '@deepseek-ai/dsh-mcp-client'", // 23
  '  config:', // 24
  '    serverName: alpha', // 25
  '    transport: stdio', // 26
  '    command: node', // 27
  '    args:', // 28
  '      - alpha.js', // 29
  "  note: 'alpha server'", // 30
  '- id: mcp-beta', // 31
  "  name: '@deepseek-ai/dsh-mcp-client'", // 32
  '  config:', // 33
  '    serverName: beta', // 34
  '    transport: http', // 35
  '    url: http://127.0.0.1:9999/mcp', // 36
  '  disabled: true', // 37
  '', // 38
]
const PATCH = `${PATCH_LINES.join('\n')}\n`
const AT = line => PATCH_LINES.indexOf(line)
/** The comment that sits between two rows, at the list level: it must survive every edit. */
const BETWEEN = '    # a comment between rows, quoted: "keep me"'
const lineIndex = (text, line) => text.split('\n').indexOf(line)

const DESKTOP_SENTINEL = '# the desktop app owns this file\n- id: does-not-matter\n'
const CRLF_LINES = [
  '- insert:',
  '    - id: crlf-theme',
  "      name: 'dsh-crlf-theme'",
  '      config:',
  '        scheme: light',
  '- id: crlf-top',
  '  name: dsh-crlf-top',
  '  config:',
  '    serverName: crlf',
]
const CRLF_PATCH = `${CRLF_LINES.join('\r\n')}\r\n`

const STATE = {
  version: 1,
  groups: [
    {
      id: 'g1',
      name: '主题组',
      members: [
        { kind: 'plugin', id: 'include:ui-theme' },
        { kind: 'plugin', id: 'top-row' },
        { kind: 'skill', id: 'user|smoke-skill' },
      ],
      collection: 'default',
      createdAt: 1,
    },
    {
      id: 'g2',
      name: 'MCP组',
      members: [
        { kind: 'plugin', id: 'mcp-alpha' },
        { kind: 'plugin', id: 'gone-row' },
        { kind: 'skill', id: 'user|off-skill' },
      ],
      collection: 'default',
      createdAt: 2,
    },
  ],
  collections: [
    { id: 'default', name: '默认分组群', order: 0 },
    { id: 'custom', name: '自定义', order: 1 },
  ],
  presets: [
    { name: 'only-theme', enabled: { plugin: ['include:ui-theme'], skill: ['user|smoke-skill'] }, note: 'keep the theme' },
    { name: 'legacy-flat', enabled: ['top-row'], note: 'old shape' },
  ],
  toolDeny: ['shell_exec'],
  auto: { appliedAt: 1700000000000 },
  panelOnlyKey: { kept: true },
}

const SKILLS = [
  { root: 'skills', rel: 'smoke-skill', name: 'smoke-skill', enabled: true },
  { root: 'skills', rel: 'off-skill', name: 'off-skill', enabled: false },
  { root: 'skills', rel: 'temp-skill', name: 'temp-skill', enabled: true },
  { root: 'skills', rel: 'nested/group/inner-skill', name: 'inner-skill', enabled: true },
  { root: '.agents/skills', rel: 'agent-skill', name: 'agent-skill', enabled: true },
  { root: 'workspace/.dsh/skills', rel: 'ws-skill', name: 'ws-skill', enabled: true },
]

// ── harness ──────────────────────────────────────────────────────────────────

const results = []
const trace = []

function check(name, ok, detail = '') {
  const passed = ok === true
  results.push({ name, ok: passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed || detail === '' ? '' : `  ← ${detail}`}`)
  return passed
}

function clip(value, limit = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

const childEnv = { ...process.env, DSH_HOME: home, USERPROFILE: home, HOME: home }

/** Run the CLI; `expected` is the exit code the contract promises. */
function run(args, expected = 0) {
  trace.push(`dsh-tool-hub ${args.join(' ')}`)
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: childEnv,
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (expected !== 0) throw new Error(`expected exit ${expected}, got 0 (stdout: ${clip(stdout)})`)
    return { status: 0, stdout, stderr: '' }
  }
  catch (error) {
    if (typeof error?.status !== 'number') throw error
    const status = error.status
    const stdout = String(error.stdout ?? '')
    const stderr = String(error.stderr ?? '')
    if (status !== expected) {
      throw new Error(`expected exit ${expected}, got ${status} (stdout: ${clip(stdout)} / stderr: ${clip(stderr)})`)
    }
    return { status, stdout, stderr }
  }
}

function jsonOf(result) {
  try {
    return JSON.parse(result.stdout)
  }
  catch (error) {
    throw new Error(`stdout is not JSON (${error.message}): ${clip(result.stdout)}`)
  }
}

async function test(name, fn) {
  try {
    await fn()
  }
  catch (error) {
    check(`${name} — threw`, false, clip(error?.message ?? error, 300))
  }
}

/**
 * Assert `after` is `before` with exactly the listed edits, in `before` line
 * coordinates. Everything not listed has to match byte for byte, which is how
 * "the neighbours did not move" is proven instead of eyeballed.
 */
function expectEdits(name, before, after, edits = {}) {
  const source = before.split('\n')
  const inserts = [...(edits.insert ?? [])].sort((left, right) => left.at - right.at)
  const replaced = new Map((edits.replace ?? []).map(item => [item.at, item]))
  const expected = []
  let cursor = 0
  for (let index = 0; index < source.length; index += 1) {
    while (cursor < inserts.length && inserts[cursor].at === index) {
      expected.push(inserts[cursor].line)
      cursor += 1
    }
    const swap = replaced.get(index)
    if (swap === undefined) {
      expected.push(source[index])
      continue
    }
    if (swap.from !== source[index]) {
      check(`${name} — replacement source matches`, false, `line ${index}: ${clip(source[index])}`)
    }
    expected.push(swap.to)
  }
  while (cursor < inserts.length) {
    if (inserts[cursor].at !== source.length) {
      check(`${name} — insertion inside the file`, false, `at ${inserts[cursor].at} of ${source.length}`)
    }
    expected.push(inserts[cursor].line)
    cursor += 1
  }
  const actual = after.split('\n')
  if (actual.length !== expected.length) {
    check(`${name} — line count`, false, `expected ${expected.length}, got ${actual.length}`)
    return
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      check(`${name} — byte ${index}`, false, `expected ${JSON.stringify(expected[index])}, got ${JSON.stringify(actual[index])}`)
      return
    }
  }
  check(name, true)
}

/** Assert `after` is `before` with the line range [start, end) replaced. */
function expectBlock(name, before, after, start, end, blockLines) {
  const source = before.split('\n')
  const expected = [...source.slice(0, start), ...blockLines, ...source.slice(end)]
  check(name, after.split('\n').join('\n') === expected.join('\n'), `expected ${expected.length} lines, got ${after.split('\n').length}`)
}

/** Indices where two texts differ, line by line. */
function diffIndices(left, right) {
  const first = left.split('\n')
  const second = right.split('\n')
  const out = []
  const longest = Math.max(first.length, second.length)
  for (let index = 0; index < longest; index += 1) {
    if (first[index] !== second[index]) out.push(index)
  }
  return out
}

/** Lines that appeared and disappeared, as multisets: the "only one line moved" test. */
function multisetDelta(from, to) {
  const counts = new Map()
  for (const line of from.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  const added = []
  for (const line of to.split('\n')) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added.push(line)
  }
  const removed = []
  for (const [line, left] of counts) {
    for (let index = 0; index < left; index += 1) removed.push(line)
  }
  return { added, removed }
}

const read = file => readFile(file, 'utf8')
const patchOf = (profile = 'web') => read(join(home, 'profiles', profile, 'cordis.patch.yml'))
const patchPath = (profile = 'web') => join(home, 'profiles', profile, 'cordis.patch.yml')
const stateOf = async () => JSON.parse(await read(join(home, 'tool-hub', 'state.json')))
const rowOf = (text, id) => parseRows(text).find(row => row.id === id)

async function writeSkill(rootRel, rel, name, enabled) {
  const dir = join(home, rootRel, rel)
  await mkdir(dir, { recursive: true })
  const body = `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n`
  await writeFile(join(dir, enabled ? 'SKILL.md' : 'SKILL.md.disabled'), body)
}

async function resetFixture() {
  await rm(home, { recursive: true, force: true })
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  await writeFile(patchPath(), PATCH)
  await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
  await writeFile(patchPath('desktop'), DESKTOP_SENTINEL)
  await mkdir(join(home, 'profiles', 'crlf'), { recursive: true })
  await writeFile(patchPath('crlf'), CRLF_PATCH)
  await mkdir(join(home, 'tool-hub'), { recursive: true })
  await writeFile(join(home, 'tool-hub', 'state.json'), `${JSON.stringify(STATE, null, 2)}\n`)
  for (const skill of SKILLS) await writeSkill(skill.root, skill.rel, skill.name, skill.enabled)
  await mkdir(scratch, { recursive: true })
}

async function backupNames() {
  try {
    return (await readdir(join(home, 'backups'))).sort()
  }
  catch {
    return []
  }
}

// ── unit: parseRows over the same fixture ────────────────────────────────────

async function unitParseRows() {
  const rows = parseRows(PATCH)
  check('parseRows: five rows, in file order', rows.map(row => row.id).join(',') === 'ui-theme,panel-mcp-illustrator,top-row,mcp-alpha,mcp-beta', rows.map(row => row.id).join(','))
  check('parseRows: indent is measured per row (6,6,2,2,2)', rows.map(row => row.indent).join(',') === '6,6,2,2,2', rows.map(row => row.indent).join(','))
  check('parseRows: every head line is a "- id:" line', rows.every(row => /^\s*- id:[ \t]*/.test(PATCH.split('\n')[row.startLine])))
  check('parseRows: spans are ordered and do not overlap', rows.every((row, index) => row.endLine > row.startLine && (index === 0 || row.startLine >= rows[index - 1].endLine)))

  const ui = rows[0]
  check('parseRows: a nested row ends before the between-rows comment', ui.startLine === AT('    - id: ui-theme') && ui.endLine === AT(BETWEEN), `${ui.startLine}..${ui.endLine}`)
  check('parseRows: ui-theme config covers exactly its one child line', ui.configStart === AT('        scheme: dark') && ui.configEnd === ui.configStart + 1, `${ui.configStart}..${ui.configEnd}`)
  check('parseRows: single-quoted name is unquoted', ui.name === 'dsh-ui-theme' && ui.disabled === false)

  const panel = rows[1]
  check('parseRows: disabled after the config block is seen', panel.disabled === true && panel.name === 'dsh-panel-mcp-illustrator')
  check('parseRows: a row ends before the next top-level row', panel.endLine === AT('- id: top-row'), `${panel.endLine}`)

  const top = rows[2]
  const topLines = PATCH.split('\n')
  check('parseRows: a top-level row keeps indent 2', top.indent === 2 && top.startLine === AT('- id: top-row'))
  check('parseRows: !!js value is kept verbatim in the config span', topLines[top.configStart] === "    expression: !!js process.env.TOOL_HUB_SMOKE === '1'")
  check('parseRows: a "#" inside quotes is not a comment boundary', topLines[top.configEnd - 1] === "    note: 'value with # hash and: colon'", clip(topLines[top.configEnd - 1]))
  check('parseRows: the blank line after a row is not part of it', top.endLine === AT('') && topLines[top.endLine] === '')
  const alpha = rows[3]
  const beta = rows[4]
  check('parseRows: a nested list stays inside the config span', alpha.configEnd === AT('      - alpha.js') + 1, `${alpha.configEnd}`)
  check('parseRows: mcp-beta config ends at its url line', beta.configEnd === AT('    url: http://127.0.0.1:9999/mcp') + 1 && beta.disabled === true, `${beta.configEnd}`)
  check('parseRows: an empty "- insert:" is not a row', rows.every(row => row.id !== 'insert'))

  check('parseRows: empty text has no rows', parseRows('').length === 0)
  check('parseRows: an empty override list has no rows', parseRows('[]\n').length === 0)
  check('parseRows: a CRLF file yields the same spans', parseRows(CRLF_PATCH).map(row => `${row.id}:${row.indent}`).join(',') === 'crlf-theme:6,crlf-top:2', parseRows(CRLF_PATCH).map(row => `${row.id}:${row.indent}`).join(','))

  const blockSource = ['- id: block-row', '  name: dsh-block', '  config: |', '    text: inside', '      deeper', '  note: after', ''].join('\n')
  const blockRow = parseRows(blockSource)[0]
  check('parseRows: a block scalar config owns its text lines', blockRow.configStart === 3 && blockRow.configEnd === 5, `${blockRow.configStart}..${blockRow.configEnd}`)

  const configList = ['- id: outer', '  name: dsh-outer', '  config:', '    servers:', '      - id: inner', '        name: not-a-row', ''].join('\n')
  check('parseRows: an id inside a config list is not a row', parseRows(configList).map(row => row.id).join(',') === 'outer', parseRows(configList).map(row => row.id).join(','))
  const commentParent = ['- insert:', '  # note above the row', '    - id: inside', '      name: dsh-inside', ''].join('\n')
  check('parseRows: a comment between "- insert:" and a row is not its parent', parseRows(commentParent).map(row => row.id).join(',') === 'inside', parseRows(commentParent).map(row => row.id).join(','))

  // removeRow is the third export; the CLI has no delete-plugin command, so it is
  // pinned here at the library level.
  const withoutUi = removeRow(PATCH, 'ui-theme')
  expectBlock('removeRow: deletes exactly the row span, comment included in neither', PATCH, withoutUi, AT('    - id: ui-theme'), AT(BETWEEN), [])
  check('removeRow: the between-rows comment is now the first thing there', withoutUi.split('\n')[AT('    - id: ui-theme')] === BETWEEN)
  const withoutTop = removeRow(PATCH, 'top-row')
  check('removeRow (top-level): one row fewer', parseRows(withoutTop).length === 4 && parseRows(withoutTop).every(row => row.id !== 'top-row'))
  check('removeRow (top-level): the blank line that followed stays', withoutTop.split('\n')[AT('- id: top-row')] === '')
  const crlfWithout = removeRow(CRLF_PATCH, 'crlf-theme')
  check('removeRow: a CRLF file keeps CRLF everywhere', crlfWithout.split('\n').slice(0, -1).every(line => line.endsWith('\r')) && !crlfWithout.includes('crlf-theme'))
  const flip = setRowDisabled(PATCH, 'ui-theme', true)
  check('setRowDisabled: line count grows by exactly one', flip.split('\n').length === PATCH.split('\n').length + 1)
}

// ── list ─────────────────────────────────────────────────────────────────────

async function listCommands() {
  const listed = jsonOf(run(['list', '--json', '--workspace', workspace]))
  check('list --json: ok', listed.ok === true && listed.profile === 'web')
  check('list --json: five plugins', listed.rows.length === 5 && listed.rows.map(row => row.id).join(',') === 'ui-theme,panel-mcp-illustrator,top-row,mcp-alpha,mcp-beta')
  check('list --json: enabled mirrors disabled', listed.rows.every(row => row.enabled === !row.disabled))
  check('list --json: two MCP servers, named by serverName', listed.mcp.length === 2 && listed.mcp[0].serverName === 'alpha' && listed.mcp[1].serverName === 'beta')
  check('list --json: MCP row is described by its scalars', listed.mcp[0].transport === 'stdio' && listed.mcp[0].command === 'node' && listed.mcp[1].url === 'http://127.0.0.1:9999/mcp')
  check('list --json: MCP output never carries env/headers/args', listed.mcp.every(server => Object.keys(server).sort().join(',') === 'command,disabled,enabled,endLine,id,serverName,startLine,transport,url'), JSON.stringify(Object.keys(listed.mcp[0]).sort()))
  check('list --json: both skill roots and the workspace root are scanned', listed.skills.length === 6 && listed.skills.map(skill => skill.name).join(',') === 'agent-skill,inner-skill,off-skill,smoke-skill,temp-skill,ws-skill', listed.skills.map(skill => skill.name).join(','))
  check('list --json: a skill with SKILL.md.disabled reads as off', listed.skills.find(skill => skill.name === 'off-skill')?.enabled === false)
  check('list --json: workspace skill is scoped', listed.skills.find(skill => skill.name === 'ws-skill')?.scope === 'workspace')
  check('list --json: groups and presets come from state.json', listed.groups.length === 2 && listed.presets.length === 2 && listed.toolDeny.join(',') === 'shell_exec')
  check('list --json: group members that no longer exist are counted', listed.groups.find(group => group.id === 'g2')?.missing === 1)

  const human = run(['list'])
  check('list: human output labels the sections', /plugins \(5\)/.test(human.stdout) && /mcp \(2\)/.test(human.stdout) && /skills \(5\)/.test(human.stdout), clip(human.stdout))

  const ghost = jsonOf(run(['list', '--json', '--profile', 'ghost']))
  check('list --json: a missing profile reports the patch as absent', ghost.patch.exists === false && ghost.rows.length === 0)

  const version = run(['--version'])
  check('--version: prints the package version', /^\d+\.\d+\.\d+/.test(version.stdout.trim()), clip(version.stdout))

  const help = run(['--help'])
  check('--help: lists every top-level command', ['plugin', 'group', 'preset', 'skill', 'mcp', 'config'].every(word => help.stdout.includes(word)))
}

// ── plugin ───────────────────────────────────────────────────────────────────

async function pluginCommand() {
  await resetFixture()
  const before = await patchOf()

  const enabledFirst = jsonOf(run(['plugin', 'enable', 'ui-theme', '--json']))
  check('plugin enable: a row with no disabled key is already on', enabledFirst.changed === false && enabledFirst.enabled === true)
  check('plugin enable: an already-on row writes nothing', await patchOf() === before && (await backupNames()).length === 0)

  const disabled = jsonOf(run(['plugin', 'disable', 'ui-theme', '--json']))
  const afterDisable = await patchOf()
  const atBetween = AT(BETWEEN)
  check('plugin disable: reports the change and the row it touched', disabled.changed === true && disabled.id === 'ui-theme' && disabled.enabled === false)
  check('plugin disable: inserted at the row\'s own indent, after its config', afterDisable.split('\n')[atBetween] === '      disabled: true', clip(afterDisable.split('\n')[atBetween]))
  expectEdits('plugin disable: one line inserted, every other line byte-identical', before, afterDisable, {
    insert: [{ at: atBetween, line: '      disabled: true' }],
  })
  check('plugin disable: prefix before the insertion is byte-identical', afterDisable.split('\n').slice(0, atBetween).join('\n') === before.split('\n').slice(0, atBetween).join('\n'))
  check('plugin disable: suffix after the insertion is byte-identical', afterDisable.split('\n').slice(atBetween + 1).join('\n') === before.split('\n').slice(atBetween).join('\n'))
  check('plugin disable: the between-rows comment survived at the list level', afterDisable.split('\n')[atBetween + 1] === BETWEEN)
  check('plugin disable: a backup holds the pre-edit bytes', (await read(disabled.backup)) === before, disabled.backup)
  check('plugin disable: backup name follows <file>-<ISO>.yml', /^cordis\.patch-.*\.yml$/.test(disabled.backup.split(/[\\/]/).pop()))

  const again = jsonOf(run(['plugin', 'disable', 'ui-theme', '--json']))
  check('plugin disable twice: second run is a no-op', again.changed === false && await patchOf() === afterDisable)
  check('plugin disable twice: no second backup', (await backupNames()).length === 1)

  const reEnabled = jsonOf(run(['plugin', 'enable', 'ui-theme', '--json']))
  expectEdits('plugin enable: rewrites the same line to false, nothing else moves', afterDisable, await patchOf(), {
    replace: [{ at: atBetween, from: '      disabled: true', to: '      disabled: false' }],
  })
  check('plugin enable: reports the change', reEnabled.changed === true && reEnabled.enabled === true)

  const beforeTop = await patchOf()
  const atBlank = lineIndex(beforeTop, '')
  const topDisabled = jsonOf(run(['plugin', 'disable', 'top-row', '--json']))
  const afterTop = await patchOf()
  expectEdits('plugin disable (top-level row): one line at indent 2, !!js untouched', beforeTop, afterTop, {
    insert: [{ at: atBlank, line: '  disabled: true' }],
  })
  check('plugin disable (top-level row): config children untouched', topDisabled.changed === true && afterTop.split('\n')[lineIndex(afterTop, "    note: 'value with # hash and: colon'")] === "    note: 'value with # hash and: colon'")
  check('plugin disable (top-level row): the blank line is still there', afterTop.split('\n')[atBlank] === '  disabled: true' && afterTop.split('\n')[atBlank + 1] === '')

  const panel = jsonOf(run(['plugin', 'disable', 'panel-mcp-illustrator', '--json']))
  check('plugin disable: an already-disabled row is a no-op', panel.changed === false)
  const panelOn = jsonOf(run(['plugin', 'enable', 'panel-mcp-illustrator', '--json']))
  check('plugin enable: a quoted name row flips to disabled: false', panelOn.changed === true && rowOf(await patchOf(), 'panel-mcp-illustrator').disabled === false)

  const byInclude = jsonOf(run(['plugin', 'disable', 'include:ui-theme', '--json']))
  check('plugin disable: an entry id with an include: prefix resolves to the row', byInclude.changed === true && byInclude.id === 'ui-theme')

  const missingRow = run(['plugin', 'disable', 'no-such-row', '--json'], 2)
  check('plugin disable: unknown row exits 2', JSON.parse(missingRow.stdout).error.code === 'row-not-found')
  const done = await patchOf()
  check('plugin: a failed lookup writes nothing', rowOf(done, 'ui-theme').disabled === true)
}

// ── group ────────────────────────────────────────────────────────────────────

async function groupCommands() {
  await resetFixture()
  const before = await patchOf()

  const listed = jsonOf(run(['group', 'list', '--json']))
  check('group list: two groups with member counts', listed.groups.length === 2 && listed.groups[0].members === 3 && listed.groups[1].members === 3)
  check('group list: a dangling member is reported, not hidden', listed.groups.find(group => group.id === 'g2').missing === 1)

  const off = jsonOf(run(['group', 'off', '主题组', '--json']))
  const afterOff = await patchOf()
  check('group off: three members changed (2 plugins, 1 skill)', off.changed.length === 3 && off.changed.filter(entry => entry.kind === 'plugin').length === 2, JSON.stringify(off.changed))
  expectEdits('group off: exactly two lines inserted for the two plugin rows', before, afterOff, {
    insert: [
      { at: AT(BETWEEN), line: '      disabled: true' },
      { at: AT(''), line: '  disabled: true' },
    ],
  })
  check('group off: the skill was switched by renaming', await stat(join(home, 'skills', 'smoke-skill', 'SKILL.md.disabled')).then(() => true, () => false))
  check('group off: other skills were not touched', await stat(join(home, 'skills', 'temp-skill', 'SKILL.md')).then(() => true, () => false))
  check('group off: the between-rows comment survived', afterOff.split('\n')[AT(BETWEEN) + 1] === BETWEEN)
  check('group off: one patch backup', (await backupNames()).length === 1)

  const offAgain = jsonOf(run(['group', 'off', '主题组', '--json']))
  check('group off twice: nothing changes', offAgain.changed.length === 0 && await patchOf() === afterOff)

  const on = jsonOf(run(['group', 'on', '主题组', '--json']))
  const afterOn = await patchOf()
  check('group on: three members changed back', on.changed.length === 3)
  expectEdits('group on: the two inserted lines flip to false, the rest is untouched', afterOff, afterOn, {
    replace: [
      { at: lineIndex(afterOff, '      disabled: true'), from: '      disabled: true', to: '      disabled: false' },
      { at: lineIndex(afterOff, '  disabled: true'), from: '  disabled: true', to: '  disabled: false' },
    ],
  })
  check('group on: the skill is back on', await stat(join(home, 'skills', 'smoke-skill', 'SKILL.md')).then(() => true, () => false))

  const mixed = jsonOf(run(['group', 'off', 'MCP组', '--json']))
  check('group off: a member with no patch row is skipped, with a reason', mixed.skipped.some(entry => entry.id === 'gone-row' && entry.reason === 'no-patch-row'), JSON.stringify(mixed.skipped))
  check('group off: an already-off skill is not reported as changed', !mixed.changed.some(entry => entry.id === 'user|off-skill'))
  check('group off: the MCP row was disabled', rowOf(await patchOf(), 'mcp-alpha').disabled === true)

  run(['group', 'off', '不存在的组', '--json'], 2)
  check('group off: unknown group exits 2', true)
  run(['group', 'on'], 1)
  check('group on without a name exits 1', true)
}

// ── preset ───────────────────────────────────────────────────────────────────

async function presetCommands() {
  await resetFixture()
  const before = await patchOf()

  const listed = jsonOf(run(['preset', 'list', '--json']))
  check('preset list: object-shaped enabled', listed.presets.find(preset => preset.name === 'only-theme').plugins === 1 && listed.presets.find(preset => preset.name === 'only-theme').skills === 1)
  check('preset list: legacy flat enabled array still counts', listed.presets.find(preset => preset.name === 'legacy-flat').plugins === 1)

  const applied = jsonOf(run(['preset', 'apply', 'only-theme', '--json', '--workspace', workspace]))
  const after = await patchOf()
  expectEdits('preset apply: only rows that were on get a disabled line', before, after, {
    insert: [
      { at: AT(''), line: '  disabled: true' },
      { at: AT('      - alpha.js') + 1, line: '  disabled: true' },
    ],
  })
  check('preset apply: the preset row stays on', rowOf(after, 'ui-theme').disabled === false)
  check('preset apply: every other row is off', ['panel-mcp-illustrator', 'top-row', 'mcp-alpha', 'mcp-beta'].every(id => rowOf(after, id).disabled === true))
  check('preset apply: exact mode reports every flip', applied.mode === 'exact' && applied.changed.length === 6, JSON.stringify(applied.changed))
  check('preset apply: two plugins flipped', applied.changed.filter(entry => entry.kind === 'plugin').length === 2)
  check('preset apply (exact): a skill the preset does not name is switched off', await stat(join(home, 'skills', 'nested', 'group', 'inner-skill', 'SKILL.md.disabled')).then(() => true, () => false))
  check('preset apply (exact): the named skill stays on', await stat(join(home, 'skills', 'smoke-skill', 'SKILL.md')).then(() => true, () => false))

  const keep = jsonOf(run(['preset', 'apply', 'legacy-flat', '--only-enable', '--json', '--workspace', workspace]))
  const afterKeep = await patchOf()
  check('preset apply --only-enable: only enables, never disables', keep.mode === 'only-enable' && rowOf(afterKeep, 'top-row').disabled === false && rowOf(afterKeep, 'ui-theme').disabled === false, JSON.stringify(keep.changed))
  check('preset apply --only-enable: skills are left alone', await stat(join(home, 'skills', 'nested', 'group', 'inner-skill', 'SKILL.md.disabled')).then(() => true, () => false))

  const flat = jsonOf(run(['preset', 'apply', 'legacy-flat', '--json', '--workspace', workspace]))
  const afterFlat = await patchOf()
  check('preset apply (flat array): top-row is the only row on', rowOf(afterFlat, 'top-row').disabled === false && ['ui-theme', 'panel-mcp-illustrator', 'mcp-alpha', 'mcp-beta'].every(id => rowOf(afterFlat, id).disabled === true))
  check('preset apply (flat array): reported as file changes', flat.changed.length > 0)

  run(['preset', 'apply', 'nope', '--json'], 2)
  check('preset apply: unknown preset exits 2', true)
}

// ── skill ────────────────────────────────────────────────────────────────────

async function skillCommands() {
  await resetFixture()

  const listed = jsonOf(run(['skill', 'list', '--json', '--workspace', workspace]))
  check('skill list: roots in scan order', listed.roots.join('|') === [join(home, 'skills'), join(home, '.agents', 'skills'), join(workspace, '.dsh', 'skills')].join('|'), listed.roots.join('|'))
  check('skill list: a nested skill is found', listed.skills.some(skill => skill.name === 'inner-skill'))
  check('skill list: ids carry the root', listed.skills.find(skill => skill.name === 'smoke-skill').id === 'user|smoke-skill')

  const global = jsonOf(run(['skill', 'list', '--json', '--global']))
  check('skill list --global: the workspace root is not scanned', global.roots.length === 2 && !global.skills.some(skill => skill.name === 'ws-skill'))
  run(['skill', 'list', '--global', '--workspace', workspace], 1)
  check('skill list: --global and --workspace contradict, exit 1', true)

  const off = jsonOf(run(['skill', 'disable', 'smoke-skill', '--json']))
  check('skill disable: renames SKILL.md', off.changed === true && await stat(join(home, 'skills', 'smoke-skill', 'SKILL.md.disabled')).then(() => true, () => false))
  check('skill disable: content is untouched', (await read(join(home, 'skills', 'smoke-skill', 'SKILL.md.disabled'))).includes('name: smoke-skill'))
  const offAgain = jsonOf(run(['skill', 'disable', 'smoke-skill', '--json']))
  check('skill disable twice: already off, nothing renamed', offAgain.changed === false && offAgain.message === 'already off')
  const on = jsonOf(run(['skill', 'enable', 'smoke-skill', '--json']))
  check('skill enable: renames back', on.changed === true && await stat(join(home, 'skills', 'smoke-skill', 'SKILL.md')).then(() => true, () => false))

  const deleted = jsonOf(run(['skill', 'delete', 'temp-skill', '--json']))
  check('skill delete: the directory is gone from the root', await stat(join(home, 'skills', 'temp-skill')).then(() => false, () => true))
  check('skill delete: it landed in the panel trash', deleted.trash.startsWith(join(home, 'tool-hub', 'trash')) && await stat(join(deleted.trash, 'meta.json')).then(() => true, () => false), deleted.trash)
  const meta = JSON.parse(await read(join(deleted.trash, 'meta.json')))
  check('skill delete: meta records where it came from', meta.name === 'temp-skill' && meta.id === 'user|temp-skill' && meta.path === join(home, 'skills', 'temp-skill'))
  const afterDelete = jsonOf(run(['skill', 'list', '--json']))
  check('skill delete: it no longer lists', !afterDelete.skills.some(skill => skill.name === 'temp-skill'))

  run(['skill', 'delete', 'temp-skill', '--json'], 2)
  check('skill delete twice: exits 2', true)
  run(['skill', 'enable', 'nope', '--json'], 2)
  check('skill enable: unknown skill exits 2', true)
  run(['skill', 'frobnicate', 'x', '--json'], 1)
  check('skill: unknown subcommand exits 1', true)
}

// ── mcp ──────────────────────────────────────────────────────────────────────

async function mcpCommands() {
  await resetFixture()

  const listed = jsonOf(run(['mcp', 'list', '--json']))
  check('mcp list: two servers, ordered as in the file', listed.servers.map(server => server.serverName).join(',') === 'alpha,beta')
  check('mcp list: disabled flag follows the row', listed.servers[1].disabled === true && listed.servers[1].enabled === false)

  const before = await patchOf()
  const disabled = jsonOf(run(['mcp', 'disable', 'alpha', '--json']))
  const afterDisable = await patchOf()
  expectEdits('mcp disable: one line inserted at the row indent', before, afterDisable, {
    insert: [{ at: AT('      - alpha.js') + 1, line: '  disabled: true' }],
  })
  check('mcp disable: row level keys below the config are untouched', afterDisable.split('\n')[AT("  note: 'alpha server'") + 1] === "  note: 'alpha server'", clip(afterDisable.split('\n')[AT("  note: 'alpha server'") + 1]))
  check('mcp disable: reports the server name', disabled.serverName === 'alpha' && disabled.id === 'mcp-alpha')

  const enabled = jsonOf(run(['mcp', 'enable', 'alpha', '--json']))
  check('mcp enable: flips the same line back', enabled.changed === true && rowOf(await patchOf(), 'mcp-alpha').disabled === false)
  const afterEnable = await patchOf()
  const enableDiff = diffIndices(afterDisable, afterEnable)
  check('mcp enable: exactly one line differs', enableDiff.length === 1 && afterEnable.split('\n')[enableDiff[0]] === '  disabled: false', JSON.stringify(enableDiff.map(index => [afterDisable.split('\n')[index], afterEnable.split('\n')[index]])))

  // Back to the pristine fixture: the span indices below are fixture coordinates.
  await resetFixture()
  const raw = jsonOf(run(['mcp', 'raw', 'alpha', '--json']))
  check('mcp raw: prints exactly one row', raw.text.startsWith('- id: mcp-alpha') && raw.text.includes("  note: 'alpha server'") && !raw.text.includes('mcp-beta'))
  check('mcp raw: reports the span it read', raw.startLine === AT('- id: mcp-alpha') && raw.endLine === AT('- id: mcp-beta'), `${raw.startLine}..${raw.endLine}`)

  const nestedSet = join(scratch, 'set-nested.yml')
  await writeFile(nestedSet, [
    '        - id: mcp-alpha',
    "          name: '@deepseek-ai/dsh-mcp-client'",
    '          config:',
    '            serverName: alpha',
    '            transport: stdio',
    '            command: node',
    '            args:',
    '              - alpha-v2.js',
    '',
  ].join('\n'))
  const beforeSet = await patchOf()
  const setResult = jsonOf(run(['mcp', 'raw', 'alpha', '--set', nestedSet, '--json']))
  const afterSet = await patchOf()
  expectBlock('mcp raw --set: only the row span is replaced, re-indented to column 0', beforeSet, afterSet, AT('- id: mcp-alpha'), AT('- id: mcp-beta'), [
    '- id: mcp-alpha',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: alpha',
    '    transport: stdio',
    '    command: node',
    '    args:',
    '      - alpha-v2.js',
  ])
  check('mcp raw --set: id and serverName are unchanged', setResult.id === 'mcp-alpha' && setResult.serverName === 'alpha' && setResult.changed === true)
  check('mcp raw --set: the new command landed', (await patchOf()).includes('      - alpha-v2.js'))
  check('mcp raw --set: the row count is still five', parseRows(await patchOf()).length === 5)

  const twoRows = join(scratch, 'set-two.yml')
  await writeFile(twoRows, `${["- id: mcp-alpha", "  name: '@deepseek-ai/dsh-mcp-client'", "- id: mcp-beta", "  name: '@deepseek-ai/dsh-mcp-client'", ''].join('\n')}`)
  const wrongId = join(scratch, 'set-id.yml')
  await writeFile(wrongId, `${["- id: mcp-gamma", "  name: '@deepseek-ai/dsh-mcp-client'", ''].join('\n')}`)
  const wrongKind = join(scratch, 'set-kind.yml')
  await writeFile(wrongKind, `${['- id: mcp-alpha', "  name: 'other-plugin'", ''].join('\n')}`)

  const beforeRejects = await patchOf()
  const two = run(['mcp', 'raw', 'alpha', '--set', twoRows, '--json'], 3)
  check('mcp raw --set: two rows are rejected (exit 3)', JSON.parse(two.stdout).error.code === 'set-row-count')
  const id = run(['mcp', 'raw', 'alpha', '--set', wrongId, '--json'], 3)
  check('mcp raw --set: a changed id is rejected (exit 3)', JSON.parse(id.stdout).error.code === 'set-row-id')
  const kind = run(['mcp', 'raw', 'alpha', '--set', wrongKind, '--json'], 3)
  check('mcp raw --set: a non-MCP row is rejected (exit 3)', JSON.parse(kind.stdout).error.code === 'set-row-kind')
  run(['mcp', 'raw', 'alpha', '--set', join(scratch, 'nope.yml'), '--json'], 2)
  check('mcp raw --set: a missing file exits 2', true)
  check('mcp raw --set: no rejected write reached the patch', await patchOf() === beforeRejects)

  run(['mcp', 'disable', 'nope', '--json'], 2)
  check('mcp disable: unknown server exits 2', true)
  run(['mcp', 'raw', 'nope', '--json'], 2)
  check('mcp raw: unknown server exits 2', true)
}

// ── config export / import ──────────────────────────────────────────────────

async function configCommands() {
  await resetFixture()
  const target = join(scratch, 'out', 'nested', 'config.json')

  // A missing parent is a refusal, not an invitation to create directories.
  const noParent = JSON.parse(run(['config', 'export', target, '--json'], 1).stdout)
  check('config export: a missing parent is refused', noParent.error.code === 'path-parent-missing', noParent.error.code)
  check('config export: the refused parent was not created', !existsSync(join(scratch, 'out')))

  const exported = jsonOf(run(['config', 'export', target, '--mkdir', '--json']))
  const payload = JSON.parse(await read(target))
  check('config export: --mkdir creates the parent and lands the file', exported.groups === 2 && exported.presets === 2 && existsSync(target))
  const again = jsonOf(run(['config', 'export', target, '--json']))
  check('config export: an existing regular file is replaced and backed up', again.file === target && (await readdir(join(home, 'backups'))).some(name => /^config-.+\.json$/.test(name)), again.file)
  check('config export: exactly the portable keys', Object.keys(payload).sort().join(',') === 'collections,exportedAt,groups,presets,source,toolDeny,version', Object.keys(payload).sort().join(','))
  check('config export: no credentials, no panel-only key, no auto', !JSON.stringify(payload).includes('panelOnlyKey') && !('auto' in payload))
  check('config export: names the profile it came from', payload.source.profile === 'web')

  const imported = jsonOf(run(['config', 'import', target, '--json']))
  const stateAfter = await stateOf()
  check('config import (merge): counts are stable', imported.mode === 'merge' && imported.groups === 2 && imported.presets === 2 && imported.collections === 2, JSON.stringify(imported))
  check('config import: the state write was backed up first', /^state-.+\.json$/.test(String(imported.backup ?? '').split(/[\\/]/).pop()), String(imported.backup))
  check('config import: unknown top-level state keys survive the rewrite', stateAfter.panelOnlyKey?.kept === true)
  check('config import: auto is preserved', stateAfter.auto.appliedAt === 1700000000000)

  const incoming = join(scratch, 'incoming.json')
  await writeFile(incoming, JSON.stringify({
    groups: [{ id: 'g3', name: '导入组', members: [{ kind: 'plugin', id: 'mcp-beta' }] }],
    collections: [{ id: 'custom2', name: '导入分组群', order: 2 }],
    presets: [{ name: 'imported', enabled: { plugin: ['mcp-beta'], skill: [] } }],
    toolDeny: ['another_tool'],
  }))
  const merged = jsonOf(run(['config', 'import', incoming, '--json']))
  check('config import (merge): new rows are appended', merged.groups === 3 && merged.presets === 3 && merged.collections === 3)
  check('config import (merge): toolDeny is a union', (await stateOf()).toolDeny.sort().join(',') === 'another_tool,shell_exec')

  const replaced = join(scratch, 'replace.json')
  await writeFile(replaced, JSON.stringify({ groups: [{ id: 'only', name: '唯一组', members: [] }], collections: [], presets: [], toolDeny: [] }))
  const refusedReplace = JSON.parse(run(['config', 'import', replaced, '--replace', '--json'], 3).stdout)
  check('config import --replace: refused without --yes', refusedReplace.error.code === 'replace-needs-yes', refusedReplace.error.code)
  check('config import --replace (refused): the state is untouched', (await stateOf()).groups.length === 3)
  const replaceResult = jsonOf(run(['config', 'import', replaced, '--replace', '--yes', '--json']))
  const stateReplaced = await stateOf()
  check('config import --replace: groups and presets are replaced', replaceResult.mode === 'replace' && stateReplaced.groups.length === 1 && stateReplaced.presets.length === 0 && stateReplaced.toolDeny.length === 0)
  check('config import --replace: the default collection is kept', stateReplaced.collections.length === 1 && stateReplaced.collections[0].id === 'default')
  check('config import --replace: unknown state keys still survive', stateReplaced.panelOnlyKey?.kept === true)

  const broken = join(scratch, 'broken.json')
  await writeFile(broken, '{not json')
  const badJson = run(['config', 'import', broken, '--json'], 3)
  check('config import: invalid JSON is a validation failure (exit 3)', JSON.parse(badJson.stdout).error.code === 'config-invalid')
  const badShape = join(scratch, 'shape.json')
  await writeFile(badShape, '[1,2,3]')
  run(['config', 'import', badShape, '--json'], 3)
  check('config import: a non-object document exits 3', true)
  run(['config', 'import', join(scratch, 'missing.json'), '--json'], 2)
  check('config import: a missing file exits 2', true)
  check('config import: a failed import leaves state alone', (await stateOf()).groups.length === 1)

  // ── path guards ───────────────────────────────────────────────────────────
  // A junction needs no privilege on Windows, so the symlink cases stay
  // testable; where even that is refused the checks are kept and named skipped.
  const realDir = join(scratch, 'real-dir')
  await mkdir(realDir, { recursive: true })
  const linkDir = join(scratch, 'link-dir')
  let linked = true
  try {
    await symlink(realDir, linkDir, 'junction')
  }
  catch {
    try {
      await symlink(realDir, linkDir, 'dir')
    }
    catch {
      linked = false
    }
  }

  const dirTarget = JSON.parse(run(['config', 'export', scratch, '--json'], 1).stdout)
  check('config export: a directory destination is refused', dirTarget.error.code === 'path-directory', dirTarget.error.code)

  if (linked) {
    const linkTarget = JSON.parse(run(['config', 'export', linkDir, '--json'], 1).stdout)
    check('config export: a symlinked destination is refused', linkTarget.error.code === 'path-symlink', linkTarget.error.code)
    const linkParent = JSON.parse(run(['config', 'export', join(linkDir, 'out.json'), '--json'], 1).stdout)
    check('config export: a symlinked parent is refused', linkParent.error.code === 'path-symlink', linkParent.error.code)
    check('config export: the refused symlink target stays empty', (await readdir(realDir)).length === 0)
    const linkedImport = JSON.parse(run(['config', 'import', linkDir, '--json'], 3).stdout)
    check('config import: a symlinked source is refused', linkedImport.error.code === 'path-symlink', linkedImport.error.code)
  }
  else {
    check('config export: a symlinked destination is refused (skipped: no link support)', true)
    check('config export: a symlinked parent is refused (skipped: no link support)', true)
    check('config export: the refused symlink target stays empty (skipped: no link support)', true)
    check('config import: a symlinked source is refused (skipped: no link support)', true)
  }

  const dirImport = JSON.parse(run(['config', 'import', scratch, '--json'], 3).stdout)
  check('config import: a directory source is refused', dirImport.error.code === 'path-kind', dirImport.error.code)

  const big = join(scratch, 'big.json')
  await writeFile(big, JSON.stringify({ padding: 'x'.repeat((2 * 1024 * 1024) + 1) }))
  const bigImport = JSON.parse(run(['config', 'import', big, '--json'], 3).stdout)
  check('config import: a file over 2 MB is refused', bigImport.error.code === 'config-too-large', bigImport.error.code)

  const outside = join(tmpdir(), `tool-hub-cli-smoke-outside-${process.pid}.json`)
  const escaped = JSON.parse(run(['config', 'export', outside, '--json'], 1).stdout)
  check('config export: outside $DSH_HOME and the cwd is refused', escaped.error.code === 'path-outside', escaped.error.code)
  check('config export: the refused outside file was not written', !existsSync(outside))
  const forced = jsonOf(run(['config', 'export', outside, '--force', '--json']))
  check('config export: --force allows an outside destination', forced.file === outside && existsSync(outside), String(forced.file))
  await rm(outside, { force: true })
}

// ── refusals, usage, CRLF ───────────────────────────────────────────────────

async function guardRails() {
  await resetFixture()
  const desktopBefore = await read(patchPath('desktop'))
  const refused = run(['list', '--profile', 'desktop', '--json'], 2)
  check('--profile desktop: refused with exit 2', JSON.parse(refused.stdout).error.code === 'profile-desktop')
  run(['plugin', 'disable', 'ui-theme', '--profile', 'desktop', '--json'], 2)
  check('--profile desktop: a write command is refused too', true)
  check('--profile desktop: the desktop patch was never touched', await read(patchPath('desktop')) === desktopBefore)

  run(['frobnicate', '--json'], 1)
  const unknown = JSON.parse(run(['frobnicate', '--json'], 1).stdout)
  check('unknown command: exit 1 and a JSON error', unknown.ok === false && unknown.error.code === 'usage')
  check('unknown command: a human run writes the reason to stderr', /unknown command/.test(run(['frobnicate'], 1).stderr))
  run(['plugin', 'disable'], 1)
  check('plugin without an id exits 1', true)
  run(['--nope'], 1)
  check('unknown option exits 1', true)
  run(['--profile'], 1)
  check('--profile without a value exits 1', true)
  run(['--profile', 'bad name!', 'list'], 1)
  check('an invalid profile name exits 1', true)

  const crlf = jsonOf(run(['plugin', 'disable', 'crlf-theme', '--profile', 'crlf', '--json']))
  const crlfAfter = await read(patchPath('crlf'))
  check('CRLF profile: the edit lands', crlf.changed === true && crlf.id === 'crlf-theme')
  check('CRLF profile: every line ending is still CRLF', crlfAfter.split('\n').slice(0, -1).every(line => line.endsWith('\r')), clip(JSON.stringify(crlfAfter.slice(0, 120))))
  expectEdits('CRLF profile: one inserted line, CRLF preserved byte for byte', CRLF_PATCH, crlfAfter, {
    insert: [{ at: 5, line: '      disabled: true\r' }],
  })

  const backups = await backupNames()
  check('backups: the CRLF write left one patch backup', backups.length === 1 && /^cordis\.patch-.+\.yml$/.test(backups[0]), backups.join(','))
  check('backups: that backup is the pre-edit file', (await read(join(home, 'backups', backups[0]))) === CRLF_PATCH)
  const leftovers = await readdir(join(home, 'profiles', 'crlf'))
  check('writes land through tmp+rename: no temp file is left behind', leftovers.join(',') === 'cordis.patch.yml', leftovers.join(','))
}

// ── the panel's own row is protected from bulk actions ──────────────────────

async function selfGuard() {
  await resetFixture()
  const text = `${['- insert:', '    - id: tool-hub', "      name: 'dsh-tool-hub'", '      config:', '        serverName: tool-hub', ''].join('\n')}`
  await mkdir(join(home, 'profiles', 'self'), { recursive: true })
  await writeFile(patchPath('self'), text)
  const state = await stateOf()
  state.groups.push({ id: 'g3', name: '自己组', members: [{ kind: 'plugin', id: 'include:tool-hub' }] })
  await writeFile(join(home, 'tool-hub', 'state.json'), `${JSON.stringify(state, null, 2)}\n`)

  const off = jsonOf(run(['group', 'off', '自己组', '--json', '--profile', 'self']))
  check('group off: the panel row is skipped as protected', off.changed.length === 0 && off.skipped.some(entry => entry.id === 'tool-hub' && entry.reason === 'protected'), JSON.stringify(off.skipped))
  check('group off (protected): the patch is untouched', await read(patchPath('self')) === text)

  run(['preset', 'apply', 'only-theme', '--json', '--profile', 'self'])
  check('preset apply (exact): a bulk action never switches the panel row off', rowOf(await read(patchPath('self')), 'tool-hub').disabled === false)

  const explicit = jsonOf(run(['plugin', 'disable', 'tool-hub', '--json', '--profile', 'self']))
  check('plugin disable: an explicit single-row command still may', explicit.changed === true && rowOf(await read(patchPath('self')), 'tool-hub').disabled === true)
}

// ── a real profile, copied into the sandbox ─────────────────────────────────

/**
 * The fixture above is synthetic; a user's profile is not. If this machine has
 * one, copy it in under a new profile name and prove the parser and the writer
 * behave on it: the same ids, and an edit that moves one `disabled:` line only.
 */
async function realProfile() {
  const source = [
    join(homedir(), '.dsh', 'profiles', 'sandbox', 'cordis.patch.yml'),
    join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
  ].find(file => existsSync(file))
  if (source === undefined) {
    console.log('SKIP  real profile: no profile patch on this machine')
    return
  }
  await resetFixture()
  const text = await read(source)
  await mkdir(join(home, 'profiles', 'copied'), { recursive: true })
  await writeFile(patchPath('copied'), text)

  const rows = parseRows(text)
  check(`real profile (${basename(dirname(source))}): every row has an id and a span`, rows.length > 0 && rows.every(row => row.id !== '' && row.endLine > row.startLine))
  const listed = jsonOf(run(['list', '--json', '--profile', 'copied']))
  check('real profile: the CLI reports the same ids the parser found', listed.rows.map(row => row.id).join(',') === rows.map(row => row.id).join(','), `${listed.rows.length} vs ${rows.length}`)

  const target = rows.find(row => !row.disabled)
  if (target === undefined) {
    console.log('SKIP  real profile: every row is already disabled')
    return
  }
  const edited = jsonOf(run(['plugin', 'disable', target.id, '--profile', 'copied', '--json']))
  const after = await read(patchPath('copied'))
  const delta = multisetDelta(text, after)
  check(`real profile: disabling ${target.id} adds one disabled line`, edited.changed === true && delta.added.length === 1 && delta.added[0].trimStart().startsWith('disabled:'), JSON.stringify(delta))
  check('real profile: nothing else was removed or rewritten', delta.removed.every(line => line.trimStart().startsWith('disabled:')) && delta.removed.length <= 1, JSON.stringify(delta.removed))
  check('real profile: the id list is unchanged', parseRows(after).map(row => row.id).join(',') === rows.map(row => row.id).join(','))
  check('real profile: the target row is now off', rowOf(after, target.id)?.disabled === true)
}

// ── run ─────────────────────────────────────────────────────────────────────

console.log(`home ${home}`)
console.log(`cli  ${CLI}`)
console.log('')

await resetFixture()
await test('unit: parseRows', unitParseRows)
await resetFixture()
await test('list', listCommands)
await test('plugin', pluginCommand)
await test('group', groupCommands)
await test('preset', presetCommands)
await test('skill', skillCommands)
await test('mcp', mcpCommands)
await test('config', configCommands)
await test('guard rails', guardRails)
await test('self row', selfGuard)
await test('real profile', realProfile)

const passed = results.filter(entry => entry.ok).length
const failed = results.length - passed
console.log('')
console.log(`commands exercised: ${[...new Set(trace.map(line => line.split(' ').slice(1, 3).filter(token => !token.startsWith('--')).join(' ')))].length}`)
console.log(`${passed}/${results.length} assertions passed${failed === 0 ? '' : `, ${failed} failed`}`)
if (failed > 0) {
  console.log('')
  for (const entry of results.filter(item => !item.ok)) console.log(`  FAILED  ${entry.name}`)
  process.exitCode = 1
}
await rm(home, { recursive: true, force: true })
