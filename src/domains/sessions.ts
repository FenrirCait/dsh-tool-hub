/**
 * Session overlays: one list of masked tools per session, inherited by its descendants.
 *
 * A session's overlay is separate from the installation deny list on purpose. The installation
 * list applies everywhere; an overlay applies to the session that switched something off and to
 * every session below it, which is how a subagent inherits the mask its parent chose.
 *
 * Lineage is host data and is therefore untrusted in shape: it is walked with a depth cap of 8
 * and a visited set, so a cycle a host (or a hand-edited file) produces can neither loop nor
 * grow the chain. The union is nearest-first, so a duplicate name is attributed to the closest
 * session that denied it.
 *
 * Failure contract: op failures throw a coded DomainFailure (see tool-surface.ts); resolved
 * masks are structured results.
 */
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { StateV2 } from '../core/state.js'
import {
  applySurface,
  asRecord,
  asStringList,
  fail,
  MAX_LINEAGE_DEPTH,
  unionNames,
  type SurfaceApplyResult,
} from './tool-surface.js'

export { MAX_LINEAGE_DEPTH }

/** Longest session id the state file will accept; the host owns the real shape. */
const MAX_SESSION_ID = 200

/** Parent lookup the caller supplies; undefined means "no parent". */
export type ParentOf = (sessionId: string) => string | undefined

/**
 * Ancestor session ids, nearest first, starting with the session itself.
 *
 * Depth-capped and cycle-safe: a chain longer than the cap is cut at the cap, and a cycle ends
 * the walk instead of repeating ids
 */
export function lineageOf(sessionId: string | undefined, parentOf: ParentOf, maxDepth = MAX_LINEAGE_DEPTH): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let current = typeof sessionId === 'string' ? sessionId.trim() : ''
  while (current !== '' && !seen.has(current) && chain.length < maxDepth) {
    seen.add(current)
    chain.push(current)
    current = parentOf(current)?.trim() ?? ''
  }
  return chain
}

/** Union of the overlays of one lineage, nearest first; only MCP names survive. */
export function overlayFor(lineage: readonly string[], overlays: Record<string, string[] | undefined>): string[] {
  return unionNames(lineage.map(sessionId => overlays[sessionId] ?? []))
}

/** The overlay one session lives under, already unioned over its lineage. */
export function overlayForSession(state: StateV2, sessionId: string, parentOf: ParentOf): string[] {
  return overlayFor(lineageOf(sessionId, parentOf), state.sessions)
}

/**
 * Resolve the parent lookup from the host. Two shapes are accepted because the field moved
 * between host generations; a missing service simply means "no inheritance", which is the
 * pre-overlay behaviour.
 */
export function resolveParentOf(services: { get(name: string): unknown }): ParentOf {
  const raw = services.get('toolHub.lineage')
  if (raw === null || typeof raw !== 'object') return () => undefined
  const port = raw as { parentOf?: unknown }
  if (typeof port.parentOf !== 'function') return () => undefined
  const parentOf = port.parentOf as (id: string) => unknown
  return sessionId => {
    const parent = parentOf(sessionId)
    return typeof parent === 'string' && parent.trim() !== '' ? parent.trim() : undefined
  }
}

/** Payload validation shared by the two mutating ops. */
function requireSessionId(payload: unknown, optional = false): string {
  const body = asRecord(payload)
  const raw = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (raw === '' && optional) return ''
  if (raw === '') throw fail('bad-payload', 'sessionId is required')
  if (raw.length > MAX_SESSION_ID) throw fail('bad-payload', 'sessionId is required (max ' + MAX_SESSION_ID + ' characters)')
  return raw
}

async function maskAfter(state: StateV2, env: HostEnv, sessionId: string): Promise<SurfaceApplyResult> {
  // The installation mask goes through the port; the session's own switches are an overlay the
  // per-agent mask owns, so they must not be folded into the global deny list.
  const mask = env.services.get('toolHub.mask') as {
    setSessionDeny?: (id: string, names: string[]) => void
    setSessionAllow?: (id: string, names: string[]) => void
  } | undefined
  const result = await applySurface({ state, services: env.services })
  mask?.setSessionDeny?.(sessionId, state.sessions[sessionId] ?? [])
  mask?.setSessionAllow?.(sessionId, state.sessionAllow[sessionId] ?? [])
  if (!result.ok) env.log('warn', '[tool-hub] session mask refused: ' + (result.message ?? result.status))
  return result
}

const sessionSet: OpHandler = async (payload, env) => {
  // One session's overlay, replaced wholesale. Unknown names are filtered later, at mask time,
  // because a tool can legitimately arrive after the user switched it on.
  const sessionId = requireSessionId(payload)
  const body = asRecord(payload)
  const deny = unionNames([asStringList(body.names)])
  if (deny.length === 0) delete env.state.sessions[sessionId]
  else env.state.sessions[sessionId] = deny
  const backup = await env.save('session-set')
  return { sessionId, deny, backup, sessions: env.state.sessions, mask: await maskAfter(env.state, env, sessionId) }
}

const sessionClear: OpHandler = async (payload, env) => {
  const sessionId = requireSessionId(payload)
  delete env.state.sessions[sessionId]
  const backup = await env.save('session-clear')
  return { sessionId, backup, sessions: env.state.sessions, mask: await maskAfter(env.state, env, sessionId) }
}

const sessionLineage: OpHandler = async (payload, env) => {
  const sessionId = requireSessionId(payload, true)
  if (sessionId === '') {
    return {
      sessions: env.state.sessions,
      count: Object.keys(env.state.sessions).length,
    }
  }
  const parentOf = resolveParentOf(env.services)
  const lineage = lineageOf(sessionId, parentOf)
  return {
    sessionId,
    lineage,
    deny: overlayFor(lineage, env.state.sessions),
    allow: overlayFor(lineage, env.state.sessionAllow),
    sessions: env.state.sessions,
    sessionAllow: env.state.sessionAllow,
  }
}


// ── G5: one switch engine for /tools, tool_switch and the dock ───────────────

export type SwitchAction = 'list' | 'off' | 'on' | 'reset'

export interface SwitchCounts {
  total: number
  enabled: number
  disabled: number
  fixed: number
}

const RESERVED_SWITCH = new Set(['run_code', 'tool_switch', 'tool_list', 'hub_tools'])

interface ToolView {
  known: string[]
  restrictable: Set<string>
}

function toolViewOf(env: HostEnv): ToolView {
  try {
    const tools = env.services.get('tools') as { view?: (scope?: unknown) => unknown } | undefined
    const view = tools?.view?.(undefined)
    const record = asRecord(view)
    const known = asStringList(record.knownNames)
    const restrictable = new Set(asStringList(record.restrictableNames))
    return { known, restrictable }
  }
  catch {
    return { known: [], restrictable: new Set() }
  }
}

function groupTargets(state: StateV2): Array<{ name: string; tools: string[] }> {
  const out: Array<{ name: string; tools: string[] }> = []
  for (const raw of Array.isArray(state.groups) ? state.groups : []) {
    const group = asRecord(raw)
    const name = typeof group.name === 'string' ? group.name : ''
    if (name === '') continue
    out.push({ name, tools: asStringList(group.tools) })
  }
  return out
}

/** all/全部 → exact name → group name (case-insensitive) → prefix; any unknown part fails the whole call. */
export function resolveSwitchTargets(
  known: readonly string[],
  restrictable: ReadonlySet<string>,
  groups: ReadonlyArray<{ name: string; tools: string[] }>,
  needle: string,
): { names: string[]; label: string } | { error: string } {
  const wanted = needle.trim()
  const usable = known.filter(name => restrictable.has(name) && !RESERVED_SWITCH.has(name))
  if (wanted === '' || wanted.toLowerCase() === 'all' || wanted === '全部') {
    return { names: usable, label: 'all' }
  }
  const exact = known.filter(name => name === wanted && restrictable.has(name) && !RESERVED_SWITCH.has(name))
  if (exact.length > 0) return { names: exact, label: wanted }
  const group = groups.find(item => item.name.toLowerCase() === wanted.toLowerCase())
  if (group !== undefined) {
    const names = group.tools.filter(name => restrictable.has(name) && !RESERVED_SWITCH.has(name))
    if (names.length === 0) return { error: 'that group has no switchable tools' }
    return { names, label: group.name }
  }
  const prefixed = usable.filter(name => name.startsWith(wanted))
  if (prefixed.length > 0) return { names: prefixed, label: wanted + '*' }
  return { error: 'unknown tool, group or prefix: ' + wanted }
}

export function sessionCounts(
  state: StateV2,
  sessionId: string,
  known: readonly string[],
  restrictable: ReadonlySet<string>,
): SwitchCounts & { mode: 'all' | 'custom'; missing: string[] } {
  const denied = new Set(state.sessions[sessionId] ?? [])
  const switchable = known.filter(name => restrictable.has(name) && !RESERVED_SWITCH.has(name))
  const disabled = switchable.filter(name => denied.has(name)).length
  const missing = [...denied].filter(name => !known.includes(name)).sort()
  return {
    total: switchable.length,
    enabled: switchable.length - disabled,
    disabled,
    fixed: known.filter(name => !restrictable.has(name)).length,
    mode: switchable.length > 0 && disabled >= switchable.length ? 'all' : 'custom',
    missing,
  }
}

export function applySessionSwitch(
  state: StateV2,
  sessionId: string,
  action: SwitchAction,
  target: string | undefined,
  known: readonly string[],
  restrictable: ReadonlySet<string>,
  groups: ReadonlyArray<{ name: string; tools: string[] }>,
): { ok: boolean; message: string; names: string[]; counts: SwitchCounts; mode: 'all' | 'custom'; changed: boolean } {
  const before = [...(state.sessions[sessionId] ?? [])]
  const current = new Set(before)
  const counts = sessionCounts(state, sessionId, known, restrictable)
  if (action === 'list') {
    return { ok: true, message: counts.disabled === 0 ? 'all switchable tools are on' : counts.disabled + ' tool(s) off', names: before.sort(), counts, mode: counts.mode, changed: false }
  }
  if (action === 'reset') {
    delete state.sessions[sessionId]
    return { ok: true, message: 'session tool switches reset', names: [], counts: sessionCounts(state, sessionId, known, restrictable), mode: 'custom', changed: before.length > 0 }
  }
  const resolved = resolveSwitchTargets(known, restrictable, groups, target ?? '')
  if ('error' in resolved) return { ok: false, message: resolved.error, names: before.sort(), counts, mode: counts.mode, changed: false }
  for (const name of resolved.names) {
    if (action === 'off') current.add(name)
    else current.delete(name)
  }
  const names = [...current].sort()
  if (names.length === 0) delete state.sessions[sessionId]
  else state.sessions[sessionId] = names
  return {
    ok: true,
    message: (action === 'off' ? 'switched off ' : 'switched on ') + resolved.names.length + ' tool(s) (' + resolved.label + '); takes effect on the next message',
    names,
    counts: sessionCounts(state, sessionId, known, restrictable),
    mode: counts.mode,
    changed: names.join('\u0000') !== before.sort().join('\u0000'),
  }
}

const sessionSwitch: OpHandler = async (payload, env) => {
  const sessionId = requireSessionId(payload)
  const body = asRecord(payload)
  const action = body.action === 'off' || body.action === 'on' || body.action === 'reset' || body.action === 'list' ? body.action : null
  if (action === null) throw fail('bad-action', 'action must be list, off, on or reset')
  const target = typeof body.target === 'string' ? body.target : undefined
  const view = toolViewOf(env)
  const result = applySessionSwitch(env.state, sessionId, action, target, view.known, view.restrictable, groupTargets(env.state))
  if (!result.ok) throw fail('unknown-target', result.message)
  const backup = result.changed ? await env.save('session-switch') : null
  return { ...result, sessionId, backup, mask: await maskAfter(env.state, env, sessionId) }
}

const sessionSummary: OpHandler = async (payload, env) => {
  const sessionId = requireSessionId(payload)
  const view = toolViewOf(env)
  return { sessionId, ...sessionCounts(env.state, sessionId, view.known, view.restrictable) }
}

const sessionAllowSet: OpHandler = async (payload, env) => {
  const sessionId = requireSessionId(payload)
  const names = unionNames([asStringList(asRecord(payload).allow)])
  if (names.length === 0) delete env.state.sessionAllow[sessionId]
  else env.state.sessionAllow[sessionId] = names
  const backup = await env.save('session-allow')
  const mask = env.services.get('toolHub.mask') as { setSessionAllow?: (id: string, list: string[]) => void } | undefined
  mask?.setSessionAllow?.(sessionId, names)
  return { sessionId, allow: names, backup }
}

const workspaceSet: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const key = typeof body.workspace === 'string' ? body.workspace.trim() : ''
  if (key === '' || key.length > 400) throw fail('bad-payload', 'workspace must be a path or id (1-400 characters)')
  const names = unionNames([asStringList(body.names)])
  if (names.length === 0) delete env.state.workspaces[key]
  else env.state.workspaces[key] = names
  const backup = await env.save('workspace-set')
  const mask = env.services.get('toolHub.mask') as { setWorkspaceDeny?: (id: string, list: string[]) => void } | undefined
  mask?.setWorkspaceDeny?.(key, names)
  return { workspace: key, deny: names, backup }
}

const subagentSet: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const deny = unionNames([asStringList(body.deny)])
  const allow = unionNames([asStringList(body.allow)])
  env.state.subagentAllow = allow
  env.state.subagentDeny = deny
  const backup = await env.save('subagent-set')
  const mask = env.services.get('toolHub.mask') as { setSubagentPolicy?: (denyList: string[], allowList: string[]) => void } | undefined
  mask?.setSubagentPolicy?.(deny, allow)
  return { deny, allow, backup }
}

/** The sessions domain: per-session tool overlays and the lineage that carries them down. */
export function sessionsDomain(): DomainRegistration {
  return {
    module: {
      id: 'sessions',
      title: { zh: '会话覆盖层', en: 'Session overlays' },
      ops: [
        { id: 'session.set', write: true, audit: true, note: 'Replaces one session overlay; only mcp__* names survive and an empty list removes the entry.' },
        { id: 'session.clear', write: true, audit: true, note: 'Drops one session overlay; the installation deny list is untouched.' },
        { id: 'session.lineage', write: false, audit: false, note: 'Reports a session lineage, its unioned deny overlay and its allow list; touches nothing.' },
        { id: 'session.allow', write: true, audit: true, note: 'Replaces one session allow list, subtracted after every deny layer.' },
        { id: 'session.switch', write: true, audit: true, note: 'Applies list/off/on/reset to this session tool switches; shared by the dock, /tools and tool_switch.' },
        { id: 'session.summary', write: false, audit: false, note: 'Counts the tools this session switched off, including fixed and missing names.' },
        { id: 'scope.workspace', write: true, audit: true, note: 'Replaces the deny override for one workspace key.' },
        { id: 'scope.subagent', write: true, audit: true, note: 'Replaces the deny/allow policy applied to subagent sessions only.' },
      ],
    },
    handlers: {
      'session.set': sessionSet,
      'session.clear': sessionClear,
      'session.lineage': sessionLineage,
      'session.allow': sessionAllowSet,
      'session.switch': sessionSwitch,
      'session.summary': sessionSummary,
      'scope.workspace': workspaceSet,
      'scope.subagent': subagentSet,
    },
  }
}
