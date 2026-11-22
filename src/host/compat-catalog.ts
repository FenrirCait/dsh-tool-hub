/**
 * Official compat packs: a remote catalog and a verified installer.
 *
 * The plugin package ships no pack of its own. `compat.index` reads an index.json from the URL
 * the owner configured (raw GitHub by default), falls back to the mirror URL, and keeps the parsed
 * document for compat.cacheMinutes. `compat.install` downloads one pack's files, checks every
 * file's byte count and SHA-256 before anything is written, and only then swaps a staging folder
 * into the profile extension root.
 *
 * The security rules live here, not in the panel:
 * - only https URLs, or http on loopback (a local mirror or a probe fixture); redirects are
 *   re-checked against the same rule;
 * - caps on the index body, each file and the pack total;
 * - every file path must stay inside the pack folder: no absolute path, no drive letter, no "..";
 * - a verification failure writes nothing, and an existing local copy is backed up before the
 *   swap, never silently overwritten.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { LocalizedText } from '../shared/types.js'

export const INDEX_SCHEMA = 1
/** Raw files on the packs repository's main branch. */
export const DEFAULT_INDEX_URL = 'https://raw.githubusercontent.com/FenrirCait/dsh-tool-hub-packs/main/index.json'
/** jsDelivr mirror of the same catalog, used only when the raw URL cannot be read. */
export const DEFAULT_MIRROR_URL = 'https://cdn.jsdelivr.net/gh/FenrirCait/dsh-tool-hub-packs@main/index.json'
/** How long a parsed catalog is reused before a refresh reads the network again. */
export const DEFAULT_CACHE_MINUTES = 60
/** A catalog this large is not a catalog; refuse it instead of parsing it. */
export const MAX_INDEX_BYTES = 1024 * 1024
export const MAX_FILE_BYTES = 8 * 1024 * 1024
export const MAX_PACK_BYTES = 32 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15000
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const SHA256 = /^[0-9a-f]{64}$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Stable codes the panel and the probes branch on. */
export type CompatFailureCode =
  | 'bad-url'
  | 'bad-index'
  | 'index-unavailable'
  | 'size-limit'
  | 'verify-failed'
  | 'bad-path'
  | 'download-failed'
  | 'write-failed'
  | 'not-installed'
  | 'not-extension'

export class CompatFailure extends Error {
  readonly code: CompatFailureCode

  constructor(code: CompatFailureCode, message: string) {
    super(message)
    this.name = 'CompatFailure'
    this.code = code
  }
}

export interface CompatFile {
  /** Relative path inside the pack folder, always with forward slashes. */
  path: string
  /** Absolute https URL (http is accepted on loopback only). */
  url: string
  bytes: number
  sha256: string
}

export interface CompatPack {
  id: string
  name: LocalizedText
  version: string
  description?: LocalizedText
  files: CompatFile[]
}

export interface CompatIndex {
  packs: CompatPack[]
}

export type IndexSource = 'index' | 'mirror' | 'cache'

export interface CatalogSettings {
  indexUrl: string
  mirrorUrl: string
  cacheMinutes: number
}

export interface CatalogResult {
  index: CompatIndex
  source: IndexSource
  fetchedAt: string
  /** Packs the parser refused and why; the rest of the catalog is still usable. */
  warnings: string[]
}

export interface CompatInstallResult {
  id: string
  version: string
  dir: string
  /** The backup folder an existing copy went to; '' when there was nothing to back up. */
  backup: string
  files: number
}

export interface CompatUninstallResult {
  id: string
  /** The backup folder the removed copy went to. */
  backup: string
}

// ── URLs and paths ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 300)
}

/**
 * The one URL rule: https anywhere, http only on loopback. Anything else is refused before a
 * request leaves the process, so a malformed setting can never turn into plaintext traffic.
 */
export function parsePackUrl(raw: string): URL | null {
  const text = raw.trim()
  if (text === '') return null
  let url: URL
  try {
    url = new URL(text)
  }
  catch {
    return null
  }
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && (LOOPBACK.has(url.hostname) || url.hostname.endsWith('.localhost'))) return url
  return null
}

/** A pack-relative file path, or null when it could escape the pack folder on any platform. */
export function safeRelativePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim().replace(/\\/g, '/')
  if (text === '' || text.length > 512) return null
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return null
  const parts = text.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null
    if (part.includes(':') || part.includes('\0')) return null
  }
  return parts.join('/')
}

/** True when candidate really lives under root (and is not root itself). */
function assertInside(root: string, candidate: string): void {
  const inner = relative(root, candidate)
  if (inner === '' || inner.startsWith('..') || isAbsolute(inner)) {
    throw new CompatFailure('bad-path', 'path escapes the pack folder: ' + candidate)
  }
}

function localizedOf(value: unknown): LocalizedText | null {
  if (typeof value === 'string') {
    const text = value.trim()
    return text === '' ? null : { zh: text, en: text }
  }
  if (!isRecord(value)) return null
  const zh = typeof value.zh === 'string' ? value.zh.trim() : ''
  const en = typeof value.en === 'string' ? value.en.trim() : ''
  if (zh === '' && en === '') return null
  return { zh: zh === '' ? en : zh, en: en === '' ? zh : en }
}

// ── the index document ──────────────────────────────────────────────────────

export type IndexParse =
  | { ok: true; index: CompatIndex; warnings: string[] }
  | { ok: false; error: string }

function fileOf(value: unknown, label: string): { file: CompatFile } | { error: string } {
  if (!isRecord(value)) return { error: label + ': a file entry is not an object' }
  const path = safeRelativePath(value.path)
  if (path === null) return { error: label + ': unsafe file path ' + JSON.stringify(value.path) }
  const url = typeof value.url === 'string' ? parsePackUrl(value.url) : null
  if (url === null) return { error: label + ': file ' + path + ' needs an https URL (http only on loopback)' }
  const bytes = typeof value.bytes === 'number' && Number.isInteger(value.bytes) && value.bytes >= 0 ? value.bytes : -1
  if (bytes < 0) return { error: label + ': file ' + path + ' needs integer bytes' }
  if (bytes > MAX_FILE_BYTES) return { error: label + ': file ' + path + ' is larger than ' + MAX_FILE_BYTES + ' bytes' }
  const sha256 = typeof value.sha256 === 'string' ? value.sha256.trim().toLowerCase() : ''
  if (!SHA256.test(sha256)) return { error: label + ': file ' + path + ' needs a 64-character sha256' }
  return { file: { path, url: url.href, bytes, sha256 } }
}

function packOf(value: unknown): { ok: true; pack: CompatPack } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'a pack entry is not an object' }
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const label = 'pack ' + (id === '' ? '(no id)' : '"' + id + '"')
  if (!ID.test(id)) return { ok: false, error: label + ': id must match ^[a-z0-9][a-z0-9_-]{0,31}$' }
  const name = localizedOf(value.name)
  if (name === null) return { ok: false, error: label + ': name needs zh and en' }
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  if (version === '' || version.length > 64) return { ok: false, error: label + ': version is required (at most 64 characters)' }
  const description = localizedOf(value.description) ?? undefined
  if (!Array.isArray(value.files) || value.files.length === 0) {
    return { ok: false, error: label + ': files must be a non-empty array' }
  }
  const files: CompatFile[] = []
  const paths = new Set<string>()
  let total = 0
  for (const item of value.files) {
    const parsed = fileOf(item, label)
    if ('error' in parsed) return { ok: false, error: parsed.error }
    const key = parsed.file.path.toLowerCase()
    if (paths.has(key)) return { ok: false, error: label + ': duplicate file path ' + parsed.file.path }
    paths.add(key)
    total += parsed.file.bytes
    if (total > MAX_PACK_BYTES) return { ok: false, error: label + ': files total more than ' + MAX_PACK_BYTES + ' bytes' }
    files.push(parsed.file)
  }
  return {
    ok: true,
    pack: { id, name, version, ...(description === undefined ? {} : { description }), files },
  }
}

/**
 * Validate one catalog document. A malformed pack is skipped with a warning so one bad entry
 * cannot hide the rest; a document that is not a schema-1 catalog is refused outright.
 */
export function normalizeIndex(raw: unknown): IndexParse {
  if (!isRecord(raw)) return { ok: false, error: 'the index must be a JSON object' }
  if (raw.schema !== INDEX_SCHEMA) return { ok: false, error: 'schema must be ' + INDEX_SCHEMA }
  if (!Array.isArray(raw.packs)) return { ok: false, error: 'packs must be an array' }
  const warnings: string[] = []
  const packs: CompatPack[] = []
  const seen = new Set<string>()
  for (const value of raw.packs) {
    const parsed = packOf(value)
    if (!parsed.ok) {
      warnings.push(parsed.error)
      continue
    }
    if (seen.has(parsed.pack.id)) {
      warnings.push('pack "' + parsed.pack.id + '" is listed twice; the first entry wins')
      continue
    }
    seen.add(parsed.pack.id)
    packs.push(parsed.pack)
  }
  return { ok: true, index: { packs }, warnings }
}

// ── fetching ────────────────────────────────────────────────────────────────

async function fetchBytes(url: URL, limit: number, accept: string): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  timer.unref?.()
  try {
    let response: Response
    try {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { accept },
      })
    }
    catch (error) {
      throw new CompatFailure('download-failed', 'cannot reach ' + url.href + ': ' + errorText(error))
    }
    if (!response.ok) throw new CompatFailure('download-failed', url.href + ' answered HTTP ' + response.status)
    if (parsePackUrl(response.url) === null) {
      throw new CompatFailure('bad-url', url.href + ' redirected to a URL that is not https or loopback')
    }
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > limit) {
      throw new CompatFailure('size-limit', url.href + ' is larger than ' + limit + ' bytes')
    }
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.byteLength > limit) throw new CompatFailure('size-limit', url.href + ' is larger than ' + limit + ' bytes')
    return body
  }
  finally {
    clearTimeout(timer)
  }
}

/** Cache entry plus when the document behind it was actually fetched. */
interface CacheEntry {
  at: number
  index: CompatIndex
  fetchedAt: string
  warnings: string[]
}

/**
 * One catalog per host. The cache is keyed by both URLs, so changing a setting reads the network
 * again instead of serving another endpoint's document; a manual refresh bypasses it.
 */
export class CompatCatalog {
  private readonly cache = new Map<string, CacheEntry>()

  async load(settings: CatalogSettings, force = false): Promise<CatalogResult> {
    const indexUrl = parsePackUrl(settings.indexUrl)
    if (indexUrl === null) {
      throw new CompatFailure('bad-url', 'compat.indexUrl must be https, or http on loopback: ' + settings.indexUrl)
    }
    const mirrorUrl = settings.mirrorUrl.trim() === '' ? null : parsePackUrl(settings.mirrorUrl)
    if (settings.mirrorUrl.trim() !== '' && mirrorUrl === null) {
      throw new CompatFailure('bad-url', 'compat.mirrorUrl must be https, or http on loopback: ' + settings.mirrorUrl)
    }
    const minutes = Number.isFinite(settings.cacheMinutes) && settings.cacheMinutes > 0 ? settings.cacheMinutes : 0
    const key = indexUrl.href + '|' + (mirrorUrl === null ? '' : mirrorUrl.href)
    const cached = this.cache.get(key)
    if (!force && minutes > 0 && cached !== undefined && Date.now() - cached.at < minutes * 60_000) {
      return { index: cached.index, source: 'cache', fetchedAt: cached.fetchedAt, warnings: cached.warnings }
    }
    const attempts: string[] = []
    for (const [source, url] of [['index', indexUrl], ['mirror', mirrorUrl]] as const) {
      if (url === null) continue
      try {
        const body = await fetchBytes(url, MAX_INDEX_BYTES, 'application/json, text/plain;q=0.9')
        let raw: unknown
        try {
          raw = JSON.parse(new TextDecoder().decode(body))
        }
        catch (error) {
          throw new CompatFailure('bad-index', 'the index is not JSON: ' + errorText(error))
        }
        const parsed = normalizeIndex(raw)
        if (!parsed.ok) throw new CompatFailure('bad-index', parsed.error)
        const entry: CacheEntry = {
          at: Date.now(),
          index: parsed.index,
          fetchedAt: new Date().toISOString(),
          warnings: parsed.warnings,
        }
        this.cache.set(key, entry)
        return { index: entry.index, source, fetchedAt: entry.fetchedAt, warnings: entry.warnings }
      }
      catch (error) {
        attempts.push(source + ': ' + errorText(error))
      }
    }
    throw new CompatFailure('index-unavailable', 'the official pack index could not be read (' + attempts.join('; ') + ')')
  }
}

// ── installing one pack ─────────────────────────────────────────────────────

function stampOf(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

async function copyTree(source: string, target: string): Promise<number> {
  let files = 0
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      await mkdir(to)
      files += await copyTree(from, to)
    }
    else if (entry.isFile()) {
      await copyFile(from, to)
      files += 1
    }
  }
  return files
}

/** One backup folder, claimed exclusively so two installs cannot share a name. */
async function backupCopy(id: string, source: string, backupRoot: string): Promise<string> {
  const root = resolve(backupRoot)
  await mkdir(root, { recursive: true })
  const base = 'extensions-' + id + '-' + stampOf(new Date())
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = join(root, attempt === 1 ? base : base + '-' + String(attempt))
    try {
      await mkdir(candidate)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw new CompatFailure('write-failed', 'could not claim a backup folder: ' + errorText(error))
    }
    try {
      await copyTree(source, candidate)
      return candidate
    }
    catch (error) {
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined)
      throw new CompatFailure('write-failed', 'could not back up the current copy: ' + errorText(error))
    }
  }
  throw new CompatFailure('write-failed', 'could not claim a backup folder for ' + id)
}

/**
 * Download and install one pack into <root>/<id>.
 *
 * The order is the contract: every file is fetched and verified into a hidden staging folder
 * first, then the existing copy (if any) is backed up, and only then is the staging folder
 * renamed into place — a failed verification leaves the current copy untouched and no folder
 * behind. A failed swap puts the previous copy back.
 */
export async function installCompatPack(options: {
  pack: CompatPack
  root: string
  backupRoot: string
}): Promise<CompatInstallResult> {
  const { pack } = options
  if (!ID.test(pack.id)) throw new CompatFailure('bad-path', 'id must match ^[a-z0-9][a-z0-9_-]{0,31}$')
  const root = resolve(options.root)
  const target = resolve(root, pack.id)
  assertInside(root, target)
  const total = pack.files.reduce((sum, file) => sum + file.bytes, 0)
  if (pack.files.length === 0) throw new CompatFailure('bad-index', 'pack "' + pack.id + '" ships no files')
  if (total > MAX_PACK_BYTES) throw new CompatFailure('size-limit', 'pack "' + pack.id + '" is larger than ' + MAX_PACK_BYTES + ' bytes')
  const stamp = stampOf(new Date())
  const staging = join(root, '.compat-' + pack.id + '-' + stamp)
  await mkdir(root, { recursive: true })
  try {
    await mkdir(staging)
    for (const file of pack.files) {
      const body = await fetchBytes(new URL(file.url), MAX_FILE_BYTES, 'application/octet-stream')
      if (body.byteLength !== file.bytes) {
        throw new CompatFailure('verify-failed', file.path + ': expected ' + file.bytes + ' bytes, got ' + body.byteLength)
      }
      const digest = createHash('sha256').update(body).digest('hex')
      if (digest !== file.sha256) {
        throw new CompatFailure('verify-failed', file.path + ': sha256 does not match the index')
      }
      const destination = resolve(staging, file.path)
      assertInside(staging, destination)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, body, { flag: 'wx' })
    }
    const existing = await stat(target).then(info => info.isDirectory(), () => false)
    const backup = existing ? await backupCopy(pack.id, target, options.backupRoot) : ''
    const retired = existing ? join(root, '.retired-' + pack.id + '-' + stamp) : ''
    try {
      if (existing) await rename(target, retired)
      await rename(staging, target)
    }
    catch (error) {
      if (existing) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
        await rename(retired, target).catch(() => undefined)
      }
      throw new CompatFailure('write-failed', 'could not move the pack into place: ' + errorText(error))
    }
    if (existing) await rm(retired, { recursive: true, force: true }).catch(() => undefined)
    return { id: pack.id, version: pack.version, dir: target, backup, files: pack.files.length }
  }
  catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** The id a folder's manifest.json declares; '' when the file cannot be read as one. */
async function manifestIdOf(file: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
    return isRecord(raw) && typeof raw.id === 'string' ? raw.id.trim() : ''
  }
  catch {
    return ''
  }
}

/**
 * Remove one installed pack from <root>/<id>, after backing it up.
 *
 * The order is the contract again: the copy is backed up first, and only then is the folder moved
 * aside in one rename and deleted, so a failed backup or a failed move always leaves the installed
 * copy where it was. The folder has to be an extension folder — a manifest.json, and if that
 * manifest names another id the folder belongs to that extension and is refused — so this op can
 * never delete whatever else happens to sit under the extension root. A copy whose manifest is
 * broken is still removable: that is precisely the folder an owner needs to clean up. The catalog
 * is only read here, and no patch file is touched.
 */
export async function uninstallCompatPack(options: {
  id: string
  root: string
  backupRoot: string
}): Promise<CompatUninstallResult> {
  const { id } = options
  if (!ID.test(id)) throw new CompatFailure('bad-path', 'id must match ^[a-z0-9][a-z0-9_-]{0,31}$')
  const root = resolve(options.root)
  const target = resolve(root, id)
  assertInside(root, target)
  const info = await stat(target).catch(() => null)
  if (info === null || !info.isDirectory()) {
    throw new CompatFailure('not-installed', 'no local copy of "' + id + '" under ' + root)
  }
  const manifestFile = join(target, 'manifest.json')
  const hasManifest = await stat(manifestFile).then(entry => entry.isFile(), () => false)
  if (!hasManifest) {
    throw new CompatFailure('not-extension', '"' + id + '" is not an extension folder: no manifest.json')
  }
  const declared = await manifestIdOf(manifestFile)
  if (declared !== '' && declared !== id) {
    throw new CompatFailure('not-extension', 'the folder under "' + id + '" is registered as "' + declared + '"')
  }
  const backup = await backupCopy(id, target, options.backupRoot)
  // Rename before deleting: the id is freed in one step, and a half-deleted folder can never be
  // discovered again. A dot name is skipped by discovery, so a leftover retired folder is inert.
  const retired = join(root, '.retired-' + id + '-' + stampOf(new Date()))
  try {
    await rename(target, retired)
  }
  catch (error) {
    throw new CompatFailure('write-failed', 'could not remove the local copy: ' + errorText(error))
  }
  await rm(retired, { recursive: true, force: true }).catch(() => undefined)
  return { id, backup }
}
