/**
 * Op dispatch: the one door between the HTTP routes and the domain handlers.
 *
 * Three facts live here instead of in every handler: whether an op exists (the registry is the
 * table), whether it carries an unconditional confirmation gate (`confirm` on its definition),
 * and one audit line per call in `history.jsonl`. A handler therefore only sees a payload and the
 * `HostEnv`; no domain can forget the gate or the audit trail.
 *
 * History is advisory by design: a failed append must never fail the op it was recording.
 */
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../core/atomic.js'
import { saveState, stateDir } from '../core/io.js'
import type { Registry } from '../core/registry.js'
import type { StateV2 } from '../core/state.js'
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { OpDefinition } from '../shared/types.js'

// ── failures ─────────────────────────────────────────────────────────────────

/** A failure with a stable code the client can branch on; anything else reads as `internal`. */
export class Failure extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'Failure'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export interface FailureShape {
  code: string
  message: string
  details?: unknown
}

/** 1.x wire shape: `{ code, message }`, plus `details` only when a handler supplied one. */
export function failureOf(error: unknown): FailureShape {
  if (error instanceof Failure) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details }
  }
  if (error instanceof Error) return { code: 'internal', message: error.message }
  return { code: 'internal', message: String(error) }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ── history ──────────────────────────────────────────────────────────────────

/** `<state dir>/history.jsonl` is append-only until it grows past this, then it keeps the tail. */
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024
export const HISTORY_KEEP = 500
/** `history()` returns this many, newest first. */
export const HISTORY_LIST = 50

export interface HistoryEntry {
  at: string
  op: string
  detail: string
  ok: boolean
  audit: boolean
}

/** Same folder as the state file, so a sandbox profile's history never mixes with the real one. */
export function historyFile(): string {
  return join(stateDir(), 'history.jsonl')
}

/**
 * What a history line is allowed to remember: the op and the short ids that name the subject.
 *
 * Payloads can carry skill text, tokens or whole configs, so nothing is copied from them except
 * short scalar identifiers — a history that leaks a secret is worse than no history.
 */
const DETAIL_KEYS = ['id', 'name', 'kind', 'targetId', 'mode', 'state'] as const

export function historyDetail(payload: unknown): string {
  if (!isRecord(payload)) return ''
  const parts: string[] = []
  for (const key of DETAIL_KEYS) {
    const value = payload[key]
    if (typeof value === 'string' && value !== '' && value.length <= 120) parts.push(`${key}=${value}`)
  }
  return parts.join(' ').slice(0, 180)
}

export interface HistoryOptions {
  file?: string
  maxBytes?: number
  keep?: number
}

/** Append one line, truncating to the tail first when the file is over its budget. */
export async function appendHistory(entry: HistoryEntry, options: HistoryOptions = {}): Promise<void> {
  const file = options.file ?? historyFile()
  const maxBytes = options.maxBytes ?? HISTORY_MAX_BYTES
  const keep = options.keep ?? HISTORY_KEEP
  try {
    await mkdir(dirname(file), { recursive: true })
    const info = await stat(file).catch(() => null)
    if (info !== null && info.size > maxBytes) {
      const text = await readFile(file, 'utf8')
      const kept = text.split('\n').filter(line => line.trim() !== '').slice(-keep)
      await writeFileAtomic(file, kept.length === 0 ? '' : `${kept.join('\n')}\n`)
    }
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
  }
  catch {
    // History is advisory: a full disk must not fail the op it was recording.
  }
}

/** Newest first; a torn last line (a crash mid-append) is dropped, not fatal. */
export async function readHistory(limit = HISTORY_LIST, file = historyFile()): Promise<HistoryEntry[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return []
  }
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const items: HistoryEntry[] = []
  for (let index = lines.length - 1; index >= 0 && items.length < limit; index -= 1) {
    const line = lines[index]
    if (line === undefined) continue
    try {
      const row: unknown = JSON.parse(line)
      if (!isRecord(row)) continue
      items.push({
        at: typeof row.at === 'string' ? row.at : '',
        op: typeof row.op === 'string' ? row.op : '',
        detail: typeof row.detail === 'string' ? row.detail : '',
        ok: row.ok === true,
        audit: row.audit === true,
      })
    }
    catch {
      // A torn line is skipped; the rest of the file still reads.
    }
  }
  return items
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export interface ServiceBag {
  get(name: string): unknown
}

export interface DispatcherOptions {
  registry: Registry
  /** The loaded document handlers mutate; `env.state` is the same object. */
  state: StateV2
  services: ServiceBag
  /** Defaults to `console.warn` for `warn` and silence for `info`. */
  log?: (level: 'info' | 'warn', message: string) => void
  now?: () => number
  /** Defaults to `<state dir>/history.jsonl`. */
  historyFile?: string
  /** Defaults to core/io's `saveState` (backup, lock, atomic write). */
  save?: (state: StateV2, reason: string) => Promise<string | null>
}

export type DispatchOutcome =
  | { ok: true; data: unknown }
  | { ok: false; error: FailureShape }

function opLabel(op: unknown): string {
  if (typeof op === 'string') return op.trim()
  if (op === undefined || op === null) return ''
  return String(op)
}

/** The unconditional gates a definition carries; conditional ones stay inside its handler. */
function assertConfirmed(definition: OpDefinition, id: string, payload: unknown): void {
  const confirmation = isRecord(payload) ? payload.confirm : undefined
  if (definition.confirm === 'reset' && confirmation !== 'reset') {
    throw new Failure('confirm-required', `${id} needs the literal confirmation token "reset"; pass confirm:"reset"`)
  }
  if (definition.confirm === true && confirmation !== true) {
    throw new Failure('confirm-required', `${id} needs confirm:true`)
  }
}

/**
 * One dispatcher per process. `bind()` is the registration half (declared ops and their handlers),
 * `execute()` the raw path that throws, `run()` the route path that records history and returns a
 * structured outcome instead of throwing.
 */
export class Dispatcher {
  private readonly registry: Registry
  private readonly state: StateV2
  private readonly services: ServiceBag
  private readonly handlers = new Map<string, OpHandler>()
  private readonly env: HostEnv
  private readonly nowFn: () => number
  private readonly logFn: (level: 'info' | 'warn', message: string) => void
  private readonly historyPath: string
  private readonly saveFn: (state: StateV2, reason: string) => Promise<string | null>

  constructor(options: DispatcherOptions) {
    this.registry = options.registry
    this.state = options.state
    this.services = options.services
    this.nowFn = options.now ?? Date.now
    this.logFn = options.log ?? defaultLog
    this.historyPath = options.historyFile ?? historyFile()
    this.saveFn = options.save ?? saveState
    this.env = {
      state: this.state,
      services: this.services,
      save: reason => this.save(reason),
      log: (level, message) => this.logFn(level, message),
      now: () => this.nowFn(),
    }
  }

  /** The bag handed to every handler; one object, so a domain always persists through core/io. */
  get hostEnv(): HostEnv {
    return this.env
  }

  /**
   * Bind one domain: every declared op gets a handler and every handler names a declared op.
   * Both halves are checked here because "the host knows an op the client does not" is the silent
   * failure the single registry exists to prevent.
   */
  bind(registration: DomainRegistration): void {
    const declared = new Set(registration.module.ops.map(op => op.id))
    const incoming = new Map<string, OpHandler>()
    // Two phases on purpose: a half-bound module would leave the registry answering an op whose
    // handler is missing, which is worse than the registration error itself.
    for (const id of Object.keys(registration.handlers)) {
      if (!declared.has(id)) throw new Error(`handler for undeclared op: ${id} (module ${registration.module.id})`)
    }
    for (const id of declared) {
      const handler = registration.handlers[id]
      if (typeof handler !== 'function') throw new Error(`op ${id} has no handler (module ${registration.module.id})`)
      if (this.handlers.has(id) || incoming.has(id)) throw new Error(`duplicate op handler: ${id}`)
      incoming.set(id, handler)
    }
    for (const [id, handler] of incoming) this.handlers.set(id, handler)
  }

  /** Declared ops as the client sees them. */
  ops(): OpDefinition[] {
    return this.registry.ops()
  }

  /** Raw dispatch: throws a `Failure` for an unknown op, a missing gate or a handler error. */
  async execute(op: unknown, payload: unknown): Promise<unknown> {
    const id = opLabel(op)
    const definition = this.registry.findOp(id)
    if (definition === undefined) throw new Failure('bad-op', `unknown op ${id}`)
    assertConfirmed(definition, id, payload)
    const handler = this.handlers.get(id)
    if (handler === undefined) throw new Failure('no-handler', `op ${id} is declared but no handler is bound`)
    return await handler(payload, this.env)
  }

  /**
   * Route path: never throws, records one history line before returning (so a client that
   * refreshes history right after the call sees its own entry).
   */
  async run(op: unknown, payload: unknown): Promise<DispatchOutcome> {
    const id = opLabel(op)
    const audit = this.registry.findOp(id)?.audit === true
    const line = (ok: boolean): HistoryEntry => ({
      at: new Date(this.nowFn()).toISOString(),
      op: id,
      detail: historyDetail(payload),
      ok,
      audit,
    })
    try {
      const data = await this.execute(op, payload)
      await appendHistory(line(true), { file: this.historyPath })
      return { ok: true, data }
    }
    catch (error) {
      const failure = failureOf(error)
      await appendHistory(line(false), { file: this.historyPath })
      return { ok: false, error: failure }
    }
  }

  /** The one save path: core/io adds the backup and the cross-process lock. */
  async save(reason: string): Promise<string | null> {
    return await this.saveFn(this.state, reason)
  }

  history(limit = HISTORY_LIST): Promise<HistoryEntry[]> {
    return readHistory(limit, this.historyPath)
  }
}

function defaultLog(level: 'info' | 'warn', message: string): void {
  if (level === 'warn') console.warn(`[tool-hub] ${message}`)
}
