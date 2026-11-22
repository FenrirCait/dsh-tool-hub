/**
 * Local extensions: one folder per extension, a manifest and an ESM host entry.
 *
 * The loader is deliberately small and strict: an extension may add ops and settings under its
 * own id namespace, nothing else. It cannot replace a built-in op, and a broken extension is a
 * status row with an error, never a host failure. Extensions are trusted local code (same process,
 * full file access); the panel only switches them on for their owner.
 */
import { constants, copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { backupDir, stateDir } from '../core/io.js'
import type { DomainRegistration } from '../shared/contract.js'
import type { DomainModule, LocalizedText } from '../shared/types.js'

export const EXTENSION_API_VERSION = 1

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const RESERVED = new Set([
  'core', 'extension', 'extensions', 'plugins', 'skills', 'mcp', 'groups', 'presets',
  'scenes', 'sessions', 'settings', 'tool-surface', 'config',
])
const VIEW_KINDS = new Set(['table', 'list', 'json'])
const MAX_MANIFEST = 64 * 1024
const MAX_STYLES = 8
const MAX_STYLE_BYTES = 256 * 1024

export interface ExtensionView {
  id: string
  title: LocalizedText
  /** How the panel renders the read op's answer. */
  kind: 'table' | 'list' | 'json'
  /** A read-only op declared by the same extension. */
  op: string
}

export interface ExtensionManifest {
  id: string
  name: LocalizedText
  version: string
  apiVersion: number
  description?: LocalizedText
  host: string
  views: ExtensionView[]
  /** Relative CSS files the panel injects while this extension is loaded. */
  styles: string[]
}

export interface ExtensionStatus {
  id: string
  name: LocalizedText
  version: string
  apiVersion: number
  dir: string
  enabled: boolean
  loaded: boolean
  error: string | null
  ops: string[]
  views: ExtensionView[]
  /** Declared style paths, kept even while disabled. */
  styles: string[]
  /** CSS text of the declared styles, loaded only while enabled. */
  css: string[]
  /** True when the folder comes from the plugin package's own compat/ directory. */
  bundled: boolean
  /** True when this local copy shadows a bundled pack with the same id; a bundled row is false. */
  overridesBundled: boolean
  /**
   * The version the package ships for this id, recorded even when a local copy wins discovery;
   * '' when the package ships no pack under this id. The card compares it with version to decide
   * whether the local copy is behind the pack.
   */
  bundledVersion: string
  /** The manifest's description, when it declared one. */
  description?: LocalizedText
}

export interface ExtensionDiscovered {
  manifest: ExtensionManifest
  dir: string
  hostFile: string
  bundled: boolean
  /** Set when a later bundled root carried the same id: this copy is the one that won. */
  overridesBundled?: boolean
  /** The bundled copy's version; '' for a local folder no pack shadows. */
  bundledVersion: string
}

export interface ExtensionLoadResult {
  registrations: Array<{ status: ExtensionStatus; registration: DomainRegistration }>
  statuses: ExtensionStatus[]
}

export interface ExtensionManagerOptions {
  roots: string[]
  services: { get(name: string): unknown }
  log: (level: 'info' | 'warn', message: string) => void
}

/**
 * Profile-scoped first, then the shared home folder, then the packs bundled with the package.
 * A profile copy wins on an id clash; bundled packs are read-only until the owner enables them,
 * so they appear in the Extensions page without being copied into the profile.
 */
const BUNDLED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'compat')

export function extensionRoots(): string[] {
  const roots = [join(stateDir(), 'extensions'), join(homedir(), '.dsh', 'tool-hub', 'extensions'), BUNDLED_ROOT]
  return [...new Set(roots.map(root => resolve(root)))]
}

/** Where the package's own compat pack for an id lives. */
function bundledExtensionDir(id: string): string {
  return join(BUNDLED_ROOT, id)
}

/** What the panel's "copy to local" op answers: the folder it made, or why it made none. */
export type InstallBundledResult =
  | { ok: true; dir: string; files: number }
  | { ok: false; reason: 'invalid-id' | 'missing-bundled' | 'already-installed' | 'copy-failed'; message: string }

/**
 * Regular files only: a link inside a pack is skipped rather than followed out of the folder.
 *
 * An install claims a fresh folder, so its copies are exclusive and can never overwrite a file
 * even in a race. An update copies back into a folder that has just been emptied from the pack's
 * own tree, so there it overwrites — which is exactly what "replace the local copy" means.
 */
async function copyTree(source: string, target: string, overwrite = false): Promise<number> {
  let files = 0
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      await mkdir(to)
      files += await copyTree(from, to, overwrite)
    }
    else if (entry.isFile()) {
      await copyFile(from, to, overwrite ? 0 : constants.COPYFILE_EXCL)
      files += 1
    }
  }
  return files
}

/**
 * Copy one bundled compat pack into the profile extension root, so the owner can edit it.
 *
 * The profile root is first in extensionRoots(), so the copy wins discovery and the page shows it
 * as a local override. Never overwrites: the target folder is claimed with a non-recursive mkdir
 * (an existing folder is refused before anything is written) and a half-written copy is removed
 * again. Returns the target dir, or a reason the caller turns into a failure code.
 */
export async function installBundledExtension(id: string): Promise<InstallBundledResult> {
  if (!ID.test(id)) return { ok: false, reason: 'invalid-id', message: 'id must match ^[a-z0-9][a-z0-9_-]{0,31}$' }
  const source = bundledExtensionDir(id)
  const info = await stat(source).catch(() => null)
  if (info === null || !info.isDirectory()) {
    return { ok: false, reason: 'missing-bundled', message: `no bundled extension "${id}"` }
  }
  const parent = join(stateDir(), 'extensions')
  const target = join(parent, id)
  await mkdir(parent, { recursive: true })
  try {
    // Non-recursive on purpose: EEXIST is the refusal, and it is atomic against another copy.
    await mkdir(target)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, reason: 'already-installed', message: `a local extension "${id}" already exists` }
    }
    throw error
  }
  try {
    const files = await copyTree(source, target)
    return { ok: true, dir: target, files }
  }
  catch (error) {
    await rm(target, { recursive: true, force: true })
    return { ok: false, reason: 'copy-failed', message: errorText(error) }
  }
}

/** What the panel's "update the local copy" op answers: where it wrote, and what it installed. */
export type UpdateBundledResult =
  | { ok: true; dir: string; backup: string; version: string }
  | { ok: false; reason: 'invalid-id' | 'missing-bundled' | 'missing-local' | 'copy-failed'; message: string }

/** The version a pack's manifest declares; '' when it cannot be read, which the caller treats as unknown. */
async function packVersion(dir: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as unknown
    return isRecord(raw) && typeof raw.version === 'string' ? raw.version.trim() : ''
  }
  catch {
    return ''
  }
}

/** One backup folder, claimed with a non-recursive mkdir so two updates cannot share a name. */
async function claimBackupFolder(id: string): Promise<string> {
  const dir = backupDir()
  await mkdir(dir, { recursive: true })
  const base = 'extensions-' + id + '-' + new Date().toISOString().replace(/[:.]/g, '-')
  for (let index = 1; index <= 50; index += 1) {
    const candidate = join(dir, index === 1 ? base : base + '-' + String(index))
    try {
      await mkdir(candidate)
      return candidate
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('could not claim a backup folder for ' + id)
}

/**
 * Replace a local copy of a bundled pack with the copy the package ships.
 *
 * The order is the whole contract: the current local folder is copied (never moved) into
 * backupDir()/extensions-<id>-<stamp> first, and only then is it rebuilt from compat/<id>. A
 * failed overwrite puts the backup back, so the row never points at a half-written folder.
 * Nothing else is written: the pack is only read, and no patch file is ever touched.
 */
export async function updateBundledExtension(id: string): Promise<UpdateBundledResult> {
  if (!ID.test(id)) return { ok: false, reason: 'invalid-id', message: 'id must match ^[a-z0-9][a-z0-9_-]{0,31}$' }
  const source = bundledExtensionDir(id)
  const bundledInfo = await stat(source).catch(() => null)
  if (bundledInfo === null || !bundledInfo.isDirectory()) {
    return { ok: false, reason: 'missing-bundled', message: `no bundled extension "${id}"` }
  }
  const target = join(stateDir(), 'extensions', id)
  const localInfo = await stat(target).catch(() => null)
  if (localInfo === null || !localInfo.isDirectory()) {
    return { ok: false, reason: 'missing-local', message: `no local extension "${id}" under ${join(stateDir(), 'extensions')}` }
  }
  const version = await packVersion(source)
  let backup = ''
  try {
    backup = await claimBackupFolder(id)
    await copyTree(target, backup)
  }
  catch (error) {
    return { ok: false, reason: 'copy-failed', message: 'backup: ' + errorText(error) }
  }
  try {
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await copyTree(source, target)
  }
  catch (error) {
    let restored = false
    try {
      await rm(target, { recursive: true, force: true })
      await mkdir(target, { recursive: true })
      await copyTree(backup, target)
      restored = true
    }
    catch {
      restored = false
    }
    return {
      ok: false,
      reason: 'copy-failed',
      message: `${errorText(error)}; backup in ${backup}${restored ? ' (the local copy was restored)' : ' (restore failed, copy it back by hand)'}`,
    }
  }
  return { ok: true, dir: target, backup, version }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function localized(value: unknown): LocalizedText | null {
  if (!isRecord(value)) return null
  const zh = typeof value.zh === 'string' ? value.zh.trim() : ''
  const en = typeof value.en === 'string' ? value.en.trim() : ''
  if (zh === '' || en === '') return null
  return { zh, en }
}

function fallbackName(id: string): LocalizedText {
  return { zh: id, en: id }
}

function viewOf(value: unknown, index: number): ExtensionView | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' && ID.test(value.id) ? value.id : `view${index + 1}`
  const title = localized(value.title) ?? fallbackName(id)
  const kind = typeof value.kind === 'string' && VIEW_KINDS.has(value.kind) ? value.kind : 'json'
  const op = typeof value.op === 'string' ? value.op.trim() : ''
  if (op === '') return null
  return { id, title, kind: kind as ExtensionView['kind'], op }
}

export type ManifestResult = { ok: true; manifest: ExtensionManifest } | { ok: false; error: string }

/** Validate one manifest against the v1 contract; every rejection names the field. */
export function normalizeManifest(raw: unknown): ManifestResult {
  if (!isRecord(raw)) return { ok: false, error: 'manifest must be a JSON object' }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!ID.test(id)) return { ok: false, error: 'id must match ^[a-z0-9][a-z0-9_-]{0,31}$' }
  if (RESERVED.has(id)) return { ok: false, error: `id "${id}" is reserved` }
  const name = localized(raw.name)
  if (name === null) return { ok: false, error: 'name needs zh and en' }
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  if (version === '') return { ok: false, error: 'version is required' }
  if (raw.apiVersion !== EXTENSION_API_VERSION) {
    return { ok: false, error: `apiVersion must be ${EXTENSION_API_VERSION}` }
  }
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  if (host === '' || isAbsolute(host) || host.split(/[\\/]/).includes('..')) {
    return { ok: false, error: 'host must be a relative path inside the extension folder' }
  }
  const views: ExtensionView[] = []
  if (raw.views !== undefined) {
    if (!Array.isArray(raw.views)) return { ok: false, error: 'views must be an array' }
    const seen = new Set<string>()
    raw.views.forEach((value, index) => {
      const view = viewOf(value, index)
      if (view === null) return
      if (seen.has(view.id)) return
      seen.add(view.id)
      views.push(view)
    })
  }
  const styles: string[] = []
  if (raw.styles !== undefined) {
    if (!Array.isArray(raw.styles)) return { ok: false, error: 'styles must be an array of relative .css paths' }
    if (raw.styles.length > MAX_STYLES) return { ok: false, error: 'styles may declare at most ' + MAX_STYLES + ' files' }
    for (const value of raw.styles) {
      const file = typeof value === 'string' ? value.trim() : ''
      if (file === '' || isAbsolute(file) || file.split(/[\\/]/).includes('..') || !file.toLowerCase().endsWith('.css')) {
        return { ok: false, error: 'every styles entry must be a relative .css path inside the extension folder' }
      }
      if (!styles.includes(file)) styles.push(file)
    }
  }
  const description = localized(raw.description) ?? undefined
  return { ok: true, manifest: { id, name, version, apiVersion: EXTENSION_API_VERSION, ...(description === undefined ? {} : { description }), host, views, styles } }
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 300)
}

export class ExtensionManager {
  private readonly cache = new Map<string, { key: string; registration: DomainRegistration }>()

  constructor(private readonly options: ExtensionManagerOptions) {}

  private async discover(): Promise<{ entries: ExtensionDiscovered[]; problems: ExtensionStatus[] }> {
    const entries: ExtensionDiscovered[] = []
    const problems: ExtensionStatus[] = []
    // First root wins on an id clash; the map keeps the winner so a later bundled folder with the
    // same id can mark it as the local copy that shadows the pack.
    const seen = new Map<string, ExtensionDiscovered>()
    for (const root of this.options.roots) {
      const bundled = resolve(root) === BUNDLED_ROOT
      let names: string[] = []
      try {
        names = await readdir(root)
      }
      catch {
        continue
      }
      for (const name of names.sort()) {
        if (name.startsWith('.')) continue
        const extDir = join(root, name)
        const info = await stat(extDir).catch(() => null)
        if (info === null || !info.isDirectory()) continue
        let text = ''
        try {
          const manifestFile = join(extDir, 'manifest.json')
          const size = (await stat(manifestFile)).size
          if (size > MAX_MANIFEST) throw new Error('manifest is larger than 64 KB')
          text = await readFile(manifestFile, 'utf8')
        }
        catch (error) {
          problems.push({
            id: name, name: fallbackName(name), version: '', apiVersion: EXTENSION_API_VERSION,
            dir: extDir, enabled: false, loaded: false, error: 'manifest.json: ' + errorText(error), ops: [], views: [], styles: [], css: [], bundled, overridesBundled: false, bundledVersion: '',
          })
          continue
        }
        let raw: unknown = null
        try {
          raw = JSON.parse(text)
        }
        catch (error) {
          problems.push({
            id: name, name: fallbackName(name), version: '', apiVersion: EXTENSION_API_VERSION,
            dir: extDir, enabled: false, loaded: false, error: 'manifest.json is not JSON: ' + errorText(error), ops: [], views: [], styles: [], css: [], bundled, overridesBundled: false, bundledVersion: '',
          })
          continue
        }
        const normalized = normalizeManifest(raw)
        if (!normalized.ok) {
          problems.push({
            id: name, name: fallbackName(name), version: '', apiVersion: EXTENSION_API_VERSION,
            dir: extDir, enabled: false, loaded: false, error: normalized.error, ops: [], views: [], styles: [], css: [], bundled, overridesBundled: false, bundledVersion: '',
          })
          continue
        }
        const manifest = normalized.manifest
        const winner = seen.get(manifest.id)
        if (winner !== undefined) {
          // extensionRoots() lists the bundled root last, so a local copy always wins the id; this
          // is the one shadow the page has to explain, and the bundled duplicate stays hidden —
          // but its version is kept on the winner, which is how the page knows the copy is behind.
          if (bundled && !winner.bundled) {
            winner.overridesBundled = true
            winner.bundledVersion = manifest.version
          }
          continue
        }
        const entry: ExtensionDiscovered = {
          manifest, dir: extDir, hostFile: resolve(extDir, manifest.host), bundled,
          bundledVersion: bundled ? manifest.version : '',
        }
        seen.set(manifest.id, entry)
        entries.push(entry)
      }
    }
    return { entries, problems }
  }

  /** Load every enabled extension; disabled or broken ones are status rows, never throws. */
  async load(enabled: readonly string[]): Promise<ExtensionLoadResult> {
    const discovered = await this.discover()
    const wanted = new Set(enabled)
    const known = new Set(discovered.entries.map(entry => entry.manifest.id))
    const statuses: ExtensionStatus[] = [...discovered.problems]
    const registrations: ExtensionLoadResult['registrations'] = []

    for (const entry of discovered.entries) {
      const { manifest, dir, hostFile } = entry
      const on = wanted.has(manifest.id)
      if (!on) {
        statuses.push({
          id: manifest.id, name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion,
          dir, enabled: false, loaded: false, error: null, ops: [], views: manifest.views,
          styles: manifest.styles, css: [], bundled: entry.bundled, overridesBundled: entry.overridesBundled === true,
          bundledVersion: entry.bundledVersion,
          ...(manifest.description === undefined ? {} : { description: manifest.description }),
        })
        continue
      }
      const loaded = await this.loadOne(entry)
      statuses.push(loaded.status)
      if (loaded.registration !== undefined) registrations.push({ status: loaded.status, registration: loaded.registration })
    }
    for (const id of wanted) {
      if (known.has(id)) continue
      statuses.push({
        id, name: fallbackName(id), version: '', apiVersion: EXTENSION_API_VERSION,
        dir: '', enabled: true, loaded: false, error: 'extension folder not found', ops: [], views: [],
        styles: [], css: [], bundled: false, overridesBundled: false, bundledVersion: '',
      })
    }
    statuses.sort((left, right) => left.id.localeCompare(right.id))
    return { registrations, statuses }
  }

  private async loadOne(entry: ExtensionDiscovered): Promise<{ status: ExtensionStatus; registration?: DomainRegistration }> {
    const { manifest, dir, hostFile } = entry
    const base = {
      id: manifest.id, name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion,
      dir, enabled: true, views: manifest.views, styles: manifest.styles, bundled: entry.bundled,
      overridesBundled: entry.overridesBundled === true, bundledVersion: entry.bundledVersion,
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
    }
    let key = ''
    let css: string[] = []
    try {
      const info = await stat(hostFile)
      if (!info.isFile()) throw new Error('host entry is not a file')
      key = `${Math.trunc(info.mtimeMs)}:${info.size}`
      for (const file of manifest.styles) {
        const styleFile = resolve(dir, file)
        const styleInfo = await stat(styleFile)
        if (!styleInfo.isFile()) throw new Error('style is not a file: ' + file)
        if (styleInfo.size > MAX_STYLE_BYTES) throw new Error('style is larger than 256 KB: ' + file)
        key += ':' + Math.trunc(styleInfo.mtimeMs) + ':' + styleInfo.size
        css.push(await readFile(styleFile, 'utf8'))
      }
    }
    catch (error) {
      return { status: { ...base, loaded: false, error: 'host entry: ' + errorText(error), ops: [], css: [] } }
    }
    const cached = this.cache.get(manifest.id)
    if (cached !== undefined && cached.key === key) {
      return {
        status: { ...base, loaded: true, error: null, ops: cached.registration.module.ops.map(op => op.id), css },
        registration: cached.registration,
      }
    }
    try {
      const moduleUrl = pathToFileURL(hostFile).href + '?v=' + encodeURIComponent(key)
      const loaded = await import(moduleUrl) as { default?: unknown }
      const activate = loaded.default
      if (typeof activate !== 'function') throw new Error('the host entry must default-export an activate(api) function')
      const api = {
        version: EXTENSION_API_VERSION,
        id: manifest.id,
        dir,
        log: this.options.log,
        services: this.options.services,
      }
      const registration = await (activate as (api: unknown) => DomainRegistration | Promise<DomainRegistration>)(api)
      const checked = validateRegistration(manifest, registration)
      this.cache.set(manifest.id, { key, registration: checked })
      return {
        status: { ...base, loaded: true, error: null, ops: checked.module.ops.map(op => op.id), css },
        registration: checked,
      }
    }
    catch (error) {
      this.cache.delete(manifest.id)
      return { status: { ...base, loaded: false, error: errorText(error), ops: [], css: [] } }
    }
  }

  /** Forget cached code for one extension (or all) so the next build re-imports it. */
  invalidate(id?: string): void {
    if (id === undefined) this.cache.clear()
    else this.cache.delete(id)
  }
}

/** The namespace and view rules, checked before a registration can join the registry. */
export function validateRegistration(manifest: ExtensionManifest, value: unknown): DomainRegistration {
  if (!isRecord(value)) throw new Error('activate() must return { module, handlers }')
  const module = value.module as DomainModule | undefined
  const handlers = value.handlers as Record<string, unknown> | undefined
  if (!isRecord(module) || typeof module.id !== 'string') throw new Error('registration.module is missing')
  if (module.id !== manifest.id) throw new Error(`module id "${module.id}" must equal the extension id`)
  if (!Array.isArray(module.ops)) throw new Error('module.ops must be an array')
  if (!isRecord(handlers)) throw new Error('registration.handlers must be an object')
  const opIds = new Set<string>()
  for (const op of module.ops) {
    if (!isRecord(op) || typeof op.id !== 'string') throw new Error('every op needs a string id')
    if (!op.id.startsWith(manifest.id + '.')) throw new Error(`op "${op.id}" must start with "${manifest.id}."`)
    if (opIds.has(op.id)) throw new Error(`duplicate op ${op.id}`)
    if (typeof op.write !== 'boolean') throw new Error(`op ${op.id} needs a boolean write`)
    opIds.add(op.id)
  }
  for (const id of Object.keys(handlers)) {
    if (!opIds.has(id)) throw new Error(`handler for undeclared op ${id}`)
    if (typeof handlers[id] !== 'function') throw new Error(`handler for ${id} is not a function`)
  }
  for (const id of opIds) {
    if (typeof handlers[id] !== 'function') throw new Error(`op ${id} has no handler`)
  }
  for (const view of manifest.views) {
    if (!opIds.has(view.op)) throw new Error(`view "${view.id}" points at undeclared op ${view.op}`)
    const op = module.ops.find(entry => entry.id === view.op)
    if (op?.write === true) throw new Error(`view "${view.id}" must point at a read op`)
  }
  const settings = Array.isArray(module.settings) ? module.settings : undefined
  return {
    module: {
      id: module.id,
      title: localized(module.title) ?? manifest.name,
      ops: module.ops.map(op => ({
        id: op.id as string,
        write: op.write as boolean,
        audit: op.audit === true,
        note: typeof op.note === 'string' ? op.note : '',
      })),
      settings,
    },
    handlers: handlers as DomainRegistration['handlers'],
  }
}
