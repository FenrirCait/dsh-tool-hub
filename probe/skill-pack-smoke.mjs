// Exercises lib/skill-pack.js against real files on disk and against zips this
// script writes byte by byte, so both the store and the deflate path are read
// back through code that shares nothing with the reader.
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { NAME_PATTERN, commitSkillDir, installSkills, inspectSource, moveSkill, moveSkillDir } from '../lib/skill-pack.js'

let passed = 0
let failed = 0
function check(name, condition, detail) {
    if (condition === true) {
        passed += 1
        console.log(`  ok   ${name}`)
    }
    else {
        failed += 1
        console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
    }
}

async function expectThrow(name, run, code) {
    try {
        await run()
        check(name, false, 'resolved instead of throwing')
    }
    catch (error) {
        check(name, error?.code === code, `code=${error?.code} message=${error?.message}`)
    }
}

async function exists(path) {
    try {
        await stat(path)
        return true
    }
    catch {
        return false
    }
}

// ── zip writer (mirror image of the reader's assumptions) ────────────────────
const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
        let value = index
        for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
        table[index] = value >>> 0
    }
    return table
})()

function crc32(buffer) {
    let value = 0xFFFFFFFF
    for (let index = 0; index < buffer.length; index += 1) {
        value = CRC_TABLE[(value ^ buffer[index]) & 0xFF] ^ (value >>> 8)
    }
    return (value ^ 0xFFFFFFFF) >>> 0
}

/** Build a zip: local headers, central directory, EOCD. No extras, no comments.
 *  `declaredSize` / `crcOverride` let a test write headers that lie, which is how
 *  the reader's size cap and CRC check get exercised. */
function makeZip(entries) {
    const localParts = []
    const centralParts = []
    let offset = 0
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8')
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
        const method = entry.method === 'store' ? 0 : 8
        const body = method === 8 ? deflateRawSync(data) : data
        const crc = entry.crcOverride ?? crc32(data)
        const size = entry.declaredSize ?? data.length

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034B50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0x0800, 6)
        local.writeUInt16LE(method, 8)
        local.writeUInt16LE(0, 10)
        local.writeUInt16LE(0x21, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(body.length, 18)
        local.writeUInt32LE(size, 22)
        local.writeUInt16LE(name.length, 26)
        local.writeUInt16LE(0, 28)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014B50, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(0x0800, 8)
        central.writeUInt16LE(method, 10)
        central.writeUInt16LE(0, 12)
        central.writeUInt16LE(0x21, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(body.length, 20)
        central.writeUInt32LE(size, 24)
        central.writeUInt16LE(name.length, 28)
        central.writeUInt16LE(0, 30)
        central.writeUInt16LE(0, 32)
        central.writeUInt16LE(0, 34)
        central.writeUInt16LE(0, 36)
        central.writeUInt32LE(0, 38)
        central.writeUInt32LE(offset, 42)

        localParts.push(local, name, body)
        centralParts.push(central, name)
        offset += local.length + name.length + body.length
    }
    const directory = Buffer.concat(centralParts)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054B50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(directory.length, 12)
    eocd.writeUInt32LE(offset, 16)
    eocd.writeUInt16LE(0, 20)
    return Buffer.concat([...localParts, directory, eocd])
}

async function writeZip(path, entries) {
    await writeFile(path, makeZip(entries))
    return path
}

// ── fixtures ────────────────────────────────────────────────────────────────
const root = await mkdtemp(join(tmpdir(), 'skill-pack-smoke-'))
console.log(`skill-pack smoke (${root})`)

const soloText = ['---', 'name: solo', 'description: a single markdown skill', '---', '', '# Solo', '', 'Body of solo.', ''].join('\n')
const soloPath = join(root, 'solo.md')
await writeFile(soloPath, soloText)
await writeFile(join(root, 'plain-title.md'), '# No frontmatter\n\nJust prose.\n')

const bundleDir = join(root, 'bundle')
await mkdir(join(bundleDir, 'alpha'), { recursive: true })
await mkdir(join(bundleDir, 'beta'), { recursive: true })
await mkdir(join(bundleDir, 'notes'), { recursive: true })
await writeFile(join(bundleDir, 'alpha', 'SKILL.md'), '# Alpha\n\nAlpha does alpha things.\n')
await writeFile(join(bundleDir, 'alpha', 'helper.txt'), 'alpha-helper')
await writeFile(join(bundleDir, 'beta', 'SKILL.md'), '---\nname: beta-two\ndescription: second skill\n---\n\n# Beta\n')
await mkdir(join(bundleDir, 'beta', 'sub'), { recursive: true })
await writeFile(join(bundleDir, 'beta', 'sub', 'deep.txt'), 'nested')
await writeFile(join(bundleDir, 'notes', 'readme.txt'), 'not a skill')

const zipPath = await writeZip(join(root, 'bundle.zip'), [
    { name: 'one/', data: '', method: 'store' },
    { name: 'one/SKILL.md', data: '---\nname: one\ndescription: deflated skill\n---\n\nOne.\n', method: 'deflate' },
    { name: 'one/data.txt', data: 'stored-payload', method: 'store' },
    { name: 'two/SKILL.md', data: '---\nname: two-zip\n---\n\nTwo.\n', method: 'deflate' },
])

// ── 1. single .md ───────────────────────────────────────────────────────────
console.log('\nsingle .md')
const solo = await inspectSource(soloPath)
check('kind is file', solo.kind === 'file', solo.kind)
check('one skill', solo.skills.length === 1, String(solo.skills.length))
check('name from frontmatter', solo.skills[0].name === 'solo', solo.skills[0].name)
check('description from frontmatter', solo.skills[0].description === 'a single markdown skill', solo.skills[0].description)
check('stored as SKILL.md', solo.skills[0].files.has('SKILL.md'))
check('bytes preserved', solo.skills[0].files.get('SKILL.md').toString('utf8') === soloText)

const plain = await inspectSource(join(root, 'plain-title.md'))
check('name falls back to the file stem', plain.skills[0].name === 'plain-title', plain.skills[0].name)
check('description falls back to prose', plain.skills[0].description === 'Just prose.', plain.skills[0].description)

// ── 2. directory with two skills ────────────────────────────────────────────
console.log('\ndirectory bundle')
const dirBundle = await inspectSource(bundleDir)
check('kind is dir', dirBundle.kind === 'dir', dirBundle.kind)
check('two skills, non-skill dir ignored', dirBundle.skills.length === 2, String(dirBundle.skills.length))
check('names in sorted order', dirBundle.skills.map(skill => skill.name).join(',') === 'alpha,beta-two', dirBundle.skills.map(skill => skill.name).join(','))
const alpha = dirBundle.skills.find(skill => skill.name === 'alpha')
check('alpha files are relative', [...alpha.files.keys()].sort().join(',') === 'SKILL.md,helper.txt', [...alpha.files.keys()].sort().join(','))
check('alpha description from body', alpha.description === 'Alpha does alpha things.', alpha.description)
check('nested file kept', dirBundle.skills.find(skill => skill.name === 'beta-two').files.has('sub/deep.txt'))

// ── 3. zip, both compression methods ────────────────────────────────────────
console.log('\nzip bundle')
const zipBundle = await inspectSource(zipPath)
check('kind is zip', zipBundle.kind === 'zip', zipBundle.kind)
check('two skills from top-level dirs', zipBundle.skills.length === 2, String(zipBundle.skills.length))
check('zip names', zipBundle.skills.map(skill => skill.name).join(',') === 'one,two-zip', zipBundle.skills.map(skill => skill.name).join(','))
const one = zipBundle.skills.find(skill => skill.name === 'one')
check('directory entry skipped, payload kept', [...one.files.keys()].sort().join(',') === 'SKILL.md,data.txt', [...one.files.keys()].sort().join(','))
check('stored entry decoded', one.files.get('data.txt').toString('utf8') === 'stored-payload', one.files.get('data.txt').toString('utf8'))
check('deflated entry decoded', one.files.get('SKILL.md').toString('utf8').includes('One.'), one.files.get('SKILL.md').toString('utf8'))
check('description parsed from deflated SKILL.md', one.description === 'deflated skill', one.description)

// ── 4. hostile zips ─────────────────────────────────────────────────────────
console.log('\nhostile zips')
const escapeZip = await writeZip(join(root, 'escape.zip'), [
    { name: '../evil.md', data: 'pwned', method: 'store' },
    { name: 'ok/SKILL.md', data: '# ok\n', method: 'deflate' },
])
await expectThrow('path traversal is refused', () => inspectSource(escapeZip), 'unsafe-entry')

const absoluteZip = await writeZip(join(root, 'absolute.zip'), [
    { name: '/etc/passwd', data: 'x', method: 'store' },
])
await expectThrow('absolute entry is refused', () => inspectSource(absoluteZip), 'unsafe-entry')

const driveZip = await writeZip(join(root, 'drive.zip'), [
    { name: 'C:/Windows/System32/x.dll', data: 'x', method: 'store' },
])
await expectThrow('drive-qualified entry is refused', () => inspectSource(driveZip), 'unsafe-entry')

const deepEscapeZip = await writeZip(join(root, 'deep.zip'), [
    { name: 'skill/../../escape.md', data: 'x', method: 'store' },
])
await expectThrow('nested traversal is refused', () => inspectSource(deepEscapeZip), 'unsafe-entry')

const sourceLink = join(root, 'source-link')
await mkdir(sourceLink, { recursive: true })
await writeFile(join(sourceLink, 'SKILL.md'), '# linked source\n')
const linkTarget = join(root, 'link-target')
await mkdir(linkTarget, { recursive: true })
const sourceSymlinkError = await makeDirLink(linkTarget, join(sourceLink, 'linked-dir'))
if (sourceSymlinkError === null) {
    await expectThrow('symlink directory source is refused', () => inspectSource(sourceLink), 'unsafe-entry')
}
else {
    check('symlink directory source is refused', false, String(sourceSymlinkError))
}

const duplicateZip = await writeZip(join(root, 'duplicate.zip'), [
    { name: 'dup/SKILL.md', data: '# one\n', method: 'store' },
    { name: 'dup/SKILL.md', data: '# two\n', method: 'store' },
])
await expectThrow('duplicate zip entry is refused', () => inspectSource(duplicateZip), 'duplicate-entry')

const truncated = join(root, 'truncated.zip')
await writeFile(truncated, Buffer.from('definitely not a zip'))
await expectThrow('non-zip bytes are refused', () => inspectSource(truncated), 'bad-zip')

const lyingZip = await writeZip(join(root, 'lying-size.zip'), [
    { name: 'liar/SKILL.md', data: `# liar\n${'x'.repeat(4096)}`, method: 'deflate', declaredSize: 8 },
])
await expectThrow('an entry that inflates past its declared size is refused', () => inspectSource(lyingZip), 'bad-zip')

const badCrcZip = await writeZip(join(root, 'bad-crc.zip'), [
    { name: 'crc/SKILL.md', data: '# crc\n', method: 'store', crcOverride: 0xDEADBEEF },
])
await expectThrow('a bad CRC is refused', () => inspectSource(badCrcZip), 'bad-zip')

// ── 5. install ──────────────────────────────────────────────────────────────
console.log('\ninstall')
const skillsRoot = join(root, 'skills')
const first = await installSkills(solo, skillsRoot)
check('single md installed', first.added.join(',') === 'solo', JSON.stringify(first))
check('single md landed as SKILL.md', (await readFile(join(skillsRoot, 'solo', 'SKILL.md'), 'utf8')) === soloText)

const again = await installSkills(solo, skillsRoot)
check('same name is skipped', again.added.length === 0 && again.skipped.length === 1, JSON.stringify(again))
check('skip reason is exists', again.skipped[0]?.reason === 'exists', JSON.stringify(again.skipped))

const changed = await inspectSource(soloPath)
changed.skills[0].files.set('SKILL.md', Buffer.from('---\nname: solo\n---\n\nRewritten.\n'))
const overwritten = await installSkills(changed, skillsRoot, { overwrite: true })
check('overwrite replaces', overwritten.added.join(',') === 'solo', JSON.stringify(overwritten))
check('overwrite wrote new bytes', (await readFile(join(skillsRoot, 'solo', 'SKILL.md'), 'utf8')).includes('Rewritten.'))
check('overwrite removes its trash', (await readdir(skillsRoot)).every(name => !name.startsWith('.trash-skill-')), (await readdir(skillsRoot)).join(','))

const dirInstall = await installSkills(dirBundle, skillsRoot)
check('directory bundle installed', dirInstall.added.sort().join(',') === 'alpha,beta-two', JSON.stringify(dirInstall))
check('nested file installed', (await readFile(join(skillsRoot, 'beta-two', 'sub', 'deep.txt'), 'utf8')) === 'nested')

const zipInstall = await installSkills(zipBundle, skillsRoot)
check('zip bundle installed', zipInstall.added.sort().join(',') === 'one,two-zip', JSON.stringify(zipInstall))

const invalidBundle = [
    { name: 'Bad Name', description: '', files: new Map([['SKILL.md', Buffer.from('# x')]]) },
    { name: 'UPPER', description: '', files: new Map([['SKILL.md', Buffer.from('# x')]]) },
    { name: 'no-readme', description: '', files: new Map([['notes.md', Buffer.from('x')]]) },
    { name: 'escape', description: '', files: new Map([['SKILL.md', Buffer.from('# x')], ['../evil.md', Buffer.from('x')]]) },
    { name: 'good-one', description: '', files: new Map([['SKILL.md', Buffer.from('# fine')]]) },
]
const invalid = await installSkills(invalidBundle, skillsRoot)
check('only the valid one installs', invalid.added.join(',') === 'good-one', JSON.stringify(invalid))
check('four invalid skips', invalid.skipped.filter(skip => skip.reason === 'invalid').length === 4, JSON.stringify(invalid.skipped))
check('invalid name not created', !(await exists(join(skillsRoot, 'Bad Name'))))
check('missing SKILL.md named in detail', invalid.skipped.some(skip => skip.name === 'no-readme' && /SKILL\.md/.test(skip.detail)), JSON.stringify(invalid.skipped))
check('NAME_PATTERN rejects uppercase', NAME_PATTERN.test('UPPER') === false)

// ── 5b. path shape ──────────────────────────────────────────────────────────
console.log('\npath shape')
const readme = Buffer.from('# shape\n')
const shapeBundle = [
    { name: 'shape-empty', files: new Map([['SKILL.md', readme], ['foo//bar', readme]]) },
    { name: 'shape-dot', files: new Map([['SKILL.md', readme], ['foo/./bar', readme]]) },
    { name: 'shape-up', files: new Map([['SKILL.md', readme], ['foo/../bar', readme]]) },
    { name: 'shape-nul', files: new Map([['SKILL.md', readme], ['foo/\0bar', readme]]) },
    { name: 'shape-trailing', files: new Map([['SKILL.md', readme], ['foo/', readme]]) },
    { name: 'shape-backslash', files: new Map([['SKILL.md', readme], ['foo\\bar', readme]]) },
    { name: 'shape-device', files: new Map([['SKILL.md', readme], ['nul.md', readme]]) },
    { name: 'shape-good', files: new Map([['SKILL.md', readme], ['sub/dir/file.txt', Buffer.from('deep')]]) },
]
const shape = await installSkills(shapeBundle, join(root, 'skills-shape'))
check('only the well-formed skill installs', shape.added.join(',') === 'shape-good', JSON.stringify(shape))
check('seven malformed paths are invalid', shape.skipped.length === 7 && shape.skipped.every(skip => skip.reason === 'invalid'), JSON.stringify(shape.skipped))
check('a legit nested path is written', (await readFile(join(root, 'skills-shape', 'shape-good', 'sub', 'dir', 'file.txt'), 'utf8')) === 'deep')
check('a rejected skill creates no directory', !(await exists(join(root, 'skills-shape', 'shape-empty'))))
check('detail names the offending path', shape.skipped.some(skip => skip.name === 'shape-empty' && skip.detail.includes('foo//bar')), JSON.stringify(shape.skipped))

// ── 5c. a failed overwrite must not eat the installed skill ─────────────────
console.log('\noverwrite failure')
const blocker = [
    { name: 'solo', files: new Map([['SKILL.md', Buffer.from('# clobbered\n')], ['blocker', readme], ['blocker/child', readme]]) },
]
let clobberError = null
try {
    await installSkills(blocker, skillsRoot, { overwrite: true })
}
catch (error) {
    clobberError = error
}
check('a failed overwrite throws', clobberError !== null, String(clobberError))
check('a failed overwrite keeps the old skill', (await readFile(join(skillsRoot, 'solo', 'SKILL.md'), 'utf8')).includes('Rewritten.'))
check('a failed overwrite leaves no scratch directories', (await readdir(skillsRoot)).every(name => !name.startsWith('.tmp-skill-') && !name.startsWith('.trash-skill-')), (await readdir(skillsRoot)).join(','))

// The second rename is the one that puts the new skill in place; if it fails the
// old directory has already been moved aside and has to come back.
const rollbackRoot = join(root, 'rollback')
await mkdir(rollbackRoot, { recursive: true })
const victim = join(rollbackRoot, 'victim')
await mkdir(victim, { recursive: true })
await writeFile(join(victim, 'SKILL.md'), 'old')
const staged = await mkdtemp(join(rollbackRoot, '.tmp-skill-'))
await writeFile(join(staged, 'SKILL.md'), 'new')
let renameCalls = 0
const flakyRename = async (from, to) => {
    renameCalls += 1
    if (renameCalls === 2) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' })
    return rename(from, to)
}
await expectThrow('the injected rename failure surfaces', () => commitSkillDir(staged, victim, { renameDir: flakyRename }), 'EIO')
check('rollback restored the old skill', (await readFile(join(victim, 'SKILL.md'), 'utf8')) === 'old')
check('rollback left no trash behind', (await readdir(rollbackRoot)).every(name => !name.startsWith('.trash-skill-')), (await readdir(rollbackRoot)).join(','))
check('the unpublished copy is left for the caller to clean', await exists(staged))
await rm(staged, { recursive: true, force: true })

// ── 6. move ─────────────────────────────────────────────────────────────────
console.log('\nmove')
const otherRoot = join(root, 'skills-other')
await mkdir(otherRoot, { recursive: true })
const moved = await moveSkill(join(skillsRoot, 'alpha'), otherRoot)
check('move returns destination', moved.to === join(otherRoot, 'alpha'), moved.to)
check('moved skill present', (await readFile(join(otherRoot, 'alpha', 'SKILL.md'), 'utf8')).includes('Alpha'))
check('moved skill still has its files', (await readFile(join(otherRoot, 'alpha', 'helper.txt'), 'utf8')) === 'alpha-helper')
check('source is gone', !(await exists(join(skillsRoot, 'alpha'))))

await mkdir(join(otherRoot, 'one'), { recursive: true })
await expectThrow('existing destination is refused', () => moveSkill(join(skillsRoot, 'one'), otherRoot), 'exists')
await expectThrow('missing source is refused', () => moveSkill(join(skillsRoot, 'nope'), otherRoot), 'not-found')
await expectThrow('moving into itself is refused', () => moveSkill(join(skillsRoot, 'solo'), join(skillsRoot, 'solo')), 'bundle')
check('refused move left the source in place', await exists(join(skillsRoot, 'one')))

// ── 6b. cross-volume move (EXDEV) ───────────────────────────────────────────
// A real second volume cannot be assumed, so the rename is made to report EXDEV;
// everything after that point — the link scan, the copy, the source removal — is
// the real code.
console.log('\ncross-volume move')
const exdevRoot = join(root, 'exdev')
const exdevSource = join(exdevRoot, 'source')
const exdevTarget = join(exdevRoot, 'target')
await mkdir(join(exdevSource, 'mover'), { recursive: true })
await writeFile(join(exdevSource, 'mover', 'SKILL.md'), '# mover\n')
await writeFile(join(exdevSource, 'mover', 'data.txt'), 'payload')
const crossDevice = async () => {
    throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
}
const crossed = await moveSkillDir(join(exdevSource, 'mover'), exdevTarget, { renameDir: crossDevice })
check('cross-volume move reports the destination', crossed.to === join(exdevTarget, 'mover'), crossed.to)
check('cross-volume move copied the files', (await readFile(join(exdevTarget, 'mover', 'data.txt'), 'utf8')) === 'payload')
check('cross-volume move removed the source', !(await exists(join(exdevSource, 'mover'))))

// A junction on Windows and a directory symlink elsewhere: both are links, which
// is what the scan has to see before a copy is allowed to run.
async function makeDirLink(target, path) {
    try {
        await symlink(resolve(target), path, process.platform === 'win32' ? 'junction' : 'dir')
        return null
    }
    catch (error) {
        return error
    }
}

await mkdir(join(exdevSource, 'linked'), { recursive: true })
await mkdir(join(exdevSource, 'shared'), { recursive: true })
await writeFile(join(exdevSource, 'linked', 'SKILL.md'), '# linked\n')
await writeFile(join(exdevSource, 'shared', 'secret.txt'), 'outside-the-skill')
const linkError = await makeDirLink(join(exdevSource, 'shared'), join(exdevSource, 'linked', 'shared-link'))
check('the fixture link exists', linkError === null, String(linkError))

await expectThrow('a linked tree is refused before copying', () => moveSkillDir(join(exdevSource, 'linked'), exdevTarget, { renameDir: crossDevice }), 'unsafe-entry')
check('the refused tree is still whole', await exists(join(exdevSource, 'linked', 'SKILL.md')))
check('the refused move copied nothing into the target', !(await exists(join(exdevTarget, 'linked'))))
check('the link still points outside', (await readFile(join(exdevSource, 'linked', 'shared-link', 'secret.txt'), 'utf8')) === 'outside-the-skill')

// ── done ────────────────────────────────────────────────────────────────────
await rm(root, { recursive: true, force: true })
console.log(`\n${passed}/${passed + failed} passed`)
if (failed > 0) process.exitCode = 1
