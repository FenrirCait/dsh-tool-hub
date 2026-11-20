#!/usr/bin/env node
/**
 * core-state probe: state migration, backup rotation, corrupt-state recovery, atomic write and the
 * cross-process lock.
 *
 * Runs against the built host output (npm run build:host), or against TOOL_HUB_DIST when that is
 * set. Every check prints PASS/FAIL; the process exits 1 if any check failed. Node builtins only.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const distRoot = resolve(process.env.TOOL_HUB_DIST ?? join(repoRoot, 'dist'))
const distCore = join(distRoot, 'core')

if (!existsSync(join(distCore, 'state.js'))) {
  process.stdout.write('FAIL dist/core/state.js is missing under ' + distRoot + '; run `npm run build:host` first' + NL)
  process.exit(1)
}

const stateModule = await import(pathToFileURL(join(distCore, 'state.js')).href)
const io = await import(pathToFileURL(join(distCore, 'io.js')).href)
const atomic = await import(pathToFileURL(join(distCore, 'atomic.js')).href)
const atomicUrl = pathToFileURL(join(distCore, 'atomic.js')).href
const { emptyState, migrate, schemaVersion, STATE_VERSION } = stateModule

let checks = 0
let failures = 0
const sandboxes = []
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

function say(line) {
  process.stdout.write(line + NL)
}

function note(line) {
  say('  note: ' + line)
}

async function check(label, fn) {
  checks += 1
  try {
    await fn()
    say('PASS ' + label)
  }
  catch (error) {
    failures += 1
    say('FAIL ' + label + ' :: ' + (error && error.message ? error.message : String(error)))
  }
}

/** A temp state directory with TOOL_HUB_STATE_FILE pointed at it, restored afterwards. */
async function withSandbox(label, fn) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const dir = await mkdtemp(join(tmpdir(), 'tool-hub-' + slug + '-'))
  sandboxes.push(dir)
  const previousState = process.env.TOOL_HUB_STATE_FILE
  const previousHome = process.env.DSH_HOME
  process.env.TOOL_HUB_STATE_FILE = join(dir, 'state.json')
  delete process.env.DSH_HOME
  try {
    return await fn(dir)
  }
  finally {
    if (previousState === undefined) delete process.env.TOOL_HUB_STATE_FILE
    else process.env.TOOL_HUB_STATE_FILE = previousState
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

async function checkSandbox(label, fn) {
  await check(label, () => withSandbox(label, fn))
}

/** A 1.x document with every key the 1.x normalizer writes. */
function v1Sample() {
  return {
    version: 1,
    groups: [{ id: 'g1', name: 'Tools', members: [{ kind: 'plugin', id: 'dsh-x' }], role: 'official', collection: 'default', tags: ['a'], auto: false, createdAt: 1700000000000 }],
    collections: [{ id: 'default', name: 'Default', order: 0 }, { id: 'work', name: 'Work', order: 1 }],
    presets: [{ name: 'Focus', enabled: { plugin: ['p1'], skill: ['s1'], tool: ['mcp__x__y'] }, toolDeny: ['mcp__x__z'], note: 'n', createdAt: 1700000000001 }],
    toolDeny: ['mcp__deny__one'],
    lazyServers: ['files'],
    lazyLoaded: ['mcp__files__read'],
    auto: { appliedAt: 1700000000002 },
    sessions: { 'sess-1': ['mcp__sess__one'] },
    scenes: { writing: { name: 'writing', at: 1700000000003, snapshot: { toolDeny: [] } } },
    mode: { name: 'writing', at: 1700000000004, snapshot: { toolDeny: [] } },
  }
}

async function backupNames(dir) {
  try {
    const names = await readdir(join(dir, 'backups'))
    return names.filter((name) => name.startsWith('state-') && name.endsWith('.json'))
  }
  catch (error) {
    void error
    return []
  }
}

function childSource(options) {
  const lines = [
    'import { access, appendFile, writeFile } from "node:fs/promises"',
    'import { withFileLock } from ' + JSON.stringify(atomicUrl),
    'const NL = String.fromCharCode(10)',
    'const lockFile = ' + JSON.stringify(options.lockFile),
    'const logFile = ' + JSON.stringify(options.logFile),
    'const readyFile = ' + JSON.stringify(options.readyFile),
    'const goFile = ' + JSON.stringify(options.goFile),
    'const id = ' + JSON.stringify(options.id),
    'const wait = (ms) => new Promise((done) => setTimeout(done, ms))',
    'const until = async (file, limitMs) => {',
    '  const deadline = Date.now() + limitMs',
    '  for (;;) {',
    '    try { await access(file); return true } catch (error) { void error }',
    '    if (Date.now() > deadline) return false',
    '    await wait(5)',
    '  }',
    '}',
    'await writeFile(readyFile, "ready")',
    'if (!(await until(goFile, 20000))) { console.error("child never saw the go file"); process.exit(2) }',
    'await withFileLock(lockFile, async () => {',
    '  await appendFile(logFile, id + ":enter" + NL)',
    '  await wait(300)',
    '  await appendFile(logFile, id + ":exit" + NL)',
    '}, { timeoutMs: 20000, pollMs: 10 })',
    'process.exit(0)',
  ]
  return lines.join(NL)
}

function runChild(options) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource(options)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stdout.on('data', () => {})
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return new Promise((resolveDone, rejectDone) => {
    child.on('error', rejectDone)
    child.on('exit', (code, signal) => {
      if (code === 0) resolveDone()
      else rejectDone(new Error('child ' + options.id + ' exited code=' + code + ' signal=' + signal + ' :: ' + stderr.trim()))
    })
  })
}

say('dist: ' + distCore)

// ---- state migration -----------------------------------------------------------------------

await check('migrate keeps every 1.x key, bumps version, and does not mutate its input', () => {
  const sample = v1Sample()
  const frozen = JSON.stringify(sample)
  const state = migrate(sample)
  assert.equal(STATE_VERSION, 2)
  assert.equal(schemaVersion(), 2)
  assert.equal(state.version, 2)
  for (const key of ['groups', 'collections', 'presets', 'toolDeny', 'sessions', 'scenes', 'mode', 'auto', 'lazyServers', 'lazyLoaded']) {
    assert.deepEqual(state[key], sample[key], key + ' was not carried through')
  }
  assert.deepEqual(state.settings, {}, 'settings must default to an empty map')
  assert.deepEqual(state.modules, {}, 'modules must default to an empty map')
  assert.equal(JSON.stringify(sample), frozen, 'migrate mutated its argument')
  assert.deepEqual(migrate(state), state, 'migrate is not idempotent on a v2 document')
})

await check('migrate validates field by field and keeps unknown keys', () => {
  const dirty = {
    version: 1,
    groups: 'nope',
    collections: [],
    presets: [1, null, { name: 'p' }],
    toolDeny: [1, 'mcp__a__b', null, 'mcp__c__d'],
    auto: { appliedAt: 'yesterday', extra: 1 },
    sessions: { good: ['mcp__a__b', 7], bad: 'nope', '': ['mcp__a__b'] },
    scenes: { good: { name: 'good' }, bad: 5 },
    mode: ['not', 'a', 'record'],
    settings: 'nope',
    modules: null,
    lazyServers: 'nope',
    lazyLoaded: ['mcp__files__read', 5],
    futureField: { keep: true },
  }
  const state = migrate(dirty)
  assert.deepEqual(state.groups, [], 'a wrong container type must fall back to the default')
  assert.deepEqual(state.collections, emptyState().collections, 'an empty drawer list must keep the default drawer')
  assert.deepEqual(state.presets, [{ name: 'p' }], 'non-object entries must be dropped')
  assert.deepEqual(state.toolDeny, ['mcp__a__b', 'mcp__c__d'], 'non-string denies must be dropped')
  assert.deepEqual(state.auto, { appliedAt: null, extra: 1 }, 'a non-numeric appliedAt must become null')
  assert.deepEqual(state.sessions, { good: ['mcp__a__b'] }, 'session overlays must be filtered per entry')
  assert.deepEqual(state.scenes, { good: { name: 'good' } }, 'scene values must be records')
  assert.equal(state.mode, null, 'a non-record mode must become null')
  assert.deepEqual(state.settings, {})
  assert.deepEqual(state.modules, {})
  assert.equal(state.lazyServers, undefined, 'a non-array lazyServers must not be invented')
  assert.deepEqual(state.lazyLoaded, ['mcp__files__read'])
  assert.deepEqual(state.futureField, { keep: true }, 'unknown keys must survive')
})

await check('migrate is total: every non-object document yields the empty state', () => {
  const empty = emptyState()
  for (const raw of [null, undefined, [], 'x', 42, true, () => {}, Symbol('s')]) {
    assert.deepEqual(migrate(raw), empty)
  }
})

// ---- paths --------------------------------------------------------------------------------

await checkSandbox('io paths honour TOOL_HUB_STATE_FILE and fall back to DSH_HOME', async (dir) => {
  assert.equal(resolve(io.stateFile()), resolve(join(dir, 'state.json')))
  assert.equal(resolve(io.stateDir()), resolve(dir))
  assert.equal(resolve(io.lockFile()), resolve(join(dir, '.state.lock')))
  assert.equal(resolve(io.backupDir()), resolve(join(dir, 'backups')))
  delete process.env.TOOL_HUB_STATE_FILE
  process.env.DSH_HOME = join(dir, 'home')
  assert.equal(resolve(io.stateFile()), resolve(join(dir, 'home', 'tool-hub', 'state.json')))
  assert.equal(resolve(io.lockFile()), resolve(join(dir, 'home', 'tool-hub', '.state.lock')))
})

// ---- load and recovery --------------------------------------------------------------------

await checkSandbox('a missing state file loads as a fresh install, not an error', async () => {
  const loaded = await io.loadState()
  assert.deepEqual(loaded.state, emptyState())
  assert.equal(loaded.error, null)
  assert.equal(loaded.recovered, null)
  assert.equal(loaded.quarantined, null)
})

await checkSandbox('a corrupt state file recovers from the newest backup and is quarantined', async (dir) => {
  const file = join(dir, 'state.json')
  await mkdir(join(dir, 'backups'), { recursive: true })
  const older = join(dir, 'backups', 'state-2026-01-01T00-00-00-000Z-older.json')
  const newer = join(dir, 'backups', 'state-2026-02-02T00-00-00-000Z-newer.json')
  await writeFile(older, JSON.stringify({ ...v1Sample(), groups: [{ id: 'g-old', name: 'old' }] }))
  await writeFile(newer, JSON.stringify({ ...v1Sample(), groups: [{ id: 'g-new', name: 'new' }] }))
  const corrupt = '{ "version": 1, "groups": ['
  await writeFile(file, corrupt)
  const loaded = await io.loadState()
  assert.equal(loaded.recovered, newer, 'recovery must pick the newest backup')
  assert.equal(loaded.state.version, 2)
  assert.deepEqual(loaded.state.groups, [{ id: 'g-new', name: 'new' }])
  assert.match(loaded.error ?? '', /invalid JSON/)
  assert.ok(loaded.quarantined !== null, 'the corrupt file must be moved aside')
  assert.equal(await readFile(loaded.quarantined, 'utf8'), corrupt, 'quarantine must keep the bytes')
  assert.equal(existsSync(file), false, 'the corrupt file must not stay in place')
  note('quarantined -> ' + loaded.quarantined)
  const again = await io.loadState()
  assert.equal(again.error, null, 'the next load must be clean')
  assert.deepEqual(again.state, emptyState())
})

await checkSandbox('recovery walks past backups that do not parse', async (dir) => {
  const file = join(dir, 'state.json')
  const good = join(dir, 'backups', 'state-2026-01-01T00-00-00-000Z-good.json')
  await mkdir(join(dir, 'backups'), { recursive: true })
  await writeFile(good, JSON.stringify(v1Sample()))
  await writeFile(join(dir, 'backups', 'state-2026-03-03T00-00-00-000Z-broken.json'), 'not json at all')
  await writeFile(file, '{]')
  const loaded = await io.loadState()
  assert.equal(loaded.recovered, good)
  assert.deepEqual(loaded.state.groups, v1Sample().groups)
})

await checkSandbox('a corrupt file with no usable backup is reported and left untouched', async (dir) => {
  const file = join(dir, 'state.json')
  const corrupt = 'not json'
  await writeFile(file, corrupt)
  const loaded = await io.loadState()
  assert.equal(loaded.recovered, null)
  assert.equal(loaded.quarantined, null)
  assert.match(loaded.error ?? '', /no usable backup/)
  assert.deepEqual(loaded.state, emptyState())
  assert.equal(await readFile(file, 'utf8'), corrupt, 'an unrecoverable file must stay for inspection')
})

// ---- backups ------------------------------------------------------------------------------

await checkSandbox('backupState rotates to the newest 20 files', async (dir) => {
  const file = join(dir, 'state.json')
  const made = []
  for (let index = 0; index < 25; index += 1) {
    await writeFile(file, JSON.stringify({ ...v1Sample(), mode: { name: 'round-' + index, at: index, snapshot: {} } }))
    const backup = await io.backupState('probe')
    assert.ok(backup !== null, 'backupState returned null with a state file present')
    made.push(backup)
    await delay(3)
  }
  const names = await backupNames(dir)
  assert.equal(names.length, 20, 'expected 20 backups, found ' + names.length)
  assert.equal(existsSync(made[0]), false, 'the oldest backup was not pruned')
  assert.equal(existsSync(made[4]), false, 'the fifth oldest backup was not pruned')
  assert.equal(existsSync(made[5]), true, 'the oldest kept backup was pruned')
  assert.equal(existsSync(made[24]), true, 'the newest backup was pruned')
  const newest = JSON.parse(await readFile(made[24], 'utf8'))
  assert.equal(newest.mode.name, 'round-24')
  const recent = await io.recentBackups()
  assert.equal(recent.length, 20)
  assert.equal(recent[0], made[24], 'recentBackups must be newest first')
  assert.equal(recent[19], made[5])
  note('kept ' + names[0] + ' .. ' + names[names.length - 1])
})

await checkSandbox('backupState returns null when there is nothing to back up', async () => {
  assert.equal(await io.backupState('probe'), null)
  assert.equal(existsSync(io.backupDir()), false)
})

// ---- save ---------------------------------------------------------------------------------

await checkSandbox('saveState backs up, writes v2 atomically and leaves no lock behind', async (dir) => {
  const file = join(dir, 'state.json')
  const first = await io.saveState({ ...emptyState(), settings: { theme: 'dark' } }, 'probe-first')
  assert.equal(first, null, 'the first save must not invent a backup')
  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(written.version, 2)
  assert.deepEqual(written.settings, { theme: 'dark' })
  assert.equal(existsSync(io.lockFile()), false, 'the lock survived the save')
  const second = await io.saveState({ ...emptyState(), settings: { theme: 'light' } }, 'probe-second')
  assert.ok(second !== null && existsSync(second), 'the second save must back the previous file up')
  assert.equal(JSON.parse(await readFile(second, 'utf8')).settings.theme, 'dark')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).settings.theme, 'light')
  assert.deepEqual(await backupNames(dir), [basename(second)])
  const coerced = await io.saveState({ version: 1, groups: 'nope', settings: { theme: 'x' } }, 'probe-coerce')
  assert.ok(coerced !== null)
  const afterCoerce = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(afterCoerce.version, 2, 'saveState must write a v2 document')
  assert.deepEqual(afterCoerce.groups, [], 'saveState must validate before writing')
})

// ---- atomic write -------------------------------------------------------------------------

await checkSandbox('writeFileAtomic replaces the file and leaves no temp files', async (dir) => {
  const file = join(dir, 'nested', 'doc.json')
  await atomic.writeFileAtomic(file, '{"a":1}')
  assert.equal(await readFile(file, 'utf8'), '{"a":1}')
  await atomic.writeJsonAtomic(file, { b: 2 })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { b: 2 })
  assert.deepEqual((await readdir(join(dir, 'nested'))).filter((name) => name.endsWith('.tmp')), [])
  if (process.platform !== 'win32') {
    assert.equal(((await stat(file)).mode & 0o777).toString(8), '600')
  }
  else {
    note('POSIX mode 0600 is not observable on win32')
  }
})

// ---- locks --------------------------------------------------------------------------------

await checkSandbox('a lock older than staleMs is broken instead of waited on', async (dir) => {
  const lock = join(dir, '.state.lock')
  await writeFile(lock, JSON.stringify({ pid: 999999, at: Date.now() - 70000, token: 'dead-owner' }))
  const started = Date.now()
  let ran = false
  const value = await atomic.withFileLock(lock, async () => { ran = true; return 'ok' }, { timeoutMs: 3000, staleMs: 60000 })
  const elapsed = Date.now() - started
  assert.equal(value, 'ok')
  assert.equal(ran, true, 'the critical section never ran')
  assert.ok(elapsed < 1500, 'breaking the stale lock took ' + elapsed + 'ms')
  assert.equal(existsSync(lock), false)
  note('stale lock broken in ' + elapsed + 'ms')
})

await checkSandbox('a live lock times out with LockTimeoutError and is not disturbed', async (dir) => {
  const lock = join(dir, '.state.lock')
  const payload = JSON.stringify({ pid: process.pid, at: Date.now(), token: 'live-holder' })
  await writeFile(lock, payload)
  let caught = null
  try {
    await atomic.withFileLock(lock, async () => 'never', { timeoutMs: 300, staleMs: 60000, pollMs: 20 })
  }
  catch (error) {
    caught = error
  }
  assert.ok(caught instanceof atomic.LockTimeoutError, 'expected LockTimeoutError, got ' + caught)
  assert.equal(caught.code, 'ELOCKTIMEOUT')
  assert.equal(await readFile(lock, 'utf8'), payload, 'a live lock must not be touched')
  await rm(lock, { force: true })
})

await checkSandbox('release is token-checked and idempotent', async (dir) => {
  const lock = join(dir, '.state.lock')
  await writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'owner-token' }))
  assert.equal(await atomic.releaseFileLock(lock, 'wrong-token'), false)
  assert.equal(existsSync(lock), true, 'a foreign token deleted the lock')
  assert.equal(await atomic.releaseFileLock(lock, 'owner-token'), true)
  assert.equal(existsSync(lock), false)
  assert.equal(await atomic.releaseFileLock(lock, 'owner-token'), false, 'a second release must be a no-op')
})

await checkSandbox('a failing critical section still releases the lock', async (dir) => {
  const lock = join(dir, '.state.lock')
  let caught = null
  try {
    await atomic.withFileLock(lock, async () => { throw new Error('boom') }, { timeoutMs: 2000 })
  }
  catch (error) {
    caught = error
  }
  assert.equal(caught && caught.message, 'boom')
  assert.equal(existsSync(lock), false, 'the lock leaked on the error path')
  assert.equal(await atomic.withFileLock(lock, async () => 'again', { timeoutMs: 2000 }), 'again')
})

await checkSandbox('two processes contend for one lock without interleaving', async (dir) => {
  const lock = join(dir, '.state.lock')
  const logFile = join(dir, 'critical.log')
  const goFile = join(dir, 'go')
  const ids = ['alpha', 'beta']
  const readyFiles = ids.map((id) => join(dir, 'ready-' + id))
  const children = ids.map((id) => runChild({
    id: id,
    lockFile: lock,
    logFile: logFile,
    goFile: goFile,
    readyFile: join(dir, 'ready-' + id),
  }))
  const deadline = Date.now() + 30000
  for (;;) {
    const ready = await Promise.all(readyFiles.map((file) => access(file).then(() => true, () => false)))
    if (ready.every(Boolean)) break
    if (Date.now() > deadline) throw new Error('children never became ready')
    await delay(10)
  }
  await writeFile(goFile, 'go')
  await Promise.all(children)
  const lines = (await readFile(logFile, 'utf8')).split(NL).filter((line) => line !== '')
  assert.equal(lines.length, 4, 'expected four records, saw: ' + lines.join(' | '))
  const records = lines.map((line) => line.split(':'))
  assert.deepEqual(records.map((record) => record[1]), ['enter', 'exit', 'enter', 'exit'], 'sections interleaved: ' + lines.join(' | '))
  assert.equal(records[0][0], records[1][0], 'the first section was interrupted: ' + lines.join(' | '))
  assert.equal(records[2][0], records[3][0], 'the second section was interrupted: ' + lines.join(' | '))
  assert.notEqual(records[0][0], records[2][0], 'both sections ran in the same child')
  assert.equal(existsSync(lock), false, 'the lock outlived both children')
  note('order: ' + lines.join(' -> '))
})

// ---- summary ------------------------------------------------------------------------------

for (const dir of sandboxes) await rm(dir, { recursive: true, force: true }).catch(() => {})
say('')
say('core-state probe: ' + (checks - failures) + '/' + checks + ' checks passed')
if (failures > 0) {
  say('FAIL ' + failures + ' check(s) failed')
  process.exit(1)
}
say('PASS all checks')