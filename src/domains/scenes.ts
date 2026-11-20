/**
 * Scenes: a saved "whole environment" (tool mask plus MCP servers), applied and restored.
 *
 * The behaviour is the 1.x engine's, imported unchanged from lib/scene-engine.js - the
 * empty-section rule, the intent-record-first order and the honest incomplete-rollback report
 * are covered by that module, so this file is the adapter: state, host ports, and the two
 * write paths (tool deny via the one surface merger, MCP servers via the MCP port).
 *
 * Failure contract: op failures throw a coded DomainFailure whose detail carries the plan and
 * the rollback report, so a half-restored environment is never reported as restored.
 */
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { StateV2 } from '../core/state.js'
import { applySurface, asRecord, asStringList, errorText, fail, type ToggleOutcome } from './tool-surface.js'
import { parseMcpRows, patchPathFor, readPatchText } from './mcp.js'
import { setPluginEnabled } from './plugins.js'
// @ts-ignore -- lib/scene-engine.js ships no declarations; the shape is declared in scene-engine.d.ts
import * as engineRaw from '../../lib/scene-engine.js'
import type {
  Scene,
  SceneEngineModule,
  SceneIo,
  SceneMode,
  ScenePlanServer,
  SceneSnapshot,
} from './scene-engine.js'

/** 1.x engine, cast once; the .d.ts next to this file describes it. */
const engine = engineRaw as unknown as SceneEngineModule

/** Service that exposes MCP rows and switches one server on or off. */
export const MCP_SERVICE = 'toolHub.mcp'

export interface McpRow {
  id: string
  serverName: string
  disabled: boolean
}

/** The narrow MCP surface a scene apply needs; a missing port degrades, it does not crash. */
export interface McpScenePort {
  rows(): Promise<McpRow[]> | McpRow[]
  setEnabled(id: string, enabled: boolean): Promise<ToggleOutcome> | ToggleOutcome
}

/** Default port: the profile patch through the shipped MCP domain and plugin manager. */
export function defaultMcpPort(env: HostEnv): McpScenePort {
  return {
    async rows() {
      const path = patchPathFor(env)
      if (path === null) return []
      const text = await readPatchText(path).catch(() => '')
      return parseMcpRows(text)
        .map(row => ({ id: row.id, serverName: String(row.config.serverName ?? ''), disabled: row.disabled === true }))
        .filter(row => row.serverName !== '')
    },
    async setEnabled(id, enabled) {
      try {
        const outcome = await setPluginEnabled(env, id, enabled)
        return { ok: outcome.ok === true, message: outcome.message }
      }
      catch (error) {
        return { ok: false, code: (error as { code?: string }).code ?? 'internal', message: errorText(error) }
      }
    },
  }
}

/** A host may register its own MCP port; otherwise the shipped domains answer. */
export function resolveMcpPort(env: HostEnv): McpScenePort {
  const raw = env.services.get(MCP_SERVICE)
  if (raw !== null && typeof raw === 'object') {
    const port = raw as Partial<McpScenePort>
    if (typeof port.rows === 'function' && typeof port.setEnabled === 'function') return raw as McpScenePort
  }
  return defaultMcpPort(env)
}

function cleanRows(rows: readonly McpRow[] | undefined): McpRow[] {
  const out: McpRow[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = typeof row?.id === 'string' ? row.id : ''
    const serverName = typeof row?.serverName === 'string' ? row.serverName : ''
    if (id === '' || serverName === '') continue
    out.push({ id, serverName, disabled: row.disabled === true })
  }
  return out
}

/** Live rows for a snapshot; a host that cannot list them degrades to "no servers known". */
async function readSceneRows(port: McpScenePort): Promise<McpRow[]> {
  try {
    return cleanRows(await port.rows())
  }
  catch {
    return []
  }
}

/** The intent record, validated; a record that cannot drive a restore is reported as absent. */
export function readMode(state: StateV2): SceneMode | null {
  const raw = asRecord(state.mode)
  const name = typeof raw.name === 'string' ? raw.name : ''
  const snapshot = asRecord(raw.snapshot)
  if (name === '' || Object.keys(snapshot).length === 0) return null
  const sessions: Record<string, string[]> = {}
  for (const [sessionId, names] of Object.entries(asRecord(snapshot.sessions))) {
    sessions[sessionId] = asStringList(names)
  }
  const mcp: Record<string, { id: string; enabled: boolean }> = {}
  for (const [serverName, value] of Object.entries(asRecord(snapshot.mcp))) {
    const row = asRecord(value)
    const id = typeof row.id === 'string' ? row.id : ''
    if (id === '') continue
    mcp[serverName] = { id, enabled: row.enabled !== false }
  }
  const normalized: SceneSnapshot = {
    at: typeof snapshot.at === 'number' ? snapshot.at : 0,
    toolDeny: asStringList(snapshot.toolDeny),
    sessions,
    mcp,
  }
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    name,
    at: typeof raw.at === 'number' ? raw.at : 0,
    snapshot: normalized,
  }
}

/**
 * The graph of the 1.x sceneIo: every write goes through env.save, and the tool domain goes
 * through the one surface merger so a scene cannot install a second, competing mask.
 *
 * tolerateMissing exists for scene.exit only: a server row deleted while the scene was active
 * is nothing to put back, and reporting it as a rollback failure would be noise.
 */
function sceneIoFor(env: HostEnv, port: McpScenePort, tolerateMissing: boolean): SceneIo {
  return {
    async writeMode(mode: SceneMode) {
      env.state.mode = { version: mode.version, name: mode.name, at: mode.at, snapshot: mode.snapshot }
      await env.save('scene-apply')
    },
    async clearMode() {
      env.state.mode = null
      await env.save('scene-exit')
    },
    async setTools(deny: string[]) {
      env.state.toolDeny = [...deny]
      await env.save('scene-tools')
      const mask = await applySurface({ state: env.state, services: env.services })
      if (!mask.ok) env.log('warn', '[tool-hub] scene mask refused: ' + (mask.message ?? mask.status))
    },
    async setServer(entry: ScenePlanServer) {
      const outcome = await port.setEnabled(entry.id, entry.enabled)
      if (outcome.ok === true) return
      if (tolerateMissing && /unknown-plugin/.test(String(outcome.message ?? ''))) return { skipped: true }
      throw new Error('cannot ' + (entry.enabled ? 'enable' : 'disable') + ' ' + entry.serverName + ': ' + (outcome.message ?? 'refused'))
    },
  }
}

function sceneNameOf(payload: unknown): string {
  const body = asRecord(payload)
  return typeof body.name === 'string' ? body.name.trim() : ''
}

const sceneSave: OpHandler = async (payload, env) => {
  const scene = engine.normalizeScene(payload)
  if (scene === null) {
    throw fail('bad-scene', 'a scene needs a name; tools.deny and mcp.off/on are both optional')
  }
  const scenes = asRecord(env.state.scenes)
  scenes[scene.name] = scene
  env.state.scenes = scenes
  const backup = await env.save('scene-save')
  return { scene, scenes: Object.keys(scenes).sort(), backup }
}

const scenePlan: OpHandler = async (payload, env) => {
  const name = sceneNameOf(payload)
  const scene = name === '' ? null : engine.normalizeScene(asRecord(env.state.scenes)[name])
  if (scene === null) throw fail('unknown-scene', 'no scene named "' + name + '"')
  const port = resolveMcpPort(env)
  const rows = await readSceneRows(port)
  const snapshot = engine.captureSnapshot({ toolDeny: env.state.toolDeny, sessions: env.state.sessions, mcpRows: rows })
  const plan = engine.planFromScene(scene, snapshot)
  return { scene: scene.name, plan, description: engine.describePlan(plan) }
}

const sceneApply: OpHandler = async (payload, env) => {
  const name = sceneNameOf(payload)
  if (name === '') throw fail('bad-payload', 'name is required')
  const scene = engine.normalizeScene(asRecord(env.state.scenes)[name])
  if (scene === null) throw fail('unknown-scene', 'no scene named "' + name + '"')
  const port = resolveMcpPort(env)
  const rows = await readSceneRows(port)
  const snapshot = engine.captureSnapshot({ toolDeny: env.state.toolDeny, sessions: env.state.sessions, mcpRows: rows })
  const run = await engine.runScene({ scene, snapshot, io: sceneIoFor(env, port, false) })
  const description = engine.describePlan(run.plan)
  if (!run.ok) {
    const message = (run.error ?? 'apply failed') + '; ' + (run.rollback?.message ?? 'rollback unavailable')
    throw fail('scene-failed', message, {
      scene: scene.name,
      plan: run.plan,
      applied: run.applied,
      rollback: run.rollback,
      incomplete: run.rollback?.incomplete ?? [],
    })
  }
  return {
    ok: true,
    scene: scene.name,
    plan: run.plan,
    applied: run.applied,
    missing: run.plan.missing,
    warn: run.plan.missing.length === 0 ? null : 'not installed: ' + run.plan.missing.join(', '),
    description,
  }
}

const sceneExit: OpHandler = async (payload, env) => {
  void payload
  const mode = readMode(env.state)
  if (mode === null) return { ok: true, restored: false, note: 'no scene is active' }
  const port = resolveMcpPort(env)
  const run = await engine.runScene({ snapshot: mode.snapshot, io: sceneIoFor(env, port, true), restoreOnly: true })
  if (!run.ok) {
    const message = (run.error ?? 'restore failed') + '; ' + (run.rollback?.message ?? 'restore unavailable')
    throw fail('scene-exit-failed', message, {
      scene: mode.name,
      rollback: run.rollback,
      incomplete: run.rollback?.incomplete ?? [],
    })
  }
  return { ok: true, restored: true, scene: mode.name, targets: run.applied }
}

/** The scenes domain: save a tools + MCP environment, apply it, restore the snapshot. */
export function scenesDomain(): DomainRegistration {
  return {
    module: {
      id: 'scenes',
      title: { zh: '场景', en: 'Scenes' },
      ops: [
        { id: 'scene.save', write: true, audit: true, note: 'Stores a named scene; a missing section means "leave that domain alone".' },
        { id: 'scene.apply', write: true, audit: true, note: 'Applies a saved tools + MCP scene; records a full snapshot first so scene.exit can restore it.' },
        { id: 'scene.exit', write: true, audit: true, note: 'Restores the snapshot taken when the scene was applied, then clears the mode record.' },
        { id: 'scene.plan', write: false, audit: false, note: 'Previews what a scene would change against the live MCP rows; touches nothing.' },
      ],
      panels: [{ slot: 'plugins.tab', id: 'scenes', order: 40 }],
    },
    handlers: {
      'scene.save': sceneSave,
      'scene.plan': scenePlan,
      'scene.apply': sceneApply,
      'scene.exit': sceneExit,
    },
  }
}

export type { Scene }
