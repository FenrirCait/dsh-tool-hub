/**
 * Shared package tree: one collapsible parent per bundle/prefix/server.
 *
 * Expansion is remembered per view in localStorage; a non-empty search forces every rendered
 * parent open so matches are never hidden behind a collapsed row. The parent switch is optional:
 * views without a safe bulk operation pass no onBulk and get no switch.
 *
 * An expanded parent paints one page (GROUP_PAGE_SIZE rows) and offers a show-more row for the
 * rest, so a bundle with hundreds of entries costs fifty rows of DOM instead of all of them.
 * Paging is a render rule, not a filter: the group object and its counts, the parent switch and
 * the view's select-all still describe every filtered row that survived the search. A changed
 * resetKey (the search term) folds every parent back to its first page. Group heads pin to the
 * top of the scrolling content; that rule lives with the other classes in theme.ts.
 */
import * as React from 'react'
import { Badge, Switch } from '../components.js'
import type { Lang } from '../i18n.js'
import { createT } from '../i18n.js'

export interface TreeGroup<T> {
  key: string
  label: string
  /** Version or other one-line detail. */
  meta?: string
  rows: T[]
  /** How many of rows are currently enabled. */
  enabled: number
  /** The parent can enable/disable the whole group. */
  switchable?: boolean
  /** True when the parent switch should read as on (usually all rows enabled). */
  allEnabled?: boolean
}

/** Rows one expanded parent paints before its show-more row: the cap that keeps a huge group cheap. */
export const GROUP_PAGE_SIZE = 50

/** What one page of a group holds: the rows to paint and how many still wait behind the button. */
export interface GroupPage<T> {
  rows: T[]
  hidden: number
}

/**
 * One page of a group. `page` counts the pages already revealed (1 = the first page) rather than
 * a row offset, so pressing show-more is always "+1" and the caller remembers no index. A page
 * below one is treated as the first; a size of zero or less disables the cap and keeps every row.
 */
export function groupPage<T>(rows: T[], page: number, size: number = GROUP_PAGE_SIZE): GroupPage<T> {
  const limit = size <= 0 ? rows.length : Math.max(1, Math.trunc(page)) * size
  const shown = Math.min(rows.length, limit)
  return { rows: rows.slice(0, shown), hidden: rows.length - shown }
}

/** The page counts a render may trust: a new reset key (the search term) drops every one of them. */
export function livePages(pages: { reset: string; pages: Record<string, number> }, resetKey: string): Record<string, number> {
  return pages.reset === resetKey ? pages.pages : {}
}

/** The counts after one more press on a group's show-more row: that group moves to its next page. */
export function revealPage(pages: Record<string, number>, key: string): Record<string, number> {
  return { ...pages, [key]: (pages[key] ?? 1) + 1 }
}

/** The show-more row's text. The generated catalogs live elsewhere, so this label stays local. */
export function showMoreLabel(lang: Lang, hidden: number): string {
  return lang === 'zh' ? `显示更多 (${hidden})` : `Show more (${hidden})`
}

export function useTreeExpansion(storageKey: string): {
  isOpen: (key: string) => boolean
  toggle: (key: string) => void
} {
  const [open, setOpen] = React.useState<Set<string>>(() => {
    try {
      const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey)
      const parsed = raw === null ? [] : JSON.parse(raw) as unknown
      return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
    }
    catch {
      return new Set()
    }
  })
  const persist = (next: Set<string>): void => {
    setOpen(next)
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey, JSON.stringify([...next]))
    }
    catch {
      /* a browser without storage still folds for this mount */
    }
  }
  return {
    isOpen: key => open.has(key),
    toggle: key => {
      const next = new Set(open)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      persist(next)
    },
  }
}

export interface GroupTreeProps<T> {
  groups: Array<TreeGroup<T>>
  lang: Lang
  forceOpen: boolean
  expansion: { isOpen: (key: string) => boolean; toggle: (key: string) => void }
  renderRow: (row: T) => React.ReactNode
  onBulk?: (group: TreeGroup<T>, next: boolean) => void
  busyKey?: string | null
  /** Rows one expanded group paints before its show-more row; defaults to GROUP_PAGE_SIZE. */
  pageSize?: number
  /** Changing this value (the search term) folds every group back to its first page. */
  resetKey?: string
}

export function GroupTree<T>(props: GroupTreeProps<T>): React.ReactElement {
  const { groups, lang, forceOpen, expansion, renderRow, onBulk, busyKey, pageSize = GROUP_PAGE_SIZE, resetKey = '' } = props
  const t = createT(lang)
  // Which page each group is on, tagged with the term it was revealed under: a new search starts
  // from the first page in the same render, without an effect that would paint the old one once.
  const [revealed, setRevealed] = React.useState<{ reset: string; pages: Record<string, number> }>({ reset: resetKey, pages: {} })
  const pages = livePages(revealed, resetKey)
  return (
    <div className="th-groups">
      {groups.map(group => {
        const open = forceOpen || expansion.isOpen(group.key)
        const allOn = group.allEnabled ?? group.enabled >= group.rows.length
        const page = groupPage(group.rows, pages[group.key] ?? 1, pageSize)
        return (
          <div className="th-group" key={group.key}>
            <div className="th-group-head">
              <button
                type="button"
                className="th-group-toggle"
                aria-expanded={open}
                aria-label={open ? t('tree.collapse') : t('tree.expand')}
                onClick={() => expansion.toggle(group.key)}
              >
                <span className={open ? 'th-chevron is-open' : 'th-chevron'} aria-hidden="true">›</span>
                <span className="th-group-label" title={group.label}>{group.label}</span>
                {group.meta === undefined ? null : <span className="th-group-meta">{group.meta}</span>}
                <Badge tone="neutral">{group.rows.length}</Badge>
                <span className="th-group-meta">{group.enabled}/{group.rows.length}</span>
              </button>
              {onBulk === undefined || group.switchable !== true ? null : (
                <Switch
                  checked={allOn}
                  busy={busyKey === group.key}
                  label={t('tree.bulk', { name: group.label })}
                  onChange={next => onBulk(group, next)}
                />
              )}
            </div>
            {open ? (
              <div className="th-list th-group-body">
                {page.rows.map(renderRow)}
                {page.hidden === 0 ? null : (
                  <button
                    type="button"
                    className="th-more"
                    onClick={() => {
                      setRevealed({ reset: resetKey, pages: revealPage(pages, group.key) })
                    }}
                  >
                    {showMoreLabel(lang, page.hidden)}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** First token of a name, used as the prefix group; names without a separator go to the fallback. */
export function prefixOf(name: string, fallback = '~'): string {
  const match = /^([A-Za-z0-9]+)[._-]/.exec(name)
  return match?.[1] === undefined ? fallback : match[1].toLowerCase()
}

export function groupByPrefix<T>(rows: T[], nameOf: (row: T) => string, fallbackLabel: string): Array<{ key: string; label: string; rows: T[] }> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const key = prefixOf(nameOf(row))
    const list = map.get(key) ?? []
    list.push(row)
    map.set(key, list)
  }
  return [...map.entries()]
    .map(([key, list]) => ({ key, label: key === '~' ? fallbackLabel : key, rows: list }))
    .sort((left, right) => (left.key === '~' ? 1 : right.key === '~' ? -1 : left.label.localeCompare(right.label)))
}
