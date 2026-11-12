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
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { MCP_MODULE, appendMcpRow, mergeMcpRows, parseMcpRows, patchPathFor, readPatchText, removeMcpRow, replaceMcpConfig, writePatchText } from './mcp.js'
import { ProbeError, probeServer } from './probe.js'
import { MCP_TOOL_PREFIX, attachToolMask, knownToolNames, readPanelFilter, splitToolName } from './tool-filter.js'

export const name = 'dsh-tool-hub'

/** Everything this plugin needs before it can answer a request. */
const REQUIRED = ['webServer']

const DISABLED_SUFFIX = '.disabled'
const SKILL_FILE = 'SKILL.md'
const MAX_BULK = 400
const MAX_BODY = 256 * 1024

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

/**
 * Skill roots, in discovery order, with the stable label written into ids.
 *
 * Only user-level roots: a project's `.dsh/skills` belongs to one workspace,
 * and this panel is not workspace-scoped yet. A skill found somewhere else is
 * still listed by the host's own skill service — it is simply not switchable
 * from here, which the footer says instead of pretending.
 */
function skillRoots() {
  // Same idea as the state file: a sandbox can mount throwaway skill roots so
  // that flipping a skill's SKILL.md ↔ SKILL.md.disabled there does not reach
  // into the real ~/.dsh/skills the user works with.
  const override = typeof process.env.TOOL_HUB_SKILL_ROOTS === 'string' ? process.env.TOOL_HUB_SKILL_ROOTS.trim() : ''
  if (override !== '') {
    return override
      .split(sep === '\\' ? ';' : ':')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((dir, index) => ({ label: index === 0 ? 'user' : `root${index + 1}`, dir: resolve(dir) }))
  }
  return [
    { label: 'user', dir: join(dshHome(), 'skills') },
    { label: 'agents', dir: join(homedir(), '.agents', 'skills') },
  ]
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

function emptyState() {
  return { version: 1, groups: [], presets: [], toolDeny: [], auto: { appliedAt: null } }
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
  if (Array.isArray(raw.groups)) {
    const seen = new Set()
    for (const group of raw.groups) {
      if (!isRecord(group)) continue
      const name = typeof group.name === 'string' ? group.name.trim().slice(0, 60) : ''
      if (name === '' || seen.has(name)) continue
      seen.add(name)
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
        id: typeof group.id === 'string' && group.id !== '' ? group.id : `g${seen.size}`,
        name,
        members,
        auto: group.auto === true,
        createdAt: typeof group.createdAt === 'number' ? group.createdAt : Date.now(),
      })
    }
  }
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

// ── skills ───────────────────────────────────────────────────────────────────

/** A directory bundle is a skill iff it holds SKILL.md or SKILL.md.disabled. */
async function readSkillDir(abs, rootLabel, rel) {
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
  const id = `${rootLabel}|${rel.split(sep).join('/')}`
  return {
    kind: 'skill',
    id,
    name: typeof fields.name === 'string' && fields.name !== '' ? fields.name : rel.split(sep).pop(),
    title: typeof fields.name === 'string' && fields.name !== '' ? fields.name : rel.split(sep).pop(),
    description: typeof fields.description === 'string' ? fields.description : '',
    source: rootLabel,
    path: abs,
    enabled: hasOn,
    official: false,
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
      const skill = await readSkillDir(abs, root.label, childRel)
      if (skill !== null) {
        out.push(skill)
        continue
      }
      if (depth < 3) out.push(...(await scanSkillRoot(root, depth + 1, childRel)))
    }
  }
  return out
}

async function listSkills() {
  const roots = skillRoots()
  const rows = []
  for (const root of roots) {
    if (!(await exists(root.dir))) continue
    rows.push(...(await scanSkillRoot(root)))
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve a skill id back to its two on-disk names, refusing to escape a root. */
function resolveSkillPath(id) {
  const separator = id.indexOf('|')
  if (separator <= 0) return null
  const label = id.slice(0, separator)
  const rel = id.slice(separator + 1)
  const root = skillRoots().find(candidate => candidate.label === label)
  if (root === undefined) return null
  const abs = resolve(root.dir, rel)
  const guard = resolve(root.dir) + sep
  if (!abs.startsWith(guard)) return null
  return { abs, dir: dirname(abs), base: abs.split(sep).pop() }
}

async function setSkillEnabled(id, enabled) {
  const resolved = resolveSkillPath(id)
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
 * The rule table behind the Auto group button.
 *
 * First match wins, so the order here is the classification. Rules read the
 * module name an installation already carries — no network, no model, nothing
 * that can decide differently on the next run — and the same table produces
 * the same groups every time. `skills` buckets carry the root label.
 */
const RULES = [
  {
    group: '通知与集成',
    test: /notify|notification|(^|[-_/])mail|calendar|(^|[-_/])mcp|telegram|slack|webhook|(^|[-_/])hook|integration|remote-access/,
  },
  {
    group: '界面与外观',
    test: /(^|[-_/])client-ui-|(^|[-_/])ui-|[-_]ui([-_/]|$)|theme|sidebar|(^|[-_/])layout|(^|[-_/])design|market|(^|[-_/])panel|(^|[-_/])badge|status-?bar|(^|[-_/])icon|(^|[-_/])hub$/,
  },
  {
    group: '创作与媒体',
    test: /image|imagegen|video|comfy|blender|drawio|(^|[-_/])draw|univer|office|(^|[-_/])voice|speech|(^|[-_/])tts|(^|[-_/])music|canvas/,
  },
  {
    group: '检索与研究',
    test: /search|arxiv|thesis|(^|[-_/])lit|crawl|(^|[-_/])fetch|browser|vision|(^|[-_/])ocr|research|(^|[-_/])wiki|paper/,
  },
  {
    group: '开发与运维',
    test: /(^|[-_/])git|github|terminal|(^|[-_/])shell|(^|[-_/])code|(^|[-_/])lint|(^|[-_/])test|deploy|(^|[-_/])cli|doctor/,
  },
  {
    // Everything the host ships lives here: it is the layer an installation
    // must keep on, so an unmatched core module belongs to it, not to "other".
    group: '基础功能',
    test: /^(?:@deepseek-ai\/)?(?:dsh|cordis)[-_/]|billion-context|(^|[-_/])context$|plugin-manager/,
  },
]

const SKILL_GROUP = { user: '技能 · 用户', agents: '技能 · 共享' }
const OTHER_GROUP = '其他'

function ruleGroupFor(moduleName) {
  const value = moduleName.toLowerCase()
  for (const rule of RULES) {
    if (rule.test.test(value)) return rule.group
  }
  return OTHER_GROUP
}

function skillGroupFor(source) {
  return SKILL_GROUP[source] ?? `技能 · ${source}`
}

/**
 * Build the plan the Auto group button previews: one bucket per group name,
 * members in listing order, and the count of rows this would move.
 */
async function buildAutoPlan(plugins, skills) {
  const buckets = new Map()
  const push = (group, member) => {
    const list = buckets.get(group) ?? []
    list.push(member)
    buckets.set(group, list)
  }
  for (const row of plugins) if (row.manageable && row.mcp !== true) push(ruleGroupFor(row.moduleName), { kind: 'plugin', id: row.id })
  for (const row of skills) push(skillGroupFor(row.source), { kind: 'skill', id: row.id })
  const order = [...RULES.map(rule => rule.group), ...Object.values(SKILL_GROUP), OTHER_GROUP]
  return order
    .filter(group => buckets.has(group))
    .map(group => ({ name: group, members: buckets.get(group) }))
}

// ── inventory ────────────────────────────────────────────────────────────────

async function listPlugins(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || manager === null) {
    throw new Failure('no-plugin-manager', 'this host exposes no pluginManager service, so plugins cannot be listed')
  }
  const rows = await manager.listPlugins()
  return rows.map((row) => {
    const meta = isRecord(row.meta) ? row.meta : {}
    const moduleName = typeof row.moduleName === 'string' ? row.moduleName : row.entryId
    const readOnly = row.readOnlyReason
    return {
      kind: 'plugin',
      id: row.entryId,
      name: typeof meta.title === 'string' && meta.title !== '' ? meta.title : moduleName,
      moduleName,
      description: typeof meta.description === 'string' ? meta.description : '',
      enabled: row.enabled === true,
      phase: row.fiberPhase ?? null,
      patchId: typeof row.patchId === 'string' ? row.patchId : null,
      readOnlyReason: readOnly ?? null,
      manageable: readOnly === undefined || readOnly === null,
      mcp: moduleName === MCP_MODULE,
      self: moduleName === SELF_MODULE,
      official: isOfficial(moduleName),
    }
  })
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
    return {
      ...row,
      name: match.name,
      mcp: true,
      mcpPatchId: match.patchId,
      mcpEditable: match.manageable && patchIds.has(match.patchId),
      transport: match.transport,
      command: match.command,
      url: match.url,
      config: match.config,
    }
  })
  const orphans = mcp.filter(row => row.entryId === null).map(row => ({
    kind: 'plugin',
    id: row.id,
    name: row.name,
    moduleName: MCP_MODULE,
    description: '',
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
    config: row.config,
    self: false,
    official: true,
  }))
  return { rows: [...merged, ...orphans], patchPath, error: null }
}

/**
 * Where dsh-skill-mcp-panel keeps its own deny list (read-only for us).
 *
 * It sits under the first skill root, so an isolated install (TOOL_HUB_SKILL_ROOTS) reads its
 * own tree instead of the machine-wide one.
 */
function panelFilterPath() {
  const root = skillRoots()[0]
  const base = root === undefined ? join(dshHome(), 'skills') : root.dir
  return join(base, '.system', 'skill-viewer', 'tool-filter.json')
}

/**
 * List the MCP tools the host currently exposes.
 *
 * `known` is false when the tools service cannot answer (early boot, or a host without
 * it); the panel then shows the saved deny list without claiming to know the live set.
 */
async function listTools(ctx, deny) {
  const denied = new Set(deny)
  const panelDeny = await readPanelFilter(panelFilterPath())
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

async function buildSnapshot(ctx) {
  const [plugins, skills] = await Promise.all([listPlugins(ctx), listSkills()])
  const mcp = await decorateMcp(ctx, plugins)
  const merged = mcp.rows
  const state = await loadState()
  const toolInfo = await listTools(ctx, state.toolDeny)
  const marketInfo = await readMarketGroups(ctx, merged)
  const compat = panelOf(merged)
  const present = new Set([...merged.map(row => `plugin:${row.id}`), ...skills.map(row => `skill:${row.id}`)])
  const groups = state.groups.map((group) => {
    const members = group.members.filter(member => present.has(`${member.kind}:${member.id}`))
    return { ...group, members, stale: group.members.length - members.length }
  })
  return {
    plugins: merged,
    skills,
    groups,
    presets: state.presets,
    auto: state.auto,
    tools: toolInfo.rows,
    toolMask: toolMask === null ? null : toolMask.info(),
    toolsKnown: toolInfo.known,
    panelDeny: toolInfo.panelDeny,
    market: marketInfo,
    compat: { ...compat, active: compat.present && compat.enabled, lock: patchPathFor(ctx) === null ? null : `${patchPathFor(ctx)}.panel.lock` },
    paths: {
      home: dshHome(),
      state: stateFile(),
      skillRoots: skillRoots().map(root => root.dir),
      patch: mcp.patchPath,
      panelFilter: panelFilterPath(),
      marketState: marketInfo.file,
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
 * Keep only the config keys this panel understands and coerce them to the shape
 * the host's MCP client expects. Anything unknown is dropped, `null` means delete.
 */
function cleanMcpConfig(asked) {
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
  for (const key of ['env', 'headers']) {
    const value = asked[key]
    if (value === null) out[key] = null
    else if (isRecord(value)) {
      const pairs = {}
      for (const [name, item] of Object.entries(value)) if (typeof item === 'string') pairs[name] = item
      out[key] = pairs
    }
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
  const started = Date.now()
  for (;;) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`)
      await handle.close()
      return file
    }
    catch (error) {
      if (error?.code !== 'EEXIST') throw new Failure('lock-failed', `cannot take ${file}: ${error?.message ?? error}`)
      let info = null
      try {
        info = await stat(file)
      }
      catch {
        continue
      }
      // The other panel treats a lock older than 30s as abandoned; do the same so a
      // crashed writer cannot wedge every later save.
      if (Date.now() - info.mtimeMs > PANEL_LOCK_STALE_MS) {
        await rm(file, { force: true })
        continue
      }
      if (Date.now() - started > PANEL_LOCK_TIMEOUT_MS) {
        throw new Failure('lock-timeout', `another writer holds ${file}`)
      }
      await new Promise(resolve => setTimeout(resolve, 120))
    }
  }
}

async function withPanelLock(patch, work) {
  const file = await acquirePanelLock(patch)
  try {
    return await work()
  }
  finally {
    await rm(file, { force: true })
  }
}

async function handleMcp(ctx, op, payload) {
  const patch = patchPathFor(ctx)
  if (patch === null) throw new Failure('no-patch', 'this profile has no cordis.patch.yml to edit')
  const text = await readPatchText(patch)
  const compat = panelOf(await listPlugins(ctx))
  const write = next => (compat.present && compat.enabled)
    ? withPanelLock(patch, () => writePatchText(patch, next))
    : writePatchText(patch, next)

  if (op === 'delete') {
    const id = String(payload?.id ?? '')
    if (!/^[A-Za-z0-9._:@/-]{1,120}$/.test(id)) throw new Failure('bad-id', 'mcp row id cannot be used')
    if (!parseMcpRows(text).some(item => item.id === id)) throw new Failure('unknown-mcp', `no MCP server "${id}" in the profile patch`)
    await write(removeMcpRow(text, id))
    return { ok: true, id, patch, route: 'hmr', removed: true }
  }

  const asked = payload?.config
  if (!isRecord(asked)) throw new Failure('bad-config', 'config must be an object')
  const cleaned = cleanMcpConfig(asked)

  if (op === 'create') {
    const name = typeof cleaned.serverName === 'string' ? cleaned.serverName : ''
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Failure('bad-name', 'server name must be 1-32 letters, digits, - or _')
    const rows = parseMcpRows(text)
    if (rows.some(item => item.config.serverName === name)) throw new Failure('duplicate-mcp', `an MCP server named "${name}" already exists`)
    const ids = new Set(rows.map(item => item.id))
    let id = `tool-hub-mcp-${name}`
    let suffix = 1
    while (ids.has(id)) {
      suffix += 1
      id = `tool-hub-mcp-${name}-${suffix}`
    }
    await write(appendMcpRow(text, id, cleaned, true))
    return { ok: true, id, patch, route: 'hmr', config: cleaned, created: true }
  }

  if (op !== 'save') throw new Failure('bad-op', `unknown mcp op ${String(op)}`)
  const id = String(payload?.id ?? '')
  if (!/^[A-Za-z0-9._:@/-]{1,120}$/.test(id)) throw new Failure('bad-id', 'mcp row id cannot be used')
  const row = parseMcpRows(text).find(item => item.id === id)
  if (row === undefined) throw new Failure('unknown-mcp', `no MCP server "${id}" in the profile patch`)
  const config = { ...row.config }
  for (const [key, value] of Object.entries(cleaned)) {
    if (value === null) delete config[key]
    else config[key] = value
  }
  await write(replaceMcpConfig(text, id, config))
  return { ok: true, id, patch, route: 'hmr', config }
}

/**
 * "Test connection" runs a throwaway MCP client: initialize -> tools/list, then
 * the process is killed. Nothing is registered, nothing is written. A draft
 * (`config`) is merged over the stored row (`id`) so the dialog can test edits
 * that are not saved yet.
 */
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
    const cleaned = cleanMcpConfig(payload.config)
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
  if (kind === 'plugin') return await setPluginEnabled(ctx, id, enabled)
  if (kind === 'skill') return await setSkillEnabled(id, enabled)
  throw new Failure('bad-kind', `unknown kind ${String(kind)}`)
}

async function toggleMany(ctx, items, enabled) {
  const list = Array.isArray(items) ? items.slice(0, MAX_BULK) : []
  const results = []
  for (const item of list) {
    const member = normalizeMember(item)
    if (member === null) {
      results.push({ id: String(item?.id ?? ''), ok: false, message: 'not a member' })
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
  return { enabled, results, changed: results.filter(row => row.ok).length }
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
  if (op === 'save') {
    const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 60) : ''
    if (name === '') throw new Failure('bad-name', 'a group needs a name')
    const members = cleanMembers(payload?.members)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    const existing = state.groups.find(group => group.id === id)
    if (existing !== undefined) {
      existing.name = name
      existing.members = members
      existing.auto = false
    }
    else {
      state.groups.push({ id: `g${Date.now().toString(36)}`, name, members, auto: false, createdAt: Date.now() })
    }
    await saveState(state)
    return { state: await loadState() }
  }
  if (op === 'delete') {
    state.groups = state.groups.filter(group => group.id !== payload?.id)
    await saveState(state)
    return { state: await loadState() }
  }
  if (op === 'toggle') {
    const group = state.groups.find(item => item.id === payload?.id)
    if (group === undefined) throw new Failure('no-group', 'that group no longer exists')
    const result = await toggleMany(ctx, group.members, payload?.enabled === true)
    return { group: group.name, ...result }
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
    applyDeny(ctx, cleaned)
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
    applyDeny(ctx, request)
    return { deny: request }
  }
  if (op === 'import') {
    const panel = await readPanelFilter(panelFilterPath())
    const known = knownToolNames(ctx)
    // The other panel keeps names it saw once; a server that is no longer configured
    // leaves a stale entry behind. Import only what this host can actually restrict.
    const usable = known === null ? panel : panel.filter(name => known.includes(name))
    const state = await loadState()
    const before = new Set(state.toolDeny)
    const merged = [...new Set([...state.toolDeny, ...usable])]
    state.toolDeny = merged
    await saveState(state)
    applyDeny(ctx, merged)
    return { deny: merged, added: merged.filter(name => !before.has(name)).length, read: usable.length }
  }
  throw new Failure('bad-op', `unknown tool op ${String(op)}`)
}

async function handleAuto(ctx, op, payload) {
  const snapshot = await buildSnapshot(ctx)
  const plan = await buildAutoPlan(snapshot.plugins, snapshot.skills)
  if (op === 'preview') return { plan, groups: plan.length, members: plan.reduce((sum, entry) => sum + entry.members.length, 0) }
  if (op === 'apply') {
    const state = await loadState()
    const keep = state.groups.filter(group => !group.auto)
    const autoGroups = plan
      .filter(entry => entry.members.length > 0)
      .map((entry, index) => ({
        id: `a${index}-${Date.now().toString(36)}`,
        name: entry.name,
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

async function dispatch(ctx, op, payload) {
  switch (op) {
    case 'snapshot':
      return await buildSnapshot(ctx)
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
    case 'preset.save':
      return await handlePreset(ctx, 'save', payload)
    case 'preset.delete':
      return await handlePreset(ctx, 'delete', payload)
    case 'preset.apply':
      return await handlePreset(ctx, 'apply', payload)
    case 'auto.preview':
      return await handleAuto(ctx, 'preview', payload)
    case 'auto.apply':
      return await handleAuto(ctx, 'apply', payload)
    case 'market.import':
      return await handleMarket(ctx, 'import', payload)
    case 'mcp.save':
      return await handleMcp(ctx, 'save', payload)
    case 'mcp.create':
      return await handleMcp(ctx, 'create', payload)
    case 'mcp.delete':
      return await handleMcp(ctx, 'delete', payload)
    case 'mcp.probe':
      return await handleProbe(ctx, payload)
    case 'tool.save':
      return await handleTool(ctx, 'save', payload)
    case 'tool.import':
      return await handleTool(ctx, 'import', payload)
    case 'state.reset': {
      const state = emptyState()
      await saveState(state)
      applyDeny(ctx, [])
      return { state }
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
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: { code: 'origin', message: 'refused: cross-origin request' } })
        return
      }
      buildSnapshot(ctx).then(
        data => sendJson(response, 200, { ok: true, data }),
        error => sendJson(response, 200, { ok: false, error: failureOf(error) }),
      )
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: '/tool-hub/api/op',
    handler: (request, response) => {
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
        body => dispatch(ctx, body?.op, body?.payload).then(
          data => sendJson(response, 200, { ok: true, data }),
          error => sendJson(response, 200, { ok: false, error: failureOf(error) }),
        ),
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

// ── plugin entry ─────────────────────────────────────────────────────────────

/** The live tool mask, or null when the host never provided the services it needs. */
let toolMask = null

/**
 * Push a deny list to the live mask, mounting it on first use.
 *
 * A panel that starts with nothing denied has no mask yet; the first switch that hides a
 * tool has to build one, otherwise the change would only exist in the file.
 */
function applyDeny(ctx, deny) {
  if (toolMask === null && deny.length > 0) {
    try {
      toolMask = attachToolMask(ctx, deny)
    } catch (error) {
      toolMask = null
      const logger = ctx.get('logger')
      logger?.warn?.(`[tool-hub] tool mask unavailable: ${String(error?.message ?? error)}`)
      return
    }
  }
  if (toolMask !== null) toolMask.setDeny(deny)
}

/**
 * @param ctx - the cordis context of this plugin.
 */
export function apply(ctx) {
  // The mask has to exist before routes answer, so a tool disabled in an earlier session is
  // already hidden by the time the first agent is created.
  loadState()
    .then((state) => {
      if (state.toolDeny.length === 0) return
      try {
        toolMask = attachToolMask(ctx, state.toolDeny)
      } catch (error) {
        toolMask = null
        const logger = ctx.get('logger')
        logger?.warn?.(`[tool-hub] tool mask unavailable: ${String(error?.message ?? error)}`)
      }
    })
    .catch(() => {})
  ctx.inject(REQUIRED, (hostCtx) => {
    // Nothing to wait for beyond the web server: the plugin manager is read at
    // request time, so a host that never loads it still answers 200 with an
    // error payload instead of failing to mount this plugin.
    mkdir(dirname(stateFile()), { recursive: true }).catch(() => {})
    return mount(hostCtx)
  }, 'tool-hub: /tool-hub/api routes')
}
