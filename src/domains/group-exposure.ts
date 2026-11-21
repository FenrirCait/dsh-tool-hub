/**
 * Replaying a session log for the on-demand groups a session has opened.
 *
 * The log is the truth. A group counts as open only when a `tool_list` call was paired with a
 * successful result, or when a PTC dispatch reported success; a call whose result was an error,
 * or that never got a result, leaves the group closed. Fork semantics fall out of the algorithm:
 * the replay starts at seq 0, so a child session sees the groups its parent opened before the
 * fork point and nothing the parent opened afterwards.
 *
 * The cache in state (`state.modules['tool-surface'].open`) is the fallback for a session whose
 * log is missing and for the panel before any agent mounts. Replay never throws: a log whose
 * eventAt() fails degrades to an empty result so the caller can fall back instead of losing the
 * mask entirely.
 *
 * Pure and IO-free: the host mask and the probes call the same function.
 */

/** A session log in the shape the host exposes: `seq` plus `eventAt(seq)`. */
export interface SessionLogLike {
  readonly seq: number
  eventAt(seq: number): unknown
}

export interface OpenGroupsResult {
  /** Group names as the tool call spelled them, trimmed. */
  open: Set<string>
  /** Events actually scanned; 0 means nothing could be replayed. */
  events: number
}

/** The discovery tool every open call goes through. */
export const DISCOVERY_TOOL = 'tool_list'
export const DISCOVERY_NAMES: ReadonlySet<string> = new Set([DISCOVERY_TOOL])

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function groupNameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name === '' ? null : name
}

/**
 * The group a tool call asks for: `{group}` either as an object or as a JSON string (the host
 * serializes arguments on the way in, and a hand-written log may hold either).
 */
export function groupFromInput(value: unknown): string | null {
  let parsed: unknown = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return null
    try {
      parsed = JSON.parse(text)
    }
    catch {
      return null
    }
  }
  const record = recordOf(parsed)
  return record === null ? null : groupNameOf(record.group)
}

/** One event as `{type, data}`; tolerant of logs that keep the fields at the top level. */
function eventOf(raw: unknown): { type: string; data: Record<string, unknown> } | null {
  const record = recordOf(raw)
  if (record === null) return null
  const data = recordOf(record.data) ?? record
  const type = typeof record.type === 'string' ? record.type : typeof data.type === 'string' ? data.type : ''
  return type === '' ? null : { type, data }
}

/** The call id a tool result belongs to, however the host carried it. */
function callIdOf(data: Record<string, unknown>): string | null {
  const direct = typeof data.toolCallId === 'string' ? data.toolCallId.trim() : ''
  if (direct !== '') return direct
  const source = recordOf(data.source)
  const fromSource = source !== null && typeof source.callId === 'string' ? source.callId.trim() : ''
  if (fromSource !== '') return fromSource
  for (const block of Array.isArray(data.content) ? data.content : []) {
    const record = recordOf(block)
    if (record === null || record.type !== 'tool-result') continue
    const fromBlock = typeof record.toolCallId === 'string' ? record.toolCallId.trim() : ''
    if (fromBlock !== '') return fromBlock
  }
  return null
}

/** Whether a tool result reports failure, at any of the shapes the host has used. */
function resultFailed(data: Record<string, unknown>): boolean {
  if (data.isError === true) return true
  if (recordOf(data.result)?.isError === true) return true
  for (const block of Array.isArray(data.content) ? data.content : []) {
    const record = recordOf(block)
    if (record !== null && record.type === 'tool-result' && record.isError === true) return true
  }
  return false
}

/**
 * Groups a session has opened, replayed from its log.
 *
 * `commandNames` is optional: when given, `command/run` events whose input starts with
 * `on <group>` (or `open <group>`) also count as an open. The panel's slash command is the only
 * caller that needs it.
 */
export function restoredOpenGroups(
  log: SessionLogLike | undefined,
  discoveryNames: ReadonlySet<string> = DISCOVERY_NAMES,
  commandNames?: ReadonlySet<string>,
): OpenGroupsResult {
  const open = new Set<string>()
  if (log === undefined || log === null) return { open, events: 0 }
  const total = typeof log.seq === 'number' && Number.isFinite(log.seq) && log.seq > 0 ? Math.floor(log.seq) : 0
  const discovery = discoveryNames.size > 0 ? discoveryNames : DISCOVERY_NAMES
  const pending = new Map<string, string>()
  let events = 0
  try {
    for (let seq = 0; seq < total; seq++) {
      events += 1
      const event = eventOf(log.eventAt(seq))
      if (event === null) continue
      const { type, data } = event
      if (type === 'tool/call') {
        const name = typeof data.name === 'string' ? data.name : ''
        const callId = typeof data.callId === 'string' ? data.callId.trim() : ''
        if (!discovery.has(name) || callId === '') continue
        const group = groupFromInput(data.arguments)
        if (group !== null) pending.set(callId, group)
        continue
      }
      if (type === 'tool/result') {
        const callId = callIdOf(data)
        if (callId === null) continue
        const group = pending.get(callId)
        if (group === undefined) continue
        pending.delete(callId)
        if (!resultFailed(data)) open.add(group)
        continue
      }
      if (type === 'tool/ptc-dispatch') {
        const name = typeof data.name === 'string' ? data.name : ''
        if (!discovery.has(name) || data.isError === true) continue
        const group = groupFromInput(data.arguments ?? data.args)
        if (group !== null) open.add(group)
        continue
      }
      if (commandNames !== undefined && commandNames.size > 0 && type === 'command/run') {
        const name = typeof data.name === 'string' ? data.name : typeof data.command === 'string' ? data.command : ''
        if (!commandNames.has(name)) continue
        const raw = typeof data.rawInput === 'string' ? data.rawInput : typeof data.input === 'string' ? data.input : ''
        const match = /^(?:on|open)\s+(\S+)/iu.exec(raw.trim())
        const group = match === null ? null : groupNameOf(match[1])
        if (group !== null) open.add(group)
      }
    }
  }
  catch {
    // A log that refuses to be read must not take the mask down with it: the caller falls back
    // to the durable cache, and an empty result is the only honest answer.
    return { open: new Set(), events: 0 }
  }
  return { open, events }
}
