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
  const result = await applySurface({ state, services: env.services, sessionId })
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
    sessions: env.state.sessions,
  }
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
        { id: 'session.lineage', write: false, audit: false, note: 'Reports a session lineage and its unioned overlay; touches nothing.' },
      ],
    },
    handlers: {
      'session.set': sessionSet,
      'session.clear': sessionClear,
      'session.lineage': sessionLineage,
    },
  }
}
