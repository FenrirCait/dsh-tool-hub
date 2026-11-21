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
 * Each row also carries the host's reasons for hiding it (install / scope / preset / on-demand /
 * lazy) as compact badges: the row switch reports the draft, so without them a row switched back
 * on would look unexplained. The reasons never touch a write — the parent switch still computes
 * from the committed deny list alone.
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
import type { ToolDenyReason, ToolRow } from '../types.js'
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

/** One reason as the row renders it; the hint is the sentence behind the badge. */
interface ReasonText {
  zh: string
  en: string
  hintZh: string
  hintEn: string
}

/**
 * The five reasons in the host's order. Copy is local: the i18n catalogs are shared with every
 * view, and a reason is a host enum the tools page owns. An unknown value (a newer host) still
 * renders, under its raw id, with no tooltip.
 */
const REASON_TEXT: Record<ToolDenyReason, ReasonText> = {
  install: { zh: '安装屏蔽', en: 'install', hintZh: '安装级屏蔽清单里有它；本页开关改的就是这张清单。', hintEn: 'The installation deny list names it; the switches here edit that list.' },
  scope: { zh: '范围', en: 'scope', hintZh: '某个会话、工作区或子代理的范围规则点名了它。', hintEn: 'A session, workspace or subagent scope rule names it.' },
  preset: { zh: '预设', en: 'preset', hintZh: '某个预设的工具策略也禁用它（应用时写进安装级屏蔽）。', hintEn: 'A preset tool policy also disables it (applying that preset writes it into the install mask).' },
  onDemand: { zh: '按需组', en: 'on-demand', hintZh: '属于按需组：组没打开时它不在模型视图里。', hintEn: 'Owned by an on-demand group: it stays out of the model view until the group is opened.' },
  lazy: { zh: '懒加载', en: 'lazy', hintZh: '服务器是懒加载，这个工具还没加载。', hintEn: 'Its server is lazy and this tool is not loaded.' },
}

/** The order this build renders: the host's order, then any value a newer host appended. */
export const REASON_ORDER: readonly ToolDenyReason[] = ['install', 'scope', 'preset', 'onDemand', 'lazy']

/** A row's reasons, deduplicated and in reporting order; unknown values keep their arrival order. */
export function reasonsOf(tool: Pick<ToolRow, 'denyReasons'>): string[] {
  const list = tool.denyReasons ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const reason of REASON_ORDER) {
    if (!list.includes(reason) || seen.has(reason)) continue
    seen.add(reason)
    out.push(reason)
  }
  for (const reason of list) {
    if (seen.has(reason)) continue
    seen.add(reason)
    out.push(reason)
  }
  return out
}

function reasonText(reason: string): ReasonText | undefined {
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, reason) ? REASON_TEXT[reason as ToolDenyReason] : undefined
}

/** The badge text for one reason; an unknown reason from a newer host shows its raw value. */
export function denyReasonLabel(lang: Lang, reason: string): string {
  const text = reasonText(reason)
  if (text === undefined) return reason
  return lang === 'zh' ? text.zh : text.en
}

/** The tooltip behind one reason; '' when this build does not know the value. */
export function denyReasonHint(lang: Lang, reason: string): string {
  const text = reasonText(reason)
  if (text === undefined) return ''
  return lang === 'zh' ? text.hintZh : text.hintEn
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
          {reasonsOf(tool).map(reason => (
            <Badge key={reason} tone={reason === 'onDemand' || reason === 'lazy' ? 'off' : 'warn'} title={denyReasonHint(lang, reason)}>
              {denyReasonLabel(lang, reason)}
            </Badge>
          ))}
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
  /** Current search term; pagination resets when it changes. */
  term: string
  /** 'tool.save:<group key>' in flight, so the shared busy state reaches the parent switch. */
  busyKey: string | null
  onToggle: (name: string, hide: boolean) => void
  onBulk: (group: TreeGroup<ToolRow>, next: boolean) => void
}

/** The tree itself: expansion memory plus the shared GroupTree, one row per tool. */
export function ToolsTree(props: ToolsTreeProps): React.ReactElement {
  const { groups, lang, t, masked, costs, showCosts, forceOpen, term, busyKey, onToggle, onBulk } = props
  const expansion = useTreeExpansion(TREE_STORAGE_KEY)
  return (
    <GroupTree
      groups={groups}
      lang={lang}
      forceOpen={forceOpen}
      resetKey={term}
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
