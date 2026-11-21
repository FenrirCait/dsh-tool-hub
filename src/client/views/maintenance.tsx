/**
 * Maintenance cards: backups on disk and a copyable environment summary.
 *
 * Listing is a read (runOp); cleaning is a write (run) and always keeps the newest N, so a
 * mis-click cannot empty the folder. The summary copies paths and counts only — never a token.
 */
import * as React from 'react'
import { runOp } from '../api.js'
import { Badge, Button, Callout, Card, Dialog, Empty, Field } from '../components.js'
import type { ViewProps } from '../types.js'
import { BackupRestoreDialog } from './backup-restore.js'

interface BackupRow {
  name: string
  dir: string
  kind: 'state' | 'patch'
  bytes: number
  modifiedAt: number
}

interface BackupScan {
  rows: BackupRow[]
  bytes: number
  error: string | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function scanOf(value: unknown): BackupScan {
  const record = asRecord(value)
  const rows = Array.isArray(record.rows) ? record.rows.map(item => asRecord(item)).filter(item => typeof item.name === 'string').map(item => ({
    name: String(item.name),
    dir: typeof item.dir === 'string' ? item.dir : '',
    kind: item.kind === 'patch' ? 'patch' as const : 'state' as const,
    bytes: typeof item.bytes === 'number' ? item.bytes : 0,
    modifiedAt: typeof item.modifiedAt === 'number' ? item.modifiedAt : 0,
  })) : []
  return { rows, bytes: typeof record.bytes === 'number' ? record.bytes : 0, error: typeof record.error === 'string' ? record.error : null }
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

export function MaintenanceCards(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run, reload } = props
  const [scan, setScan] = React.useState<BackupScan | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [cleaning, setCleaning] = React.useState(false)
  const [restoring, setRestoring] = React.useState(false)
  const [keep, setKeep] = React.useState('50')
  const [olderDays, setOlderDays] = React.useState('0')
  const [status, setStatus] = React.useState('')
  const [copied, setCopied] = React.useState(false)

  const load = React.useCallback(() => {
    setLoading(true)
    void runOp('backup.list', {}).then(result => {
      setLoading(false)
      setScan(result.ok ? scanOf(result.data) : { rows: [], bytes: 0, error: result.message })
    })
  }, [])

  React.useEffect(() => { load() }, [load])

  const clean = (): void => {
    const keepValue = Number.parseInt(keep, 10)
    const daysValue = Number.parseInt(olderDays, 10)
    setCleaning(false)
    void run('backup.clean', {
      keep: Number.isFinite(keepValue) ? keepValue : 50,
      olderThanDays: Number.isFinite(daysValue) ? daysValue : 0,
    }).then(ok => {
      if (!ok) return
      setStatus(t('backup.cleanDone'))
      load()
      reload()
    })
  }

  /** The dialog owns the restore; the card only opens it, reports the result and refreshes its list. */
  const closeRestore = React.useCallback(() => { setRestoring(false) }, [])
  const restored = React.useCallback(() => {
    setStatus(t('backup.restoreDone'))
    load()
  }, [t, load])

  const copySummary = (): void => {
    const lines = [
      'dsh-tool-hub',
      'home: ' + snapshot.paths.home,
      'state: ' + snapshot.paths.state,
      'patch: ' + (snapshot.paths.patch ?? '—'),
      'plugins: ' + snapshot.plugins.length + ' / skills: ' + snapshot.skills.length + ' / mcp: ' + snapshot.plugins.filter(row => row.mcp).length,
      'mask: mounted=' + snapshot.mask.mounted + ' deny=' + snapshot.mask.deny.length + ' problems=' + snapshot.mask.problems.length,
      'patch blocks: ' + snapshot.patchInfo.blocks.length + ' / foreign rows: ' + snapshot.patchInfo.foreignTotal,
    ].join('\n')
    const clipboard = navigator.clipboard
    if (clipboard === undefined) {
      setStatus(t('backup.copyFailed'))
      return
    }
    void clipboard.writeText(lines).then(() => {
      setCopied(true)
      setStatus(t('backup.copied'))
      setTimeout(() => { setCopied(false) }, 1500)
    }).catch(() => { setStatus(t('backup.copyFailed')) })
  }

  const rows = scan?.rows ?? []
  const shown = rows.slice(0, 8)

  return (
    <div className="th-section" role="region" aria-label={t('backup.title')}>
      <div className="th-section-title">{t('backup.title')}</div>
      <Card>
        {scan === null ? (
          <Empty title={t('backup.loading')} />
        ) : rows.length === 0 ? (
          <Empty title={t('backup.empty')} hint={t('backup.emptyHint')} />
        ) : (
          <div className="th-list">
            {shown.map(row => (
              <div className="th-row" key={row.dir + '/' + row.name}>
                <div className="th-row-body">
                  <span className="th-row-name th-mono">{row.name}</span>
                  <span className="th-row-meta">{row.kind === 'patch' ? t('backup.patch') : t('backup.state')} · {row.dir}</span>
                </div>
                <Badge>{sizeText(row.bytes)}</Badge>
              </div>
            ))}
          </div>
        )}
        <div className="th-row-meta">
          {t('backup.total', { count: rows.length, size: sizeText(scan?.bytes ?? 0) })}
          {scan?.error == null ? '' : ' · ' + scan.error}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <Button variant="ghost" busy={loading} onClick={load}>{t('backup.refresh')}</Button>
          <Button variant="ghost" disabled={rows.length === 0} onClick={() => { setCleaning(true) }}>{t('backup.clean')}</Button>
          <Button variant="ghost" disabled={rows.length === 0} onClick={() => { setRestoring(true) }}>{t('backup.restore')}</Button>
          <Button variant="ghost" busy={copied} onClick={copySummary}>{t('backup.copy')}</Button>
        </div>
        {status === '' ? null : <Callout>{status}</Callout>}
      </Card>

      <Dialog
        open={cleaning}
        title={t('backup.clean')}
        onClose={() => { setCleaning(false) }}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCleaning(false) }}>{t('action.cancel')}</Button>
            <Button variant="danger" busy={busy === 'backup.clean'} onClick={clean}>{t('action.confirm')}</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field id="th-backup-keep" label={t('backup.keep')} hint={t('backup.keepHint')}>
            <input id="th-backup-keep" className="th-input" type="number" min={0} max={2000} value={keep} aria-label={t('backup.keep')} onChange={event => { setKeep(event.target.value) }} />
          </Field>
          <Field id="th-backup-days" label={t('backup.older')} hint={t('backup.olderHint')}>
            <input id="th-backup-days" className="th-input" type="number" min={0} max={3650} value={olderDays} aria-label={t('backup.older')} onChange={event => { setOlderDays(event.target.value) }} />
          </Field>
        </div>
      </Dialog>

      <BackupRestoreDialog
        open={restoring}
        lang={lang}
        t={t}
        busy={busy}
        run={run}
        reload={reload}
        onClose={closeRestore}
        onRestored={restored}
      />
    </div>
  )
}
