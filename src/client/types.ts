/**
 * Shapes the panel reads off the hub snapshot.
 *
 * The host owns these fields; this file is the client's contract with it. Everything the
 * shell does not already depend on is optional, and api.ts normalises a partial answer into
 * HubSnapshot, so no view has to guard the same field twice.
 */
import type { Lang, TFunction } from './i18n.js'
import type { SettingsField } from '../shared/types.js'

/** What a row can be: the two kinds a group member or a preset entry may name. */
export type Kind = 'plugin' | 'skill'

/** Credential keys the host saw, values stay host-side. */
export interface SecretKeys {
  env: string[]
  headers: string[]
}

/** One loader entry, optionally decorated with the MCP config it came from. */
export interface PluginRow {
  id: string
  name: string
  kind?: string
  moduleName?: string | null
  description?: string
  enabled: boolean
  /** Loader fiber phase, e.g. 'active' or 'pending'; null when the host cannot see it. */
  phase?: string | null
  patchId?: string | null
  manageable?: boolean
  readOnlyReason?: string | null
  self?: boolean
  official?: boolean
  builtinUi?: boolean
  mcp?: boolean
  mcpPatchId?: string | null
  mcpEditable?: boolean
  transport?: string | null
  command?: string | null
  url?: string | null
  config?: Record<string, unknown> | null
  secretKeys?: SecretKeys
  root?: string | null
}

/** One skill folder the host found under a configured root. */
export interface SkillRow {
  id: string
  name: string
  enabled: boolean
  rootId?: string
  root?: string | null
  description?: string
  /** 'dir' for a folder with SKILL.md, 'file' for a single markdown skill. */
  entry?: string
  packs?: number
}

export interface GroupMember {
  kind: string
  id: string
}

export interface CollectionRow {
  id: string
  name: string
}

export interface GroupRow {
  id: string
  name: string
  members: GroupMember[]
  collection?: string | null
  enabled?: boolean
  /** Members listed in the group whose row no longer exists. */
  stale?: number
}

/** A saved set of enabled ids. */
export interface PresetRow {
  plugin?: string[]
  skill?: string[]
  tool?: string[]
}

export interface PatchBlockInfo {
  name: string
  beginLine: number
  endLine: number
  rows: string[]
  foreign: string[]
  known: boolean
}

export interface MaskInfo {
  available: boolean
  mounted: number
  deny: string[]
  sessions: Array<{ sessionId: string; deny: string[] }>
  problems: string[]
}

/** What the host says about itself: the build it runs and the runtime under it. */
export interface HostMeta {
  pluginVersion: string
  node: string
  platform: string
  pid: number
}

export interface PatchInfo {
  path: string | null
  rows: number
  blocks: PatchBlockInfo[]
  unclosed: string[]
  foreignTotal: number
}

export interface ExtensionViewRow {
  id: string
  title: { zh: string; en: string }
  kind: 'table' | 'list' | 'json'
  op: string
}

export interface ExtensionStatus {
  id: string
  name: { zh: string; en: string }
  version: string
  apiVersion: number
  dir: string
  enabled: boolean
  loaded: boolean
  error: string | null
  ops: string[]
  views: ExtensionViewRow[]
}

export interface HistoryEntry {
  at: string
  op: string
  detail: string
  ok: boolean
  audit: boolean
}

export interface SceneState {
  mode: string | null
  since: number | null
  names: string[]
  scenes: Record<string, unknown>
}

export interface SkillRootInfo {
  id: string
  label?: string
  dir?: string
  scope?: string
  workspace?: string | null
}

export interface SnapshotPaths {
  home?: string
  state?: string
  patch?: string | null
  skillRoots: string[]
  skills?: SkillRootInfo[]
}

export interface ToolRow {
  name: string
  enabled: boolean
  server?: string | null
  lazy?: boolean
}

/** The normalised snapshot: arrays are always present, so a view can map without a guard. */
export interface HubSnapshot {
  plugins: PluginRow[]
  skills: SkillRow[]
  groups: GroupRow[]
  collections: CollectionRow[]
  presets: Record<string, PresetRow>
  tools: ToolRow[]
  sessions: Record<string, string[]>
  scene: SceneState
  paths: SnapshotPaths
  mcpError: string | null
  limits: { bulk: number } | null
  /** Declared settings values, flat keys like "settings.appearance.theme". */
  settings: Record<string, unknown>
  /** The declarations the Settings page renders; empty when the host is too old to send them. */
  settingsSchema: SettingsField[]
  /** Newest-first audit lines from the host dispatcher. */
  history: HistoryEntry[]
  /** Local extensions the host discovered, with load state and declared views. */
  extensions: ExtensionStatus[]
  /** Managed blocks in the profile patch file, and the rows their owners do not own. */
  patchInfo: PatchInfo
  /** The per-agent tool mask: mounted agents, deny list and problems. */
  mask: MaskInfo
  /** The host's own version and runtime, shown on the Diagnostics page. */
  meta: HostMeta
  /** When this copy was read, used by the topbar to show staleness. */
  fetchedAt: number
}

/** Confirmation text a dialog shows before a destructive op is sent. */
export interface ConfirmRequest {
  op: string
  payload: unknown
  title: string
  body: string
}

/** Sends one op and refreshes the snapshot on success; false means the op failed. */
/** What a write returns when the caller needs the host's answer, not just success. */
export interface RunOutcome {
  ok: boolean
  data?: unknown
  error?: string
}

export type RunOp = (op: string, payload?: unknown) => Promise<boolean>

export type RunDetailedOp = (op: string, payload?: unknown) => Promise<RunOutcome>

/** Props every view receives from the shell. */
export interface ViewProps {
  snapshot: HubSnapshot
  lang: Lang
  t: TFunction
  busy: string | null
  run: RunOp
  /** Same write path, but keeps the host payload so a view can render it. */
  runDetailed: RunDetailedOp
  reload: () => Promise<void>
}
