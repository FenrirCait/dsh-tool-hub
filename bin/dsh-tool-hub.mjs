#!/usr/bin/env node
/**
 * dsh-tool-hub — command line.
 *
 * Zero dependencies beyond Node itself, and no host process: it reads and
 * writes the same three things the panel does — the profile's
 * `cordis.patch.yml`, `<dshHome>/tool-hub/state.json`, and the `SKILL.md` ↔
 * `SKILL.md.disabled` rename — so a script, a CI job or a user in a terminal can
 * switch things without a browser.
 *
 * Rules it follows:
 *   - only the targeted row of a patch file is written (see lib/patch-rows.js);
 *     everything else, comments and line endings included, stays byte-identical;
 *   - every write is preceded by a copy in `<dshHome>/backups/` and lands through
 *     a temp file + rename;
 *   - the descriptor profile is off-limits: the desktop app owns it;
 *   - credentials are never read. `config export` copies four state keys by
 *     name, and `mcp list` never prints `env`/`headers`;
 *   - the two config commands take a path from the user, so both confine it
 *     first: exports stay inside `$DSH_HOME` / the working directory (unless
 *     `--force`), never follow a symlink, and never create a parent directory
 *     without `--mkdir`; imports must be a regular file of at most 2 MB, and
 *     `--replace` also needs `--yes` because it throws the whole state away.
 *
 * Exit codes: 0 success, 1 usage, 2 not found, 3 validation failure.
 */
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRows, removeRow, setRowDisabled } from '../lib/patch-rows.js'
import { captureSnapshot, describePlan, normalizeScene, runScene } from '../lib/scene-engine.js'

const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
const SKILL_FILE = 'SKILL.md'
const DISABLED_SUFFIX = '.disabled'
const DEFAULT_COLLECTION = { id: 'default', name: '默认分组群', order: 0 }
/**
 * The panel's own row. A bulk action (group / preset) never switches it off: that
 * would remove the thing the user is standing on. An explicit single-row command
 * still may, because then the user named it.
 */
const SELF_ROW_IDS = new Set(['tool-hub'])

const EXIT = { ok: 0, usage: 1, missing: 2, invalid: 3 }

class CliFailure extends Error {
  constructor(message, exitCode = EXIT.usage, code = 'usage') {
    super(message)
    this.exitCode = exitCode
    this.code = code
  }
}

const usage = (message, code = 'usage') => new CliFailure(message, EXIT.usage, code)
const missing = (message, code = 'not-found') => new CliFailure(message, EXIT.missing, code)
const invalid = (message, code = 'invalid') => new CliFailure(message, EXIT.invalid, code)

// ── argv ─────────────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(['--profile', '--workspace', '--set', '--names', '--tools-deny', '--mcp-off'])

function parseArgv(argv) {
  const options = {
    profile: 'web',
    workspace: null,
    set: null,
    toolsDeny: null,
    mcpOff: null,
    json: false,
    global: false,
    replace: false,
    onlyEnable: false,
    force: false,
    mkdir: false,
    yes: false,
    help: false,
    version: false,
    positionals: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      options.positionals.push(...argv.slice(index + 1))
      break
    }
    if (token === '-h' || token === '--help') {
      options.help = true
      continue
    }
    if (token === '--version') {
      options.version = true
      continue
    }
    if (token === '--json') {
      options.json = true
      continue
    }
    if (token === '--global') {
      options.global = true
      continue
    }
    if (token === '--replace') {
      options.replace = true
      continue
    }
    if (token === '--only-enable') {
      options.onlyEnable = true
      continue
    }
    if (token === '--force') {
      options.force = true
      continue
    }
    if (token === '--mkdir') {
      options.mkdir = true
      continue
    }
    if (token === '--yes') {
      options.yes = true
      continue
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals >= 0 ? token.slice(0, equals) : token
      let value = equals >= 0 ? token.slice(equals + 1) : null
      if (!VALUE_FLAGS.has(name)) throw usage(`unknown option ${name}`)
      if (value === null) {
        index += 1
        value = argv[index]
        if (value === undefined) throw usage(`${name} needs a value`)
      }
      // An empty value is meaningful for two flags: `--names ""` clears a session overlay, and
      // `--tools-deny ""` stores an empty deny list, which clears the mask on apply (omitting
      // the flag means "do not touch tools"). An empty `--mcp-off` has no such meaning — an
      // empty off/on list is not "turn everything on", it is just nothing to do.
      if (value === '' && !['--names', '--tools-deny'].includes(name)) throw usage(`${name} needs a value`)
      if (name === '--profile') options.profile = value
      else if (name === '--workspace') options.workspace = value
      else if (name === '--names') options.names = value
      else if (name === '--tools-deny') options.toolsDeny = value
      else if (name === '--mcp-off') options.mcpOff = value
      else options.set = value
      continue
    }
    if (token.startsWith('-') && token !== '-') throw usage(`unknown option ${token}`)
    options.positionals.push(token)
  }
  return options
}

// ── paths and profiles ───────────────────────────────────────────────────────

function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv === '' ? join(homedir(), '.dsh') : resolve(fromEnv)
}

/**
 * The profile every command works on. `desktop` is refused up front: the desktop
 * app owns that profile and rewrites it from its own state, so a CLI edit there
 * would be overwritten or, worse, fight the running app.
 */
function makeContext(options) {
  const home = dshHome()
  const name = String(options.profile ?? 'web')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw usage(`"${name}" is not a valid profile name`)
  if (name === 'desktop') {
    throw missing('the desktop profile is owned by the desktop app; use --profile web (or another profile)', 'profile-desktop')
  }
  const dir = join(home, 'profiles', name)
  return {
    home,
    name,
    dir,
    patchFile: join(dir, 'cordis.patch.yml'),
    stateFile: join(home, 'tool-hub', 'state.json'),
    backups: join(home, 'backups'),
    trash: join(home, 'tool-hub', 'trash'),
  }
}

async function exists(file) {
  const info = await stat(file).catch(() => null)
  return info !== null
}

/** The patch text, or null when the profile has no patch file yet. */
async function readPatch(ctx) {
  try {
    return await readFile(ctx.patchFile, 'utf8')
  }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw new CliFailure(`cannot read ${ctx.patchFile}: ${error.message}`, EXIT.missing, 'patch-unreadable')
  }
}

/** The patch of a profile that must exist; a missing profile is a "not found". */
async function requirePatch(ctx) {
  const info = await stat(ctx.dir).catch(() => null)
  if (info === null || !info.isDirectory()) throw missing(`profile "${ctx.name}" not found at ${ctx.dir}`, 'profile-not-found')
  return (await readPatch(ctx)) ?? ''
}

async function backupFile(ctx, file) {
  const info = await stat(file).catch(() => null)
  if (info === null || !info.isFile()) return null
  await mkdir(ctx.backups, { recursive: true })
  const ext = extname(file) || '.bak'
  const stem = basename(file, ext)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let target = join(ctx.backups, `${stem}-${stamp}${ext}`)
  let suffix = 1
  while (existsSync(target)) {
    target = join(ctx.backups, `${stem}-${stamp}-${suffix}${ext}`)
    suffix += 1
  }
  await copyFile(file, target)
  return target
}

async function writeFileAtomic(file, text) {
  const info = await stat(file).catch(() => null)
  const mode = info === null ? 0o600 : info.mode & 0o777
  await mkdir(dirname(resolve(file)), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, text, { encoding: 'utf8', mode })
  await rename(temp, file)
}

/** Back up, then write. The backup path is reported so a caller can undo. */
async function writePatch(ctx, text) {
  await mkdir(ctx.dir, { recursive: true })
  const backup = await backupFile(ctx, ctx.patchFile)
  await writeFileAtomic(ctx.patchFile, text)
  return backup
}

// ── state ────────────────────────────────────────────────────────────────────

function emptyState() {
  return {
    version: 1,
    groups: [],
    collections: [{ ...DEFAULT_COLLECTION }],
    presets: [],
    toolDeny: [],
    auto: { appliedAt: null },
    // Session overlays: <sessionId> -> mcp__* names that session switched off.
    sessions: {},
    // Saved environments (tools + MCP) and the record of the one currently applied. The panel
    // keeps both in this file too; lib/scene-engine.js owns their shape.
    scenes: {},
    mode: null,
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keys this CLI owns. Anything else already in state.json belongs to the panel and
 * is carried through untouched so a rewrite never drops a field we do not know.
 */
const OWNED_STATE_KEYS = new Set(['version', 'groups', 'collections', 'presets', 'toolDeny', 'auto', 'sessions', 'scenes', 'mode'])

async function readState(ctx) {
  let raw
  try {
    raw = JSON.parse(await readFile(ctx.stateFile, 'utf8'))
  }
  catch (error) {
    if (error.code === 'ENOENT') return emptyState()
    if (error instanceof SyntaxError) throw invalid(`${ctx.stateFile} is not valid JSON: ${error.message}`, 'state-invalid')
    throw new CliFailure(`cannot read ${ctx.stateFile}: ${error.message}`, EXIT.missing, 'state-unreadable')
  }
  if (!isRecord(raw)) throw invalid(`${ctx.stateFile} must hold a JSON object`, 'state-invalid')
  const state = emptyState()
  state.version = typeof raw.version === 'number' ? raw.version : 1
  if (Array.isArray(raw.groups)) state.groups = raw.groups.filter(isRecord)
  if (Array.isArray(raw.collections)) state.collections = [DEFAULT_COLLECTION, ...raw.collections.filter(isRecord).filter(entry => entry.id !== 'default')]
  if (Array.isArray(raw.presets)) state.presets = raw.presets.filter(isRecord)
  if (Array.isArray(raw.toolDeny)) state.toolDeny = raw.toolDeny.filter(name => typeof name === 'string')
  if (isRecord(raw.auto)) state.auto = raw.auto
  if (isRecord(raw.sessions)) {
    for (const [sessionId, names] of Object.entries(raw.sessions)) {
      if (sessionId === '' || !Array.isArray(names)) continue
      const deny = names.filter(name => typeof name === 'string' && name.startsWith('mcp__'))
      if (deny.length > 0) state.sessions[sessionId] = [...new Set(deny)]
    }
  }
  if (isRecord(raw.scenes)) {
    for (const [name, value] of Object.entries(raw.scenes)) {
      const scene = normalizeScene(value)
      if (scene !== null && scene.name === name) state.scenes[name] = scene
    }
  }
  if (isRecord(raw.mode) && typeof raw.mode.name === 'string' && raw.mode.name !== '' && isRecord(raw.mode.snapshot)) {
    state.mode = { name: raw.mode.name, at: typeof raw.mode.at === 'number' ? raw.mode.at : Date.now(), snapshot: raw.mode.snapshot }
  }
  const extra = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!OWNED_STATE_KEYS.has(key)) extra[key] = value
  }
  if (Object.keys(extra).length > 0) state.extra = extra
  return state
}

async function writeState(ctx, state) {
  await mkdir(dirname(resolve(ctx.stateFile)), { recursive: true })
  const backup = await backupFile(ctx, ctx.stateFile)
  const payload = {
    ...(isRecord(state.extra) ? state.extra : {}),
    version: state.version,
    groups: state.groups,
    collections: state.collections,
    presets: state.presets,
    toolDeny: state.toolDeny,
    auto: state.auto,
    sessions: state.sessions,
    scenes: state.scenes,
    mode: state.mode,
  }
  await writeFileAtomic(ctx.stateFile, `${JSON.stringify(payload, null, 2)}\n`)
  return backup
}

// ── patch rows ───────────────────────────────────────────────────────────────

/** Strip the loader's tree prefixes: a group member reads `include:<patchId>`. */
function idVariants(wanted) {
  const value = String(wanted ?? '').trim()
  if (value === '') return []
  const out = [value]
  let stripped = value
  while (stripped.startsWith('include:') || stripped.startsWith('patch:')) {
    stripped = stripped.slice(stripped.indexOf(':') + 1)
    out.push(stripped)
  }
  const tail = stripped.split(/[:/]/).pop()
  if (tail !== undefined && !out.includes(tail)) out.push(tail)
  return out
}

function matchesId(candidate, wanted) {
  return idVariants(wanted).includes(candidate)
}

function findRow(rows, wanted) {
  const variants = idVariants(wanted)
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (variants.includes(rows[index].id)) return rows[index]
  }
  return undefined
}

function requireRow(rows, wanted) {
  const row = findRow(rows, wanted)
  if (row === undefined) throw missing(`no patch row answers to "${wanted}"`, 'row-not-found')
  return row
}

/** The scalar value of one key inside a row's `config:` block. */
function configScalar(lines, row, key) {
  if (row.configStart < 0 || row.configEnd <= row.configStart) return null
  const wanted = row.indent + 2
  for (let index = row.configStart; index < row.configEnd; index += 1) {
    const line = lines[index]
    if (line === undefined || line.trim() === '') continue
    if (line.length - line.trimStart().length !== wanted) continue
    const match = /^([^:#]+?)[ \t]*:[ \t]*(.*)$/.exec(line.trimStart())
    if (match === null || match[1].trim() !== key) continue
    const value = match[2].trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1)
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1)
    return value
  }
  return null
}

/** Every MCP client row, named by the `serverName` its config carries. */
function mcpServers(text) {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/)
  return parseRows(source)
    .filter(row => row.name === MCP_MODULE)
    .map(row => ({
      id: row.id,
      serverName: configScalar(lines, row, 'serverName') ?? row.id,
      transport: configScalar(lines, row, 'transport') ?? 'stdio',
      command: configScalar(lines, row, 'command') ?? '',
      url: configScalar(lines, row, 'url') ?? '',
      disabled: row.disabled,
      enabled: !row.disabled,
      startLine: row.startLine,
      endLine: row.endLine,
    }))
}

function findServer(servers, wanted) {
  const name = String(wanted ?? '').trim()
  const exact = servers.filter(server => server.serverName === name)
  if (exact.length > 0) return exact[exact.length - 1]
  const byId = servers.filter(server => matchesId(server.id, name))
  if (byId.length > 0) return byId[byId.length - 1]
  return undefined
}

function rowBlock(text, row) {
  return text.split(/\r?\n/).slice(row.startLine, row.endLine).join('\n')
}

// ── skills ───────────────────────────────────────────────────────────────────

function skillRoots(ctx, options) {
  const roots = [
    { id: 'user', dir: join(ctx.home, 'skills'), scope: 'global' },
    { id: 'agents', dir: join(homedir(), '.agents', 'skills'), scope: 'global' },
  ]
  if (options.global === true) {
    if (options.workspace !== null) throw usage('--global and --workspace contradict each other')
    return roots
  }
  if (options.workspace !== null) {
    const workspace = resolve(options.workspace)
    roots.push({ id: 'ws', dir: join(workspace, '.dsh', 'skills'), scope: 'workspace', workspace })
  }
  return roots
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return {}
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (pair === null) continue
    let value = pair[2].trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    fields[pair[1]] = value
  }
  return fields
}

async function readSkillDir(abs, root, rel) {
  const on = join(abs, SKILL_FILE)
  const off = `${on}${DISABLED_SUFFIX}`
  const hasOn = await exists(on)
  const hasOff = !hasOn && (await exists(off))
  if (!hasOn && !hasOff) return null
  let fields = {}
  try {
    fields = frontmatter(await readFile(hasOn ? on : off, 'utf8'))
  }
  catch {
    fields = {}
  }
  const fallback = rel.split('/').pop()
  return {
    id: `${root.id}|${rel}`,
    name: typeof fields.name === 'string' && fields.name !== '' ? fields.name : fallback,
    dir: abs,
    dirName: fallback,
    root: root.id,
    scope: root.scope,
    enabled: hasOn,
    path: hasOn ? on : off,
  }
}

async function scanSkillRoot(root, depth = 0, rel = '') {
  const out = []
  let entries
  try {
    entries = await readdir(join(root.dir, rel), { withFileTypes: true })
  }
  catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (!entry.isDirectory()) continue
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    const abs = join(root.dir, childRel)
    const skill = await readSkillDir(abs, root, childRel)
    if (skill !== null) {
      out.push(skill)
      continue
    }
    if (depth < 3) out.push(...await scanSkillRoot(root, depth + 1, childRel))
  }
  return out
}

async function scanSkills(ctx, options) {
  const skills = []
  for (const root of skillRoots(ctx, options)) {
    if (!(await exists(root.dir))) continue
    skills.push(...await scanSkillRoot(root))
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

function resolveSkill(skills, wanted) {
  const name = String(wanted ?? '').trim()
  if (name === '') throw usage('a skill name is required')
  const exact = skills.filter(skill => skill.id === name || skill.name === name || skill.dirName === name)
  if (exact.length === 1) return exact[0]
  if (exact.length === 0) throw missing(`no skill answers to "${name}"`, 'skill-not-found')
  const list = exact.map(skill => `${skill.id} (${skill.dir})`).join(', ')
  throw invalid(`"${name}" is ambiguous: ${list}`, 'skill-ambiguous')
}

/** Flip a skill by renaming its entry file, exactly like the panel does. */
async function setSkillEnabled(skill, enabled) {
  const on = join(skill.dir, SKILL_FILE)
  const off = `${on}${DISABLED_SUFFIX}`
  const hasOn = await exists(on)
  const hasOff = await exists(off)
  if (enabled) {
    if (hasOn) return { changed: false, message: 'already on' }
    if (!hasOff) throw missing(`${SKILL_FILE} not found in ${skill.dir}`, 'skill-file-missing')
    await rename(off, on)
    return { changed: true, message: 'renamed on' }
  }
  if (hasOff) return { changed: false, message: 'already off' }
  if (!hasOn) throw missing(`${SKILL_FILE} not found in ${skill.dir}`, 'skill-file-missing')
  await rename(on, off)
  return { changed: true, message: 'renamed off' }
}

function safeName(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9\-_.]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return cleaned === '' ? 'skill' : cleaned
}

async function movePath(from, to) {
  try {
    await rename(from, to)
  }
  catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await copyTree(from, to)
    await rm(from, { recursive: true, force: true })
  }
}

async function copyTree(from, to) {
  await cp(from, to, { recursive: true, force: true })
}

/** Delete is a move into the panel's own trash folder, with a note of origin. */
async function trashSkill(ctx, skill) {
  await mkdir(ctx.trash, { recursive: true })
  const stamp = `${Date.now()}`
  let target = join(ctx.trash, `${stamp}-${safeName(skill.name)}`)
  let suffix = 1
  while (await exists(target)) {
    target = join(ctx.trash, `${stamp}-${safeName(skill.name)}-${suffix}`)
    suffix += 1
  }
  await movePath(skill.dir, target)
  const meta = { name: skill.name, id: skill.id, path: skill.dir, root: skill.root, at: new Date().toISOString() }
  await writeFile(join(target, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return target
}

// ── state merging for config import ──────────────────────────────────────────

function validateConfig(raw) {
  if (!isRecord(raw)) throw invalid('an imported config must be a JSON object', 'config-invalid')
  for (const key of ['groups', 'collections', 'presets', 'toolDeny']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) throw invalid(`"${key}" must be an array`, 'config-invalid')
  }
  const collections = []
  for (const entry of raw.collections ?? []) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '' || typeof entry.name !== 'string' || entry.name === '') {
      throw invalid('every collection needs a string id and name', 'config-invalid')
    }
    collections.push({ id: entry.id, name: entry.name, order: typeof entry.order === 'number' ? entry.order : collections.length })
  }
  const groups = []
  for (const entry of raw.groups ?? []) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw invalid('every group needs a name', 'config-invalid')
    }
    const members = []
    const seen = new Set()
    for (const member of Array.isArray(entry.members) ? entry.members : []) {
      if (!isRecord(member) || typeof member.id !== 'string' || member.id === '') {
        throw invalid(`group "${entry.name}" has a member without an id`, 'config-invalid')
      }
      const kind = member.kind === 'skill' ? 'skill' : member.kind === 'plugin' ? 'plugin' : null
      if (kind === null) throw invalid(`group "${entry.name}" has a member of unknown kind`, 'config-invalid')
      const key = `${kind}:${member.id}`
      if (seen.has(key)) continue
      seen.add(key)
      members.push({ kind, id: member.id })
    }
    groups.push({ ...entry, name: entry.name.trim(), id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `g${groups.length + 1}`, members })
  }
  const presets = []
  const presetNames = new Set()
  for (const entry of raw.presets ?? []) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw invalid('every preset needs a name', 'config-invalid')
    }
    if (presetNames.has(entry.name)) throw invalid(`preset "${entry.name}" appears twice`, 'config-invalid')
    presetNames.add(entry.name)
    presets.push({ ...entry, name: entry.name.trim() })
  }
  const toolDeny = (raw.toolDeny ?? []).filter(name => typeof name === 'string')
  return { collections, groups, presets, toolDeny }
}

function mergeState(state, incoming) {
  const next = { ...state, groups: [...state.groups], collections: [...state.collections], presets: [...state.presets], toolDeny: [...state.toolDeny] }
  const collections = new Map(next.collections.map(entry => [entry.id, entry]))
  for (const entry of incoming.collections) if (!collections.has(entry.id)) collections.set(entry.id, entry)
  next.collections = [...collections.values()].sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  const byId = new Map(next.groups.map(group => [group.id, group]))
  const byName = new Map(next.groups.map(group => [group.name, group]))
  for (const group of incoming.groups) {
    const target = byId.get(group.id) ?? byName.get(group.name)
    if (target === undefined) {
      next.groups.push(group)
      byId.set(group.id, group)
      byName.set(group.name, group)
      continue
    }
    const members = Array.isArray(target.members) ? target.members : []
    const seen = new Set(members.map(member => `${member.kind}:${member.id}`))
    for (const member of group.members) {
      const key = `${member.kind}:${member.id}`
      if (seen.has(key)) continue
      seen.add(key)
      members.push(member)
    }
    target.members = members
  }
  const byPreset = new Map(next.presets.map(preset => [preset.name, preset]))
  for (const preset of incoming.presets) {
    const target = byPreset.get(preset.name)
    if (target === undefined) next.presets.push(preset)
    else Object.assign(target, preset)
    byPreset.set(preset.name, target ?? preset)
  }
  next.toolDeny = [...new Set([...next.toolDeny, ...incoming.toolDeny])]
  return next
}

function replaceState(state, incoming) {
  const collections = incoming.collections.length === 0 ? [{ ...DEFAULT_COLLECTION }] : incoming.collections
  if (!collections.some(entry => entry.id === 'default')) collections.unshift({ ...DEFAULT_COLLECTION })
  return { ...state, groups: incoming.groups, collections, presets: incoming.presets, toolDeny: incoming.toolDeny }
}

// ── output ───────────────────────────────────────────────────────────────────

function emit(options, json, human) {
  if (options.json) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`)
  else process.stdout.write(`${human.join('\n')}\n`)
}

function pad(value, width) {
  const text = String(value ?? '')
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function renderRows(rows) {
  const lines = []
  const idWidth = Math.max(4, ...rows.map(row => row.id.length))
  const nameWidth = Math.max(4, ...rows.map(row => String(row.name ?? '').length))
  for (const row of rows) {
    const name = row.name === null ? '-' : row.name
    lines.push(`  ${row.disabled ? 'OFF' : 'ON '}  ${pad(row.id, idWidth)}  ${pad(name, nameWidth)}`)
  }
  return lines
}

function stateSummary(state) {
  return {
    groups: state.groups.length,
    presets: state.presets.length,
    collections: state.collections.length,
    toolDeny: state.toolDeny.length,
    sessions: Object.keys(state.sessions).length,
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdList(ctx, options) {
  const text = await readPatch(ctx)
  const rows = text === null ? [] : parseRows(text)
  const servers = mcpServers(text ?? '')
  const skills = await scanSkills(ctx, options)
  const state = await readState(ctx)
  const groupSummaries = state.groups.map((group) => {
    const members = Array.isArray(group.members) ? group.members : []
    let off = 0
    let missingMembers = 0
    for (const member of members) {
      if (member.kind === 'plugin') {
        const row = findRow(rows, member.id)
        if (row === undefined) missingMembers += 1
        else if (row.disabled) off += 1
      }
      else {
        const skill = skills.find(candidate => matchesId(candidate.id, member.id))
        if (skill === undefined) missingMembers += 1
        else if (!skill.enabled) off += 1
      }
    }
    return {
      id: typeof group.id === 'string' ? group.id : null,
      name: typeof group.name === 'string' ? group.name : '(unnamed)',
      members: members.length,
      plugins: members.filter(member => member.kind === 'plugin').length,
      skills: members.filter(member => member.kind === 'skill').length,
      off,
      missing: missingMembers,
    }
  })
  const presets = state.presets.map(preset => ({
    name: typeof preset.name === 'string' ? preset.name : '(unnamed)',
    plugins: presetPluginIds(preset).length,
    skills: presetSkillIds(preset).length,
    note: typeof preset.note === 'string' ? preset.note : '',
  }))
  const json = {
    ok: true,
    profile: ctx.name,
    dshHome: ctx.home,
    patch: { file: ctx.patchFile, exists: text !== null, rows: rows.length },
    rows: rows.map(row => ({
      id: row.id,
      name: row.name,
      disabled: row.disabled,
      enabled: !row.disabled,
      startLine: row.startLine,
      endLine: row.endLine,
      indent: row.indent,
    })),
    mcp: servers,
    skills: skills.map(skill => ({ id: skill.id, name: skill.name, enabled: skill.enabled, path: skill.dir, root: skill.root, scope: skill.scope })),
    groups: groupSummaries,
    presets,
    toolDeny: state.toolDeny,
    state: stateSummary(state),
  }
  const human = [
    `profile  ${ctx.name}`,
    `dsh home ${ctx.home}`,
    `patch    ${ctx.patchFile}${text === null ? '  (missing)' : `  (${rows.length} rows)`}`,
    '',
    `plugins (${rows.length})`,
    ...(rows.length === 0 ? ['  (none)'] : renderRows(rows)),
    '',
    `mcp (${servers.length})`,
    ...(servers.length === 0
      ? ['  (none)']
      : servers.map(server => `  ${server.disabled ? 'OFF' : 'ON '}  ${pad(server.id, Math.max(4, ...servers.map(item => item.id.length)))}  ${server.serverName}  ${server.transport}`)),
    '',
    `skills (${skills.length})`,
    ...(skills.length === 0
      ? ['  (none)']
      : skills.map(skill => `  ${skill.enabled ? 'ON ' : 'OFF'}  ${pad(skill.name, Math.max(4, ...skills.map(item => item.name.length)))}  ${skill.id}`)),
    '',
    `groups (${groupSummaries.length})`,
    ...(groupSummaries.length === 0
      ? ['  (none)']
      : groupSummaries.map(group => `  ${pad(group.name, Math.max(4, ...groupSummaries.map(item => item.name.length)))}  ${group.members} members${group.off === 0 ? '' : ` · ${group.off} off`}${group.missing === 0 ? '' : ` · ${group.missing} missing`}`)),
    '',
    `presets (${presets.length})`,
    ...(presets.length === 0 ? ['  (none)'] : presets.map(preset => `  ${preset.name}  ${preset.plugins} plugins · ${preset.skills} skills`)),
  ]
  emit(options, json, human)
  return EXIT.ok
}

async function cmdPlugin(ctx, action, entryId, options) {
  if (action !== 'enable' && action !== 'disable') throw usage(`plugin ${action ?? ''} is not a command; use plugin enable|disable <entryId>`)
  if (entryId === undefined) throw usage(`plugin ${action} needs an entry id`)
  const text = await requirePatch(ctx)
  const row = requireRow(parseRows(text), entryId)
  const enabled = action === 'enable'
  const next = setRowDisabled(text, row.id, !enabled)
  const changed = next !== text
  const backup = changed ? await writePatch(ctx, next) : null
  const json = { ok: true, profile: ctx.name, id: row.id, enabled, changed, backup }
  emit(options, json, changed
    ? [`${enabled ? 'enabled' : 'disabled'} ${row.id}`, `backup ${backup}`]
    : [`${row.id} is already ${enabled ? 'enabled' : 'disabled'}`])
  return EXIT.ok
}

function presetPluginIds(preset) {
  const enabled = preset?.enabled
  if (Array.isArray(enabled)) return enabled.filter(id => typeof id === 'string')
  if (isRecord(enabled) && Array.isArray(enabled.plugin)) return enabled.plugin.filter(id => typeof id === 'string')
  return []
}

function presetSkillIds(preset) {
  const enabled = preset?.enabled
  if (isRecord(enabled) && Array.isArray(enabled.skill)) return enabled.skill.filter(id => typeof id === 'string')
  return []
}

function findGroup(state, name) {
  const wanted = String(name ?? '').trim()
  const byName = state.groups.filter(group => group.name === wanted)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw invalid(`group name "${wanted}" is ambiguous (${byName.map(group => group.id).join(', ')})`, 'group-ambiguous')
  const byId = state.groups.find(group => group.id === wanted)
  if (byId !== undefined) return byId
  throw missing(`no group named "${wanted}"`, 'group-not-found')
}

async function cmdGroup(ctx, action, name, options) {
  const state = await readState(ctx)
  if (action === 'list' || action === undefined) {
    const text = await readPatch(ctx)
    const rows = text === null ? [] : parseRows(text)
    const skills = await scanSkills(ctx, options)
    const groups = state.groups.map((group) => {
      const members = Array.isArray(group.members) ? group.members : []
      let off = 0
      let absent = 0
      for (const member of members) {
        if (member.kind === 'plugin') {
          const row = findRow(rows, member.id)
          if (row === undefined) absent += 1
          else if (row.disabled) off += 1
        }
        else {
          const skill = skills.find(candidate => matchesId(candidate.id, member.id))
          if (skill === undefined) absent += 1
          else if (!skill.enabled) off += 1
        }
      }
      return { id: group.id, name: group.name, members: members.length, off, missing: absent }
    })
    const json = { ok: true, profile: ctx.name, groups }
    const width = Math.max(4, ...groups.map(group => String(group.name).length))
    emit(options, json, groups.length === 0
      ? ['no groups']
      : groups.map(group => `${pad(group.name, width)}  ${group.members} members${group.off === 0 ? '' : ` · ${group.off} off`}${group.missing === 0 ? '' : ` · ${group.missing} missing`}`))
    return EXIT.ok
  }
  if (action !== 'on' && action !== 'off') throw usage(`unknown group command "${action}"`)
  if (name === undefined) throw usage(`group ${action} needs a group name`)
  const group = findGroup(state, name)
  const enabled = action === 'on'
  let text = await requirePatch(ctx)
  let skills = await scanSkills(ctx, options)
  const changed = []
  const skipped = []
  for (const member of Array.isArray(group.members) ? group.members : []) {
    if (member.kind === 'plugin') {
      const row = findRow(parseRows(text), member.id)
      if (row === undefined) {
        skipped.push({ kind: 'plugin', id: member.id, reason: 'no-patch-row' })
        continue
      }
      if (!enabled && SELF_ROW_IDS.has(row.id)) {
        skipped.push({ kind: 'plugin', id: row.id, reason: 'protected' })
        continue
      }
      const next = setRowDisabled(text, row.id, !enabled)
      if (next !== text) {
        text = next
        changed.push({ kind: 'plugin', id: row.id })
      }
      continue
    }
    const skill = skills.find(candidate => matchesId(candidate.id, member.id))
    if (skill === undefined) {
      skipped.push({ kind: 'skill', id: member.id, reason: 'not-in-known-roots' })
      continue
    }
    const result = await setSkillEnabled(skill, enabled)
    if (result.changed) changed.push({ kind: 'skill', id: skill.id })
  }
  const backup = changed.some(entry => entry.kind === 'plugin') ? await writePatch(ctx, text) : null
  const json = { ok: true, profile: ctx.name, group: group.name, enabled, changed, skipped, backup }
  emit(options, json, [
    `group ${group.name}: ${action}`,
    `changed ${changed.length}${skipped.length === 0 ? '' : ` · skipped ${skipped.length}`}`,
    ...changed.map(entry => `  ${entry.kind} ${entry.id}`),
    ...skipped.map(entry => `  skipped ${entry.kind} ${entry.id} (${entry.reason})`),
    ...(backup === null ? [] : [`backup ${backup}`]),
  ])
  return EXIT.ok
}

async function cmdPreset(ctx, action, name, options) {
  const state = await readState(ctx)
  if (action === 'list' || action === undefined) {
    const presets = state.presets.map(preset => ({
      name: preset.name,
      plugins: presetPluginIds(preset).length,
      skills: presetSkillIds(preset).length,
      note: typeof preset.note === 'string' ? preset.note : '',
      createdAt: typeof preset.createdAt === 'number' ? preset.createdAt : null,
    }))
    const json = { ok: true, profile: ctx.name, presets }
    emit(options, json, presets.length === 0
      ? ['no presets']
      : presets.map(preset => `${preset.name}  ${preset.plugins} plugins · ${preset.skills} skills${preset.note === '' ? '' : `  ${preset.note}`}`))
    return EXIT.ok
  }
  if (action !== 'apply') throw usage(`unknown preset command "${action}"`)
  if (name === undefined) throw usage('preset apply needs a preset name')
  const preset = state.presets.find(entry => entry.name === name)
  if (preset === undefined) throw missing(`no preset named "${name}"`, 'preset-not-found')
  const wantedPlugins = new Set(presetPluginIds(preset))
  const wantedSkills = new Set(presetSkillIds(preset))
  // `exact` (the default, same as the panel) makes the profile look like the preset:
  // everything it does not name is switched off. `--only-enable` only turns things on.
  const exact = options.onlyEnable !== true
  let text = await requirePatch(ctx)
  const rows = parseRows(text)
  const changed = []
  for (const row of rows) {
    const candidates = [row.id, `include:${row.id}`, `patch:${row.id}`]
    const enabled = candidates.some(id => wantedPlugins.has(id))
    if (!enabled && SELF_ROW_IDS.has(row.id)) continue
    if (!enabled && !exact) continue
    const next = setRowDisabled(text, row.id, !enabled)
    if (next !== text) {
      text = next
      changed.push({ kind: 'plugin', id: row.id, enabled })
    }
  }
  const skills = await scanSkills(ctx, options)
  for (const skill of skills) {
    const enabled = wantedSkills.has(skill.id)
    if (enabled === skill.enabled) continue
    if (!enabled && !exact) continue
    const result = await setSkillEnabled(skill, enabled)
    if (result.changed) changed.push({ kind: 'skill', id: skill.id, enabled })
  }
  const backup = changed.some(entry => entry.kind === 'plugin') ? await writePatch(ctx, text) : null
  const json = { ok: true, profile: ctx.name, preset: preset.name, mode: exact ? 'exact' : 'only-enable', changed, backup }
  emit(options, json, [
    `preset ${preset.name}: applied`,
    `changed ${changed.length}`,
    ...changed.map(entry => `  ${entry.kind} ${entry.id} → ${entry.enabled ? 'on' : 'off'}`),
    ...(backup === null ? [] : [`backup ${backup}`]),
  ])
  return EXIT.ok
}

async function cmdSkill(ctx, action, name, options) {
  const skills = await scanSkills(ctx, options)
  if (action === 'list' || action === undefined) {
    const json = {
      ok: true,
      roots: skillRoots(ctx, options).map(root => root.dir),
      skills: skills.map(skill => ({ id: skill.id, name: skill.name, enabled: skill.enabled, path: skill.dir, root: skill.root, scope: skill.scope })),
    }
    const width = Math.max(4, ...skills.map(skill => skill.name.length))
    emit(options, json, skills.length === 0
      ? ['no skills']
      : skills.map(skill => `${skill.enabled ? 'ON ' : 'OFF'}  ${pad(skill.name, width)}  ${skill.id}`))
    return EXIT.ok
  }
  if (action !== 'enable' && action !== 'disable' && action !== 'delete') {
    throw usage(`unknown skill command "${action}"`)
  }
  if (name === undefined) throw usage(`skill ${action} needs a skill name`)
  const skill = resolveSkill(skills, name)
  if (action === 'delete') {
    const target = await trashSkill(ctx, skill)
    const json = { ok: true, name: skill.name, id: skill.id, deleted: true, trash: target }
    emit(options, json, [`deleted ${skill.name}`, `moved to ${target}`])
    return EXIT.ok
  }
  const result = await setSkillEnabled(skill, action === 'enable')
  const json = { ok: true, name: skill.name, id: skill.id, enabled: action === 'enable', changed: result.changed, message: result.message }
  emit(options, json, [`${skill.name}: ${result.message}`])
  return EXIT.ok
}

async function cmdMcp(ctx, action, name, options) {
  const text = await readPatch(ctx)
  const servers = mcpServers(text ?? '')
  if (action === 'list' || action === undefined) {
    const json = { ok: true, profile: ctx.name, servers }
    const width = Math.max(4, ...servers.map(server => server.id.length))
    emit(options, json, servers.length === 0
      ? ['no MCP servers']
      : servers.map(server => `${server.disabled ? 'OFF' : 'ON '}  ${pad(server.id, width)}  ${server.serverName}  ${server.transport}${server.command === '' ? '' : `  ${server.command}`}${server.url === '' ? '' : `  ${server.url}`}`))
    return EXIT.ok
  }
  if (action === 'raw') {
    if (name === undefined) throw usage('mcp raw needs a server name')
    if (text === null) throw missing(`profile "${ctx.name}" has no patch file`, 'patch-missing')
    const rows = parseRows(text)
    const server = findServer(servers, name)
    if (server === undefined) throw missing(`no MCP server answers to "${name}"`, 'server-not-found')
    const row = requireRow(rows, server.id)
    if (options.set === null) {
      const block = rowBlock(text, row)
      const json = { ok: true, profile: ctx.name, id: row.id, serverName: server.serverName, text: block, startLine: row.startLine, endLine: row.endLine }
      emit(options, json, block.split('\n'))
      return EXIT.ok
    }
    const replacement = await buildReplacement(options.set, row)
    const records = textRecords(text)
    const tail = records[row.endLine - 1]?.eol ?? ''
    const fallback = dominantEolOf(records)
    replacement.forEach((record, index) => {
      record.eol = tail === '' && index < replacement.length - 1 ? fallback : tail
    })
    const next = joinRecordsOf([...records.slice(0, row.startLine), ...replacement, ...records.slice(row.endLine)])
    const backup = next === text ? null : await writePatch(ctx, next)
    const json = { ok: true, profile: ctx.name, id: row.id, serverName: server.serverName, changed: next !== text, backup }
    emit(options, json, next === text ? [`${row.id} is unchanged`] : [`replaced ${row.id}`, `backup ${backup}`])
    return EXIT.ok
  }
  if (action !== 'enable' && action !== 'disable') throw usage(`unknown mcp command "${action}"`)
  if (name === undefined) throw usage(`mcp ${action} needs a server name`)
  if (text === null) throw missing(`profile "${ctx.name}" has no patch file`, 'patch-missing')
  const server = findServer(servers, name)
  if (server === undefined) throw missing(`no MCP server answers to "${name}"`, 'server-not-found')
  const enabled = action === 'enable'
  const next = setRowDisabled(text, server.id, !enabled)
  const changed = next !== text
  const backup = changed ? await writePatch(ctx, next) : null
  const json = { ok: true, profile: ctx.name, id: server.id, serverName: server.serverName, enabled, changed, backup }
  emit(options, json, changed
    ? [`${enabled ? 'enabled' : 'disabled'} MCP server ${server.serverName} (${server.id})`, `backup ${backup}`]
    : [`MCP server ${server.serverName} is already ${enabled ? 'enabled' : 'disabled'}`])
  return EXIT.ok
}

/** A `--set` file must hold exactly one MCP row, and it must keep the target id. */
async function buildReplacement(file, target) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  }
  catch (error) {
    throw missing(`cannot read ${file}: ${error.message}`, 'set-file-missing')
  }
  const rows = parseRows(raw)
  if (rows.length !== 1) throw invalid(`--set must contain exactly one "- id:" row, found ${rows.length}`, 'set-row-count')
  const row = rows[0]
  if (row.name !== MCP_MODULE) throw invalid(`--set row must be an MCP client row (name: ${MCP_MODULE})`, 'set-row-kind')
  if (row.id !== target.id) throw invalid(`--set must keep the id "${target.id}", got "${row.id}"`, 'set-row-id')
  const records = textRecords(raw).slice(row.startLine, row.endLine)
  const delta = target.indent - row.indent
  return records.map((record) => {
    if (record.text.trim() === '') return { text: '', eol: '' }
    let line = record.text
    if (delta > 0) line = ' '.repeat(delta) + line
    else if (delta < 0) line = line.slice(Math.min(-delta, line.length - line.trimStart().length))
    return { text: line, eol: '' }
  })
}

// ── tiny line helpers shared with the writer above ───────────────────────────

function textRecords(text) {
  const records = []
  let index = 0
  while (index < text.length) {
    let end = index
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1
    let eol = ''
    if (end < text.length) {
      if (text[end] === '\r' && text[end + 1] === '\n') {
        eol = '\r\n'
        end += 2
      }
      else {
        eol = text[end]
        end += 1
      }
    }
    records.push({ text: text.slice(index, end - eol.length), eol })
    index = end
  }
  return records
}

function joinRecordsOf(records) {
  return records.map(record => record.text + record.eol).join('')
}

function dominantEolOf(records) {
  let crlf = 0
  let lf = 0
  for (const record of records) {
    if (record.eol === '\r\n') crlf += 1
    else if (record.eol === '\n') lf += 1
  }
  return crlf > lf ? '\r\n' : '\n'
}

// ── path guards for config export / import ───────────────────────────────────
//
// Both commands take a path straight from the user, so both decide first whether
// the path is one this tool may touch. A destination must be a regular file
// inside `$DSH_HOME` or the working directory, reachable without following a
// symbolic link; its parent must already exist unless `--mkdir` says otherwise,
// and leaving those two roots needs `--force`. A source must be a regular file,
// not a link, and no larger than `MAX_IMPORT_BYTES`.

const MAX_IMPORT_BYTES = 2 * 1024 * 1024

/** A path as it will be compared: absolute, and case-folded on Windows. */
function comparablePath(path) {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

/** True when `target` is `root` itself or sits below it. */
function isInside(target, root) {
  const rel = relative(comparablePath(root), comparablePath(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Reject a symbolic link at `start` or at any ancestor between it and `root`.
 * `root` may be null, in which case the walk stops at the first path that has no
 * parent (the drive or filesystem root).
 */
async function assertNoSymlink(start, root) {
  const stop = root === null ? null : comparablePath(root)
  let cursor = resolve(start)
  for (let guard = 0; guard < 64; guard += 1) {
    const info = await lstat(cursor).catch(() => null)
    if (info !== null && info.isSymbolicLink()) {
      throw usage(`refusing to follow a symbolic link: ${cursor}`, 'path-symlink')
    }
    if (stop !== null && comparablePath(cursor) === stop) return
    const parent = dirname(cursor)
    if (parent === cursor) return
    cursor = parent
  }
}

/** Validate a `config export` destination and return its absolute path. */
async function assertExportTarget(file, ctx, options) {
  const target = resolve(file)
  const home = resolve(ctx.home)
  const cwd = resolve(process.cwd())
  const insideHome = isInside(target, home)
  const insideCwd = isInside(target, cwd)
  if (!options.force && !insideHome && !insideCwd) {
    throw usage(`refusing to write outside ${home} or the working directory: ${target} (pass --force to allow it)`, 'path-outside')
  }
  const root = insideHome ? home : insideCwd ? cwd : null

  const info = await lstat(target).catch(() => null)
  if (info !== null) {
    if (info.isSymbolicLink()) throw usage(`refusing to write through a symbolic link: ${target}`, 'path-symlink')
    if (info.isDirectory()) throw usage(`the destination is a directory: ${target}`, 'path-directory')
    if (!info.isFile()) throw usage(`the destination is not a regular file: ${target}`, 'path-kind')
  }

  const parent = dirname(target)
  const parentInfo = await lstat(parent).catch(() => null)
  if (parentInfo === null) {
    if (!options.mkdir) throw usage(`the parent directory does not exist: ${parent} (pass --mkdir to create it)`, 'path-parent-missing')
  }
  else {
    if (parentInfo.isSymbolicLink()) throw usage(`refusing to write inside a symbolic link: ${parent}`, 'path-symlink')
    if (!parentInfo.isDirectory()) throw usage(`the parent is not a directory: ${parent}`, 'path-kind')
    await assertNoSymlink(parent, root)
  }
  return target
}

/** Validate a `config import` source and return its absolute path. */
async function assertImportSource(file) {
  const source = resolve(file)
  const info = await lstat(source).catch(() => null)
  if (info === null) throw missing(`cannot read ${source}: no such file`, 'config-file-missing')
  if (info.isSymbolicLink()) throw invalid(`refusing to read through a symbolic link: ${source}`, 'path-symlink')
  if (!info.isFile()) throw invalid(`not a regular file: ${source}`, 'path-kind')
  if (info.size > MAX_IMPORT_BYTES) {
    throw invalid(`the file is too large (${info.size} bytes; the limit is ${MAX_IMPORT_BYTES})`, 'config-too-large')
  }
  return source
}

/**
 * Ask before a `--replace` import throws the current state away. Only a real
 * terminal can answer; a pipe or a redirect counts as "no", and then `--yes` is
 * the only way through.
 */
function confirmReplace(source) {
  if (process.stdin.isTTY !== true) return false
  process.stderr.write(`dsh-tool-hub: replace the whole tool-hub state from ${source}? [y/N] `)
  const buffer = Buffer.alloc(64)
  let length = 0
  try {
    length = readSync(0, buffer, 0, buffer.length, null)
  }
  catch {
    return false
  }
  const answer = buffer.subarray(0, length).toString('utf8').trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}

async function cmdConfig(ctx, action, file, options) {
  if (action === 'export') {
    if (file === undefined) throw usage('config export needs a destination file')
    const target = await assertExportTarget(file, ctx, options)
    const state = await readState(ctx)
    const payload = {
      version: state.version,
      exportedAt: new Date().toISOString(),
      source: { profile: ctx.name },
      groups: state.groups,
      collections: state.collections,
      presets: state.presets,
      toolDeny: state.toolDeny,
    }
    if (options.mkdir) await mkdir(dirname(target), { recursive: true })
    await backupFile(ctx, target)
    await writeFileAtomic(target, `${JSON.stringify(payload, null, 2)}\n`)
    const json = { ok: true, profile: ctx.name, file: target, groups: payload.groups.length, presets: payload.presets.length, collections: payload.collections.length, toolDeny: payload.toolDeny.length }
    emit(options, json, [`exported ${payload.groups.length} groups, ${payload.presets.length} presets, ${payload.collections.length} collections to ${target}`])
    return EXIT.ok
  }
  if (action !== 'import') throw usage(`unknown config command "${action}"`)
  if (file === undefined) throw usage('config import needs a source file')
  const source = await assertImportSource(file)
  if (options.replace && options.yes !== true && confirmReplace(source) === false) {
    throw invalid('config import --replace rewrites the whole tool-hub state; pass --yes to confirm', 'replace-needs-yes')
  }
  let raw
  try {
    raw = await readFile(source, 'utf8')
  }
  catch (error) {
    throw missing(`cannot read ${source}: ${error.message}`, 'config-file-missing')
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  }
  catch (error) {
    throw invalid(`${file} is not valid JSON: ${error.message}`, 'config-invalid')
  }
  const incoming = validateConfig(parsed)
  const state = await readState(ctx)
  const next = options.replace ? replaceState(state, incoming) : mergeState(state, incoming)
  const backup = await writeState(ctx, next)
  const json = { ok: true, profile: ctx.name, file: source, mode: options.replace ? 'replace' : 'merge', groups: next.groups.length, presets: next.presets.length, collections: next.collections.length, toolDeny: next.toolDeny.length, backup }
  emit(options, json, [`imported (${json.mode}) ${incoming.groups.length} groups, ${incoming.presets.length} presets`, backup === null ? 'state file created' : `backup ${backup}`])
  return EXIT.ok
}

// ── help / version ───────────────────────────────────────────────────────────

const HELP = `dsh-tool-hub — switch plugins, skills and MCP servers of a DSH profile

Usage
  dsh-tool-hub list [--profile p] [--workspace path] [--json]
  dsh-tool-hub plugin enable|disable <entryId> [--profile p] [--json]
  dsh-tool-hub group list|on|off <name> [--profile p] [--json]
  dsh-tool-hub preset list|apply <name> [--only-enable] [--profile p] [--json]
  dsh-tool-hub skill list|enable|disable|delete <name> [--workspace path|--global] [--json]
  dsh-tool-hub mcp list|enable|disable <serverName> [--profile p] [--json]
  dsh-tool-hub mcp raw <serverName> [--set file] [--profile p]
  dsh-tool-hub session list|set <sessionId> --names a,b|clear <sessionId> [--profile p] [--json]
  dsh-tool-hub scene list|exit [--profile p] [--json]
  dsh-tool-hub scene save <name> [--tools-deny a,b] [--mcp-off x] [--profile p] [--json]
  dsh-tool-hub scene apply <name> [--profile p] [--json]
  dsh-tool-hub config export <file> [--mkdir] [--force] [--profile p]
  dsh-tool-hub config import <file> [--replace --yes] [--profile p]

Semantics
  preset apply       exact by default: rows and skills the preset does not name are
                     switched off (the panel's behaviour); --only-enable only turns
                     things on. The panel's own row is never switched off in bulk.
  session set        replaces one session's overlay (only mcp__* names survive); the panel's
                     installation list is untouched, and an empty --names clears the entry.
  scene save         stores a tools + MCP environment in state.json. Only mcp__* names are
                     kept in tools.deny; --mcp-off takes server names. A flag left out leaves
                     that domain untracked (apply will not touch it); an empty --tools-deny ("")
                     stores an empty deny list, which clears the mask on apply.
  scene apply        records the current environment first, then writes toolDeny and flips the
                     patch rows. A failure restores the snapshot, and the report names what is
                     still wrong if the restore itself fails. It cannot re-apply a live mask:
                     the host picks the new toolDeny up on its next load or state change.
  scene exit         puts the snapshot back and clears the record; with nothing active it is a
                     no-op, so it can be run twice.
  mcp raw --set      the file must hold exactly one row, of the MCP client module,
                     with the target's id; it is re-indented into the target row.
  config export      the destination must be a regular file inside $DSH_HOME or the
                     working directory, with no symlink on the way; a missing parent
                     is an error unless --mkdir, and --force widens the two roots.
  config import      the source must be a regular file, not a symlink, at most 2 MB.
                     --replace throws the whole state away, so it also needs --yes
                     (a terminal gets asked instead; a pipe counts as no).

Paths
  --profile <name>   profile under <dshHome>/profiles (default web; desktop is refused)
  DSH_HOME           <dshHome>, default ~/.dsh
  patch              <dshHome>/profiles/<name>/cordis.patch.yml
  state              <dshHome>/tool-hub/state.json
  skills             <dshHome>/skills, ~/.agents/skills, and <workspace>/.dsh/skills with --workspace

Exit codes: 0 success, 1 usage, 2 not found, 3 validation failure.`

async function readVersion() {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  }
  catch {
    return 'unknown'
  }
}

// ── entry ────────────────────────────────────────────────────────────────────

/**
 * Session overlays: tools one session switched off, on top of the installation list. The CLI
 * writes the same state file the panel does, so a session switch made here shows up there and
 * the other way round.
 */
async function cmdSession(ctx, action, sessionId, options) {
  const state = await readState(ctx)
  if (action === undefined || action === 'list') {
    const rows = Object.entries(state.sessions)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([id, deny]) => ({ sessionId: id, deny }))
    emit(
      options,
      { ok: true, sessions: rows },
      rows.length === 0
        ? ['  (no session overlays)']
        : rows.map(row => `  ${pad(row.sessionId, 24)}  ${row.deny.join(', ')}`),
    )
    return EXIT.ok
  }
  if (action !== 'set' && action !== 'clear') throw usage('session takes list, set <sessionId> --names a,b, or clear <sessionId>')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw usage(`session ${action} needs a sessionId`)
  const id = sessionId.trim()
  if (action === 'clear') {
    delete state.sessions[id]
  } else {
    const names = String(options.names ?? '').split(',').map(name => name.trim()).filter(name => name !== '')
    const deny = [...new Set(names.filter(name => name.startsWith('mcp__')))]
    if (deny.length === 0) delete state.sessions[id]
    else state.sessions[id] = deny
  }
  const backup = await writeState(ctx, state)
  const deny = state.sessions[id] ?? []
  emit(
    options,
    { ok: true, sessionId: id, deny, backup },
    [deny.length === 0 ? `  cleared: ${id}` : `  set: ${id} -> ${deny.join(', ')}`],
  )
  return EXIT.ok
}

/** Comma-separated flag value to a list; `--flag ""` is a real empty list, not "missing". */
function splitList(value) {
  return String(value ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

/** One line for `scene list`: what this scene would touch, without needing a snapshot. */
function sceneSummary(scene) {
  const parts = []
  if (scene.tools !== undefined) parts.push(`tools: ${scene.tools.deny.length} masked`)
  if (scene.mcp !== undefined) {
    if (scene.mcp.off.length > 0) parts.push(`off: ${scene.mcp.off.join(', ')}`)
    if (scene.mcp.on.length > 0) parts.push(`on: ${scene.mcp.on.join(', ')}`)
    if (scene.mcp.off.length === 0 && scene.mcp.on.length === 0) parts.push('mcp: empty list')
  }
  return parts.length === 0 ? 'no domains (leaves both untouched)' : parts.join(' · ')
}

/**
 * The two writes a scene run needs, bound to one state object. `lib/scene-engine.js` owns the
 * order and the rollback; this only knows where the bytes go: state.json for the deny list and
 * the mode record, the profile patch for one MCP row.
 */
function sceneCliIo(ctx, state, { tolerateMissing = false } = {}) {
  const backups = []
  return {
    backups,
    async writeMode(mode) {
      state.mode = { name: mode.name, at: mode.at, snapshot: mode.snapshot }
      backups.push(await writeState(ctx, state))
    },
    async clearMode() {
      state.mode = null
      backups.push(await writeState(ctx, state))
    },
    async setTools(deny) {
      state.toolDeny = [...deny]
      backups.push(await writeState(ctx, state))
    },
    async setServer(entry) {
      const text = await readPatch(ctx)
      if (text === null) {
        if (tolerateMissing) return { skipped: true }
        throw missing(`profile "${ctx.name}" has no patch file`, 'patch-missing')
      }
      const servers = mcpServers(text)
      const server = findServer(servers, entry.id) ?? findServer(servers, entry.serverName)
      if (server === undefined) {
        // A row deleted while the scene was active is nothing to put back; reporting it as a
        // failed restore would be noise about something that no longer exists.
        if (tolerateMissing) return { skipped: true }
        throw missing(`no MCP server answers to "${entry.serverName}"`, 'server-not-found')
      }
      const next = setRowDisabled(text, server.id, entry.enabled !== true)
      if (next !== text) backups.push(await writePatch(ctx, next))
    },
  }
}

/**
 * Scenes: a saved environment of tool masking plus MCP servers — the same record the panel
 * writes, read back through lib/scene-engine.js so both paths agree on the empty-section rule
 * and on the rollback order.
 *
 * The CLI runs without a host, so `apply` persists the environment and flips the patch rows;
 * the live mask is the host's to recompute the next time it loads state (see --help).
 */
async function cmdScene(ctx, action, name, options) {
  const state = await readState(ctx)
  if (action === undefined || action === 'list') {
    const active = state.mode?.name ?? null
    const rows = Object.keys(state.scenes).sort().map(sceneName => ({
      name: sceneName,
      active: sceneName === active,
      summary: sceneSummary(state.scenes[sceneName]),
      scene: state.scenes[sceneName],
    }))
    emit(
      options,
      { ok: true, active, scenes: rows },
      rows.length === 0
        ? ['  (no scenes)']
        : rows.map(row => `  ${row.active ? '*' : ' '} ${pad(row.name, 16)}  ${row.summary}`),
    )
    return EXIT.ok
  }
  if (action === 'save') {
    const wanted = String(name ?? '').trim()
    if (wanted === '') throw usage('scene save needs a name')
    if (wanted.length > 60) throw invalid('a scene name is at most 60 characters', 'scene-name')
    const tools = options.toolsDeny === null ? undefined : { deny: splitList(options.toolsDeny) }
    const mcp = options.mcpOff === null ? undefined : { off: splitList(options.mcpOff) }
    const scene = normalizeScene({
      name: wanted,
      ...(tools === undefined ? {} : { tools }),
      ...(mcp === undefined ? {} : { mcp }),
    })
    if (scene === null) throw invalid('the scene does not normalize to a usable record', 'scene-invalid')
    const keptTools = new Set(scene.tools?.deny ?? [])
    const keptServers = new Set(scene.mcp?.off ?? [])
    const dropped = {
      tools: tools === undefined ? [] : [...new Set(tools.deny)].filter(entry => !keptTools.has(entry)),
      mcp: mcp === undefined ? [] : [...new Set(mcp.off)].filter(entry => !keptServers.has(entry)),
    }
    const replaced = state.scenes[scene.name] !== undefined
    state.scenes[scene.name] = scene
    const backup = await writeState(ctx, state)
    const lines = [`saved scene ${scene.name}: ${sceneSummary(scene)}`]
    if (dropped.tools.length > 0) lines.push(`  dropped (not an mcp__* name): ${dropped.tools.join(', ')}`)
    if (dropped.mcp.length > 0) lines.push(`  dropped (not a server name): ${dropped.mcp.join(', ')}`)
    if (backup !== null) lines.push(`  backup ${backup}`)
    emit(options, { ok: true, name: scene.name, scene, replaced, dropped, backup }, lines)
    return EXIT.ok
  }
  if (action === 'apply') {
    const wanted = String(name ?? '').trim()
    if (wanted === '') throw usage('scene apply needs a name')
    const scene = state.scenes[wanted]
    if (scene === undefined) throw missing(`no scene named "${wanted}"`, 'unknown-scene')
    const patch = await readPatch(ctx)
    const snapshot = captureSnapshot({
      toolDeny: state.toolDeny,
      sessions: state.sessions,
      mcpRows: mcpServers(patch ?? '').map(row => ({ id: row.id, serverName: row.serverName, disabled: row.disabled })),
    })
    const io = sceneCliIo(ctx, state)
    const run = await runScene({ scene, snapshot, io })
    if (!run.ok) throw invalid(`${run.error}; ${run.rollback?.message ?? 'rollback unavailable'}`, 'scene-failed')
    const planText = describePlan(run.plan)
    const missingServers = [...new Set(run.plan.missing ?? [])]
    const lines = [`applied scene ${scene.name}: ${planText}`]
    if (missingServers.length > 0) lines.push(`  missing servers: ${missingServers.join(', ')}`)
    for (const item of io.backups) if (item !== null) lines.push(`  backup ${item}`)
    emit(options, { ok: true, scene: scene.name, plan: planText, applied: run.applied, missing: missingServers, backups: io.backups }, lines)
    return EXIT.ok
  }
  if (action === 'exit') {
    if (name !== undefined) throw usage('scene exit takes no name')
    if (state.mode === null || state.mode === undefined) {
      emit(options, { ok: true, restored: false, note: 'no scene is active' }, ['  no scene is active; nothing to restore'])
      return EXIT.ok
    }
    const restoring = state.mode.name
    const io = sceneCliIo(ctx, state, { tolerateMissing: true })
    const run = await runScene({ snapshot: state.mode.snapshot, io, restoreOnly: true })
    if (!run.ok) throw invalid(`${run.error}; ${run.rollback?.message ?? 'restore unavailable'}`, 'scene-exit-failed')
    const lines = [`restored the environment saved before scene ${restoring}`, ...run.applied.map(item => `  ${item}`)]
    for (const item of io.backups) if (item !== null) lines.push(`  backup ${item}`)
    emit(options, { ok: true, restored: true, scene: restoring, targets: run.applied, backups: io.backups }, lines)
    return EXIT.ok
  }
  throw usage('scene takes list, save <name>, apply <name>, or exit')
}

async function main(argv) {
  const options = parseArgv(argv)
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return EXIT.ok
  }
  if (options.version) {
    process.stdout.write(`${await readVersion()}\n`)
    return EXIT.ok
  }
  const [command, ...rest] = options.positionals
  if (command === undefined) {
    process.stdout.write(`${HELP}\n`)
    return EXIT.usage
  }
  const ctx = makeContext(options)
  switch (command) {
    case 'list':
      return await cmdList(ctx, options)
    case 'plugin':
      return await cmdPlugin(ctx, rest[0], rest[1], options)
    case 'group':
      return await cmdGroup(ctx, rest[0], rest[1], options)
    case 'preset':
      return await cmdPreset(ctx, rest[0], rest[1], options)
    case 'skill':
      return await cmdSkill(ctx, rest[0], rest[1], options)
    case 'mcp':
      return await cmdMcp(ctx, rest[0], rest[1], options)
    case 'config':
      return await cmdConfig(ctx, rest[0], rest[1], options)
    case 'session':
      return await cmdSession(ctx, rest[0], rest[1], options)
    case 'scene':
      return await cmdScene(ctx, rest[0], rest[1], options)
    default:
      throw usage(`unknown command "${command}"; run dsh-tool-hub --help`)
  }
}

/** Best effort: a usage failure must still answer in the shape the caller asked for. */
function wantsJsonOutput(argv) {
  try {
    return parseArgv(argv).json === true
  }
  catch {
    return argv.includes('--json')
  }
}

const argv = process.argv.slice(2)
const jsonErrors = wantsJsonOutput(argv)
try {
  process.exitCode = await main(argv)
}
catch (error) {
  const failure = error instanceof CliFailure ? error : new CliFailure(error?.message ?? String(error), EXIT.usage, 'internal')
  if (jsonErrors) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }, null, 2)}\n`)
  process.stderr.write(`dsh-tool-hub: ${failure.message}\n`)
  process.exitCode = failure.exitCode
}
