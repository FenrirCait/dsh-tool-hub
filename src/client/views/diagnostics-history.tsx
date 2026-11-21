/**
 * The audit tail: filter, render and clear one profile's operation history.
 *
 * Clearing is a write (history.clear) and cannot be undone, so it goes through a dialog. The
 * filter is local: the snapshot already carries the newest entries, and typing must not refetch.
 */
import * as React from 'react'
import { Badge, Button, Card, Dialog, Empty } from '../components.js'
import type { HistoryEntry, ViewProps } from '../types.js'

function label(lang: ViewProps['lang'], zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

function stamp(iso: string, lang: ViewProps['lang']): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
}

export interface DiagnosticsHistoryProps {
  history: HistoryEntry[]
  t: ViewProps['t']
  lang: ViewProps['lang']
  busy: string | null
  run: ViewProps['run']
  reload: ViewProps['reload']
}

export function DiagnosticsHistory(props: DiagnosticsHistoryProps): React.ReactElement {
  const { history, t, lang, busy, run, reload } = props
  const [query, setQuery] = React.useState('')
  const [clearOpen, setClearOpen] = React.useState(false)
  const term = query.trim().toLowerCase()
  const shown = term === '' ? history : history.filter(entry => entry.op.toLowerCase().includes(term) || entry.detail.toLowerCase().includes(term))

  return (
    <div className="th-section" role="region" aria-label={t('diagnostics.history')}>
      <div className="th-section-title">{t('diagnostics.history')}</div>
      <div className="th-toolbar">
        <input
          className="th-input"
          type="text"
          value={query}
          placeholder={t('diagnostics.historyFilter')}
          aria-label={t('diagnostics.historyFilter')}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value) }}
        />
        <Button variant="ghost" disabled={history.length === 0} onClick={() => { setClearOpen(true) }}>{t('diagnostics.historyClear')}</Button>
      </div>
      {shown.length === 0 ? (
        <Empty
          title={history.length > 0 ? t('diagnostics.historyNoMatch') : t('diagnostics.empty')}
          hint={label(
            lang,
            '开关与写入会在这里留一行；诊断本身只读，不会记录。',
            'Toggles and writes leave a line here; diagnostics itself is read-only and is not recorded.',
          )}
        />
      ) : (
        <Card label={t('diagnostics.history')}>
          <div className="th-list">
            {shown.map((entry: HistoryEntry, index: number) => (
              <div className="th-row" key={entry.op + '-' + entry.at + '-' + String(index)}>
                <div className="th-row-body">
                  <span className="th-row-name th-mono" title={t('diagnostics.op')}>{entry.op}</span>
                  <span className="th-row-meta">
                    <span className="th-mono" title={t('diagnostics.at')}>{stamp(entry.at, lang)}</span>
                    {entry.detail === '' ? null : <span>{entry.detail}</span>}
                  </span>
                </div>
                <Badge tone={entry.ok ? 'on' : 'danger'}>
                  {entry.ok ? t('diagnostics.ok') : t('diagnostics.fail')}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Dialog
        open={clearOpen}
        title={t('diagnostics.historyClear')}
        onClose={() => { setClearOpen(false) }}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setClearOpen(false) }}>{t('action.cancel')}</Button>
            <Button
              variant="danger"
              busy={busy === 'history.clear'}
              onClick={() => {
                setClearOpen(false)
                void run('history.clear', {}).then(ok => { if (ok) reload() })
              }}
            >
              {t('action.confirm')}
            </Button>
          </>
        }
      >
        {t('diagnostics.historyClearConfirm', { count: String(history.length) })}
      </Dialog>
    </div>
  )
}
