/**
 * dsh-tool-hub — host half.
 *
 * One panel for the two things an installation actually switches on and off:
 * plugins (through the host's own `pluginManager`, so toggling here is exactly
 * toggling there) and skills (through the `SKILL.md` ↔ `SKILL.md.disabled`
 * rename the skill scanner already treats as "off").
 *
 * The host serves this half as two same-origin JSON routes on the bare
 * webServer, which is the shape a panel needs: a browser tab posts JSON, the
 * hand is the host's own service. No client package is involved, so nothing
 * here can break when the shell's component library moves.
 *
 * Group and preset state is this plugin's own file:
 *   <dshHome>/tool-hub/state.json
 * written atomically (tmp + rename), never mixed with another plugin's state.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, cp, mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MCP_MODULE, appendMcpRow, finishDocument, mergeMcpRows, parseMcpRows, patchPathFor, readPatchText, removeMcpRow, replaceMcpConfig, splitDocument, writePatchText } from './mcp.js'
import { authorizeUrl, createPkce, discover, exchangeCode, register } from './oauth.js'
import { ProbeError, probeServer } from './probe.js'
import { inspectSource, installSkills, moveSkill } from './skill-pack.js'
import { MCP_TOOL_PREFIX, attachToolMask, knownToolNames, readPanelFilter, splitToolName } from './tool-filter.js'
import { effectiveDeny, lazyPrompt, lazyReport, serverOf } from './lazy.js'
import { diagnoseMount, heartbeatPath, writeMountHeartbeat } from './mount-heartbeat.js'
import { describeOp } from './op-registry.js'

export const name = 'dsh-tool-hub'

/** Everything this plugin needs before it can answer a request. */
const REQUIRED = ['webServer']

/**
 * Everything `apply()` waits for, in one place: the heartbeat records these names and `doctor`
 * compares them, so a renamed inject shows up as a check instead of as a plugin that silently
 * never mounted.
 */
const HEARTBEAT_INJECTS = ['tools', 'systemPrompt', ...REQUIRED]

const DISABLED_SUFFIX = '.disabled'
const SKILL_FILE = 'SKILL.md'
const MAX_BULK = 400
const MAX_BODY = 256 * 1024
/** `skill.read` stops here, and says so; the panel shows what it got. */
const SKILL_TEXT_LIMIT = 200_000
/** `skill.trash` lists this many, newest first. */
const TRASH_LIST_LIMIT = 20
/** `mcp.rawSave` waits this long before asking the host whether it loaded the row. */
const RAW_VERIFY_DELAY_MS = 900
/** `<state dir>/history.jsonl` is append-only until it grows past this, then it keeps the tail. */
const HISTORY_MAX_BYTES = 2 * 1024 * 1024
const HISTORY_KEEP = 500
/** `snapshot.history` returns this many, newest first. */
const HISTORY_LIST = 50
/**
 * OAuth for MCP servers is an out-of-band flow: the host opens no route, the user copies the
 * code back. The redirect therefore only has to be a value the authorization server accepts.
 */
const OAUTH_REDIRECT_URI = 'http://localhost/oauth/callback'
const OAUTH_PENDING_LIMIT = 8
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000
/** state → { at, id, verifier, meta, clientId, clientSecret, redirectUri }; in-process only. */
const OAUTH_PENDING = new Map()

// ── paths ────────────────────────────────────────────────────────────────────

/** The DSH home this process runs against. */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv === '' ? join(homedir(), '.dsh') : fromEnv
}

function stateFile() {
  // A test profile can point the panel at its own state file so that trying
  // groups and presets in a sandbox never rewrites the state of the profile
  // the user actually works in.
  const override = typeof process.env.TOOL_HUB_STATE_FILE === 'string' ? process.env.TOOL_HUB_STATE_FILE.trim() : ''
  if (override !== '') return resolve(override)
  return join(dshHome(), 'tool-hub', 'state.json')
}

/** Deleted skills wait here, one directory per delete, under the state file's own folder. */
function trashDir() {
  return join(dirname(stateFile()), 'trash')
}

/**
 * Skill roots, in discovery order, with the stable ids written into row ids.
 *
 * Three kinds of root: the two global ones (`<dshHome>/skills` and `~/.agents/skills`) and one
 * per workspace (`<workspace>/.dsh/skills`). A workspace is whatever the host can tell us about;
 * every source is tried in order and any failure is treated as "that source knows nothing",
 * because a panel that cannot list skills is worse than a panel that lists the global ones.
 *
 * `id` is the prefix of every skill id (`user|rel`, `ws-1a2b3c4d|rel`), so it has to be stable
 * across runs and processes — hence a hash of the workspace path rather than an index.
 */
function skillRootList(ctx) {
  const roots = []
  // Same idea as the state file: a sandbox can mount throwaway global skill roots so that
  // flipping a skill's SKILL.md ↔ SKILL.md.disabled there does not reach into the real
  // ~/.dsh/skills the user works with. Workspace roots still come from the host, because
  // those are the feature.
  const override = typeof process.env.TOOL_HUB_SKILL_ROOTS === 'string' ? process.env.TOOL_HUB_SKILL_ROOTS.trim() : ''
  if (override !== '') {
    override
      .split(sep === '\\' ? ';' : ':')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .forEach((dir, index) => {
        roots.push({
          id: index === 0 ? 'user' : `root${index + 1}`,
          label: index === 0 ? '全局 · 用户' : '全局 · 共享',
          dir: resolve(dir),
          scope: 'global',
          workspace: null,
        })
      })
  }
  else {
    roots.push({ id: 'user', label: '全局 · 用户', dir: join(dshHome(), 'skills'), scope: 'global', workspace: null })
    roots.push({ id: 'agents', label: '全局 · 共享', dir: join(homedir(), '.agents', 'skills'), scope: 'global', workspace: null })
  }
  for (const workspace of workspacePaths(ctx)) {
    roots.push({
      id: `ws-${hashText(workspace)}`,
      label: basename(workspace) === '' ? workspace : basename(workspace),
      dir: join(workspace, '.dsh', 'skills'),
      scope: 'workspace',
      workspace,
    })
  }
  return roots
}

/** FNV-1a over the path: stable, cheap, and short enough to read in an id. */
function hashText(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Workspace paths the host knows about, first source that answers wins.
 *
 * Order is fixed by the contract — env first (a sandbox points the panel at a throwaway tree),
 * then the services a host may or may not expose. Each item may be a bare path or an object
 * carrying one under `path` / `dir` / `root`; anything else is skipped, never thrown.
 */
function workspacePaths(ctx) {
  const found = []
  const add = (value) => {
    try {
      if (typeof value === 'string') {
        const clean = value.trim()
        if (clean !== '' && !found.includes(resolve(clean))) found.push(resolve(clean))
        return
      }
      if (isRecord(value)) add(value.path ?? value.dir ?? value.root)
    }
    catch {
      // A path-shaped value we cannot resolve is not a workspace.
    }
  }
  // A bare "-" means "no workspace roots" (the sandbox profile uses it to stay isolated);
  // an empty value is treated as unset so the service lookup still runs.
  const fromEnv = typeof process.env.TOOL_HUB_WORKSPACES === 'string' ? process.env.TOOL_HUB_WORKSPACES.trim() : ''
  if (fromEnv === '-') return found
  if (fromEnv !== '') {
    for (const entry of fromEnv.split(';')) add(entry)
    return found
  }
  const sources = [
    () => ctx?.get?.('workspaces')?.list?.(),
    () => ctx?.get?.('workspaceRegistry')?.list?.(),
    () => ctx?.get?.('sessions')?.listWorkspaces?.(),
  ]
  for (const read of sources) {
    let list = null
    try {
      list = read()
    }
    catch {
      list = null
    }
    if (!Array.isArray(list)) continue
    const before = found.length
    for (const entry of list) add(entry)
    if (found.length > before) return found
  }
  return found
}

// ── small helpers ────────────────────────────────────────────────────────────

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

async function readText(path, limit = Infinity) {
  const raw = await readFile(path)
  return limit === Infinity ? raw.toString('utf8') : raw.subarray(0, limit).toString('utf8')
}

/** Atomic JSON write: a crash leaves either the old file or the new one. */
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Keep the newest 20 copies; the directory is only ever written by this file. */
async function pruneBackups(dir) {
  try {
    const names = (await readdir(dir)).filter(name => /^state-.*\.json$/.test(name)).sort()
    const extra = names.slice(0, Math.max(0, names.length - 20))
    for (const name of extra) await rm(join(dir, name), { force: true })
  }
  catch {
    // A missing or unreadable directory is not worth failing a write over.
  }
}

/**
 * Copy the current state aside before an operation that can overwrite it wholesale
 * (`config.import` with replace, `state.reset`). Returns the backup file name.
 */
async function backupState(label) {
  const file = stateFile()
  if ((await exists(file)) !== true) return null
  const dir = join(dirname(file), 'backups')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `state-${stamp}-${label}.json`
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), await readText(file), 'utf8')
  await pruneBackups(dir)
  return name
}

/** Strip the YAML frontmatter block, if the file opens with one. */
function frontmatter(text) {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = text.slice(3, end)
  const fields = {}
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  return fields
}

function firstLine(text, max = 180) {
  const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// ── state ────────────────────────────────────────────────────────────────────

const DEFAULT_COLLECTION = { id: 'default', name: '默认分组群', order: 0 }

function emptyState() {
  return {
    version: 1,
    groups: [],
    collections: [{ ...DEFAULT_COLLECTION }],
    presets: [],
    toolDeny: [],
    // Servers whose tools stay out of the model until someone loads them by name, plus the
    // names already loaded. Both lists are the user's, never inferred at runtime.
    lazyServers: [],
    lazyLoaded: [],
    auto: { appliedAt: null },
    // Session id -> tools that session switched off. Separate from `toolDeny` on purpose: the
    // installation list applies everywhere, this one only to the session (and its subagents,
    // through the lineage the mask walks). Empty lists are pruned, so `{}` is the normal state.
    sessions: {},
  }
}

// Roles are the rail's sections. `task`/`skill` are the old two-axis taxonomy and `rest` used to
// mean "unsorted"; a state file written before 1.10 still carries them, so they fold into the
// closest bucket that still exists rather than leaving groups invisible in the rail.
function cleanRole(role) {
  if (role === 'official' || role === 'base' || role === 'rest' || role === 'mcp') return role
  if (role === 'task' || role === 'skill') return 'rest'
  return null
}

function normalizeMember(raw) {
  if (!isRecord(raw)) return null
  const kind = raw.kind === 'skill' ? 'skill' : raw.kind === 'plugin' ? 'plugin' : null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (kind === null || id === '') return null
  return { kind, id }
}

function normalizeState(raw) {
  const state = emptyState()
  if (!isRecord(raw)) return state
  // Collections are the rail's drawers: one default drawer exists from the start so a group always
  // has somewhere to live, and the rest are whatever the user named.
  if (Array.isArray(raw.collections)) {
    const seen = new Set(['default'])
    for (const entry of raw.collections) {
      if (!isRecord(entry)) continue
      const id = typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : ''
      const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 40) : ''
      if (id === '' || name === '' || seen.has(id) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) continue
      seen.add(id)
      state.collections.push({ id, name, order: typeof entry.order === 'number' ? entry.order : state.collections.length })
    }
  }
  state.collections.sort((left, right) => left.order - right.order)
  const collectionIds = new Set(state.collections.map(entry => entry.id))
  if (Array.isArray(raw.groups)) {
    // Identity is the id, not the name: role and topic can produce two groups that read the
    // same ("工具与权限" once for always-on rows, once for per-task rows) and both must survive.
    const seen = new Set()
    for (const group of raw.groups) {
      if (!isRecord(group)) continue
      const name = typeof group.name === 'string' ? group.name.trim().slice(0, 60) : ''
      if (name === '') continue
      const id = typeof group.id === 'string' && group.id !== '' ? group.id : `g${state.groups.length + 1}`
      if (seen.has(id)) continue
      seen.add(id)
      const members = []
      const memberKeys = new Set()
      for (const member of Array.isArray(group.members) ? group.members : []) {
        const normalized = normalizeMember(member)
        if (normalized === null) continue
        const key = `${normalized.kind}:${normalized.id}`
        if (memberKeys.has(key)) continue
        memberKeys.add(key)
        members.push(normalized)
      }
      state.groups.push({
        id,
        name,
        members,
        role: cleanRole(group.role),
        collection: group.collection === null ? null : collectionIds.has(group.collection) ? group.collection : 'default',
        tags: Array.isArray(group.tags) ? [...new Set(group.tags.filter(tag => typeof tag === 'string' && tag.trim() !== '').map(tag => tag.trim().slice(0, 24)))].slice(0, 8) : [],
        auto: group.auto === true,
        createdAt: typeof group.createdAt === 'number' ? group.createdAt : Date.now(),
      })
    }
  }
  // Two automatic buckets that read the same (role + name) are one bucket: an older apply can leave
  // such a pair behind, and two identical rows in the rail is exactly the redundancy this fixes.
  const byKey = new Map()
  const mergedGroups = []
  for (const group of state.groups) {
    if (group.role === null || group.role === undefined) {
      mergedGroups.push(group)
      continue
    }
    // Generated ids (a… from auto grouping, m… from a market import) may merge with each other;
    // a group the user made keeps its own identity even if it reuses the name.
    const generated = group.auto === true || /^[am]\d/.test(group.id)
    const key = `${generated ? 'gen' : `hand:${group.id}`}\u0000${group.role}\u0000${group.name}`
    const kept = byKey.get(key)
    if (kept === undefined) {
      byKey.set(key, group)
      mergedGroups.push(group)
      continue
    }
    const seen = new Set(kept.members.map(member => `${member.kind}:${member.id}`))
    for (const member of group.members) {
      const memberKey = `${member.kind}:${member.id}`
      if (seen.has(memberKey)) continue
      seen.add(memberKey)
      kept.members.push(member)
    }
    kept.tags = [...new Set([...kept.tags, ...group.tags])].slice(0, 8)
  }
  state.groups = mergedGroups
  if (Array.isArray(raw.presets)) {
    const seen = new Set()
    for (const preset of raw.presets) {
      if (!isRecord(preset)) continue
      const name = typeof preset.name === 'string' ? preset.name.trim().slice(0, 60) : ''
      if (name === '' || seen.has(name)) continue
      seen.add(name)
      const enabled = isRecord(preset.enabled) ? preset.enabled : {}
      const plugin = Array.isArray(enabled.plugin) ? enabled.plugin.filter(id => typeof id === 'string') : []
      const skill = Array.isArray(enabled.skill) ? enabled.skill.filter(id => typeof id === 'string') : []
      const tool = Array.isArray(enabled.tool) ? enabled.tool.filter(id => typeof id === 'string') : []
      const recordedDeny = Array.isArray(preset.toolDeny)
        ? preset.toolDeny.filter(id => typeof id === 'string' && id.startsWith(MCP_TOOL_PREFIX))
        : null
      state.presets.push({
        name,
        enabled: { plugin: [...new Set(plugin)], skill: [...new Set(skill)], tool: [...new Set(tool)] },
        // Kept as-is: a preset without a recorded deny list is a preset from before the fix,
        // and the apply path has to tell those two apart.
        ...(recordedDeny === null ? {} : { toolDeny: [...new Set(recordedDeny)] }),
        note: typeof preset.note === 'string' ? preset.note : '',
        createdAt: typeof preset.createdAt === 'number' ? preset.createdAt : Date.now(),
      })
    }
  }
  if (isRecord(raw.auto) && typeof raw.auto.appliedAt === 'number') state.auto.appliedAt = raw.auto.appliedAt
  if (Array.isArray(raw.toolDeny)) {
    const deny = raw.toolDeny.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
    state.toolDeny = [...new Set(deny)]
  }
  if (Array.isArray(raw.lazyServers)) {
    const servers = raw.lazyServers
      .filter(name => typeof name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(name.trim()))
      .map(name => name.trim())
    state.lazyServers = [...new Set(servers)]
  }
  if (Array.isArray(raw.lazyLoaded)) {
    const loaded = raw.lazyLoaded.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
    state.lazyLoaded = [...new Set(loaded)]
  }
  // Session overlays: only MCP names, only non-empty lists, and the session id is opaque to us
  // (the host owns its shape) — kept as a key, never parsed.
  if (isRecord(raw.sessions)) {
    for (const [sessionId, names] of Object.entries(raw.sessions)) {
      if (sessionId === '' || sessionId.length > 200 || !Array.isArray(names)) continue
      const deny = names.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
      if (deny.length > 0) state.sessions[sessionId] = [...new Set(deny)]
    }
  }
  return state
}

async function loadState() {
  try {
    const text = await readText(stateFile())
    return normalizeState(JSON.parse(text))
  }
  catch {
    return emptyState()
  }
}

async function saveState(state) {
  await writeJsonAtomic(stateFile(), state)
  return state
}

// ── history ──────────────────────────────────────────────────────────────────

/** One line per dispatch, under the state file's own folder. */
function historyFile() {
  return join(dirname(stateFile()), 'history.jsonl')
}

/** Same tmp + rename contract as the state file, for the truncation rewrite. */
async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/**
 * What a history line is allowed to remember: the op and the ids that name the subject.
 *
 * Payloads can carry skill text, tokens or whole configs, so nothing is copied from them except
 * short scalar identifiers — a history that leaks a secret is worse than no history.
 */
function historyDetail(payload) {
  if (!isRecord(payload)) return ''
  const parts = []
  for (const key of ['id', 'name', 'kind', 'targetId', 'mode', 'state']) {
    const value = payload[key]
    if (typeof value === 'string' && value !== '' && value.length <= 120) parts.push(`${key}=${value}`)
  }
  return parts.join(' ').slice(0, 180)
}

async function appendHistory(entry) {
  try {
    const file = historyFile()
    await mkdir(dirname(file), { recursive: true })
    const info = await stat(file).catch(() => null)
    if (info !== null && info.size > HISTORY_MAX_BYTES) {
      const text = await readText(file)
      const kept = text.split('\n').filter(line => line.trim() !== '').slice(-HISTORY_KEEP)
      await writeTextAtomic(file, kept.length === 0 ? '' : `${kept.join('\n')}\n`)
    }
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
  }
  catch {
    // History is advisory: a full disk must not fail the op it was recording.
  }
}

async function readHistory(limit = HISTORY_LIST) {
  try {
    const text = await readText(historyFile())
    const lines = text.split('\n').filter(line => line.trim() !== '')
    const items = []
    for (let index = lines.length - 1; index >= 0 && items.length < limit; index -= 1) {
      try {
        const row = JSON.parse(lines[index])
        if (!isRecord(row)) continue
        items.push({
          at: typeof row.at === 'string' ? row.at : '',
          op: typeof row.op === 'string' ? row.op : '',
          detail: typeof row.detail === 'string' ? row.detail : '',
          ok: row.ok === true,
          // Passed through so a client can show "who changed what" without keeping its own
          // copy of which ops are audited. Absent on lines written before the registry existed.
          audit: row.audit === true,
        })
      }
      catch {
        // A torn last line (a crash mid-append) is dropped, not fatal.
      }
    }
    return items
  }
  catch {
    return []
  }
}

// ── skills ───────────────────────────────────────────────────────────────────

/** A directory bundle is a skill iff it holds SKILL.md or SKILL.md.disabled. */
async function readSkillDir(abs, root, rel) {
  const on = join(abs, SKILL_FILE)
  const off = join(abs, `${SKILL_FILE}${DISABLED_SUFFIX}`)
  const hasOn = await exists(on)
  const hasOff = !hasOn && (await exists(off))
  if (!hasOn && !hasOff) return null
  const file = hasOn ? on : off
  let fields = {}
  try {
    fields = frontmatter(await readText(file, 8192))
  }
  catch {
    fields = {}
  }
  const name = typeof fields.name === 'string' && fields.name !== '' ? fields.name : rel.split(sep).pop()
  return {
    kind: 'skill',
    id: `${root.id}|${rel.split(sep).join('/')}`,
    name,
    title: name,
    description: typeof fields.description === 'string' ? fields.description : '',
    // A skill's own frontmatter is its only description source; say so instead of leaving the
    // field looking like a plugin row's fallback chain.
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
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    const childRel = rel === '' ? entry.name : join(rel, entry.name)
    if (entry.isDirectory()) {
      const abs = join(root.dir, childRel)
      const skill = await readSkillDir(abs, root, childRel)
      if (skill !== null) {
        out.push(skill)
        continue
      }
      if (depth < 3) out.push(...(await scanSkillRoot(root, depth + 1, childRel)))
    }
  }
  return out
}

async function listSkills(roots) {
  const rows = []
  for (const root of roots) {
    if (!(await exists(root.dir))) continue
    rows.push(...(await scanSkillRoot(root)))
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve a skill id back to its two on-disk names, refusing to escape a root. */
function resolveSkillPath(roots, id) {
  const separator = id.indexOf('|')
  if (separator <= 0) return null
  const rootId = id.slice(0, separator)
  const rel = id.slice(separator + 1)
  const root = roots.find(candidate => candidate.id === rootId)
  if (root === undefined) return null
  const rootDir = resolve(root.dir)
  const abs = resolve(rootDir, rel)
  // Ask the path module whether the target is still under the root instead of comparing strings:
  // a root that is already `C:\` (or `/`) has a prefix of `C:\\`, which no real child ever starts
  // with, so the old guard called every skill under a filesystem root an escape. `relative`
  // answers with `..` when the target is outside and with an absolute path across Windows drives.
  const inner = relative(rootDir, abs)
  if (inner === '' || inner === '..' || inner.startsWith(`..${sep}`) || isAbsolute(inner)) return null
  return { abs, dir: dirname(abs), base: abs.split(sep).pop(), root, rel: rel.split(sep).join('/') }
}

async function setSkillEnabled(ctx, id, enabled) {
  const roots = skillRootList(ctx)
  const resolved = resolveSkillPath(roots, id)
  if (resolved === null) throw new Failure('unknown-skill', `no skill folder answers to ${id}`)
  const target = join(resolved.dir, resolved.base)
  const on = join(target, SKILL_FILE)
  const off = `${on}${DISABLED_SUFFIX}`
  const hasOn = await exists(on)
  const hasOff = await exists(off)
  if (enabled) {
    if (hasOn) return { id, ok: true, message: 'already on' }
    if (!hasOff) throw new Failure('missing-skill-file', `${SKILL_FILE} not found in ${target}`)
    await rename(off, on)
    return { id, ok: true, message: 'renamed on' }
  }
  if (hasOff) return { id, ok: true, message: 'already off' }
  if (!hasOn) throw new Failure('missing-skill-file', `${SKILL_FILE} not found in ${target}`)
  await rename(on, off)
  return { id, ok: true, message: 'renamed off' }
}

/** The file a skill row reads from: `SKILL.md`, its disabled twin, or a single `.md` skill. */
async function skillEntry(resolved) {
  const info = await stat(resolved.abs).catch(() => null)
  if (info === null) return null
  if (info.isFile()) return { kind: 'file', file: resolved.abs }
  for (const name of [SKILL_FILE, `${SKILL_FILE}${DISABLED_SUFFIX}`]) {
    const file = join(resolved.abs, name)
    if (await exists(file)) return { kind: 'dir', file }
  }
  return null
}

/** Move a file or a whole tree; `rename` cannot cross volumes, so a copy is the fallback. */
async function movePath(from, to) {
  try {
    await rename(from, to)
  }
  catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, force: true })
    await rm(from, { recursive: true, force: true })
  }
}

/** Letters, digits and `-_.` survive; everything else — including CJK — becomes `-`. */
function safeName(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9\-_.]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return cleaned === '' ? 'skill' : cleaned
}

async function readTrashMeta(item) {
  try {
    const raw = JSON.parse(await readFile(join(item, 'meta.json'), 'utf8'))
    return isRecord(raw) ? raw : null
  }
  catch {
    return null
  }
}

/**
 * Preview / delete / list / restore one skill.
 *
 * Delete is a move into `<state dir>/trash/<ts>-<safe>/` and nothing else: the tree stays whole,
 * a `meta.json` records where it came from, and restore is the same move in reverse. Nothing is
 * ever removed from disk here, which is what makes the panel's ten-second undo honest.
 */
async function handleSkill(ctx, op, payload) {
  const roots = skillRootList(ctx)
  if (op === 'trash') {
    let names = []
    try {
      names = await readdir(trashDir())
    }
    catch {
      return { items: [] }
    }
    // Stamps are millisecond numbers, so a plain descending sort is newest first.
    names.sort().reverse()
    const items = []
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
    return { items }
  }

  if (op === 'restore') {
    const asked = typeof payload?.trashPath === 'string' ? payload.trashPath.trim() : ''
    if (asked === '') throw new Failure('bad-trash', 'trashPath is required')
    const item = resolve(asked)
    // Only a direct child of our own trash folder: a restore must never be a rename of
    // something the caller picked elsewhere on disk.
    if (dirname(item) !== resolve(trashDir())) throw new Failure('bad-trash', 'not a trash item of this panel')
    const meta = await readTrashMeta(item)
    if (meta === null) throw new Failure('bad-trash', 'that trash item has no meta.json')
    const root = roots.find(candidate => candidate.id === meta.rootId)
    if (root === undefined) throw new Failure('root-missing', `the root ${String(meta.rootId)} no longer exists`)
    const rel = typeof meta.rel === 'string' ? meta.rel : ''
    const parts = rel.split('/').filter(part => part !== '' && part !== '.' && part !== '..')
    if (parts.length === 0) throw new Failure('bad-trash', 'that trash item has no recorded path')
    const dest = join(root.dir, ...parts)
    if (!resolve(dest).startsWith(resolve(root.dir) + sep)) throw new Failure('bad-trash', 'recorded path escapes its root')
    if (await exists(dest)) throw new Failure('target-exists', `${dest} already exists`)
    await mkdir(dirname(dest), { recursive: true })
    if (meta.kind === 'file') {
      await movePath(join(item, parts[parts.length - 1]), dest)
      await rm(item, { recursive: true, force: true })
    }
    else {
      // The bookkeeping file must not travel back into the skill tree.
      await rm(join(item, 'meta.json'), { force: true })
      await movePath(item, dest)
    }
    return { restored: `${root.id}|${parts.join('/')}` }
  }

  const id = String(payload?.id ?? '')
  const resolved = resolveSkillPath(roots, id)
  if (resolved === null) throw new Failure('unknown-skill', `no skill folder answers to ${id}`)
  const entry = await skillEntry(resolved)
  if (entry === null) throw new Failure('missing-skill-file', `no skill file under ${resolved.abs}`)

  if (op === 'read') {
    const raw = await readFile(entry.file)
    const text = raw.toString('utf8')
    const truncated = text.length > SKILL_TEXT_LIMIT
    return { id, text: truncated ? text.slice(0, SKILL_TEXT_LIMIT) : text, bytes: raw.length, truncated }
  }

  if (op !== 'delete') throw new Failure('bad-op', `unknown skill op ${String(op)}`)

  let name = resolved.rel.split('/').pop()
  try {
    const fields = frontmatter(await readText(entry.file, 8192))
    if (typeof fields.name === 'string' && fields.name !== '') name = fields.name
  }
  catch {
    // A skill file we cannot read still has a folder name worth showing.
  }
  await mkdir(trashDir(), { recursive: true })
  const stamp = String(Date.now())
  let item = join(trashDir(), `${stamp}-${safeName(name)}`)
  let suffix = 1
  while (await exists(item)) {
    suffix += 1
    item = join(trashDir(), `${stamp}-${safeName(name)}-${suffix}`)
  }
  if (entry.kind === 'dir') {
    await movePath(resolved.abs, item)
  }
  else {
    await mkdir(item, { recursive: true })
    await movePath(resolved.abs, join(item, basename(resolved.abs)))
  }
  await writeJsonAtomic(join(item, 'meta.json'), {
    rootId: resolved.root.id,
    rel: resolved.rel,
    name,
    at: new Date().toISOString(),
    kind: entry.kind,
  })
  return { id, trashPath: item, name }
}

// ── skill packs: import from a path, move between roots ─────────────────────

/** `unknown-root` and `exists` are the two the client switches on; everything else keeps its code. */
async function handleSkillPack(ctx, op, payload) {
  const roots = skillRootList(ctx)
  const targetId = String(payload?.targetId ?? '')
  const root = roots.find(candidate => candidate.id === targetId)
  if (root === undefined) throw new Failure('unknown-root', `no skill root with id "${targetId}"`)

  if (op === 'import') {
    const source = typeof payload?.path === 'string' ? payload.path.trim() : ''
    if (source === '') throw new Failure('bad-path', 'a local path is required')
    let bundle
    try {
      bundle = await inspectSource(source)
    }
    catch (error) {
      throw new Failure(typeof error?.code === 'string' ? error.code : 'inspect-failed', String(error?.message ?? error))
    }
    if (bundle.skills.length === 0) throw new Failure('empty-source', `no skill found under ${source}`)
    let result
    try {
      result = await installSkills(bundle, root.dir, { overwrite: payload?.overwrite === true })
    }
    catch (error) {
      throw new Failure(typeof error?.code === 'string' ? error.code : 'install-failed', String(error?.message ?? error))
    }
    return { root: root.id, added: result.added, skipped: result.skipped }
  }
  if (op !== 'move') throw new Failure('bad-op', `unknown skill op ${String(op)}`)

  const id = String(payload?.id ?? '')
  const resolved = resolveSkillPath(roots, id)
  if (resolved === null) throw new Failure('unknown-skill', `no skill folder answers to ${id}`)
  // Two roots that are the same directory would "move" a nested skill up to the top level.
  if (resolved.root.id === root.id) throw new Failure('exists', 'the skill is already in that root')
  const entry = await skillEntry(resolved)
  // An id that parses but points at nothing is an unknown skill; a real folder with no skill file
  // in it is a different problem, and the message has to say which one happened.
  if (entry === null) {
    if (!await exists(resolved.abs)) throw new Failure('unknown-skill', `no skill folder answers to ${id}`)
    throw new Failure('missing-skill-file', `no skill file under ${resolved.abs}`)
  }

  if (entry.kind === 'dir') {
    try {
      const moved = await moveSkill(resolved.abs, root.dir)
      return { from: moved.from, to: moved.to, root: root.id }
    }
    catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'move-failed'
      throw new Failure(code === 'exists' ? 'exists' : code, String(error?.message ?? error))
    }
  }
  // A single-file skill keeps its file name; `moveSkill` only knows directories.
  const from = resolved.abs
  const to = join(root.dir, basename(resolved.abs))
  if (await exists(to)) throw new Failure('exists', `destination already exists: ${to}`)
  await mkdir(root.dir, { recursive: true })
  await movePath(from, to)
  return { from, to, root: root.id }
}

// ── failures ─────────────────────────────────────────────────────────────────

class Failure extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function failureOf(error) {
  if (error instanceof Failure) return { code: error.code, message: error.message }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

// ── auto grouping ────────────────────────────────────────────────────────────

/**
 * Auto grouping has two axes, role first.
 *
 * Role answers "how do I use this thing": `base` is the layer an installation keeps on
 * (context compaction, the shell, the marketplace, the model bridge), `task` is what gets
 * switched on for one job (a renderer, a crawler, a git helper). Topic answers "what is it
 * about". Both come from the module name plus the title/description a row already carries —
 * no network, no model, same answer every run.
 *
 * Scoring rather than first-match: a module name can hit several topics, and picking by rule
 * order is what used to put 60% of an installation into one bucket.
 */
const TOPICS = [
  { topic: '上下文与记忆', test: /context|compact|memory|recall|summar/ },
  { topic: '市场与安装', test: /market|install|registry|bundle|upgrade|version/ },
  { topic: '界面与外观', test: /(^|[-_/])ui|theme|sidebar|layout|(^|[-_/])panel|badge|status-?bar|(^|[-_/])icon|(^|[-_/])shell|design|studio/ },
  { topic: '模型与推理', test: /model|inference|llm|provider|token|reason|agent|prompt/ },
  { topic: '工具与权限', test: /tool|permission|approval|guard|sandbox|policy|secret/ },
  { topic: '会话与运行时', test: /session|runtime|api|gateway|kernel|cordis|loader|hmr|typert|timer|storage|attach/ },
  { topic: '通知与集成', test: /notify|notification|(^|[-_/])mail|calendar|telegram|slack|webhook|(^|[-_/])hook|integration|remote-access|(^|[-_/])mcp/ },
  { topic: '创作与媒体', test: /image|imagegen|video|comfy|blender|drawio|(^|[-_/])draw|univer|office|(^|[-_/])voice|speech|(^|[-_/])tts|(^|[-_/])music|canvas/ },
  { topic: '检索与抓取', test: /search|arxiv|thesis|(^|[-_/])lit|crawl|(^|[-_/])fetch|browser|vision|(^|[-_/])ocr|research|(^|[-_/])wiki|paper/ },
  { topic: '开发与自动化', test: /(^|[-_/])git|github|terminal|(^|[-_/])shell|(^|[-_/])code|lint|(^|[-_/])test|deploy|(^|[-_/])cli|doctor|schedule|job/ },
]

const OTHER_GROUP = '其他'
const SKILL_GROUP = { user: '技能 · 用户', agents: '技能 · 共享' }

// Words that describe a layer rather than a job. A third-party row whose text hits more of
// these than of the task words is something you keep on, not something you switch per task.
const BASE_HINTS = /context|compact|memory|session|sidebar|theme|layout|market|install|usage|cost|panel|runtime|bridge|gateway|registry|storage|shell|ui|tools|permission|sandbox|prompt/
const TASK_HINTS = /generate|search|crawl|convert|extract|review|batch|analy|render|edit|translate|export|import|notify|fetch|scrape|compose|draw|animate/

const OFFICIAL_PREFIX = /^(?:@deepseek-ai\/|cordis[:-])/

function textOf(row) {
  return `${row.moduleName ?? ''} ${row.description ?? ''} ${row.name ?? ''}`.toLowerCase()
}

const ROLE_NAMES = { official: '官方', base: '第三方底座', rest: '用户下载', mcp: 'MCP 服务器' }

/**
 * The row a module belongs to as a *group member*. A package may ship several loader entries —
 * `billion-context` plus `billion-context/dsh-compaction-gate`, or `@scope/name` plus
 * `@scope/name/sub` — and they are one thing to a user: one install, one switch in the group.
 * So grouping and the tree both key on this, while enabling stays per row.
 */
function rootModule(moduleName) {
  if (typeof moduleName !== 'string' || moduleName === '') return ''
  const parts = moduleName.split('/')
  if (parts[0].startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : moduleName
  return parts[0]
}

function classify(row) {
  const text = textOf(row)
  const module = String(row.moduleName ?? '').toLowerCase()
  const official = OFFICIAL_PREFIX.test(module)
  const baseHits = (text.match(BASE_HINTS) ?? []).length
  const taskHits = (text.match(TASK_HINTS) ?? []).length
  // Four buckets, decided in this order: what the client itself starts as an MCP server (those rows
  // are `@deepseek-ai/dsh-mcp-client` too, so they have to be claimed before the official prefix
  // swallows them), what ships with the client, what a third party installs to sit under everything
  // (context, memory, market, sidebar…), and everything else the user downloaded for a job.
  const role = row.mcp === true ? 'mcp' : official ? 'official' : baseHits > taskHits ? 'base' : 'rest'
  let topic = OTHER_GROUP
  for (const entry of TOPICS) {
    if (entry.test.test(text)) {
      topic = entry.topic
      break
    }
  }
  return { role, topic, tags: [role, topic] }
}

function skillGroupFor(source) {
  return SKILL_GROUP[source] ?? `技能 · ${source}`
}

/**
 * Build the plan the Auto group button previews. Four buckets — official, MCP servers, the
 * always-on base layer, and what the user downloaded — because that is the decision a user
 * actually makes when flipping switches. Topic is still computed and shown as a tag.
 */
/** Where a package's package.json may live: the profile first, then the client's own install. */
function packageRoots(ctx) {
  const roots = []
  try {
    const profile = ctx.get('profileContext')
    const dir = typeof profile?.dir === 'string' ? profile.dir : ''
    if (dir !== '') roots.push(join(dir, 'node_modules'))
  }
  catch { /* no profile context */ }
  // Official packages are never copied into a profile: they live next to the client.
  // The packaged app keeps them under <app>/resources/app/dsh/node_modules; a source
  // checkout has them in the repo. Both are derived from the running executable so the
  // panel does not need to know which one it is in.
  const candidates = []
  try {
    const exe = dirname(process.execPath)
    candidates.push(join(exe, 'resources', 'app', 'dsh', 'node_modules'))
    candidates.push(join(exe, 'resources', 'app', 'node_modules'))
  }
  catch { /* no execPath */ }
  try {
    const entry = typeof process.argv?.[1] === 'string' ? process.argv[1] : ''
    if (entry !== '') {
      // <root>/lib/bin.js or <root>/node_modules/@deepseek-ai/dsh/lib/bin.js
      candidates.push(join(dirname(entry), '..', 'node_modules'))
      candidates.push(join(dirname(entry), '..', '..', 'node_modules'))
    }
  }
  catch { /* no argv */ }
  for (const candidate of candidates) {
    const clean = resolve(candidate)
    if (!roots.includes(clean)) roots.push(clean)
  }
  return roots
}

/**
 * Descriptions for packages that ship no `description` in their manifest and no `meta.description`
 * on their row. Keys are root module names, lower-cased; both languages are kept because the panel
 * is bilingual and the row string is picked without knowing the reader's locale.
 */
const KNOWN_DESCRIPTIONS = new Map([
  ['dshmarket', { zh: '插件市场：浏览、安装与更新 DSH 插件', en: 'Plugin marketplace: browse, install and update DSH plugins' }],
  ['dsh-better-sidebar', { zh: '更顺手的侧边栏：会话、工作区与快捷入口', en: 'A smoother sidebar for sessions, workspaces and shortcuts' }],
  ['dsh-cost-meter', { zh: '用量与花费统计：按会话看 token 与成本', en: 'Usage and cost meter: tokens and spend per session' }],
  ['@michengai/dsh-codex-ui', { zh: 'Codex 风格的对话界面', en: 'Codex-style chat interface for DSH' }],
  ['dsh-windows-mcp', { zh: 'Windows 桌面自动化 MCP 服务：窗口、控件与截图', en: 'Windows desktop automation MCP server: windows, controls, screenshots' }],
  ['billion-context', { zh: '上下文压缩与提示词缓存管理', en: 'Context compression and prompt cache management' }],
  ['dsh-tool-hub', { zh: '统一工具管理台：插件、技能与 MCP 一处开关', en: 'One panel for plugins, skills and MCP servers' }],
  ['dsh-skill-mcp-panel', { zh: '技能与 MCP 服务器面板', en: 'Skills and MCP server panel' }],
  ['ui-theme', { zh: '主题与外观：深浅色、字号与配色', en: 'Theme and appearance: light/dark, type scale, colors' }],
  ['dsh-notifier', { zh: '桌面通知：任务完成时提醒', en: 'Desktop notifications when a task finishes' }],
])

/** The known-package entry for a module name (a subpath row resolves through its package root). */
function knownDescription(moduleName) {
  if (typeof moduleName !== 'string' || moduleName === '') return null
  const root = rootModule(moduleName)
  if (root === '' || root.startsWith('cordis:')) return null
  return KNOWN_DESCRIPTIONS.get(root.toLowerCase()) ?? null
}

/** What a package declares about itself: its own labels, and whether it carries a UI. */
async function packageMeta(ctx, moduleName, cache) {
  if (cache.has(moduleName)) return cache.get(moduleName)
  const meta = { keywords: [], surface: null, packageDescription: '' }
  if (typeof moduleName === 'string' && moduleName !== '') {
    // A loader row can point at a subpath inside a package (`@scope/pkg/theme`, `pkg/part`).
    // The manifest lives on the package root, so try both.
    const root = rootModule(moduleName)
    const names = root !== '' && root !== moduleName ? [moduleName, root] : [moduleName]
    let found = false
    for (const name of names) {
      for (const dir of packageRoots(ctx)) {
        try {
          const raw = JSON.parse(await readFile(join(dir, name, 'package.json'), 'utf8'))
          // The manifest's own one-liner: the second link of the description fallback chain.
          meta.packageDescription = typeof raw?.description === 'string' ? raw.description.trim().slice(0, 240) : ''
          const keywords = Array.isArray(raw?.keywords) ? raw.keywords : typeof raw?.keywords === 'string' ? raw.keywords.split(',') : []
          meta.keywords = keywords
            .map(word => String(word).trim())
            .filter(word => word !== '' && word.length <= 24)
            .slice(0, 4)
          const dsh = isRecord(raw?.dsh) ? raw.dsh : {}
          // ui: this package ships a browser half. host: it is installable but headless.
          if (dsh.client !== undefined && dsh.client !== null) meta.surface = 'ui'
          else if (dsh.bundle !== undefined && dsh.bundle !== null) meta.surface = 'host'
          found = true
          break
        }
        catch {
          // Not under this root; try the next one.
        }
      }
      if (found) break
    }
  }
  // Official rows have no profile copy at all, and a linked package may have no manifest we
  // can reach. Their names are still a structural fact: DSH's own browser halves are all
  // `@deepseek-ai/dsh-client-*`, everything else official is a host-side entry.
  if (meta.surface === null && typeof moduleName === 'string') {
    const value = moduleName.toLowerCase()
    if (value.startsWith('cordis:')) meta.surface = 'host'
    else if (/^@deepseek-ai\/dsh-client-/.test(value)) meta.surface = 'ui'
    else if (value.startsWith('@deepseek-ai/')) meta.surface = 'host'
  }
  cache.set(moduleName, meta)
  return meta
}

/** The labels a package ships with, which beat anything we can infer from its name. */
async function packageKeywords(ctx, moduleName, cache) {
  return (await packageMeta(ctx, moduleName, cache)).keywords
}

async function buildAutoPlan(ctx, plugins, skills) {
  const buckets = new Map()
  const push = (role, member, topic) => {
    const bucket = buckets.get(role) ?? { role, members: [], topics: new Map() }
    bucket.members.push(member)
    bucket.topics.set(topic, (bucket.topics.get(topic) ?? 0) + 1)
    buckets.set(role, bucket)
  }
  const keywordCache = new Map()
  const ownTags = new Map()
  for (const row of plugins) {
    if (!row.manageable) continue
    const { role, topic } = classify(row)
    push(role, { kind: 'plugin', id: row.id }, topic)
    const words = await packageKeywords(ctx, row.moduleName, keywordCache)
    if (words.length > 0) ownTags.set(`plugin:${row.id}`, words)
  }
  // Skills are something the user downloaded, so they share that bucket; the type column is
  // what tells them apart from plugins.
  for (const row of skills) push('rest', { kind: 'skill', id: row.id }, skillGroupFor(row.source))
  const rank = { official: 0, mcp: 1, base: 2, rest: 3 }
  return [...buckets.values()]
    .sort((left, right) => rank[left.role] - rank[right.role])
    .map((bucket) => {
      // Only what the packages themselves declare. A group with no keywords shows no labels;
      // our inferred topic words live in `row.alias` and never dress up as package metadata.
      const own = [...new Set(bucket.members.flatMap(member => ownTags.get(`${member.kind}:${member.id}`) ?? []))]
      const tags = own.slice(0, 4)
      return {
        name: ROLE_NAMES[bucket.role],
        role: bucket.role,
        collection: bucket.role === 'rest' ? null : 'default',
        tags,
        members: bucket.members,
      }
    })
}

// ── inventory ────────────────────────────────────────────────────────────────

async function listPlugins(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || manager === null) {
    throw new Failure('no-plugin-manager', 'this host exposes no pluginManager service, so plugins cannot be listed')
  }
  const rows = await manager.listPlugins()
  const packageCache = new Map()
  return await Promise.all(rows.map(async (row) => {
    const meta = isRecord(row.meta) ? row.meta : {}
    const moduleName = typeof row.moduleName === 'string' ? row.moduleName : row.entryId
    const readOnly = row.readOnlyReason
    const packageInfo = await packageMeta(ctx, moduleName, packageCache)
    // The description chain, in order: the row's own meta, the package manifest, a known-package
    // table, and finally an honest empty string. `descriptionSource` says which link answered, so
    // a missing line is diagnosable instead of looking like a rendering bug.
    const metaDescription = typeof meta.description === 'string' && meta.description.trim() !== '' ? meta.description : ''
    const known = knownDescription(moduleName)
    const description = metaDescription !== ''
      ? metaDescription
      : packageInfo.packageDescription !== '' ? packageInfo.packageDescription : known === null ? '' : known.zh
    const descriptionSource = metaDescription !== ''
      ? 'meta'
      : packageInfo.packageDescription !== '' ? 'package' : known === null ? '' : 'known'
    // Grouping keeps reading only what a row itself declares: a manifest blurb should not silently
    // move a plugin between the auto-group buckets.
    const declared = typeof meta.description === 'string' ? meta.description : ''
    return {
      kind: 'plugin',
      id: row.entryId,
      name: typeof meta.title === 'string' && meta.title !== '' ? meta.title : moduleName,
      moduleName,
      description,
      descriptionSource,
      ...(descriptionSource === 'known' && known !== null ? { descriptionEn: known.en } : {}),
      enabled: row.enabled === true,
      phase: row.fiberPhase ?? null,
      patchId: typeof row.patchId === 'string' ? row.patchId : null,
      readOnlyReason: readOnly ?? null,
      manageable: readOnly === undefined || readOnly === null,
      mcp: moduleName === MCP_MODULE,
      self: moduleName === SELF_MODULE,
      official: isOfficial(moduleName),
      root: rootModule(moduleName),
      role: classify({ moduleName, description: declared, name: typeof meta.title === 'string' ? meta.title : moduleName, mcp: moduleName === MCP_MODULE }).role,
      // The topic words we infer never show up as labels; they only make the row findable by
      // search, so `memory` still finds billion-context without putting a made-up tag on it.
      alias: classify({ moduleName, description: declared, name: typeof meta.title === 'string' ? meta.title : moduleName }).topic,
      keywords: packageInfo.keywords,
      surface: packageInfo.surface,
      // A client-bundled UI plugin is not a profile patch row: flipping it looks possible but
      // the loader refuses the write. Flag it so the panel can say so instead of failing.
      builtinUi: isOfficial(moduleName) && packageInfo.surface === 'ui',
    }
  }))
}

/**
 * MCP servers are ordinary loader rows, but the panel shows them by their
 * server name and lets people edit the config the row carries on disk.
 */
async function decorateMcp(ctx, plugins) {
  const patchPath = patchPathFor(ctx)
  if (patchPath === null) return { rows: plugins, patchPath: null, error: 'no profile patch found' }
  let text = ''
  try {
    text = await readPatchText(patchPath)
  }
  catch (error) {
    return { rows: plugins, patchPath, error: failureOf(error).message }
  }
  const mcp = mergeMcpRows(parseMcpRows(text), plugins)
  const patchIds = new Set(mcp.map(row => row.patchId).filter(id => id !== null))
  const byEntry = new Map(mcp.filter(row => row.entryId !== null).map(row => [row.entryId, row]))
  const merged = plugins.map((row) => {
    const match = row.mcp === true ? byEntry.get(row.id) : undefined
    if (match === undefined) return row
    const masked = maskConfigSecrets(match.config)
    return {
      ...row,
      name: match.name,
      mcp: true,
      mcpPatchId: match.patchId,
      mcpEditable: match.manageable && patchIds.has(match.patchId),
      transport: match.transport,
      command: match.command,
      url: match.url,
      config: masked.config,
      secretKeys: masked.secretKeys,
    }
  })
  const orphans = mcp.filter(row => row.entryId === null).map((row) => {
    const masked = maskConfigSecrets(row.config)
    return {
      kind: 'plugin',
      id: row.id,
      name: row.name,
      moduleName: MCP_MODULE,
      description: '',
      descriptionSource: '',
      enabled: false,
      phase: null,
      patchId: row.patchId,
      readOnlyReason: null,
      manageable: false,
      mcp: true,
      mcpPatchId: row.patchId,
      mcpEditable: false,
      transport: row.transport,
      command: row.command,
      url: row.url,
      config: masked.config,
      secretKeys: masked.secretKeys,
      self: false,
      official: true,
    }
  })
  return { rows: [...merged, ...orphans], patchPath, error: null }
}

/** The fields of an MCP config that carry credentials. */
const SECRET_FIELDS = ['env', 'headers']

/**
 * Snapshot-side secret masking: the keys stay, the values never leave the host.
 *
 * `secretKeys` is what the panel needs to say "2 keys set" and to send the key back empty
 * (meaning "keep it") without ever holding the value. Everything else in the config is
 * copied untouched — this is a view, not a rewrite.
 */
function maskConfigSecrets(config) {
  const secretKeys = { env: [], headers: [] }
  if (!isRecord(config)) return { config: config ?? null, secretKeys }
  const out = {}
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_FIELDS.includes(key) && isRecord(value)) {
      const masked = {}
      for (const [name, item] of Object.entries(value)) {
        masked[name] = ''
        if (item !== null && item !== undefined && item !== '') secretKeys[key].push(name)
      }
      out[key] = masked
      continue
    }
    out[key] = value
  }
  return { config: out, secretKeys }
}

/**
 * Where dsh-skill-mcp-panel keeps its own deny list (read-only for us).
 *
 * It sits under the first skill root, so an isolated install (TOOL_HUB_SKILL_ROOTS) reads its
 * own tree instead of the machine-wide one.
 */
function panelFilterPath(roots) {
  const root = roots[0]
  const base = root === undefined ? join(dshHome(), 'skills') : root.dir
  return join(base, '.system', 'skill-viewer', 'tool-filter.json')
}

/**
 * List the MCP tools the host currently exposes.
 *
 * `known` is false when the tools service cannot answer (early boot, or a host without
 * it); the panel then shows the saved deny list without claiming to know the live set.
 */
async function listTools(ctx, deny, roots) {
  const denied = new Set(deny)
  const panelDeny = await readPanelFilter(panelFilterPath(roots))
  const panelSet = new Set(panelDeny)
  const names = knownToolNames(ctx)
  if (names === null) return { rows: [], known: false, panelDeny }
  const rows = names
    .filter(name => name.startsWith(MCP_TOOL_PREFIX))
    .map((name) => {
      const parts = splitToolName(name)
      return {
        name,
        server: parts === null ? '' : parts.server,
        tool: parts === null ? name : parts.tool,
        enabled: !denied.has(name),
        panelDenied: panelSet.has(name),
      }
    })
    .sort((left, right) => (left.server === right.server
      ? left.tool.localeCompare(right.tool)
      : left.server.localeCompare(right.server)))
  return { rows, known: true, panelDeny }
}

/**
 * dshmarket keeps its own groups in `<profile>/.dsh-market/state.json` as
 * `{ groups: { name: [packageName, …] }, groupOrder: [name, …] }`. They are read-only here:
 * importing copies the grouping into our state and never writes that file.
 */
async function readMarketGroups(ctx, plugins) {
  const patch = patchPathFor(ctx)
  const file = patch === null ? null : join(dirname(patch), '.dsh-market', 'state.json')
  if (file === null) return { available: false, file: null, groups: [], error: null }
  let raw = null
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  }
  catch (error) {
    const missing = error?.code === 'ENOENT'
    return { available: false, file, groups: [], error: missing ? null : `cannot read dshmarket state: ${error?.message ?? error}` }
  }
  if (!isRecord(raw) || !isRecord(raw.groups)) return { available: false, file, groups: [], error: null }
  const byModule = new Map()
  for (const row of plugins) {
    if (typeof row.moduleName !== 'string' || row.moduleName === '') continue
    const list = byModule.get(row.moduleName)
    if (list === undefined) byModule.set(row.moduleName, [row])
    else list.push(row)
  }
  const order = Array.isArray(raw.groupOrder)
    ? raw.groupOrder.filter(name => typeof name === 'string' && Array.isArray(raw.groups[name]))
    : Object.keys(raw.groups)
  const groups = []
  for (const name of order) {
    const packages = Array.isArray(raw.groups[name]) ? raw.groups[name].filter(item => typeof item === 'string') : []
    const ids = []
    const missing = []
    for (const pkg of packages) {
      const rows = byModule.get(pkg)
      if (rows === undefined) missing.push(pkg)
      else for (const row of rows) if (!ids.includes(row.id)) ids.push(row.id)
    }
    groups.push({ name, packages: packages.length, members: ids.length, ids, missing })
  }
  return { available: groups.length > 0, file, groups, error: null }
}

/**
 * Cached snapshot. Every op answers then asks for a refresh, so an uncached build ran the whole
 * inventory twice per click; a short TTL plus single-flight keeps that to one build.
 */
async function buildSnapshot(ctx, options = {}) {
  if (options.fresh !== true && snapshotCache !== null && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS) return snapshotCache.value
  if (snapshotInflight !== null) return await snapshotInflight
  snapshotInflight = buildSnapshotOnce(ctx, options.fresh === true)
    .then((value) => {
      snapshotCache = { at: Date.now(), value }
      return value
    })
    .finally(() => { snapshotInflight = null })
  return await snapshotInflight
}

/** Drop the cache after a write: the next reader rebuilds at once. */
// `keepBundles` matters: a switch flips loader rows, never the bundle list, and re-listing
// bundles costs as much as listing the rows (400 ms on a 33-bundle profile).
function invalidateSnapshot(keepBundles = false) {
  snapshotCache = null
  pluginRowsCache = null
  if (keepBundles !== true) bundlesCache = null
}

async function buildSnapshotOnce(ctx, fresh = false) {
  // One root discovery per snapshot: the panel asks for this often, and a workspace list read
  // three times could disagree with itself halfway down the tree.
  const profile = process.env.TOOL_HUB_PROFILE === '1'
  const marks = []
  const at = (label, started) => { if (profile) marks.push([label, Number(process.hrtime.bigint() - started) / 1e6]) }
  const step = async (label, work) => {
    const started = process.hrtime.bigint()
    const value = await work()
    at(label, started)
    return value
  }
  const roots = skillRootList(ctx)
  const plugins = await step('plugins', () => pluginRows(ctx, fresh))
  const skills = await step('skills', () => listSkills(roots))
  const mcp = await step('mcp', () => decorateMcp(ctx, plugins))
  const merged = mcp.rows
  const state = await step('state', () => loadState())
  const toolInfo = await step('tools', () => listTools(ctx, effectiveDeny(state, knownToolNames(ctx) ?? []), roots))
  const marketInfo = await step('market', () => readMarketGroups(ctx, merged))
  const bundlesInfo = await step('bundles', () => bundlesFor(ctx, fresh))
  const compat = panelOf(merged)
  const present = new Set([...merged.map(row => `plugin:${row.id}`), ...skills.map(row => `skill:${row.id}`)])
  const groups = state.groups.map((group) => {
    const members = group.members.filter(member => present.has(`${member.kind}:${member.id}`))
    return { ...group, members, stale: group.members.length - members.length }
  })
  if (profile) {
    const total = marks.reduce((sum, [, ms]) => sum + ms, 0)
    const line = new Date().toISOString() + ' ' + marks.map(([label, ms]) => label + '=' + ms.toFixed(1)).join(' ') + ' total=' + total.toFixed(1) + 'ms\n'
    // The host owns stdout/stderr, so profiling goes to a file next to the state document.
    appendFile(join(dirname(stateFile()), 'snapshot-profile.log'), line).catch(() => {})
  }
  return {
    plugins: merged,
    skills,
    groups,
    collections: state.collections,
    presets: state.presets,
    auto: state.auto,
    tools: toolInfo.rows,
    lazy: state.lazyServers,
    lazyLoaded: state.lazyLoaded,
    // Exposed separately from `toolMask`: a panel must be able to list the overlays even when the
    // host gave us no mask service at all (then nothing is enforced, and the panel says so).
    sessions: state.sessions,
    toolMask: toolMask === null ? null : toolMask.info(),
    toolsKnown: toolInfo.known,
    panelDeny: toolInfo.panelDeny,
    market: marketInfo,
    // P2: the bundle view and the history drawer are extras; neither can fail the snapshot.
    bundles: bundlesInfo.rows,
    bundleError: bundlesInfo.error,
    history: await readHistory(),
    compat: { ...compat, active: compat.present && compat.enabled, lock: patchPathFor(ctx) === null ? null : `${patchPathFor(ctx)}.panel.lock` },
    paths: {
      home: dshHome(),
      state: stateFile(),
      // The contract the client groups by: id + label + scope + owning workspace per root.
      skills: roots.map(root => ({ id: root.id, label: root.label, dir: root.dir, scope: root.scope, workspace: root.workspace })),
      skillRoots: roots.map(root => root.dir),
      patch: mcp.patchPath,
      panelFilter: panelFilterPath(roots),
      marketState: marketInfo.file,
      trash: trashDir(),
    },
    mcpError: mcp.error,
    limits: { bulk: MAX_BULK },
  }
}

// ── operations ───────────────────────────────────────────────────────────────

const SELF_MODULE = 'dsh-tool-hub'

/** Config keys an MCP row may carry; anything else is left to the raw file. */
const ALLOWED_MCP_KEYS = new Set([
  'serverName',
  'transport',
  'command',
  'args',
  'cwd',
  'env',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'failOnStartupError',
  'reconnect',
])

/**
 * Write one MCP server's config back into the profile patch.
 *
 * The enable switch is not here: those rows are ordinary loader entries, so it
 * goes through `pluginManager.setPluginEnabled` like every other plugin. Only
 * the config needs the file, and only this row's block is rewritten.
 */
/**
 * `${NAME}` in an `env` / `headers` value means "read that environment variable at load time".
 * The patch file gets the YAML tag form the loader evaluates, never the secret itself.
 */
const SECRET_TEMPLATE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/**
 * Turn one `env` / `headers` object into what should be written for it.
 *
 * Values are strings; `null` (or anything else) is not a value the loader can carry. A value
 * that is exactly `${NAME}` becomes the internal `{ __js }` marker, an existing `!!js …` value
 * passes through untouched, and an empty value keeps the stored one — or fails loudly when
 * there is nothing stored.
 */
function secretPairs(field, asked, existing) {
  const stored = isRecord(existing) ? existing : {}
  const pairs = {}
  for (const [name, item] of Object.entries(stored)) {
    if (typeof item === 'string') pairs[name] = item
    else if (isRecord(item) && typeof item.__js === 'string') pairs[name] = { __js: item.__js }
  }
  for (const [name, item] of Object.entries(asked)) {
    if (typeof item !== 'string') continue
    if (item === '') {
      if (!Object.prototype.hasOwnProperty.call(pairs, name)) {
        throw new Failure('bad-secret', `${field}.${name} is empty and has no stored value to keep`)
      }
      continue
    }
    if (item.startsWith('!!js ')) {
      pairs[name] = item
      continue
    }
    const template = SECRET_TEMPLATE.exec(item)
    pairs[name] = template === null ? item : { __js: `process.env.${template[1]}` }
  }
  return pairs
}

/**
 * Keep only the config keys this panel understands and coerce them to the shape
 * the host's MCP client expects. Anything unknown is dropped, `null` means delete.
 *
 * `env` / `headers` have their own three-way rule, because the panel never holds their
 * values: a non-empty string is written, an empty string keeps whatever the file already
 * had (the client sends `''` for every key it saw masked), and an empty string for a key
 * nobody has ever set is refused — otherwise a typo in a key name would silently create
 * an empty credential.
 */
function cleanMcpConfig(asked, existing) {
  const out = {}
  const scalar = (key) => {
    const value = asked[key]
    if (value === null) out[key] = null
    else if (typeof value === 'string') out[key] = value
  }
  scalar('serverName')
  scalar('transport')
  scalar('command')
  scalar('cwd')
  scalar('url')
  if (Array.isArray(asked.args) && asked.args.every(item => typeof item === 'string')) out.args = asked.args
  else if (asked.args === null) out.args = null
  for (const key of SECRET_FIELDS) {
    const value = asked[key]
    if (value === null) out[key] = null
    else if (isRecord(value)) out[key] = secretPairs(key, value, isRecord(existing) ? existing[key] : null)
  }
  if (asked.toolCallTimeoutMs === null) out.toolCallTimeoutMs = null
  else if (Number.isFinite(asked.toolCallTimeoutMs) && asked.toolCallTimeoutMs > 0) out.toolCallTimeoutMs = Math.round(asked.toolCallTimeoutMs)
  if (typeof asked.failOnStartupError === 'boolean') out.failOnStartupError = asked.failOnStartupError
  if (asked.reconnect === null) out.reconnect = null
  else if (isRecord(asked.reconnect)) {
    const next = {}
    if (typeof asked.reconnect.enabled === 'boolean') next.enabled = asked.reconnect.enabled
    for (const key of ['initialDelayMs', 'maxDelayMs', 'maxAttempts']) {
      const value = asked.reconnect[key]
      if (Number.isFinite(value) && value > 0) next[key] = Math.round(value)
    }
    out.reconnect = next
  }
  return out
}

/**
 * Compatibility with dsh-skill-mcp-panel, detected rather than configured.
 *
 * That panel has no private enable/disable state: skills are switched by renaming
 * `SKILL.md`, MCP servers by editing the profile patch's `panel-mcp-*` rows. Both
 * panels therefore read the same truth, and the only way they can hurt each other
 * is by writing at the same moment — its writer takes `<patch>.panel.lock`, so we
 * take the same lock while we write. Its tool deny list stays read-only here and is
 * merged as a union (see tool-filter.js): its runtime truth is its own memory, so
 * writing that file would be overwritten on its next save.
 */
const PANEL_MODULE = 'dsh-skill-mcp-panel'
const PANEL_LOCK_STALE_MS = 30_000
const PANEL_LOCK_HEARTBEAT_MS = 10_000
const PANEL_LOCK_TIMEOUT_MS = (() => {
  const asked = Number(process.env.TOOL_HUB_LOCK_TIMEOUT_MS ?? '')
  return Number.isFinite(asked) && asked > 0 ? asked : 5000
})()

function panelOf(plugins) {
  const row = plugins.find(item => item.moduleName === PANEL_MODULE)
  return { present: row !== undefined, enabled: row?.enabled === true, moduleName: PANEL_MODULE }
}

async function acquirePanelLock(patch) {
  const file = `${patch}.panel.lock`
  const token = `${process.pid}:${randomUUID()}`
  const started = Date.now()
  // A patch write implies the profile directory; creating it here keeps the first write to a
  // fresh profile from failing on a missing parent.
  await mkdir(dirname(file), { recursive: true })
  for (;;) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(`${token}\n${new Date().toISOString()}\n`)
      await handle.close()
      return { file, token, lost: false }
    }
    catch (error) {
      if (error?.code !== 'EEXIST') throw new Failure('lock-failed', `cannot take ${file}: ${error?.message ?? error}`)
      const seen = await readLockOwner(file)
      // A lock we cannot even read (permissions, a directory in the way) is not a spin target.
      if (seen === null) {
        await new Promise(resolve => setTimeout(resolve, 60))
        continue
      }
      // The other panel treats a lock older than 30s as abandoned. Reclaim only a lock that has a
      // readable token (a file we cannot identify is not ours to delete) and only after a second
      // read agrees, so two waiters cannot both "reclaim" and end up writing at once.
      if (seen.token !== '' && seen.age > PANEL_LOCK_STALE_MS) {
        const again = await readLockOwner(file)
        if (again !== null && again.token === seen.token && again.age > PANEL_LOCK_STALE_MS) {
          await rm(file, { force: true })
        }
        continue
      }
      if (Date.now() - started > PANEL_LOCK_TIMEOUT_MS) {
        throw new Failure('lock-timeout', `another writer holds ${file}`)
      }
      await new Promise(resolve => setTimeout(resolve, 120))
    }
  }
}

/** Whoever holds the lock now — its token and how long its mtime has stood still. */
async function readLockOwner(file) {
  try {
    const [info, text] = await Promise.all([stat(file), readFile(file, 'utf8')])
    return { token: String(text).split('\n')[0].trim(), age: Date.now() - info.mtimeMs }
  }
  catch {
    return null
  }
}

/**
 * Drop our lock, but only if the file still carries our token: a lock that was reclaimed while we
 * ran belongs to someone else. Moving the file out of the way first makes the check-and-delete
 * one step instead of two.
 *
 * Answers `released`, `gone` (the file is no longer there — a cleanup, not a conflict) or
 * `foreign` (someone else owns it now, which the caller has to report).
 */
async function releasePanelLock(lock) {
  const owner = await readLockOwner(lock.file)
  if (owner === null) return 'gone'
  if (owner.token !== lock.token) return 'foreign'
  const parked = `${lock.file}.${process.pid}.${randomUUID()}.release`
  try {
    await rename(lock.file, parked)
  }
  catch {
    return 'gone'
  }
  const taken = String(await readFile(parked, 'utf8').catch(() => '')).split('\n')[0].trim()
  if (taken !== lock.token) {
    // Someone else's lock slipped in between the check and the move. Put it back only if the
    // name is still free; never overwrite a lock that a third writer created meanwhile.
    const free = await stat(lock.file).then(() => false, () => true)
    if (free) await rename(parked, lock.file).catch(() => rm(parked, { force: true }).catch(() => {}))
    else await rm(parked, { force: true }).catch(() => {})
    return 'foreign'
  }
  await rm(parked, { force: true }).catch(() => {})
  return 'released'
}

/**
 * Run `work` holding the patch lock.
 *
 * The holder refreshes the lock's mtime every ten seconds, so a write that waits for a 900ms
 * verification (and its retries) is never mistaken for a crashed writer. If the lock changed
 * hands mid-write the call reports `lock-lost` rather than claiming a clean write.
 */
async function withPanelLock(patch, work) {
  const lock = await acquirePanelLock(patch)
  const beat = setInterval(() => {
    utimes(lock.file, new Date(), new Date()).then(
      async () => {
        const owner = await readLockOwner(lock.file)
        if (owner === null || owner.token !== lock.token) {
          lock.lost = true
          clearInterval(beat)
        }
      },
      () => {
        lock.lost = true
        clearInterval(beat)
      },
    )
  }, PANEL_LOCK_HEARTBEAT_MS)
  beat.unref?.()
  let result
  let failure = null
  try {
    result = await work()
  }
  catch (error) {
    failure = error
  }
  clearInterval(beat)
  const released = await releasePanelLock(lock).catch(() => 'gone')
  // The original failure wins: a release problem must not hide what actually went wrong.
  if (failure !== null) throw failure
  if (lock.lost || released === 'foreign') {
    throw new Failure('lock-lost', `the patch lock ${lock.file} changed hands during this write`)
  }
  return result
}

/**
 * `mcp.create` / `mcp.save` / `mcp.delete`.
 *
 * Everything that reads the file — the row lookup, the "empty credential keeps the stored value"
 * rule, the id it generates — happens inside the patch lock, because a request that computed its
 * edit from an old copy of the file would silently overwrite whoever wrote in between. Payload
 * shape is validated before locking so a malformed request never waits on another writer.
 */
async function handleMcp(ctx, op, payload) {
  const patch = patchPathFor(ctx)
  if (patch === null) throw new Failure('no-patch', 'this profile has no cordis.patch.yml to edit')
  if (op !== 'create' && op !== 'save' && op !== 'delete') throw new Failure('bad-op', `unknown mcp op ${String(op)}`)

  const id = String(payload?.id ?? '')
  if (op !== 'create' && !/^[A-Za-z0-9._:@/-]{1,120}$/.test(id)) throw new Failure('bad-id', 'mcp row id cannot be used')
  const asked = payload?.config
  if (op !== 'delete' && !isRecord(asked)) throw new Failure('bad-config', 'config must be an object')

  return await withPanelLock(patch, async () => {
    const text = await readPatchText(patch)
    const rows = parseMcpRows(text)

    if (op === 'delete') {
      if (!rows.some(item => item.id === id)) throw new Failure('unknown-mcp', `no MCP server "${id}" in the profile patch`)
      // §0: every write lands a copy of the file first; the write itself stays tmp + rename.
      await backupPatch(patch, text)
      await writePatchText(patch, removeMcpRow(text, id))
      return { ok: true, id, patch, route: 'hmr', removed: true }
    }

    if (op === 'create') {
      // Nothing to keep: every empty credential here is a new key, and that is `bad-secret`.
      const cleaned = cleanMcpConfig(asked, null)
      const name = typeof cleaned.serverName === 'string' ? cleaned.serverName : ''
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Failure('bad-name', 'server name must be 1-32 letters, digits, - or _')
      if (rows.some(item => item.config.serverName === name)) throw new Failure('duplicate-mcp', `an MCP server named "${name}" already exists`)
      const ids = new Set(rows.map(item => item.id))
      let fresh = `tool-hub-mcp-${name}`
      let suffix = 1
      while (ids.has(fresh)) {
        suffix += 1
        fresh = `tool-hub-mcp-${name}-${suffix}`
      }
      await backupPatch(patch, text)
      await writePatchText(patch, appendMcpRow(text, fresh, cleaned, true))
      return { ok: true, id: fresh, patch, route: 'hmr', config: cleaned, created: true }
    }

    const row = rows.find(item => item.id === id)
    if (row === undefined) throw new Failure('unknown-mcp', `no MCP server "${id}" in the profile patch`)
    // The existing config is what makes an empty credential mean "keep it" instead of "erase it".
    const cleaned = cleanMcpConfig(asked, row.config)
    const config = { ...row.config }
    for (const [key, value] of Object.entries(cleaned)) {
      if (value === null) delete config[key]
      else config[key] = value
    }
    await backupPatch(patch, text)
    await writePatchText(patch, replaceMcpConfig(text, id, config))
    return { ok: true, id, patch, route: 'hmr', config }
  })
}

async function handleProbe(ctx, payload) {
  const askedId = typeof payload?.id === 'string' && payload.id !== '' ? payload.id : null
  let config = {}
  if (askedId !== null) {
    const patch = patchPathFor(ctx)
    if (patch === null) throw new Failure('no-patch', 'this profile has no cordis.patch.yml to edit')
    const text = await readPatchText(patch)
    const row = parseMcpRows(text).find(item => item.id === askedId)
    if (row === undefined) throw new Failure('unknown-mcp', `no MCP server "${askedId}" in the profile patch`)
    config = { ...row.config }
  }
  if (isRecord(payload?.config) === true) {
    // Same rule as save: an empty credential means "the one already stored", so a probe of a
    // row whose values the panel cannot see still tests with its real values.
    const cleaned = cleanMcpConfig(payload.config, config)
    for (const [key, value] of Object.entries(cleaned)) {
      if (value === null) delete config[key]
      else config[key] = value
    }
  }
  if (Object.keys(config).length === 0) throw new Failure('bad-config', 'nothing to test: no id and no config')
  const raw = Number(payload?.timeoutMs)
  const timeoutMs = Number.isFinite(raw) && raw >= 2000 ? Math.min(Math.round(raw), 60000) : 12000
  try {
    const result = await probeServer(config, { timeoutMs })
    return { ok: true, ...result, count: result.tools.length, timeoutMs }
  }
  catch (error) {
    if (error instanceof ProbeError) throw new Failure(error.code, error.message, error.detail)
    throw error
  }
}

// ── raw MCP rows ─────────────────────────────────────────────────────────────

const MCP_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,120}$/

/** One row's bytes exactly as the file holds them, indentation and line ending included. */
function rowText(text, row) {
  const doc = splitDocument(text)
  return doc.lines.slice(row.startLine, row.endLine).join(doc.eol)
}

/** The file as it was, kept under `<dshHome>/backups/` before any byte-level edit. */
async function backupPatch(patch, text) {
  const dir = join(dshHome(), 'backups')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${basename(patch)}-${stamp}-${process.pid}.bak`)
  await writeFile(file, text, 'utf8')
  return file
}

/**
 * Ask the host whether it actually loaded the row we wrote.
 *
 * There is no `waitForMcp` in this host, so the snapshot is the oracle: a row that survives
 * the write appears either bound to a loader entry or as an orphan, and either way carries the
 * server name we just wrote. Three attempts, because an HMR reload is not synchronous.
 */
async function verifyRawSave(ctx, id, expectedName) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise(done => setTimeout(done, attempt === 0 ? RAW_VERIFY_DELAY_MS : 300))
    try {
      const snap = await buildSnapshot(ctx)
      const live = snap.plugins.find(row => row.mcpPatchId === id)
      if (live === undefined) continue
      if (expectedName !== null && live.name !== expectedName) continue
      return true
    }
    catch {
      // A snapshot that throws is not an answer; try once more.
    }
  }
  return false
}

/**
 * `mcp.raw` / `mcp.rawSave`: the escape hatch under the form.
 *
 * The validation is deliberately all-or-nothing: four checks plus "no stray lines", and any
 * failure means not a single byte is written. A row that passes is written verbatim, backed up
 * first, and then checked against the host's own view; if the host did not pick it up, the
 * previous text goes back and the caller gets a failure instead of a broken profile.
 */
async function handleMcpRaw(ctx, op, payload) {
  const patch = patchPathFor(ctx)
  if (patch === null) throw new Failure('no-patch', 'this profile has no cordis.patch.yml to edit')

  if (op === 'raw') {
    const id = String(payload?.id ?? '')
    if (!MCP_ID_PATTERN.test(id)) throw new Failure('bad-id', 'mcp row id cannot be used')
    const text = await readPatchText(patch)
    const row = parseMcpRows(text).find(item => item.id === id)
    if (row === undefined) throw new Failure('unknown-mcp', `no MCP server "${id}" in the profile patch`)
    return { id, text: rowText(text, row) }
  }
  if (op !== 'rawSave') throw new Failure('bad-op', `unknown mcp op ${String(op)}`)

  const askedId = typeof payload?.id === 'string' ? payload.id.trim() : ''
  if (askedId !== '' && !MCP_ID_PATTERN.test(askedId)) throw new Failure('bad-id', 'mcp row id cannot be used')
  const snippet = typeof payload?.text === 'string' ? payload.text : ''
  if (snippet.trim() === '') throw new Failure('raw-invalid', 'the edited text is empty')
  // Parse and validate the snippet before touching the patch: a request that cannot possibly be
  // written should not sit in the lock queue behind a slow writer.
  const parsed = parseMcpRows(snippet)
  if (parsed.length !== 1) throw new Failure('raw-invalid', `expected exactly one MCP row, found ${parsed.length}`)
  const next = parsed[0]
  if (next.name !== MCP_MODULE) throw new Failure('raw-invalid', 'that row is not an MCP server')
  if (next.startLine !== 0) throw new Failure('raw-invalid', 'the text must start with its `- id:` line')
  const wantedName = typeof payload?.name === 'string' ? payload.name.trim() : ''

  return await withPanelLock(patch, async () => {
    // Re-read inside the lock: the row this edit replaces is located from the file as it is now,
    // never from the copy the request happened to see.
    const text = await readPatchText(patch)
    const rows = parseMcpRows(text)
    let existing = null
    if (askedId !== '') {
      existing = rows.find(item => item.id === askedId) ?? null
    }
    else {
      // No id: the server name has to pick exactly one row, otherwise "which row" is a guess.
      const matches = wantedName === '' ? [] : rows.filter(item => item.config?.serverName === wantedName)
      if (matches.length > 1) throw new Failure('bad-id', `more than one MCP server is named "${wantedName}"`)
      if (matches.length === 1) existing = matches[0]
    }
    if (existing === null) throw new Failure('unknown-mcp', 'no MCP server matches that id')

    if (next.id !== existing.id) throw new Failure('raw-id', `the row id must stay "${existing.id}"`)
    if (next.indent !== existing.indent) throw new Failure('raw-indent', `the row must stay indented by ${existing.indent} spaces`)
    const doc = splitDocument(text)
    const snippetLines = splitDocument(snippet).lines
    const stray = snippetLines.findIndex((line, index) => line.trim() !== '' && (index < next.startLine || index >= next.endLine))
    if (stray >= 0) throw new Failure('raw-invalid', `line ${stray + 1} is outside the MCP row`)

    const expectedName = typeof next.config?.serverName === 'string' ? next.config.serverName : next.id
    const merged = finishDocument(doc, [...doc.lines.slice(0, existing.startLine), ...snippetLines, ...doc.lines.slice(existing.endLine)])
    const backup = await backupPatch(patch, text)
    await writePatchText(patch, merged)

    if (!(await verifyRawSave(ctx, existing.id, expectedName))) {
      // Still inside the lock: nothing else may write between "the host did not load it" and the
      // restore. And restore only if the file is still exactly what this call wrote — otherwise
      // the edit is kept and the caller is told the patch moved under it.
      const current = await readPatchText(patch)
      if (current !== merged) {
        throw new Failure('raw-conflict', `the host did not load the edited row and the patch changed meanwhile; left as-is (backup: ${backup})`)
      }
      try {
        await writePatchText(patch, text)
      }
      catch (error) {
        throw new Failure('raw-rollback', `the host did not load the edited row and the previous text could not be restored: ${error?.message ?? error} (backup: ${backup})`)
      }
      throw new Failure('raw-verify', `the host did not load the edited row; the file was put back (backup: ${backup})`)
    }
    return { id: existing.id, saved: true, backup }
  })
}

/**
 * Write one row's config through the same gate as every other patch write: backup, panel lock,
 * tmp + rename, then a snapshot check. `mutate` receives the file's own config (never the masked
 * snapshot copy), so a token can be added without round-tripping the masked values.
 */
async function commitMcpConfig(ctx, id, mutate) {
  const patch = patchPathFor(ctx)
  if (patch === null) throw new Failure('no-patch', 'this profile has no cordis.patch.yml to edit')
  return await withPanelLock(patch, async () => {
    const text = await readPatchText(patch)
    const row = parseMcpRows(text).find(item => item.id === id)
    if (row === undefined) throw new Failure('unknown-mcp', `no MCP server "${id}" in the profile patch`)
    const config = mutate({ ...row.config })
    const next = replaceMcpConfig(text, id, config)
    const backup = await backupPatch(patch, text)
    await writePatchText(patch, next)
    const expectedName = typeof config.serverName === 'string' ? config.serverName : id
    if (!(await verifyRawSave(ctx, id, expectedName))) {
      // Compare-and-restore, inside the lock: only put the old text back while the file still
      // holds exactly what this call wrote.
      const current = await readPatchText(patch)
      if (current !== next) {
        throw new Failure('verify', `the host did not load the written row and the patch changed meanwhile; left as-is (backup: ${backup})`)
      }
      try {
        await writePatchText(patch, text)
      }
      catch (error) {
        throw new Failure('verify-rollback', `the host did not load the written row and the previous text could not be restored: ${error?.message ?? error} (backup: ${backup})`)
      }
      throw new Failure('verify', `the host did not load the written row; the file was put back (backup: ${backup})`)
    }
    return { backup }
  })
}

// ── OAuth for MCP servers (out-of-band code paste) ──────────────────────────

function pruneOauthPending() {
  const now = Date.now()
  for (const [key, item] of OAUTH_PENDING) {
    if (now - item.at > OAUTH_PENDING_TTL_MS) OAUTH_PENDING.delete(key)
  }
  // Insertion order is age order, so the first key is the one to drop.
  while (OAUTH_PENDING.size >= OAUTH_PENDING_LIMIT) {
    const oldest = OAUTH_PENDING.keys().next()
    if (oldest.done === true) break
    OAUTH_PENDING.delete(oldest.value)
  }
}

function oauthPendingGet(state) {
  const item = OAUTH_PENDING.get(state)
  if (item === undefined) return null
  if (Date.now() - item.at > OAUTH_PENDING_TTL_MS) {
    OAUTH_PENDING.delete(state)
    return null
  }
  return item
}

/**
 * `mcp.oauthStart` / `mcp.oauthFinish` / `mcp.oauthCancel`.
 *
 * Discovery, dynamic registration and PKCE all live in `lib/oauth.js`; this side only keeps the
 * pending pair in memory, and the access token never travels back to the caller — it goes into the
 * row's `Authorization` header and the reply is just `{ id, saved: true }`.
 */
async function handleOauth(ctx, op, payload) {
  if (op === 'cancel') {
    const state = typeof payload?.state === 'string' ? payload.state.trim() : ''
    if (state !== '') OAUTH_PENDING.delete(state)
    return { cancelled: true }
  }

  if (op === 'start') {
    const id = String(payload?.id ?? '')
    if (!MCP_ID_PATTERN.test(id)) throw new Failure('bad-id', 'mcp row id cannot be used')
    const patch = patchPathFor(ctx)
    if (patch === null) throw new Failure('no-patch', 'this profile has no cordis.patch.yml to edit')
    const row = parseMcpRows(await readPatchText(patch)).find(item => item.id === id)
    if (row === undefined) throw new Failure('unknown-mcp', `no MCP server "${id}" in the profile patch`)
    const raw = typeof row.config?.url === 'string' ? row.config.url.trim() : ''
    let endpoint = null
    try {
      const parsed = new URL(raw)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') endpoint = raw
    }
    catch {
      endpoint = null
    }
    if (endpoint === null) throw new Failure('not-http', 'this server has no http(s) url to authorize against')

    let meta
    try {
      meta = await discover(endpoint)
    }
    catch (error) {
      throw new Failure('oauth-failed', String(error?.message ?? error))
    }
    let client
    try {
      client = await register(meta, { clientName: 'dsh-tool-hub', redirectUri: OAUTH_REDIRECT_URI })
    }
    catch (error) {
      throw new Failure('oauth-failed', String(error?.message ?? error))
    }
    const pkce = createPkce()
    const state = randomBytes(16).toString('hex')
    const url = authorizeUrl({
      meta,
      clientId: client.clientId,
      redirectUri: OAUTH_REDIRECT_URI,
      state,
      codeChallenge: pkce.challenge,
      scopes: meta.scopes,
    })
    pruneOauthPending()
    OAUTH_PENDING.set(state, {
      at: Date.now(),
      id,
      verifier: pkce.verifier,
      meta,
      clientId: client.clientId,
      clientSecret: typeof client.clientSecret === 'string' ? client.clientSecret : null,
      redirectUri: OAUTH_REDIRECT_URI,
    })
    return { authorizeUrl: url, state, redirectUri: OAUTH_REDIRECT_URI }
  }
  if (op !== 'finish') throw new Failure('bad-op', `unknown oauth op ${String(op)}`)

  const state = typeof payload?.state === 'string' ? payload.state.trim() : ''
  const code = typeof payload?.code === 'string' ? payload.code.trim() : ''
  const pending = state === '' ? null : oauthPendingGet(state)
  if (pending === null) throw new Failure('bad-state', 'that login is unknown or has expired')
  if (code === '') throw new Failure('oauth-failed', 'the authorization code is empty')

  let token
  try {
    token = await exchangeCode({
      meta: pending.meta,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret ?? undefined,
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
    })
  }
  catch (error) {
    // A code is single-use: once the exchange fails this pending entry cannot be retried.
    OAUTH_PENDING.delete(state)
    throw new Failure('oauth-failed', String(error?.message ?? error))
  }
  OAUTH_PENDING.delete(state)
  try {
    await commitMcpConfig(ctx, pending.id, config => ({
      ...config,
      headers: {
        ...(isRecord(config.headers) ? config.headers : {}),
        Authorization: `Bearer ${token.accessToken}`,
      },
    }))
  }
  catch (error) {
    // The only codes the caller knows here are bad-state / oauth-failed; anything else is a write.
    throw new Failure('oauth-failed', String(error?.message ?? error))
  }
  return { id: pending.id, saved: true }
}



// ── diagnostics, bundles, config transfer ───────────────────────────────────

/**
 * `pluginManager.listBundles()` shaped for the panel: names, versions, which rows belong to a
 * bundle. A host without that service (or one that throws) is a `bundleError`, never a failed
 * snapshot — the bundle view is an extra, not the main list.
 */
async function listBundlesForSnapshot(ctx) {
  let manager = null
  try {
    manager = ctx.get('pluginManager')
  }
  catch {
    manager = null
  }
  if (manager === null || manager === undefined || typeof manager.listBundles !== 'function') {
    return { rows: [], error: 'this host has no pluginManager.listBundles' }
  }
  try {
    const list = await manager.listBundles()
    const rows = (Array.isArray(list) ? list : []).map((bundle) => {
      const row = isRecord(bundle) ? bundle : {}
      const members = Array.isArray(row.rows)
        ? row.rows.map(item => (typeof item === 'string' ? item : isRecord(item) ? item.entryId : undefined)).filter(item => typeof item === 'string')
        : []
      return {
        name: typeof row.name === 'string' ? row.name : '',
        ...(typeof row.version === 'string' ? { version: row.version } : {}),
        enabled: row.enabled === true,
        official: row.official === true,
        rows: members,
      }
    }).filter(row => row.name !== '')
    return { rows, error: null }
  }
  catch (error) {
    return { rows: [], error: String(error?.message ?? error) }
  }
}

/**
 * `doctor`: the six things that make a panel look broken, each answered by trying it.
 *
 * Every check is independent — one failing probe never hides the others — and the ids are the
 * contract the client renders.
 */
async function handleDoctor(ctx) {
  const checks = []
  const patch = patchPathFor(ctx)
  const push = (id, ok, detail) => checks.push({ id, ok, detail: String(detail) })

  try {
    if (patch === null) throw new Error('this profile has no cordis.patch.yml')
    const rows = parseMcpRows(await readPatchText(patch))
    push('patch-parse', true, `${rows.length} MCP row(s) in ${patch}`)
  }
  catch (error) {
    push('patch-parse', false, error?.message ?? error)
  }

  try {
    const dir = dirname(stateFile())
    await mkdir(dir, { recursive: true })
    const probe = join(dir, `.doctor-${process.pid}-${Date.now()}.tmp`)
    await writeFile(probe, 'ok', 'utf8')
    await rm(probe, { force: true })
    push('state-writable', true, dir)
  }
  catch (error) {
    push('state-writable', false, error?.message ?? error)
  }

  let failed = []
  let listed = true
  try {
    // `phase` is the snapshot's own name for the loader's fiber state.
    failed = (await listPlugins(ctx)).filter(row => row.phase === 'failed' || row.state === 'failed')
  }
  catch (error) {
    listed = false
    push('failed-rows', false, `cannot list plugins: ${String(error?.message ?? error)}`)
  }
  if (listed) {
    push('failed-rows', failed.length === 0, failed.length === 0 ? 'no failed rows' : failed.map(row => row.moduleName ?? row.id).join(', '))
  }

  const lock = patch === null ? null : `${patch}.panel.lock`
  try {
    const info = lock === null ? null : await stat(lock).catch(() => null)
    if (info === null) push('stale-lock', true, 'no lock file')
    else {
      const age = Date.now() - info.mtimeMs
      push('stale-lock', age <= PANEL_LOCK_STALE_MS, age <= PANEL_LOCK_STALE_MS ? `held for ${Math.round(age / 1000)}s` : `${lock} is ${Math.round(age / 1000)}s old (stale)`)
    }
  }
  catch (error) {
    push('stale-lock', false, error?.message ?? error)
  }

  const roots = skillRootList(ctx)
  const unreadable = []
  let readable = 0
  for (const root of roots) {
    try {
      await readdir(root.dir)
      readable += 1
    }
    catch (error) {
      if (error?.code === 'ENOENT') continue
      unreadable.push(`${root.id}: ${error?.code ?? error?.message ?? error}`)
    }
  }
  push('skill-roots', unreadable.length === 0, unreadable.length === 0 ? `${readable}/${roots.length} root(s) readable` : unreadable.join('; '))

  try {
    await mkdir(trashDir(), { recursive: true })
    const probe = join(trashDir(), `.doctor-${process.pid}-${Date.now()}.tmp`)
    await writeFile(probe, 'ok', 'utf8')
    await rm(probe, { force: true })
    push('trash', true, trashDir())
  }
  catch (error) {
    push('trash', false, error?.message ?? error)
  }

  try {
    const known = knownToolNames(ctx)
    const present = known !== null && known.includes('hub_tools')
    push('hub-tools', present, present ? 'hub_tools is registered' : 'hub_tools is missing from the tool registry')
  }
  catch (error) {
    push('hub-tools', false, error?.message ?? error)
  }

  // Ninth check: did this process mount at all? An inject name the host no longer publishes
  // makes the plugin vanish without a log line, and every other check here still passes.
  try {
    const verdict = diagnoseMount({
      file: heartbeatPath(dirname(stateFile())),
      pid: process.pid,
      hostStartedAt: Date.now() - Math.round(process.uptime() * 1000),
      expectedInjects: [...HEARTBEAT_INJECTS],
    })
    push('mount-heartbeat', verdict.ok, verdict.ok
      ? `applied ${Math.round(verdict.facts.ageMs / 1000)}s ago, pid ${verdict.facts.pid}`
      : verdict.problems.join('; '))
  }
  catch (error) {
    push('mount-heartbeat', false, error?.message ?? error)
  }

  // The last profiled snapshot, if the operator ran with TOOL_HUB_PROFILE=1. Kept informational:
  // a slow snapshot is worth seeing, but it is not a broken installation.
  try {
    const file = join(dirname(stateFile()), 'snapshot-profile.log')
    const raw = await readFile(file, 'utf8')
    const lines = raw.trim().split('\n').filter(line => line !== '')
    const last = lines[lines.length - 1] ?? ''
    const steps = [...last.matchAll(/([a-z]+)=([0-9.]+)/g)].map(match => `${match[1]} ${Math.round(Number(match[2]))}ms`)
    push('snapshot-profile', true, steps.length === 0 ? `no parsed timings in ${file}` : `${steps.join(' · ')} (${lines.length} sample(s))`)
  }
  catch (error) {
    push('snapshot-profile', true, 'no profile log yet — run with TOOL_HUB_PROFILE=1 to collect timings')
  }
  return { checks }
}

/** Merge two normalized states: by id for groups, existing wins on a name collision. */
function mergeConfigStates(current, incoming) {
  const next = {
    version: 1,
    groups: current.groups.map(group => ({ ...group, members: [...group.members], tags: [...group.tags] })),
    collections: [...current.collections],
    presets: [...current.presets],
    toolDeny: [...current.toolDeny],
    auto: current.auto,
  }
  const collectionIds = new Set(next.collections.map(entry => entry.id))
  for (const entry of incoming.collections) {
    if (collectionIds.has(entry.id)) continue
    next.collections.push(entry)
    collectionIds.add(entry.id)
  }
  next.collections.sort((left, right) => left.order - right.order)

  const byId = new Map(next.groups.map(group => [group.id, group]))
  const byName = new Map(next.groups.map(group => [group.name, group]))
  for (const group of incoming.groups) {
    const sameId = byId.get(group.id)
    if (sameId !== undefined) {
      const seen = new Set(sameId.members.map(member => `${member.kind}:${member.id}`))
      for (const member of group.members) {
        const key = `${member.kind}:${member.id}`
        if (seen.has(key)) continue
        seen.add(key)
        sameId.members.push(member)
      }
      sameId.tags = [...new Set([...sameId.tags, ...group.tags])].slice(0, 8)
      continue
    }
    // 同名组保留现有：the user's own group wins over one of the same name from the file.
    if (byName.has(group.name)) continue
    next.groups.push(group)
    byId.set(group.id, group)
    byName.set(group.name, group)
  }

  const presetNames = new Set(next.presets.map(preset => preset.name))
  for (const preset of incoming.presets) {
    if (presetNames.has(preset.name)) continue
    next.presets.push(preset)
    presetNames.add(preset.name)
  }
  next.toolDeny = [...new Set([...next.toolDeny, ...incoming.toolDeny])].filter(name => name.startsWith(MCP_TOOL_PREFIX))
  return next
}

/**
 * `config.export` / `config.import`: groups, collections, presets and the tool deny list, nothing
 * that names a credential or a path on this machine.
 */
async function handleConfig(ctx, op, payload) {
  const state = await loadState()
  if (op === 'export') {
    const body = {
      version: 1,
      groups: state.groups,
      collections: state.collections,
      presets: state.presets,
      toolDeny: state.toolDeny,
    }
    return { json: JSON.stringify(body, null, 2) }
  }
  if (op !== 'import') throw new Failure('bad-op', `unknown config op ${String(op)}`)

  const mode = payload?.mode === 'replace' ? 'replace' : 'merge'
  if (mode === 'replace' && payload?.confirm !== true) {
    throw new Failure('confirm-required', 'replacing the config overwrites groups, collections and presets; pass confirm:true')
  }
  let raw = payload?.json
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    }
    catch {
      throw new Failure('bad-json', 'that config file is not valid JSON')
    }
  }
  if (!isRecord(raw)) throw new Failure('bad-config', 'config must be an object')
  const incoming = normalizeState({
    groups: raw.groups,
    collections: raw.collections,
    presets: raw.presets,
    toolDeny: raw.toolDeny,
  })
  const next = mode === 'replace'
    ? { ...incoming, auto: state.auto }
    : mergeConfigStates(state, incoming)
  const backup = mode === 'replace' ? await backupState('config-import') : null
  await saveState(next)
  await applyStateMask(ctx, next)
  return { state: next, backup }
}

/**
 * A row is "official" when it ships with the client instead of arriving from a
 * user install: the `@deepseek-ai/*` packages and the loader's own `cordis:`
 * entries. Skills are never official — the panel only scans user roots.
 */
function isOfficial(moduleName) {
  if (typeof moduleName !== 'string') return false
  const value = moduleName.toLowerCase()
  return value.startsWith('cordis:') || value.startsWith('@deepseek-ai/')
}

async function isSelfEntry(manager, id) {
  if (typeof id !== 'string') return false
  try {
    const rows = await manager.listPlugins()
    return rows.some(row => row.entryId === id && row.moduleName === SELF_MODULE)
  }
  catch {
    return false
  }
}

async function setPluginEnabled(ctx, id, enabled) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || manager === null) throw new Failure('no-plugin-manager', 'no pluginManager service')
  // A panel that can switch itself off is a trap: the next click has nowhere to land,
  // and the user has to edit the profile by hand to get back. Refuse that one entry.
  if (enabled === false && await isSelfEntry(manager, id)) {
    throw new Failure('self-protected', 'this panel cannot disable itself')
  }
  const result = await manager.setPluginEnabled(id, enabled)
  const application = typeof result?.application === 'string' ? result.application : 'unknown'
  const ok = application !== 'failed' && application !== 'cancelled'
  return {
    id,
    ok,
    application,
    message: typeof result?.error === 'string' ? result.error : application,
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
  }
}

async function toggleOne(ctx, kind, id, enabled) {
  if (kind === 'plugin') {
    // Refuse up front with a reason the panel can print: a client-bundled UI plugin has no
    // profile row, so the write would come back as a bare "failed".
    if (enabled === false) {
      const rows = await listPlugins(ctx)
      const row = rows.find(item => item.id === id)
      if (row !== undefined && row.builtinUi === true) {
        throw new Failure('builtin-ui', `${row.moduleName} ships inside the client UI bundle; override it in the profile cordis.patch.yml instead`)
      }
    }
    return await setPluginEnabled(ctx, id, enabled)
  }
  if (kind === 'skill') return await setSkillEnabled(ctx, id, enabled)
  throw new Failure('bad-kind', `unknown kind ${String(kind)}`)
}

async function toggleMany(ctx, items, enabled) {
  const list = Array.isArray(items) ? items.slice(0, MAX_BULK) : []
  // Turning things off: client-bundled UI plugins cannot be written, so skip them instead of
  // collecting dozens of identical failures when a whole group is switched off.
  let builtin = new Set()
  if (enabled === false) {
    try {
      const snapshot = await buildSnapshot(ctx)
      builtin = new Set(snapshot.plugins.filter(row => row.builtinUi === true).map(row => row.id))
    }
    catch { /* a snapshot failure just means no skip list */ }
  }
  const results = []
  const skippedBuiltin = []
  for (const item of list) {
    const member = normalizeMember(item)
    if (member === null) {
      results.push({ id: String(item?.id ?? ''), ok: false, message: 'not a member' })
      continue
    }
    if (member.kind === 'plugin' && builtin.has(member.id)) {
      skippedBuiltin.push(member.id)
      continue
    }
    try {
      results.push(await toggleOne(ctx, member.kind, member.id, enabled))
    }
    catch (error) {
      results.push({ id: member.id, ok: false, ...failureOf(error) })
    }
    // The plugin manager persists and reloads per call; a small gap keeps the
    // loader from seeing two writes to the same layer inside one tick.
    await new Promise(done => setTimeout(done, 60))
  }
  return { enabled, results, changed: results.filter(row => row.ok).length, skippedBuiltin: skippedBuiltin.length }
}

async function thirdPartyTargets(ctx) {
  // Only plugins and skills are needed here; building the whole snapshot (bundles, history,
  // market state, tool catalogue) just to filter two lists cost a full rebuild per click.
  const roots = skillRootList(ctx)
  const profile = process.env.TOOL_HUB_PROFILE === '1'
  const startedAt = process.hrtime.bigint()
  const allRows = await pluginRows(ctx, false)
  const afterRows = process.hrtime.bigint()
  const skillRows = await listSkills(roots)
  if (profile) {
    const line = new Date().toISOString() + ' thirdparty plugins=' + (Number(afterRows - startedAt) / 1e6).toFixed(1) + ' skills=' + (Number(process.hrtime.bigint() - afterRows) / 1e6).toFixed(1) + 'ms\n'
    appendFile(join(dirname(stateFile()), 'snapshot-profile.log'), line).catch(() => {})
  }
  const plugins = allRows.filter(row => row.enabled === true
    && row.self !== true
    && row.official !== true
    && row.manageable !== false)
  // An MCP server row wears an official module name, but the server itself is whatever the user
  // configured, so it belongs to the third-party side of the line.
  const mcp = allRows.filter(row => row.enabled === true && row.mcp === true
    && row.self !== true
    && row.manageable !== false && !plugins.includes(row))
  const skills = skillRows.filter(row => row.enabled === true)
  const seen = new Set()
  const rows = []
  for (const row of [...plugins, ...mcp, ...skills]) {
    const key = `${row.kind}:${row.id}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ kind: row.kind, id: row.id, name: row.name, moduleName: row.moduleName ?? null, mcp: row.mcp === true, role: row.role ?? null })
  }
  return rows
}

function rollbackDir() {
  return join(dirname(stateFile()), 'rollback')
}

async function latestRollback() {
  let names = []
  try {
    names = await readdir(rollbackDir())
  }
  catch {
    return null
  }
  const files = names.filter(name => name.endsWith('.json')).sort()
  const last = files.pop()
  if (last === undefined) return null
  try {
    const raw = JSON.parse(await readFile(join(rollbackDir(), last), 'utf8'))
    return { file: last, ...raw }
  }
  catch {
    return null
  }
}

async function handleThirdParty(ctx, op) {
  if (op === 'status') {
    const snapshot = await latestRollback()
    return { targets: await thirdPartyTargets(ctx), snapshot }
  }
  if (op === 'off') {
    const targets = await thirdPartyTargets(ctx)
    if (targets.length === 0) return { disabled: 0, failed: 0, snapshot: null }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = `${stamp}.json`
    await mkdir(rollbackDir(), { recursive: true })
    await writeJsonAtomic(join(rollbackDir(), file), {
      version: 1,
      at: new Date().toISOString(),
      patch: patchPathFor(ctx),
      plugins: targets.filter(row => row.kind === 'plugin').map(row => row.id),
      skills: targets.filter(row => row.kind === 'skill').map(row => row.id),
    })
    const result = await toggleMany(ctx, targets, false)
    const failed = result.results.filter(row => row.ok !== true).length
    // A rollback point that restores nothing is worse than none: the panel would
    // offer "restore" for a run where every write was refused.
    if (result.changed === 0) {
      await rm(join(rollbackDir(), file), { force: true }).catch(() => {})
      return { disabled: 0, failed, snapshot: null }
    }
    return { disabled: result.changed, failed, snapshot: file }
  }
  if (op === 'restore') {
    const snapshot = await latestRollback()
    if (snapshot === null) throw new Failure('no-snapshot', 'there is no rollback point to restore')
    const items = [
      ...(Array.isArray(snapshot.plugins) ? snapshot.plugins : []).map(id => ({ kind: 'plugin', id })),
      ...(Array.isArray(snapshot.skills) ? snapshot.skills : []).map(id => ({ kind: 'skill', id })),
    ]
    const result = await toggleMany(ctx, items, true)
    return { restored: result.changed, failed: result.results.filter(row => row.ok !== true).length, snapshot: snapshot.file }
  }
  throw new Failure('bad-op', 'unknown third-party operation')
}

async function handleGroup(ctx, op, payload) {
  const state = await loadState()
  const snapshot = await buildSnapshot(ctx)
  const known = new Set([
    ...snapshot.plugins.map(row => `plugin:${row.id}`),
    ...snapshot.skills.map(row => `skill:${row.id}`),
  ])
  const cleanMembers = (members) => {
    const out = []
    const seen = new Set()
    for (const raw of Array.isArray(members) ? members : []) {
      const member = normalizeMember(raw)
      if (member === null) continue
      const key = `${member.kind}:${member.id}`
      if (seen.has(key) || !known.has(key)) continue
      seen.add(key)
      out.push(member)
    }
    return out
  }
  // Whoever a caller picks, the whole package comes along: a group never holds half of a tree
  // (`billion-context` without `billion-context/dsh-compaction-gate` would be a group that flips
  // only part of an install). Skills have no children, so they pass through untouched.
  const rootOf = new Map(snapshot.plugins.map(row => [row.id, row.root ?? row.moduleName]))
  const treeOf = new Map()
  for (const row of snapshot.plugins) {
    const root = row.root ?? row.moduleName
    const bag = treeOf.get(root) ?? []
    bag.push(row.id)
    treeOf.set(root, bag)
  }
  const withTrees = (members) => {
    const out = []
    const seen = new Set()
    for (const member of members) {
      const ids = member.kind === 'plugin' ? (treeOf.get(rootOf.get(member.id) ?? '') ?? [member.id]) : [member.id]
      for (const id of ids) {
        const key = `${member.kind}:${id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ kind: member.kind, id })
      }
    }
    return out
  }
  const cleanTags = (tags) => [...new Set((Array.isArray(tags) ? tags : [])
    .filter(tag => typeof tag === 'string' && tag.trim() !== '')
    .map(tag => tag.trim().slice(0, 24)))].slice(0, 8)
    if (op === 'reorder') {
    const order = Array.isArray(payload?.order) ? payload.order.filter(id => typeof id === 'string') : []
    const byId = new Map(state.groups.map(group => [group.id, group]))
    const next = []
    for (const id of order) {
      const group = byId.get(id)
      if (group === undefined) continue
      next.push(group)
      byId.delete(id)
    }
    // Anything the caller did not mention keeps its relative order at the end.
    for (const group of state.groups) if (byId.has(group.id)) next.push(group)
    state.groups = next
    await saveState(state)
    return { state: await loadState(), order: next.map(group => group.id) }
  }
  if (op === 'save') {
    const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 60) : ''
    if (name === '') throw new Failure('bad-name', 'a group needs a name')
    const members = withTrees(cleanMembers(payload?.members))
    const id = typeof payload?.id === 'string' ? payload.id : ''
    const loose = payload?.collection === null
    const askedCollection = typeof payload?.collection === 'string' ? payload.collection : ''
    const collection = loose ? null : state.collections.some(entry => entry.id === askedCollection) ? askedCollection : 'default'
    const existing = state.groups.find(group => group.id === id)
    if (existing !== undefined) {
      existing.name = name
      existing.members = members
      existing.role = cleanRole(payload?.role) ?? existing.role ?? null
      existing.collection = collection
      existing.tags = cleanTags(payload?.tags ?? existing.tags)
      existing.auto = false
    }
    else {
      state.groups.push({ id: `g${Date.now().toString(36)}`, name, members, role: cleanRole(payload?.role), collection, tags: cleanTags(payload?.tags), auto: false, createdAt: Date.now() })
    }
    await saveState(state)
    return { state: await loadState() }
  }
  if (op === 'move') {
    const group = state.groups.find(item => item.id === payload?.id)
    if (group === undefined) throw new Failure('no-group', 'that group no longer exists')
    const wanted = payload?.collection === null ? null : typeof payload?.collection === 'string' ? payload.collection : 'default'
    if (wanted !== null && !state.collections.some(entry => entry.id === wanted)) throw new Failure('unknown-collection', `no drawer "${wanted}"`)
    group.collection = wanted
    await saveState(state)
    return { state: await loadState(), order: state.groups.map(item => item.id) }
  }
  if (op === 'remove') {
    const group = state.groups.find(item => item.id === payload?.id)
    if (group === undefined) throw new Failure('no-group', 'that group no longer exists')
    const drop = new Set(cleanMembers(payload?.members).map(member => `${member.kind}:${member.id}`))
    const before = group.members.length
    group.members = group.members.filter(member => !drop.has(`${member.kind}:${member.id}`))
    await saveState(state)
    return { state: await loadState(), removed: before - group.members.length }
  }
  if (op === 'clean') {
    const group = state.groups.find(item => item.id === payload?.id)
    if (group === undefined) throw new Failure('no-group', 'that group no longer exists')
    const before = group.members.length
    group.members = group.members.filter(member => known.has(`${member.kind}:${member.id}`))
    await saveState(state)
    return { state: await loadState(), removed: before - group.members.length }
  }
  if (op === 'delete') {
    state.groups = state.groups.filter(group => group.id !== payload?.id)
    await saveState(state)
    return { state: await loadState() }
  }
  if (op === 'add') {
    const group = state.groups.find(item => item.id === payload?.id)
    if (group === undefined) throw new Failure('no-group', 'that group no longer exists')
    const incoming = withTrees(cleanMembers(payload?.members))
    const have = new Set(group.members.map(member => `${member.kind}:${member.id}`))
    const added = incoming.filter(member => !have.has(`${member.kind}:${member.id}`))
    group.members = [...group.members, ...added]
    await saveState(state)
    return { state: await loadState(), added: added.length }
  }
  if (op === 'toggle') {
    const group = state.groups.find(item => item.id === payload?.id)
    if (group === undefined) throw new Failure('no-group', 'that group no longer exists')
    let members = withTrees(group.members)
    const skipShared = payload?.skipShared === true
    // A plugin in two groups is still one switch. "Only the ones this group owns" means leaving
    // alone every member that another group also lists, so a bulk flip cannot quietly reach into
    // a group the user is not looking at.
    if (skipShared) {
      const elsewhere = new Set()
      for (const other of state.groups) {
        if (other.id === group.id) continue
        for (const member of other.members) elsewhere.add(`${member.kind}:${member.id}`)
      }
      members = members.filter(member => !elsewhere.has(`${member.kind}:${member.id}`))
    }
    const result = await toggleMany(ctx, members, payload?.enabled === true)
    return { group: group.name, skipped: withTrees(group.members).length - members.length, ...result }
  }
  throw new Failure('bad-op', `unknown group op ${String(op)}`)
}

async function applyPresetDeny(ctx, next) {
  const state = await loadState()
  const cleaned = [...new Set(next.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)))]
  const same = cleaned.length === state.toolDeny.length && cleaned.every((name, index) => name === state.toolDeny[index])
  if (!same) {
    state.toolDeny = cleaned
    await saveState(state)
    await applyStateMask(ctx, state)
  }
  return { denied: cleaned.length }
}

/**
 * Second pass for presets that predate `toolDeny`: their tool list is "what was on", which can
 * only be inverted against tools that exist. Called once shortly after the servers of a preset
 * were switched on, when their tools have registered.
 */
async function applyPresetToolsLater(ctx, name, mode) {
  try {
    const state = await loadState()
    const preset = state.presets.find(item => item.name === name)
    if (preset === undefined || Array.isArray(preset.toolDeny)) return
    const wanted = Array.isArray(preset.enabled.tool) ? preset.enabled.tool : null
    if (wanted === null) return
    const snapshot = await buildSnapshot(ctx)
    const known = snapshot.tools.map(row => row.name)
    if (known.length === 0) return
    const next = mode === 'exact'
      ? known.filter(tool => !wanted.includes(tool))
      : state.toolDeny.filter(tool => !wanted.includes(tool))
    await applyPresetDeny(ctx, next)
  }
  catch (error) {
    ctx.logger?.warn?.(`tool-hub: delayed preset tools pass failed: ${error?.message ?? error}`)
  }
}

async function handlePreset(ctx, op, payload) {
  const state = await loadState()
  if (op === 'save') {
    const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 60) : ''
    if (name === '') throw new Failure('bad-name', 'a preset needs a name')
    const snapshot = await buildSnapshot(ctx)
    const enabled = {
      plugin: snapshot.plugins.filter(row => row.enabled).map(row => row.id),
      skill: snapshot.skills.filter(row => row.enabled).map(row => row.id),
      tool: snapshot.tools.filter(row => row.enabled).map(row => row.name),
    }
    const existing = state.presets.find(preset => preset.name === name)
    // `tool` is the list that was on; `toolDeny` is the list that was masked. Keeping the
    // deny list makes a preset replayable while the servers it mentions are switched off —
    // at replay time their tools are simply not in the live view, so `tool` alone cannot
    // tell us what to mask.
    const recorded = {
      enabled,
      toolDeny: state.toolDeny.slice(),
    }
    if (existing !== undefined) {
      existing.enabled = recorded.enabled
      existing.toolDeny = recorded.toolDeny
      existing.createdAt = Date.now()
      existing.note = typeof payload?.note === 'string' ? payload.note : existing.note
    }
    else {
      state.presets.push({ name, enabled: recorded.enabled, toolDeny: recorded.toolDeny, note: typeof payload?.note === 'string' ? payload.note : '', createdAt: Date.now() })
    }
    await saveState(state)
    return { presets: state.presets }
  }
  if (op === 'update') {
    // Same snapshot as save, but only for a preset that already exists: the point of a separate
    // verb is that overwriting is an explicit choice, not something a typo can do.
    const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
    const preset = state.presets.find(item => item.name === name)
    if (preset === undefined) throw new Failure('no-preset', 'that preset no longer exists')
    const snapshot = await buildSnapshot(ctx)
    preset.enabled = {
      plugin: snapshot.plugins.filter(row => row.enabled).map(row => row.id),
      skill: snapshot.skills.filter(row => row.enabled).map(row => row.id),
      tool: snapshot.tools.filter(row => row.enabled).map(row => row.name),
    }
    preset.toolDeny = state.toolDeny.slice()
    preset.updatedAt = Date.now()
    await saveState(state)
    return { presets: state.presets, updated: true, name }
  }
  if (op === 'delete') {
    state.presets = state.presets.filter(preset => preset.name !== payload?.name)
    await saveState(state)
    return { presets: state.presets }
  }
  if (op === 'apply') {
    const preset = state.presets.find(item => item.name === payload?.name)
    if (preset === undefined) throw new Failure('no-preset', 'that preset no longer exists')
    const snapshot = await buildSnapshot(ctx)
    const wantPlugin = new Set(preset.enabled.plugin)
    const wantSkill = new Set(preset.enabled.skill)
    const mode = payload?.mode === 'only-enable' ? 'only-enable' : 'exact'
    const items = []
    for (const row of snapshot.plugins) {
      if (!row.manageable) continue
      // Applying a preset that predates this panel must not switch the panel off.
      if (row.moduleName === SELF_MODULE) continue
      const want = wantPlugin.has(row.id)
      if (row.enabled !== want && (mode === 'exact' || want)) items.push({ kind: 'plugin', id: row.id, enabled: want })
    }
    for (const row of snapshot.skills) {
      const want = wantSkill.has(row.id)
      if (row.enabled !== want && (mode === 'exact' || want)) items.push({ kind: 'skill', id: row.id, enabled: want })
    }
    const results = []
    for (const item of items) {
      try {
        results.push(await toggleOne(ctx, item.kind, item.id, item.enabled))
      }
      catch (error) {
        results.push({ id: item.id, ok: false, ...failureOf(error) })
      }
      await new Promise(done => setTimeout(done, 60))
    }
    // Tool masking is a fourth dimension: presets saved before 1.2.0 have no list and are
    // left alone, so an old preset never silently re-enables tools someone disabled by hand.
    //
    // The tricky case is a preset applied while the servers it mentions are switched off: the
    // live view then knows none of their tools, so complementing "what should be on" against
    // "what exists" masks nothing (and the user had to press Apply twice). A recorded deny list
    // is name-based and needs no live view, so it is used whenever the preset has one; only
    // presets predating that field fall back to the live complement, with one delayed retry
    // for the tools that appear right after the servers above are switched on.
    let tools = null
    const wanted = Array.isArray(preset.enabled.tool) ? preset.enabled.tool : null
    const recordedDeny = Array.isArray(preset.toolDeny)
      ? preset.toolDeny.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
      : null
    const known = snapshot.tools.map(row => row.name)
    let next = null
    if (recordedDeny !== null) {
      next = mode === 'exact'
        ? recordedDeny
        : state.toolDeny.filter(name => !(wanted !== null && wanted.includes(name)))
    }
    else if (wanted !== null && known.length > 0) {
      next = mode === 'exact'
        ? known.filter(name => !wanted.includes(name))
        : state.toolDeny.filter(name => !wanted.includes(name))
    }
    if (next !== null) {
      tools = await applyPresetDeny(ctx, next)
    }
    else if (wanted !== null) {
      // Nothing known yet: the servers were off. Try once more after they had time to register.
      tools = { deferred: true }
      setTimeout(() => { void applyPresetToolsLater(ctx, preset.name, mode) }, 1500)
    }
    return { preset: preset.name, requested: items.length, applied: results.filter(row => row.ok).length, results, tools }
  }
  throw new Failure('bad-op', `unknown preset op ${String(op)}`)
}

/**
 * Drawers for hand-made groups. `default` always exists and cannot be removed: a group needs a
 * home, and making the user create one before they can make a group is a worse first run.
 */
async function handleCollection(ctx, op, payload) {
  const state = await loadState()
  if (op === 'save') {
    const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 40) : ''
    if (name === '') throw new Failure('bad-name', 'a drawer needs a name')
    const asked = typeof payload?.id === 'string' ? payload.id.trim().toLowerCase() : ''
    const existing = asked === '' ? undefined : state.collections.find(entry => entry.id === asked)
    if (existing !== undefined) {
      existing.name = name
    }
    else {
      let id = asked
      if (id === '' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) id = `c${Date.now().toString(36)}`
      while (state.collections.some(entry => entry.id === id)) id = `${id}-2`
      state.collections.push({ id, name, order: state.collections.length })
    }
    await saveState(state)
    return { state: await loadState() }
  }
  if (op === 'delete') {
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (id === 'default') throw new Failure('default-collection', 'the default drawer cannot be removed')
    if (!state.collections.some(entry => entry.id === id)) throw new Failure('unknown-collection', `no drawer "${id}"`)
    state.collections = state.collections.filter(entry => entry.id !== id)
    for (const group of state.groups) if (group.collection === id) group.collection = 'default'
    await saveState(state)
    return { state: await loadState() }
  }
  throw new Failure('bad-op', `unknown collection op ${String(op)}`)
}

/**
 * Copy dshmarket's groups into ours. Read-only on their file; a group whose name is already
 * taken here is skipped rather than merged, so a second import never duplicates or reshuffles
 * groups the user may have edited since.
 */
async function handleMarket(ctx, op, payload) {
  if (op !== 'import') throw new Failure('bad-op', `unknown market op ${String(op)}`)
  const state = await loadState()
  const plugins = await listPlugins(ctx)
  const market = await readMarketGroups(ctx, plugins)
  if (market.error !== null) throw new Failure('market-unreadable', market.error)
  if (!market.available) throw new Failure('market-empty', 'dshmarket has no groups to import')
  const taken = new Set(state.groups.map(group => group.name))
  const stamp = Date.now().toString(36)
  const imported = []
  const skipped = []
  let missing = 0
  market.groups.forEach((entry, index) => {
    if (entry.members === 0) {
      skipped.push({ name: entry.name, reason: 'no-installed-members' })
      return
    }
    let name = entry.name
    if (taken.has(name)) {
      skipped.push({ name, reason: 'name-taken' })
      return
    }
    taken.add(name)
    const members = entry.ids.map(id => ({ kind: 'plugin', id }))
    state.groups.push({
      id: `m${index}-${stamp}`,
      name: name.slice(0, 40),
      members,
      auto: false,
      createdAt: Date.now(),
    })
    imported.push({ name, members: members.length, missing: entry.missing.length })
    missing += entry.missing.length
  })
  if (imported.length > 0) await saveState(state)
  return {
    imported: imported.length,
    skipped,
    missing,
    groups: imported,
    total: market.groups.length,
    file: market.file,
  }
}

async function handleTool(ctx, op, payload) {
  if (op === 'save') {
    if (!Array.isArray(payload?.deny)) throw new Failure('bad-payload', 'deny must be an array of tool names')
    const asked = payload.deny.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
    const request = [...new Set(asked)]
    const known = knownToolNames(ctx)
    if (known !== null) {
      const allowed = new Set(known)
      const unknown = request.filter(name => !allowed.has(name))
      if (unknown.length > 0) {
        throw new Failure('unknown-tool', `not an MCP tool of this host: ${unknown.slice(0, 3).join(', ')}`)
      }
    }
    const state = await loadState()
    state.toolDeny = request
    await saveState(state)
    await applyStateMask(ctx, state)
    return { deny: request }
  }
  if (op === 'import') {
    const panel = await readPanelFilter(panelFilterPath(skillRootList(ctx)))
    const known = knownToolNames(ctx)
    // The other panel keeps names it saw once; a server that is no longer configured
    // leaves a stale entry behind. Import only what this host can actually restrict.
    const usable = known === null ? panel : panel.filter(name => known.includes(name))
    const state = await loadState()
    const before = new Set(state.toolDeny)
    const merged = [...new Set([...state.toolDeny, ...usable])]
    state.toolDeny = merged
    await saveState(state)
    await applyStateMask(ctx, state)
    return { deny: merged, added: merged.filter(name => !before.has(name)).length, read: usable.length }
  }
  throw new Failure('bad-op', `unknown tool op ${String(op)}`)
}

async function handleAuto(ctx, op, payload) {
  const snapshot = await buildSnapshot(ctx)
  const plan = await buildAutoPlan(ctx, snapshot.plugins, snapshot.skills)
  if (op === 'preview') return { plan, groups: plan.length, members: plan.reduce((sum, entry) => sum + entry.members.length, 0) }
  if (op === 'apply') {
    const state = await loadState()
    // A group with an automatic id that somehow lost its auto flag is still an automatic group:
    // leaving it behind means the old taxonomy stays visible under the new one.
    const keep = state.groups.filter(group => !group.auto && !/^a\d-/.test(group.id))
    const autoGroups = plan
      .filter(entry => entry.members.length > 0)
      .map((entry, index) => ({
        id: `a${index}-${Date.now().toString(36)}`,
        name: entry.name,
        role: entry.role,
        collection: entry.collection ?? null,
        tags: entry.tags,
        members: entry.members,
        auto: true,
        createdAt: Date.now(),
      }))
    state.groups = [...keep, ...autoGroups]
    state.auto = { appliedAt: Date.now() }
    await saveState(state)
    return { state: await loadState(), groups: autoGroups.length, members: autoGroups.reduce((sum, group) => sum + group.members.length, 0) }
  }
  throw new Failure('bad-op', `unknown auto op ${String(op)}`)
}

// One transaction at a time: loadState -> mutate -> saveState is a read-modify-write,
// and an atomic rename only protects the bytes, not the read.
let stateSequence = Promise.resolve()
function withStateLock(work) {
  const next = stateSequence.then(work, work)
  stateSequence = next.then(() => undefined, () => undefined)
  return next
}

const STATE_OPS = /^(?:group|preset|collection|tool|auto|state|market)\./

async function dispatch(ctx, op, payload) {
  // A write can build a snapshot before it saves; clearing only on entry would leave that
  // pre-write copy in the cache for the refresh that follows the call.
  const cached = op !== 'snapshot' && op !== 'doctor' && op !== 'history'
  if (cached) invalidateSnapshot(true)
  const result = STATE_OPS.test(op) || op === 'bulk' || op === 'toggle'
    ? await withStateLock(() => dispatchOnce(ctx, op, payload))
    : await dispatchOnce(ctx, op, payload)
  if (cached) invalidateSnapshot(true)
  return result
}

async function dispatchOnce(ctx, op, payload) {
  // `lib/op-registry.js` is the door. Two facts live there instead of being restated in every
  // handler: whether the op exists at all, and whether it carries an unconditional confirmation
  // gate. Conditional gates (a destructive branch inside an otherwise safe op) stay in the
  // handler and are described in the entry's note.
  const entry = describeOp(op)
  if (entry === undefined) throw new Failure('bad-op', `unknown op ${String(op)}`)
  if (entry.confirm === 'reset' && payload?.confirm !== 'reset') {
    throw new Failure('confirm-required', `${String(op)} needs the literal confirmation token "reset"; pass confirm:"reset"`)
  }
  if (entry.confirm === true && payload?.confirm !== true) {
    throw new Failure('confirm-required', `${String(op)} needs confirm:true`)
  }
  switch (op) {
    case 'snapshot':
      return await buildSnapshot(ctx, { fresh: payload?.fresh === true })
    case 'toggle': {
      const enabled = payload?.enabled === true
      const result = await toggleOne(ctx, payload?.kind, String(payload?.id ?? ''), enabled)
      return result
    }
    case 'bulk':
      return await toggleMany(ctx, payload?.items, payload?.enabled === true)
    case 'group.save':
      return await handleGroup(ctx, 'save', payload)
    case 'group.delete':
      return await handleGroup(ctx, 'delete', payload)
    case 'group.toggle':
      return await handleGroup(ctx, 'toggle', payload)
    case 'group.reorder':
      return await handleGroup(ctx, 'reorder', payload)
    case 'group.move':
      return await handleGroup(ctx, 'move', payload)
    case 'group.clean':
      return await handleGroup(ctx, 'clean', payload)
    case 'group.add':
      return await handleGroup(ctx, 'add', payload)
    case 'group.remove':
      return await handleGroup(ctx, 'remove', payload)
    case 'preset.save':
      return await handlePreset(ctx, 'save', payload)
    case 'preset.delete':
      return await handlePreset(ctx, 'delete', payload)
    case 'preset.apply':
      return await handlePreset(ctx, 'apply', payload)
    case 'thirdparty.status':
  case 'thirdparty.off':
  case 'thirdparty.restore':
    return handleThirdParty(ctx, op.split('.')[1])
  case 'preset.update':
      return await handlePreset(ctx, 'update', payload)
    case 'auto.preview':
      return await handleAuto(ctx, 'preview', payload)
    case 'auto.apply':
      return await handleAuto(ctx, 'apply', payload)
    case 'market.import':
      return await handleMarket(ctx, 'import', payload)
    case 'collection.save':
      return await handleCollection(ctx, 'save', payload)
    case 'collection.delete':
      return await handleCollection(ctx, 'delete', payload)
    case 'mcp.save':
      return await handleMcp(ctx, 'save', payload)
    case 'mcp.create':
      return await handleMcp(ctx, 'create', payload)
    case 'mcp.delete':
      return await handleMcp(ctx, 'delete', payload)
    case 'mcp.probe':
      return await handleProbe(ctx, payload)
    case 'mcp.raw':
      return await handleMcpRaw(ctx, 'raw', payload)
    case 'mcp.rawSave':
      return await handleMcpRaw(ctx, 'rawSave', payload)
    case 'skill.read':
      return await handleSkill(ctx, 'read', payload)
    case 'skill.delete':
      return await handleSkill(ctx, 'delete', payload)
    case 'skill.restore':
      return await handleSkill(ctx, 'restore', payload)
    case 'skill.trash':
      return await handleSkill(ctx, 'trash', payload)
    case 'skill.import':
      return await handleSkillPack(ctx, 'import', payload)
    case 'skill.move':
      return await handleSkillPack(ctx, 'move', payload)
    case 'mcp.oauthStart':
      return await handleOauth(ctx, 'start', payload)
    case 'mcp.oauthFinish':
      return await handleOauth(ctx, 'finish', payload)
    case 'mcp.oauthCancel':
      return await handleOauth(ctx, 'cancel', payload)
    case 'doctor':
      return await handleDoctor(ctx)
    case 'config.export':
      return await handleConfig(ctx, 'export', payload)
    case 'config.import':
      return await handleConfig(ctx, 'import', payload)
    case 'tool.save':
      return await handleTool(ctx, 'save', payload)
    case 'lazy.set': {
      if (typeof payload?.server !== 'string' || payload.server.trim() === '') {
        throw new Failure('bad-payload', 'server is required')
      }
      const state = await changeLazy(ctx, { server: payload.server, on: payload.on === true })
      return { lazy: state.lazyServers, loaded: state.lazyLoaded }
    }
    case 'lazy.load':
    case 'lazy.unload': {
      const patch = { load: op === 'lazy.load' }
      if (typeof payload?.server === 'string' && payload.server.trim() !== '') patch.server = payload.server.trim()
      if (Array.isArray(payload?.names)) patch.names = payload.names
      if (patch.server === undefined && patch.names === undefined) {
        throw new Failure('bad-payload', 'pass server or names')
      }
      const state = await changeLazy(ctx, patch)
      return { lazy: state.lazyServers, loaded: state.lazyLoaded }
    }
    case 'tool.import':
      return await handleTool(ctx, 'import', payload)
    case 'session.set': {
      // One session's overlay, replaced wholesale. Unknown names are filtered later, at mask
      // time, because a tool can legitimately arrive after the user switches it on.
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (sessionId === '' || sessionId.length > 200) throw new Failure('bad-payload', 'sessionId is required (max 200 characters)')
      const state = await loadState()
      const names = Array.isArray(payload?.names) ? payload.names : []
      const deny = [...new Set(names.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)))]
      if (deny.length === 0) delete state.sessions[sessionId]
      else state.sessions[sessionId] = deny
      await saveState(state)
      await applyStateMask(ctx, state)
      return { sessionId, deny, sessions: state.sessions }
    }
    case 'session.clear': {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (sessionId === '') throw new Failure('bad-payload', 'sessionId is required')
      const state = await loadState()
      delete state.sessions[sessionId]
      await saveState(state)
      await applyStateMask(ctx, state)
      return { sessionId, sessions: state.sessions }
    }
    case 'state.reset': {
      // The `confirm:"reset"` gate is enforced once, in the dispatch header, from the registry.
      const backup = await backupState('state-reset')
      const state = emptyState()
      await saveState(state)
      await applyStateMask(ctx, state)
      return { state, backup }
    }
    default:
      throw new Failure('bad-op', `unknown op ${String(op)}`)
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Refuse a request a browser page on another origin could have made.
 *
 * `Host` is the header an attacker's page cannot forge, so it has to name
 * loopback (or nothing at all: a non-browser caller — and the Desktop shell's
 * own proxy — may drop it). A present `Origin` must agree with `Host`, and a
 * cross-site fetch is refused outright.
 */
function sameOrigin(request) {
  const host = request.headers.host
  const origin = request.headers.origin
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  if (origin === undefined) return true
  let originUrl
  try {
    originUrl = new URL(origin)
  }
  catch {
    return false
  }
  if (host === undefined) return true
  const name = host.toLowerCase().startsWith('[')
    ? host.toLowerCase().slice(0, host.indexOf(']') + 1)
    : host.toLowerCase().split(':')[0]
  const loopback = name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
  if (originUrl.host === host) return true
  if (originUrl.port === '' && loopback && originUrl.hostname === name) return true
  return false
}

/**
 * The host's own browser gate (`connection.requestRejection`, the check the
 * host's /api runs): it knows the session cookie and the remote-access policy,
 * neither of which our `sameOrigin` above can see. Resolved per request, not at
 * mount time — the service may be registered after this plugin starts.
 *
 * Returns an HTTP status (401 / 403) to refuse with, or undefined to let the
 * request through. A gate that throws refuses too: fail closed, not open.
 */
function hostRejection(ctx, request) {
  const connection = ctx.get?.('connection') ?? ctx.connection
  const gate = connection?.requestRejection
  if (typeof gate !== 'function') return undefined
  try {
    return gate.call(connection, request)
  }
  catch {
    return 403
  }
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY) throw new Failure('too-large', 'request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  catch {
    throw new Failure('bad-json', 'request body is not JSON')
  }
}

/** Register both routes; returns one disposer for the caller's effect. */
function mount(ctx) {
  const server = ctx.get('webServer')
  if (server === undefined || server === null) {
    ctx.logger?.warn?.('[tool-hub] no webServer service; the panel API is not mounted')
    return () => {}
  }
  const disposers = []

  disposers.push(server.register({
    kind: 'exact',
    path: '/tool-hub/api/snapshot',
    handler: (request, response) => {
      const rejection = hostRejection(ctx, request)
      if (rejection !== undefined) {
        sendJson(response, rejection, {
          ok: false,
          error: {
            code: rejection === 403 ? 'forbidden' : 'unauthorized',
            message: 'DSH browser authentication is required',
          },
        })
        return
      }
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: { code: 'origin', message: 'refused: cross-origin request' } })
        return
      }
      const fresh = /(?:^|[?&])fresh=1(?:&|$)/.test(`${request.url ?? ''}`)
      buildSnapshot(ctx, { fresh }).then(
        data => sendJson(response, 200, { ok: true, data }),
        error => sendJson(response, 200, { ok: false, error: failureOf(error) }),
      )
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: '/tool-hub/api/op',
    handler: (request, response) => {
      const rejection = hostRejection(ctx, request)
      if (rejection !== undefined) {
        sendJson(response, rejection, {
          ok: false,
          error: {
            code: rejection === 403 ? 'forbidden' : 'unauthorized',
            message: 'DSH browser authentication is required',
          },
        })
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: { code: 'origin', message: 'refused: cross-origin request' } })
        return
      }
      readJson(request).then(
        async (body) => {
          const op = body?.op
          const payload = body?.payload
          // Recorded before the reply goes out: an op that returned has a line on disk, so a
          // client that immediately refreshes history sees its own call.
          const record = ok => appendHistory({
            at: new Date().toISOString(),
            op: String(op ?? ''),
            detail: historyDetail(payload),
            ok,
            // Straight from the registry: a reader can filter the history down to the calls a
            // human would want to trace without knowing which ops those are.
            audit: describeOp(String(op ?? ''))?.audit === true,
          })
          try {
            const data = await dispatch(ctx, op, payload)
            await record(true)
            sendJson(response, 200, { ok: true, data })
          }
          catch (error) {
            await record(false)
            sendJson(response, 200, { ok: false, error: failureOf(error) })
          }
        },
        error => sendJson(response, 400, { ok: false, error: failureOf(error) }),
      )
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      }
      catch {
        // A route already gone is not a failure.
      }
    }
  }
}

let snapshotCache = null
let snapshotInflight = null
const SNAPSHOT_TTL_MS = 1200
// `pluginManager.listPlugins()` and `listBundles()` walk every loader entry (and every bundle's
// rows) on each call; both only change when a write happens, and every write invalidates them.
let pluginRowsCache = null
const PLUGIN_ROWS_TTL_MS = 5000
let bundlesCache = null
const BUNDLES_TTL_MS = 60_000

async function pluginRows(ctx, fresh) {
  const now = Date.now()
  if (fresh !== true && pluginRowsCache !== null && now - pluginRowsCache.at < PLUGIN_ROWS_TTL_MS) return pluginRowsCache.value
  const value = await listPlugins(ctx)
  pluginRowsCache = { at: now, value }
  return value
}

async function bundlesFor(ctx, fresh) {
  const now = Date.now()
  if (fresh !== true && bundlesCache !== null && now - bundlesCache.at < BUNDLES_TTL_MS) return bundlesCache.value
  const value = await listBundlesForSnapshot(ctx)
  bundlesCache = { at: now, value }
  return value
}

// ── plugin entry ─────────────────────────────────────────────────────────────

/** Whether `hub_tools` reached the registry; doctor reports it. */
let hubToolRegistered = false

/** The live tool mask, or null when the host never provided the services it needs. */
let toolMask = null

/**
 * Push a deny list to the live mask, mounting it on first use.
 *
 * A panel that starts with nothing denied has no mask yet; the first switch that hides a
 * tool has to build one, otherwise the change would only exist in the file.
 */
function applyDeny(ctx, deny, sessions) {
  if (toolMask === null && (deny.length > 0 || Object.keys(sessions ?? {}).length > 0)) {
    try {
      toolMask = attachToolMask(ctx, deny, sessions)
    } catch (error) {
      toolMask = null
      const logger = ctx.get('logger')
      logger?.warn?.(`[tool-hub] tool mask unavailable: ${String(error?.message ?? error)}`)
      return
    }
  }
  if (toolMask !== null) {
    // Session overlays are replaced wholesale: the state file is the truth, and a list that
    // disappeared from it must stop masking (a session the user cleared has no entry at all).
    for (const [sessionId, names] of Object.entries(sessions ?? {})) toolMask.setSessionDeny(sessionId, names)
    for (const sessionId of [...toolMask.sessionDeny.keys()]) {
      if (!Object.hasOwn(sessions ?? {}, sessionId)) toolMask.setSessionDeny(sessionId, [])
    }
    toolMask.setDeny(deny)
  }
}

/** The state the prompt section reads; kept here so the section stays a pure function. */
let lazyState = null

/**
 * Recompute the live mask from a state: explicit deny list plus every tool of a lazy
 * server the user has not loaded. Callers save first, then call this.
 */
async function applyStateMask(ctx, state) {
  const next = state ?? (await loadState())
  lazyState = next
  applyDeny(ctx, effectiveDeny(next, knownToolNames(ctx) ?? []), next.sessions)
  return next
}

/**
 * Lazily hide or unhide servers and tools, then persist. Shared by the HTTP ops and the
 * `hub_tools` tool so both paths cannot drift apart.
 */
async function changeLazy(ctx, patch) {
  const state = await loadState()
  const known = knownToolNames(ctx) ?? []
  if (typeof patch.server === 'string') {
    const server = patch.server.trim()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(server)) throw new Failure('bad-server', 'server names are letters, digits, - and _')
    const listed = lazyReport({ ...state, lazyServers: [server] }, known)[0]
    if (patch.on === true) {
      if (!state.lazyServers.includes(server)) state.lazyServers.push(server)
      // Turning lazy on hides everything that was loaded before; the user asked for the
      // server to start quiet, so the loaded set for it resets.
      state.lazyLoaded = state.lazyLoaded.filter(name => serverOf(name) !== server)
      if (listed !== undefined) state.lazyLoaded = state.lazyLoaded.filter(name => !listed.tools.includes(name))
    } else {
      state.lazyServers = state.lazyServers.filter(name => name !== server)
      if (listed !== undefined) state.lazyLoaded = [...new Set([...state.lazyLoaded, ...listed.tools])]
    }
  }
  if (Array.isArray(patch.names)) {
    const wanted = patch.names.filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
    const lazy = new Set(state.lazyServers)
    const usable = wanted.filter(name => lazy.has(serverOf(name) ?? ''))
    if (patch.load === true) state.lazyLoaded = [...new Set([...state.lazyLoaded, ...usable])]
    else state.lazyLoaded = state.lazyLoaded.filter(name => !usable.includes(name))
  }
  await saveState(state)
  await applyStateMask(ctx, state)
  return state
}

/** One `hub_tools` call: list the catalog, load names, or unload them again. */
async function hubTool(ctx, args) {
  const action = args?.action
  if (action === 'list') {
    const state = await loadState()
    const report = lazyReport(state, knownToolNames(ctx) ?? [])
    return {
      action,
      servers: report.map(row => ({
        server: row.server,
        total: row.total,
        loaded: row.loaded,
        tools: row.tools.map(name => ({ name, loaded: state.lazyLoaded.includes(name) })),
      })),
      lazy: state.lazyServers,
    }
  }
  if (action === 'enable' || action === 'disable') {
    const patch = { load: action === 'enable' }
    if (typeof args?.server === 'string' && args.server.trim() !== '') patch.server = args.server.trim()
    if (Array.isArray(args?.names)) patch.names = args.names
    const before = new Set((await loadState()).lazyLoaded)
    const state = await changeLazy(ctx, patch)
    const after = new Set(state.lazyLoaded)
    return {
      action,
      loaded: [...after].filter(name => !before.has(name)),
      unloaded: [...before].filter(name => !after.has(name)),
      total: after.size,
    }
  }
  throw new Failure('bad-action', 'action must be list, enable or disable')
}

/**
 * @param ctx - the cordis context of this plugin.
 */
export function apply(ctx) {
  // The mask has to exist before routes answer, so a tool disabled in an earlier session is
  // already hidden by the time the first agent is created.
  loadState()
    .then((state) => {
      lazyState = state
      const deny = effectiveDeny(state, knownToolNames(ctx) ?? [])
      if (deny.length === 0 && Object.keys(state.sessions ?? {}).length === 0) return
      try {
        toolMask = attachToolMask(ctx, deny, state.sessions)
      } catch (error) {
        toolMask = null
        const logger = ctx.get('logger')
        logger?.warn?.(`[tool-hub] tool mask unavailable: ${String(error?.message ?? error)}`)
      }
    })
    .catch(() => {})
  // The catalog tool is always visible: it is the only door into a hidden server, so it must
  // not be hidden by the mask it drives.
  ctx.inject(['tools'], (hostCtx) => {
    // Injected services arrive as properties on the scoped context; `get` keeps this working
    // for hosts (and probes) that only implement the lookup form.
    const registry = hostCtx.tools ?? hostCtx.get?.('tools')
    if (registry === undefined || registry === null) return
    try {
      registry.register({
        name: 'hub_tools',
        description: 'List and load lazily loaded MCP tools. Call action="list" to see the catalog, then action="enable" with names or a server to make those tools callable on the next turn.',
        parameters: {
          action: { type: 'string', required: true, enum: ['list', 'enable', 'disable'], description: 'list the catalog, or load/unload tools' },
          server: { type: 'string', description: 'MCP server name; with enable/disable it applies to every tool of that server' },
          names: { type: 'array', items: { type: 'string' }, description: 'exact tool names such as mcp__demo__alpha' },
        },
        output: {
          schema: { type: 'object', properties: {} },
          // `register()` refuses a definition without a render function; this one only has to
          // put the JSON on screen, the panel does the pretty version.
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args) => await hubTool(hostCtx, args),
      })
      hubToolRegistered = true
    } catch (error) {
      hubToolRegistered = false
      const message = `[tool-hub] hub_tools unavailable: ${String(error?.message ?? error)}`
      const logger = ctx.get('logger')
      if (typeof logger?.warn === 'function') logger.warn(message)
      else console.warn(message)
    }
  }, 'tool-hub: hub_tools')
  // One paragraph explains the hidden catalog; it renders empty (and costs nothing) until a
  // server is marked lazy.
  ctx.inject(['systemPrompt'], (hostCtx) => {
    const prompts = hostCtx.systemPrompt ?? hostCtx.get?.('systemPrompt')
    if (prompts === undefined || prompts === null) return
    try {
      prompts.section({
        name: 'tool-hub:lazy-tools',
        order: prompts.getSectionOrder('MCP_SERVERS'),
        interpolate: false,
        text: () => lazyPrompt(lazyState ?? emptyState(), knownToolNames(hostCtx) ?? []),
      })
    } catch (error) {
      const logger = ctx.get('logger')
      logger?.warn?.(`[tool-hub] lazy prompt section unavailable: ${String(error?.message ?? error)}`)
    }
  }, 'tool-hub: lazy prompt')
  ctx.inject(REQUIRED, (hostCtx) => {
    // Nothing to wait for beyond the web server: the plugin manager is read at
    // request time, so a host that never loads it still answers 200 with an
    // error payload instead of failing to mount this plugin.
    mkdir(dirname(stateFile()), { recursive: true }).catch(() => {})
    // Stamped here, not at the top of `apply()`: this callback only runs once the host has
    // resolved every name in REQUIRED, so a heartbeat means "the panel's routes are mounted",
    // which is the question `doctor` is actually asked.
    try {
      writeMountHeartbeat({ stateDir: dirname(stateFile()), injects: [...HEARTBEAT_INJECTS] })
    } catch (error) {
      const logger = ctx.get('logger')
      logger?.warn?.(`[tool-hub] mount heartbeat not written: ${String(error?.message ?? error)}`)
    }
    return mount(hostCtx)
  }, 'tool-hub: /tool-hub/api routes')
}


