/**
 * The one implementation of the four-layer tool scope formula.
 *
 *   deny(a) = (install ∪ workspace(cwd(a)) ∪ sessionDeny(lineage(a))) − sessionAllow(lineage(a))
 *   subagent only: deny(a) = (deny(a) − subagentAllow) ∪ subagentDeny
 *
 * The subagent test is origin/delegationDepth, never parentSession: a normal fork keeps the parent
 * link too, and inheriting a subagent-only policy into a fork would be wrong. A missing cwd simply
 * disables the workspace layer. Everything here is pure and IO-free so the mask and the reporting
 * op cannot drift apart.
 */
import { resolve as resolvePath } from 'node:path'

export interface AgentScope {
  sessionId?: string
  parentSessionId?: string
  cwd?: string
  subagent: boolean
}

export interface ScopeLayers {
  install: string[]
  workspace: string[]
  sessionDeny: string[]
  sessionAllow: string[]
  subagentAllow: string[]
  subagentDeny: string[]
}

export interface ScopeInput {
  install: readonly string[]
  workspaces: Readonly<Record<string, readonly string[]>>
  sessionDeny: Readonly<Record<string, readonly string[]>>
  sessionAllow: Readonly<Record<string, readonly string[]>>
  subagentAllow: readonly string[]
  subagentDeny: readonly string[]
  lineage: readonly string[]
  scope: AgentScope
}

export interface ScopeResolution {
  deny: string[]
  layers: ScopeLayers
  workspaceKey: string | null
  subagent: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Accept both header shapes the host has used: requestHeader() and a plain header object. */
function headerOf(agent: unknown): Record<string, unknown> {
  if (!isRecord(agent)) return {}
  const session = isRecord(agent.session) ? agent.session : {}
  try {
    const fn = session.requestHeader
    if (typeof fn === 'function') {
      const value = (fn as () => unknown).call(session)
      if (isRecord(value)) return value
    }
  }
  catch {
    /* fall through to the plain header */
  }
  if (isRecord(session.header)) return session.header
  if (isRecord(agent.header)) return agent.header
  return {}
}

export function agentScopeOf(agent: unknown): AgentScope {
  const record = isRecord(agent) ? agent : {}
  const session = isRecord(record.session) ? record.session : {}
  const meta = isRecord(record.meta) ? record.meta : {}
  const header = headerOf(agent)
  const sessionId = text(session.id) || text(record.id) || undefined
  const parentSessionId = text(header.parentSessionId) || text(header.parentSession) || text(meta.parentSessionId) || undefined
  const cwd = text(header.cwd) || text(header.workspaceRoot) || text(header.workspaceId) || text(meta.cwd) || undefined
  const depth = typeof header.delegationDepth === 'number' && Number.isFinite(header.delegationDepth) ? header.delegationDepth : 0
  const origin = text(header.origin)
  return {
    sessionId,
    parentSessionId,
    cwd,
    subagent: origin === 'subagent' || depth > 0,
  }
}

/** Storage form: absolute paths normalized, drive-letter case preserved. */
export function normalizeWorkspaceKey(raw: unknown): string {
  const value = text(raw)
  if (value === '') return ''
  try {
    return resolvePath(value).replace(/[\\/]+$/u, '')
  }
  catch {
    return value
  }
}

/** Comparison form: the drive letter is case-insensitive on Windows, the rest is kept. */
export function workspaceLookupKey(raw: unknown): string {
  const normalized = normalizeWorkspaceKey(raw)
  if (normalized === '') return ''
  return /^[A-Za-z]:/u.test(normalized) ? normalized[0]!.toLowerCase() + normalized.slice(1) : normalized
}

function union(...lists: ReadonlyArray<readonly string[] | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const name of list ?? []) {
      if (typeof name !== 'string' || name === '' || seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/** Resolve one agent's effective deny list; the only place the formula lives. */
export function resolveScopedDeny(input: ScopeInput): ScopeResolution {
  const lookup = workspaceLookupKey(input.scope.cwd)
  let workspaceKey: string | null = null
  let workspace: string[] = []
  if (lookup !== '') {
    for (const [key, names] of Object.entries(input.workspaces)) {
      if (workspaceLookupKey(key) !== lookup) continue
      workspaceKey = key
      workspace = [...names]
      break
    }
  }
  const sessionDeny = union(...input.lineage.map(id => input.sessionDeny[id]))
  const sessionAllow = union(...input.lineage.map(id => input.sessionAllow[id]))
  const install = union(input.install)
  const base = union(install, workspace, sessionDeny)
  const allow = new Set(sessionAllow)
  let deny = base.filter(name => !allow.has(name))
  const subagent = input.scope.subagent === true
  if (subagent) {
    const subAllow = new Set(input.subagentAllow)
    deny = deny.filter(name => !subAllow.has(name))
    deny = union(deny, input.subagentDeny)
  }
  deny.sort()
  return {
    deny,
    layers: {
      install,
      workspace,
      sessionDeny,
      sessionAllow,
      subagentAllow: subagent ? union(input.subagentAllow) : [],
      subagentDeny: subagent ? union(input.subagentDeny) : [],
    },
    workspaceKey,
    subagent,
  }
}
