/**
 * Local extensions: one folder per extension, a manifest and an ESM host entry.
 *
 * The loader is deliberately small and strict: an extension may add ops and settings under its
 * own id namespace, nothing else. It cannot replace a built-in op, and a broken extension is a
 * status row with an error, never a host failure. Extensions are trusted local code (same process,
 * full file access); the panel only switches them on for their owner.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stateDir } from '../core/io.js'
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
}

export interface ExtensionDiscovered {
  manifest: ExtensionManifest
  dir: string
  hostFile: string
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
export function extensionRoots(): string[] {
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'compat')
  const roots = [join(stateDir(), 'extensions'), join(homedir(), '.dsh', 'tool-hub', 'extensions'), bundled]
  return [...new Set(roots.map(root => resolve(root)))]
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
    const seen = new Set<string>()
    for (const root of this.options.roots) {
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
            dir: extDir, enabled: false, loaded: false, error: 'manifest.json: ' + errorText(error), ops: [], views: [], styles: [], css: [],
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
            dir: extDir, enabled: false, loaded: false, error: 'manifest.json is not JSON: ' + errorText(error), ops: [], views: [], styles: [], css: [],
          })
          continue
        }
        const normalized = normalizeManifest(raw)
        if (!normalized.ok) {
          problems.push({
            id: name, name: fallbackName(name), version: '', apiVersion: EXTENSION_API_VERSION,
            dir: extDir, enabled: false, loaded: false, error: normalized.error, ops: [], views: [], styles: [], css: [],
          })
          continue
        }
        const manifest = normalized.manifest
        if (seen.has(manifest.id)) continue
        seen.add(manifest.id)
        entries.push({ manifest, dir: extDir, hostFile: resolve(extDir, manifest.host) })
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
          styles: manifest.styles, css: [],
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
        styles: [], css: [],
      })
    }
    statuses.sort((left, right) => left.id.localeCompare(right.id))
    return { registrations, statuses }
  }

  private async loadOne(entry: ExtensionDiscovered): Promise<{ status: ExtensionStatus; registration?: DomainRegistration }> {
    const { manifest, dir, hostFile } = entry
    const base = {
      id: manifest.id, name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion,
      dir, enabled: true, views: manifest.views, styles: manifest.styles,
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
