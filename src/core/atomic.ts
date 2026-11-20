import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Write through a sibling temp file and rename, so a reader never sees half a document. */
export async function writeFileAtomic(file: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode })
    await rename(temp, file)
  }
  catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export interface LockOptions { timeoutMs?: number; staleMs?: number }

/**
 * Cross-process advisory lock (O_EXCL). A stale lock whose owner is gone is broken rather than
 * waited on; the caller gets the lock or a timeout, never a silent lost update.
 */
export async function withFileLock<T>(lockFile: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000
  const staleMs = options.staleMs ?? 60000
  await mkdir(dirname(lockFile), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const handle = await open(lockFile, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
        return await work()
      }
      finally {
        await handle.close().catch(() => {})
        await rm(lockFile, { force: true }).catch(() => {})
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await open(lockFile, 'r').then(async handle => {
        const text = await handle.readFile('utf8').catch(() => '')
        await handle.close().catch(() => {})
        return text
      }).catch(() => '')
      const at = Number(JSON.parse(info || '{}').at ?? 0)
      if (Date.now() - at > staleMs) await rm(lockFile, { force: true }).catch(() => {})
      else if (Date.now() > deadline) throw new Error(`lock timeout: ${lockFile}`)
      else await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}
