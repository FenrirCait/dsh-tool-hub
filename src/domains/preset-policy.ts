/**
 * Preset tool policy: the pure half of G11a.
 *
 * One preset can carry its own tool policy: a disabled list plus named groups of patterns. The
 * policy is the user's statement of intent, so it outlives the live view - a preset whose servers
 * are off still knows which tools it wants masked. Everything in this file is a pure function over
 * plain values: the host validates with it, the panel previews and diffs with it, and a probe needs
 * nothing but the compiled module to exercise it.
 *
 * **Groups are recorded, not enforced.** G11a stores and edits them; hiding their members at
 * runtime needs the on-demand exposure state that G10 owns (fork前缀 included), so the runtime deny
 * list here is exactly {@link deniedByPolicy} - the disabled names. The panel says so out loud, and
 * `policyCounts` still reports the group count so the difference is visible instead of implied.
 *
 * The tool-name prefix is redeclared on purpose: this module is imported by the browser bundle,
 * and importing the host's tool-surface module from here would pull the domain graph (and its
 * node-side imports) into the client typecheck. probe/next/preset-policy.mjs asserts the two
 * constants never drift apart.
 */

/** Must equal MCP_TOOL_PREFIX in src/domains/tool-surface.ts; a probe checks it. */
export const POLICY_TOOL_PREFIX = 'mcp__'

/** A named set of exact tool names or wildcard patterns ("mcp__github__*"). */
export interface PresetToolGroup {
  name: string
  description?: string
  /** Exact names or patterns containing `*`; first matching group wins. */
  patterns: string[]
}

/** One preset's tool policy: what it masks, and the groups it remembers. */
export interface PresetToolPolicy {
  disabled: string[]
  groups: PresetToolGroup[]
}

/** A policy that masks nothing; what "reset" writes and what a fresh preset starts from. */
export function emptyPolicy(): PresetToolPolicy {
  return { disabled: [], groups: [] }
}

/** Caps, applied by normalization instead of failing a load: a broken file must still open. */
export const MAX_POLICY_GROUPS = 50
export const MAX_POLICY_PATTERNS = 200
export const MAX_POLICY_DISABLED = 2000
export const MAX_POLICY_NAME = 60
export const MAX_POLICY_DESCRIPTION = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/** Maskable tool names: `mcp__*`, trimmed, deduplicated, sorted, capped. */
export function cleanToolNames(value: unknown, limit = MAX_POLICY_DISABLED): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of stringList(value)) {
    const name = entry.trim()
    if (name === '' || !name.startsWith(POLICY_TOOL_PREFIX) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= limit) break
  }
  return out.sort()
}

function cleanPatterns(value: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of stringList(value)) {
    const pattern = entry.trim()
    if (pattern === '' || seen.has(pattern)) continue
    seen.add(pattern)
    out.push(pattern)
    if (out.length >= MAX_POLICY_PATTERNS) break
  }
  return out
}

/**
 * Normalize one policy, or `undefined` when the value is not a policy at all.
 *
 * `undefined` and `null` both mean "this preset has no policy" - the apply path has to tell that
 * apart from "a policy that masks nothing", which is what {@link emptyPolicy} is for. An empty
 * group name is dropped (a name is the only thing that makes a group addressable), a duplicate name
 * is dropped first-one-wins on the lowercased name, and an empty pattern or description is dropped
 * rather than stored as `''`.
 */
export function normalizeToolPolicy(value: unknown): PresetToolPolicy | undefined {
  if (!isRecord(value)) return undefined
  const groups: PresetToolGroup[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(value.groups) ? value.groups : []) {
    const raw = isRecord(entry) ? entry : {}
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_POLICY_NAME) : ''
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const group: PresetToolGroup = { name, patterns: cleanPatterns(raw.patterns) }
    const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, MAX_POLICY_DESCRIPTION) : ''
    if (description !== '') group.description = description
    groups.push(group)
    if (groups.length >= MAX_POLICY_GROUPS) break
  }
  return { disabled: cleanToolNames(value.disabled), groups }
}

/** A deep copy, so two presets never share one policy object. */
export function clonePolicy(policy: PresetToolPolicy): PresetToolPolicy {
  return {
    disabled: [...policy.disabled],
    groups: policy.groups.map(group => ({
      name: group.name,
      ...(group.description === undefined ? {} : { description: group.description }),
      patterns: [...group.patterns],
    })),
  }
}

/**
 * The canonical text of a policy, used to decide "is the draft dirty".
 *
 * Order of `disabled` and of the patterns inside a group is not a user-visible change, so both are
 * sorted here; group order is user-visible (first matching group wins) and is kept.
 */
export function policySignature(policy: PresetToolPolicy | undefined): string {
  if (policy === undefined) return 'none'
  return JSON.stringify({
    disabled: [...policy.disabled].sort(),
    groups: policy.groups.map(group => ({
      name: group.name.toLowerCase(),
      description: group.description ?? '',
      patterns: [...group.patterns].sort(),
    })),
  })
}

/** True when the draft would change what the preset stores. */
export function policyDirty(saved: PresetToolPolicy | undefined, draft: PresetToolPolicy | undefined): boolean {
  return policySignature(saved) !== policySignature(draft)
}

/** How many entries a draft differs from its saved policy by; what the draft bar counts. */
export function policyChangeCount(saved: PresetToolPolicy | undefined, draft: PresetToolPolicy | undefined): number {
  if (!policyDirty(saved, draft)) return 0
  const before = saved ?? emptyPolicy()
  const after = draft ?? emptyPolicy()
  const beforeDisabled = new Set(before.disabled)
  const afterDisabled = new Set(after.disabled)
  let count = 0
  for (const name of after.disabled) if (!beforeDisabled.has(name)) count += 1
  for (const name of before.disabled) if (!afterDisabled.has(name)) count += 1
  const beforeGroups = new Map(before.groups.map(group => [group.name.toLowerCase(), group]))
  const afterGroups = new Map(after.groups.map(group => [group.name.toLowerCase(), group]))
  for (const [key, group] of afterGroups) {
    const old = beforeGroups.get(key)
    if (old === undefined) {
      count += 1 + group.patterns.length
      continue
    }
    if (old.name !== group.name) count += 1
    if ((old.description ?? '') !== (group.description ?? '')) count += 1
    const oldPatterns = new Set(old.patterns)
    const newPatterns = new Set(group.patterns)
    for (const pattern of group.patterns) if (!oldPatterns.has(pattern)) count += 1
    for (const pattern of old.patterns) if (!newPatterns.has(pattern)) count += 1
  }
  for (const key of beforeGroups.keys()) if (!afterGroups.has(key)) count += 1
  return count
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Exact name, or a pattern where `*` stands for any run of characters (including none). */
export function patternMatch(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name
  const parts = pattern.split('*').map(escapeRegExp)
  return new RegExp('^' + parts.join('[\\s\\S]*') + '$').test(name)
}

/**
 * Which group owns each tool: a tool belongs to the first group whose any pattern matches it, and
 * every later match is ignored (that is the rule the editor and the diagnostics both apply).
 */
export function memberOf(policy: PresetToolPolicy, toolNames: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of toolNames) {
    for (const group of policy.groups) {
      if (!group.patterns.some(pattern => patternMatch(pattern, name))) continue
      out.set(name, group.name)
      break
    }
  }
  return out
}

export interface PolicyIssues {
  /** Groups whose patterns match no tool in the supplied catalog (also covers "no patterns"). */
  emptyGroups: string[]
  /** Tools that are group members and disabled at the same time. */
  disabledMembers: Array<{ tool: string; group: string }>
  /** Tools matched by more than one group; only the first group owns them. */
  duplicateMembers: Array<{ tool: string; groups: string[] }>
  /** Disabled names the catalog no longer has. */
  orphans: string[]
}

/**
 * The four mistakes worth telling the user about, computed against one catalog. `toolNames` is the
 * maskable catalog the editor is looking at, so a group that only matches tools from a server that
 * is currently off shows up as empty - a warning, never a failed save.
 */
export function policyIssues(policy: PresetToolPolicy, toolNames: readonly string[]): PolicyIssues {
  const names = [...new Set(toolNames)]
  const disabled = new Set(policy.disabled)
  const emptyGroups: string[] = []
  const disabledMembers: Array<{ tool: string; group: string }> = []
  const duplicateMembers: Array<{ tool: string; groups: string[] }> = []
  const matched = new Map<string, string[]>()
  for (const group of policy.groups) {
    const hits = names.filter(name => group.patterns.some(pattern => patternMatch(pattern, name)))
    if (hits.length === 0) emptyGroups.push(group.name)
    for (const tool of hits) {
      const list = matched.get(tool)
      if (list === undefined) matched.set(tool, [group.name])
      else list.push(group.name)
    }
  }
  for (const [tool, groups] of matched) {
    if (disabled.has(tool)) disabledMembers.push({ tool, group: groups[0] ?? '' })
    if (groups.length > 1) duplicateMembers.push({ tool, groups })
  }
  const known = new Set(names)
  const orphans = policy.disabled.filter(name => !known.has(name))
  return { emptyGroups, disabledMembers, duplicateMembers, orphans }
}

/** What the runtime masks for this policy today: the disabled names, groups not yet enforced. */
export function deniedByPolicy(policy: PresetToolPolicy): string[] {
  return [...policy.disabled]
}

/** Counts for the row badge and the apply receipt. */
export function policyCounts(policy: PresetToolPolicy): { disabled: number; groups: number } {
  return { disabled: policy.disabled.length, groups: policy.groups.length }
}

export interface ProjectedPolicy {
  policy: PresetToolPolicy
  /** Groups whose members all disappeared from the target catalog; skipped, and named. */
  skippedGroups: string[]
  /** Members plus disabled names that survived; zero means "nothing in common". */
  entries: number
}

/**
 * Project one policy onto another preset's tool catalog, the way copying between presets works:
 * a disabled name survives only when the target knows it, and a group survives only while it still
 * owns at least one tool the earlier surviving groups have not taken. Group names, descriptions and
 * the surviving patterns are copied verbatim.
 */
export function projectPolicy(policy: PresetToolPolicy, toolNames: readonly string[]): ProjectedPolicy {
  const names = [...new Set(toolNames)]
  const known = new Set(names)
  const disabled = policy.disabled.filter(name => known.has(name))
  const groups: PresetToolGroup[] = []
  const skippedGroups: string[] = []
  const taken = new Set<string>()
  for (const group of policy.groups) {
    const patterns = group.patterns.filter(pattern => names.some(name => patternMatch(pattern, name)))
    const free = names.filter(name => !taken.has(name) && patterns.some(pattern => patternMatch(pattern, name)))
    if (patterns.length === 0 || free.length === 0) {
      skippedGroups.push(group.name)
      continue
    }
    for (const name of free) taken.add(name)
    groups.push({
      name: group.name,
      ...(group.description === undefined ? {} : { description: group.description }),
      patterns,
    })
  }
  return { policy: { disabled, groups }, skippedGroups, entries: taken.size + disabled.length }
}
