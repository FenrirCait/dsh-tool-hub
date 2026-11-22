/**
 * Diagnostics: the doctor's checks, the audit tail, and where this installation lives.
 *
 * Doctor is the one host probe the panel triggers on demand, and it is read-only. That is also
 * why this view calls runOp directly instead of props.run: run() reports success and drops the
 * report the page has to render. History, paths and extension failures are snapshot data — the
 * host already wrote them, so the page reads them and never asks for them twice.
 *
 * Two operational actions live here, both explicit and both reporting their own result:
 *   - copy the current report (doctor + snapshot essentials) to the clipboard;
 *   - reload a failed extension through the host's existing extension.reload op, one row at a
 *     time or once for every failed row. Nothing is repaired automatically.
 *
 * Extension failures need no extra host field: buildSnapshot already ships
 * `extensions[].error/loaded/styles` (src/host/index.ts:272), and a bad CSS style file surfaces
 * as an error on the extension row because the loader reads the declared styles while mounting.
 *
 * Every parsed row is validated: an older host may return fewer checks, and a row without an id
 * is dropped rather than rendered as a blank badge.
 */
import * as React from 'react'
import { OPS, runOp } from '../api.js'
import { Badge, Button, Callout, Card, Dialog, Empty } from '../components.js'
import { MaintenanceCards } from './maintenance.js'
import { DiagnosticsHistory } from './diagnostics-history.js'
import type { ExtensionStatus, SnapshotPaths, ViewProps } from '../types.js'

/** The host op the extensions view also sends; named once here so a rename is one line. */
const RELOAD_OP = 'extension.reload'

/** The host's one repair write: back the stale panel lock up, then remove it. */
const CLEAR_LOCK_OP = 'doctor.clearLock'

/** Checks whose failure points at the patch file itself, which this page locates but never rewrites (C7). */
const PATCH_CHECK_IDS: readonly string[] = ['patch-parse', 'patch-managed']

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

/** What the last reload/copy action said; `ok` picks the tone, `text` is already translated. */
interface ActionNote {
  ok: boolean
  text: string
}

/** One-off labels the catalogs do not carry; everything else comes from t(). */
function label(lang: ViewProps['lang'], zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

/**
 * An extension row is failed when its load reported an error, or when it is enabled but never
 * loaded. A broken declared style file lands in the first case: the loader reads the CSS while
 * mounting, so the extension itself carries the error.
 */
function failedExtension(entry: ExtensionStatus): boolean {
  if (entry.error !== null && entry.error !== '') return true
  return entry.enabled && !entry.loaded
}

/** The name in the panel's current language, or the id when the manifest has no usable name. */
function extensionName(entry: ExtensionStatus, lang: ViewProps['lang']): string {
  const name = lang === 'zh' ? entry.name.zh : entry.name.en
  return name === '' ? entry.id : name
}

/**
 * The text the copy button puts on the clipboard: the doctor report plus the snapshot facts the
 * page renders. Field labels stay English so a report pasted into an issue reads the same for
 * every operator; values are copied as the host wrote them.
 */
export function buildDiagnosticsReport(
  snapshot: ViewProps['snapshot'],
  report: DoctorReport | null,
  at: string,
  lang: ViewProps['lang'],
): string {
  const lines: string[] = []
  lines.push('dsh-tool-hub diagnostics')
  lines.push('generated: ' + at)
  lines.push('host: plugin ' + snapshot.meta.pluginVersion + ' · node ' + snapshot.meta.node + ' · ' + snapshot.meta.platform + ' · pid ' + snapshot.meta.pid)
  if (report === null) {
    lines.push('doctor: not run')
  } else {
    const failing = report.checks.filter(row => !row.ok)
    lines.push('doctor: ' + (report.ok ? 'ok' : failing.length + ' issue(s)'))
    for (const row of report.checks) {
      lines.push('  [' + (row.ok ? 'ok' : 'fail') + '] ' + row.id + ': ' + (row.detail === '' ? 'no detail' : row.detail))
    }
    const capabilities = report.capabilities
    if (capabilities !== null) {
      lines.push('capabilities: ' + capabilities.present + '/' + capabilities.total + ' present' + (capabilities.degraded ? ', degraded' : ''))
      for (const row of capabilities.missing) {
        lines.push('  missing ' + row.service + '.' + row.member + ' (' + (row.required ? 'required' : 'optional') + '): ' + row.fallback)
      }
    }
  }
  const failed = snapshot.extensions.filter(failedExtension)
  lines.push('extensions: ' + snapshot.extensions.length + ' installed, ' + failed.length + ' failed')
  for (const entry of snapshot.extensions) {
    const state = entry.enabled ? (entry.loaded ? 'loaded' : 'not loaded') : 'disabled'
    const styles = entry.styles === undefined || entry.styles.length === 0 ? '' : '; styles: ' + entry.styles.join(', ')
    const error = entry.error === null || entry.error === '' ? '' : '; error: ' + entry.error
    lines.push('  [' + (failedExtension(entry) ? 'fail' : 'ok') + '] ' + entry.id + ' "' + extensionName(entry, lang) + '" ' + (entry.version === '' ? '?' : entry.version) + ' ' + state + styles + error)
  }
  lines.push('patch: ' + (snapshot.paths.patch === null || snapshot.paths.patch === undefined ? 'none' : snapshot.paths.patch))
  lines.push('patch blocks: ' + snapshot.patchInfo.blocks.length + ' block(s), ' + snapshot.patchInfo.foreignTotal + ' foreign row(s) left untouched')
  lines.push('mask: mounted=' + snapshot.mask.mounted + ' deny=' + snapshot.mask.deny.length + ' sessions=' + snapshot.mask.sessions.length + ' problems=' + snapshot.mask.problems.length)
  const skills = snapshot.paths.skillRoots.length > 0
    ? snapshot.paths.skillRoots
    : (snapshot.paths.skills ?? []).map(root => (typeof root.dir === 'string' ? root.dir : '')).filter(dir => dir !== '')
  lines.push('paths: home=' + (snapshot.paths.home ?? '') + '; state=' + (snapshot.paths.state ?? '') + '; skills=' + (skills.length === 0 ? 'none' : skills.join(', ')))
  if (snapshot.history.length > 0) {
    lines.push('history: ' + snapshot.history.length + ' op(s), newest first')
    for (const entry of snapshot.history.slice(0, 10)) {
      lines.push('  ' + entry.at + ' ' + (entry.ok ? 'ok' : 'fail') + ' ' + entry.op + (entry.detail === '' ? '' : ': ' + entry.detail))
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * Clipboard write with a selection fallback: an Electron window on a non-secure origin can expose
 * `navigator.clipboard` and still reject the write, so a failure there is not the end.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard: Clipboard | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return true
    }
    catch {
      // Fall through to the selection copy below.
    }
  }
  if (typeof document === 'undefined') return false
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'readonly')
    area.setAttribute('aria-hidden', 'true')
    area.className = 'th-visually-hidden'
    document.body.appendChild(area)
    area.select()
    const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    document.body.removeChild(area)
    return copied === true
  }
  catch {
    return false
  }
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
  const { snapshot, t, lang, busy, run, reload, runDetailed } = props
  const [report, setReport] = React.useState<DoctorReport | null>(null)
  const [failure, setFailure] = React.useState<string | null>(null)
  const [running, setRunning] = React.useState(false)
  const [lastRun, setLastRun] = React.useState<string | null>(null)
  const [copyState, setCopyState] = React.useState<'idle' | 'copying' | 'ok' | 'fail'>('idle')
  const [actionNote, setActionNote] = React.useState<ActionNote | null>(null)
  const [confirmClear, setConfirmClear] = React.useState(false)
  const [clearing, setClearing] = React.useState(false)
  /** The failing patch check whose path and rows the page is showing, or null. */
  const [locateId, setLocateId] = React.useState<string | null>(null)
  // A ref, not the state flag: two clicks in one tick both see the old render's state.
  const inFlight = React.useRef(false)
  const copyInFlight = React.useRef(false)

  /** The only read-only host call this view makes; reloads below are explicit writes. */
  const runDoctor = React.useCallback(async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setRunning(true)
    setFailure(null)
    setCopyState('idle')
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

  /** Copy the report the page currently shows: the doctor answer plus the snapshot facts. */
  const copyReport = React.useCallback(async (): Promise<void> => {
    if (copyInFlight.current) return
    copyInFlight.current = true
    setCopyState('copying')
    const text = buildDiagnosticsReport(snapshot, report, new Date().toISOString(), lang)
    const copied = await copyToClipboard(text)
    copyInFlight.current = false
    setCopyState(copied ? 'ok' : 'fail')
  }, [snapshot, report, lang])

  /** Reload one extension by id; the shell's write path refreshes the snapshot on success. */
  const reloadOne = React.useCallback(async (id: string): Promise<boolean> => {
    const outcome = await runDetailed(RELOAD_OP, { id })
    setActionNote(outcome.ok
      ? { ok: true, text: label(lang, '已重新加载 ' + id, 'Reloaded ' + id) }
      : { ok: false, text: label(lang, '重载失败：' + id + ' — ' + (outcome.error ?? 'unknown error'), 'Reload failed: ' + id + ' — ' + (outcome.error ?? 'unknown error')) })
    return outcome.ok
  }, [lang, runDetailed])

  /**
   * Reload every failed row through the same op, one id at a time. The list is captured before
   * the first write: each success refreshes the snapshot, and re-deriving would move the target.
   */
  const reloadFailed = React.useCallback(async (): Promise<void> => {
    const failedIds = snapshot.extensions.filter(failedExtension).map(entry => entry.id)
    if (failedIds.length === 0) return
    let done = 0
    const errors: string[] = []
    for (const id of failedIds) {
      const outcome = await runDetailed(RELOAD_OP, { id })
      if (outcome.ok) done += 1
      else errors.push(id + ': ' + (outcome.error ?? 'unknown error'))
    }
    setActionNote(errors.length === 0
      ? { ok: true, text: label(lang, '已重新加载 ' + done + ' 个失败的扩展', 'Reloaded ' + done + ' failed extension(s)') }
      : { ok: false, text: label(lang, '已重新加载 ' + done + '/' + failedIds.length + ' 个；失败：' + errors.join('; '), 'Reloaded ' + done + '/' + failedIds.length + '; failed: ' + errors.join('; ')) })
  }, [snapshot.extensions, lang, runDetailed])

  /**
   * Clear the stale panel lock through the host's repair op. The host backs the lock up before
   * deleting it and refuses a lock its holder may still own; this page only asks and reports.
   */
  const clearLock = React.useCallback(async (): Promise<void> => {
    if (clearing) return
    setClearing(true)
    const outcome = await runDetailed(CLEAR_LOCK_OP, { confirm: true })
    setClearing(false)
    setConfirmClear(false)
    if (!outcome.ok) {
      setActionNote({
        ok: false,
        text: label(lang, '清理锁失败：' + (outcome.error ?? 'unknown error'), 'Clearing the lock failed: ' + (outcome.error ?? 'unknown error')),
      })
      return
    }
    const data = recordOf(outcome.data)
    const backup = textOf(data?.backup)
    setActionNote(backup === ''
      ? { ok: true, text: label(lang, '锁文件已清理（没有需要备份的锁）', 'The lock file was cleared (none needed a backup)') }
      : { ok: true, text: label(lang, '已备份锁文件到 ' + backup + ' 并删除', 'Backed the lock file up to ' + backup + ' and removed it') })
    // The point of the repair is the next verdict, so re-run the checks instead of only refreshing.
    await runDoctor()
  }, [clearing, lang, runDetailed, runDoctor])

  /** Copy one failing check as an issue-ready block: id, path and verbatim detail. */
  const copyCheckDetail = React.useCallback(async (row: CheckRow): Promise<void> => {
    const patch = snapshot.paths.patch ?? ''
    const text = [
      'dsh-tool-hub check: ' + row.id,
      'path: ' + (patch === '' ? 'none' : patch),
      'detail: ' + (row.detail === '' ? 'no detail' : row.detail),
    ].join('\n') + '\n'
    const copied = await copyToClipboard(text)
    setActionNote(copied
      ? { ok: true, text: label(lang, '已复制 ' + row.id + ' 的详情', 'Copied the detail of ' + row.id) }
      : { ok: false, text: label(lang, '复制详情失败：浏览器不允许访问剪贴板', 'Copy failed: the browser denied clipboard access') })
  }, [snapshot.paths.patch, lang])

  const checks = report === null ? [] : report.checks
  const failing = checks.filter(row => !row.ok)
  const locateRow = locateId === null ? null : checks.find(row => row.id === locateId) ?? null
  const patchPath = snapshot.paths.patch ?? ''
  const unclosedBlocks = snapshot.patchInfo.unclosed
  const foreignBlocks = snapshot.patchInfo.blocks.filter(block => block.foreign.length > 0)
  const capabilities = report === null ? null : report.capabilities
  const pathRows = pathRowsOf(snapshot.paths, t, lang)
  // What the host is, straight off the snapshot: its build version and the runtime under it.
  const hostRows = [
    { label: t('diagnostics.hostPlugin'), value: snapshot.meta.pluginVersion },
    { label: t('diagnostics.hostNode'), value: snapshot.meta.node },
    { label: t('diagnostics.hostPlatform'), value: snapshot.meta.platform },
    { label: label(lang, '进程 ID', 'PID'), value: String(snapshot.meta.pid) },
  ]
  const capabilityLabel = label(lang, '宿主能力', 'Host capabilities')
  const runLabel = running ? t('diagnostics.running') : t('diagnostics.run')
  const extensionsLabel = label(lang, '扩展', 'Extensions')
  const extensions = snapshot.extensions
  const failedExtensions = extensions.filter(failedExtension)
  const bulkBusy = busy !== null && busy.startsWith(RELOAD_OP)
  const bulkLabel = bulkBusy
    ? label(lang, '重新加载中…', 'Reloading…')
    : label(lang, '重新加载失败扩展', 'Reload failed extensions')
  const copyButtonLabel = copyState === 'copying'
    ? label(lang, '复制中…', 'Copying…')
    : copyState === 'ok'
      ? label(lang, '已复制', 'Copied')
      : copyState === 'fail'
        ? label(lang, '复制失败', 'Copy failed')
        : label(lang, '复制报告', 'Copy report')
  const copyNote = copyState === 'ok'
    ? label(lang, '已复制当前报告到剪贴板', 'Copied the current report to the clipboard')
    : copyState === 'fail'
      ? label(lang, '复制失败：浏览器不允许访问剪贴板', 'Copy failed: the browser denied clipboard access')
      : ''
  const liveText = copyNote !== '' ? copyNote : (actionNote === null ? '' : actionNote.text)

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
        <Button
          variant="ghost"
          busy={copyState === 'copying'}
          disabled={running}
          onClick={() => {
            void copyReport()
          }}
          label={copyButtonLabel}
        >
          {copyButtonLabel}
        </Button>
        {copyNote === '' ? null : <span className="th-row-meta">{copyNote}</span>}
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
        <span className="th-visually-hidden" aria-live="polite">{liveText}</span>
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

      {actionNote === null ? null : (actionNote.ok
        ? <div className="th-row-meta">{actionNote.text}</div>
        : <Callout tone="error">{actionNote.text}</Callout>)}

      {extensions.length === 0 ? null : (
        <div className="th-section" role="region" aria-label={extensionsLabel}>
          <div className="th-section-title">{extensionsLabel}</div>
          <Card label={extensionsLabel}>
            <div className="th-toolbar">
              {failedExtensions.length === 0 ? null : (
                <Button variant="primary" busy={bulkBusy} onClick={() => { void reloadFailed() }} label={bulkLabel}>
                  {bulkLabel}
                </Button>
              )}
              <span className="th-row-meta">
                {failedExtensions.length === 0
                  ? label(lang, `${extensions.length} 个扩展全部正常加载`, `${extensions.length} extension(s) loaded cleanly`)
                  : label(lang, `${failedExtensions.length}/${extensions.length} 个扩展加载失败`, `${failedExtensions.length}/${extensions.length} extension(s) failed`)}
              </span>
            </div>
            <div className="th-list">
              {extensions.map(entry => {
                const isFailed = failedExtension(entry)
                const rowBusy = busy === RELOAD_OP + ':' + entry.id
                const styles = entry.styles ?? []
                return (
                  <div className="th-row" key={entry.id}>
                    <div className="th-row-body">
                      <span className="th-row-name">
                        {extensionName(entry, lang)}
                        <span className="th-mono">{entry.id + '@' + (entry.version === '' ? '?' : entry.version)}</span>
                      </span>
                      <span className="th-row-meta">
                        {entry.enabled ? label(lang, '已启用', 'enabled') : label(lang, '已停用', 'disabled')}
                        {' · '}
                        {entry.loaded ? label(lang, '已加载', 'loaded') : label(lang, '未加载', 'not loaded')}
                        {styles.length === 0 ? null : <span className="th-mono">{label(lang, '样式：', 'Styles: ') + styles.join(', ')}</span>}
                      </span>
                      {entry.error === null || entry.error === '' ? null : <span className="th-row-meta">{entry.error}</span>}
                    </div>
                    {isFailed ? (
                      <Button
                        variant="ghost"
                        busy={rowBusy}
                        disabled={bulkBusy}
                        onClick={() => { void reloadOne(entry.id) }}
                        label={label(lang, '重新加载 ' + entry.id, 'Reload ' + entry.id)}
                      >
                        {label(lang, '重新加载', 'Reload')}
                      </Button>
                    ) : (
                      <Badge tone="on">{t('diagnostics.ok')}</Badge>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
        </div>
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

      <div className="th-section" role="region" aria-label={t('diagnostics.mask')}>
        <div className="th-section-title">{t('diagnostics.mask')}</div>
        <Card>
          {snapshot.mask.available ? null : (
            <Callout tone="error">{t('diagnostics.maskMissing')}</Callout>
          )}
          {snapshot.mask.mounted === 0 && snapshot.mask.deny.length === 0 ? (
            <Empty title={t('diagnostics.maskNone')} />
          ) : (
            <div className="th-list">
              <div className="th-row">
                <div className="th-row-body">
                  <span className="th-row-name">{t('diagnostics.maskMounted')}</span>
                  <span className="th-row-meta">{snapshot.mask.mounted}</span>
                </div>
                <Badge tone={snapshot.mask.mounted > 0 ? 'on' : 'off'}>{snapshot.mask.mounted}</Badge>
              </div>
              <div className="th-row">
                <div className="th-row-body">
                  <span className="th-row-name">{t('diagnostics.maskDeny')}</span>
                  <span className="th-row-meta th-mono">{snapshot.mask.deny.length === 0 ? '—' : snapshot.mask.deny.join(', ')}</span>
                </div>
                <Badge tone={snapshot.mask.deny.length > 0 ? 'on' : 'off'}>{snapshot.mask.deny.length}</Badge>
              </div>
              <div className="th-row">
                <div className="th-row-body">
                  <span className="th-row-name">{t('diagnostics.maskSessions')}</span>
                  <span className="th-row-meta">{snapshot.mask.sessions.length}</span>
                </div>
                <Badge tone={snapshot.mask.sessions.length > 0 ? 'on' : 'off'}>{snapshot.mask.sessions.length}</Badge>
              </div>
            </div>
          )}
          {snapshot.mask.problems.map(problem => (
            <Callout key={problem} tone="error">{problem}</Callout>
          ))}
        </Card>
      </div>

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
                  {row.ok ? null : row.id === 'stale-lock' ? (
                    <Button variant="ghost" onClick={() => { setConfirmClear(true) }} label={label(lang, '清理锁文件', 'Clear the lock file')}>
                      {label(lang, '清理锁', 'Clear lock')}
                    </Button>
                  ) : PATCH_CHECK_IDS.includes(row.id) ? (
                    <>
                      <Button variant="ghost" onClick={() => { setLocateId(current => (current === row.id ? null : row.id)) }} label={label(lang, '定位 ' + row.id, 'Locate ' + row.id)}>
                        {label(lang, '定位问题', 'Locate')}
                      </Button>
                      <Button variant="ghost" onClick={() => { void copyCheckDetail(row) }} label={label(lang, '复制 ' + row.id + ' 的详情', 'Copy the detail of ' + row.id)}>
                        {label(lang, '复制详情', 'Copy detail')}
                      </Button>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
            {locateRow === null ? null : (
              <div className="th-list">
                <div className="th-row">
                  <div className="th-row-body">
                    <span className="th-row-name">{label(lang, '补丁文件', 'Patch file')}</span>
                    <span className="th-row-meta th-mono">{patchPath === '' ? label(lang, '未配置', 'not configured') : patchPath}</span>
                  </div>
                </div>
                <div className="th-row">
                  <div className="th-row-body">
                    <span className="th-row-name th-mono">{locateRow.id}</span>
                    <span className="th-row-meta">{locateRow.detail === '' ? label(lang, '没有详情', 'No detail') : locateRow.detail}</span>
                  </div>
                </div>
                {unclosedBlocks.map(name => (
                  <div className="th-row" key={'unclosed-' + name}>
                    <div className="th-row-body">
                      <span className="th-row-name">{label(lang, '未闭合块', 'Unclosed block')}</span>
                      <span className="th-row-meta th-mono">{name}</span>
                    </div>
                  </div>
                ))}
                {foreignBlocks.map(block => (
                  <div className="th-row" key={'foreign-' + block.name}>
                    <div className="th-row-body">
                      <span className="th-row-name">{label(lang, '外来行', 'Foreign rows')}</span>
                      <span className="th-row-meta"><span className="th-mono">{block.name}</span>{' · ' + block.foreign.join(', ')}</span>
                    </div>
                  </div>
                ))}
                <div className="th-row-meta">
                  {label(lang, '只读定位：补丁文件不会被改写；要改内容请到配置页。', 'Read-only location: the patch file is never rewritten; edit its content in the Config view.')}
                </div>
              </div>
            )}
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

      <MaintenanceCards {...props} />

      <DiagnosticsHistory history={snapshot.history} t={t} lang={lang} busy={busy} run={run} reload={reload} />

      <div className="th-section" role="region" aria-label={t('diagnostics.host')}>
        <div className="th-section-title">{t('diagnostics.host')}</div>
        <Card label={t('diagnostics.host')}>
          <div className="th-list">
            {hostRows.map(row => (
              <div className="th-row" key={row.label}>
                <div className="th-row-body">
                  <span className="th-row-name">{row.label}</span>
                  <span className="th-row-meta th-mono">{row.value === '' ? '—' : row.value}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
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

      <Dialog
        open={confirmClear}
        title={label(lang, '清理陈旧锁文件', 'Clear the stale lock file')}
        onClose={() => { setConfirmClear(false) }}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setConfirmClear(false) }}>{t('action.cancel')}</Button>
            <Button variant="danger" busy={clearing} onClick={() => { void clearLock() }} label={label(lang, '清理锁', 'Clear lock')}>
              {label(lang, '清理锁', 'Clear lock')}
            </Button>
          </>
        }
      >
        <div className="th-list">
          <div className="th-row">
            <div className="th-row-body">
              <span className="th-row-name">{label(lang, '锁文件', 'Lock file')}</span>
              <span className="th-row-meta th-mono">{patchPath === '' ? label(lang, '未配置', 'not configured') : patchPath + '.panel.lock'}</span>
            </div>
          </div>
          <div className="th-row-meta">
            {label(lang, '先把锁文件备份到备份目录，再删除它；补丁文件本身不会被读写。', 'The lock file is backed up before removal; the patch file itself is never read or written.')}
          </div>
        </div>
      </Dialog>
    </div>
  )
}
