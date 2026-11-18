/**
 * Skill bundles arrive in three shapes: one `.md` file, a directory that either
 * *is* a skill or holds one directory per skill, or a `.zip`. This module reads
 * all three into one shape — `{ name, description, files }`, where `files` is a
 * Map of skill-relative POSIX paths to Buffers and `SKILL.md` is always one of
 * the keys — then installs them under `<root>/<name>/` or moves an installed
 * skill between roots.
 *
 * Self-contained on purpose: `node:fs`, `node:path`, `node:zlib` and nothing
 * else. The panel has to run inside a profile whose dependency tree we do not
 * control, so a bundle reader may not pull a zip library into it.
 *
 * The zip reader is deliberately small and strict: store + deflate only, no
 * zip64, no encryption, no symlink entries, and every entry name must stay
 * inside the archive. A bundle that fails those rules is a bundle we refuse to
 * extract rather than one we extract partially.
 */
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const SKILL_FILE = 'SKILL.md'
/** A skill name has to be safe as a directory name on every platform. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

const EOCD_SIG = 0x06054B50
const CENTRAL_SIG = 0x02014B50
const LOCAL_SIG = 0x04034B50
const ZIP_FLAG_ENCRYPTED = 0x0001
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
/** A skill being replaced parks here, inside the same root, until the new one lands. */
const TRASH_PREFIX = '.trash-skill-'
/** Windows resolves these to devices whatever the extension, so a file with one of these names silently vanishes. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export class SkillPackError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SkillPackError'
    this.code = code
  }
}

function fail(code, message) {
  throw new SkillPackError(code, message)
}

// ── frontmatter ──────────────────────────────────────────────────────────────

/** Split a markdown file into its leading `---` block and the body below it. */
export function parseFrontmatter(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (!source.startsWith('---')) return { fields: {}, body: source }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { fields: {}, body: source }
  const fields = {}
  for (const line of source.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (value.length > 1 && (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    fields[match[1]] = value
  }
  const close = source.indexOf('\n', end + 1)
  return { fields, body: close === -1 ? '' : source.slice(close + 1) }
}

/** First line of the body that carries prose rather than a heading or a fence. */
function proseLine(body, max = 200) {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('```')) continue
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }
  return ''
}

/**
 * A fallback name (directory or file stem) is normalised: non-ASCII cannot pass
 * NAME_PATTERN anyway, so it folds to `skill` instead of failing installation
 * later. A `name:` from frontmatter is never rewritten — if it is unusable the
 * install step reports it as `invalid`, which the user can see and fix.
 */
function slug(raw) {
  const cleaned = String(raw)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'skill' : cleaned.slice(0, 64)
}

function toSkill(files, fallbackName) {
  const readme = files.get(SKILL_FILE)
  const { fields, body } = readme === undefined ? { fields: {}, body: '' } : parseFrontmatter(readme.toString('utf8'))
  const declared = typeof fields.name === 'string' ? fields.name.trim() : ''
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''
  return {
    name: declared === '' ? slug(fallbackName) : declared,
    description: description === '' ? proseLine(body) : description,
    files,
  }
}

// ── directory sources ────────────────────────────────────────────────────────

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  }
  catch {
    return false
  }
}

/** True for anything at `path`, including a dangling link — which `stat` misses. */
async function entryExists(path) {
  try {
    await lstat(path)
    return true
  }
  catch {
    return false
  }
}

/** Every regular file under `root`, keyed by a POSIX path relative to it. */
async function collectDir(root) {
  const files = new Map()
  async function walk(abs, rel) {
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    }
    catch (error) {
      fail('unreadable', `cannot read ${abs}: ${error.message}`)
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      // Never follow a link out of the bundle: what gets copied has to be what
      // the directory itself contains.
             if (entry.isSymbolicLink()) fail('unsafe-entry', `symbolic link at "${rel === '' ? entry.name : `${rel}/${entry.name}`}"`)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        await walk(join(abs, entry.name), childRel)
      }
      else if (entry.isFile()) {
        files.set(childRel, await readFile(join(abs, entry.name)))
      }
    }
  }
  await walk(root, '')
  return files
}

/** A directory is one skill if it holds SKILL.md, else its children each are. */
async function inspectDir(abs) {
  if (await isFile(join(abs, SKILL_FILE))) {
    return [toSkill(await collectDir(abs), basename(abs))]
  }
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  }
  catch (error) {
    fail('unreadable', `cannot read ${abs}: ${error.message}`)
  }
     entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const skills = []
  for (const entry of entries) {
         if (entry.isSymbolicLink()) fail('unsafe-entry', `symbolic link at "${entry.name}"`)
     if (!entry.isDirectory()) continue
     const child = join(abs, entry.name)
    if (!(await isFile(join(child, SKILL_FILE)))) continue
    skills.push(toSkill(await collectDir(child), entry.name))
  }
  return skills
}

// ── zip sources ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(buffer) {
  let value = 0xFFFFFFFF
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xFF] ^ (value >>> 8)
  }
  return (value ^ 0xFFFFFFFF) >>> 0
}

function findEocd(buffer) {
  const minimum = 22
  if (buffer.length < minimum) fail('bad-zip', 'file is too short to be a zip archive')
  const lowest = Math.max(0, buffer.length - 65557)
  for (let at = buffer.length - minimum; at >= lowest; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIG) return at
  }
  return fail('bad-zip', 'no end-of-central-directory record')
}

/**
 * Why a skill-relative path is unusable, or null when it is fine.
 *
 * A relative path inside a skill has exactly one spelling: `/`-separated, no
 * leading or trailing separator, no empty / `.` / `..` segment, no NUL, no
 * backslash, no drive letter. This returns a reason instead of quietly
 * normalising, because a repaired key no longer names the file the caller
 * thought it named, and two keys could collapse onto one path after repair.
 */
function relProblem(value) {
  if (value === '') return 'is empty'
  if (value.includes('\0')) return 'contains a NUL'
  if (value.includes('\\')) return 'uses a backslash separator'
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'is an absolute path'
  if (value.endsWith('/')) return 'ends with a separator'
  for (const segment of value.split('/')) {
    if (segment === '') return 'has an empty path segment'
    if (segment === '.') return 'has a "." segment'
    if (segment === '..') return 'escapes the skill directory'
    if (/^[A-Za-z]:/.test(segment)) return 'has a drive letter in a segment'
    if (WINDOWS_RESERVED.test(segment)) return `uses the reserved device name "${segment}"`
    if (/[ .]$/.test(segment)) return `ends with a space or a dot: "${segment}"`
  }
  return null
}

/**
 * An entry name has to name a path *inside* the bundle. A backslash is read as
 * a separator first, so a zip written on Windows cannot smuggle `..\..\x`
 * past the traversal check; the resulting name is still held to relProblem.
 */
function safeEntryPath(raw, index) {
  const name = raw.replaceAll('\\', '/')
  if (name === '') fail('unsafe-entry', `zip entry ${index} has an empty name`)
  const directory = name.endsWith('/')
  const bare = directory ? name.slice(0, -1) : name
  const problem = relProblem(bare)
  if (problem !== null) fail('unsafe-entry', `zip entry "${name}" ${problem}`)
  return { name, directory }
}

/** Read store/deflate entries, verifying sizes and CRC so corruption is loud. */
function readZipEntries(buffer) {
  const eocd = findEocd(buffer)
  const count = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    fail('bad-zip', 'zip64 archives are not supported')
  }
  if (count === 0) fail('bad-zip', 'archive holds no entries')
  if (cdOffset + cdSize > buffer.length) fail('bad-zip', 'central directory runs past the end of the file')

  const entries = []
  let total = 0
  let at = cdOffset
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length) fail('bad-zip', 'central directory is truncated')
    if (buffer.readUInt32LE(at) !== CENTRAL_SIG) fail('bad-zip', `bad central directory signature at entry ${index}`)
    const madeBy = buffer.readUInt16LE(at + 4)
    const flags = buffer.readUInt16LE(at + 8)
    const method = buffer.readUInt16LE(at + 10)
    const crc = buffer.readUInt32LE(at + 16)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const size = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const external = buffer.readUInt32LE(at + 38)
    const localOffset = buffer.readUInt32LE(at + 42)
    // Bit 11 is a hint only; we always decode UTF-8. A DOS-era CP437 name with
    // non-ASCII bytes mis-decodes, which is visible immediately and far less
    // surprising than silently mangling it through a half-implemented table.
    const rawName = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    at += 46 + nameLength + extraLength + commentLength

    const { name, directory } = safeEntryPath(rawName, index)
    if ((flags & ZIP_FLAG_ENCRYPTED) !== 0) fail('bad-zip', `zip entry "${name}" is encrypted`)
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      fail('bad-zip', `zip entry "${name}" uses unsupported compression method ${method}`)
    }
    // Unix hosts stamp the file mode into the high half of external attributes;
    // a symlink entry would let a later read follow it out of the bundle.
    if ((madeBy >>> 8 === 3 || madeBy >>> 8 === 19) && ((external >>> 16) & 0xF000) === 0xA000) {
      fail('unsafe-entry', `zip entry "${name}" is a symbolic link`)
    }
    if (directory) {
      entries.push({ name, dir: true, data: null })
      continue
    }
    if (size > MAX_ENTRY_BYTES) fail('bad-zip', `zip entry "${name}" is larger than ${MAX_ENTRY_BYTES} bytes`)
    total += size
    if (total > MAX_TOTAL_BYTES) fail('bad-zip', `archive expands past ${MAX_TOTAL_BYTES} bytes`)

    if (localOffset + 30 > buffer.length) fail('bad-zip', `zip entry "${name}" points outside the file`)
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) fail('bad-zip', `bad local header for "${name}"`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    if (start + compressedSize > buffer.length) fail('bad-zip', `zip entry "${name}" is truncated`)
    const raw = buffer.subarray(start, start + compressedSize)

    let data
    if (method === METHOD_STORE) {
      if (compressedSize !== size) fail('bad-zip', `stored entry "${name}" has mismatched sizes`)
      data = Buffer.from(raw)
    }
    else {
      try {
        // Cap the output at the size the header promised: a hostile archive can
        // claim a tiny entry and inflate to gigabytes, and zlib would happily
        // allocate all of it before the length check below ever runs.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })
      }
      catch (error) {
        fail('bad-zip', `cannot inflate "${name}": ${error.message}`)
      }
    }
    if (data.length !== size) fail('bad-zip', `zip entry "${name}" expanded to ${data.length} bytes, expected ${size}`)
    if (crc32(data) !== crc) fail('bad-zip', `zip entry "${name}" failed its CRC check`)
    entries.push({ name, dir: false, data })
  }
  return entries
}

/**
 * Group a flat entry list into skills: a root `SKILL.md` makes the whole
 * archive one skill; otherwise every top-level directory holding a `SKILL.md`
 * is a skill and the rest of the archive is ignored.
 */
function groupZip(entries, fallbackName) {
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.name)) fail('duplicate-entry', `duplicate zip entry "${entry.name}"`)
    seen.add(entry.name)
  }
  const files = entries.filter(entry => entry.dir === false)
  const put = list => new Map(list.map(entry => [entry.name, entry.data]))

  if (files.some(entry => entry.name === SKILL_FILE)) {
    return [toSkill(put(files), fallbackName)]
  }
  const tops = new Map()
  for (const entry of files) {
    const cut = entry.name.indexOf('/')
    if (cut <= 0) continue
    const top = entry.name.slice(0, cut)
    if (!tops.has(top)) tops.set(top, [])
    tops.get(top).push({ name: entry.name.slice(cut + 1), data: entry.data })
  }
  const skills = []
  for (const top of [...tops.keys()].sort()) {
    const list = tops.get(top)
    if (!list.some(entry => entry.name === SKILL_FILE)) continue
    skills.push(toSkill(put(list), top))
  }
  return skills
}

function inspectZip(buffer, fallbackName) {
  return groupZip(readZipEntries(buffer), fallbackName)
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Read a bundle without touching disk outside it.
 *
 * @param {string} source `.md` file, a directory, or a `.zip`.
 * @returns {Promise<{ kind: 'file'|'dir'|'zip', skills: Array<{ name: string, description: string, files: Map<string, Buffer> }> }>}
 */
export async function inspectSource(source) {
  if (typeof source !== 'string' || source.trim() === '') fail('not-found', 'inspectSource needs a path')
  const abs = resolve(source)
  let info
  try {
    info = await stat(abs)
  }
  catch {
    fail('not-found', `no such path: ${source}`)
  }
  if (info.isDirectory()) {
    return { kind: 'dir', skills: await inspectDir(abs) }
  }
  const extension = extname(abs).toLowerCase()
  const stem = basename(abs).slice(0, basename(abs).length - extname(abs).length)
  if (extension === '.zip') {
    return { kind: 'zip', skills: inspectZip(await readFile(abs), stem) }
  }
  if (extension === '.md') {
    // A lone markdown file becomes a one-file skill, always stored as SKILL.md
    // so every bundle downstream sees the same layout.
    const text = await readFile(abs)
    const files = new Map([[SKILL_FILE, text]])
    return { kind: 'file', skills: [toSkill(files, stem)] }
  }
  return fail('unsupported', `not a .md file, a directory or a .zip: ${source}`)
}

function invalidFiles(files) {
  if (!(files instanceof Map) || files.size === 0) return 'files must be a non-empty Map'
  if (!files.has(SKILL_FILE)) return `${SKILL_FILE} is missing`
  for (const [rel, data] of files) {
    if (typeof rel !== 'string') return 'file keys must be strings'
    const problem = relProblem(rel)
    if (problem !== null) return `"${rel}" ${problem}`
    if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) return `"${rel}" is not a Buffer`
  }
  return null
}

/** Write a validated skill into a fresh temp directory under `targetDir`. */
async function writeTempSkill(targetDir, files) {
  const temp = await mkdtemp(join(targetDir, '.tmp-skill-'))
  try {
    for (const [rel, data] of files) {
      const target = join(temp, ...rel.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, Buffer.isBuffer(data) ? data : Buffer.from(data))
    }
    // The map was validated before writing, but confirm the one file the whole
    // bundle hinges on actually reached disk before anything is published.
    await stat(join(temp, SKILL_FILE))
    return temp
  }
  catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}

/**
 * Put `tempDir` in place at `destDir`, replacing what is there.
 *
 * The old directory is moved aside rather than deleted, so the window in which
 * `destDir` is missing is one rename long and the old skill can still be put
 * back: if the second rename fails, the old directory returns to `destDir` and
 * the error propagates. Only after the new directory is in place is the old one
 * deleted, and a failure to delete it leaves a hidden `.trash-skill-*` behind
 * rather than turning a successful install into an error.
 *
 * `io` exists so the probe can prove that rollback by making the second rename
 * fail; production callers never pass it. @internal
 *
 * @param {string} tempDir directory holding the new skill contents.
 * @param {string} destDir final skill directory.
 */
export async function commitSkillDir(tempDir, destDir, io = {}) {
  const renameDir = io.renameDir ?? rename
  const removeDir = io.removeDir ?? rm
  if (!(await entryExists(destDir))) {
    await renameDir(tempDir, destDir)
    return
  }
  const trash = join(dirname(destDir), `${TRASH_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await renameDir(destDir, trash)
  try {
    await renameDir(tempDir, destDir)
  }
  catch (error) {
    try {
      await renameDir(trash, destDir)
    }
    catch (restoreError) {
      // Both renames failed; keep the original error but say where the old copy
      // is, because that path is now the only way back to it.
      error.trash = trash
      error.restoreError = restoreError
    }
    throw error
  }
  await removeDir(trash, { recursive: true, force: true }).catch(() => {})
}

/**
 * Install inspected skills under `<targetDir>/<name>/`.
 *
 * A name that cannot be a directory name (NAME_PATTERN) or a file map without
 * `SKILL.md` is skipped as `invalid`; a directory that already exists is
 * skipped as `exists` unless `overwrite` is true. Nothing is half-written: the
 * skill is assembled in a temp directory and renamed into place, and an
 * overwrite moves the old directory aside first so a failure restores it.
 *
 * @param {{ skills: Array }|Array} bundle output of inspectSource, or a bare list.
 * @param {string} targetDir skills root; one subdirectory per skill.
 * @param {{ overwrite?: boolean }} [options]
 * @returns {Promise<{ added: string[], skipped: Array<{ name: string, reason: 'exists'|'invalid', detail?: string }> }>}
 */
export async function installSkills(bundle, targetDir, options = {}) {
  const skills = Array.isArray(bundle) ? bundle : bundle !== null && typeof bundle === 'object' && Array.isArray(bundle.skills) ? bundle.skills : null
  if (skills === null) fail('bundle', 'expected inspectSource() output or an array of skills')
  if (typeof targetDir !== 'string' || targetDir.trim() === '') fail('bundle', 'installSkills needs a target directory')
  const overwrite = options.overwrite === true
  await mkdir(targetDir, { recursive: true })

  const added = []
  const skipped = []
  for (const skill of skills) {
    const name = skill !== null && typeof skill === 'object' && typeof skill.name === 'string' ? skill.name : ''
    if (!NAME_PATTERN.test(name)) {
      skipped.push({ name, reason: 'invalid', detail: 'name must match ' + NAME_PATTERN.source })
      continue
    }
    const problem = invalidFiles(skill.files)
    if (problem !== null) {
      skipped.push({ name, reason: 'invalid', detail: problem })
      continue
    }
    const dest = join(targetDir, name)
    if (!overwrite && (await entryExists(dest))) {
      skipped.push({ name, reason: 'exists' })
      continue
    }
    const temp = await writeTempSkill(targetDir, skill.files)
    try {
      await commitSkillDir(temp, dest)
    }
    catch (error) {
      await rm(temp, { recursive: true, force: true })
      throw error
    }
    added.push(name)
  }
  return { added, skipped }
}

/**
 * Refuse a tree that holds a link anywhere inside it. Only relevant when the
 * tree is about to be *copied*: a copy follows the link and would pull in
 * content from outside the skill, and the subsequent delete of the source would
 * then look like it moved something it did not.
 */
async function assertNoSymlinks(root) {
  async function walk(abs, rel) {
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    }
    catch (error) {
      fail('unreadable', `cannot read ${abs}: ${error.message}`)
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isSymbolicLink()) fail('unsafe-entry', `"${childRel}" is a symbolic link`)
      if (entry.isDirectory()) await walk(join(abs, entry.name), childRel)
    }
  }
  await walk(root, '')
}

/**
 * Move an installed skill directory between roots, keeping its directory name:
 * `moveSkill('<rootA>/alpha', '<rootB>')` lands at `<rootB>/alpha`.
 *
 * `rename` is atomic on one volume; across volumes it fails with EXDEV and the
 * directory is copied, then removed — but only after the source tree has been
 * checked for links, because that copy is the one place a skill could reach
 * outside itself. An existing destination is an error rather than a silent
 * merge, because merging two skills with the same name loses one.
 *
 * `io` lets the probe force the EXDEV path on one volume; production callers
 * never pass it. @internal
 *
 * @returns {Promise<{ from: string, to: string }>}
 */
export async function moveSkillDir(fromDir, toDir, io = {}) {
  const renameDir = io.renameDir ?? rename
  const copyDir = io.copyDir ?? cp
  const removeDir = io.removeDir ?? rm
  if (typeof fromDir !== 'string' || fromDir.trim() === '') fail('not-found', 'moveSkill needs a source directory')
  if (typeof toDir !== 'string' || toDir.trim() === '') fail('bundle', 'moveSkill needs a destination root')
  const from = resolve(fromDir)
  const to = join(resolve(toDir), basename(from))

  let info
  try {
    info = await lstat(from)
  }
  catch {
    fail('not-found', `no such directory: ${fromDir}`)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('not-found', `not a directory: ${fromDir}`)
  if (from === to) return { from, to }
  if (to.startsWith(from + '\\') || to.startsWith(from + '/')) fail('bundle', 'cannot move a skill inside itself')
  if (await entryExists(to)) fail('exists', `destination already exists: ${to}`)

  await mkdir(dirname(to), { recursive: true })
  try {
    await renameDir(from, to)
  }
  catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await assertNoSymlinks(from)
    await copyDir(from, to, { recursive: true, force: false, errorOnExist: true })
    await removeDir(from, { recursive: true, force: true })
  }
  return { from, to }
}

/** @see moveSkillDir */
export async function moveSkill(fromDir, toDir) {
  return moveSkillDir(fromDir, toDir)
}
