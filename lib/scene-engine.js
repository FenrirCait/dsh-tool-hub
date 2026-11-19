/**
 * Scene switching for the two domains this plugin actually owns: tool masking and MCP servers.
 *
 * A scene is a saved "whole environment": which MCP tools stay muted, and which servers are on.
 * Two rules make it safe to apply:
 *
 *   - **Empty means "leave it alone".** A missing `tools` or `mcp` section is not the same as an
 *     empty list: `undefined` leaves that domain untouched, `[]` clears it. Both domains use the
 *     same rule, because a scene that silently emptied a domain on its first run is how users
 *     lose an environment without noticing.
 *   - **Intent first, then state, then the fallback.** The mode record (with a full snapshot of
 *     both domains) is written before anything changes, and a failed apply restores the snapshot.
 *     If the restore itself fails, the report says which targets are still wrong; silence there
 *     would be worse than the failure.
 *
 * The module is IO-free on purpose: every write goes through the `io` callbacks, so the whole
 * sequence — including a failure injected halfway — is testable without a host.
 */

export const SCENE_VERSION = 1

const MCP_TOOL_PREFIX = 'mcp__'
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

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

/**
 * A scene from whatever the caller sent, or null when it is not usable.
 * `tools` / `mcp` stay `undefined` when absent: that is the "do not touch this domain" marker.
 */
export function normalizeScene(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : ''
  if (name === '') return null
  const scene = { version: SCENE_VERSION, name }
  if (raw.tools !== undefined) {
    if (raw.tools === null || typeof raw.tools !== 'object' || Array.isArray(raw.tools)) return null
    const deny = Array.isArray(raw.tools.deny)
      ? raw.tools.deny.filter(value => typeof value === 'string' && value.startsWith(MCP_TOOL_PREFIX))
      : []
    scene.tools = { deny: [...new Set(deny)] }
  }
  if (raw.mcp !== undefined) {
    if (raw.mcp === null || typeof raw.mcp !== 'object' || Array.isArray(raw.mcp)) return null
    scene.mcp = { off: serverNames(raw.mcp.off), on: serverNames(raw.mcp.on) }
  }
  return scene
}

/** Everything an apply could change, captured before it starts. */
export function captureSnapshot({ toolDeny, sessions, mcpRows, at = Date.now() } = {}) {
  const mcp = {}
  for (const row of Array.isArray(mcpRows) ? mcpRows : []) {
    const serverName = typeof row?.serverName === 'string' ? row.serverName : null
    const id = typeof row?.id === 'string' ? row.id : null
    if (serverName === null || id === null) continue
    mcp[serverName] = { id, enabled: row.disabled !== true }
  }
  return {
    at,
    toolDeny: [...(Array.isArray(toolDeny) ? toolDeny : [])],
    sessions: { ...(sessions !== null && typeof sessions === 'object' ? sessions : {}) },
    mcp,
  }
}

/** What applying a scene would do, given the snapshot the servers were read from. */
export function planFromScene(scene, snapshot) {
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
  return { tools, mcp, missing }
}

/** The plan that puts everything back the way the snapshot found it. */
export function planFromSnapshot(snapshot) {
  return {
    tools: { deny: [...(snapshot?.toolDeny ?? [])] },
    mcp: Object.entries(snapshot?.mcp ?? {}).map(([serverName, row]) => ({ id: row.id, serverName, enabled: row.enabled !== false })),
    missing: [],
  }
}

async function applyPlan(plan, io, applied) {
  if (plan.tools !== null) {
    await io.setTools(plan.tools.deny)
    applied.push('tools')
  }
  for (const entry of plan.mcp) {
    const outcome = await io.setServer(entry)
    applied.push(outcome?.skipped === true ? `mcp:${entry.serverName} (skipped)` : `mcp:${entry.serverName}`)
  }
}

/**
 * Put both domains back. Best effort per target, then an honest report: a restore that half
 * worked and said "done" is the failure mode this whole function exists to avoid.
 */
export async function restoreSnapshot(snapshot, io) {
  const results = []
  const plan = planFromSnapshot(snapshot)
  try {
    await io.setTools(plan.tools.deny)
    results.push({ target: 'tools', ok: true })
  } catch (error) {
    results.push({ target: 'tools', ok: false, message: errorText(error) })
  }
  for (const entry of plan.mcp) {
    try {
      await io.setServer(entry)
      results.push({ target: `mcp:${entry.serverName}`, ok: true })
    } catch (error) {
      results.push({ target: `mcp:${entry.serverName}`, ok: false, message: errorText(error) })
    }
  }
  const incomplete = results.filter(result => result.ok === false)
  return {
    ok: incomplete.length === 0,
    incomplete,
    restored: results.filter(result => result.ok).map(result => result.target),
    message: incomplete.length === 0
      ? `restored ${results.length} target(s)`
      : `rollback incomplete — still wrong: ${incomplete.map(result => result.target).join(', ')}`,
  }
}

/**
 * Apply a scene, or (with `restoreOnly`) put the snapshot back.
 *
 * Order matters and is the point: record the intent, then change state, then fall back if the
 * change fails. The mode record is cleared when a restore finishes, so `scene.exit` is idempotent.
 *
 * @returns {{ok: boolean, plan: object, applied: string[], error?: string, rollback?: object}}
 */
export async function runScene({ scene, snapshot, io, restoreOnly = false, now = Date.now() }) {
  const plan = restoreOnly ? planFromSnapshot(snapshot) : planFromScene(scene, snapshot)
  if (restoreOnly === false) {
    await io.writeMode({ version: SCENE_VERSION, name: typeof scene?.name === 'string' ? scene.name : '', snapshot, at: now })
  }
  const applied = []
  try {
    await applyPlan(plan, io, applied)
  } catch (error) {
    const rollback = await restoreSnapshot(snapshot, io)
    try {
      await io.clearMode?.()
    } catch {
      /* clearing the intent record is best effort; the report below is the truth */
    }
    return { ok: false, plan, applied, error: errorText(error), rollback }
  }
  if (restoreOnly === true) await io.clearMode?.()
  return { ok: true, plan, applied, rollback: null }
}

/** One line for the panel and the CLI: what a scene would change, before it changes it. */
export function describePlan(plan) {
  const tools = plan?.tools === null ? 'tools: untouched' : `tools: ${plan?.tools?.deny?.length ?? 0} masked`
  const off = (plan?.mcp ?? []).filter(entry => entry.enabled === false).map(entry => entry.serverName)
  const on = (plan?.mcp ?? []).filter(entry => entry.enabled === true).map(entry => entry.serverName)
  const parts = [tools]
  if (off.length > 0) parts.push(`servers off: ${off.join(', ')}`)
  if (on.length > 0) parts.push(`servers on: ${on.join(', ')}`)
  if ((plan?.missing ?? []).length > 0) parts.push(`missing: ${plan.missing.join(', ')}`)
  return parts.join(' · ')
}
