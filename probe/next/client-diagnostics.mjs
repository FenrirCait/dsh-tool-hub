#!/usr/bin/env node
/**
 * probe/next/client-diagnostics.mjs -- the diagnostics view (task-15, task-44), checked from outside.
 *
 * Source-only gates: the view is read as text, so the probe needs no browser, no host and no
 * build. It pins the properties the page must keep:
 *   1. the view exists and still exports DiagnosticsView(props: ViewProps);
 *   2. doctor is the only read-only host call, sent once through runOp(OPS.doctor) and never
 *      through props.run (run() reports success, not the report the page renders);
 *   3. the report parser validates every row instead of trusting the payload;
 *   4. checks render with OK/Fail badges, their detail, and a failing-count summary;
 *   5. history renders time, op, detail and result from snapshot.history, or an empty state;
 *   6. paths render home / state / patch / skill roots from snapshot.paths, and the host card
 *      shows the plugin version, node, platform and pid from snapshot.meta;
 *   7. the capability summary names missing members and their fallback;
 *   8. doctor is never run on mount, only from an explicit click;
 *   9. the run button reports its own busy state;
 *  10. every t('...') resolves in both catalogs and stays inside diagnostics/action/state/a11y;
 *  11. no literal colours, no inline styles, no HTML injection, no TODO marker;
 *  12. the file stays inside the view budget and the shell mount stays intact;
 *  13. copy puts the current report on the clipboard and shows success or failure;
 *  14. a failed extension row offers one explicit extension.reload, and one bulk action reloads
 *      every failed row; both report their result and neither invents a repair op;
 *  15. extension failures come from the snapshot payload, not from a new host field.
 *
 * No third-party libraries. Every line is PASS or FAIL; exit 1 when any check fails.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = join(ROOT, 'src', 'client')
const VIEW = join(CLIENT, 'views', 'diagnostics.tsx')
const SHELL = join(CLIENT, 'shell.tsx')
const I18N = join(CLIENT, 'i18n.ts')
const TYPES = join(CLIENT, 'types.ts')
const HOST_INDEX = join(ROOT, 'src', 'host', 'index.ts')
const HISTORY = join(CLIENT, 'views', 'diagnostics-history.tsx')
const historySource = readFileSync(HISTORY, 'utf8')

let passed = 0
const failures = []

function check(name, run) {
  try {
    const detail = run()
    passed += 1
    console.log('PASS ' + name + (detail === undefined || detail === '' ? '' : ' (' + detail + ')'))
  }
  catch (error) {
    failures.push(name)
    console.log('FAIL ' + name + ' -- ' + (error instanceof Error ? error.message : String(error)))
  }
}

function skip(name, why) {
  passed += 1
  console.log('SKIP ' + name + ' (' + why + ')')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const rel = file => relative(ROOT, file).split('\\').join('/')
const source = existsSync(VIEW) ? readFileSync(VIEW, 'utf8') : ''
const numberOf = needle => source.split(needle).length - 1
const lines = source.split('\n')

/** Block comments and full-line comments removed: prose may name a rule the code does not follow. */
function stripComments(text) {
  let out = ''
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('/*', index)
    if (open === -1) {
      out += text.slice(index)
      break
    }
    out += text.slice(index, open)
    const close = text.indexOf('*/', open + 2)
    if (close === -1) break
    index = close + 2
  }
  return out.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
}

const body = stripComments(source)

/**
 * The keys a source calls t('...') with, in first-seen order. The leading boundary keeps
 * identifiers such as createElement('textarea') from reading as a t('textarea') call; the key
 * need not be the only argument, so t('key', { ... }) is found too.
 */
function keysUsed(text) {
  const keys = new Set()
  const pattern = /(^|[^A-Za-z0-9_$])t\('([^']+)'/g
  let match = pattern.exec(text)
  while (match !== null) {
    keys.add(match[2])
    match = pattern.exec(text)
  }
  return keys
}

/** Keys of one catalog literal, parsed without a regex so a quote never has to be escaped. */
function catalogKeys(text, name) {
  const marker = 'const ' + name + ': Catalog = {'
  const start = text.indexOf(marker)
  assert(start !== -1, 'i18n.ts has no ' + name + ' catalog')
  const open = start + marker.length - 1
  let depth = 0
  let close = -1
  for (let cursor = open; cursor < text.length; cursor += 1) {
    const char = text[cursor]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        close = cursor
        break
      }
    }
  }
  assert(close !== -1, name + ' catalog is not closed')
  const keys = new Set()
  for (const line of text.slice(open + 1, close).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("'")) continue
    const end = trimmed.indexOf("'", 1)
    if (end === -1) continue
    keys.add(trimmed.slice(1, end))
  }
  return keys
}

/** Specifiers of imports, so a missing .js suffix cannot ship. */
function relativeImports(text) {
  const specs = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('import ')) continue
    const at = trimmed.indexOf("from '")
    if (at === -1) continue
    const start = at + 6
    const end = trimmed.indexOf("'", start)
    if (end === -1) continue
    specs.push(trimmed.slice(start, end))
  }
  return specs
}

// -- the view itself -------------------------------------------------------

check('files-present', () => {
  assert(existsSync(VIEW), 'src/client/views/diagnostics.tsx is missing')
  assert(source.length > 4000, 'the view is still the scaffold (' + source.length + ' bytes)')
  assert(!source.includes('Scaffolded for the view agent'), 'the scaffold header is still there')
  return rel(VIEW) + ', ' + lines.length + ' lines, ' + statSync(VIEW).size + ' bytes'
})

check('export-view', () => {
  assert(source.includes('export function DiagnosticsView(props: ViewProps): React.ReactElement'), 'DiagnosticsView must stay the exported entry point, typed against ViewProps')
  assert(/import type \{ ExtensionStatus, SnapshotPaths, ViewProps \} from '\.\.\/types\.js'/.test(source), 'ViewProps, SnapshotPaths and ExtensionStatus must come from ../types.js')
  return 'DiagnosticsView(props: ViewProps): React.ReactElement'
})

check('doctor-op-readonly', () => {
  assert(source.includes("import { OPS, runOp } from '../api.js'"), 'doctor must be sent through api.ts runOp')
  assert(numberOf('OPS.doctor') === 1, 'OPS.doctor must appear once, found ' + numberOf('OPS.doctor'))
  assert(numberOf('runOp(') === 1, 'exactly one runOp() call expected, found ' + numberOf('runOp('))
  assert(source.includes('await runOp(OPS.doctor, {})'), 'the one call must be a payload-only doctor read')
  assert(!body.includes('getSnapshot('), 'the view must not fetch a snapshot of its own')
  assert(!body.includes('fetch('), 'the view must not use fetch directly')
  assert(!body.includes('props.run'), 'the view must not call the shell run(): it drops the report')
  assert(!body.includes('run(OPS.doctor'), 'doctor must never go through the write path')
  assert(!body.includes('runOp(RELOAD_OP'), 'extension.reload must go through the shell write path, not runOp')
  return 'runOp(OPS.doctor, {}), one read; extension.reload goes through runDetailed'
})

check('report-parser', () => {
  assert(source.includes('function readReport(value: unknown): DoctorReport {'), 'readReport must normalise the op answer')
  assert(source.includes('function checksOf(value: unknown): CheckRow[] {'), 'checksOf must own the check rows')
  assert(source.includes('function capabilityOf(value: unknown): CapabilitySummary | null {'), 'capabilityOf must own the capability summary')
  assert(source.includes("const id = textOf(row.id)") && source.includes("if (id === '') continue"), 'a check without an id must be dropped')
  assert(source.includes('if (present === null || total === null) return null'), 'a capability summary without counts is not rendered')
  assert(source.includes('checks: checksOf(row.checks)'), 'readReport must route checks through checksOf')
  assert(source.includes('capabilities: capabilityOf(row.capabilities)'), 'readReport must route capabilities through capabilityOf')
  assert(source.includes("if (!Array.isArray(value)) return []"), 'a non-array checks field must yield no rows')
  return 'validated checks + optional capability summary'
})

check('checks-render', () => {
  assert(source.includes('{checks.map(row => ('), 'the checks list must map the parsed rows')
  assert(source.includes('<span className="th-row-name th-mono">{row.id}</span>'), 'each check must show its id')
  assert(source.includes("tone={row.ok ? 'on' : 'danger'}"), 'each check needs an OK/Fail badge')
  assert(source.includes("{row.ok ? t('diagnostics.ok') : t('diagnostics.fail')}"), 'the badge must read OK or Fail from the catalogs')
  assert(source.includes("row.detail === '' ? label(lang, '没有详情', 'No detail') : row.detail"), 'the check detail must render, with an explicit empty case')
  return 'id + detail + OK/Fail badge per check'
})

check('failing-summary', () => {
  assert(source.includes('const failing = checks.filter(row => !row.ok)'), 'the view needs the failing count')
  assert(source.includes("t('diagnostics.issue')"), 'the failing summary must name the issue')
  assert(source.includes("failing.length === 0 ? t('diagnostics.ok') :"), 'an all-green report must read as OK')
  assert(source.includes('role="status" aria-label={t(\'a11y.status\')}'), 'the summary must be announced as a status region')
  return 'fail count vs total, announced'
})

check('history-table', () => {
  assert(historySource.includes('shown.map((entry: HistoryEntry, index: number) => ('), 'history rows must keep the HistoryEntry contract')
  assert(historySource.includes("title={t('diagnostics.op')}>{entry.op}</span>"), 'each row must show the op')
  assert(historySource.includes("title={t('diagnostics.at')}>{stamp(entry.at, lang)}</span>"), 'each row must show the formatted time')
  assert(historySource.includes("{entry.detail === '' ? null : <span>{entry.detail}</span>}"), 'each row must show the detail when present')
  assert(historySource.includes("tone={entry.ok ? 'on' : 'danger'}"), 'each row needs its result badge')
  assert(historySource.includes("{entry.ok ? t('diagnostics.ok') : t('diagnostics.fail')}"), 'the result badge must read OK or Fail')
  return 'time + op + detail + result'
})

check('history-empty', () => {
  assert(historySource.includes('shown.length === 0 ? ('), 'an empty history needs its own branch')
  assert(historySource.includes("history.length > 0 ? t('diagnostics.historyNoMatch') : t('diagnostics.empty')"), 'the empty history state must use diagnostics.empty')
  return 'empty state for a fresh installation'
})

check('paths-card', () => {
  assert(source.includes('const pathRows = pathRowsOf(snapshot.paths, t, lang)'), 'paths must come from the snapshot')
  assert(source.includes("function pathRowsOf(paths: SnapshotPaths, t: ViewProps['t'], lang: ViewProps['lang']): PathRow[] {"), 'pathRowsOf must own the four path rows')
  assert(source.includes("label(lang, '宿主目录', 'Home')"), 'the home row needs a label')
  assert(source.includes("{ label: t('diagnostics.state'), values: [paths.state ?? ''] }"), 'the state file row must use diagnostics.state')
  assert(source.includes("{ label: t('diagnostics.patch'), values: [paths.patch ?? ''] }"), 'the patch row must use diagnostics.patch')
  assert(source.includes("{ label: t('diagnostics.skills'), values: skills }"), 'the skill roots row must use diagnostics.skills')
  assert(source.includes('paths.skillRoots.length > 0') && source.includes('paths.skills ?? []'), 'skill roots fall back to the richer skills rows')
  assert(source.includes("label(lang, '未配置', 'not configured')"), 'a missing path must say so instead of rendering blank')
  return 'home / state / patch / skill roots'
})

check('host-meta-card', () => {
  assert(source.includes("t('diagnostics.host')"), 'the host card needs its own section title')
  assert(source.includes('role="region" aria-label={t(\'diagnostics.host\')}'), 'the host card needs a named region')
  assert(source.includes('snapshot.meta.pluginVersion'), 'the card must show the plugin version')
  assert(source.includes('snapshot.meta.node'), 'the card must show the node version')
  assert(source.includes('snapshot.meta.platform'), 'the card must show the platform')
  assert(source.includes('String(snapshot.meta.pid)'), 'the card must show the pid as text')
  assert(source.includes('{hostRows.map(row => ('), 'the host rows must be rendered from the snapshot')
  return 'version + node + platform + pid from snapshot.meta'
})

check('capability-summary', () => {
  assert(source.includes("capabilities.present + '/' + capabilities.total"), 'the summary must show present / total')
  assert(source.includes('capabilities.missing.map(row => ('), 'every missing member must be listed')
  assert(source.includes('capabilities.degraded'), 'optional gaps must read as degraded, not broken')
  assert(source.includes("{row.fallback === '' ? null : <span>{row.fallback}</span>}"), 'a missing member must name its fallback')
  assert(source.includes("label(lang, '必需', 'required')"), 'the rows must distinguish required from optional')
  assert(source.includes("label(lang, '宿主能力', 'Host capabilities')"), 'the section needs a bilingual label')
  return 'present/total, missing members, fallback, required flag'
})

check('no-auto-run', () => {
  assert(!body.includes('useEffect'), 'doctor must not run on mount: the operator asks for it')
  assert(numberOf('void runDoctor()') === 3, 'three explicit entry points expected (toolbar, error retry, empty state), found ' + numberOf('void runDoctor()'))
  assert(numberOf('void reloadFailed()') === 1, 'exactly one bulk reload entry point expected, found ' + numberOf('void reloadFailed()'))
  assert(numberOf('void reloadOne(entry.id)') === 1, 'exactly one per-row reload entry point expected, found ' + numberOf('void reloadOne(entry.id)'))
  return 'explicit click only'
})

check('busy-state', () => {
  assert(source.includes('const [running, setRunning] = React.useState(false)'), 'the view owns its own busy flag')
  assert(source.includes('busy={running}'), 'the run button must show the busy state')
  assert(source.includes("const runLabel = running ? t('diagnostics.running') : t('diagnostics.run')"), 'the label must switch to diagnostics.running')
  assert(source.includes('setRunning(true)') && source.includes('setRunning(false)'), 'both edges of the busy flag must be set')
  return 'running flag, busy button, Running… label'
})

check('snapshot-only', () => {
  assert(source.includes('const { snapshot, t, lang, busy, run, reload, runDetailed } = props'), 'the view reads the snapshot it was given and the shell write path')
  assert(source.includes('<DiagnosticsHistory history={snapshot.history}'), 'history is snapshot data')
  assert(source.includes('snapshot.paths'), 'paths are snapshot data')
  assert(!source.includes('setInterval'), 'the view must not poll the host')
  assert(!source.includes('setTimeout'), 'the view must not retry on a timer')
  return 'history + paths + extensions from the snapshot; no polling'
})

check('a11y-labels', () => {
  assert(numberOf('role="region"') >= 5, 'labelled sections expected, found ' + numberOf('role="region"'))
  assert(source.includes('role="region" aria-label={t(\'diagnostics.checks\')}'), 'the checks section needs a name')
  assert(historySource.includes('role="region" aria-label={t(\'diagnostics.history\')}'), 'the history section needs a name')
  assert(source.includes('role="region" aria-label={t(\'diagnostics.paths\')}'), 'the paths section needs a name')
  assert(source.includes('role="region" aria-label={capabilityLabel}'), 'the capability section needs a name')
  assert(source.includes('role="region" aria-label={extensionsLabel}'), 'the extensions section needs a name')
  assert(numberOf('role="status"') === 1, 'exactly one live status region expected')
  assert(numberOf('aria-live="polite"') === 1, 'exactly one polite live region expected for action feedback')
  assert(source.includes('label={runLabel}'), 'the run button needs an accessible name')
  assert(source.includes('label={copyButtonLabel}'), 'the copy button needs an accessible name')
  assert(source.includes("label={label(lang, '重新加载 ' + entry.id, 'Reload ' + entry.id)}"), 'each reload button needs an accessible name naming its row')
  assert(source.includes("{t('action.retry')}"), 'the failure banner must offer a real retry button')
  return 'five regions, one status, one polite live region, named buttons'
})

// -- task-44: copy the report and recovery actions -------------------------

check('copy-report-action', () => {
  assert(source.includes("const [copyState, setCopyState] = React.useState<'idle' | 'copying' | 'ok' | 'fail'>('idle')"), 'copy state must track idle/copying/ok/fail')
  assert(source.includes('const copyReport = React.useCallback'), 'copyReport must be an explicit handler')
  assert(source.includes('const copied = await copyToClipboard(text)'), 'the handler must await the clipboard write')
  assert(source.includes("label(lang, '复制报告', 'Copy report')"), 'the button needs a bilingual idle label')
  assert(source.includes("label(lang, '已复制', 'Copied')"), 'success must be visible on the button')
  assert(source.includes("label(lang, '复制失败', 'Copy failed')"), 'failure must be visible on the button')
  assert(source.includes("label(lang, '已复制当前报告到剪贴板', 'Copied the current report to the clipboard')"), 'success must be stated in words')
  assert(source.includes("label(lang, '复制失败：浏览器不允许访问剪贴板', 'Copy failed: the browser denied clipboard access')"), 'failure must say why')
  return 'copy state, visible success and failure labels'
})

check('report-builder', () => {
  assert(source.includes('function buildDiagnosticsReport('), 'one builder must own the copied text')
  assert(source.includes('buildDiagnosticsReport(snapshot, report, new Date().toISOString(), lang)'), 'the builder must receive the snapshot and the doctor report')
  for (const section of ['doctor: ', 'capabilities: ', 'extensions: ', 'patch blocks: ', 'history: ']) {
    assert(source.includes("'" + section + "'"), 'the copied report has no ' + section + 'section')
  }
  assert(source.includes("'mask: mounted='"), 'the copied report has no mask section')
  assert(source.includes("'paths: home='"), 'the copied report has no paths section')
  assert(source.includes("'; styles: ' + entry.styles.join(', ')"), 'the copied report must list declared styles')
  assert(source.includes("'; error: ' + entry.error"), 'the copied report must carry the extension error')
  assert(source.includes('snapshot.history.slice(0, 10)'), 'the copied report must bound the history tail')
  assert(!source.includes('snapshot.settings'), 'the copied report must not include settings values')
  return 'doctor + capabilities + extensions + paths + bounded history'
})

check('clipboard-fallback', () => {
  assert(source.includes("const clipboard: Clipboard | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard"), 'the primary path is navigator.clipboard')
  assert(source.includes('await clipboard.writeText(text)'), 'the primary path writes the text')
  assert(source.includes("document.createElement('textarea')"), 'a refused clipboard write falls back to a selection copy')
  assert(source.includes("area.className = 'th-visually-hidden'"), 'the fallback textarea must stay out of sight')
  assert(source.includes('document.body.appendChild(area)') && source.includes('document.body.removeChild(area)'), 'the fallback textarea must be cleaned up')
  assert(source.includes("document.execCommand('copy')"), 'the fallback must use the copy command')
  return 'navigator.clipboard first, selection copy second'
})

check('extension-failures', () => {
  assert(source.includes('function failedExtension(entry: ExtensionStatus): boolean'), 'one predicate must decide a failed extension row')
  assert(source.includes("if (entry.error !== null && entry.error !== '') return true"), 'a reported error makes the row failed')
  assert(source.includes('return entry.enabled && !entry.loaded'), 'an enabled row that never loaded is failed too')
  assert(source.includes('const extensions = snapshot.extensions'), 'the rows come from the snapshot payload')
  assert(source.includes('const failedExtensions = extensions.filter(failedExtension)'), 'the page derives the failed set once')
  assert(source.includes(`{entry.error === null || entry.error === '' ? null : <span className="th-row-meta">{entry.error}</span>}`), 'the row must show the host error, a style failure included')
  assert(source.includes("label(lang, '样式：', 'Styles: ') + styles.join(', ')"), 'the row must list its declared style files')
  return 'error + loaded + styles from snapshot.extensions'
})

check('per-row-reload', () => {
  assert(source.includes("const RELOAD_OP = 'extension.reload'"), 'the view must call the existing extension.reload op')
  assert(source.includes('const reloadOne = React.useCallback(async (id: string): Promise<boolean> => {'), 'one handler reloads one row')
  assert(source.includes('await runDetailed(RELOAD_OP, { id })'), 'the per-row write must carry the row id')
  assert(source.includes('busy={rowBusy}'), 'the row button must show its own busy state')
  assert(source.includes('disabled={bulkBusy}'), 'no row reload may start while another reload is running')
  assert(source.includes("label(lang, '重新加载', 'Reload')"), 'the row action must read Reload')
  assert(source.includes('{isFailed ? ('), 'only a failed row gets the reload button')
  assert(source.includes(`tone="on">{t('diagnostics.ok')}</Badge>`), 'a healthy row shows OK instead')
  const hostIndex = readFileSync(HOST_INDEX, 'utf8')
  assert(hostIndex.includes("{ id: 'extension.reload', write: true, audit: true"), 'src/host/index.ts no longer declares extension.reload')
  for (const invented of ['extension.repair', 'extension.reset', 'extension.fix', 'doctor.repair']) {
    assert(!source.includes(invented), 'the view invents the repair op ' + invented)
  }
  return 'extension.reload { id } per failed row, no new op'
})

check('bulk-reload', () => {
  assert(source.includes('const reloadFailed = React.useCallback'), 'one handler owns the bulk action')
  assert(source.includes('const failedIds = snapshot.extensions.filter(failedExtension).map(entry => entry.id)'), 'the bulk target is captured before the first write')
  assert(source.includes('for (const id of failedIds)'), 'the bulk action reloads each failed row through the same op')
  assert(source.includes("label(lang, '重新加载失败扩展', 'Reload failed extensions')"), 'the bulk button needs a bilingual label')
  assert(source.includes('{failedExtensions.length === 0 ? null : ('), 'the bulk button appears only when a row has an error')
  assert(source.includes("label(lang, '已重新加载 ' + done + ' 个失败的扩展', 'Reloaded ' + done + ' failed extension(s)')"), 'the bulk action must report its count')
  assert(source.includes("label(lang, '已重新加载 ' + done + '/' + failedIds.length + ' 个；失败：'"), 'a partial bulk failure must report both counts and the errors')
  return 'one button, failed rows only, counts reported'
})

check('action-feedback', () => {
  assert(source.includes('const [actionNote, setActionNote] = React.useState<ActionNote | null>(null)'), 'the last action result must be kept')
  assert(source.includes('{actionNote === null ? null : (actionNote.ok'), 'the result must render')
  assert(source.includes('<Callout tone="error">{actionNote.text}</Callout>'), 'a failed action must raise an alert')
  assert(source.includes('<span className="th-visually-hidden" aria-live="polite">{liveText}</span>'), 'both actions must announce their result')
  assert(source.includes("label(lang, '已重新加载 ' + id, 'Reloaded ' + id)"), 'a successful row reload must be named')
  assert(source.includes("label(lang, '重载失败：' + id"), 'a failed row reload must name the row and the reason')
  assert(!body.includes('autoReload'), 'nothing reloads extensions automatically')
  return 'visible note, alert on failure, one polite announcement'
})

check('extension-payload-exposed', () => {
  const types = readFileSync(TYPES, 'utf8')
  assert(types.includes('export interface ExtensionStatus'), 'ExtensionStatus must stay the extension contract')
  assert(types.includes('error: string | null'), 'ExtensionStatus must still expose the load error')
  assert(types.includes('styles?: string[]'), 'ExtensionStatus must still expose the declared styles')
  assert(types.includes('extensions: ExtensionStatus[]'), 'HubSnapshot must still carry the extension rows')
  const hostIndex = readFileSync(HOST_INDEX, 'utf8')
  assert(hostIndex.includes('extensions: holder.statuses'), 'buildSnapshot must still fill extensions from the manager statuses')
  assert(!source.includes("'extension.list'"), 'diagnostics must not spend an extra op on extension.list')
  return 'snapshot.extensions already exposes failures; no host field added'
})

// -- contracts with the rest of the panel ----------------------------------

check('i18n-keys-exist', () => {
  const i18n = readFileSync(I18N, 'utf8')
  const zh = catalogKeys(i18n, 'zh')
  const en = catalogKeys(i18n, 'en')
  for (const key of zh) assert(en.has(key), 'en is missing "' + key + '"')
  for (const key of en) assert(zh.has(key), 'zh is missing "' + key + '"')
  const used = keysUsed(body)
  for (const key of used) assert(zh.has(key), "the view calls t('" + key + "') which no catalog defines")
  for (const key of keysUsed(historySource)) assert(zh.has(key), "the history component calls t('" + key + "') which no catalog defines")
  const required = [
    'diagnostics.run', 'diagnostics.running', 'diagnostics.checks', 'diagnostics.ok',
    'diagnostics.fail', 'diagnostics.issue', 'diagnostics.history', 'diagnostics.empty',
    'diagnostics.paths', 'diagnostics.state', 'diagnostics.patch', 'diagnostics.skills',
    'diagnostics.at', 'diagnostics.op', 'action.retry', 'state.ready', 'a11y.status',
  ]
  for (const key of required) assert(zh.has(key), "no catalog defines t('" + key + "')")
  return zh.size + ' keys aligned, ' + used.size + ' used by the view'
})

check('no-new-i18n-keys', () => {
  const i18n = readFileSync(I18N, 'utf8')
  const zh = catalogKeys(i18n, 'zh')
  for (const key of keysUsed(body)) assert(zh.has(key), 'new label "' + key + '" was not added to i18n.ts either')
  for (const prefix of ['diagnostics.copy', 'diagnostics.reload', 'diagnostics.extension', 'diagnostics.action']) {
    assert(![...keysUsed(body)].some(key => key.startsWith(prefix)), 'task-44 labels must stay local, not added as ' + prefix + '* keys')
  }
  return 'task-44 labels use the local bilingual helper only'
})

check('host-meta-keys', () => {
  const i18n = readFileSync(I18N, 'utf8')
  const zh = catalogKeys(i18n, 'zh')
  const en = catalogKeys(i18n, 'en')
  const keys = ['diagnostics.host', 'diagnostics.hostPlugin', 'diagnostics.hostNode', 'diagnostics.hostPlatform']
  for (const key of keys) {
    assert(zh.has(key), 'zh is missing "' + key + '"')
    assert(en.has(key), 'en is missing "' + key + '"')
    assert(body.includes("t('" + key + "')"), 'the view never resolves "' + key + '"')
  }
  return keys.length + ' host keys in zh + en, all used by the view'
})

check('i18n-key-scope', () => {
  const allowed = ['diagnostics.', 'action.', 'state.', 'a11y.']
  for (const key of keysUsed(body)) {
    assert(allowed.some(prefix => key.startsWith(prefix)), 'key "' + key + '" is outside the diagnostics/action/state/a11y families')
  }
  return allowed.join(' ')
})

check('imports-clean', () => {
  const specs = relativeImports(source)
  assert(specs.includes('react'), 'the view needs React')
  assert(specs.includes('../api.js'), 'runOp must come from ../api.js')
  assert(specs.includes('../components.js'), 'the view must reuse the shared primitives')
  assert(specs.includes('../types.js'), 'ViewProps must come from ../types.js')
  assert(specs.length === 6, 'six imports expected, found: ' + specs.join(', '))
  for (const spec of specs.filter(item => item.startsWith('.'))) assert(spec.endsWith('.js') || spec.endsWith('.jsx'), spec + ' must carry a .js suffix')
  return specs.join(', ')
})

check('no-literal-colours', () => {
  assert(!source.includes('style={{'), 'the view must not style inline: th-* classes carry the theme')
  const hex = /#[0-9a-fA-F]{3,8}/.exec(source)
  assert(hex === null, 'literal colour at offset ' + (hex === null ? 0 : hex.index))
  for (const pattern of ['rgb(', 'rgba(', 'hsl(', 'hsla(', 'color:']) {
    assert(!source.includes(pattern), 'the view uses ' + pattern + ' outside a token')
  }
  assert(source.includes('className="th-row"'), 'the view must lay out with the shared th-* classes')
  return 'classNames only, no colour values'
})

check('no-unsafe-markup', () => {
  for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment']) {
    assert(!source.includes(pattern), 'the view uses ' + pattern)
  }
  const todo = source.indexOf('TODO(') !== -1 || source.indexOf('FIXME') !== -1 || source.indexOf('XXX:') !== -1
  assert(!todo, 'the view still carries a TODO marker')
  return 'no HTML string injection, no TODO'
})

check('bilingual-oneoff', () => {
  assert(source.includes("function label(lang: ViewProps['lang'], zh: string, en: string): string {"), 'one-off labels go through one helper')
  assert(source.includes("return lang === 'zh' ? zh : en"), 'the helper must switch on the ViewProps language')
  assert(source.includes("label(lang, '宿主目录', 'Home')"), 'the home label must be bilingual')
  assert(source.includes("label(lang, '宿主能力', 'Host capabilities')"), 'the capability label must be bilingual')
  assert(source.includes("label(lang, '扩展', 'Extensions')"), 'the extensions label must be bilingual')
  assert(source.includes("label(lang, '已启用', 'enabled')") && source.includes("label(lang, '已加载', 'loaded')"), 'the extension state labels must be bilingual')
  return "lang === 'zh' ? zh : en"
})

check('file-length', () => {
  const bytes = statSync(VIEW).size
  assert(lines.length < 760, 'the view has ' + lines.length + ' lines (limit 760)')
  assert(bytes < 70 * 1024, 'the view is ' + bytes + ' bytes (limit 70 KB)')
  return lines.length + ' lines, ' + bytes + ' bytes'
})

check('view-mounted', () => {
  const shell = readFileSync(SHELL, 'utf8')
  assert(shell.includes("import { DiagnosticsView } from './views/diagnostics.js'"), 'the shell must import this view')
  assert(shell.split('<DiagnosticsView ').length - 1 === 1, 'the shell must mount the view once')
  const at = shell.indexOf('<DiagnosticsView ')
  const end = shell.indexOf('/>', at)
  assert(at !== -1 && end !== -1, 'the shell mount is not self-closing or is missing')
  const mount = shell.slice(at, end)
  for (const prop of ['snapshot={snapshot}', 't={t}', 'busy={busy}', 'run={run}', 'runDetailed={runDetailed}', 'reload={reload}']) {
    assert(mount.includes(prop), 'the shell must pass ' + prop)
  }
  assert(/lang=\{(?:effectiveLang|lang)\}/.test(mount), 'the shell must pass a language')
  assert(shell.includes("{ id: 'diagnostics', label: 'nav.diagnostics' }"), 'the sidebar keeps one diagnostics entry')
  return 'one import, one mount, every ViewProps'
})

const bundle = join(ROOT, 'dist', 'client.js')
if (!existsSync(bundle)) {
  skip('bundle-diagnostics', 'dist/client.js not built yet; the lead builds')
}
else if (!readFileSync(bundle, 'utf8').includes('Host capabilities')) {
  skip('bundle-diagnostics', 'dist/client.js predates this view; rebuild to include it')
}
else {
  check('bundle-diagnostics', () => {
    const text = readFileSync(bundle, 'utf8')
    // These markers are one-offs only this view carries; the shared catalogs do not.
    for (const marker of ['Host capabilities', 'diagnostics.issue', 'doctor', 'Copy report', 'Reload failed extensions', 'extension.reload']) {
      assert(text.includes(marker), 'dist/client.js carries no ' + marker)
    }
    return 'the bundle carries the view, the actions and the doctor op'
  })
}

console.log(passed + '/' + (passed + failures.length) + ' checks passed')
if (failures.length > 0) {
  console.log('failed: ' + failures.join(', '))
  process.exit(1)
}
