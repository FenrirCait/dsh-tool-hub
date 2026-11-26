/**
 * Scene locks: which saved scenes are frozen, and which ops a lock refuses.
 *
 * A locked scene means "this environment is settled, stop changing it". The judgement lives here,
 * as a pure function over state, for two reasons:
 *
 *   - one place decides for every caller: the HTTP route, the model-side tool call and the CLI
 *     all reach handlers through `Dispatcher.execute`, which is where this is asked;
 *   - the scene engine itself does not go through that door (it writes state and calls the ports
 *     directly), so a locked scene can still be applied and exited by its own engine. Only the
 *     ops below are refused - that asymmetry is what makes a lock usable instead of a trap.
 *
 * The refusal text states the fact and nothing else: the reader can be a model, and "go open the
 * scenes page" is advice only a human with a pointer can act on.
 */
import type { StateV2 } from '../core/state.js'

/**
 * `all` - any write that changes the environment every scene describes;
 * `self-scene` - the ops that modify a named scene's archive;
 * `active-scene` - the ops that move the currently applied scene.
 */
export type FrozenScope = 'all' | 'active-scene' | 'self-scene'

/**
 * The freeze table, exact to the op id. Anything not listed is allowed, including:
 *
 *   - `scene.lock` - unlocking has to stay reachable, or a lock is a deadlock;
 *   - `scene.plan` and every other read-only op - no side effect;
 *   - `session.*`, `scope.*` and `settings.set` - session overlays are not what a scene
 *     describes, and settings are presentation;
 *   - `backup.*` - restoring a backup is the documented way out of a broken environment.
 */
export const FROZEN_OPS: Readonly<Record<string, FrozenScope>> = {
  'mcp.save': 'all',
  'mcp.create': 'all',
  'mcp.delete': 'all',
  'mcp.rawSave': 'all',
  'toggle': 'all',
  'bulk': 'all',
  'skill.toggle': 'all',
  'skill.delete': 'all',
  'skill.import': 'all',
  'skill.move': 'all',
  'skill.restore': 'all',
  'skill.trashClean': 'all',
  'preset.save': 'all',
  'preset.update': 'all',
  'preset.delete': 'all',
  'preset.apply': 'all',
  'tool.save': 'all',
  'tool.toggle': 'all',
  'tool.import': 'all',
  'lazy.set': 'all',
  'lazy.load': 'all',
  'lazy.unload': 'all',
  'scene.save': 'self-scene',
  'scene.delete': 'self-scene',
  'scene.apply': 'active-scene',
  'scene.exit': 'active-scene',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The names of every locked scene, stable-sorted so a message reads the same twice. */
export function lockedSceneNames(state: StateV2): string[] {
  const scenes = isRecord(state.scenes) ? state.scenes : {}
  const names: string[] = []
  for (const [name, value] of Object.entries(scenes)) {
    if (name === '' || !isRecord(value)) continue
    if (value.locked === true) names.push(name)
  }
  return names.sort()
}

/** The scene the mode record says is applied, or null when nothing is applied. */
export function activeSceneName(state: StateV2): string | null {
  const mode = state.mode
  if (!isRecord(mode)) return null
  const name = typeof mode.name === 'string' ? mode.name.trim() : ''
  return name === '' ? null : name
}

/** The scene a payload names, trimmed; empty when it names none. */
function targetNameOf(payload: unknown): string {
  if (!isRecord(payload)) return ''
  return typeof payload.name === 'string' ? payload.name.trim() : ''
}

function quoted(names: readonly string[]): string {
  return names.map(name => '"' + name + '"').join(', ')
}

/** One sentence per scope, the same words for every caller. */
function lockedMessage(locked: readonly string[]): string {
  const head = locked.length === 1 ? 'scene ' + quoted(locked) + ' is locked' : 'scenes ' + quoted(locked) + ' are locked'
  const tail = locked.length === 1 ? 'unlock that scene first.' : 'unlock those scenes first.'
  return head + ': this write was refused because it would change the environment that scene defines; ' + tail
}

/**
 * Why a lock refuses this op, or null when it does not.
 *
 * Any single locked scene freezes the environment ops - no per-scene carve-out: the point of a
 * lock is "stop moving the environment", and a scene that changed half of it would be worse than
 * no lock at all.
 */
export function frozenRejection(state: StateV2, op: string, payload: unknown): string | null {
  const scope = FROZEN_OPS[op]
  if (scope === undefined) return null
  const locked = lockedSceneNames(state)
  if (locked.length === 0) return null
  if (scope === 'all') return lockedMessage(locked)

  const target = targetNameOf(payload)
  if (scope === 'self-scene') {
    if (target === '' || !locked.includes(target)) return null
    return 'scene "' + target + '" is locked: its archive cannot be modified or deleted; unlock it first.'
  }

  // active-scene: only a locked *active* scene freezes the op.
  const active = activeSceneName(state)
  if (active === null || !locked.includes(active)) return null
  // Re-applying the scene that is already applied changes nothing, so it stays allowed.
  if (op === 'scene.apply' && target === active) return null
  return 'scene "' + active + '" is locked and currently active: switching away or exiting is refused; unlock it first.'
}