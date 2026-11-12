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
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

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
  return { version: 1, groups: [], presets: [], auto: { appliedAt: null } }
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
      state.presets.push({
        name,
        enabled: { plugin: [...new Set(plugin)], skill: [...new Set(skill)] },
        note: typeof preset.note === 'string' ? preset.note : '',
        createdAt: typeof preset.createdAt === 'number' ? preset.createdAt : Date.now(),
      })
    }
  }
  if (isRecord(raw.auto) && typeof raw.auto.appliedAt === 'number') state.auto.appliedAt = raw.auto.appliedAt
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
  for (const row of plugins) if (row.manageable) push(ruleGroupFor(row.moduleName), { kind: 'plugin', id: row.id })
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
      readOnlyReason: readOnly ?? null,
      manageable: readOnly === undefined || readOnly === null,
    }
  })
}

async function buildSnapshot(ctx) {
  const [plugins, skills] = await Promise.all([listPlugins(ctx), listSkills()])
  const state = await loadState()
  const present = new Set([...plugins.map(row => `plugin:${row.id}`), ...skills.map(row => `skill:${row.id}`)])
  const groups = state.groups.map((group) => {
    const members = group.members.filter(member => present.has(`${member.kind}:${member.id}`))
    return { ...group, members, stale: group.members.length - members.length }
  })
  return {
    plugins,
    skills,
    groups,
    presets: state.presets,
    auto: state.auto,
    paths: { home: dshHome(), state: stateFile(), skillRoots: skillRoots().map(root => root.dir) },
    limits: { bulk: MAX_BULK },
  }
}

// ── operations ───────────────────────────────────────────────────────────────

async function setPluginEnabled(ctx, id, enabled) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || manager === null) throw new Failure('no-plugin-manager', 'no pluginManager service')
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

async function handlePreset(ctx, op, payload) {
  const state = await loadState()
  if (op === 'save') {
    const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 60) : ''
    if (name === '') throw new Failure('bad-name', 'a preset needs a name')
    const snapshot = await buildSnapshot(ctx)
    const enabled = {
      plugin: snapshot.plugins.filter(row => row.enabled).map(row => row.id),
      skill: snapshot.skills.filter(row => row.enabled).map(row => row.id),
    }
    const existing = state.presets.find(preset => preset.name === name)
    if (existing !== undefined) {
      existing.enabled = enabled
      existing.createdAt = Date.now()
      existing.note = typeof payload?.note === 'string' ? payload.note : existing.note
    }
    else {
      state.presets.push({ name, enabled, note: typeof payload?.note === 'string' ? payload.note : '', createdAt: Date.now() })
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
    return { preset: preset.name, requested: items.length, applied: results.filter(row => row.ok).length, results }
  }
  throw new Failure('bad-op', `unknown preset op ${String(op)}`)
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
    case 'state.reset': {
      const state = emptyState()
      await saveState(state)
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

/**
 * @param ctx - the cordis context of this plugin.
 */
export function apply(ctx) {
  ctx.inject(REQUIRED, (hostCtx) => {
    // Nothing to wait for beyond the web server: the plugin manager is read at
    // request time, so a host that never loads it still answers 200 with an
    // error payload instead of failing to mount this plugin.
    mkdir(dirname(stateFile()), { recursive: true }).catch(() => {})
    return mount(hostCtx)
  }, 'tool-hub: /tool-hub/api routes')
}
