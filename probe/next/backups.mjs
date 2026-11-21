#!/usr/bin/env node
/**
 * backups: list both backup folders, clean conservatively, refuse unsafe requests.
 *
 * The probe runs entirely in a temp DSH_HOME; no real backup is touched.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'hub-backup-'))
const home = join(root, 'home')
const stateBackups = join(root, 'backups')
const patchBackups = join(home, 'backups')
await mkdir(stateBackups, { recursive: true })
await mkdir(patchBackups, { recursive: true })
await mkdir(join(patchBackups, 'nested'), { recursive: true })
process.env.DSH_HOME = home
process.env.TOOL_HUB_STATE_FILE = join(root, 'state.json')

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const { backupsDomain } = await import(pathToFileURL(join(distRoot, 'domains', 'backups.js')).href)
const domain = backupsDomain()
const handlers = domain.handlers
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
const now = Date.now()
const day = 24 * 60 * 60 * 1000
async function make(dir, name, bytes, ageDays) {
  const path = join(dir, name)
  await writeFile(path, 'x'.repeat(bytes))
  const at = new Date(now - ageDays * day)
  await utimes(path, at, at)
}
await make(stateBackups, 'state-new.json-1', 10, 1)
await make(stateBackups, 'state-old.json-0', 20, 40)
await make(patchBackups, 'cordis.patch-new.yml-1', 30, 2)
await make(patchBackups, 'cordis.patch-old.yml-0', 40, 50)
await writeFile(join(patchBackups, 'nested', 'not-a-backup'), 'x')

try {
  await check('ops: list is read-only, clean is write+audit', () => {
    const ops = Object.fromEntries(domain.module.ops.map(op => [op.id, op]))
    assert(ops['backup.list'].write === false, 'list write flag')
    assert(ops['backup.clean'].write === true && ops['backup.clean'].audit === true, 'clean flags')
    return Object.keys(ops).join(', ')
  })
  await check('list: both folders, newest first, directories ignored', async () => {
    const result = await handlers['backup.list']({}, {})
    equal(result.rows.length, 4)
    equal(result.rows.map(row => row.name).slice(0, 2), ['state-new.json-1', 'cordis.patch-new.yml-1'])
    equal(result.bytes, 100)
    assert(result.rows.every(row => row.kind === 'state' || row.kind === 'patch'), 'kinds')
    return result.rows.length + ' rows / ' + result.bytes + ' bytes'
  })
  await check('clean: keep=2 removes the two oldest only', async () => {
    const result = await handlers['backup.clean']({ keep: 2 }, {})
    assert(result.deleted === 2, 'deleted ' + result.deleted)
    equal(result.remaining, 2)
    equal((await readdir(stateBackups)).sort(), ['state-new.json-1'])
    equal((await readdir(patchBackups)).filter(name => name !== 'nested'), ['cordis.patch-new.yml-1'])
    assert((await readdir(patchBackups)).includes('nested'), 'subdirectory must survive')
  })
  await check('clean: keep=0 needs olderThanDays', async () => {
    const error = await refusal(handlers['backup.clean']({ keep: 0 }, {}))
    assert(error !== null && error.code === 'confirm-required', String(error))
  })
  await check('clean: olderThanDays keeps recent files even past keep', async () => {
    await make(stateBackups, 'state-old2.json-0', 5, 40)
    const result = await handlers['backup.clean']({ keep: 1, olderThanDays: 30 }, {})
    assert(result.deleted === 1, 'deleted ' + result.deleted)
    assert((await readdir(stateBackups)).includes('state-new.json-1'), 'recent kept')
    assert(!(await readdir(stateBackups)).includes('state-old2.json-0'), 'old removed')
  })
  await check('clean: an out-of-range keep is refused', async () => {
    const error = await refusal(handlers['backup.clean']({ keep: 9999 }, {}))
    assert(error !== null && error.code === 'bad-payload', String(error))
  })
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log('\nbackups probe: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
