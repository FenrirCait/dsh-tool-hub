#!/usr/bin/env node
/**
 * trash: the retention sweep removes old trash folders, keeps recent ones and can be switched off.
 *
 * Everything runs against a temp state file (TOOL_HUB_STATE_FILE) with DSH_HOME redirected too, so
 * no real trash folder — and no real skill — is touched. Entries are created the way deleteSkill
 * makes them: one directory per deleted skill, holding a meta.json.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'hub-trash-'))
process.env.DSH_HOME = join(root, 'home')
process.env.TOOL_HUB_STATE_FILE = join(root, 'state.json')

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const { cleanupTrash, trashDir, skillsDomain } = await import(pathToFileURL(join(distRoot, 'domains', 'skills.js')).href)
const domain = skillsDomain()

let pass = 0
let fail = 0
function check(name, run) {
  return Promise.resolve().then(run)
    .then(detail => { pass += 1; console.log('PASS ' + name + (detail === undefined ? '' : '  ' + detail)) })
    .catch(error => { fail += 1; console.log('FAIL ' + name + '  ' + (error && error.message ? error.message : String(error))) })
}
function assert(condition, message) { if (!condition) throw new Error(message) }
function equal(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error((label ?? 'expected') + ' ' + right + ', got ' + left)
}

const day = 24 * 60 * 60 * 1000
const trash = trashDir()

/** One trash entry as deleteSkill leaves it: a folder with meta.json, dated by its mtime. */
async function makeEntry(name, ageDays) {
  const item = join(trash, name)
  await mkdir(item, { recursive: true })
  await writeFile(join(item, 'meta.json'), JSON.stringify({ name, at: new Date(Date.now() - ageDays * day).toISOString() }) + '\n')
  const at = new Date(Date.now() - ageDays * day)
  await utimes(item, at, at)
  return item
}

let sweep = null
try {
  await check('old: an entry past the retention is removed', async () => {
    await makeEntry('1000-old', 40)
    await makeEntry('2000-recent', 1)
    sweep = await cleanupTrash(30)
    assert(sweep.deleted === 1, 'deleted ' + sweep.deleted)
    const left = await readdir(trash)
    assert(!left.includes('1000-old'), 'old entry survived: ' + left.join(','))
    return 'deleted ' + sweep.deleted + ' / kept ' + sweep.kept
  })
  await check('recent: an entry inside the retention stays', async () => {
    assert(sweep !== null, 'the first sweep did not run')
    assert(sweep.kept === 1, 'kept ' + sweep.kept)
    const left = await readdir(trash)
    assert(left.includes('2000-recent'), 'recent entry vanished: ' + left.join(','))
    return 'kept ' + sweep.kept
  })
  await check('keepDays 0: the sweep is a no-op', async () => {
    await makeEntry('3000-old', 40)
    equal(await cleanupTrash(0), { deleted: 0, kept: 0 }, 'keepDays 0 result')
    assert((await readdir(trash)).includes('3000-old'), 'keepDays 0 removed an entry')
    return 'deleted 0, entry intact'
  })
  await check('missing dir: a fresh install reports zeros', async () => {
    await rm(trash, { recursive: true, force: true })
    equal(await cleanupTrash(30), { deleted: 0, kept: 0 }, 'missing dir result')
    return 'deleted 0 / kept 0'
  })
  await check('op: skill.trashClean is write+audit and sweeps by the declared setting', async () => {
    const ops = Object.fromEntries(domain.module.ops.map(op => [op.id, op]))
    const op = ops['skill.trashClean']
    assert(op !== undefined, 'skill.trashClean is not declared')
    assert(op.write === true && op.audit === true, 'flags: write=' + op.write + ' audit=' + op.audit)
    const fields = domain.module.settings ?? []
    const field = fields.find(item => item.key === 'skills.trashKeepDays')
    assert(field !== undefined, 'skills.trashKeepDays is not declared')
    assert(field.type === 'number', 'setting type ' + field.type)
    assert(field.default === 30 && field.min === 0 && field.max === 3650, 'setting ' + JSON.stringify({ default: field.default, min: field.min, max: field.max }))
    const env = { state: { settings: { 'skills.trashKeepDays': 30 } } }
    await makeEntry('4000-old', 40)
    const swept = await domain.handlers['skill.trashClean']({}, env)
    assert(swept.ok === true && swept.deleted === 1 && swept.days === 30, JSON.stringify(swept))
    assert(!(await readdir(trash)).includes('4000-old'), 'the op left the old entry behind')
    const off = await domain.handlers['skill.trashClean']({ days: 0 }, env)
    assert(off.ok === true && off.deleted === 0 && off.days === 0, JSON.stringify(off))
    return 'write+audit, deleted 1 at 30 days, days:0 a no-op'
  })
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log('\ntrash probe: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
