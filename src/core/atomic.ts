import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'

/** Default lock wait: a caller that cannot get the lock in this window fails instead of hanging. */
export const LOCK_TIMEOUT_MS = 5000
/** Default lock age after which the owner is presumed dead and the lock is broken. */
export const LOCK_STALE_MS = 60000
/** How long to wait between acquisition attempts. */
export const LOCK_POLL_MS = 50
/** A lock younger than this is never broken on process liveness alone: it may still be mid-write. */
const LIVENESS_GRACE_MS = 1000
/** Machine-readable code carried by {@link LockTimeoutError}. */
export const LOCK_TIMEOUT_CODE = 'ELOCKTIMEOUT'

/** Raised by withFileLock when another process holds the lock for longer than the timeout. */
export class LockTimeoutError extends Error {
  readonly code = LOCK_TIMEOUT_CODE
  readonly lockFile: string
  readonly waitedMs: number

  constructor(lockFile: string, waitedMs: number) {
    super(`lock timeout after ${waitedMs}ms: ${lockFile}`)
    this.name = 'LockTimeoutError'
    this.lockFile = lockFile
    this.waitedMs = waitedMs
  }
}

export interface LockOptions {
  /** Give up (LockTimeoutError) after this long. Default 5 s. */
  timeoutMs?: number
  /** Treat a lock older than this as abandoned and break it. Default 60 s. */
  staleMs?: number
  /** Delay between attempts; jitter is added on top. Default 50 ms. */
  pollMs?: number
}

/** What a lock file claims about its holder, with nulls for anything unparseable. */
export interface LockHolder {
  pid: number | null
  at: number | null
  token: string | null
}

function siblingTemp(file: string): string {
  return `${file}.${process.pid}.${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.tmp`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/**
 * Write through a sibling temp file and rename, so a reader never sees half a document.
 *
 * The temp file is created exclusively with the target mode (0600 by default), flushed before the
 * rename, and removed if anything fails: the rename is the only commit point, so a crash leaves
 * either the previous file or the complete new one.
 */
export async function writeFileAtomic(file: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = siblingTemp(file)
  try {
    const handle = await open(temp, 'wx', mode)
    try {
      await handle.writeFile(text, 'utf8')
      // fsync is best effort: a filesystem that rejects it for regular files still gets the rename.
      await handle.sync().catch(() => {})
    }
    finally {
      await handle.close().catch(() => {})
    }
    await rename(temp, file)
  }
  catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Same guarantees as {@link writeFileAtomic}, for a JSON-serialisable value. */
export async function writeJsonAtomic(file: string, value: unknown, mode = 0o600): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/** Read a lock file's claims; null when the file is absent or unreadable as a file. */
async function readLockHolder(lockFile: string): Promise<LockHolder | null> {
  let text: string
  try {
    text = await readFile(lockFile, 'utf8')
  }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    // A lock held open by another process on Windows can report EPERM/EACCES; treat as "exists".
    return { pid: null, at: null, token: null }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { pid: null, at: null, token: null }
    }
    const record = parsed as Record<string, unknown>
    return {
      pid: typeof record.pid === 'number' && Number.isFinite(record.pid) ? record.pid : null,
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : null,
      token: typeof record.token === 'string' && record.token !== '' ? record.token : null,
    }
  }
  catch {
    // A half-written lock is not an error: its age decides whether it is abandoned.
    return { pid: null, at: null, token: null }
  }
}

/** Age of a lock: its own `at` when trustworthy, else the file mtime. Null when neither is known. */
async function lockAgeMs(lockFile: string, holder: LockHolder): Promise<number | null> {
  if (holder.at !== null) return Date.now() - holder.at
  const info = await stat(lockFile).catch(() => null)
  return info === null ? null : Date.now() - info.mtimeMs
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    // ESRCH means the pid is gone; EPERM means it exists under another user.
    return errorCode(error) !== 'ESRCH'
  }
}

/**
 * Remove a lock by renaming it aside first, so two processes that decide to break the same lock
 * cannot both win: the rename is atomic and only one of them succeeds.
 */
async function breakLock(lockFile: string): Promise<boolean> {
  const grave = `${lockFile}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await rename(lockFile, grave)
  }
  catch {
    // ENOENT: someone else broke it first. EPERM/EACCES: still open elsewhere; retry later.
    return false
  }
  await rm(grave, { force: true }).catch(() => {})
  return true
}

/** Decide whether the current holder is gone, and break the lock if so. */
async function breakIfStale(lockFile: string, staleMs: number): Promise<boolean> {
  const holder = await readLockHolder(lockFile)
  // The file vanished between our open() and this read: retry immediately.
  if (holder === null) return true
  const age = await lockAgeMs(lockFile, holder)
  if (age === null) return false
  if (age > staleMs) return breakLock(lockFile)
  // A crashed owner is worth breaking early, but never inside the write window.
  if (age > LIVENESS_GRACE_MS && holder.pid !== null && !isProcessAlive(holder.pid)) {
    return breakLock(lockFile)
  }
  return false
}

/** Create the lock exclusively, waiting for a live holder. Returns this acquisition's token. */
async function acquireLock(lockFile: string, timeoutMs: number, staleMs: number, pollMs: number): Promise<string> {
  const startedAt = Date.now()
  for (;;) {
    const token = randomBytes(8).toString('hex')
    let handle: FileHandle | null = null
    try {
      handle = await open(lockFile, 'wx', 0o600)
    }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    if (handle !== null) {
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token }), 'utf8')
        await handle.sync().catch(() => {})
      }
      catch (error) {
        await handle.close().catch(() => {})
        await breakLock(lockFile).catch(() => {})
        throw error
      }
      // Close the handle at once: on Windows an open handle blocks the rename used to release it.
      await handle.close().catch(() => {})
      return token
    }
    if (await breakIfStale(lockFile, staleMs)) continue
    const waited = Date.now() - startedAt
    if (waited >= timeoutMs) throw new LockTimeoutError(lockFile, waited)
    await sleep(pollMs + Math.floor(Math.random() * 10))
  }
}

/**
 * Release a lock this process owns. Idempotent and token-checked: calling it twice, or after the
 * lock was broken and re-taken by someone else, returns false and leaves the newer lock alone.
 */
export async function releaseFileLock(lockFile: string, token: string): Promise<boolean> {
  try {
    const holder = await readLockHolder(lockFile)
    if (holder === null || holder.token === null || holder.token !== token) return false
    return await breakLock(lockFile)
  }
  catch {
    return false
  }
}

/**
 * Cross-process advisory lock (O_EXCL, holder pid + timestamp) around one critical section.
 *
 * A waiter that finds a lock older than `staleMs` (or whose owner process is gone) breaks it
 * instead of waiting forever; past `timeoutMs` it throws {@link LockTimeoutError} rather than
 * proceeding without the lock, so a lost update stays a reported failure. The lock is released in
 * a finally block, which keeps the file clean when `work` throws.
 *
 * `work` should finish well inside `staleMs`: a holder that outlives it can be treated as dead.
 */
export async function withFileLock<T>(lockFile: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const pollMs = Math.max(5, options.pollMs ?? LOCK_POLL_MS)
  if (!(staleMs > 0)) throw new RangeError(`staleMs must be positive: ${staleMs}`)
  await mkdir(dirname(lockFile), { recursive: true })
  const token = await acquireLock(lockFile, Math.max(0, timeoutMs), staleMs, pollMs)
  try {
    return await work()
  }
  finally {
    await releaseFileLock(lockFile, token)
  }
}
