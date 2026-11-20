/**
 * Host portability: dshmarket groups, and the third-party off/restore switch.
 *
 * Both are 1.x ports and keep the 1.x wire shapes:
 * - dshmarket keeps its own file at `<profile>/.dsh-market/state.json` as
 *   `{ groups: { name: [packageName, …] }, groupOrder: [name, …] }`. It is read-only here:
 *   `market.status` maps its packages onto live plugin rows, and `market.import` copies the
 *   grouping into our state without ever writing that file.
 * - `third.*` operates on "everything the user installed": enabled plugins that are neither
 *   official nor this panel, MCP server rows (an official module name, but the server is whatever
 *   the user configured), and enabled skills. `third.off` writes a rollback point first, so
 *   `third.restore` never depends on remembering what used to be on.
 *
 * The mapping and filtering halves are pure (`marketGroupsFrom`, `mergeMarketGroups`,
 * `thirdPartyTargetsFrom`, `normalizeRollback`) so a probe can check them without a live host;
 * the handlers below are thin wrappers around core/io, the plugin and skill domains, and the
 * atomic writer.
 */
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeJsonAtomic } from '../core/atomic.js'
import { stateFile } from '../core/io.js'
import { MAX_GROUP_NAME, normalizeGroups, type GroupRecord, type Member } from '../domains/groups.js'
import { patchPathFor } from '../domains/mcp.js'
import { listPluginRows, toggleMany, type PluginRow } from '../domains/plugins.js'
import { listSkills, type SkillRow } from '../domains/skills.js'
import type { HostEnv, OpHandler } from '../shared/contract.js'
import type { OpDefinition } from '../shared/types.js'
import { Failure } from './dispatch.js'

// ── shared helpers ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value !== 'undefined' && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Re-throw a domain error as the dispatch `Failure` so its stable code survives `run()`. */
function asFailure(fallback: string, error: unknown): Failure {
  if (error instanceof Failure) return error
  const own = isRecord(error) && typeof error.code === 'string' && error.code !== '' ? error.code : fallback
  return new Failure(own, messageOf(error))
}

// ── dshmarket ────────────────────────────────────────────────────────────────

/** One group as the panel shows it; `packages` and `members` are counts, as in 1.x. */
export interface MarketGroup {
  name: string
  packages: number
  members: number
  ids: string[]
  missing: string[]
}

export interface MarketStatus {
  available: boolean
  file: string | null
  groups: MarketGroup[]
  error: string | null
}

/** What `market.import` left behind, in 1.x's shape. */
export interface MarketSkip {
  name: string
  reason: 'no-installed-members' | 'name-taken' | 'empty-name'
}

export interface MarketImportResult {
  imported: number
  skipped: MarketSkip[]
  missing: number
  groups: Array<{ name: string; members: number; missing: number }>
  total: number
  file: string | null
}

/** The dshmarket file beside the profile patch, or null when the host exposes no profile. */
export function marketFileFor(patchFile: string | null): string | null {
  return patchFile === null ? null : join(dirname(patchFile), '.dsh-market', 'state.json')
}

/** The row fields the mapping reads; `PluginRow` satisfies this. */
export interface MarketPluginRow {
  id: string
  moduleName?: string | undefined
}

/**
 * Map a parsed dshmarket document onto live plugin rows. Read-only and total: a document without a
 * `groups` object answers `available:false`, and a package nobody installed lands in `missing`
 * instead of being invented as a member.
 *
 * Order follows `groupOrder` when it is an array of names that still have a group entry; without
 * it, the object's own key order is used (1.x's fallback).
 */
export function marketGroupsFrom(
  doc: unknown,
  rows: readonly MarketPluginRow[],
  file: string | null,
): MarketStatus {
  if (!isRecord(doc) || !isRecord(doc.groups)) {
    return { available: false, file, groups: [], error: null }
  }
  const table = doc.groups
  const byModule = new Map<string, string[]>()
  for (const row of rows) {
    if (typeof row.moduleName !== 'string' || row.moduleName === '') continue
    const list = byModule.get(row.moduleName)
    if (list === undefined) byModule.set(row.moduleName, [row.id])
    else if (!list.includes(row.id)) list.push(row.id)
  }
  const order = Array.isArray(doc.groupOrder)
    ? doc.groupOrder.filter((name): name is string => typeof name === 'string' && Array.isArray(table[name]))
    : Object.keys(table)
  const groups: MarketGroup[] = []
  for (const name of order) {
    const listed = table[name]
    const packages = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === 'string') : []
    const ids: string[] = []
    const missing: string[] = []
    for (const pkg of packages) {
      const members = byModule.get(pkg)
      if (members === undefined) missing.push(pkg)
      else for (const id of members) if (!ids.includes(id)) ids.push(id)
    }
    groups.push({ name, packages: packages.length, members: ids.length, ids, missing })
  }
  return { available: groups.length > 0, file, groups, error: null }
}

export interface MarketMergeResult {
  /** The whole list to persist (current groups plus the imported ones). */
  groups: GroupRecord[]
  created: GroupRecord[]
  summaries: Array<{ name: string; members: number; missing: number }>
  skipped: MarketSkip[]
  missing: number
}

/**
 * Copy dshmarket groups into a normalized group list. A group whose name is already taken is
 * skipped rather than merged, so a second import never duplicates or reshuffles groups the user may
 * have edited since (1.x rule). Imported ids are `m<source index>-<now base36>`, and they land in
 * no drawer (`collection: null`), exactly like 1.x.
 */
export function mergeMarketGroups(
  current: unknown,
  market: readonly MarketGroup[],
  now: number,
): MarketMergeResult {
  const groups = normalizeGroups(current)
  const taken = new Set(groups.map(group => group.name))
  const stamp = now.toString(36)
  const created: GroupRecord[] = []
  const summaries: Array<{ name: string; members: number; missing: number }> = []
  const skipped: MarketSkip[] = []
  let missing = 0
  market.forEach((entry, index) => {
    if (entry.members === 0) {
      skipped.push({ name: entry.name, reason: 'no-installed-members' })
      return
    }
    const name = entry.name.trim().slice(0, MAX_GROUP_NAME)
    if (name === '') {
      skipped.push({ name: entry.name, reason: 'empty-name' })
      return
    }
    if (taken.has(name)) {
      skipped.push({ name, reason: 'name-taken' })
      return
    }
    taken.add(name)
    const members: Member[] = entry.ids.map(id => ({ kind: 'plugin', id }))
    const group: GroupRecord = {
      id: `m${index}-${stamp}`,
      name,
      members,
      role: null,
      collection: null,
      tags: [],
      auto: false,
      createdAt: now,
      onDemand: false,
    }
    created.push(group)
    summaries.push({ name, members: members.length, missing: entry.missing.length })
    missing += entry.missing.length
  })
  return { groups: [...groups, ...created], created, summaries, skipped, missing }
}

async function readMarket(env: HostEnv): Promise<MarketStatus> {
  const file = marketFileFor(patchPathFor(env))
  if (file === null) return { available: false, file: null, groups: [], error: null }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return {
      available: false,
      file,
      groups: [],
      error: missing ? null : 'cannot read dshmarket state: ' + messageOf(error),
    }
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  }
  catch (error) {
    return { available: false, file, groups: [], error: 'cannot read dshmarket state: ' + messageOf(error) }
  }
  if (!isRecord(doc) || !isRecord(doc.groups)) return { available: false, file, groups: [], error: null }
  let rows: PluginRow[]
  try {
    rows = await listPluginRows(env)
  }
  catch (error) {
    throw asFailure('list-failed', error)
  }
  return marketGroupsFrom(doc, rows, file)
}

// ── third-party targets ──────────────────────────────────────────────────────

/** The plugin fields the filter reads; `PluginRow` satisfies this. */
export interface ThirdPluginLike {
  id: string
  name?: string | undefined
  moduleName?: string | undefined
  enabled?: boolean | undefined
  mcp?: boolean | undefined
  self?: boolean | undefined
  official?: boolean | undefined
  manageable?: boolean | undefined
  role?: string | null | undefined
}

/** The skill fields the filter reads; `SkillRow` satisfies this. */
export interface ThirdSkillLike {
  id: string
  name?: string | undefined
  enabled?: boolean | undefined
  role?: string | null | undefined
}

export interface ThirdTarget {
  kind: 'plugin' | 'skill'
  id: string
  name: string
  moduleName: string | null
  mcp: boolean
  role: string | null
}

function targetOf(kind: ThirdTarget['kind'], row: ThirdPluginLike | ThirdSkillLike): ThirdTarget {
  const full = row as ThirdPluginLike
  const fallbackRole = kind === 'skill' ? 'rest' : null
  return {
    kind,
    id: row.id,
    name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
    moduleName: kind === 'plugin' && typeof full.moduleName === 'string' && full.moduleName !== '' ? full.moduleName : null,
    mcp: kind === 'plugin' && full.mcp === true,
    role: typeof full.role === 'string' ? full.role : fallbackRole,
  }
}

/**
 * Everything the switch treats as third-party, in 1.x's order and dedupe: enabled non-official
 * plugins, then MCP server rows (their module is official, their server is not), then enabled
 * skills. The panel itself, official packages, disabled entries and rows the loader cannot flip
 * never enter the list.
 */
export function thirdPartyTargetsFrom(
  plugins: readonly ThirdPluginLike[],
  skills: readonly ThirdSkillLike[],
): ThirdTarget[] {
  const ordinary = plugins.filter(row => row.enabled === true
    && row.self !== true
    && row.official !== true
    && row.manageable !== false)
  const mcp = plugins.filter(row => row.enabled === true
    && row.mcp === true
    && row.self !== true
    && row.manageable !== false
    && !ordinary.includes(row))
  const picked: Array<{ kind: ThirdTarget['kind']; row: ThirdPluginLike | ThirdSkillLike }> = []
  for (const row of ordinary) picked.push({ kind: 'plugin', row })
  for (const row of mcp) picked.push({ kind: 'plugin', row })
  for (const row of skills) if (row.enabled === true) picked.push({ kind: 'skill', row })
  const seen = new Set<string>()
  const targets: ThirdTarget[] = []
  for (const entry of picked) {
    const key = entry.kind + ':' + entry.row.id
    if (seen.has(key)) continue
    seen.add(key)
    targets.push(targetOf(entry.kind, entry.row))
  }
  return targets
}

async function thirdPartyTargets(env: HostEnv): Promise<ThirdTarget[]> {
  let plugins: PluginRow[]
  let skills: SkillRow[]
  try {
    plugins = await listPluginRows(env)
    skills = await listSkills(env)
  }
  catch (error) {
    throw asFailure('list-failed', error)
  }
  return thirdPartyTargetsFrom(plugins, skills)
}

// ── rollback points ──────────────────────────────────────────────────────────

/** Rollback points live beside the state file, so a sandbox profile stays isolated. */
export function rollbackDir(): string {
  return join(dirname(stateFile()), 'rollback')
}

/** 1.x's file name: an ISO stamp with `:` and `.` folded to `-`, so names sort by time. */
export function rollbackName(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-') + '.json'
}

export interface RollbackDoc {
  version: number
  at: string
  patch: string | null
  plugins: string[]
  skills: string[]
}

export interface RollbackSnapshot extends RollbackDoc {
  file: string
}

/** Read a rollback document defensively: only the fields a restore uses survive. */
export function normalizeRollback(raw: unknown): RollbackDoc | null {
  if (!isRecord(raw)) return null
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    at: typeof raw.at === 'string' ? raw.at : '',
    patch: typeof raw.patch === 'string' ? raw.patch : null,
    plugins: strings(raw.plugins),
    skills: strings(raw.skills),
  }
}

/** The newest rollback point on disk, or null when there is none (or the newest is unreadable). */
export async function latestRollback(): Promise<RollbackSnapshot | null> {
  let names: string[]
  try {
    names = await readdir(rollbackDir())
  }
  catch {
    return null
  }
  const files = names.filter(name => name.endsWith('.json')).sort()
  const last = files[files.length - 1]
  if (last === undefined) return null
  try {
    const doc = normalizeRollback(JSON.parse(await readFile(join(rollbackDir(), last), 'utf8')))
    return doc === null ? null : { file: last, ...doc }
  }
  catch {
    return null
  }
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function marketStatusHandler(_payload: unknown, env: HostEnv): Promise<MarketStatus> {
  return await readMarket(env)
}

async function marketImportHandler(_payload: unknown, env: HostEnv): Promise<MarketImportResult> {
  const market = await readMarket(env)
  if (market.error !== null) throw new Failure('market-unreadable', market.error)
  if (!market.available) throw new Failure('market-empty', 'dshmarket has no groups to import')
  const merge = mergeMarketGroups(env.state.groups, market.groups, env.now())
  // One save for the whole import, and none when every group was skipped: an import that changed
  // nothing should not add a backup generation to the state file.
  if (merge.created.length > 0) {
    env.state.groups = merge.groups
    await env.save('portability:market-import')
  }
  return {
    imported: merge.created.length,
    skipped: merge.skipped,
    missing: merge.missing,
    groups: merge.summaries,
    total: market.groups.length,
    file: market.file,
  }
}

async function thirdStatusHandler(_payload: unknown, env: HostEnv): Promise<{
  targets: ThirdTarget[]
  snapshot: RollbackSnapshot | null
}> {
  return { targets: await thirdPartyTargets(env), snapshot: await latestRollback() }
}

async function thirdOffHandler(_payload: unknown, env: HostEnv): Promise<{
  disabled: number
  failed: number
  snapshot: string | null
}> {
  const targets = await thirdPartyTargets(env)
  if (targets.length === 0) return { disabled: 0, failed: 0, snapshot: null }
  const at = env.now()
  const file = rollbackName(at)
  const dir = rollbackDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, file)
  // The rollback point lands before the first switch is flipped: a crash midway leaves a restore
  // path, and an off that changes nothing deletes it again below.
  const doc: RollbackDoc = {
    version: 1,
    at: new Date(at).toISOString(),
    patch: patchPathFor(env),
    plugins: targets.filter(target => target.kind === 'plugin').map(target => target.id),
    skills: targets.filter(target => target.kind === 'skill').map(target => target.id),
  }
  await writeJsonAtomic(path, doc)
  const result = await toggleMany(env, targets.map(target => ({ kind: target.kind, id: target.id })), false)
  const failed = result.results.filter(row => isRecord(row) && row.ok !== true).length
  // A rollback point that restores nothing is worse than none: every write was refused, so the
  // file must not stay behind pretending a restore is available (1.x rule).
  if (result.changed === 0) {
    await rm(path, { force: true }).catch(() => {})
    return { disabled: 0, failed, snapshot: null }
  }
  await env.save('portability:third-off')
  return { disabled: result.changed, failed, snapshot: file }
}

async function thirdRestoreHandler(_payload: unknown, env: HostEnv): Promise<{
  restored: number
  failed: number
  snapshot: string
}> {
  const snapshot = await latestRollback()
  if (snapshot === null) throw new Failure('no-snapshot', 'there is no rollback point to restore')
  const items = [
    ...snapshot.plugins.map(id => ({ kind: 'plugin', id })),
    ...snapshot.skills.map(id => ({ kind: 'skill', id })),
  ]
  const result = await toggleMany(env, items, true)
  const failed = result.results.filter(row => isRecord(row) && row.ok !== true).length
  if (result.changed > 0) await env.save('portability:third-restore')
  return { restored: result.changed, failed, snapshot: snapshot.file }
}

// ── registration ─────────────────────────────────────────────────────────────

export const PORTABILITY_OPS: OpDefinition[] = [
  { id: 'market.status', write: false, audit: false, note: 'Reads dshmarket\'s own group file and maps it onto live plugin rows; writes nothing.' },
  { id: 'market.import', write: true, audit: true, note: 'Copies dshmarket groups into state.groups, skipping names already taken; saves once.' },
  { id: 'third.status', write: false, audit: false, note: 'Lists the third-party plugins and skills a switch-off would touch, plus the newest rollback point.' },
  { id: 'third.off', write: true, audit: true, note: 'Writes a rollback point, then switches every third-party plugin and skill off.' },
  { id: 'third.restore', write: true, audit: true, note: 'Switches back on everything the newest rollback point lists.' },
]

/** One handler per declared op; index.ts folds these into the core domain. */
export function portabilityHandlers(): Record<string, OpHandler> {
  return {
    'market.status': marketStatusHandler,
    'market.import': marketImportHandler,
    'third.status': thirdStatusHandler,
    'third.off': thirdOffHandler,
    'third.restore': thirdRestoreHandler,
  }
}
