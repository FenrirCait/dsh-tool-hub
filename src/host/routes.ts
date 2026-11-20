/**
 * The panel's JSON routes.
 *
 * `/tool-hub/api/*` is what 1.x mounted and what the shipped client still posts to;
 * `/tool-hub/api/v1/*` is the 2.0 name for the same handlers. Both prefixes are registered against
 * one pair of handlers, so a client can migrate without the host running two code paths.
 *
 * A request passes three gates in this order, which is the order 1.x used:
 *   1. the host's own browser gate (`connection.requestRejection`) — resolved per request, because
 *      the service may be registered after this plugin starts; a gate that throws refuses (403);
 *   2. the method (GET for snapshot, POST for op; anything else is 405 with an `allow` header);
 *   3. same-origin, the check that cannot see the host's session cookie.
 * A refusal body is `{ ok: false, error: { code, message } }` — the 1.x shape byte for byte, so the
 * client's error rendering needs no version branch.
 *
 * An op failure answers 200 with `ok: false` (the call was understood); only a body that could not
 * be read answers 400, and only an unexpected internal error answers 500. Nothing throws out of a
 * handler.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HubContext } from '../shared/types.js'
import { Failure, failureOf, isRecord, type DispatchOutcome } from './dispatch.js'

// ── paths ────────────────────────────────────────────────────────────────────

export const API_PREFIX = '/tool-hub/api'
export const API_V1_PREFIX = '/tool-hub/api/v1'

/** 1.x paths: kept because that is what the shipped client calls. */
export const SNAPSHOT_PATH = `${API_PREFIX}/snapshot`
export const OP_PATH = `${API_PREFIX}/op`
/** 2.0 aliases: same handlers, one prefix up. */
export const V1_SNAPSHOT_PATH = `${API_V1_PREFIX}/snapshot`
export const V1_OP_PATH = `${API_V1_PREFIX}/op`

export const API_PATHS = [SNAPSHOT_PATH, OP_PATH, V1_SNAPSHOT_PATH, V1_OP_PATH] as const

/** 1.x refused anything larger; the client never sends more than a scene or an imported config. */
export const MAX_BODY = 256 * 1024

// ── host shapes ──────────────────────────────────────────────────────────────

/** The slice of the host's `webServer` service the API needs. */
export interface RouteRegistration {
  kind: 'exact'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void
}

export interface RouteServer {
  register(route: RouteRegistration): (() => void) | void
}

export interface ApiOptions {
  ctx: HubContext
  /** One op, structured outcome — `Dispatcher.run` is exactly this. */
  run: (op: unknown, payload: unknown) => Promise<DispatchOutcome>
  /** Snapshot builder; defaults to dispatching op `snapshot` (the 1.x op name, unchanged). */
  snapshot?: (request: { fresh: boolean }) => Promise<unknown>
}

// ── gates ────────────────────────────────────────────────────────────────────

/**
 * Refuse a request a browser page on another origin could have made.
 *
 * `Host` is the header an attacker's page cannot forge, so it has to name loopback (or nothing at
 * all: a non-browser caller — and the Desktop shell's own proxy — may drop it). A present `Origin`
 * must agree with `Host`, and a cross-site fetch is refused outright.
 */
export function sameOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host
  const origin = request.headers.origin
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  if (origin === undefined) return true
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  }
  catch {
    return false
  }
  if (host === undefined) return true
  const lower = host.toLowerCase()
  const name = lower.startsWith('[')
    ? lower.slice(0, lower.indexOf(']') + 1)
    : lower.split(':')[0] ?? ''
  const loopback = name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
  if (originUrl.host === host) return true
  if (originUrl.port === '' && loopback && originUrl.hostname === name) return true
  return false
}

/**
 * The host's own browser gate (`connection.requestRejection`, the check the host's `/api` runs).
 * Resolved per request, never at mount time: the service may be registered after this plugin
 * starts. Returns 401 / 403 to refuse with, or undefined to let the request through. A gate that
 * throws refuses too — fail closed, not open.
 */
export function hostRejection(ctx: HubContext, request: IncomingMessage): number | undefined {
  const connection = readService<{ requestRejection?: unknown }>(ctx, 'connection')
  const gate = connection?.requestRejection
  if (typeof gate !== 'function') return undefined
  try {
    const verdict: unknown = gate.call(connection, request)
    return typeof verdict === 'number' ? verdict : undefined
  }
  catch {
    return 403
  }
}

function readService<T>(ctx: HubContext, name: string): T | undefined {
  try {
    const read = ctx.get
    if (typeof read !== 'function') return undefined
    return (read.call(ctx, name) as T | null | undefined) ?? undefined
  }
  catch {
    return undefined
  }
}

// ── wire ─────────────────────────────────────────────────────────────────────

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** 401 / 403 from the host gate, in the 1.x shape. */
function refuseAuth(response: ServerResponse, rejection: number): void {
  sendJson(response, rejection, {
    ok: false,
    error: {
      code: rejection === 403 ? 'forbidden' : 'unauthorized',
      message: 'DSH browser authentication is required',
    },
  })
}

function refuseOrigin(response: ServerResponse): void {
  sendJson(response, 403, { ok: false, error: { code: 'origin', message: 'refused: cross-origin request' } })
}

function allowOnly(response: ServerResponse, method: string): void {
  response.writeHead(405, { allow: method })
  response.end()
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > MAX_BODY) throw new Failure('too-large', 'request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
  catch {
    throw new Failure('bad-json', 'request body is not JSON')
  }
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleSnapshot(options: ApiOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const rejection = hostRejection(options.ctx, request)
  if (rejection !== undefined) {
    refuseAuth(response, rejection)
    return
  }
  if (request.method !== 'GET') {
    allowOnly(response, 'GET')
    return
  }
  if (!sameOrigin(request)) {
    refuseOrigin(response)
    return
  }
  const fresh = /(?:^|[?&])fresh=1(?:&|$)/.test(request.url ?? '')
  const build = options.snapshot ?? defaultSnapshot(options)
  try {
    const data = await build({ fresh })
    sendJson(response, 200, { ok: true, data })
  }
  catch (error) {
    sendJson(response, 200, { ok: false, error: failureOf(error) })
  }
}

/** Default builder: the `snapshot` op, so the route has no snapshot logic of its own. */
function defaultSnapshot(options: ApiOptions): (request: { fresh: boolean }) => Promise<unknown> {
  return async ({ fresh }) => {
    const outcome = await options.run('snapshot', { fresh })
    if (outcome.ok) return outcome.data
    throw new Failure(outcome.error.code, outcome.error.message, outcome.error.details)
  }
}

async function handleOp(options: ApiOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const rejection = hostRejection(options.ctx, request)
  if (rejection !== undefined) {
    refuseAuth(response, rejection)
    return
  }
  if (request.method !== 'POST') {
    allowOnly(response, 'POST')
    return
  }
  if (!sameOrigin(request)) {
    refuseOrigin(response)
    return
  }
  let body: unknown
  try {
    body = await readJson(request)
  }
  catch (error) {
    // The body never reached an op, so this is a transport failure, not an op failure.
    sendJson(response, 400, { ok: false, error: failureOf(error) })
    return
  }
  const envelope = isRecord(body) ? body : {}
  const outcome = await options.run(envelope.op, envelope.payload)
  sendJson(response, 200, outcome)
}

/** Turn a handler into a request listener that cannot throw into the host's server. */
function safe(work: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    void work(request, response).catch(error => {
      if (response.headersSent) {
        response.end()
        return
      }
      sendJson(response, 500, { ok: false, error: failureOf(error) })
    })
  }
}

// ── mount ────────────────────────────────────────────────────────────────────

/**
 * Register both prefixes and return one disposer for the caller's effect.
 *
 * A host without `webServer` is a degraded install, not a crash: the panel API stays unmounted and
 * the warning names why.
 */
export function mountApi(options: ApiOptions): () => void {
  const server = readService<RouteServer>(options.ctx, 'webServer')
  if (server === undefined || typeof server.register !== 'function') {
    warn(options.ctx, 'no webServer service; the panel API is not mounted')
    return () => {}
  }
  const snapshotHandler = safe((request, response) => handleSnapshot(options, request, response))
  const opHandler = safe((request, response) => handleOp(options, request, response))
  const routes: RouteRegistration[] = [
    { kind: 'exact', path: SNAPSHOT_PATH, handler: snapshotHandler },
    { kind: 'exact', path: OP_PATH, handler: opHandler },
    { kind: 'exact', path: V1_SNAPSHOT_PATH, handler: snapshotHandler },
    { kind: 'exact', path: V1_OP_PATH, handler: opHandler },
  ]
  const disposers: Array<() => void> = []
  for (const route of routes) {
    try {
      const dispose = server.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    catch (error) {
      warn(options.ctx, `cannot register ${route.path}: ${errorText(error)}`)
    }
  }
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

/** Mount and let the context own the cleanup when it offers an effect hook. */
export function installApi(options: ApiOptions): () => void {
  const dispose = mountApi(options)
  try {
    const effect = options.ctx.effect
    if (typeof effect === 'function') effect.call(options.ctx, () => dispose)
  }
  catch {
    // An effect failure must not unmount the API that is already answering.
  }
  return dispose
}

function warn(ctx: HubContext, message: string): void {
  const logger = readService<{ warn?: (message: string) => void }>(ctx, 'logger')
  if (typeof logger?.warn === 'function') {
    try {
      logger.warn(`[tool-hub] ${message}`)
      return
    }
    catch {
      // Fall through to the console line.
    }
  }
  console.warn(`[tool-hub] ${message}`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
