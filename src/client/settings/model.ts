/**
 * The settings page without React: schema → groups, stored values → draft, draft → save payload.
 *
 * Every function here is pure over plain values, so the probe can call them directly and the
 * view stays a thin renderer. Coercion mirrors the host (src/core/settings.ts): a value that does
 * not fit its declaration falls back to the declared default, a number is clamped to min/max,
 * and a select keeps only a value one of its options names.
 */
import type { SettingsField } from '../../shared/types.js'
import type { TFunction } from '../i18n.js'

/** The four shapes a field can declare; anything else renders and coerces as a string. */
export type FieldKind = 'boolean' | 'number' | 'string' | 'select'

/** One rendered section: the first segment of the key, and the fields under it. */
export interface SettingsGroup {
  id: string
  fields: SettingsField[]
}

const KINDS: readonly string[] = ['boolean', 'number', 'string', 'select']

export function fieldKind(field: SettingsField): FieldKind {
  return KINDS.includes(field.type) ? (field.type as FieldKind) : 'string'
}

/**
 * The segment every key shares, when it is a module id rather than a group.
 *
 * Module-declared settings arrive as "settings.appearance.theme": grouping on the raw first
 * segment would put the whole page in one section called "settings". A key with fewer than
 * three segments is already "group.name" and needs no stripping, so the shared head is returned
 * only when every key has at least that many parts.
 */
export function modulePrefixOf(fields: SettingsField[]): string {
  let shared: string | null = null
  for (const field of fields) {
    const parts = field.key.split('.')
    if (parts.length < 3) return ''
    const head = parts[0] ?? ''
    if (shared === null) shared = head
    else if (shared !== head) return ''
  }
  return shared === null ? '' : shared
}

/** The section a key belongs to: its first segment after the module prefix; "other" when bare. */
export function groupIdOf(key: string, prefix = ''): string {
  const rest = prefix !== '' && key.startsWith(prefix + '.') ? key.slice(prefix.length + 1) : key
  const parts = rest.split('.')
  const head = parts.length > 1 ? parts[0] : ''
  return head === undefined || head === '' ? 'other' : head
}

/** Groups in the order the schema declares them; a field never moves between sections. */
export function groupFields(fields: SettingsField[]): SettingsGroup[] {
  const prefix = modulePrefixOf(fields)
  const order: string[] = []
  const buckets = new Map<string, SettingsField[]>()
  for (const field of fields) {
    const id = groupIdOf(field.key, prefix)
    const bucket = buckets.get(id)
    if (bucket === undefined) {
      buckets.set(id, [field])
      order.push(id)
    } else {
      bucket.push(field)
    }
  }
  return order.map(id => ({ id, fields: buckets.get(id) ?? [] }))
}

/** "appearance" → "Appearance", for a section no catalogue names. */
export function titleCaseOf(id: string): string {
  return id
    .split(/[-_.\s]+/)
    .filter(part => part !== '')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function clampNumber(field: SettingsField, value: number): number {
  const min = typeof field.min === 'number' ? field.min : -Infinity
  const max = typeof field.max === 'number' ? field.max : Infinity
  return Math.min(max, Math.max(min, value))
}

function optionValues(field: SettingsField): string[] {
  return (field.options ?? []).map(option => option.value)
}

/** The value a field shows when the store holds nothing usable: its declared default, made renderable. */
export function fallbackOf(field: SettingsField): unknown {
  const declared = field.default
  const kind = fieldKind(field)
  if (kind === 'boolean') return typeof declared === 'boolean' ? declared : false
  if (kind === 'number') {
    const number = typeof declared === 'number' ? declared : Number(declared)
    return Number.isFinite(number) ? clampNumber(field, number) : clampNumber(field, 0)
  }
  if (kind === 'select') {
    const values = optionValues(field)
    return typeof declared === 'string' && values.includes(declared) ? declared : values[0] ?? ''
  }
  if (typeof declared === 'string') return declared
  return declared === undefined || declared === null ? '' : String(declared)
}

/** One stored value fitted to its declaration; unusable input becomes the fallback. */
export function coerce(field: SettingsField, value: unknown): unknown {
  if (value === undefined || value === null) return fallbackOf(field)
  const kind = fieldKind(field)
  if (kind === 'boolean') return typeof value === 'boolean' ? value : fallbackOf(field)
  if (kind === 'number') {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    return Number.isFinite(number) ? clampNumber(field, number) : fallbackOf(field)
  }
  if (kind === 'select') {
    return typeof value === 'string' && optionValues(field).includes(value) ? value : fallbackOf(field)
  }
  return typeof value === 'string' ? value : fallbackOf(field)
}

/** What the page shows for one key: the stored value when it fits, the default otherwise. */
export function valueOf(field: SettingsField, settings: Record<string, unknown>): unknown {
  return coerce(field, settings[field.key])
}

export function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) < 1e-9
  return left === right
}

/** Every field at its effective value: the editable copy the page starts from. */
export function draftOf(fields: SettingsField[], settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) out[field.key] = valueOf(field, settings)
  return out
}

/** Keys whose draft differs from what the store holds, in schema order. */
export function dirtyOf(
  fields: SettingsField[],
  draft: Record<string, unknown>,
  settings: Record<string, unknown>,
): string[] {
  const out: string[] = []
  for (const field of fields) {
    if (!sameValue(coerce(field, draft[field.key]), valueOf(field, settings))) out.push(field.key)
  }
  return out
}

/** The payload for settings.set: only what changed, already coerced to its declared type. */
export function savePayloadOf(
  fields: SettingsField[],
  draft: Record<string, unknown>,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of dirtyOf(fields, draft, settings)) {
    const field = fields.find(candidate => candidate.key === key)
    if (field === undefined) continue
    out[key] = coerce(field, draft[key])
  }
  return out
}

/** The draft rewritten to declared defaults; still a draft, so saving stays an explicit act. */
export function restoreDefaultsOf(fields: SettingsField[], draft: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...draft }
  for (const field of fields) out[field.key] = fallbackOf(field)
  return out
}

/** A section title from the catalogue, or the id itself when no entry names it. */
export function groupTitleOf(id: string, t: TFunction): string {
  const key = `settings.group.${id}`
  const text = t(key)
  return text === key ? titleCaseOf(id) : text
}

/** One value as text, for a title attribute: option labels are shown in the reader's language. */
export function displayValueOf(field: SettingsField, value: unknown, lang: 'zh' | 'en'): string {
  const fitted = coerce(field, value)
  if (fieldKind(field) === 'select') {
    const option = (field.options ?? []).find(candidate => candidate.value === fitted)
    if (option !== undefined) return pick(option.label, lang)
  }
  if (typeof fitted === 'boolean') return fitted ? 'true' : 'false'
  return String(fitted)
}

/** A bilingual label with the reader's language first and the other one as the fallback. */
export function pick(text: { zh: string; en: string } | undefined, lang: 'zh' | 'en'): string {
  if (text === undefined) return ''
  const primary = lang === 'zh' ? text.zh : text.en
  const fallback = lang === 'zh' ? text.en : text.zh
  return primary !== '' ? primary : fallback
}
