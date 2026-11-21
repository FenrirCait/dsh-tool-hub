/**
 * Skills as a prefix tree: one collapsible parent per name prefix.
 *
 * The grouping and search rules live in the marked region below as plain functions, so
 * probe/next can bundle and execute them instead of grepping for them; the component is only the
 * React shell that hands package-tree's shared GroupTree the rows and the remembered folds.
 */
import * as React from 'react'
import type { Lang } from '../i18n.js'
import { GroupTree, useTreeExpansion } from './package-tree.js'
import type { TreeGroup } from './package-tree.js'

/** One storage key per view, so tools, plugins and skills remember their folds separately. */
export const SKILLS_TREE_STORAGE = 'tool-hub-tree-skills'

// #region tree-helpers

/** The least a row must expose for the grouping rules; the view's SkillRow satisfies it. */
export interface TreeRow {
  name: string
  enabled: boolean
}

/** What groupByPrefix returns, repeated here so the region stays import-free and executable. */
export interface PrefixGroup<T> {
  key: string
  label: string
  rows: T[]
}

/**
 * Prefix groups with the search rules applied, plus the parent-switch facts GroupTree renders.
 *
 * - no term: every group keeps every child, in the order the prefix grouping produced them;
 * - a term that matches the parent label (or its key) keeps every child, because the parent is
 *   what matched — a plain row filter would have hidden the children that do not spell the term;
 * - otherwise only the children whose own text matches survive;
 * - a group left without rows disappears rather than rendering an empty parent;
 * - the switch exists only when the group has rows, and reads on only when all of them are on.
 */
export function skillTree<T extends TreeRow>(
  groups: Array<PrefixGroup<T>>,
  term: string,
  haystack: (row: T) => string,
): Array<TreeGroup<T>> {
  const needle = term.trim().toLowerCase()
  const out: Array<TreeGroup<T>> = []
  for (const group of groups) {
    const labelHit = needle !== '' && (group.label.toLowerCase().includes(needle) || group.key.toLowerCase().includes(needle))
    const rows = needle === '' || labelHit ? group.rows : group.rows.filter(row => haystack(row).toLowerCase().includes(needle))
    if (rows.length === 0) continue
    const enabled = rows.reduce((count, row) => count + (row.enabled ? 1 : 0), 0)
    out.push({
      key: group.key,
      label: group.label,
      rows,
      enabled,
      switchable: rows.length > 0,
      allEnabled: enabled === rows.length,
    })
  }
  return out
}

// #endregion tree-helpers

export interface SkillTreeProps<T> {
  /** Groups already filtered by the search rules; this component only renders them. */
  groups: Array<TreeGroup<T>>
  lang: Lang
  /** A search is running: every parent opens so no match hides behind a fold. */
  forceOpen: boolean
  /** The term behind forceOpen; a changed term folds every parent back to its first page. */
  resetKey?: string
  /** Group key whose bulk write is still running; the parent switch spins while it does. */
  busyKey: string | null
  onBulk: (group: TreeGroup<T>, next: boolean) => void
  renderRow: (row: T) => React.ReactNode
}

export function SkillTree<T>(props: SkillTreeProps<T>): React.ReactElement {
  const { groups, lang, forceOpen, resetKey, busyKey, onBulk, renderRow } = props
  // Nothing is stored on a first visit, so every parent starts folded.
  const expansion = useTreeExpansion(SKILLS_TREE_STORAGE)
  return (
    <GroupTree
      groups={groups}
      lang={lang}
      forceOpen={forceOpen}
      resetKey={resetKey}
      expansion={expansion}
      busyKey={busyKey}
      onBulk={onBulk}
      renderRow={renderRow}
    />
  )
}
