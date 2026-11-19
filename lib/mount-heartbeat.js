/**
 * Mount heartbeat: the one file that answers "is this plugin actually applied right now?".
 *
 * `doctor` can probe the profile, the patch file, the trash directory and the tool registry and
 * still not know whether *this plugin* is mounted. The failure that matters is silent: change an
 * `inject` service name, the plugin never applies, no error is thrown, nothing is logged, and the
 * UI block simply disappears. So `apply()` drops one small file, and `doctor` reads it back and
 * compares it with the live process. A mismatch then becomes a verdict instead of a guess.
 *
 * Three properties this file exists for:
 *   - atomic: a reader must never see a half-written heartbeat and call it "not mounted";
 *   - read-safe: a corrupt or missing file is a diagnosis, never an exception in doctor;
 *   - plain facts: the file only stores what can be compared (pid, host start, injects, time).
 *
 * Zero dependencies, node core only.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Bumped only when the on-disk shape changes; a reader refuses anything else. */
const VERSION = 1

/** 24h. Older than that and no boot in the last day wrote it, so it proves nothing. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function errorText(error) {
  return error !== null && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : String(error)
}

/**
 * The host's own approximation of when this process booted, derived from uptime instead of a
 * stored constant: it survives a hot reload of this module, which a module-level `Date.now()`
 * would not.
 */
function hostStartFromUptime() {
  return Date.now() - Math.round(process.uptime() * 1000)
}

/** Where the heartbeat lives for one state directory (next to `state.json`, not inside it). */
export function heartbeatPath(stateDir) {
  return join(stateDir, 'mount.json')
}

/** Keep only real service names; a stray value would only produce a phantom problem later. */
function normalizeInjects(injects) {
  if (!Array.isArray(injects)) return []
  const seen = new Set()
  for (const name of injects) {
    if (typeof name === 'string' && name !== '') seen.add(name)
  }
  return [...seen]
}

/**
 * Write the heartbeat. Atomic on purpose: `rename` inside one directory is atomic, so a reader
 * sees either the previous complete file or the new complete file, never a truncated one.
 *
 * Throws on real I/O failure — the caller (apply) decides whether a missing heartbeat is worth
 * logging, and swallowing it here would hide a broken state directory from doctor as well.
 *
 * @returns {{ file: string, data: object }} what was written, for callers that log it.
 */
export function writeMountHeartbeat({
  stateDir,
  pid = process.pid,
  hostStartedAt = hostStartFromUptime(),
  injects = [],
  now = Date.now(),
} = {}) {
  if (typeof stateDir !== 'string' || stateDir === '') {
    throw new TypeError('writeMountHeartbeat needs a stateDir')
  }
  const file = heartbeatPath(stateDir)
  const data = {
    version: VERSION,
    pid: Number(pid),
    hostStartedAt: Number(hostStartedAt),
    injects: normalizeInjects(injects),
    writtenAt: Number(now),
  }
  mkdirSync(stateDir, { recursive: true })
  // The name carries pid and randomness so two processes writing the same directory at once
  // cannot collide on the temporary file and hand each other a half-written payload.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    // Leave no debris behind: a `.tmp-*` file would look like a bug to the next doctor run.
    rmSync(tmp, { force: true })
    throw error
  }
  return { file, data }
}

/** Which required field is missing or has the wrong type; null when the shape is usable. */
function wrongField(parsed) {
  if (!Number.isFinite(parsed.version)) return 'version'
  if (!Number.isFinite(parsed.pid)) return 'pid'
  if (!Number.isFinite(parsed.hostStartedAt)) return 'hostStartedAt'
  if (!Number.isFinite(parsed.writtenAt)) return 'writtenAt'
  if (!Array.isArray(parsed.injects)) return 'injects'
  if (parsed.injects.some(name => typeof name !== 'string')) return 'injects'
  return null
}

/**
 * Read and shape-check one heartbeat file, without deciding whether the version is supported.
 * Split out so `readMountHeartbeat` and `diagnoseMount` cannot drift apart on the shape rules.
 */
function parseHeartbeat(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // A missing file is the normal "never mounted" state, not an error worth a stack trace.
    if (error?.code === 'ENOENT') return { ok: false, reason: 'no heartbeat file' }
    return { ok: false, reason: `cannot read heartbeat: ${errorText(error)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // A truncated file is what a non-atomic write would leave; keep the reason distinct so
    // doctor can tell "bug in the writer" from "plugin never applied".
    return { ok: false, reason: `bad heartbeat json: ${errorText(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'bad heartbeat json: not an object' }
  }
  const field = wrongField(parsed)
  if (field !== null) return { ok: false, reason: `heartbeat field missing or invalid: ${field}` }
  return { ok: true, data: parsed }
}

/**
 * Read the heartbeat for a state directory.
 * Never throws: callers are diagnostics, and a diagnostic that dies on a missing file is useless.
 *
 * @returns {{ ok: true, data: object } | { ok: false, reason: string }}
 */
export function readMountHeartbeat(stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') {
    return { ok: false, reason: 'no heartbeat file' }
  }
  const parsed = parseHeartbeat(heartbeatPath(stateDir))
  if (!parsed.ok) return parsed
  if (parsed.data.version !== VERSION) return { ok: false, reason: 'unknown heartbeat version' }
  return parsed
}

/**
 * Compare a heartbeat file with the live process and list every way it fails to describe it.
 *
 * Each problem is independent — one drifted field must not hide a missing inject — because the
 * operator is debugging a silent mount failure and needs the whole picture in one pass.
 *
 * @returns {{ ok: boolean, problems: string[], facts: object }}
 */
export function diagnoseMount({
  file,
  pid = process.pid,
  hostStartedAt = hostStartFromUptime(),
  expectedInjects = [],
  toleranceMs = 5000,
  now = Date.now(),
} = {}) {
  const problems = []
  const facts = { pid: null, hostStartedAt: null, writtenAt: null, ageMs: null, injects: [] }

  const parsed = typeof file === 'string' && file !== '' ? parseHeartbeat(file) : { ok: false, reason: 'no heartbeat file' }
  if (!parsed.ok) {
    // Without a readable file there is nothing to compare: every other check would be noise.
    problems.push(parsed.reason)
    return { ok: false, problems, facts }
  }

  const data = parsed.data
  facts.pid = data.pid
  facts.hostStartedAt = data.hostStartedAt
  facts.writtenAt = data.writtenAt
  facts.ageMs = now - data.writtenAt
  facts.injects = [...data.injects]

  // Kept even though the reader refuses an unknown version: diagnose can be handed a file from
  // a newer install, and the version is the first thing worth naming in that case.
  if (data.version !== VERSION) problems.push('unknown heartbeat version')

  if (data.pid !== pid) {
    problems.push(`heartbeat belongs to pid ${data.pid}, current pid ${pid}`)
  }

  // The decisive check: if the host started long ago but the file claims another start time, this
  // boot never wrote it — which means the plugin never applied in this process.
  if (Number.isFinite(hostStartedAt) && Math.abs(hostStartedAt - data.hostStartedAt) > toleranceMs) {
    problems.push('host start time drifted')
  }

  for (const name of expectedInjects) {
    // One problem per service, so the missing name itself is the fix instruction.
    if (typeof name === 'string' && name !== '' && !data.injects.includes(name)) {
      problems.push(`missing inject: ${name}`)
    }
  }

  const age = now - data.writtenAt
  if (age > MAX_AGE_MS) {
    problems.push(`heartbeat is stale: written ${Math.round(age / 1000)}s ago`)
  }
  // A clock that runs backwards, or a file copied from another machine, lands here.
  if (data.writtenAt > now + toleranceMs) {
    problems.push(`heartbeat is from the future: ${Math.round((data.writtenAt - now) / 1000)}s ahead`)
  }

  return { ok: problems.length === 0, problems, facts }
}
