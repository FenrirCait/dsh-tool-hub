/**
 * Shared package tree: one collapsible parent per bundle/prefix/server.
 *
 * Expansion is remembered per view in localStorage; a non-empty search forces every rendered
 * parent open so matches are never hidden behind a collapsed row. The parent switch is optional:
 * views without a safe bulk operation pass no onBulk and get no switch.
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
}

export function GroupTree<T>(props: GroupTreeProps<T>): React.ReactElement {
  const { groups, lang, forceOpen, expansion, renderRow, onBulk, busyKey } = props
  const t = createT(lang)
  return (
    <div className="th-groups">
      {groups.map(group => {
        const open = forceOpen || expansion.isOpen(group.key)
        const allOn = group.allEnabled ?? group.enabled >= group.rows.length
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
            {open ? <div className="th-list th-group-body">{group.rows.map(renderRow)}</div> : null}
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
