import type { DomainModule, SettingsField } from '../shared/types.js'

/**
 * Settings are declared by modules and stored flat in state.settings under `<module>.<key>`.
 * Defaults are derived, never hand-copied: a module that adds a field gets a stored value on the
 * next write without a migration.
 */
export function settingsFields(modules: DomainModule[]): Array<{ key: string; field: SettingsField }> {
  return modules.flatMap(module => (module.settings ?? []).map(field => ({ key: `${module.id}.${field.key}`, field })))
}

export function settingsDefaults(modules: DomainModule[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { key, field } of settingsFields(modules)) out[key] = field.default
  return out
}

/** Fill missing defaults without touching a value the user (or an older version) already stored. */
export function applySettingsDefaults(stored: Record<string, unknown>, modules: DomainModule[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...stored }
  for (const [key, value] of Object.entries(settingsDefaults(modules))) {
    if (out[key] === undefined) out[key] = value
  }
  return out
}

/** Coerce one stored value to its declared type; an unusable value falls back to the default. */
export function coerceSetting(field: SettingsField, value: unknown): unknown {
  if (field.type === 'boolean') return typeof value === 'boolean' ? value : field.default
  if (field.type === 'number') {
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(number)) return field.default
    const min = field.min ?? -Infinity
    const max = field.max ?? Infinity
    return Math.min(max, Math.max(min, number))
  }
  if (field.type === 'select') {
    const allowed = (field.options ?? []).map(option => option.value)
    return typeof value === 'string' && allowed.includes(value) ? value : field.default
  }
  return typeof value === 'string' ? value : field.default
}

/** Every stored setting checked against its declaration; unknown stored keys are kept. */
export function normalizeSettings(stored: Record<string, unknown>, modules: DomainModule[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...stored }
  for (const { key, field } of settingsFields(modules)) out[key] = coerceSetting(field, out[key])
  return out
}
