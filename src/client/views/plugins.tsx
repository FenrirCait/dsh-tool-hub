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
 *
 * The rows are drawn by plugins-tree.tsx under their loader bundle (snapshot.bundles names the
 * plugin ids each bundle installed); the parents are built here so the toolbar's "select all
 * visible" and the parent switch act on exactly the rows the search left on screen. A parent that
 * needs the dialog stages its ids as the selection, which keeps one confirm path for both.
 *
 * The third-party dialog is the panic switch: `third.status` is a read (runOp), and only that
 * dialog sends `third.off` (after its own confirm) or `third.restore`, both through run().
 */
import * as React from 'react'
import { OPS, runOp } from '../api.js'
import { Badge, Button, Card, Dialog, Empty, RowBoundary, SearchBox, Switch } from '../components.js'
import type { PluginRow, ViewProps } from '../types.js'
import type { TreeGroup } from './package-tree.js'
import { pluginTreeGroups, PluginsTree } from './plugins-tree.js'
import { GroupMembershipDialog, type GroupMemberRef } from './group-membership.js'

// #region bulk-helpers
/** The 1.x confirmation line: a batch larger than this asks before writing. */
export const BULK_CONFIRM_ABOVE = 20
/** src/domains/plugins.ts MAX_BULK: the fallback when a snapshot carries no limit. */
export const BULK_CAP = 400

/** The host's member shape for one plugin id; this view never batches skills. */
export function bulkItems(ids: string[], rows: PluginRow[] = []): { kind: 'plugin'; id: string; bundleName?: string }[] {
  const bundles = new Map(rows.filter(row => row.bundleName !== undefined).map(row => [row.id, row.bundleName as string]))
  return ids.map(id => ({ kind: 'plugin', id, ...(bundles.has(id) ? { bundleName: bundles.get(id) } : {}) }))
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

/** The host's bulk answer: rows changed, bundled-UI entries skipped, and whether the cap cut it. */
export type BulkResult = { changed: number; skipped: number; truncated: boolean }

/** bulk's data made total: a host without counts still renders a report instead of a blank line. */
export function normalizeBulk(raw: unknown): BulkResult | null {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  if (record === null) return null
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return { changed: count(record.changed), skipped: count(record.skippedBuiltin), truncated: record.truncated === true }
}
// #endregion bulk-helpers

// #region third-helpers
export type ThirdTarget = { kind: string; id: string; name: string; mcp: boolean }
export type ThirdSnapshot = { file: string; at: string; plugins: string[]; skills: string[] }
export type ThirdStatus = { targets: ThirdTarget[]; snapshot: ThirdSnapshot | null }

/** Op ids this view adds beyond the shell's shared table: the third-party panic switch. */
export const THIRD = { status: 'third.status', off: 'third.off', restore: 'third.restore' } as const

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** third.status, made total: a host without the op still renders an empty dialog, not a crash. */
export function normalizeThird(raw: unknown): ThirdStatus {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const targets = (Array.isArray(record.targets) ? record.targets : []).flatMap((entry): ThirdTarget[] => {
    const row = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null
    if (row === null || typeof row.id !== 'string' || row.id === '') return []
    return [{ kind: typeof row.kind === 'string' ? row.kind : 'plugin', id: row.id, name: typeof row.name === 'string' ? row.name : row.id, mcp: row.mcp === true }]
  })
  const snapshot = typeof record.snapshot === 'object' && record.snapshot !== null ? (record.snapshot as Record<string, unknown>) : null
  return {
    targets,
    snapshot: snapshot === null ? null : {
      file: typeof snapshot.file === 'string' ? snapshot.file : '',
      at: typeof snapshot.at === 'string' ? snapshot.at : '',
      plugins: stringList(snapshot.plugins),
      skills: stringList(snapshot.skills),
    },
  }
}

/** The summary the dialog prints: enabled targets by kind, and 1 rollback point when one exists. */
export function thirdCounts(status: ThirdStatus): { plugins: number; skills: number; snapshots: number } {
  return {
    plugins: status.targets.filter(target => target.kind === 'plugin').length,
    skills: status.targets.filter(target => target.kind === 'skill').length,
    snapshots: status.snapshot === null ? 0 : 1,
  }
}

export function rollbackCount(snapshot: ThirdSnapshot | null): number {
  return snapshot === null ? 0 : snapshot.plugins.length + snapshot.skills.length
}
// #endregion third-helpers

export function PluginsView(props: ViewProps): React.ReactElement {
  const { snapshot, lang, t, busy, run, runDetailed } = props
  const [query, setQuery] = React.useState('')
  const [assignMember, setAssignMember] = React.useState<GroupMemberRef | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  const [confirming, setConfirming] = React.useState<boolean | null>(null)
  const [third, setThird] = React.useState<ThirdStatus | null>(null)
  const [thirdOpen, setThirdOpen] = React.useState(false)
  const [thirdConfirm, setThirdConfirm] = React.useState(false)
  const [thirdNotice, setThirdNotice] = React.useState('')
  const [thirdReading, setThirdReading] = React.useState(false)
  const [bulkReport, setBulkReport] = React.useState<BulkResult | null>(null)
  const [bulkGroup, setBulkGroup] = React.useState<string | null>(null)

  const term = query.trim().toLowerCase()
  const matches = (row: PluginRow): boolean =>
    term === '' || row.name.toLowerCase().includes(term) || row.id.toLowerCase().includes(term)
  const groups = pluginTreeGroups({
    rows: snapshot.plugins,
    bundles: snapshot.bundles,
    term,
    ungrouped: t('tree.ungrouped'),
    matches,
  })
  const visibleRows = groups.flatMap(group => group.rows)
  const known = new Set(snapshot.plugins.map(row => row.id))
  const picked = selected.filter(id => known.has(id))
  const visibleIds = selectableIds(visibleRows)
  const allVisible = visibleIds.length > 0 && visibleIds.every(id => picked.includes(id))
  const cap = snapshot.limits === null ? BULK_CAP : snapshot.limits.bulk
  const overCap = picked.length > cap
  const bulkBusy = busy === OPS.bulk
  const anyBusy = busy !== null
  const zh = lang === 'zh'
  const thirdTargets = third === null ? 0 : third.targets.length
  const thirdRollback = rollbackCount(third === null ? null : third.snapshot)

  const commit = React.useCallback(
    (enabled: boolean, ids: string[] = picked): void => {
      if (ids.length === 0 || ids.length > cap) return
      setBulkReport(null)
      void runDetailed(OPS.bulk, { items: bulkItems(ids, snapshot.plugins), enabled }).then(outcome => {
        setBulkGroup(null)
        setSelected(current => selectionAfter(outcome.ok, current))
        if (!outcome.ok) return
        setConfirming(null)
        setBulkReport(normalizeBulk(outcome.data))
      })
    },
    [picked, cap, runDetailed],
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

  // A parent switch stages its own ids, so both entry points share the dialog and the cap: over the
  // threshold it opens the same confirm, below it the batch goes straight out. It only ever writes
  // the rows the search left visible — a folded row is still a visible one, a filtered row is not.
  /** Closing the dialog abandons both the staged selection and the parent's busy mark. */
  const cancelConfirm = (): void => {
    if (bulkBusy) return
    setConfirming(null)
    setBulkGroup(null)
  }

  const onGroupBulk = React.useCallback(
    (group: TreeGroup<PluginRow>, next: boolean): void => {
      if (anyBusy) return
      const ids = selectableIds(group.rows)
      if (ids.length === 0) return
      if (ids.length > cap) {
        setSelected(ids)
        return
      }
      setBulkGroup(group.key)
      if (needsConfirm(ids.length)) {
        setSelected(ids)
        setConfirming(next)
        return
      }
      commit(next, ids)
    },
    [anyBusy, cap, commit],
  )

  // The dialog opens on a read: targets and the rollback point are shown before anything is written.
  const readThird = async (): Promise<void> => {
    setThirdReading(true)
    const result = await runOp(THIRD.status, {})
    setThird(result.ok ? normalizeThird(result.data) : null)
    setThirdNotice(result.ok ? '' : result.message)
    setThirdReading(false)
  }

  const openThird = async (): Promise<void> => {
    setThirdConfirm(false)
    setThirdOpen(true)
    await readThird()
  }

  const disableThird = (): void => {
    const count = thirdTargets
    void run(THIRD.off, {}).then(ok => {
      setThirdConfirm(false)
      if (!ok) return
      setThirdNotice(t('third.result', { n: count }))
      void readThird()
    })
  }

  const restoreThird = (): void => {
    const count = thirdRollback
    void run(THIRD.restore, {}).then(ok => {
      if (!ok) return
      setThirdNotice(t('third.restored', { n: count }))
      void readThird()
    })
  }

  if (snapshot.plugins.length === 0) {
    return <Empty title={t('plugins.empty')} hint={t('app.subtitle')} />
  }

  const renderRow = (row: PluginRow): React.ReactNode => {
    const key = `${OPS.toggle}:${row.id}`
    const rowBusy = busy === key
    const disabled = row.manageable === false
    const checked = picked.includes(row.id)
    return (
      <RowBoundary key={row.id} label={zh ? `插件行「${row.name}」渲染失败` : `Plugin row "${row.name}" failed to render`} retry={t('action.retry')}>
      <div className="th-row">
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
        <Button variant="ghost" disabled={row.manageable === false} onClick={() => { setAssignMember({ kind: 'plugin', id: row.id, name: row.name, mcp: row.mcp === true }) }}>{zh ? '分组' : 'Groups'}</Button>
        <Switch
          checked={row.enabled}
          busy={rowBusy}
          disabled={disabled || bulkBusy}
          label={t('a11y.switch', { name: row.name })}
          onChange={next => {
            void run(OPS.toggle, { kind: 'plugin', id: row.id, enabled: next, ...(row.bundleName === undefined ? {} : { bundleName: row.bundleName }) })
          }}
        />
      </div>
      </RowBoundary>
    )
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
        <SearchBox value={query} onChange={setQuery} placeholder={t('plugins.search')} label={t('plugins.search')} onClear={() => { setQuery('') }} clearLabel={t('action.clear')} />
        <Badge tone="brand">{t('plugins.count', { n: visibleRows.length })}</Badge>
        <Button variant="ghost" label={t('third.title')} onClick={() => { void openThird() }}>
          {t('third.title')}
        </Button>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <label className="th-toolbar" style={{ gap: 6, margin: 0 }}>
          <input type="checkbox" checked={allVisible} disabled={visibleIds.length === 0 || bulkBusy} aria-label={zh ? '全选当前可见的插件' : 'Select all visible plugins'} onChange={event => { setSelected(current => selectVisible(current, visibleIds, event.target.checked)) }} />
          <span>{zh ? `全选可见（${visibleIds.length}）` : `Select all visible (${visibleIds.length})`}</span>
        </label>
        {picked.length > 0 ? (
          <Badge tone={overCap ? 'warn' : 'brand'}>
            {zh ? `已选 ${picked.length}` : `${picked.length} selected`}
          </Badge>
        ) : null}
        <Button variant="primary" busy={bulkBusy} disabled={picked.length === 0 || overCap || anyBusy} onClick={() => { ask(true) }}>{zh ? '批量启用' : 'Enable selected'}</Button>
        <Button variant="danger" busy={bulkBusy} disabled={picked.length === 0 || overCap || anyBusy} onClick={() => { ask(false) }}>{zh ? '批量停用' : 'Disable selected'}</Button>
        {picked.length > 0 ? (
          <Button variant="ghost" disabled={anyBusy} onClick={() => { setSelected([]) }}>{zh ? '清除选择' : 'Clear selection'}</Button>
        ) : null}
        </div>
      </div>
      {overCap ? (
        <div style={{ marginBottom: 12 }}>
          <Badge tone="warn">{zh ? `一批最多 ${cap} 个；请减少选择。` : `At most ${cap} per batch; pick fewer rows.`}</Badge>
        </div>
      ) : null}
      {bulkReport === null ? null : (
        <div className="th-field-hint" role="status">
          {t('plugins.bulkDone', { changed: bulkReport.changed, skipped: bulkReport.skipped, truncated: bulkReport.truncated ? (zh ? '是' : 'yes') : (zh ? '否' : 'no') })}
        </div>
      )}
      {visibleRows.length === 0 ? (
        <Empty title={t('plugins.emptyFiltered', { query })} />
      ) : (
        <Card label={t('plugins.title')}>
          <PluginsTree
            groups={groups}
            lang={lang}
            term={term}
            busyKey={bulkGroup}
            renderRow={renderRow}
            onBulk={onGroupBulk}
          />
        </Card>
      )}
      <Dialog
        open={confirming !== null}
        title={t('dialog.confirmTitle')}
        onClose={cancelConfirm}
        footer={
          <>
            <Button variant="ghost" disabled={bulkBusy} onClick={cancelConfirm}>{t('action.cancel')}</Button>
            <Button variant={confirming === false ? 'danger' : 'primary'} busy={bulkBusy} onClick={() => { if (confirming !== null) commit(confirming) }}>{t('action.confirm')}</Button>
          </>
        }
      >
        <span>{confirmText}</span>
      </Dialog>
      <Dialog
        open={thirdOpen}
        title={thirdConfirm ? t('dialog.confirmTitle') : t('third.title')}
        onClose={() => {
          if (busy === null) {
            setThirdOpen(false)
            setThirdConfirm(false)
          }
        }}
        footer={
          thirdConfirm ? (
            <>
              <Button variant="ghost" disabled={busy !== null} onClick={() => { setThirdConfirm(false) }}>{t('action.cancel')}</Button>
              <Button variant="danger" busy={busy === THIRD.off} onClick={disableThird}>{t('action.confirm')}</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => { setThirdOpen(false) }}>{t('action.cancel')}</Button>
              <Button variant="ghost" disabled={thirdRollback === 0 || busy !== null || thirdReading} onClick={restoreThird}>{t('third.restore')}</Button>
              <Button variant="danger" disabled={thirdTargets === 0 || busy !== null || thirdReading} onClick={() => { setThirdConfirm(true) }}>{t('third.off')}</Button>
            </>
          )
        }
      >
        {thirdConfirm ? (
          <span>{t('third.confirmOff', { n: thirdTargets })}</span>
        ) : thirdReading ? (
          <span>{t('state.busy')}</span>
        ) : third === null ? (
          <span>{t('third.none')}</span>
        ) : (
          <div>
            <div>{t('third.status', thirdCounts(third))}</div>
            {third.targets.length === 0 ? <div>{t('third.none')}</div> : (
              <ul className="th-list">{third.targets.map(target => (
                <li className="th-row" key={`${target.kind}:${target.id}`}>
                  <span className="th-row-name">{target.name}</span>
                  <span className="th-mono">{target.id}</span>
                  <Badge>{target.kind}</Badge>
                  {target.mcp ? <Badge>MCP</Badge> : null}
                </li>
              ))}</ul>
            )}
            <div>{third.snapshot === null ? t('third.noSnapshot') : `${third.snapshot.file} · ${rollbackCount(third.snapshot)} ${zh ? '项' : 'items'}`}</div>
          </div>
        )}
        {thirdNotice === '' ? null : <div>{thirdNotice}</div>}
      </Dialog>
      <div style={{ marginTop: 12 }}>
        <Button variant="ghost" onClick={() => { void props.reload() }}>{t('action.retry')}</Button>
      </div>
      <GroupMembershipDialog open={assignMember !== null} mode="member" member={assignMember ?? undefined} groups={snapshot.groups} snapshot={snapshot} lang={lang} t={t} busy={busy} run={run} onClose={() => { setAssignMember(null) }} />
    </div>
  )
}