/**
 * Type surface for the 1.x scene engine (`lib/scene-engine.js`).
 *
 * The engine ships no declarations and 2.0 reuses it verbatim, so this file only describes the
 * shapes it already returns. Nothing here adds runtime code, and nothing forks the behaviour:
 * the empty-section rule, the intent-before-state order and the incomplete-rollback report all
 * stay in the engine, where its own smoke probe covers them.
 */

export interface SceneTools {
  deny: string[]
}

export interface SceneMcp {
  off: string[]
  on: string[]
}

/** A saved scene. A missing `tools` or `mcp` key means "leave that domain alone". */
export interface Scene {
  version: number
  name: string
  tools?: SceneTools
  mcp?: SceneMcp
}

export interface SceneSnapshotMcp {
  id: string
  enabled: boolean
}

/** Everything an apply could change, captured before it starts. */
export interface SceneSnapshot {
  at: number
  toolDeny: string[]
  sessions: Record<string, string[]>
  mcp: Record<string, SceneSnapshotMcp>
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
}

export interface RollbackReport {
  ok: boolean
  incomplete: RollbackRow[]
  restored: string[]
  message: string
}

/** The host calls one apply needs; the engine owns ordering and reporting. */
export interface SceneIo {
  writeMode(mode: SceneMode): Promise<void> | void
  clearMode?(): Promise<void> | void
  setTools(deny: string[]): Promise<void> | void
  setServer(entry: ScenePlanServer): Promise<{ skipped?: boolean } | void> | { skipped?: boolean } | void
}

export interface SceneRunResult {
  ok: boolean
  plan: ScenePlan
  applied: string[]
  error?: string
  rollback: RollbackReport | null
}

export interface CaptureInput {
  toolDeny?: unknown
  sessions?: unknown
  mcpRows?: unknown
  at?: number
}

export interface RunSceneInput {
  scene?: Scene
  snapshot: SceneSnapshot
  io: SceneIo
  restoreOnly?: boolean
  now?: number
}

/** The module shape the import is cast to; mirrors `lib/scene-engine.js` exports. */
export interface SceneEngineModule {
  SCENE_VERSION: number
  normalizeScene(raw: unknown): Scene | null
  captureSnapshot(input?: CaptureInput): SceneSnapshot
  planFromScene(scene: Scene | null | undefined, snapshot: SceneSnapshot): ScenePlan
  planFromSnapshot(snapshot: SceneSnapshot): ScenePlan
  restoreSnapshot(snapshot: SceneSnapshot, io: SceneIo): Promise<RollbackReport>
  runScene(input: RunSceneInput): Promise<SceneRunResult>
  describePlan(plan: ScenePlan): string
}
