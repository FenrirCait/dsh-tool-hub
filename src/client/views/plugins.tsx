/**
 * Plugins: every loader entry, its state, its switch, and the batch switch.
 *
 * A single row still flips through `toggle`; ticking rows turns the toolbar into a batch that
 * sends `bulk` — the host's payload is { items: [{ kind: 'plugin', id }], enabled }, and this view
 * invents nothing beyond it. The 1.x rule survives: past twenty rows the panel asks first, because
 * one click must not silently flip a whole installation.
 *
 * The batch is capped by the snapshot's `limits.bulk` (the host caps at 400) and a failed batch
 * keeps its selection, since retrying is the only useful next move.
 */
import * as React from 'react'
import { OPS } from '../api.js'
import { Badge, Button, Card, Dialog, Empty, SearchBox, Switch } from '../components.js'
import type { PluginRow, ViewProps } from '../types.js'

// #region bulk-helpers
/** The 1.x confirmation line: a batch larger than this asks before writing. */
export const BULK_CONFIRM_ABOVE = 20
/** src/domains/plugins.ts MAX_BULK: the fallback when a snapshot carries no limit. */
export const BULK_CAP = 400

/** The host's member shape for one plugin id; this view never batches skills. */
export function bulkItems(ids: string[]): { kind: 'plugin'; id: string }[] {
  return ids.map(id => ({ kind: 'plugin', id }))
}

/** Whether a batch needs the dialog. The host documents "confirms past 20", so strictly greater. */
export function needsConfirm(count: number, threshold: number = BULK_CONFIRM_ABOVE): boolean {
  return count > threshold
}

/** Add or remove one id, keeping the order rows were picked in. */
export function toggleSelected(current: string[], id: string, on: boolean): string[] {
  if (!on) return current.filter(item => item !== id)
  return current.includes(id) ? current : [...current, id]
}

/** Tick or untick every visible id; ids already picked keep their place and never repeat. */
export function selectVisible(current: string[], visible: string[], on: boolean): string[] {
  if (!on) {
    const drop = new Set(visible)
    return current.filter(id => !drop.has(id))
  }
  const seen = new Set(current)
  const next = current.slice()
  for (const id of visible) {
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

/** A failed batch keeps its selection: the user needs it to retry. */
export function selectionAfter(ok: boolean, current: string[]): string[] {
  return ok ? [] : current
}

/** Rows the host lets this panel write; a read-only row has no switch, so it has no checkbox. */
export function selectableIds(rows: PluginRow[]): string[] {
  return rows.filter(row => row.manageable !== false).map(row => row.id)
}
// #endregion bulk-helpers

export function PluginsView(props: ViewProps): React.ReactElement {
  const { snapshot, lang, t, busy, run } = props
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState<string[]>([])
  const [confirming, setConfirming] = React.useState<boolean | null>(null)

  const term = query.trim().toLowerCase()
  const rows = snapshot.plugins.filter(row => {
    if (term === '') return true
    return row.name.toLowerCase().includes(term) || row.id.toLowerCase().includes(term)
  })
  const known = new Set(snapshot.plugins.map(row => row.id))
  const picked = selected.filter(id => known.has(id))
  const visibleIds = selectableIds(rows)
  const allVisible = visibleIds.length > 0 && visibleIds.every(id => picked.includes(id))
  const cap = snapshot.limits === null ? BULK_CAP : snapshot.limits.bulk
  const overCap = picked.length > cap
  const bulkBusy = busy === OPS.bulk
  const anyBusy = busy !== null
  const zh = lang === 'zh'

  const commit = React.useCallback(
    (enabled: boolean): void => {
      const ids = picked
      if (ids.length === 0 || ids.length > cap) return
      void run(OPS.bulk, { items: bulkItems(ids), enabled }).then(ok => {
        setSelected(current => selectionAfter(ok, current))
        if (ok) setConfirming(null)
      })
    },
    [picked, cap, run],
  )

  const ask = React.useCallback(
    (enabled: boolean): void => {
      if (picked.length === 0 || picked.length > cap) return
      if (needsConfirm(picked.length)) {
        setConfirming(enabled)
        return
      }
      commit(enabled)
    },
    [picked, cap, commit],
  )

  if (snapshot.plugins.length === 0) {
    return <Empty title={t('plugins.empty')} hint={t('app.subtitle')} />
  }

  const confirmText =
    confirming === null
      ? ''
      : confirming
        ? zh
          ? `将启用已选的 ${picked.length} 个插件。`
          : `Enable the ${picked.length} selected plugins.`
        : zh
          ? `将停用已选的 ${picked.length} 个插件；内建 UI 与只读条目会被跳过。`
          : `Disable the ${picked.length} selected plugins; bundled-UI and read-only entries are skipped.`

  return (
    <div>
      <div className="th-toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('plugins.search')}
          label={t('plugins.search')}
          onClear={() => {
            setQuery('')
          }}
          clearLabel={t('action.clear')}
        />
        <Badge tone="brand">{t('plugins.count', { n: rows.length })}</Badge>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <label className="th-toolbar" style={{ gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            checked={allVisible}
            disabled={visibleIds.length === 0 || bulkBusy}
            aria-label={zh ? '全选当前可见的插件' : 'Select all visible plugins'}
            onChange={event => {
              setSelected(current => selectVisible(current, visibleIds, event.target.checked))
            }}
          />
          <span>{zh ? `全选可见（${visibleIds.length}）` : `Select all visible (${visibleIds.length})`}</span>
        </label>
        {picked.length > 0 ? (
          <Badge tone={overCap ? 'warn' : 'brand'}>
            {zh ? `已选 ${picked.length}` : `${picked.length} selected`}
          </Badge>
        ) : null}
        <Button
          variant="primary"
          busy={bulkBusy}
          disabled={picked.length === 0 || overCap || anyBusy}
          onClick={() => {
            ask(true)
          }}
        >
          {zh ? '批量启用' : 'Enable selected'}
        </Button>
        <Button
          variant="danger"
          busy={bulkBusy}
          disabled={picked.length === 0 || overCap || anyBusy}
          onClick={() => {
            ask(false)
          }}
        >
          {zh ? '批量停用' : 'Disable selected'}
        </Button>
        {picked.length > 0 ? (
          <Button
            variant="ghost"
            disabled={anyBusy}
            onClick={() => {
              setSelected([])
            }}
          >
            {zh ? '清除选择' : 'Clear selection'}
          </Button>
        ) : null}
        </div>
      </div>
      {overCap ? (
        <div style={{ marginBottom: 12 }}>
          <Badge tone="warn">{zh ? `一批最多 ${cap} 个；请减少选择。` : `At most ${cap} per batch; pick fewer rows.`}</Badge>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <Empty title={t('plugins.emptyFiltered', { query })} />
      ) : (
        <Card label={t('plugins.title')}>
          <div className="th-list">
            {rows.map(row => {
              const key = `${OPS.toggle}:${row.id}`
              const rowBusy = busy === key
              const disabled = row.manageable === false
              const checked = picked.includes(row.id)
              return (
                <div className="th-row" key={row.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || bulkBusy}
                    aria-label={zh ? `选择 ${row.name}` : `Select ${row.name}`}
                    title={disabled ? row.readOnlyReason ?? undefined : undefined}
                    onChange={event => {
                      setSelected(current => toggleSelected(current, row.id, event.target.checked))
                    }}
                  />
                  <div className="th-row-body">
                    <span className="th-row-name">{row.name}</span>
                    <span className="th-row-meta">
                      <span className="th-mono">{row.id}</span>
                      <Badge tone={row.enabled ? 'on' : 'off'}>{row.enabled ? t('state.on') : t('state.off')}</Badge>
                      {row.mcp === true ? <Badge>MCP</Badge> : null}
                      {row.self === true ? <Badge>self</Badge> : null}
                      {row.official === true ? <Badge>official</Badge> : null}
                      {row.phase !== null && row.phase !== 'active' ? <Badge tone="warn">{row.phase}</Badge> : null}
                      {disabled ? <Badge tone="warn">{row.readOnlyReason ?? 'read-only'}</Badge> : null}
                    </span>
                  </div>
                  <Switch
                    checked={row.enabled}
                    busy={rowBusy}
                    disabled={disabled || bulkBusy}
                    label={t('a11y.switch', { name: row.name })}
                    onChange={next => {
                      void run(OPS.toggle, { kind: 'plugin', id: row.id, enabled: next })
                    }}
                  />
                </div>
              )
            })}
          </div>
        </Card>
      )}
      <Dialog
        open={confirming !== null}
        title={t('dialog.confirmTitle')}
        onClose={() => {
          if (!bulkBusy) setConfirming(null)
        }}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={bulkBusy}
              onClick={() => {
                setConfirming(null)
              }}
            >
              {t('action.cancel')}
            </Button>
            <Button
              variant={confirming === false ? 'danger' : 'primary'}
              busy={bulkBusy}
              onClick={() => {
                if (confirming !== null) commit(confirming)
              }}
            >
              {t('action.confirm')}
            </Button>
          </>
        }
      >
        <span>{confirmText}</span>
      </Dialog>
      <div style={{ marginTop: 12 }}>
        <Button
          variant="ghost"
          onClick={() => {
            void props.reload()
          }}
        >
          {t('action.retry')}
        </Button>
      </div>
    </div>
  )
}
