/**
 * State schema version 2.
 *
 * Version 1 is the 1.x file: flat groups/collections/presets/toolDeny/lazyServers/lazyLoaded/
 * auto/sessions/scenes/mode. Version 2 adds `settings` and `modules` and keeps every 1.x key where
 * it was, so a rollback to 1.1.0 still reads the file.
 *
 * {@link migrate} is the single place that decides what a document means. It is pure (never
 * mutates its input, never throws) and total (every JSON value has a v2 answer), and it carries
 * top-level keys it does not recognise through unchanged: a state file from a build that knows
 * more fields than this one must survive a read/write round trip untouched instead of being
 * silently stripped by the upgrade.
 */

/** The schema version this build reads and writes. */
export const STATE_VERSION = 2

/** The schema version this build writes, as a function for callers that only want the number. */
export function schemaVersion(): number {
  return STATE_VERSION
}

/** The drawer every installation starts with, so no group is ever homeless. */
export const DEFAULT_COLLECTION = { id: 'default', name: '默认分组群', order: 0 }

export interface StateAuto {
  appliedAt: number | null
  [key: string]: unknown
}

export interface StateV2 {
  version: 2
  groups: unknown[]
  collections: unknown[]
  presets: unknown[]
  toolDeny: string[]
  auto: StateAuto
  sessions: Record<string, string[]>
  scenes: Record<string, unknown>
  mode: unknown | null
  settings: Record<string, unknown>
  modules: Record<string, unknown>
  /** 1.x lazy-loading lists, carried through so the lazy domain reads them without a cast. */
  lazyServers?: string[]
  lazyLoaded?: string[]
}

/** A fresh v2 document: exactly what a first run starts from. */
export function emptyState(): StateV2 {
  return {
    version: STATE_VERSION,
    groups: [],
    collections: [{ ...DEFAULT_COLLECTION }],
    presets: [],
    toolDeny: [],
    auto: { appliedAt: null },
    sessions: {},
    scenes: {},
    mode: null,
    settings: {},
    modules: {},
  }
}

type Record_ = Record<string, unknown>

/** Keys this module understands; everything else is passed through untouched. */
const KNOWN_KEYS = new Set([
  'version',
  'groups',
  'collections',
  'presets',
  'toolDeny',
  'auto',
  'sessions',
  'scenes',
  'mode',
  'settings',
  'modules',
  'lazyServers',
  'lazyLoaded',
])

/** Keys that would replace a prototype if they were spread out of a hostile file. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** An array of plain objects; non-object entries are dropped, the rest are kept verbatim. */
function recordList(value: unknown): Record_[] | null {
  if (!Array.isArray(value)) return null
  return value.filter(isRecord)
}

/** An array of strings; non-string entries are dropped. */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** A plain object copied one level deep, so later writes never reach the caller's document. */
function recordMap(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  return { ...value }
}

/** Session overlays: opaque session ids mapped to the tool names that session switched off. */
function sessionMap(value: unknown): Record<string, string[]> | null {
  if (!isRecord(value)) return null
  const out: Record<string, string[]> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === '' || key.length > 200) continue
    const names = stringList(entry)
    if (names === null) continue
    out[key] = names
  }
  return out
}

/** Saved scenes: the key is the scene name, the value must be a scene record. */
function sceneMap(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    out[key] = entry
  }
  return out
}

/** `auto.appliedAt` is the only field with a type of its own; other fields ride along. */
function normalizeAuto(value: unknown): StateAuto | null {
  if (!isRecord(value)) return null
  return { ...value, appliedAt: isFiniteNumber(value.appliedAt) ? value.appliedAt : null }
}

/** Top-level keys this module does not know, kept so a newer file is not truncated on save. */
function unknownKeys(source: Record_): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (KNOWN_KEYS.has(key) || UNSAFE_KEYS.has(key)) continue
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * Pure and total: a 1.x document, a 2.x document, or nothing at all becomes a v2 document.
 *
 * Every field is validated on its own: a wrong container type falls back to the empty-state
 * default, and entries inside an array or map are filtered to the shape the field promises. A
 * field that is already correct is carried through by reference-free copy, so a round trip through
 * save/load does not change the document's meaning.
 */
export function migrate(raw: unknown): StateV2 {
  const base = emptyState()
  if (!isRecord(raw)) return base
  try {
    const groups = recordList(raw.groups)
    const collections = recordList(raw.collections)
    const presets = recordList(raw.presets)
    const toolDeny = stringList(raw.toolDeny)
    const auto = normalizeAuto(raw.auto)
    const sessions = sessionMap(raw.sessions)
    const scenes = sceneMap(raw.scenes)
    const settings = recordMap(raw.settings)
    const modules = recordMap(raw.modules)
    const lazyServers = stringList(raw.lazyServers)
    const lazyLoaded = stringList(raw.lazyLoaded)

    const out: Record<string, unknown> = { ...unknownKeys(raw), ...base }
    out.version = STATE_VERSION
    // An empty drawer list would leave the rail without its default group, so keep the default.
    if (groups !== null) out.groups = groups
    if (collections !== null && collections.length > 0) out.collections = collections
    if (presets !== null) out.presets = presets
    if (toolDeny !== null) out.toolDeny = toolDeny
    if (auto !== null) out.auto = auto
    if (sessions !== null) out.sessions = sessions
    if (scenes !== null) out.scenes = scenes
    if ('mode' in raw) out.mode = isRecord(raw.mode) ? raw.mode : null
    if (settings !== null) out.settings = settings
    if (modules !== null) out.modules = modules
    if (lazyServers !== null) out.lazyServers = lazyServers
    if (lazyLoaded !== null) out.lazyLoaded = lazyLoaded
    return out as unknown as StateV2
  }
  catch {
    // A document whose getters or proxies throw is treated as unreadable, never as a crash.
    return base
  }
}
