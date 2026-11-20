/**
 * Skills domain: list, toggle, read, delete (to trash), restore, import and move skills.
 *
 * A skill is a directory holding `SKILL.md`, the same file renamed to `SKILL.md.disabled`
 * (which is exactly what the host's skill scanner reads as "off"), or a single `.md` file.
 * Toggling therefore never touches plugin state: it renames one file inside the skill folder,
 * which is why a throwaway profile can exercise it without reaching the user's real skills.
 *
 * Roots are discovered per call: the two global ones (`<dshHome>/skills`, `~/.agents/skills`),
 * one per workspace the host can name, and whatever `TOOL_HUB_SKILL_ROOTS` lists. That override is
 * what keeps a test profile inside its own tree; an entry may be written `readonly=<dir>` to mark a
 * shared root as someone else's, so a toggle refuses it instead of half-succeeding on a permission
 * error later.
 *
 * Everything that mutates disk throws a SkillError carrying a code; the op handlers at the bottom
 * turn those into structured `{ ok: false, code, message }` results, so nothing escapes to the
 * process (docs/MODULES.md: pick one error style per module, and this module picked that one).
 */
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { stateDir } from '../core/io.js'
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { OpDefinition } from '../shared/types.js'

export const SKILL_FILE = 'SKILL.md'
export const DISABLED_SUFFIX = '.disabled'
/** A skill name has to survive as a directory name on every platform. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** How deep under a root we look for a skill folder (1.x used the same number). */
const MAX_SCAN_DEPTH = 3
/** `skill.read` stops here and says so instead of shipping a 40 MB transcript. */
const SKILL_TEXT_LIMIT = 200_000
/** `skill.trash` lists this many entries, newest first. */
const TRASH_LIST_LIMIT = 20
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
/** A skill being replaced parks here, inside the same root, until the new one lands. */
const TRASH_PREFIX = '.trash-skill-'
/** Windows resolves these to devices whatever the extension, so such a file silently vanishes. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
/** Three backticks, built here so this file needs no nested markdown fence literal. */
const FENCE = String.fromCharCode(96, 96, 96)

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP_FLAG_ENCRYPTED = 0x0001
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

export interface SkillRoot {
  id: string
  label: string
  dir: string
  scope: 'global' | 'workspace'
  workspace: string | null
  /** A root the panel lists but never writes; a toggle reports `read-only`. */
  readOnly: boolean
}

/** The row shape the client renders; field names follow the 1.x snapshot. */
export interface SkillRow {
  kind: 'skill'
  id: string
  name: string
  title: string
  description: string
  descriptionSource: 'meta'
  scope: 'global' | 'workspace'
  workspace: string | null
  rootId: string
  rootLabel: string
  source: string
  path: string
  enabled: boolean
  official: false
  role: 'rest'
  self: false
}

export interface SkillBundleSkill {
  name: string
  description: string
  files: Map<string, Buffer>
}

export interface SkillBundle {
  kind: 'file' | 'dir' | 'zip'
  skills: SkillBundleSkill[]
}

export interface DomainFailure {
  ok: false
  code: string
  message: string
}

export interface ResolvedSkill {
  abs: string
  dir: string
  base: string
  root: SkillRoot
  /** POSIX path of the skill folder (or skill file) relative to its root. */
  rel: string
}

export class SkillError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SkillError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new SkillError(code, message)
}

/** One place that turns a thrown error into the module's structured failure shape. */
export function failureOf(error: unknown): DomainFailure {
  if (error instanceof SkillError) return { ok: false, code: error.code, message: error.message }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, code: typeof code === 'string' ? code : 'internal', message: error.message }
  }
  return { ok: false, code: 'internal', message: String(error) }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function envText(name: string): string {
  const value = process.env[name]
  return typeof value === 'string' ? value.trim() : ''
}

/** The DSH home this process runs against, derived the same way core/io does it. */
function dshHomeDir(): string {
  const fromEnv = envText('DSH_HOME')
  return fromEnv === '' ? dirname(stateDir()) : fromEnv
}

/** Deleted skills wait here, one directory per delete, beside the state file. */
export function trashDir(): string {
  return join(stateDir(), 'trash')
}

/** FNV-1a over the workspace path: stable across processes, short enough to read in an id. */
export function hashText(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

/** True for anything at `path`, including a dangling link, which `stat` misses. */
async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  }
  catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  }
  catch {
    return false
  }
}

async function readText(path: string, limit = Number.POSITIVE_INFINITY): Promise<string> {
  const raw = await readFile(path)
  return (limit === Number.POSITIVE_INFINITY ? raw : raw.subarray(0, limit)).toString('utf8')
}

/** Split a markdown file into its leading `---` block and the body below it. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (!source.startsWith('---')) return { fields: {}, body: source }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { fields: {}, body: source }
  const fields: Record<string, string> = {}
  for (const line of source.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1] ?? ''
    if (key === '') continue
    let value = (match[2] ?? '').trim()
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  const close = source.indexOf('\n', end + 1)
  return { fields, body: close === -1 ? '' : source.slice(close + 1) }
}

/** First line of the body that carries prose rather than a heading or a fence. */
function proseLine(body: string, max = 200): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(FENCE)) continue
    return line.length > max ? line.slice(0, max - 1) + '…' : line
  }
  return ''
}

/**
 * A fallback name (directory or file stem) is normalised: non-ASCII cannot pass NAME_PATTERN
 * anyway, so it folds to `skill` instead of failing installation later. A `name:` declared in
 * frontmatter is never rewritten; an unusable one is reported as `invalid` by installSkills.
 */
function slug(raw: string): string {
  const cleaned = String(raw)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'skill' : cleaned.slice(0, 64)
}

function toSkill(files: Map<string, Buffer>, fallbackName: string): SkillBundleSkill {
  const readme = files.get(SKILL_FILE)
  const parsed = readme === undefined ? { fields: {} as Record<string, string>, body: '' } : parseFrontmatter(readme.toString('utf8'))
  const declared = typeof parsed.fields.name === 'string' ? parsed.fields.name.trim() : ''
  const description = typeof parsed.fields.description === 'string' ? parsed.fields.description.trim() : ''
  return {
    name: declared === '' ? slug(fallbackName) : declared,
    description: description === '' ? proseLine(parsed.body) : description,
    files,
  }
}

// ── roots ────────────────────────────────────────────────────────────────────

/**
 * Skill roots in discovery order, with the stable ids written into row ids.
 *
 * The id prefixes every skill id (`user|rel`, `ws-1a2b3c4d|rel`), so it has to stay stable across runs and
 * processes: the workspace half is a hash of the path rather than an index.
 */
export function skillRoots(env: HostEnv): SkillRoot[] {
  const roots: SkillRoot[] = []
  const override = envText('TOOL_HUB_SKILL_ROOTS')
  const separator = sep === '\\' ? ';' : ':'
  if (override !== '') {
    const entries = override.split(separator).map(entry => entry.trim()).filter(entry => entry !== '')
    entries.forEach((entry, index) => {
      const readOnly = /^readonly=/i.test(entry)
      const dir = readOnly ? entry.slice('readonly='.length).trim() : entry
      if (dir === '') return
      roots.push({
        id: index === 0 ? 'user' : 'root' + String(index + 1),
        label: index === 0 ? '全局 · 用户' : '全局 · 共享 ' + String(index + 1),
        dir: resolve(dir),
        scope: 'global',
        workspace: null,
        readOnly,
      })
    })
  }
  else {
    roots.push({ id: 'user', label: '全局 · 用户', dir: join(dshHomeDir(), 'skills'), scope: 'global', workspace: null, readOnly: false })
    roots.push({ id: 'agents', label: '全局 · 共享', dir: join(homedir(), '.agents', 'skills'), scope: 'global', workspace: null, readOnly: false })
  }
  for (const workspace of workspacePaths(env)) {
    roots.push({
      id: 'ws-' + hashText(workspace),
      label: basename(workspace) === '' ? workspace : basename(workspace),
      dir: join(workspace, '.dsh', 'skills'),
      scope: 'workspace',
      workspace,
      readOnly: false,
    })
  }
  return roots
}

/**
 * Workspace paths the host knows about; the first source that answers wins.
 *
 * `TOOL_HUB_WORKSPACES` comes first so a profile can point the panel at a throwaway tree; a bare
 * `-` means "no workspace roots" (the sandbox profile uses it to stay isolated). Each service item may
 * be a bare path or an object carrying one under `path` / `dir` / `root`; anything else is skipped, never
 * thrown.
 */
function workspacePaths(env: HostEnv): string[] {
  const found: string[] = []
  const add = (value: unknown): void => {
    try {
      if (typeof value === 'string') {
        const clean = value.trim()
        if (clean !== '' && !found.includes(resolve(clean))) found.push(resolve(clean))
        return
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        add(record.path ?? record.dir ?? record.root)
      }
    }
    catch {
      // A path-shaped value we cannot resolve is not a workspace.
    }
  }
  const fromEnv = envText('TOOL_HUB_WORKSPACES')
  if (fromEnv === '-') return found
  if (fromEnv !== '') {
    for (const entry of fromEnv.split(';')) add(entry)
    return found
  }
  const sources: Array<() => unknown> = [
    () => (env.services.get('workspaces') as { list?: unknown } | undefined)?.list,
    () => (env.services.get('workspaceRegistry') as { list?: unknown } | undefined)?.list,
    () => (env.services.get('sessions') as { listWorkspaces?: unknown } | undefined)?.listWorkspaces,
  ]
  for (const read of sources) {
    let list: unknown
    try {
      const member = read()
      list = typeof member === 'function' ? (member as () => unknown)() : undefined
    }
    catch {
      list = undefined
    }
    if (!Array.isArray(list)) continue
    const before = found.length
    for (const entry of list) add(entry)
    if (found.length > before) return found
  }
  return found
}

// ── listing ──────────────────────────────────────────────────────────────────

/** A directory bundle is a skill iff it holds SKILL.md or SKILL.md.disabled. */
async function readSkillDir(abs: string, root: SkillRoot, rel: string): Promise<SkillRow | null> {
  const on = join(abs, SKILL_FILE)
  const off = join(abs, SKILL_FILE + DISABLED_SUFFIX)
  const hasOn = await exists(on)
  const hasOff = !hasOn && (await exists(off))
  if (!hasOn && !hasOff) return null
  const file = hasOn ? on : off
  let fields: Record<string, string> = {}
  try {
    fields = parseFrontmatter(await readText(file, 8192)).fields
  }
  catch {
    fields = {}
  }
  const fallback = rel.split(sep).pop() ?? rel
  const name = typeof fields.name === 'string' && fields.name !== '' ? fields.name : fallback
  return {
    kind: 'skill',
    id: root.id + '|' + rel.split(sep).join('/'),
    name,
    title: name,
    description: typeof fields.description === 'string' ? fields.description : '',
    // A skill's own frontmatter is its only description source; saying so beats leaving the field
    // looking like a plugin row's fallback chain.
    descriptionSource: 'meta',
    scope: root.scope,
    workspace: root.workspace,
    rootId: root.id,
    rootLabel: root.label,
    source: root.label,
    path: abs,
    enabled: hasOn,
    official: false,
    role: 'rest',
    self: false,
  }
}

async function scanSkillRoot(root: SkillRoot, depth = 0, rel = ''): Promise<SkillRow[]> {
  const out: SkillRow[] = []
  let entries
  try {
    entries = await readdir(join(root.dir, rel), { withFileTypes: true })
  }
  catch {
    return out
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    const childRel = rel === '' ? entry.name : join(rel, entry.name)
    if (!entry.isDirectory()) continue
    const abs = join(root.dir, childRel)
    const skill = await readSkillDir(abs, root, childRel)
    if (skill !== null) {
      out.push(skill)
      continue
    }
    if (depth < MAX_SCAN_DEPTH) out.push(...(await scanSkillRoot(root, depth + 1, childRel)))
  }
  return out
}

export async function listSkills(env: HostEnv): Promise<SkillRow[]> {
  const rows: SkillRow[] = []
  for (const root of skillRoots(env)) {
    if (!(await exists(root.dir))) continue
    rows.push(...(await scanSkillRoot(root)))
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

/** Resolve a skill id back to its on-disk names, refusing to escape a root. */
export function resolveSkillId(roots: SkillRoot[], id: string): ResolvedSkill | null {
  const separator = id.indexOf('|')
  if (separator <= 0) return null
  const rootId = id.slice(0, separator)
  const rel = id.slice(separator + 1)
  const root = roots.find(candidate => candidate.id === rootId)
  if (root === undefined) return null
  const rootDir = resolve(root.dir)
  const abs = resolve(rootDir, rel)
  // Ask the path module whether the target is still under the root instead of comparing strings:
  // a root at a filesystem root has a prefix no real child ever starts with. `relative` answers with
  // `..` when the target is outside and with an absolute path across Windows drives.
  const inner = relative(rootDir, abs)
  if (inner === '' || inner === '..' || inner.startsWith('..' + sep) || isAbsolute(inner)) return null
  const base = abs.split(sep).pop() ?? rel
  return { abs, dir: dirname(abs), base, root, rel: rel.split(sep).join('/') }
}

/** The file a skill row reads from: SKILL.md, its disabled twin, or a single .md skill. */
export async function skillEntry(resolved: ResolvedSkill): Promise<{ kind: 'file' | 'dir'; file: string } | null> {
  const info = await stat(resolved.abs).catch(() => null)
  if (info === null) return null
  if (info.isFile()) return { kind: 'file', file: resolved.abs }
  for (const name of [SKILL_FILE, SKILL_FILE + DISABLED_SUFFIX]) {
    const file = join(resolved.abs, name)
    if (await exists(file)) return { kind: 'dir', file }
  }
  return null
}

// ── toggle ───────────────────────────────────────────────────────────────────

/**
 * Rename SKILL.md to its .disabled twin, or back. This is the whole of a skill's on/off state,
 * which is why the host's own scanner and this panel agree without sharing a file.
 */
export async function setSkillEnabled(env: HostEnv, id: string, enabled: boolean): Promise<{ id: string; ok: true; message: string }> {
  const roots = skillRoots(env)
  const resolved = resolveSkillId(roots, id)
  if (resolved === null) fail('unknown-skill', 'no skill folder answers to ' + id)
  if (resolved.root.readOnly) fail('read-only', 'the skill root "' + resolved.root.id + '" is read-only')
  const target = join(resolved.dir, resolved.base)
  const on = join(target, SKILL_FILE)
  const off = on + DISABLED_SUFFIX
  const hasOn = await exists(on)
  const hasOff = await exists(off)
  // An id that parses but points at nothing is an unknown skill; a real folder with no skill file
  // is a different problem, and the message has to say which one happened.
  if (!hasOn && !hasOff) {
    if (!(await exists(target))) fail('unknown-skill', 'no skill folder answers to ' + id)
    fail('missing-skill-file', SKILL_FILE + ' not found in ' + target)
  }
  try {
    if (enabled) {
      if (hasOn) return { id, ok: true, message: 'already on' }
      if (!hasOff) fail('missing-skill-file', SKILL_FILE + ' not found in ' + target)
      await rename(off, on)
      return { id, ok: true, message: 'renamed on' }
    }
    if (hasOff) return { id, ok: true, message: 'already off' }
    if (!hasOn) fail('missing-skill-file', SKILL_FILE + ' not found in ' + target)
    await rename(on, off)
    return { id, ok: true, message: 'renamed off' }
  }
  catch (error) {
    // A permission failure is a read-only skill in practice; say that instead of EACCES.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      fail('read-only', 'cannot rename ' + basename(on) + ' in ' + target + ': ' + (error as Error).message)
    }
    throw error
  }
}

// ── trash ────────────────────────────────────────────────────────────────────

/** Move a file or a whole tree; rename cannot cross volumes, so a copy is the fallback. */
export async function movePath(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, force: true })
    await rm(from, { recursive: true, force: true })
  }
}

/** Letters, digits and `-_.` survive; everything else — including CJK — becomes `-`. */
export function safeName(value: string): string {
  const cleaned = String(value).replace(/[^A-Za-z0-9\-_.]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return cleaned === '' ? 'skill' : cleaned
}

interface TrashMeta {
  rootId?: unknown
  rel?: unknown
  name?: unknown
  at?: unknown
  kind?: unknown
}

async function readTrashMeta(item: string): Promise<TrashMeta | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(item, 'meta.json'), 'utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as TrashMeta) : null
  }
  catch {
    return null
  }
}

export interface TrashItem {
  trashPath: string
  name: string
  at: string
  rootId: string | null
  rel: string | null
}

export async function listTrash(): Promise<TrashItem[]> {
  let names: string[]
  try {
    names = await readdir(trashDir())
  }
  catch {
    return []
  }
  // Stamps are millisecond numbers, so a plain descending sort is newest first.
  names.sort().reverse()
  const items: TrashItem[] = []
  for (const name of names) {
    if (items.length >= TRASH_LIST_LIMIT) break
    const item = join(trashDir(), name)
    const info = await stat(item).catch(() => null)
    if (info === null) continue
    const meta = info.isDirectory() ? await readTrashMeta(item) : null
    items.push({
      trashPath: item,
      name: typeof meta?.name === 'string' && meta.name !== '' ? meta.name : name,
      at: typeof meta?.at === 'string' ? meta.at : new Date(info.mtimeMs).toISOString(),
      rootId: typeof meta?.rootId === 'string' ? meta.rootId : null,
      rel: typeof meta?.rel === 'string' ? meta.rel : null,
    })
  }
  return items
}

/**
 * Delete is a move into `<state dir>/trash/<ts>-<safe>/` and nothing else: the tree stays whole, a
 * meta.json records where it came from, and restore is the same move in reverse. Nothing is ever
 * removed from disk here, which is what makes the panel's undo honest.
 */
export async function deleteSkill(env: HostEnv, id: string): Promise<{ ok: true; id: string; trashPath: string; name: string }> {
  const roots = skillRoots(env)
  const resolved = resolveSkillId(roots, id)
  if (resolved === null) fail('unknown-skill', 'no skill folder answers to ' + id)
  if (resolved.root.readOnly) fail('read-only', 'the skill root "' + resolved.root.id + '" is read-only')
  const entry = await skillEntry(resolved)
  if (entry === null) {
    if (!(await exists(resolved.abs))) fail('unknown-skill', 'no skill folder answers to ' + id)
    fail('missing-skill-file', 'no skill file under ' + resolved.abs)
  }

  let name = resolved.rel.split('/').pop() ?? resolved.base
  try {
    const fields = parseFrontmatter(await readText(entry.file, 8192)).fields
    if (typeof fields.name === 'string' && fields.name !== '') name = fields.name
  }
  catch {
    // A skill file we cannot read still has a folder name worth showing.
  }
  await mkdir(trashDir(), { recursive: true })
  const stamp = String(Date.now())
  let item = join(trashDir(), stamp + '-' + safeName(name))
  let suffix = 1
  while (await exists(item)) {
    suffix += 1
    item = join(trashDir(), stamp + '-' + safeName(name) + '-' + String(suffix))
  }
  if (entry.kind === 'dir') {
    await movePath(resolved.abs, item)
  }
  else {
    await mkdir(item, { recursive: true })
    await movePath(resolved.abs, join(item, basename(resolved.abs)))
  }
  const meta = {
    rootId: resolved.root.id,
    rel: resolved.rel,
    name,
    at: new Date().toISOString(),
    kind: entry.kind,
  }
  await writeFile(join(item, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
  return { ok: true, id, trashPath: item, name }
}

export async function restoreSkill(env: HostEnv, trashPath: string): Promise<{ ok: true; restored: string }> {
  const asked = trashPath.trim()
  if (asked === '') fail('bad-trash', 'trashPath is required')
  const item = resolve(asked)
  // Only a direct child of our own trash folder: a restore must never be a rename of something the
  // caller picked elsewhere on disk.
  if (dirname(item) !== resolve(trashDir())) fail('bad-trash', 'not a trash item of this panel')
  const meta = await readTrashMeta(item)
  if (meta === null) fail('bad-trash', 'that trash item has no meta.json')
  const roots = skillRoots(env)
  const root = roots.find(candidate => candidate.id === meta.rootId)
  if (root === undefined) fail('root-missing', 'the root ' + String(meta.rootId) + ' no longer exists')
  if (root.readOnly) fail('read-only', 'the skill root "' + root.id + '" is read-only')
  const rel = typeof meta.rel === 'string' ? meta.rel : ''
  const parts = rel.split('/').filter(part => part !== '' && part !== '.' && part !== '..')
  if (parts.length === 0) fail('bad-trash', 'that trash item has no recorded path')
  const dest = join(root.dir, ...parts)
  const inner = relative(resolve(root.dir), resolve(dest))
  if (inner === '' || inner === '..' || inner.startsWith('..' + sep) || isAbsolute(inner)) {
    fail('bad-trash', 'recorded path escapes its root')
  }
  if (await exists(dest)) fail('target-exists', dest + ' already exists')
  await mkdir(dirname(dest), { recursive: true })
  if (meta.kind === 'file') {
    const last = parts[parts.length - 1]
    if (last === undefined) fail('bad-trash', 'that trash item has no recorded file name')
    await movePath(join(item, last), dest)
    await rm(item, { recursive: true, force: true })
  }
  else {
    // The bookkeeping file must not travel back into the skill tree.
    await rm(join(item, 'meta.json'), { force: true })
    await movePath(item, dest)
  }
  return { ok: true, restored: root.id + '|' + parts.join('/') }
}

// ── import: read a bundle without leaving it ─────────────────────────────────

/** Why a skill-relative path is unusable, or null when it is fine. */
function relProblem(value: string): string | null {
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
    if (WINDOWS_RESERVED.test(segment)) return 'uses the reserved device name "' + segment + '"'
    if (/[ .]$/.test(segment)) return 'ends with a space or a dot: "' + segment + '"'
  }
  return null
}

/** A zip entry name has to name a path inside the archive, after backslashes become separators. */
function safeEntryPath(raw: string, index: number): { name: string; directory: boolean } {
  const name = raw.replaceAll('\\', '/')
  if (name === '') fail('unsafe-entry', 'zip entry ' + String(index) + ' has an empty name')
  const directory = name.endsWith('/')
  const bare = directory ? name.slice(0, -1) : name
  const problem = relProblem(bare)
  if (problem !== null) fail('unsafe-entry', 'zip entry "' + name + '" ' + problem)
  return { name, directory }
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index] ?? 0
    value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function findEocd(buffer: Buffer): number {
  const minimum = 22
  if (buffer.length < minimum) fail('bad-zip', 'file is too short to be a zip archive')
  const lowest = Math.max(0, buffer.length - 65557)
  for (let at = buffer.length - minimum; at >= lowest; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIG) return at
  }
  return fail('bad-zip', 'no end-of-central-directory record')
}

interface ZipEntry {
  name: string
  dir: boolean
  data: Buffer | null
}

/** Read store/deflate entries, verifying sizes and CRC so corruption is loud. */
function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer)
  const count = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('bad-zip', 'zip64 archives are not supported')
  if (count === 0) fail('bad-zip', 'archive holds no entries')
  if (cdOffset + cdSize > buffer.length) fail('bad-zip', 'central directory runs past the end of the file')

  const entries: ZipEntry[] = []
  let total = 0
  let at = cdOffset
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length) fail('bad-zip', 'central directory is truncated')
    if (buffer.readUInt32LE(at) !== CENTRAL_SIG) fail('bad-zip', 'bad central directory signature at entry ' + String(index))
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
    // Bit 11 is a hint only; we always decode UTF-8. A DOS-era CP437 name mis-decodes visibly,
    // which is far less surprising than silently mangling it through a half-implemented table.
    const rawName = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    at += 46 + nameLength + extraLength + commentLength

    const entry = safeEntryPath(rawName, index)
    if ((flags & ZIP_FLAG_ENCRYPTED) !== 0) fail('bad-zip', 'zip entry "' + entry.name + '" is encrypted')
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      fail('bad-zip', 'zip entry "' + entry.name + '" uses unsupported compression method ' + String(method))
    }
    // Unix hosts stamp the file mode into the high half of external attributes; a symlink entry
    // would let a later read follow it out of the bundle.
    if ((madeBy >>> 8 === 3 || madeBy >>> 8 === 19) && ((external >>> 16) & 0xf000) === 0xa000) {
      fail('unsafe-entry', 'zip entry "' + entry.name + '" is a symbolic link')
    }
    if (entry.directory) {
      entries.push({ name: entry.name, dir: true, data: null })
      continue
    }
    if (size > MAX_ENTRY_BYTES) fail('bad-zip', 'zip entry "' + entry.name + '" is larger than ' + String(MAX_ENTRY_BYTES) + ' bytes')
    total += size
    if (total > MAX_TOTAL_BYTES) fail('bad-zip', 'archive expands past ' + String(MAX_TOTAL_BYTES) + ' bytes')

    if (localOffset + 30 > buffer.length) fail('bad-zip', 'zip entry "' + entry.name + '" points outside the file')
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) fail('bad-zip', 'bad local header for "' + entry.name + '"')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    if (start + compressedSize > buffer.length) fail('bad-zip', 'zip entry "' + entry.name + '" is truncated')
    const data = buffer.subarray(start, start + compressedSize)

    let output: Buffer
    if (method === METHOD_STORE) {
      if (compressedSize !== size) fail('bad-zip', 'stored entry "' + entry.name + '" has mismatched sizes')
      output = Buffer.from(data)
    }
    else {
      try {
        // Cap the output at the size the header promised: a hostile archive can claim a tiny
        // entry and inflate to gigabytes before any length check would run.
        output = inflateRawSync(data, { maxOutputLength: Math.max(size, 1) })
      }
      catch (error) {
        fail('bad-zip', 'cannot inflate "' + entry.name + '": ' + (error as Error).message)
      }
    }
    if (output.length !== size) fail('bad-zip', 'zip entry "' + entry.name + '" expanded to ' + String(output.length) + ' bytes, expected ' + String(size))
    if (crc32(output) !== crc) fail('bad-zip', 'zip entry "' + entry.name + '" failed its CRC check')
    entries.push({ name: entry.name, dir: false, data: output })
  }
  return entries
}

/**
 * Group a flat entry list into skills: a root SKILL.md makes the whole archive one skill; otherwise
 * every top-level directory holding a SKILL.md is a skill and the rest of the archive is ignored.
 */
function groupZip(entries: ZipEntry[], fallbackName: string): SkillBundleSkill[] {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.name)) fail('duplicate-entry', 'duplicate zip entry "' + entry.name + '"')
    seen.add(entry.name)
  }
  const files: Array<{ name: string; data: Buffer }> = []
  for (const entry of entries) {
    if (entry.dir || entry.data === null) continue
    files.push({ name: entry.name, data: entry.data })
  }
  const put = (list: Array<{ name: string; data: Buffer }>): Map<string, Buffer> => new Map(list.map(item => [item.name, item.data]))

  if (files.some(entry => entry.name === SKILL_FILE)) {
    return [toSkill(put(files), fallbackName)]
  }
  const tops = new Map<string, Array<{ name: string; data: Buffer }>>()
  for (const entry of files) {
    const cut = entry.name.indexOf('/')
    if (cut <= 0) continue
    const top = entry.name.slice(0, cut)
    const list = tops.get(top) ?? []
    list.push({ name: entry.name.slice(cut + 1), data: entry.data })
    tops.set(top, list)
  }
  const skills: SkillBundleSkill[] = []
  for (const top of [...tops.keys()].sort()) {
    const list = tops.get(top) ?? []
    if (!list.some(entry => entry.name === SKILL_FILE)) continue
    skills.push(toSkill(put(list), top))
  }
  return skills
}

/** Every regular file under `root`, keyed by a POSIX path relative to it. Links are refused. */
async function collectDir(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  async function walk(abs: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    }
    catch (error) {
      fail('unreadable', 'cannot read ' + abs + ': ' + (error as Error).message)
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : rel + '/' + entry.name
      // Never follow a link out of the bundle: what gets copied has to be what the directory
      // itself contains.
      if (entry.isSymbolicLink()) fail('unsafe-entry', 'symbolic link at "' + childRel + '"')
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
async function inspectDir(abs: string): Promise<SkillBundleSkill[]> {
  if (await isFile(join(abs, SKILL_FILE))) {
    return [toSkill(await collectDir(abs), basename(abs))]
  }
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  }
  catch (error) {
    fail('unreadable', 'cannot read ' + abs + ': ' + (error as Error).message)
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const skills: SkillBundleSkill[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail('unsafe-entry', 'symbolic link at "' + entry.name + '"')
    if (!entry.isDirectory()) continue
    const child = join(abs, entry.name)
    if (!(await isFile(join(child, SKILL_FILE)))) continue
    skills.push(toSkill(await collectDir(child), entry.name))
  }
  return skills
}

/** Read a bundle without touching disk outside it: a .md file, a directory, or a .zip. */
export async function inspectSource(source: string): Promise<SkillBundle> {
  if (typeof source !== 'string' || source.trim() === '') fail('not-found', 'inspectSource needs a path')
  const abs = resolve(source)
  let info
  try {
    info = await stat(abs)
  }
  catch {
    fail('not-found', 'no such path: ' + source)
  }
  if (info.isDirectory()) return { kind: 'dir', skills: await inspectDir(abs) }
  const extension = extname(abs).toLowerCase()
  const stem = basename(abs).slice(0, basename(abs).length - extname(abs).length)
  if (extension === '.zip') {
    return { kind: 'zip', skills: groupZip(readZipEntries(await readFile(abs)), stem) }
  }
  if (extension === '.md') {
    // A lone markdown file becomes a one-file skill, always stored as SKILL.md so every bundle
    // downstream sees the same layout.
    const files = new Map<string, Buffer>([[SKILL_FILE, await readFile(abs)]])
    return { kind: 'file', skills: [toSkill(files, stem)] }
  }
  return fail('unsupported', 'not a .md file, a directory or a .zip: ' + source)
}

function invalidFiles(files: Map<string, Buffer> | undefined): string | null {
  if (!(files instanceof Map) || files.size === 0) return 'files must be a non-empty map'
  if (!files.has(SKILL_FILE)) return SKILL_FILE + ' is missing'
  for (const [rel, data] of files) {
    if (typeof rel !== 'string') return 'file keys must be strings'
    const problem = relProblem(rel)
    if (problem !== null) return '"' + rel + '" ' + problem
    if (!Buffer.isBuffer(data)) return '"' + rel + '" is not a Buffer'
  }
  return null
}

/** Write a validated skill into a fresh temp directory under `targetDir`. */
async function writeTempSkill(targetDir: string, files: Map<string, Buffer>): Promise<string> {
  const temp = await mkdtemp(join(targetDir, '.tmp-skill-'))
  try {
    for (const [rel, data] of files) {
      const target = join(temp, ...rel.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data)
    }
    // The map was validated before writing, but confirm the one file the whole bundle hinges on
    // actually reached disk before anything is published.
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
 * The old directory is moved aside rather than deleted, so the window in which destDir is missing
 * is one rename long and the old skill can still be put back; a failure to delete the parked copy
 * leaves a hidden .trash-skill-* behind instead of failing the install.
 */
export async function commitSkillDir(tempDir: string, destDir: string): Promise<void> {
  if (!(await entryExists(destDir))) {
    await rename(tempDir, destDir)
    return
  }
  const trash = join(dirname(destDir), TRASH_PREFIX + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8))
  await rename(destDir, trash)
  try {
    await rename(tempDir, destDir)
  }
  catch (error) {
    try {
      await rename(trash, destDir)
    }
    catch (restoreError) {
      // Both renames failed; keep the original error but say where the old copy is, because that
      // path is now the only way back to it.
      const detail = error as Error & { trash?: string; restoreError?: unknown }
      detail.trash = trash
      detail.restoreError = restoreError
    }
    throw error
  }
  await rm(trash, { recursive: true, force: true }).catch(() => {})
}

/**
 * Install inspected skills under `<targetDir>/<name>/`.
 *
 * A name that cannot be a directory name, or a file map without SKILL.md, is skipped as invalid;
 * an existing directory is skipped as "exists" unless overwrite is true. Nothing is half-written:
 * the skill is assembled in a temp directory and renamed into place.
 */
export async function installSkills(
  bundle: SkillBundle | SkillBundleSkill[],
  targetDir: string,
  options: { overwrite?: boolean } = {},
): Promise<{ added: string[]; skipped: Array<{ name: string; reason: 'exists' | 'invalid'; detail?: string }> }> {
  const skills = Array.isArray(bundle) ? bundle : Array.isArray(bundle.skills) ? bundle.skills : null
  if (skills === null) fail('bundle', 'expected inspectSource() output or an array of skills')
  if (typeof targetDir !== 'string' || targetDir.trim() === '') fail('bundle', 'installSkills needs a target directory')
  const overwrite = options.overwrite === true
  await mkdir(targetDir, { recursive: true })

  const added: string[] = []
  const skipped: Array<{ name: string; reason: 'exists' | 'invalid'; detail?: string }> = []
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

/** Refuse a tree that holds a link anywhere inside it — the copy would pull in outside content. */
async function assertNoSymlinks(root: string): Promise<void> {
  async function walk(abs: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    }
    catch (error) {
      fail('unreadable', 'cannot read ' + abs + ': ' + (error as Error).message)
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : rel + '/' + entry.name
      if (entry.isSymbolicLink()) fail('unsafe-entry', '"' + childRel + '" is a symbolic link')
      if (entry.isDirectory()) await walk(join(abs, entry.name), childRel)
    }
  }
  await walk(root, '')
}

/**
 * Move an installed skill directory between roots, keeping its name: moveSkillDir('/a/alpha','/b')
 * lands at /b/alpha. An existing destination is an error rather than a silent merge.
 */
export async function moveSkillDir(fromDir: string, toDir: string): Promise<{ from: string; to: string }> {
  if (typeof fromDir !== 'string' || fromDir.trim() === '') fail('not-found', 'moveSkill needs a source directory')
  if (typeof toDir !== 'string' || toDir.trim() === '') fail('bundle', 'moveSkill needs a destination root')
  const from = resolve(fromDir)
  const to = join(resolve(toDir), basename(from))

  let info
  try {
    info = await lstat(from)
  }
  catch {
    fail('not-found', 'no such directory: ' + fromDir)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('not-found', 'not a directory: ' + fromDir)
  if (from === to) return { from, to }
  if (to.startsWith(from + sep) || to.startsWith(from + '/')) fail('bundle', 'cannot move a skill inside itself')
  if (await entryExists(to)) fail('exists', 'destination already exists: ' + to)

  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await assertNoSymlinks(from)
    await cp(from, to, { recursive: true, force: false, errorOnExist: true })
    await rm(from, { recursive: true, force: true })
  }
  return { from, to }
}

/** Move one installed skill (a folder or a single .md file) into another root. */
export async function moveSkillBetweenRoots(
  env: HostEnv,
  id: string,
  targetRootId: string,
): Promise<{ ok: true; from: string; to: string; root: string }> {
  const roots = skillRoots(env)
  const root = roots.find(candidate => candidate.id === targetRootId)
  if (root === undefined) fail('unknown-root', 'no skill root with id "' + targetRootId + '"')
  if (root.readOnly) fail('read-only', 'the skill root "' + root.id + '" is read-only')
  const resolved = resolveSkillId(roots, id)
  if (resolved === null) fail('unknown-skill', 'no skill folder answers to ' + id)
  if (resolved.root.id === root.id) fail('exists', 'the skill is already in that root')
  if (resolved.root.readOnly) fail('read-only', 'the skill root "' + resolved.root.id + '" is read-only')
  const entry = await skillEntry(resolved)
  // An id that parses but points at nothing is an unknown skill; a real folder with no skill file
  // is a different problem, and the message has to say which one happened.
  if (entry === null) {
    if (!(await exists(resolved.abs))) fail('unknown-skill', 'no skill folder answers to ' + id)
    fail('missing-skill-file', 'no skill file under ' + resolved.abs)
  }
  if (entry.kind === 'dir') {
    const moved = await moveSkillDir(resolved.abs, root.dir)
    return { ok: true, from: moved.from, to: moved.to, root: root.id }
  }
  // A single-file skill keeps its file name; moveSkillDir only knows directories.
  const from = resolved.abs
  const to = join(root.dir, basename(resolved.abs))
  if (await entryExists(to)) fail('exists', 'destination already exists: ' + to)
  await mkdir(root.dir, { recursive: true })
  await movePath(from, to)
  return { ok: true, from, to, root: root.id }
}

// ── ops ──────────────────────────────────────────────────────────────────────

const OPS: OpDefinition[] = [
  { id: 'skill.list', write: false, audit: false, note: 'Lists every skill under every skill root; reading only.' },
  { id: 'skill.toggle', write: true, audit: true, note: 'Renames SKILL.md to its .disabled twin (or back) inside one skill folder.' },
  { id: 'skill.read', write: false, audit: false, note: 'Returns one skill file text, truncated at the 200k character limit.' },
  { id: 'skill.delete', write: true, audit: true, note: 'Moves a skill into the trash folder; nothing is deleted from disk.' },
  { id: 'skill.restore', write: true, audit: true, note: 'Moves a trashed skill back to the root its meta.json records.' },
  { id: 'skill.trash', write: false, audit: false, note: 'Lists the trash folder contents, newest first; read-only.' },
  { id: 'skill.import', write: true, audit: false, note: 'Installs skill files from a local bundle (.md, directory or .zip) into a root.' },
  { id: 'skill.move', write: true, audit: true, note: 'Moves a skill between skill roots; an existing destination is refused.' },
]

function guarded(work: (payload: Record<string, unknown>, env: HostEnv) => Promise<unknown>): OpHandler {
  return async (payload, env): Promise<unknown> => {
    try {
      return await work(asRecord(payload), env)
    }
    catch (error) {
      return failureOf(error)
    }
  }
}

function field(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** One handler per declared op; every failure comes back as ok:false with a code. */
export function createSkillsDomain(): DomainRegistration {
  return {
    module: {
      id: 'skills',
      title: { zh: '技能', en: 'Skills' },
      ops: OPS,
      panels: [{ slot: 'plugins.tab', id: 'skills', order: 20 }],
    },
    handlers: {
      'skill.list': guarded(async (_payload, env) => {
        const roots = skillRoots(env)
        const items = await listSkills(env)
        return {
          ok: true,
          roots: roots.map(root => ({
            id: root.id,
            label: root.label,
            dir: root.dir,
            scope: root.scope,
            workspace: root.workspace,
            readOnly: root.readOnly,
          })),
          items,
          count: items.length,
        }
      }),
      'skill.toggle': guarded(async (payload, env) => await setSkillEnabled(env, field(payload, 'id'), payload.enabled === true)),
      'skill.read': guarded(async (payload, env) => {
        const id = field(payload, 'id')
        const resolved = resolveSkillId(skillRoots(env), id)
        if (resolved === null) fail('unknown-skill', 'no skill folder answers to ' + id)
        const entry = await skillEntry(resolved)
        if (entry === null) {
          if (!(await exists(resolved.abs))) fail('unknown-skill', 'no skill folder answers to ' + id)
          fail('missing-skill-file', 'no skill file under ' + resolved.abs)
        }
        const raw = await readFile(entry.file)
        const value = raw.toString('utf8')
        const truncated = value.length > SKILL_TEXT_LIMIT
        return { ok: true, id, text: truncated ? value.slice(0, SKILL_TEXT_LIMIT) : value, bytes: raw.length, truncated }
      }),
      'skill.delete': guarded(async (payload, env) => await deleteSkill(env, field(payload, 'id'))),
      'skill.restore': guarded(async (payload, env) => await restoreSkill(env, field(payload, 'trashPath'))),
      'skill.trash': guarded(async () => ({ ok: true, items: await listTrash() })),
      'skill.import': guarded(async (payload, env) => {
        const roots = skillRoots(env)
        const targetId = field(payload, 'targetId')
        const root = roots.find(candidate => candidate.id === targetId)
        if (root === undefined) fail('unknown-root', 'no skill root with id "' + targetId + '"')
        if (root.readOnly) fail('read-only', 'the skill root "' + root.id + '" is read-only')
        const source = field(payload, 'path')
        if (source === '') fail('bad-path', 'a local path is required')
        const bundle = await inspectSource(source)
        if (bundle.skills.length === 0) fail('empty-source', 'no skill found under ' + source)
        const result = await installSkills(bundle, root.dir, { overwrite: payload.overwrite === true })
        return { ok: true, root: root.id, added: result.added, skipped: result.skipped }
      }),
      'skill.move': guarded(async (payload, env) => await moveSkillBetweenRoots(env, field(payload, 'id'), field(payload, 'targetId'))),
    },
  }
}

/** Alias so a registrar can pick either naming style. */
export const skillsDomain = createSkillsDomain
