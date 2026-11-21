/**
 * Scenes: a saved "whole environment" (plugin and skill rows, tool mask, MCP servers, and an
 * optional preset applied on entry), applied and restored.
 *
 * The behaviour is the engine's, imported unchanged from lib/scene-engine.js - the
 * undefined-versus-empty rule, the intent-record-first order, the apply order and the honest
 * incomplete-rollback report are covered by that module, so this file is the adapter: state,
 * host ports, the member planning that reuses `planPresetApply`, the preset step, and the two
 * write paths (tool deny via the one surface merger, MCP servers via the MCP port).
 *
 * Two rules this file adds on top of the engine:
 *   - a scene never restores session overlays, and its exit reply says so, so a user does not go
 *     looking for an overlay the scene deliberately left alone;
 *   - `locked` belongs to `scene.lock` alone. A save that carries the flag keeps whatever the
 *     archive already had and reports the field as ignored, so "save" can never drop a lock.
 *
 * What a scene deliberately does not cover (design §3.9, so these are not silent gaps): the
 * host prompt file `~/.dsh/AGENTS.md` is never written or applied (that is an A-class write with
 * its own confirmation flow); memories, subagent personas and quick prompts are out of scope;
 * session overlays are not restored; there is no boot-time reconcile; and there is no recycle
 * bin - a deleted scene comes back through the backup domain, which is already here.
 *
 * Failure contract: op failures throw a coded DomainFailure whose detail carries the plan and
 * the rollback report, so a half-restored environment is never reported as restored.
 */
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { StateV2 } from '../core/state.js'
import {
  applySurface,
  asRecord,
  asStringList,
  errorText,
  fail,
  failureOf,
  type ToggleOutcome,
} from './tool-surface.js'
import { parseMcpRows, patchPathFor, readPatchText } from './mcp.js'
import { setPluginEnabled } from './plugins.js'
import { cleanCatalogRows, resolveMemberPort, type CatalogRow } from './groups.js'
import { planPresetApply, presetsDomain, type PresetRecord } from './presets.js'
import { lockedSceneNames } from './scene-lock.js'
// @ts-ignore -- lib/scene-engine.js ships no declarations; the shape is declared in scene-engine.d.ts
import * as engineRaw from '../../lib/scene-engine.js'
import type {
  Scene,
  SceneEngineModule,
  SceneIo,
  SceneMemberPlan,
  SceneMode,
  ScenePlanServer,
  ScenePresetOutcome,
  SceneSnapshot,
} from './scene-engine.js'

/** 2.x engine, cast once; the .d.ts next to this file describes it. */
const engine = engineRaw as unknown as SceneEngineModule

/**
 * The preset domain's apply handler, called directly: a scene's own engine bypasses the dispatch
 * gate (that is what lets a locked scene apply itself). A table that lost the handler is a build
 * error, refused loudly rather than silently skipping the preset step.
 */
function applyPresetOp(payload: unknown, env: HostEnv): Promise<unknown> {
  const handler = presetsDomain().handlers['preset.apply']
  if (handler === undefined) throw new Error('the presets domain does not handle preset.apply')
  return handler(payload, env)
}

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

interface MemberRead {
  rows: CatalogRow[]
  /** Why the catalog could not be read; null when it could. */
  error: string | null
}

/**
 * Live plugin/skill rows. A read failure is reported, never smoothed into "there are no rows":
 * an empty catalog would make every listed member look uninstalled and would leave the exit with
 * nothing to restore while still claiming a clean restore.
 */
async function readMemberRows(env: HostEnv): Promise<MemberRead> {
  try {
    return { rows: cleanCatalogRows(await resolveMemberPort(env).rows()), error: null }
  }
  catch (error) {
    return { rows: [], error: errorText(error) }
  }
}

/**
 * The plugin/skill switches a scene asks for, planned by the preset rule rather than a second
 * copy of it: an exact selection where everything listed is on and everything else manageable is
 * off. The engine ignores a domain whose section is absent, so planning both is harmless.
 */
export function memberPlanFor(scene: Scene, rows: readonly CatalogRow[]): SceneMemberPlan {
  const preset: PresetRecord = {
    name: scene.name,
    enabled: { plugin: scene.plugins ?? [], skill: scene.skills ?? [], tool: [] },
    note: '',
    createdAt: 0,
  }
  const items = planPresetApply(preset, rows, 'exact')
  return {
    plugin: items.filter(item => item.kind === 'plugin').map(item => ({ id: item.id, enabled: item.enabled })),
    skill: items.filter(item => item.kind === 'skill').map(item => ({ id: item.id, enabled: item.enabled })),
  }
}

/** A plain object (not an array, not null): the shape both member maps and the snapshot use. */
function isMap(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A snapshot's boolean map, total for reading: only string keys with a boolean value survive. */
function boolMap(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [id, flag] of Object.entries(asRecord(value))) {
    if (id === '') continue
    out[id] = flag === true
  }
  return out
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
  // Absent stays absent: a record written before a host could list its rows has no member map,
  // and inventing an empty one would claim there was nothing to restore.
  if (isMap(snapshot.plugins)) normalized.plugins = boolMap(snapshot.plugins)
  if (isMap(snapshot.skills)) normalized.skills = boolMap(snapshot.skills)
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    name,
    at: typeof raw.at === 'number' ? raw.at : 0,
    snapshot: normalized,
  }
}

/**
 * Whether a switch refused because the row is gone. The shipped ports report that as a code with
 * a plain-English message ("no plugin entry answers to X", "no skill folder answers to Y"), so the
 * code decides and the message is only a fallback for a host that sends text alone.
 */
function isMissingRow(outcome: ToggleOutcome): boolean {
  const code = String(outcome.code ?? '')
  const message = String(outcome.message ?? '')
  return /unknown-(plugin|skill)|row-not-found|not-found/.test(code)
    || /unknown-(plugin|skill)|not-found|no plugin entry answers|no skill folder answers/.test(message)
}

/**
 * The graph of the engine's sceneIo: every write goes through env.save, the tool domain goes
 * through the one surface merger so a scene cannot install a second, competing mask, and members
 * go through the member port one row at a time.
 *
 * tolerateMissing exists for scene.exit only: a server or member row deleted while the scene was
 * active is nothing to put back, and reporting it as a rollback failure would be noise. During an
 * apply's rollback the flag is false, because a row vanishing mid-apply is worth reporting.
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
      if (tolerateMissing && isMissingRow(outcome)) return { skipped: true }
      throw new Error('cannot ' + (entry.enabled ? 'enable' : 'disable') + ' ' + entry.serverName + ': ' + (outcome.message ?? 'refused'))
    },
    async setMember(kind, id, enabled) {
      const outcome = await resolveMemberPort(env).setEnabled(kind, id, enabled)
      if (outcome.ok === true) return
      if (tolerateMissing && isMissingRow(outcome)) return { skipped: true }
      throw new Error('cannot ' + (enabled ? 'enable' : 'disable') + ' ' + kind + ' ' + id + ': ' + (outcome.message ?? 'refused'))
    },
  }
}

function sceneNameOf(payload: unknown): string {
  const body = asRecord(payload)
  return typeof body.name === 'string' ? body.name.trim() : ''
}

/** One line about what the preset step did, kept small: the scene reply is not a preset reply. */
function presetReport(name: string, reply: unknown): Record<string, unknown> {
  const body = asRecord(reply)
  const tools = asRecord(body.tools)
  return {
    name,
    ok: true,
    requested: typeof body.requested === 'number' ? body.requested : 0,
    changed: typeof body.applied === 'number' ? body.applied : 0,
    tools: typeof tools.decision === 'string' ? tools.decision : null,
  }
}

/**
 * The preset step: `preset.apply(exact)` before the scene's own sections, so an explicit section
 * always has the last word. A preset that no longer exists is reported like a missing server
 * (one line in `missing`) and the scene still applies; any other failure throws and the engine
 * rolls the whole environment back.
 */
async function presetStep(env: HostEnv, name: string): Promise<ScenePresetOutcome> {
  try {
    const reply = await applyPresetOp({ name, mode: 'exact' }, env)
    return { report: presetReport(name, reply) }
  }
  catch (error) {
    if (failureOf(error).code === 'no-preset') {
      return { report: { name, ok: false, missing: true }, missing: ['preset:' + name] }
    }
    throw error
  }
}

/** The live picture a plan or an apply is computed against. */
async function captureFor(env: HostEnv, port: McpScenePort): Promise<{ snapshot: SceneSnapshot; rows: CatalogRow[]; degraded: string | null }> {
  const mcpRows = await readSceneRows(port)
  const member = await readMemberRows(env)
  const degraded = member.error === null ? null : 'member catalog unavailable: ' + member.error
  return {
    snapshot: engine.captureSnapshot({
      toolDeny: env.state.toolDeny,
      sessions: env.state.sessions,
      mcpRows,
      // An unreadable catalog is not captured at all: the exit must not "restore" rows it never saw.
      memberRows: member.error === null ? member.rows : undefined,
    }),
    rows: member.rows,
    degraded,
  }
}

const sceneSave: OpHandler = async (payload, env) => {
  const scene = engine.normalizeScene(payload)
  if (scene === null) {
    throw fail('bad-scene', 'a scene needs a name; tools, mcp, plugins, skills, preset and locked are all optional')
  }
  const scenes = asRecord(env.state.scenes)
  const existing = asRecord(scenes[scene.name])
  const ignored: string[] = []
  const body = asRecord(payload)
  if ('locked' in body) ignored.push('locked')
  // No scene field carries a free-form note; saying so beats dropping it silently.
  if ('note' in body) ignored.push('note')
  // The archive keeps its lock; only scene.lock changes it.
  if (existing.locked === true) scene.locked = true
  else delete scene.locked
  scenes[scene.name] = scene
  env.state.scenes = scenes
  const backup = await env.save('scene-save')
  const reply = { scene, scenes: Object.keys(scenes).sort(), backup }
  return ignored.length === 0 ? reply : { ...reply, ignored }
}

const scenePlan: OpHandler = async (payload, env) => {
  const name = sceneNameOf(payload)
  const scene = name === '' ? null : engine.normalizeScene(asRecord(env.state.scenes)[name])
  if (scene === null) throw fail('unknown-scene', 'no scene named "' + name + '"')
  const port = resolveMcpPort(env)
  const { snapshot, rows, degraded } = await captureFor(env, port)
  const plan = engine.planFromScene(scene, snapshot, { memberPlan: memberPlanFor(scene, rows) })
  return {
    scene: scene.name,
    plan,
    description: engine.describePlan(plan),
    preset: plan.preset,
    missing: plan.missing,
    presetOverridden: plan.presetOverridden,
    degraded,
  }
}

const sceneApply: OpHandler = async (payload, env) => {
  const name = sceneNameOf(payload)
  if (name === '') throw fail('bad-payload', 'name is required')
  const scene = engine.normalizeScene(asRecord(env.state.scenes)[name])
  if (scene === null) throw fail('unknown-scene', 'no scene named "' + name + '"')
  const port = resolveMcpPort(env)
  const { snapshot, rows, degraded } = await captureFor(env, port)
  const preset = scene.preset
  const run = await engine.runScene({
    scene,
    snapshot,
    io: sceneIoFor(env, port, false),
    memberPlan: memberPlanFor(scene, rows),
    applyPreset: preset === undefined ? null : () => presetStep(env, preset),
  })
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
  const warnings: string[] = []
  if (run.plan.missing.length > 0) warnings.push('not installed: ' + run.plan.missing.join(', '))
  if (degraded !== null) warnings.push(degraded)
  return {
    ok: true,
    scene: scene.name,
    plan: run.plan,
    applied: run.applied,
    skipped: run.applied.filter(target => target.endsWith('(skipped)')),
    missing: run.plan.missing,
    degraded,
    warn: warnings.length === 0 ? null : warnings.join('; '),
    preset: run.preset,
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
  return {
    ok: true,
    restored: true,
    scene: mode.name,
    targets: run.applied,
    note: 'session overlays are not part of a scene',
  }
}

const sceneDelete: OpHandler = async (payload, env) => {
  const name = sceneNameOf(payload)
  if (name === '') throw fail('bad-payload', 'name is required')
  const scenes = asRecord(env.state.scenes)
  if (!(name in scenes)) throw fail('unknown-scene', 'no scene named "' + name + '"')
  const mode = readMode(env.state)
  // The snapshot in the mode record is the only way back from an apply, so the scene it names
  // stays until that snapshot has been consumed by an exit.
  if (mode !== null && mode.name === name) {
    throw fail('scene-active', 'scene "' + name + '" is applied; exit it before deleting its archive')
  }
  delete scenes[name]
  env.state.scenes = scenes
  const backup = await env.save('scene-delete')
  return { deleted: name, scenes: Object.keys(scenes).sort(), backup }
}

const sceneLock: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const name = sceneNameOf(payload)
  if (name === '') throw fail('bad-payload', 'name is required')
  if (typeof body.locked !== 'boolean') throw fail('bad-payload', 'locked must be true or false')
  const scenes = asRecord(env.state.scenes)
  const stored = asRecord(scenes[name])
  if (Object.keys(stored).length === 0) throw fail('unknown-scene', 'no scene named "' + name + '"')
  const record: Record<string, unknown> = { ...stored }
  if (body.locked === true) record.locked = true
  else delete record.locked
  scenes[name] = record
  env.state.scenes = scenes
  const backup = await env.save('scene-lock')
  return {
    name,
    locked: body.locked === true,
    scenes: Object.keys(scenes).sort(),
    lockedScenes: lockedSceneNames(env.state),
    backup,
  }
}

/** The scenes domain: save a whole environment, apply it, restore the snapshot, lock it. */
export function scenesDomain(): DomainRegistration {
  return {
    module: {
      id: 'scenes',
      title: { zh: '场景', en: 'Scenes' },
      ops: [
        { id: 'scene.save', write: true, audit: true, note: 'Stores a named scene of plugins, skills, tools, MCP and an optional preset; a missing section means "leave that domain alone".' },
        { id: 'scene.apply', write: true, audit: true, note: 'Applies a scene (preset first, then its sections); records a full snapshot so scene.exit can restore it.' },
        { id: 'scene.exit', write: true, audit: true, note: 'Restores the snapshot taken when the scene was applied, then clears the mode record; session overlays are not restored.' },
        { id: 'scene.plan', write: false, audit: false, note: 'Previews what a scene would change against the live rows; touches nothing.' },
        { id: 'scene.delete', write: true, audit: true, note: 'Deletes a saved scene; the applied scene must be exited first. Restorable only from a backup.' },
        { id: 'scene.lock', write: true, audit: true, note: 'Locks or unlocks one scene; a locked scene freezes environment writes and cannot be changed or deleted.' },
      ],
      panels: [{ slot: 'plugins.tab', id: 'scenes', order: 40 }],
    },
    handlers: {
      'scene.save': sceneSave,
      'scene.plan': scenePlan,
      'scene.apply': sceneApply,
      'scene.exit': sceneExit,
      'scene.delete': sceneDelete,
      'scene.lock': sceneLock,
    },
  }
}

export type { Scene }
