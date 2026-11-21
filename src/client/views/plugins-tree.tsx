/**
 * Plugins tree: the same loader rows, folded under the bundle that installed them.
 *
 * The grouping is a pure function so the probe can execute it rather than trust a grep:
 * `groupPlugins` maps bundle membership (a BundleRow's rows are plugin ids) onto TreeGroup values,
 * orders bundles by name, keeps the bundle's own version as the parent's meta line and leaves the
 * plugins no bundle names in one ungrouped group last. `filterPluginGroups` then applies the search
 * term per group: a group whose own label matches keeps every child, everything else keeps only the
 * rows that match, and a group left with no rows disappears together with its switch.
 *
 * Expansion lives in package-tree.tsx and is remembered under PLUGINS_TREE_KEY, so the first visit
 * shows every bundle folded, the next one shows what the user left open, and a non-empty search
 * forces everything open so a match is never hidden behind a collapsed row.
 *
 * The parent switch is handed back to the view: only the view knows the host's bulk cap and its
 * 1.x "confirm past twenty" rule. What this file guarantees is that a group is switchable only when
 * at least one child is manageable, and that its switch reads as on only when every manageable child
 * is on — a read-only or bundled-UI row never makes a group look half-flipped.
 */
import * as React from 'react'
import type { Lang } from '../i18n.js'
import type { BundleRow, PluginRow } from '../types.js'
import { GroupTree, useTreeExpansion } from './package-tree.js'
import type { TreeGroup } from './package-tree.js'

/** localStorage key for this view's folded groups; the tools and skills views keep their own. */
export const PLUGINS_TREE_KEY = 'tool-hub-tree-plugins'

// #region tree-helpers
/** Rows the host lets this panel write; read-only rows never join a parent batch. */
export function manageableRows(rows: PluginRow[]): PluginRow[] {
  return rows.filter(row => row.manageable !== false)
}

/** Plugin id -> index of the first bundle naming it, so a shared id lands in one group only. */
export function bundleMembership(bundles: BundleRow[]): Map<string, number> {
  const owner = new Map<string, number>()
  bundles.forEach((bundle, at) => {
    for (const id of bundle.rows) {
      if (!owner.has(id)) owner.set(id, at)
    }
  })
  return owner
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base
  let suffix = 2
  while (used.has(key)) {
    key = base + '#' + suffix
    suffix += 1
  }
  used.add(key)
  return key
}

/** One parent row: counts, the switch decision, and the meta line (a bundle's version). */
function treeGroup(key: string, label: string, meta: string | undefined, rows: PluginRow[]): TreeGroup<PluginRow> {
  const manageable = manageableRows(rows)
  return {
    key,
    label,
    ...(meta === undefined || meta === '' ? {} : { meta }),
    rows,
    enabled: rows.filter(row => row.enabled).length,
    switchable: manageable.length > 0,
    allEnabled: manageable.length > 0 && manageable.every(row => row.enabled),
  }
}

/**
 * Fold rows into one group per bundle, bundles by name and the ungrouped remainder last.
 * A bundle no row belongs to is not rendered: an empty parent would only carry a dead switch.
 */
export function groupPlugins(rows: PluginRow[], bundles: BundleRow[], ungrouped: string): Array<TreeGroup<PluginRow>> {
  const owner = bundleMembership(bundles)
  const buckets = new Map<number, PluginRow[]>()
  const loose: PluginRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const at = owner.get(row.id)
    if (at === undefined) {
      loose.push(row)
      continue
    }
    const bucket = buckets.get(at)
    if (bucket === undefined) buckets.set(at, [row])
    else bucket.push(row)
  }
  const groups: Array<TreeGroup<PluginRow>> = []
  const used = new Set<string>()
  bundles.forEach((bundle, at) => {
    const members = buckets.get(at)
    if (members === undefined || members.length === 0) return
    groups.push(treeGroup(uniqueKey('bundle:' + bundle.name, used), bundle.name, bundle.version, members))
  })
  groups.sort((left, right) => left.label.localeCompare(right.label))
  if (loose.length > 0) groups.push(treeGroup('ungrouped', ungrouped, undefined, loose))
  return groups
}

/**
 * Narrow every group to the search term. A group whose own label matches keeps all its children
 * (searching "mcp" should not eat the MCP bundle's rows); otherwise only matching rows stay and a
 * group with none is dropped. Counts and switchability are recomputed from what is visible, so the
 * parent switch can only ever write rows the user can see.
 */
export function filterPluginGroups(groups: Array<TreeGroup<PluginRow>>, term: string, matches: (row: PluginRow) => boolean): Array<TreeGroup<PluginRow>> {
  if (term === '') return groups
  const out: Array<TreeGroup<PluginRow>> = []
  for (const group of groups) {
    if (group.label.toLowerCase().includes(term)) {
      out.push(group)
      continue
    }
    const rows = group.rows.filter(matches)
    if (rows.length === 0) continue
    out.push(treeGroup(group.key, group.label, group.meta, rows))
  }
  return out
}

/** What the view hands over: every row, every bundle, the term and the row matcher. */
export interface PluginTreeInput {
  rows: PluginRow[]
  bundles: BundleRow[]
  term: string
  ungrouped: string
  matches: (row: PluginRow) => boolean
}

export function pluginTreeGroups(input: PluginTreeInput): Array<TreeGroup<PluginRow>> {
  return filterPluginGroups(groupPlugins(input.rows, input.bundles, input.ungrouped), input.term, input.matches)
}
// #endregion tree-helpers

export interface PluginsTreeProps {
  /** Groups built by pluginTreeGroups, already filtered by the current term. */
  groups: Array<TreeGroup<PluginRow>>
  lang: Lang
  /** Current term; non-empty forces every group open. */
  term: string
  /** Key of the group whose batch is running, so its own switch reports the busy state. */
  busyKey: string | null
  renderRow: (row: PluginRow) => React.ReactNode
  onBulk: (group: TreeGroup<PluginRow>, next: boolean) => void
}

/** The shared GroupTree with this view's storage key and search rule; no state of its own. */
export function PluginsTree(props: PluginsTreeProps): React.ReactElement {
  const { groups, lang, term, busyKey, renderRow, onBulk } = props
  const expansion = useTreeExpansion(PLUGINS_TREE_KEY)
  return (
    <GroupTree
      groups={groups}
      lang={lang}
      forceOpen={term !== ''}
      expansion={expansion}
      renderRow={renderRow}
      onBulk={onBulk}
      busyKey={busyKey}
    />
  )
}
