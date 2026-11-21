/**
 * The tools tree: one collapsible parent per MCP server, and one per name prefix for the rest.
 *
 * Grouping, filtering and the parent write are pure functions so the probe can run them; the
 * component only spends them on the shared GroupTree. Keys are namespaced (mcp:/prefix:) because
 * one server and one prefix may carry the same name.
 *
 * Expansion is remembered under 'tool-hub-tree-tools' and starts empty, so every parent is
 * collapsed on a first visit; a non-empty search forces every rendered parent open, because a
 * match behind a collapsed row would read as a missing tool. A term that matches a parent label
 * keeps every child of that parent: searching a server name lists its tools, not nothing.
 *
 * The parent switch exists for MCP groups whose children can all be restricted — an agent-scope
 * tool is fixed, and a bulk write that silently skipped it would lie about the switch. With a
 * search active the group is its visible rows, so the switch never reaches a row hidden by the
 * filter. It writes tool.save with the next full deny list computed from the snapshot (deny =
 * every tool the snapshot reports as disabled), never from an unsaved draft, so a draft can
 * neither shrink nor grow the list; a successful write therefore drops the draft it never read.
 */
import * as React from 'react'
import { Badge, Switch } from '../components.js'
import type { Lang, TFunction } from '../i18n.js'
import type { ToolRow } from '../types.js'
import { GroupTree, groupByPrefix, useTreeExpansion } from './package-tree.js'
import type { TreeGroup } from './package-tree.js'

/** localStorage key holding the open parents of the tools tree. */
export const TREE_STORAGE_KEY = 'tool-hub-tree-tools'

/** Parent keys are namespaced: one server and one built-in prefix may share a name. */
const MCP_KEY = 'mcp:'
const PREFIX_KEY = 'prefix:'

export type ToolGroupKind = 'mcp' | 'prefix'

export interface ToolTreeGroup extends TreeGroup<ToolRow> {
  /** Where the parent came from. */
  kind: ToolGroupKind
  /** The server name, or the prefix token, without the key namespace. */
  id: string
}

export interface ToolTree {
  groups: ToolTreeGroup[]
  /** Every visible row in group order; the toolbar count and the empty branch read this. */
  rows: ToolRow[]
}

/** The two-language label the view used before the tree; kept here because the tree owns rows. */
export function copyLabel(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

/** The committed installation deny list: every tool the snapshot reports as disabled. */
export function denyOf(tools: readonly ToolRow[]): string[] {
  return tools.filter(tool => !tool.enabled).map(tool => tool.name)
}

/** The next full deny list for a group write: names leave on enable, join on disable. */
export function nextDeny(deny: readonly string[], names: readonly string[], enable: boolean): string[] {
  const next = new Set(deny)
  for (const name of names) {
    if (enable) next.delete(name)
    else next.add(name)
  }
  return [...next].sort()
}

/** A parent may write a bulk deny only when every child can be restricted. */
export function groupSwitchable(rows: readonly ToolRow[]): boolean {
  return rows.length > 0 && rows.every(tool => tool.fixed !== true)
}

/** A row is visible on its own name or on its server; the parent label is checked separately. */
function toolMatches(tool: ToolRow, needle: string): boolean {
  if (needle === '') return true
  if (tool.name.toLowerCase().includes(needle)) return true
  return (tool.server ?? '').toLowerCase().includes(needle)
}

/**
 * Group the tools, then filter them: server rows under their server, the rest under their prefix.
 * A parent whose own label matches keeps every child, so a server-name search lists its tools.
 */
export function buildToolTree(tools: readonly ToolRow[], term: string, t: TFunction): ToolTree {
  const needle = term.trim().toLowerCase()
  const servers = new Map<string, ToolRow[]>()
  const loose: ToolRow[] = []
  for (const tool of tools) {
    const server = tool.server ?? ''
    if (server === '') {
      loose.push(tool)
      continue
    }
    const members = servers.get(server)
    if (members === undefined) servers.set(server, [tool])
    else members.push(tool)
  }

  const groups: ToolTreeGroup[] = []
  const take = (kind: ToolGroupKind, id: string, label: string, meta: string | undefined, members: ToolRow[]): void => {
    const labelHit = needle !== '' && label.toLowerCase().includes(needle)
    const rows = labelHit ? members.slice() : members.filter(tool => toolMatches(tool, needle))
    if (rows.length === 0) return
    groups.push({
      key: (kind === 'mcp' ? MCP_KEY : PREFIX_KEY) + id,
      kind,
      id,
      label,
      meta,
      rows,
      /* MCP parents toggle the lazy server (on = every tool available, off = hidden); prefix
         groups are fixed built-ins and have no safe bulk write. */
      enabled: rows.filter(tool => tool.enabled).length,
      switchable: kind === 'mcp',
      ...(kind === 'mcp' ? { allEnabled: rows.every(tool => tool.lazy !== true) } : {}),
    })
  }

  const ordered = [...servers.entries()].sort(([left], [right]) => (left < right ? -1 : 1))
  for (const [server, members] of ordered) take('mcp', server, server, 'MCP', members)
  // A prefix is worth its own parent only when it names a real cluster; singletons and pairs
  // collapse into one "other built-ins" group so the top level stays short.
  const MIN_PREFIX_GROUP = 3
  const buckets = groupByPrefix(loose, tool => tool.name, t('tree.builtin'))
  const looseRest: ToolRow[] = []
  for (const bucket of buckets) {
    if (bucket.key !== '~' && bucket.rows.length >= MIN_PREFIX_GROUP) take('prefix', bucket.key, bucket.label, undefined, bucket.rows)
    else looseRest.push(...bucket.rows)
  }
  if (looseRest.length > 0) take('prefix', 'other', t('tree.builtinOther'), undefined, looseRest)

  return { groups, rows: groups.flatMap(group => group.rows) }
}

interface ToolLineProps {
  tool: ToolRow
  hidden: boolean
  lang: Lang
  t: TFunction
  costs: Record<string, number>
  showCosts: boolean
  onToggle: (name: string, hide: boolean) => void
}

/** One tool row: name, its state badges, and the switch that edits the draft. */
function ToolLine(props: ToolLineProps): React.ReactElement {
  const { tool, hidden, lang, t, costs, showCosts, onToggle } = props
  return (
    <div className="th-row">
      <div className="th-row-body">
        <span className="th-row-name th-mono">{tool.name}</span>
        <span className="th-row-meta">
          <Badge tone={hidden ? 'warn' : 'on'}>{hidden ? t('tools.masked') : t('tools.visible')}</Badge>
          {tool.lazy === true ? <Badge tone="off">{t('tools.lazy')}</Badge> : null}
          {tool.fixed === true ? <Badge tone="warn">{copyLabel(lang, '固定', 'fixed')}</Badge> : null}
          {tool.lazyHidden === true ? <Badge tone="off">{copyLabel(lang, '懒加载隐藏', 'lazy-hidden')}</Badge> : null}
          {showCosts && costs[tool.name] !== undefined ? <Badge tone="neutral">{'~' + String(costs[tool.name]) + ' tok'}</Badge> : null}
        </span>
      </div>
      <Switch
        checked={!hidden}
        label={t('a11y.switch', { name: tool.name })}
        onChange={next => { onToggle(tool.name, !next) }}
      />
    </div>
  )
}

export interface ToolsTreeProps {
  groups: ToolTreeGroup[]
  lang: Lang
  t: TFunction
  /** Names in the draft mask; a row switch edits this, so rows show the draft, not the snapshot. */
  masked: Set<string>
  costs: Record<string, number>
  showCosts: boolean
  /** A non-empty search: every rendered parent is open. */
  forceOpen: boolean
  /** 'tool.save:<group key>' in flight, so the shared busy state reaches the parent switch. */
  busyKey: string | null
  onToggle: (name: string, hide: boolean) => void
  onBulk: (group: TreeGroup<ToolRow>, next: boolean) => void
}

/** The tree itself: expansion memory plus the shared GroupTree, one row per tool. */
export function ToolsTree(props: ToolsTreeProps): React.ReactElement {
  const { groups, lang, t, masked, costs, showCosts, forceOpen, busyKey, onToggle, onBulk } = props
  const expansion = useTreeExpansion(TREE_STORAGE_KEY)
  return (
    <GroupTree
      groups={groups}
      lang={lang}
      forceOpen={forceOpen}
      expansion={expansion}
      busyKey={busyKey}
      onBulk={onBulk}
      renderRow={tool => (
        <ToolLine
          key={tool.name}
          tool={tool}
          hidden={masked.has(tool.name)}
          lang={lang}
          t={t}
          costs={costs}
          showCosts={showCosts}
          onToggle={onToggle}
        />
      )}
    />
  )
}
