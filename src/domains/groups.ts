/**
 * Groups: the rail's rows, their members, their drawers, and the one bulk switch.
 *
 * The semantics are 1.x's, kept because users' files and clicks depend on them:
 *   - identity is the id, not the name: two groups may read the same and both survive;
 *   - a generated bucket that appears twice (same role + name) is merged, a hand-made one is not;
 *   - a member expands to its whole package, so a group never flips half an install;
 *   - a plugin listed by two groups is still one switch, which is what skipShared protects.
 *   - the automatic taxonomy is a plan first: a preview builds it without writing, an apply
 *     replaces only the generated groups and never a hand-made one;
 *
 * 2.0 adds one field: onDemand. A group marked on demand keeps its members out of the model
 * until the group is switched on; the mask itself is computed by tool-surface.ts, which asks
 * the host port for the names, so this file only records the intent.
 *
 * Failure contract: op failures throw a coded DomainFailure; per-member toggle outcomes are
 * structured rows. A missing member port degrades reads and refuses writes, it never crashes.
 */
import type { DomainRegistration, HostEnv, OpHandler } from '../shared/contract.js'
import type { StateV2 } from '../core/state.js'
import { asRecord, asStringList, errorText, fail, failureOf, resolveSurfacePort, type ToggleOutcome } from './tool-surface.js'
import { maskable, toolNames, RESERVED_TOOLS } from '../core/tool-names.js'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '../core/atomic.js'
import { listBundles, listPluginRows, toggleOne, invalidatePluginCache } from './plugins.js'
import { listSkills, setSkillEnabled } from './skills.js'
import { MCP_MODULE, patchPathFor } from './mcp.js'
import { insertOutsideBlocks } from '../core/patch-blocks.js'
import { removeRow, setRowDisabled } from '../../lib/patch-rows.js'

export type MemberKind = 'plugin' | 'skill' | 'tool'

export interface Member {
  kind: MemberKind
  /** Plugin id, skill id, or tool name when the kind is 'tool'. */
  id: string
}

export type GroupRole = 'official' | 'base' | 'rest' | 'mcp' | null

export interface GroupRecord {
  id: string
  name: string
  members: Member[]
  role: GroupRole
  collection: string | null
  tags: string[]
  auto: boolean
  createdAt: number
  /** 2.0: members stay out of the model until this group is switched on. */
  onDemand: boolean
  /**
   * Tool names this group owns for on-demand masking, resolved against the live view. Explicit
   * data: the host tool definition carries no owner, so a plugin member cannot be mapped onto the
   * tools it registers. A 'tool' member is the same fact in member form; both are honoured.
   */
  tools?: string[]
}

export interface CollectionRecord {
  id: string
  name: string
  order: number
}

/** One live row the panel can switch; the member port returns these. */
export interface CatalogRow {
  kind: MemberKind
  id: string
  enabled: boolean
  manageable?: boolean
  /** Package root: every loader entry of one package shares it. */
  root?: string
  moduleName?: string
}

export interface MemberPort {
  rows(): Promise<readonly CatalogRow[]> | readonly CatalogRow[]
  setEnabled(kind: MemberKind, id: string, enabled: boolean): Promise<ToggleOutcome> | ToggleOutcome
}

/** Service that lists switchable plugins/skills and flips one. */
export const MEMBERS_SERVICE = 'toolHub.members'

/**
 * Rows from the plugin and skill domains, with bundle membership mapped onto `root` so a
 * selected entry expands to its whole package. A listing failure yields an empty catalog: the
 * caller degrades and says so instead of failing the op it was asked to perform.
 */
export async function liveCatalogRows(env: HostEnv): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = []
  const rootOf = new Map<string, string>()
  try {
    const bundles = await listBundles(env)
    for (const bundle of bundles.rows) {
      for (const id of bundle.rows) rootOf.set(id, 'bundle:' + bundle.name)
    }
  }
  catch {
    /* bundles are an optimisation: without them a package expands by moduleName */
  }
  try {
    for (const row of await listPluginRows(env)) {
      rows.push({
        kind: 'plugin',
        id: row.id,
        enabled: row.enabled,
        manageable: row.manageable,
        root: rootOf.get(row.id) ?? row.moduleName,
        moduleName: row.moduleName,
      })
    }
  }
  catch {
    /* the caller reports the empty catalog */
  }
  try {
    for (const row of await listSkills(env)) rows.push({ kind: 'skill', id: row.id, enabled: row.enabled, manageable: true })
  }
  catch {
    /* same as above */
  }
  return rows
}

/** Default port: the sibling domains this build already ships. */
export function defaultMemberPort(env: HostEnv): MemberPort {
  return {
    rows: () => liveCatalogRows(env),
    async setEnabled(kind, id, enabled) {
      try {
        const outcome = await toggleOne(env, kind, id, enabled) as { ok?: unknown; code?: unknown; message?: unknown }
        const ok = outcome !== null && typeof outcome === 'object' && outcome.ok === true
        return {
          ok,
          code: typeof outcome?.code === 'string' ? outcome.code : undefined,
          message: typeof outcome?.message === 'string' ? outcome.message : ok ? 'ok' : 'refused',
        }
      }
      catch (error) {
        return { ok: false, code: (error as { code?: string }).code ?? 'internal', message: errorText(error) }
      }
    },
  }
}

/** A host may register its own member port; otherwise the shipped domains answer. */
export function resolveMemberPort(env: HostEnv): MemberPort {
  const raw = env.services.get(MEMBERS_SERVICE)
  if (raw !== null && typeof raw === 'object') {
    const port = raw as Partial<MemberPort>
    if (typeof port.rows === 'function' && typeof port.setEnabled === 'function') return raw as MemberPort
  }
  return defaultMemberPort(env)
}

export const DEFAULT_COLLECTION_ID = 'default'
export const DEFAULT_COLLECTION_NAME = '默认分组群'
export const MAX_GROUP_NAME = 60
export const MAX_COLLECTION_NAME = 40
export const MAX_TAGS = 8
export const MAX_TAG_LENGTH = 24
const COLLECTION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

// -- normalization -----------------------------------------------------------

/** Roles are the rail's sections; the old task/skill axis folds into rest. */
export function cleanRole(value: unknown): GroupRole {
  if (value === 'official' || value === 'base' || value === 'rest' || value === 'mcp') return value
  if (value === 'task' || value === 'skill') return 'rest'
  return null
}

export function cleanTags(value: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of asStringList(value)) {
    const tag = entry.trim().slice(0, MAX_TAG_LENGTH)
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

export function normalizeMember(value: unknown): Member | null {
  const raw = asRecord(value)
  const kind: MemberKind | null = raw.kind === 'skill'
    ? 'skill'
    : raw.kind === 'plugin' ? 'plugin' : raw.kind === 'tool' ? 'tool' : null
  if (kind === null) return null
  const id = kind === 'tool' ? toolNames([raw.id])[0] ?? '' : typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '' || (kind === 'tool' && RESERVED_TOOLS.has(id))) return null
  return { kind, id }
}

export function memberKey(member: Member): string {
  return member.kind + ':' + member.id
}

/** Drawers, default first and always present: a group needs a home. */
export function normalizeCollections(value: unknown): CollectionRecord[] {
  const collections: CollectionRecord[] = [{ id: DEFAULT_COLLECTION_ID, name: DEFAULT_COLLECTION_NAME, order: 0 }]
  const seen = new Set<string>([DEFAULT_COLLECTION_ID])
  for (const entry of Array.isArray(value) ? value : []) {
    const raw = asRecord(entry)
    const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_COLLECTION_NAME) : ''
    if (id === '' || name === '' || seen.has(id) || !COLLECTION_ID.test(id)) continue
    seen.add(id)
    collections.push({ id, name, order: typeof raw.order === 'number' ? raw.order : collections.length })
  }
  return collections.sort((left, right) => left.order - right.order)
}

/**
 * Groups from a state file, with the two 1.x repairs: duplicate ids collapse, and generated
 * buckets that read the same (role + name) merge into one. A hand-made group keeps its own
 * identity even when it reuses a name.
 */
export function normalizeGroups(value: unknown): GroupRecord[] {
  const loaded: GroupRecord[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(value) ? value : []) {
    const raw = asRecord(entry)
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_GROUP_NAME) : ''
    if (name === '') continue
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'g' + (loaded.length + 1)
    if (seen.has(id)) continue
    seen.add(id)
    const members: Member[] = []
    const memberKeys = new Set<string>()
    for (const candidate of Array.isArray(raw.members) ? raw.members : []) {
      const member = normalizeMember(candidate)
      if (member === null || memberKeys.has(memberKey(member))) continue
      memberKeys.add(memberKey(member))
      members.push(member)
    }
    loaded.push({
      id,
      name,
      members,
      role: cleanRole(raw.role),
      collection: raw.collection === null ? null : typeof raw.collection === 'string' ? raw.collection : DEFAULT_COLLECTION_ID,
      tags: cleanTags(raw.tags),
      auto: raw.auto === true,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      onDemand: raw.onDemand === true,
      tools: maskable(asStringList(raw.tools)),
    })
  }
  const byKey = new Map<string, GroupRecord>()
  const merged: GroupRecord[] = []
  for (const group of loaded) {
    if (group.role === null) {
      merged.push(group)
      continue
    }
    const generated = group.auto || /^[am]\d/.test(group.id)
    const key = (generated ? 'gen' : 'hand:' + group.id) + '\u0000' + group.role + '\u0000' + group.name
    const kept = byKey.get(key)
    if (kept === undefined) {
      byKey.set(key, group)
      merged.push(group)
      continue
    }
    const keys = new Set(kept.members.map(memberKey))
    for (const member of group.members) {
      if (keys.has(memberKey(member))) continue
      keys.add(memberKey(member))
      kept.members.push(member)
    }
    kept.tags = cleanTags([...kept.tags, ...group.tags])
    kept.onDemand = kept.onDemand || group.onDemand
    // A generated bucket that appears twice keeps every tool either copy named.
    kept.tools = maskable([...(kept.tools ?? []), ...(group.tools ?? [])])
  }
  return merged
}

// -- member cleaning and package expansion -----------------------------------

export function knownKeys(rows: readonly CatalogRow[]): Set<string> {
  const keys = new Set<string>()
  for (const row of rows) keys.add(row.kind + ':' + row.id)
  return keys
}

/**
 * Keep members that resolve to a live row, deduplicated; unknown members never enter a group.
 * Tool members resolve against `knownTools` when the caller has the live view; without it they
 * are kept (a group saved before the tools page loaded must not lose them).
 */
export function cleanMembers(value: unknown, known: ReadonlySet<string>, knownTools?: ReadonlySet<string>): Member[] {
  const out: Member[] = []
  const seen = new Set<string>()
  for (const candidate of Array.isArray(value) ? value : []) {
    const member = normalizeMember(candidate)
    if (member === null) continue
    const key = memberKey(member)
    // A tool member resolves against the tool inventory, not against the plugin/skill rows.
    if (member.kind === 'tool') {
      if (knownTools !== undefined && !knownTools.has(member.id)) continue
    }
    else if (!known.has(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(member)
  }
  return out
}

/**
 * Whoever a caller picks, the whole package comes along: a group never holds half of a tree.
 * Skills have no children, so they pass through untouched.
 */
export function expandBundles(members: readonly Member[], rows: readonly CatalogRow[]): Member[] {
  const rootOf = new Map<string, string>()
  const tree = new Map<string, string[]>()
  for (const row of rows) {
    if (row.kind !== 'plugin') continue
    const root = row.moduleName === MCP_MODULE ? 'mcp:' + row.id : (row.root ?? row.moduleName ?? row.id)
    rootOf.set(row.id, root)
    tree.set(root, [...(tree.get(root) ?? []), row.id])
  }
  const out: Member[] = []
  const seen = new Set<string>()
  for (const member of members) {
    const ids = member.kind === 'plugin' ? (tree.get(rootOf.get(member.id) ?? '') ?? [member.id]) : [member.id]
    for (const id of ids) {
      const key = member.kind + ':' + id
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: member.kind, id })
    }
  }
  return out
}

function replace(groups: readonly GroupRecord[], next: GroupRecord): GroupRecord[] {
  return groups.map(group => (group.id === next.id ? next : group))
}

function findGroup(groups: readonly GroupRecord[], id: unknown): GroupRecord | undefined {
  return typeof id === 'string' ? groups.find(group => group.id === id) : undefined
}

function cleanCollection(value: unknown, collections: readonly CollectionRecord[]): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return DEFAULT_COLLECTION_ID
  return collections.some(entry => entry.id === value) ? value : DEFAULT_COLLECTION_ID
}

// -- group operations (pure; the handlers persist) ---------------------------

export interface GroupContext {
  known: ReadonlySet<string>
  rows: readonly CatalogRow[]
  collections: readonly CollectionRecord[]
  now: number
}

export interface GroupSaveResult {
  groups: GroupRecord[]
  group: GroupRecord
}

export function applyGroupSave(groups: readonly GroupRecord[], payload: Record<string, unknown>, ctx: GroupContext): GroupSaveResult {
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, MAX_GROUP_NAME) : ''
  if (name === '') throw fail('bad-name', 'a group needs a name')
  const members = expandBundles(cleanMembers(payload.members, ctx.known), ctx.rows)
  const collection = cleanCollection(payload.collection, ctx.collections)
  const id = typeof payload.id === 'string' ? payload.id : ''
  const existing = findGroup(groups, id)
  const onDemand = payload.onDemand === undefined ? (existing?.onDemand ?? false) : payload.onDemand === true
  const tools = payload.tools === undefined ? maskable(existing?.tools ?? []) : cleanToolNames(payload.tools)
  if (existing !== undefined) {
    const next: GroupRecord = {
      ...existing,
      name,
      members,
      role: cleanRole(payload.role) ?? existing.role,
      collection,
      tags: payload.tags === undefined ? existing.tags : cleanTags(payload.tags),
      auto: false,
      onDemand,
      tools,
    }
    return { groups: replace(groups, next), group: next }
  }
  const created: GroupRecord = {
    id: 'g' + ctx.now.toString(36),
    name,
    members,
    role: cleanRole(payload.role),
    collection,
    tags: cleanTags(payload.tags),
    auto: false,
    createdAt: ctx.now,
    onDemand,
    tools,
  }
  return { groups: [...groups, created], group: created }
}

export function applyGroupDelete(groups: readonly GroupRecord[], id: unknown): GroupRecord[] {
  const wanted = typeof id === 'string' ? id : ''
  return groups.filter(group => group.id !== wanted)
}

/** Anything the caller did not mention keeps its relative order at the end. */
export function applyGroupReorder(groups: readonly GroupRecord[], order: unknown): GroupRecord[] {
  const byId = new Map(groups.map(group => [group.id, group]))
  const next: GroupRecord[] = []
  for (const id of asStringList(order)) {
    const group = byId.get(id)
    if (group === undefined) continue
    next.push(group)
    byId.delete(id)
  }
  for (const group of groups) if (byId.has(group.id)) next.push(group)
  return next
}

export function applyGroupMove(
  groups: readonly GroupRecord[],
  payload: Record<string, unknown>,
  collections: readonly CollectionRecord[],
): GroupRecord {
  const group = findGroup(groups, payload.id)
  if (group === undefined) throw fail('no-group', 'that group no longer exists')
  const wanted = payload.collection === null
    ? null
    : typeof payload.collection === 'string' ? payload.collection : DEFAULT_COLLECTION_ID
  if (wanted !== null && !collections.some(entry => entry.id === wanted)) {
    throw fail('unknown-collection', 'no drawer "' + wanted + '"')
  }
  group.collection = wanted
  return group
}

export function applyGroupClean(groups: readonly GroupRecord[], id: unknown, known: ReadonlySet<string>): { groups: GroupRecord[]; removed: number } {
  const group = findGroup(groups, id)
  if (group === undefined) throw fail('no-group', 'that group no longer exists')
  const before = group.members.length
  group.members = group.members.filter(member => known.has(memberKey(member)))
  return { groups: replace(groups, group), removed: before - group.members.length }
}

export function applyGroupAdd(
  groups: readonly GroupRecord[],
  payload: Record<string, unknown>,
  ctx: GroupContext,
): { groups: GroupRecord[]; group: GroupRecord; added: number } {
  const group = findGroup(groups, payload.id)
  if (group === undefined) throw fail('no-group', 'that group no longer exists')
  const incoming = expandBundles(cleanMembers(payload.members, ctx.known), ctx.rows)
  const have = new Set(group.members.map(memberKey))
  const added = incoming.filter(member => !have.has(memberKey(member)))
  group.members = [...group.members, ...added]
  return { groups: replace(groups, group), group, added: added.length }
}

export function applyGroupRemove(groups: readonly GroupRecord[], payload: Record<string, unknown>, known: ReadonlySet<string>): { groups: GroupRecord[]; removed: number } {
  const group = findGroup(groups, payload.id)
  if (group === undefined) throw fail('no-group', 'that group no longer exists')
  const drop = new Set(cleanMembers(payload.members, known).map(memberKey))
  const before = group.members.length
  group.members = group.members.filter(member => !drop.has(memberKey(member)))
  return { groups: replace(groups, group), removed: before - group.members.length }
}

export interface TogglePlan {
  group: GroupRecord
  members: Member[]
  skippedShared: number
}

/**
 * The members one bulk switch would reach. \`skipShared\` leaves alone every member another
 * group also lists: a bulk flip must not quietly reach into a group the user is not looking at.
 */
export function planGroupToggle(
  groups: readonly GroupRecord[],
  id: unknown,
  rows: readonly CatalogRow[],
  skipShared: boolean,
): TogglePlan {
  const group = findGroup(groups, id)
  if (group === undefined) throw fail('no-group', 'that group no longer exists')
  // Tool members are masking data, not switchable rows: a bulk switch must never hand them to
  // the member port, which only knows plugins and skills.
  const switchable = group.members.filter(member => member.kind !== 'tool')
  let members = expandBundles(switchable, rows)
  if (skipShared) {
    const elsewhere = new Set<string>()
    for (const other of groups) {
      if (other.id === group.id) continue
      for (const member of other.members) elsewhere.add(memberKey(member))
    }
    members = members.filter(member => !elsewhere.has(memberKey(member)))
  }
  return { group, members, skippedShared: expandBundles(switchable, rows).length - members.length }
}

/** Ids of switchable members that on-demand groups keep masked until the group is switched on. */
export function onDemandMembers(groups: readonly GroupRecord[]): Member[] {
  const out: Member[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    if (!group.onDemand) continue
    for (const member of group.members) {
      if (member.kind === 'tool') continue
      const key = memberKey(member)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: member.kind, id: member.id })
    }
  }
  return out
}

// -- on-demand tool names ----------------------------------------------------

/** One trimmed, deduplicated, reserved-free list from whatever a caller passed. */
function cleanToolNames(value: unknown): string[] {
  return maskable(toolNames(value))
}

/** Every tool name one group owns, in `tools` or as a 'tool' member. */
export function groupToolNames(group: GroupRecord): string[] {
  const names: string[] = [...(group.tools ?? [])]
  for (const member of group.members) if (member.kind === 'tool') names.push(member.id)
  return maskable(names.filter(name => !RESERVED_TOOLS.has(name)))
}

/**
 * Tool names on-demand groups own, resolved against the live view. `known` is the host's tool
 * inventory; without it every stored name is reported (the panel still lists them), while
 * {@link onDemandDeny} stays empty because a mask may only name tools the host can restrict.
 */
export function onDemandToolNames(groups: readonly GroupRecord[], known?: readonly string[] | null): string[] {
  const allowed = known === undefined || known === null ? null : new Set(known)
  const out: string[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const name of groupToolNames(group)) {
      if (seen.has(name) || (allowed !== null && !allowed.has(name))) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/**
 * Names the mask must deny for one agent: the tools of every on-demand group that is not open.
 *
 * Group names compare case-insensitively (the reference implementation lowercases both sides).
 * A tool shared by an open group and a closed one stays hidden: the closed group has not been
 * switched on, so it still owns its tools.
 */
export function onDemandDeny(
  groups: readonly GroupRecord[],
  known: readonly string[],
  open: ReadonlySet<string>,
): string[] {
  const allowed = new Set(known)
  const opened = new Set<string>()
  for (const name of open) opened.add(name.trim().toLowerCase())
  const out: string[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    if (group.onDemand !== true) continue
    if (opened.has(group.name.trim().toLowerCase())) continue
    for (const name of groupToolNames(group)) {
      if (seen.has(name) || !allowed.has(name) || RESERVED_TOOLS.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

export interface GroupToolsResult {
  groups: GroupRecord[]
  group: GroupRecord
  tools: string[]
}

/** Replace the explicit tool list of one group; names are filtered to the live view. */
export function applyGroupTools(
  groups: readonly GroupRecord[],
  id: unknown,
  tools: unknown,
  known?: readonly string[] | null,
): GroupToolsResult {
  const group = findGroup(groups, id)
  if (group === undefined) throw fail('no-group', 'that group no longer exists')
  const allowed = known === undefined || known === null ? null : new Set(known)
  const next = cleanToolNames(tools).filter(name => allowed === null || allowed.has(name))
  group.tools = next
  return { groups: replace(groups, group), group, tools: next }
}

/** Flip the on-demand flag of one group without touching its members. */
export function applyGroupOnDemand(groups: readonly GroupRecord[], id: unknown, onDemand: unknown): { groups: GroupRecord[]; group: GroupRecord } {
  const group = findGroup(groups, id)
  if (group === undefined) throw fail('no-group', 'that group no longer exists')
  group.onDemand = onDemand === true
  return { groups: replace(groups, group), group }
}

// -- auto groups (rule-based taxonomy) ---------------------------------------

/** The four buckets the automatic plan can produce, in the order the rail shows them. */
export type AutoRole = 'official' | 'mcp' | 'base' | 'rest'

/** The labels 1.x used; a user's existing auto groups read the same after the port. */
export const AUTO_ROLE_NAMES: Record<AutoRole, string> = {
  official: '官方',
  mcp: 'MCP 服务器',
  base: '第三方底座',
  rest: '用户下载',
}

const AUTO_ROLE_RANK: Record<AutoRole, number> = { official: 0, mcp: 1, base: 2, rest: 3 }

/** Package names shaped like the client's own: those rows are never a third-party bucket. */
const AUTO_OFFICIAL_PREFIX = /^(?:@deepseek-ai\/|cordis[:-])/

/**
 * Words that describe a layer rather than a job. A third-party row whose text hits more of these
 * than of the task words is something you keep on, not something you switch per task.
 */
const AUTO_BASE_HINTS = /context|compact|memory|session|sidebar|theme|layout|market|install|usage|cost|panel|runtime|bridge|gateway|registry|storage|shell|ui|tools|permission|sandbox|prompt/
const AUTO_TASK_HINTS = /generate|search|crawl|convert|extract|review|batch|analy|render|edit|translate|export|import|notify|fetch|scrape|compose|draw|animate/

/** What the classifier reads: the row's own metadata, nothing inferred from a manifest. */
export interface AutoPluginRow {
  id: string
  moduleName: string
  name: string
  description: string
  mcp: boolean
  manageable: boolean
}

export interface AutoSkillRow {
  id: string
}

export interface AutoRows {
  plugins: readonly AutoPluginRow[]
  skills: readonly AutoSkillRow[]
}

/** One generated bucket, before it has an id. */
export interface AutoPlanEntry {
  name: string
  role: AutoRole
  collection: string | null
  tags: string[]
  members: Member[]
}

/**
 * Which bucket a plugin belongs to. The 1.x order is kept on purpose: an MCP server row is also an
 * `@deepseek-ai/` package, so it has to be claimed before the official prefix swallows it.
 *
 * Both hint patterns are matched without /g, exactly as 1.x did, so each contributes at most one
 * hit: a third-party row is a base layer only when a layer word appears and no job word does.
 */
export function autoRoleFor(row: AutoPluginRow): AutoRole {
  const module = row.moduleName.toLowerCase()
  const text = (row.moduleName + ' ' + row.description + ' ' + row.name).toLowerCase()
  if (row.mcp) return 'mcp'
  if (AUTO_OFFICIAL_PREFIX.test(module)) return 'official'
  const baseHits = text.match(AUTO_BASE_HINTS) === null ? 0 : 1
  const taskHits = text.match(AUTO_TASK_HINTS) === null ? 0 : 1
  return baseHits > taskHits ? 'base' : 'rest'
}

/**
 * The plan the auto preview shows and the apply writes. Four buckets — official, MCP servers, the
 * always-on base layer, and what the user downloaded — because that is the decision a user makes
 * when flipping switches. A row the loader cannot flip is left out: a group must be actionable.
 *
 * Tags stay empty here. 1.x dressed generated groups with the package's own `keywords`, and the
 * 2.0 plugin row does not carry them (plugins.ts reads row meta only), so an inferred word would
 * pretend to be package metadata.
 */
export function buildAutoPlan(rows: AutoRows): AutoPlanEntry[] {
  const buckets = new Map<AutoRole, Member[]>()
  const push = (role: AutoRole, member: Member): void => {
    buckets.set(role, [...(buckets.get(role) ?? []), member])
  }
  for (const row of rows.plugins) {
    if (!row.manageable) continue
    push(autoRoleFor(row), { kind: 'plugin', id: row.id })
  }
  // Skills are something the user downloaded, so they share that bucket; the type column is what
  // tells them apart from plugins.
  for (const row of rows.skills) push('rest', { kind: 'skill', id: row.id })
  return [...buckets.entries()]
    .sort((left, right) => AUTO_ROLE_RANK[left[0]] - AUTO_ROLE_RANK[right[0]])
    .map(([role, members]) => ({
      name: AUTO_ROLE_NAMES[role],
      role,
      collection: role === 'rest' ? null : DEFAULT_COLLECTION_ID,
      tags: [],
      members,
    }))
}

export interface AutoApplyResult {
  groups: GroupRecord[]
  created: GroupRecord[]
  members: number
}

/**
 * Write a plan over an existing group list. Every automatic group is replaced and every hand-made
 * group survives: leaving the old taxonomy behind would show two truths in one rail. A group whose
 * id is automatic but which somehow lost its flag is still automatic, so the id alone is enough.
 * Hand-made groups keep their place at the front; the generated ones follow in plan order.
 */
export function applyAutoPlan(
  groups: readonly GroupRecord[],
  plan: readonly AutoPlanEntry[],
  now: number,
): AutoApplyResult {
  const keep = groups.filter(group => !group.auto && !/^a\d-/.test(group.id))
  const created: GroupRecord[] = plan
    .filter(entry => entry.members.length > 0)
    .map((entry, index) => ({
      id: 'a' + index + '-' + now.toString(36),
      name: entry.name,
      members: entry.members.map(member => ({ ...member })),
      role: entry.role,
      collection: entry.collection,
      tags: [...entry.tags],
      auto: true,
      createdAt: now,
      onDemand: false,
    }))
  return {
    groups: [...keep, ...created],
    created,
    members: created.reduce((sum, group) => sum + group.members.length, 0),
  }
}

/** Service a host may register to hand the auto builder richer rows than the toggle catalog. */
export const AUTO_ROWS_SERVICE = 'toolHub.autoRows'

export interface AutoRowPort {
  plugins(): Promise<readonly AutoPluginRow[]> | readonly AutoPluginRow[]
  skills(): Promise<readonly AutoSkillRow[]> | readonly AutoSkillRow[]
}

/** Default port: the plugin and skill domains this build already ships. */
export function defaultAutoRowPort(env: HostEnv): AutoRowPort {
  return { plugins: () => listPluginRows(env), skills: () => listSkills(env) }
}

/** A host may register its own auto row port; otherwise the shipped domains answer. */
export function resolveAutoRowPort(env: HostEnv): AutoRowPort {
  const raw = env.services.get(AUTO_ROWS_SERVICE)
  if (raw !== null && typeof raw === 'object') {
    const port = raw as Partial<AutoRowPort>
    if (typeof port.plugins === 'function' && typeof port.skills === 'function') return raw as AutoRowPort
  }
  return defaultAutoRowPort(env)
}

interface AutoCatalog {
  rows: AutoRows
  degraded: string | null
}

/**
 * Rows for one plan. A source that fails leaves its half empty and reports why: a preview may
 * degrade and say so, while apply refuses rather than write a half-built taxonomy.
 */
async function readAutoRows(env: HostEnv): Promise<AutoCatalog> {
  const port = resolveAutoRowPort(env)
  const errors: string[] = []
  let plugins: readonly AutoPluginRow[] = []
  let skills: readonly AutoSkillRow[] = []
  try {
    plugins = await port.plugins()
  }
  catch (error) {
    errors.push('plugins: ' + errorText(error))
  }
  try {
    skills = await port.skills()
  }
  catch (error) {
    errors.push('skills: ' + errorText(error))
  }
  return {
    rows: { plugins, skills },
    degraded: errors.length === 0 ? null : 'auto catalog incomplete: ' + errors.join('; '),
  }
}

// -- drawers -----------------------------------------------------------------

export function applyCollectionSave(collections: readonly CollectionRecord[], payload: Record<string, unknown>, now: number): CollectionRecord[] {
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, MAX_COLLECTION_NAME) : ''
  if (name === '') throw fail('bad-name', 'a drawer needs a name')
  const asked = typeof payload.id === 'string' ? payload.id.trim().toLowerCase() : ''
  const existing = asked === '' ? undefined : collections.find(entry => entry.id === asked)
  if (existing !== undefined) return collections.map(entry => (entry.id === existing.id ? { ...entry, name } : entry))
  let id = COLLECTION_ID.test(asked) ? asked : 'c' + now.toString(36)
  while (collections.some(entry => entry.id === id)) id = id + '-2'
  return [...collections, { id, name, order: collections.length }]
}

export function applyCollectionDelete(
  collections: readonly CollectionRecord[],
  groups: readonly GroupRecord[],
  id: unknown,
): { collections: CollectionRecord[]; groups: GroupRecord[] } {
  const wanted = typeof id === 'string' ? id : ''
  if (wanted === DEFAULT_COLLECTION_ID) throw fail('default-collection', 'the default drawer cannot be removed')
  if (!collections.some(entry => entry.id === wanted)) throw fail('unknown-collection', 'no drawer "' + wanted + '"')
  return {
    collections: collections.filter(entry => entry.id !== wanted),
    groups: groups.map(group => (group.collection === wanted ? { ...group, collection: DEFAULT_COLLECTION_ID } : group)),
  }
}

// -- handlers ----------------------------------------------------------------

interface Catalog {
  rows: CatalogRow[]
  known: Set<string>
  degraded: string | null
}

/** Rows as the group and preset plans want them; malformed entries are dropped, not guessed. */
export function cleanCatalogRows(value: unknown): CatalogRow[] {
  const rows: CatalogRow[] = []
  for (const raw of Array.isArray(value) ? value : []) {
    const record = asRecord(raw)
    const kind: MemberKind | null = record.kind === 'skill' ? 'skill' : record.kind === 'plugin' ? 'plugin' : null
    const id = typeof record.id === 'string' ? record.id : ''
    if (kind === null || id === '') continue
    rows.push({
      kind,
      id,
      enabled: record.enabled === true,
      manageable: record.manageable !== false,
      root: typeof record.root === 'string' ? record.root : undefined,
      moduleName: typeof record.moduleName === 'string' ? record.moduleName : undefined,
    })
  }
  return rows
}

async function readCatalog(env: HostEnv): Promise<Catalog> {
  try {
    const rows = cleanCatalogRows(await resolveMemberPort(env).rows())
    return { rows, known: knownKeys(rows), degraded: null }
  }
  catch (error) {
    return { rows: [], known: new Set<string>(), degraded: 'member catalog unavailable: ' + errorText(error) }
  }
}

function groupList(groups: readonly GroupRecord[]): GroupRecord[] {
  return groups.map(group => ({ ...group, members: [...group.members], tags: [...group.tags] }))
}

function saveGroups(env: HostEnv, groups: GroupRecord[]): void {
  env.state.groups = groups
}

const groupSave: OpHandler = async (payload, env) => {
  const catalog = await readCatalog(env)
  const collections = normalizeCollections(env.state.collections)
  const groups = normalizeGroups(env.state.groups)
  const result = applyGroupSave(groups, asRecord(payload), { ...catalog, collections, now: env.now() })
  saveGroups(env, result.groups)
  const backup = await env.save('group-save')
  return { group: result.group, groups: groupList(result.groups), backup, degraded: catalog.degraded }
}

/** Refresh the per-agent masks after the tool names of an on-demand group changed. */
function refreshMasks(env: HostEnv): void {
  const mask = env.services.get('toolHub.mask') as { sync?: () => void } | undefined
  mask?.sync?.()
}

const groupOnDemand: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const groups = normalizeGroups(env.state.groups)
  const result = applyGroupOnDemand(groups, body.id, body.onDemand)
  saveGroups(env, result.groups)
  const backup = await env.save('group-on-demand')
  refreshMasks(env)
  return { group: result.group, groups: groupList(result.groups), backup }
}

const groupTools: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  if (!Array.isArray(body.tools)) throw fail('bad-payload', 'tools must be an array of tool names')
  const known = resolveSurfacePort(env.services)?.known() ?? null
  const groups = normalizeGroups(env.state.groups)
  const result = applyGroupTools(groups, body.id, body.tools, known)
  saveGroups(env, result.groups)
  const backup = await env.save('group-tools')
  refreshMasks(env)
  return { group: result.group, tools: result.tools, groups: groupList(result.groups), backup }
}

const groupDelete: OpHandler = async (payload, env) => {
  const groups = normalizeGroups(env.state.groups)
  const next = applyGroupDelete(groups, asRecord(payload).id)
  saveGroups(env, next)
  const backup = await env.save('group-delete')
  return { groups: groupList(next), backup }
}

const groupReorder: OpHandler = async (payload, env) => {
  const groups = normalizeGroups(env.state.groups)
  const next = applyGroupReorder(groups, asRecord(payload).order)
  saveGroups(env, next)
  const backup = await env.save('group-reorder')
  return { groups: groupList(next), order: next.map(group => group.id), backup }
}

const groupMove: OpHandler = async (payload, env) => {
  const collections = normalizeCollections(env.state.collections)
  const groups = normalizeGroups(env.state.groups)
  const group = applyGroupMove(groups, asRecord(payload), collections)
  saveGroups(env, groups)
  const backup = await env.save('group-move')
  return { group, groups: groupList(groups), backup }
}

const groupClean: OpHandler = async (payload, env) => {
  const catalog = await readCatalog(env)
  if (catalog.degraded !== null) throw fail('capability-missing', catalog.degraded)
  const groups = normalizeGroups(env.state.groups)
  const result = applyGroupClean(groups, asRecord(payload).id, catalog.known)
  saveGroups(env, result.groups)
  const backup = await env.save('group-clean')
  return { groups: groupList(result.groups), removed: result.removed, backup }
}

const groupAdd: OpHandler = async (payload, env) => {
  const catalog = await readCatalog(env)
  const groups = normalizeGroups(env.state.groups)
  const result = applyGroupAdd(groups, asRecord(payload), { ...catalog, collections: normalizeCollections(env.state.collections), now: env.now() })
  saveGroups(env, result.groups)
  const backup = await env.save('group-add')
  return { group: result.group, groups: groupList(result.groups), added: result.added, backup, degraded: catalog.degraded }
}

const groupRemove: OpHandler = async (payload, env) => {
  const catalog = await readCatalog(env)
  const groups = normalizeGroups(env.state.groups)
  const result = applyGroupRemove(groups, asRecord(payload), catalog.known)
  saveGroups(env, result.groups)
  const backup = await env.save('group-remove')
  return { groups: groupList(result.groups), removed: result.removed, backup }
}

const groupToggle: OpHandler = async (payload, env) => {
  const body = asRecord(payload)
  const catalog = await readCatalog(env)
  const port = resolveMemberPort(env)
  const groups = normalizeGroups(env.state.groups)
  const enabled = body.enabled === true
  const plan = planGroupToggle(groups, body.id, catalog.rows, body.skipShared === true)
  const results: Array<{ kind: MemberKind; id: string; ok: boolean; code?: string; message?: string }> = []
  for (const member of plan.members) {
    try {
      const outcome = await port.setEnabled(member.kind, member.id, enabled)
      results.push({ kind: member.kind, id: member.id, ok: outcome.ok === true, ...(outcome.ok === true ? {} : failureOf(new Error(outcome.message ?? 'refused'))) })
    }
    catch (error) {
      results.push({ kind: member.kind, id: member.id, ok: false, ...failureOf(error) })
    }
    // The plugin manager persists and reloads per call; a small gap keeps the loader from
    // seeing two writes to the same layer inside one tick.
    await new Promise(done => setTimeout(done, 60))
  }
  return {
    group: plan.group.name,
    enabled,
    requested: plan.members.length,
    changed: results.filter(row => row.ok).length,
    skippedShared: plan.skippedShared,
    results,
  }
}

/**
 * Whole-group switch in two writes: every plugin member's patch row is edited in one document,
 * then the loader reloads once. The per-member path reloads the whole tree for every member
 * (a minute on a large profile), so a generated group of 188 could never finish inside a click.
 */
let batchSequence: Promise<unknown> = Promise.resolve()

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = batchSequence.then(work, work)
  batchSequence = run.then(() => undefined, () => undefined)
  return run
}

/** Disable one row, appending an override when the bundle never wrote a patch row for it. */
function disableRow(text: string, id: string): string {
  try {
    return setRowDisabled(text, id, true)
  }
  catch (error) {
    // Only a missing row is appendable; an expression or a duplicate id must reach the caller.
    if ((error as { code?: string }).code !== 'row-not-found') throw error
    // Never land inside another panel's managed block: its next rewrite would drop this row.
    return insertOutsideBlocks(text, '- id: ' + JSON.stringify(id) + '\n  disabled: true')
  }
}

const groupBatch: OpHandler = async (payload, env) => serialized(async () => {
  const body = asRecord(payload)
  const catalog = await readCatalog(env)
  const groups = normalizeGroups(env.state.groups)
  const enabled = body.enabled === true
  const plan = planGroupToggle(groups, body.id, catalog.rows, body.skipShared === true)
  const rows = await listPluginRows(env, true).catch(() => [])
  const byId = new Map(rows.map(row => [row.id, row]))
  const patchPath = patchPathFor(env)
  let text = patchPath === null ? '' : await readFile(patchPath, 'utf8').catch(() => '')
  const touched: string[] = []
  const results: Array<{ kind: MemberKind; id: string; ok: boolean; code?: string; message?: string }> = []
  let skillsChanged = 0

  for (const member of plan.members) {
    if (member.kind === 'skill') {
      try {
        const outcome = await setSkillEnabled(env, member.id, enabled)
        if (outcome.ok === true) skillsChanged += 1
        results.push({ kind: 'skill', id: member.id, ok: outcome.ok === true, ...(outcome.ok === true ? {} : failureOf(new Error(outcome.message ?? 'refused'))) })
      }
      catch (error) {
        results.push({ kind: 'skill', id: member.id, ok: false, ...failureOf(error) })
      }
      continue
    }
    const row = byId.get(member.id)
    if (row === undefined) {
      results.push({ kind: 'plugin', id: member.id, ok: false, code: 'unknown-plugin', message: 'no plugin entry answers to ' + member.id })
      continue
    }
    if (row.enabled === enabled) {
      results.push({ kind: 'plugin', id: member.id, ok: true, code: 'unchanged' })
      continue
    }
    if (!enabled) {
      if (row.readOnlyReason !== null) {
        results.push({ kind: 'plugin', id: member.id, ok: false, code: 'read-only', message: row.readOnlyReason })
        continue
      }
      if (row.builtinUi) {
        results.push({ kind: 'plugin', id: member.id, ok: false, code: 'builtin-ui', message: 'ships inside the client UI bundle' })
        continue
      }
      if (row.self) {
        results.push({ kind: 'plugin', id: member.id, ok: false, code: 'self-protected', message: 'this panel cannot disable itself' })
        continue
      }
    }
    if (patchPath === null) {
      results.push({ kind: 'plugin', id: member.id, ok: false, code: 'patch-missing', message: 'this host exposes no profile patch file' })
      continue
    }
    const patchId = row.patchId ?? member.id
    try {
      text = enabled ? removeRow(text, patchId) : disableRow(text, patchId)
    }
    catch (error) {
      results.push({ kind: 'plugin', id: member.id, ok: false, ...failureOf(error) })
      continue
    }
    touched.push(patchId)
    results.push({ kind: 'plugin', id: member.id, ok: true })
  }

  if (patchPath !== null && touched.length > 0) await writeFileAtomic(patchPath, text, 0o644)

  let application = 'none'
  let reloadError: string | null = null
  if (touched.length > 0) {
    const manager = env.services.get('pluginManager') as {
      reload?: (ids: string[]) => Promise<unknown>
      configure?: (operation: () => Promise<unknown>) => Promise<unknown>
    } | undefined
    if (typeof manager?.reload === 'function') {
      try {
        // The HMR reconciler only accepts a reload inside its exclusive section; configure is
        // the manager's own wrapper for that (setPluginEnabled uses it too).
        const reload = async (): Promise<unknown> => await manager.reload!(enabled ? touched : [])
        const outcome = (typeof manager.configure === 'function' ? await manager.configure(reload) : await reload()) as { application?: unknown; error?: unknown; restartReason?: unknown }
        application = typeof outcome?.application === 'string' ? outcome.application : outcome?.restartReason === undefined ? 'applied' : 'restart-required'
        if (typeof outcome?.error === 'string' && outcome.error !== '') reloadError = outcome.error
      }
      catch (error) {
        application = 'failed'
        reloadError = errorText(error)
      }
    }
    else {
      application = 'pending-restart'
    }
    invalidatePluginCache()
  }

  return {
    group: plan.group.name,
    enabled,
    requested: plan.members.length,
    changed: results.filter(row => row.ok && row.code !== 'unchanged').length,
    unchanged: results.filter(row => row.code === 'unchanged').length,
    skills: skillsChanged,
    skippedShared: plan.skippedShared,
    patched: touched.length,
    application,
    reloadError,
    results,
  }
})

const autoPreview: OpHandler = async (_payload, env) => {
  const catalog = await readAutoRows(env)
  const plan = buildAutoPlan(catalog.rows)
  return {
    plan,
    groups: plan.length,
    members: plan.reduce((sum, entry) => sum + entry.members.length, 0),
    degraded: catalog.degraded,
  }
}

const autoApply: OpHandler = async (_payload, env) => {
  const catalog = await readAutoRows(env)
  if (catalog.degraded !== null) throw fail('capability-missing', catalog.degraded)
  const now = env.now()
  const plan = buildAutoPlan(catalog.rows)
  const result = applyAutoPlan(normalizeGroups(env.state.groups), plan, now)
  saveGroups(env, result.groups)
  // `appliedAt` is the only key this op owns; another build's fields under `auto` ride along.
  env.state.auto = { ...env.state.auto, appliedAt: now }
  const backup = await env.save('auto-apply')
  return {
    groups: result.created.length,
    members: result.members,
    appliedAt: env.state.auto.appliedAt,
    plan: groupList(result.created),
    backup,
  }
}

const collectionSave: OpHandler = async (payload, env) => {
  const collections = applyCollectionSave(normalizeCollections(env.state.collections), asRecord(payload), env.now())
  env.state.collections = collections
  const backup = await env.save('collection-save')
  return { collections, backup }
}

const collectionDelete: OpHandler = async (payload, env) => {
  const result = applyCollectionDelete(
    normalizeCollections(env.state.collections),
    normalizeGroups(env.state.groups),
    asRecord(payload).id,
  )
  env.state.collections = result.collections
  saveGroups(env, result.groups)
  const backup = await env.save('collection-delete')
  return { collections: result.collections, groups: groupList(result.groups), backup }
}

/** The groups domain: rows, members, drawers and the bulk switch. */
export function groupsDomain(): DomainRegistration {
  return {
    module: {
      id: 'groups',
      title: { zh: '分组', en: 'Groups' },
      ops: [
        { id: 'group.save', write: true, audit: true, note: 'Creates or updates a group; members are filtered to live rows and expanded to whole packages.' },
        { id: 'group.onDemand', write: true, audit: true, note: 'Flips the on-demand flag of one group and refreshes the per-agent masks.' },
        { id: 'group.tools', write: true, audit: true, note: 'Replaces the explicit tool list of one on-demand group, filtered to the live view and free of reserved names.' },
        { id: 'group.delete', write: true, audit: true, note: 'Removes a group from state.json.' },
        { id: 'group.toggle', write: true, audit: true, note: 'Switches the plugins and skills of a group through the host, honouring skipShared.' },
        { id: 'group.batch', write: true, audit: true, note: 'Switches a whole group in one patch write and one loader reload; the panel uses this.' },
        { id: 'group.reorder', write: true, audit: true, note: 'Reorders groups in state.json.' },
        { id: 'group.move', write: true, audit: true, note: 'Moves a group into another drawer.' },
        { id: 'group.clean', write: true, audit: true, note: 'Drops group members that no longer resolve to a live plugin or skill.' },
        { id: 'group.add', write: true, audit: true, note: 'Appends members to a group, expanding whole packages.' },
        { id: 'group.remove', write: true, audit: true, note: 'Removes members from a group.' },
        { id: 'auto.preview', write: false, audit: false, note: 'Builds the rule-based group plan without touching state.' },
        { id: 'auto.apply', write: true, audit: true, note: 'Replaces every automatic group with a fresh plan and stamps auto.appliedAt.' },
        { id: 'collection.save', write: true, audit: true, note: 'Creates or renames a drawer in state.json.' },
        { id: 'collection.delete', write: true, audit: true, note: 'Deletes a drawer and reassigns its groups to the default drawer.' },
      ],
    },
    handlers: {
      'group.save': groupSave,
      'group.onDemand': groupOnDemand,
      'group.tools': groupTools,
      'group.delete': groupDelete,
      'group.toggle': groupToggle,
      'group.batch': groupBatch,
      'group.reorder': groupReorder,
      'group.move': groupMove,
      'group.clean': groupClean,
      'group.add': groupAdd,
      'group.remove': groupRemove,
      'auto.preview': autoPreview,
      'auto.apply': autoApply,
      'collection.save': collectionSave,
      'collection.delete': collectionDelete,
    },
  }
}