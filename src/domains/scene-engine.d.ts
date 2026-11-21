/**
 * Type surface for the scene engine (`lib/scene-engine.js`, schema version 2).
 *
 * The engine ships no declarations and ships as plain JS, so this file only describes the shapes
 * it already returns. Nothing here adds runtime code, and nothing forks the behaviour: the
 * undefined-versus-empty rule, the intent-before-state order, the apply order (members, tools,
 * MCP) and the incomplete-rollback report all stay in the engine, where its own probe covers them.
 */

export interface SceneTools {
  deny: string[]
}

export interface SceneMcp {
  off: string[]
  on: string[]
}

/** One planned member switch: the row id and the state the scene wants it in. */
export interface SceneMemberItem {
  id: string
  enabled: boolean
}

/** What the caller planned for the two member domains (derived with `planPresetApply`). */
export interface SceneMemberPlan {
  plugin: SceneMemberItem[]
  skill: SceneMemberItem[]
}

/**
 * A saved scene. A missing section means "leave that domain alone"; an empty list clears it.
 * `locked` never participates in an apply - it only gates writes, and only `scene.lock` sets it.
 */
export interface Scene {
  version: number
  name: string
  tools?: SceneTools
  mcp?: SceneMcp
  plugins?: string[]
  skills?: string[]
  preset?: string
  locked?: boolean
}

export interface SceneSnapshotMcp {
  id: string
  enabled: boolean
}

/**
 * Everything an apply could change, captured before it starts.
 *
 * `sessions` is report-only: a scene is an installation-wide environment, so a restore never
 * rewrites another session's overlay. `plugins`/`skills` hold every row the snapshot saw, which
 * is what lets an exit undo a hand-flipped switch too.
 */
export interface SceneSnapshot {
  at: number
  toolDeny: string[]
  sessions: Record<string, string[]>
  mcp: Record<string, SceneSnapshotMcp>
  plugins?: Record<string, boolean>
  skills?: Record<string, boolean>
}

export interface ScenePlanServer {
  id: string
  serverName: string
  enabled: boolean
}

export interface ScenePlan {
  /** `null` means the tools domain is untouched; a list (even empty) means it is set. */
  tools: SceneTools | null
  mcp: ScenePlanServer[]
  /** `null` means the plugins domain is untouched; a list (even empty) means it is set. */
  plugins: SceneMemberItem[] | null
  /** `null` means the skills domain is untouched; a list (even empty) means it is set. */
  skills: SceneMemberItem[] | null
  /** The preset the scene binds, or null when it binds none. */
  preset: string | null
  /** Sections that win over the preset: `plugins` | `skills` | `tools`. */
  presetOverridden: string[]
  /** Bare server names, `plugin:<id>`, `skill:<id>` and `preset:<name>`. */
  missing: string[]
}

/** The intent record written before an apply changes anything. */
export interface SceneMode {
  version: number
  name: string
  at: number
  snapshot: SceneSnapshot
}

export interface RollbackRow {
  target: string
  ok: boolean
  message?: string
  /** The host reported the target as gone; nothing was put back and nothing is wrong. */
  skipped?: boolean
}

export interface RollbackReport {
  ok: boolean
  incomplete: RollbackRow[]
  restored: string[]
  message: string
}

/** What the preset step reports back into the engine; `missing` joins `plan.missing`. */
export interface ScenePresetOutcome {
  report?: unknown
  missing?: string[]
}

/** The host calls one apply needs; the engine owns ordering and reporting. */
export interface SceneIo {
  writeMode(mode: SceneMode): Promise<void> | void
  clearMode?(): Promise<void> | void
  setTools(deny: string[]): Promise<void> | void
  setServer(entry: ScenePlanServer): Promise<{ skipped?: boolean } | void> | { skipped?: boolean } | void
  /** Optional so a host without the member port fails loudly only when a member plan exists. */
  setMember?(kind: 'plugin' | 'skill', id: string, enabled: boolean): Promise<{ skipped?: boolean } | void> | { skipped?: boolean } | void
}

export interface SceneRunResult {
  ok: boolean
  plan: ScenePlan
  applied: string[]
  /** The preset step's report, or null when the scene binds no preset. */
  preset: unknown
  error?: string
  rollback: RollbackReport | null
}

export interface CaptureInput {
  toolDeny?: unknown
  sessions?: unknown
  mcpRows?: unknown
  /** Catalog rows (`{ kind, id, enabled }`) captured in full for both member domains. */
  memberRows?: unknown
  at?: number
}

export interface PlanFromSceneOptions {
  memberPlan?: SceneMemberPlan | null
}

export interface RunSceneInput {
  scene?: Scene
  snapshot: SceneSnapshot
  io: SceneIo
  restoreOnly?: boolean
  /** Plugin/skill items for this apply, planned by the caller from the live catalog. */
  memberPlan?: SceneMemberPlan | null
  /** Runs after the intent record is written and before the plan; a throw triggers the rollback. */
  applyPreset?: (() => Promise<ScenePresetOutcome | void>) | null
  now?: number
}

/** The module shape the import is cast to; mirrors `lib/scene-engine.js` exports. */
export interface SceneEngineModule {
  SCENE_VERSION: number
  normalizeScene(raw: unknown): Scene | null
  captureSnapshot(input?: CaptureInput): SceneSnapshot
  planFromScene(scene: Scene | null | undefined, snapshot: SceneSnapshot, options?: PlanFromSceneOptions): ScenePlan
  planFromSnapshot(snapshot: SceneSnapshot): ScenePlan
  restoreSnapshot(snapshot: SceneSnapshot, io: SceneIo): Promise<RollbackReport>
  runScene(input: RunSceneInput): Promise<SceneRunResult>
  describePlan(plan: ScenePlan): string
}
