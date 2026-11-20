/**
 * State schema version 2. Version 1 is the 1.x file (flat groups/presets/toolDeny/sessions/
 * scenes/mode); version 2 adds `settings` and `modules`, and keeps every 1.x key where it was so
 * a rollback to 1.1.0 still reads the file.
 */
export const STATE_VERSION = 2

export interface StateV2 {
  version: 2
  groups: unknown[]
  collections: unknown[]
  presets: unknown[]
  toolDeny: string[]
  auto: { appliedAt: number | null }
  sessions: Record<string, string[]>
  scenes: Record<string, unknown>
  mode: unknown | null
  settings: Record<string, unknown>
  modules: Record<string, unknown>
}

export function emptyState(): StateV2 {
  return {
    version: STATE_VERSION,
    groups: [],
    collections: [{ id: 'default', name: '默认分组群', order: 0 }],
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

/** Pure: a 1.x document (or nothing) becomes a v2 document. Unknown keys are carried through. */
export function migrate(raw: unknown): StateV2 {
  const base = emptyState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const source = raw as Record<string, unknown>
  const out: StateV2 = {
    ...base,
    ...(Array.isArray(source.groups) ? { groups: source.groups } : {}),
    ...(Array.isArray(source.collections) ? { collections: source.collections } : {}),
    ...(Array.isArray(source.presets) ? { presets: source.presets } : {}),
    ...(Array.isArray(source.toolDeny) ? { toolDeny: source.toolDeny.filter((name): name is string => typeof name === 'string') } : {}),
    ...(source.auto !== null && typeof source.auto === 'object' ? { auto: source.auto as StateV2['auto'] } : {}),
    ...(source.sessions !== null && typeof source.sessions === 'object' && !Array.isArray(source.sessions) ? { sessions: source.sessions as StateV2['sessions'] } : {}),
    ...(source.scenes !== null && typeof source.scenes === 'object' && !Array.isArray(source.scenes) ? { scenes: source.scenes as StateV2['scenes'] } : {}),
    ...(source.mode !== undefined ? { mode: source.mode } : {}),
    ...(source.settings !== null && typeof source.settings === 'object' && !Array.isArray(source.settings) ? { settings: source.settings as StateV2['settings'] } : {}),
    ...(source.modules !== null && typeof source.modules === 'object' && !Array.isArray(source.modules) ? { modules: source.modules as StateV2['modules'] } : {}),
  }
  return out
}
