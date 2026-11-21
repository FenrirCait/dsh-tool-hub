/**
 * Scene switching: the four domains a scene covers, applied as one environment and restored
 * from a snapshot.
 *
 * A scene is a saved "whole environment": which plugin and skill rows are on, which MCP tools
 * stay muted, which servers are on, and (optionally) a preset to apply first. Four rules make it
 * safe to apply:
 *
 *   - **Undefined means "leave it alone".** A missing section is not the same as an empty list:
 *     `undefined` leaves that domain untouched, `[]` clears it. Every domain uses the same rule,
 *     because a scene that silently emptied a domain on its first run is how users lose an
 *     environment without noticing.
 *   - **Intent first, then state, then the fallback.** The mode record (with a full snapshot of
 *     every domain) is written before anything changes, and a failed apply restores the snapshot.
 *     If the restore itself fails, the report says which targets are still wrong; silence there
 *     would be worse than the failure.
 *   - **Members are planned elsewhere.** Which plugin/skill row flips is `planPresetApply`'s
 *     decision - one selection rule for presets and scenes - so the caller hands the member items
 *     in as data. This module owns the order (members, then tools, then MCP), the intent record,
 *     and the report.
 *   - **Sessions are never restored.** The snapshot keeps the overlays only so a report can say
 *     what the room looked like; a scene is an installation-wide environment, and rewriting
 *     another session's overlay would surprise that session.
 *
 * The module is IO-free on purpose: every write goes through the `io` callbacks, so the whole
 * sequence - including a failure injected halfway - is testable without a host.
 */

export const SCENE_VERSION = 2

const MCP_TOOL_PREFIX = 'mcp__'
/** Names the host refuses to restrict; a scene may name any other model tool. */
const RESERVED_TOOLS = new Set(['run_code', 'tool_switch', 'tool_list', 'hub_tools'])
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
/** A member id or preset name is a label, not a document: anything longer is a mistake. */
const MAX_MEMBER_ID = 120
const MAX_PRESET_NAME = 60

function errorText(error) {
  return error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
}

/** Server names the user could mean; anything else is dropped rather than kept as a landmine. */
function serverNames(list) {
  const out = []
  for (const value of Array.isArray(list) ? list : []) {
    if (typeof value !== 'string') continue
    const name = value.trim()
    if (SERVER_NAME.test(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** Member ids from a section: strings only, trimmed, deduplicated, each at most MAX_MEMBER_ID. */
function memberIds(list) {
  const out = []
  for (const value of Array.isArray(list) ? list : []) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (id === '' || id.length > MAX_MEMBER_ID || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/** Member items as the caller planned them; junk entries are dropped, not applied. */
function memberItems(value) {
  const out = []
  for (const entry of Array.isArray(value) ? value : []) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (id === '' || out.some(item => item.id === id)) continue
    out.push({ id, enabled: entry.enabled === true })
  }
  return out
}

/**
 * A scene from whatever the caller sent, or null when it is not usable.
 *
 * Every section stays `undefined` when absent: that is the "do not touch this domain" marker.
 * A section that is present but the wrong container type makes the whole record unusable, which
 * the save path reports as "that is not a scene" instead of quietly dropping a domain.
 */
export function normalizeScene(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : ''
  if (name === '') return null
  const scene = { version: SCENE_VERSION, name }
  if (raw.tools !== undefined) {
    if (raw.tools === null || typeof raw.tools !== 'object' || Array.isArray(raw.tools)) return null
    const deny = Array.isArray(raw.tools.deny)
      ? raw.tools.deny.filter(value => typeof value === 'string' && value.trim() !== '' && !RESERVED_TOOLS.has(value))
      : []
    scene.tools = { deny: [...new Set(deny)] }
  }
  if (raw.mcp !== undefined) {
    if (raw.mcp === null || typeof raw.mcp !== 'object' || Array.isArray(raw.mcp)) return null
    scene.mcp = { off: serverNames(raw.mcp.off), on: serverNames(raw.mcp.on) }
  }
  if (raw.plugins !== undefined) {
    if (!Array.isArray(raw.plugins)) return null
    scene.plugins = memberIds(raw.plugins)
  }
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) return null
    scene.skills = memberIds(raw.skills)
  }
  if (raw.preset !== undefined) {
    if (typeof raw.preset !== 'string') return null
    const preset = raw.preset.trim().slice(0, MAX_PRESET_NAME)
    // An empty string is "no binding", which is the same as the section being absent.
    if (preset !== '') scene.preset = preset
  }
  // Read back, never decided here: only scene.lock sets a lock, but a save has to keep it.
  if (raw.locked === true) scene.locked = true
  return scene
}

/**
 * Everything an apply could change, captured before it starts.
 *
 * Member rows are captured in full, not only the ones a scene names: that is what lets an exit
 * put back the plugin someone switched on by hand while the scene was active. A row that appears
 * after the snapshot is left alone, because guessing its intended state is worse than asking.
 */
export function captureSnapshot({ toolDeny, sessions, mcpRows, memberRows, at = Date.now() } = {}) {
  const mcp = {}
  for (const row of Array.isArray(mcpRows) ? mcpRows : []) {
    const serverName = typeof row?.serverName === 'string' ? row.serverName : null
    const id = typeof row?.id === 'string' ? row.id : null
    if (serverName === null || id === null) continue
    mcp[serverName] = { id, enabled: row.disabled !== true }
  }
  const plugins = {}
  const skills = {}
  for (const row of Array.isArray(memberRows) ? memberRows : []) {
    const kind = row?.kind === 'skill' ? 'skill' : row?.kind === 'plugin' ? 'plugin' : null
    const id = typeof row?.id === 'string' ? row.id : ''
    if (kind === null || id === '') continue
    const target = kind === 'plugin' ? plugins : skills
    target[id] = row.enabled === true
  }
  const snapshot = {
    at,
    toolDeny: [...(Array.isArray(toolDeny) ? toolDeny : [])],
    sessions: { ...(sessions !== null && typeof sessions === 'object' ? sessions : {}) },
    mcp,
  }
  // A host that could not list its member rows leaves the maps off on purpose: an empty map
  // would claim "there were no rows", and the exit would then restore nothing while saying it
  // had put everything back.
  if (Array.isArray(memberRows)) {
    snapshot.plugins = plugins
    snapshot.skills = skills
  }
  return snapshot
}

/**
 * What applying a scene would do, given the snapshot the domains were read from.
 *
 * `memberPlan` carries the plugin/skill items the caller derived with `planPresetApply`; the
 * engine only decides when they run and how failures are reported. A section that is absent
 * yields `null` (untouched) whether or not the caller supplied a plan for it.
 */
export function planFromScene(scene, snapshot, options) {
  const tools = scene?.tools === undefined ? null : { deny: [...scene.tools.deny] }
  const mcp = []
  const missing = []
  const wanted = scene?.mcp
  if (wanted !== undefined) {
    for (const server of wanted.off) {
      const row = snapshot?.mcp?.[server]
      if (row === undefined) { missing.push(server); continue }
      mcp.push({ id: row.id, serverName: server, enabled: false })
    }
    for (const server of wanted.on) {
      const row = snapshot?.mcp?.[server]
      if (row === undefined) { missing.push(server); continue }
      if (mcp.some(entry => entry.serverName === server)) continue
      mcp.push({ id: row.id, serverName: server, enabled: true })
    }
  }
  const memberPlan = options?.memberPlan
  const plugins = scene?.plugins === undefined ? null : memberItems(memberPlan?.plugin)
  const skills = scene?.skills === undefined ? null : memberItems(memberPlan?.skill)
  // A listed member the snapshot does not know is reported, never invented: the rest of the
  // section still holds, so one uninstalled plugin cannot block an otherwise valid scene.
  // Without a member map there is no catalog to judge against, so nothing is called missing.
  if (snapshot?.plugins !== undefined) {
    for (const id of scene?.plugins ?? []) {
      if (snapshot.plugins[id] === undefined) missing.push('plugin:' + id)
    }
  }
  if (snapshot?.skills !== undefined) {
    for (const id of scene?.skills ?? []) {
      if (snapshot.skills[id] === undefined) missing.push('skill:' + id)
    }
  }
  const preset = typeof scene?.preset === 'string' && scene.preset !== '' ? scene.preset : null
  const presetOverridden = []
  if (preset !== null) {
    // An explicit section wins over the preset, so the plan says which domains do that.
    if (scene.plugins !== undefined) presetOverridden.push('plugins')
    if (scene.skills !== undefined) presetOverridden.push('skills')
    if (scene.tools !== undefined) presetOverridden.push('tools')
  }
  return { tools, mcp, plugins, skills, preset, presetOverridden, missing }
}

/**
 * The plan that puts everything back the way the snapshot found it.
 *
 * Members are restored from every row the snapshot saw, so a hand-flipped switch inside a scene
 * comes back too; a row the snapshot never saw is not in the list and therefore left alone.
 */
export function planFromSnapshot(snapshot) {
  const entries = map => Object.entries(map ?? {}).map(([id, enabled]) => ({ id, enabled: enabled !== false }))
  return {
    tools: { deny: [...(snapshot?.toolDeny ?? [])] },
    mcp: Object.entries(snapshot?.mcp ?? {}).map(([serverName, row]) => ({ id: row.id, serverName, enabled: row.enabled !== false })),
    plugins: entries(snapshot?.plugins),
    skills: entries(snapshot?.skills),
    preset: null,
    presetOverridden: [],
    missing: [],
  }
}

/** One member switch; a host without the port says so instead of silently doing nothing. */
async function setMember(io, kind, id, enabled) {
  if (typeof io.setMember !== 'function') throw new Error('cannot switch ' + kind + ' ' + id + ': this host has no member port')
  return await io.setMember(kind, id, enabled)
}

/**
 * Apply in the order that is cheapest-to-worst: members first (one IO per row, the likeliest to
 * fail halfway), then the single tool-surface write, then MCP last because it reloads the loader
 * and changes the tool list.
 */
async function applyPlan(plan, io, applied) {
  for (const item of plan.plugins ?? []) {
    const outcome = await setMember(io, 'plugin', item.id, item.enabled)
    applied.push(outcome?.skipped === true ? 'plugin:' + item.id + ' (skipped)' : 'plugin:' + item.id)
  }
  for (const item of plan.skills ?? []) {
    const outcome = await setMember(io, 'skill', item.id, item.enabled)
    applied.push(outcome?.skipped === true ? 'skill:' + item.id + ' (skipped)' : 'skill:' + item.id)
  }
  if (plan.tools !== null) {
    await io.setTools(plan.tools.deny)
    applied.push('tools')
  }
  for (const entry of plan.mcp) {
    const outcome = await io.setServer(entry)
    applied.push(outcome?.skipped === true ? 'mcp:' + entry.serverName + ' (skipped)' : 'mcp:' + entry.serverName)
  }
}

/**
 * Put every domain back. Best effort per target, then an honest report: a restore that half
 * worked and said "done" is the failure mode this whole function exists to avoid. A target the
 * host reports as gone counts as restored - there is nothing left to put back - and the report
 * says "(skipped)" rather than pretending it flipped.
 */
export async function restoreSnapshot(snapshot, io) {
  const results = []
  const plan = planFromSnapshot(snapshot)
  const record = (target, ok, extra) => {
    results.push(extra === undefined ? { target, ok } : { target, ok, ...extra })
  }
  for (const [kind, items] of [['plugin', plan.plugins], ['skill', plan.skills]]) {
    for (const item of items) {
      const target = kind + ':' + item.id
      try {
        const outcome = await setMember(io, kind, item.id, item.enabled)
        record(target, true, outcome?.skipped === true ? { skipped: true } : undefined)
      }
      catch (error) {
        record(target, false, { message: errorText(error) })
      }
    }
  }
  try {
    await io.setTools(plan.tools.deny)
    record('tools', true)
  }
  catch (error) {
    record('tools', false, { message: errorText(error) })
  }
  for (const entry of plan.mcp) {
    try {
      await io.setServer(entry)
      record('mcp:' + entry.serverName, true)
    }
    catch (error) {
      record('mcp:' + entry.serverName, false, { message: errorText(error) })
    }
  }
  const incomplete = results.filter(result => result.ok === false)
  return {
    ok: incomplete.length === 0,
    incomplete,
    restored: results.filter(result => result.ok).map(result => (result.skipped === true ? result.target + ' (skipped)' : result.target)),
    message: incomplete.length === 0
      ? 'restored ' + results.length + ' target(s)'
      : 'rollback incomplete — still wrong: ' + incomplete.map(result => result.target).join(', '),
  }
}

/**
 * Apply a scene, or (with `restoreOnly`) put the snapshot back.
 *
 * Order matters and is the point: record the intent, optionally apply the bound preset, then
 * change state, then fall back if anything fails. `applyPreset` is a callback rather than a flag
 * so the preset domain stays outside this module while its failure still triggers the same
 * rollback. The mode record is cleared when a restore finishes, so `scene.exit` is idempotent.
 *
 * @returns {{ok: boolean, plan: object, applied: string[], preset: unknown, error?: string, rollback?: object}}
 */
export async function runScene({ scene, snapshot, io, restoreOnly = false, memberPlan = null, applyPreset = null, now = Date.now() }) {
  const plan = restoreOnly ? planFromSnapshot(snapshot) : planFromScene(scene, snapshot, { memberPlan })
  if (restoreOnly === false) {
    await io.writeMode({ version: SCENE_VERSION, name: typeof scene?.name === 'string' ? scene.name : '', snapshot, at: now })
  }
  const applied = []
  let preset = null
  try {
    if (restoreOnly === false && typeof applyPreset === 'function') {
      const outcome = await applyPreset()
      preset = outcome?.report ?? null
      if (Array.isArray(outcome?.missing)) plan.missing.push(...outcome.missing)
    }
    await applyPlan(plan, io, applied)
  }
  catch (error) {
    const rollback = await restoreSnapshot(snapshot, io)
    try {
      await io.clearMode?.()
    }
    catch {
      /* clearing the intent record is best effort; the report below is the truth */
    }
    return { ok: false, plan, applied, preset, error: errorText(error), rollback }
  }
  if (restoreOnly === true) await io.clearMode?.()
  return { ok: true, plan, applied, preset, rollback: null }
}

function memberSummary(items) {
  const on = items.filter(item => item.enabled).length
  const off = items.length - on
  const parts = []
  if (on > 0) parts.push(on + ' on')
  if (off > 0) parts.push(off + ' off')
  return parts.join(', ')
}

/** One line for the panel and the CLI: what a scene would change, before it changes it. */
export function describePlan(plan) {
  const tools = plan?.tools === null || plan?.tools === undefined ? 'tools: untouched' : 'tools: ' + plan.tools.deny.length + ' masked'
  const parts = [tools]
  if (Array.isArray(plan?.plugins) && plan.plugins.length > 0) parts.push('plugins: ' + memberSummary(plan.plugins))
  if (Array.isArray(plan?.skills) && plan.skills.length > 0) parts.push('skills: ' + memberSummary(plan.skills))
  const off = (plan?.mcp ?? []).filter(entry => entry.enabled === false).map(entry => entry.serverName)
  const on = (plan?.mcp ?? []).filter(entry => entry.enabled === true).map(entry => entry.serverName)
  if (off.length > 0) parts.push('servers off: ' + off.join(', '))
  if (on.length > 0) parts.push('servers on: ' + on.join(', '))
  if (typeof plan?.preset === 'string' && plan.preset !== '') {
    const overridden = Array.isArray(plan.presetOverridden) ? plan.presetOverridden : []
    parts.push('preset: ' + plan.preset + (overridden.length === 0 ? '' : ' (overridden: ' + overridden.join(', ') + ')'))
  }
  if ((plan?.missing ?? []).length > 0) parts.push('missing: ' + plan.missing.join(', '))
  return parts.join(' · ')
}
