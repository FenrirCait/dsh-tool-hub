/**
 * Diagnostics: the doctor's checks, the audit tail, and where this installation lives.
 *
 * Doctor is the one host probe the panel triggers on demand, and it is read-only. That is also
 * why this view calls runOp directly instead of props.run: run() reports success and drops the
 * report the page has to render. History and paths are snapshot data — the host already wrote
 * them, so the page reads them and never asks for them twice.
 *
 * Every parsed row is validated: an older host may return fewer checks, and a row without an id
 * is dropped rather than rendered as a blank badge.
 */
import * as React from 'react'
import { OPS, runOp } from '../api.js'
import { Badge, Button, Callout, Card, Empty } from '../components.js'
import type { HistoryEntry, SnapshotPaths, ViewProps } from '../types.js'

/** One doctor row as the page renders it; the host contract lives in src/host/diagnostics.ts. */
interface CheckRow {
  id: string
  ok: boolean
  detail: string
}

/** One host member the capability report says is missing, with its table fallback. */
interface CapabilityRow {
  id: string
  service: string
  member: string
  required: boolean
  fallback: string
}

/** The capability half of the doctor report: counts plus the rows worth naming. */
interface CapabilitySummary {
  present: number
  total: number
  ok: boolean
  degraded: boolean
  missing: CapabilityRow[]
}

/** What the page keeps from one doctor call; never assumed complete. */
interface DoctorReport {
  ok: boolean
  checks: CheckRow[]
  capabilities: CapabilitySummary | null
}

/** One label/value pair in the paths card; a root set may carry several values. */
interface PathRow {
  label: string
  values: string[]
}

/** One-off labels the catalogs do not carry; everything else comes from t(). */
function label(lang: ViewProps['lang'], zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A check row is usable only with an id; everything else falls back to a failed-looking row. */
function checksOf(value: unknown): CheckRow[] {
  if (!Array.isArray(value)) return []
  const rows: CheckRow[] = []
  for (const item of value) {
    const row = recordOf(item)
    if (row === null) continue
    const id = textOf(row.id)
    if (id === '') continue
    rows.push({ id, ok: row.ok === true, detail: textOf(row.detail) })
  }
  return rows
}

/** The capability summary is optional: a host that predates it still yields usable checks. */
function capabilityOf(value: unknown): CapabilitySummary | null {
  const row = recordOf(value)
  if (row === null) return null
  const present = countOf(row.present)
  const total = countOf(row.total)
  if (present === null || total === null) return null
  const missing: CapabilityRow[] = []
  if (Array.isArray(row.missing)) {
    for (const item of row.missing) {
      const spec = recordOf(item)
      if (spec === null) continue
      const service = textOf(spec.service)
      if (service === '') continue
      const member = textOf(spec.member)
      missing.push({
        id: textOf(spec.id) === '' ? service + '.' + member : textOf(spec.id),
        service,
        member,
        required: spec.required === true,
        fallback: textOf(spec.fallback),
      })
    }
  }
  return { present, total, ok: row.ok === true, degraded: row.degraded === true, missing }
}

/** Normalise an op answer; a partial or unexpected payload becomes an empty report, not a crash. */
function readReport(value: unknown): DoctorReport {
  const row = recordOf(value)
  if (row === null) return { ok: false, checks: [], capabilities: null }
  return { ok: row.ok === true, checks: checksOf(row.checks), capabilities: capabilityOf(row.capabilities) }
}

/** ISO text to a readable stamp; an unparseable value is shown as the host wrote it. */
function stamp(at: string, lang: ViewProps['lang']): string {
  if (at === '') return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  try {
    return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }
  catch {
    return at
  }
}

/** Four rows: where the plugin lives, its state, its patch, and every skill root it scans. */
function pathRowsOf(paths: SnapshotPaths, t: ViewProps['t'], lang: ViewProps['lang']): PathRow[] {
  const skills = paths.skillRoots.length > 0
    ? paths.skillRoots
    : (paths.skills ?? []).map(root => (typeof root.dir === 'string' ? root.dir : '')).filter(dir => dir !== '')
  return [
    { label: label(lang, '宿主目录', 'Home'), values: [paths.home ?? ''] },
    { label: t('diagnostics.state'), values: [paths.state ?? ''] },
    { label: t('diagnostics.patch'), values: [paths.patch ?? ''] },
    { label: t('diagnostics.skills'), values: skills },
  ]
}

export function DiagnosticsView(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang } = props
  const [report, setReport] = React.useState<DoctorReport | null>(null)
  const [failure, setFailure] = React.useState<string | null>(null)
  const [running, setRunning] = React.useState(false)
  const [lastRun, setLastRun] = React.useState<string | null>(null)
  // A ref, not the state flag: two clicks in one tick both see the old render's state.
  const inFlight = React.useRef(false)

  /** The only host call this view makes, and it is read-only by contract. */
  const runDoctor = React.useCallback(async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setRunning(true)
    setFailure(null)
    const result = await runOp(OPS.doctor, {})
    inFlight.current = false
    setRunning(false)
    if (!result.ok) {
      setReport(null)
      setFailure(result.message)
      return
    }
    setReport(readReport(result.data))
    setLastRun(new Date().toISOString())
  }, [])

  const checks = report === null ? [] : report.checks
  const failing = checks.filter(row => !row.ok)
  const capabilities = report === null ? null : report.capabilities
  const history = snapshot.history
  const pathRows = pathRowsOf(snapshot.paths, t, lang)
  const capabilityLabel = label(lang, '宿主能力', 'Host capabilities')
  const runLabel = running ? t('diagnostics.running') : t('diagnostics.run')

  return (
    <div>
      <div className="th-toolbar">
        <Button
          variant="primary"
          busy={running}
          onClick={() => {
            void runDoctor()
          }}
          label={runLabel}
        >
          {runLabel}
        </Button>
        <span className="th-row-meta" role="status" aria-label={t('a11y.status')}>
          {report === null ? null : (
            <>
              <Badge tone={failing.length === 0 ? 'on' : 'danger'}>
                {failing.length === 0 ? t('diagnostics.ok') : `${t('diagnostics.issue')} ${failing.length}`}
              </Badge>
              <Badge>{`${t('diagnostics.checks')} ${checks.length}`}</Badge>
            </>
          )}
          {lastRun === null ? null : (
            <span className="th-mono">
              {label(lang, `运行于 ${stamp(lastRun, lang)}`, `Ran at ${stamp(lastRun, lang)}`)}
            </span>
          )}
        </span>
      </div>

      {failure === null ? null : (
        <Callout
          action={
            <Button variant="ghost" onClick={() => { void runDoctor() }}>
              {t('action.retry')}
            </Button>
          }
        >
          {label(lang, `诊断请求失败：${failure}`, `The diagnostics request failed: ${failure}`)}
        </Callout>
      )}

      {snapshot.patchInfo.path === null ? null : (
        <div className="th-section" role="region" aria-label={t('diagnostics.patchBlocks')}>
          <div className="th-section-title">{t('diagnostics.patchBlocks')}</div>
          <Card>
          {snapshot.patchInfo.blocks.length === 0 ? (
            <Empty title={t('diagnostics.patchNone')} hint={t('diagnostics.patchSafe')} />
          ) : (
            <div className="th-list">
              {snapshot.patchInfo.blocks.map(block => (
                <div className="th-row" key={block.name}>
                  <div className="th-row-body">
                    <span className="th-row-name th-mono">{block.name}</span>
                    {block.foreign.length === 0 ? (
                      <span className="th-row-meta">{label(lang, `${block.rows.length} 行`, `${block.rows.length} row(s)`)}</span>
                    ) : (
                      <span className="th-row-meta">
                        {t('diagnostics.patchForeign', { block: block.name, count: String(block.foreign.length), list: block.foreign.join(', ') })}
                      </span>
                    )}
                  </div>
                  <Badge tone={block.foreign.length === 0 ? 'on' : 'off'}>{label(lang, `${block.rows.length} 行`, `${block.rows.length} rows`)}</Badge>
                </div>
              ))}
            </div>
          )}
          {snapshot.patchInfo.unclosed.map(name => (
            <Callout key={name} tone="error">{t('diagnostics.patchUnclosed', { block: name })}</Callout>
          ))}
          {snapshot.patchInfo.blocks.length === 0 ? null : (
            <div className="th-row-meta">{t('diagnostics.patchSafe')}</div>
          )}
          </Card>
        </div>
      )}

      <div className="th-section" role="region" aria-label={t('diagnostics.checks')}>
        <div className="th-section-title">{t('diagnostics.checks')}</div>
        {report === null ? (
          <Empty
            title={t('diagnostics.checks')}
            hint={label(
              lang,
              '运行诊断读取宿主的检查项；只读，不会改动任何状态。',
              'Run diagnostics to read the host checks; it is read-only and changes nothing.',
            )}
            action={
              <Button onClick={() => { void runDoctor() }}>
                {t('diagnostics.run')}
              </Button>
            }
          />
        ) : checks.length === 0 ? (
          <Empty title={label(lang, '宿主没有返回诊断项', 'The host returned no check')} />
        ) : (
          <Card label={t('diagnostics.checks')}>
            <div className="th-list">
              {checks.map(row => (
                <div className="th-row" key={row.id}>
                  <div className="th-row-body">
                    <span className="th-row-name th-mono">{row.id}</span>
                    <span className="th-row-meta">
                      {row.detail === '' ? label(lang, '没有详情', 'No detail') : row.detail}
                    </span>
                  </div>
                  <Badge tone={row.ok ? 'on' : 'danger'}>
                    {row.ok ? t('diagnostics.ok') : t('diagnostics.fail')}
                  </Badge>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {capabilities === null ? null : (
        <div className="th-section" role="region" aria-label={capabilityLabel}>
          <div className="th-section-title">{capabilityLabel}</div>
          <Card label={capabilityLabel}>
            <div className="th-row">
              <div className="th-row-body">
                <span className="th-row-name th-mono">{capabilities.present + '/' + capabilities.total}</span>
                <span className="th-row-meta">
                  {capabilities.missing.length === 0
                    ? label(lang, '宿主成员齐全', 'Every host member is present')
                    : label(
                        lang,
                        `${capabilities.missing.length} 个成员缺失，按回退路径运行`,
                        `${capabilities.missing.length} member(s) missing; their fallback applies`,
                      )}
                </span>
              </div>
              <Badge tone={capabilities.ok ? (capabilities.degraded ? 'warn' : 'on') : 'danger'}>
                {capabilities.ok ? t('state.ready') : t('diagnostics.fail')}
              </Badge>
            </div>
            {capabilities.missing.map(row => (
              <div className="th-row" key={row.id}>
                <div className="th-row-body">
                  <span className="th-row-name th-mono">{row.id}</span>
                  <span className="th-row-meta">
                    <span className="th-mono">{row.service + '.' + (row.member === '' ? '—' : row.member)}</span>
                    {row.fallback === '' ? null : <span>{row.fallback}</span>}
                  </span>
                </div>
                <Badge tone={row.required ? 'danger' : 'warn'}>
                  {row.required ? label(lang, '必需', 'required') : label(lang, '可选', 'optional')}
                </Badge>
              </div>
            ))}
          </Card>
        </div>
      )}

      <div className="th-section" role="region" aria-label={t('diagnostics.history')}>
        <div className="th-section-title">{t('diagnostics.history')}</div>
        {history.length === 0 ? (
          <Empty
            title={t('diagnostics.empty')}
            hint={label(
              lang,
              '开关与写入会在这里留一行；诊断本身只读，不会记录。',
              'Toggles and writes leave a line here; diagnostics itself is read-only and is not recorded.',
            )}
          />
        ) : (
          <Card label={t('diagnostics.history')}>
            <div className="th-list">
              {history.map((entry: HistoryEntry, index: number) => (
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
      </div>

      <div className="th-section" role="region" aria-label={t('diagnostics.paths')}>
        <div className="th-section-title">{t('diagnostics.paths')}</div>
        <Card label={t('diagnostics.paths')}>
          <div className="th-list">
            {pathRows.map(row => {
              const values = row.values.filter(value => value !== '')
              return (
                <div className="th-row" key={row.label}>
                  <div className="th-row-body">
                    <span className="th-row-name">{row.label}</span>
                    <span className="th-row-meta">
                      {values.length === 0 ? (
                        <span>{label(lang, '未配置', 'not configured')}</span>
                      ) : (
                        values.map(value => (
                          <span className="th-mono" key={value}>{value}</span>
                        ))
                      )}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      </div>
    </div>
  )
}
