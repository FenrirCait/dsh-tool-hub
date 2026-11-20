/**
 * Extensions: what is installed, whether it loaded, its hot switch, the views it declares, and
 * one console for the ops it registers.
 *
 * Three host calls, and the difference between them is deliberate:
 *   - a declared view's read goes through runOp, because the page renders the payload and run()
 *     reports success instead of keeping it;
 *   - the panel's own two writes (extension.set, extension.reload) go through run, so the shell
 *     owns busy and the failure notice, and the snapshot reload after a write comes for free;
 *   - the console's ops go through runDetailed, because the host's answer is what the operator
 *     came for and a failure has to stay readable under the form.
 *
 * A declared view may only point at a read op — src/host/extensions.ts refuses a registration
 * whose view names a write op — so views[].op is the panel's only trustworthy source of "this op
 * is a read". Any op the console can reach that no view declares is handled as a write: the
 * dialog asks first and the payload leaves with confirm:true, the flag the dispatch gate accepts.
 * Nothing here decides what an extension's op means; it only refuses to fire one silently.
 */
import * as React from 'react'
import { runOp } from '../api.js'
import { Badge, Button, Callout, Card, Dialog, Empty, Field, Select, Switch, Toolbar, monoStyle } from '../components.js'
import { FONT, R, SP, T } from '../theme.js'
import type { ExtensionStatus, ExtensionViewRow, ViewProps } from '../types.js'

// ── the two ops this panel sends ─────────────────────────────────────────────

/** The panel's own writes; an extension's ops arrive in the snapshot and are never spelled here. */
export const EXT = { set: 'extension.set', reload: 'extension.reload' } as const

// ── normalising helpers ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One language per render; a manifest that lost one side falls back to the other, then the id. */
export function nameOf(entry: ExtensionStatus, lang: ViewProps['lang']): string {
  const preferred = lang === 'zh' ? entry.name.zh : entry.name.en
  const other = lang === 'zh' ? entry.name.en : entry.name.zh
  if (preferred !== '') return preferred
  return other !== '' ? other : entry.id
}

export function titleOf(view: ExtensionViewRow, lang: ViewProps['lang']): string {
  const preferred = lang === 'zh' ? view.title.zh : view.title.en
  const other = lang === 'zh' ? view.title.en : view.title.zh
  if (preferred !== '') return preferred
  return other !== '' ? other : view.id
}

/** The ops a declared view proves are reads; the host refuses a view over a write op. */
export function readOps(entry: ExtensionStatus): Set<string> {
  const ops = new Set<string>()
  for (const view of entry.views) ops.add(view.op)
  return ops
}

/** Everything else the console can reach is handled as a write: ask first, then confirm. */
export function isWriteOp(reads: Set<string>, op: string): boolean {
  return !reads.has(op)
}

export type ParsedPayload = { ok: true; value: unknown } | { ok: false }

/** The payload box is JSON; an empty box is the empty object, a broken one is refused here. */
export function parsePayload(text: string): ParsedPayload {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown }
  } catch {
    return { ok: false }
  }
}

const CELL_LIMIT = 160

/** One cell as text: primitives verbatim, anything deeper as compact JSON, both capped. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = ''
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
  else {
    try {
      text = JSON.stringify(value) ?? ''
    } catch {
      text = String(value)
    }
  }
  return text.length > CELL_LIMIT ? text.slice(0, CELL_LIMIT) + '…' : text
}

/** A rendered table: header names, and rows already flattened to one string per column. */
export interface TableData {
  columns: string[]
  rows: string[][]
}

/** rows, items, or the payload itself: the three places a list of rows can sit. */
function rowList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return null
  if (Array.isArray(value.rows)) return value.rows
  if (Array.isArray(value.items)) return value.items
  return null
}

function columnNames(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.columns)) return []
  const names: string[] = []
  for (const column of value.columns) {
    if (typeof column === 'string' && column !== '' && !names.includes(column)) names.push(column)
  }
  return names
}

function positionalNames(width: number): string[] {
  const names: string[] = []
  for (let index = 0; index < Math.max(width, 1); index += 1) names.push(String(index + 1))
  return names
}

/**
 * A table, or null when the payload is not tabular.
 *
 * Accepted: a bare array of records (columns from the keys, first-seen order), a wrapper
 * { columns?, rows } / { items }, and positional row arrays (header from columns, else 1..n).
 * Anything else is null and the caller renders the JSON box instead of inventing a table.
 */
export function tableData(value: unknown): TableData | null {
  const list = rowList(value)
  if (list === null) return null
  const declared = columnNames(value)
  const keys: string[] = []
  let width = 0
  for (const entry of list) {
    if (isRecord(entry)) {
      for (const key of Object.keys(entry)) if (!keys.includes(key)) keys.push(key)
    } else if (Array.isArray(entry)) width = Math.max(width, entry.length)
    else width = Math.max(width, 1)
  }
  const columns = declared.length > 0 ? declared : keys.length > 0 ? keys : positionalNames(width)
  const rows: string[][] = []
  for (const entry of list) {
    const row: string[] = []
    if (isRecord(entry)) {
      for (const column of columns) row.push(cellText(entry[column]))
    } else if (Array.isArray(entry)) {
      for (let index = 0; index < columns.length; index += 1) row.push(cellText(entry[index]))
    } else {
      row.push(cellText(entry))
      for (let index = 1; index < columns.length; index += 1) row.push('')
    }
    rows.push(row)
  }
  return { columns, rows }
}

/** One list line: a label the row is known by, and its remaining fields rendered beside it. */
export interface ListItem {
  label: string
  detail: string
}

function firstText(record: Record<string, unknown>): { text: string; key: string } {
  for (const key of ['name', 'title', 'id', 'key']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return { text: value, key }
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && value !== '') return { text: value, key }
  }
  return { text: '', key: '' }
}

function itemOf(entry: unknown): ListItem {
  if (!isRecord(entry)) return { label: cellText(entry), detail: '' }
  const label = firstText(entry)
  if (label.text === '') return { label: cellText(entry), detail: '' }
  const parts: string[] = []
  for (const [key, value] of Object.entries(entry)) {
    if (key === label.key) continue
    const text = cellText(value)
    if (text !== '') parts.push(key + ': ' + text)
  }
  return { label: label.text, detail: parts.join(' · ') }
}

/** A list, or null when the payload is neither a list nor a record of fields. */
export function listItems(value: unknown): ListItem[] | null {
  const list = rowList(value)
  if (list !== null) return list.map(itemOf)
  if (isRecord(value)) {
    const items: ListItem[] = []
    for (const [key, entry] of Object.entries(value)) items.push({ label: key, detail: cellText(entry) })
    return items
  }
  return null
}

/** The JSON box's text; a payload JSON cannot express still renders as something readable. */
export function jsonText(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

// ── styles: tokens and layout only, never a literal colour ──────────────────

const BAR: React.CSSProperties = { marginBottom: SP.sm }
const PAD: React.CSSProperties = { padding: '0 ' + SP.lg + 'px ' + SP.lg + 'px' }
const SCROLL: React.CSSProperties = { overflowX: 'auto' }
const TABLE: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: FONT.xs }
const TH: React.CSSProperties = {
  textAlign: 'left',
  padding: SP.xs + 'px ' + SP.md + 'px',
  borderBottom: '1px solid ' + T.borderSoft,
  color: T.text3,
  fontWeight: 600,
  whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = {
  padding: SP.xs + 'px ' + SP.md + 'px',
  borderTop: '1px solid ' + T.borderSoft,
  color: T.text2,
  verticalAlign: 'top',
}
const BOX: React.CSSProperties = {
  ...monoStyle,
  color: T.text2,
  margin: 0,
  padding: SP.md + 'px ' + SP.lg + 'px',
  border: '1px solid ' + T.borderSoft,
  borderRadius: R.sm,
  background: T.surface,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 260,
  overflow: 'auto',
}
const BOX_INPUT: React.CSSProperties = { ...BOX, minHeight: 72, width: '100%', resize: 'vertical' }

// ── renderers ───────────────────────────────────────────────────────────────

function JsonBox(props: { value: unknown; label: string }): React.ReactElement {
  return (
    <pre style={BOX} aria-label={props.label}>
      {jsonText(props.value)}
    </pre>
  )
}

function Table(props: { data: TableData; label: string }): React.ReactElement {
  return (
    <div className="th-card" style={SCROLL}>
      <table style={TABLE}>
        <caption className="th-visually-hidden">{props.label}</caption>
        <thead>
          <tr>
            {props.data.columns.map((column, index) => (
              <th key={index} scope="col" style={TH}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.data.rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} style={TD}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function List(props: { items: ListItem[] }): React.ReactElement {
  return (
    <ul className="th-list">
      {props.items.map((item, index) => (
        <li className="th-row" key={index}>
          <div className="th-row-body">
            <span className="th-row-name">{item.label}</span>
            {item.detail === '' ? null : <span className="th-row-meta">{item.detail}</span>}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** One declared view's answer, rendered by the kind the manifest declared. */
function ViewBody(props: {
  kind: ExtensionViewRow['kind']
  data: unknown
  label: string
  t: ViewProps['t']
}): React.ReactElement {
  const { kind, data, label, t } = props
  if (data === null || data === undefined) return <Empty title={t('extensions.viewEmpty')} />
  if (kind === 'table') {
    const table = tableData(data)
    if (table === null) return <JsonBox value={data} label={label} />
    if (table.rows.length === 0) return <Empty title={t('extensions.viewEmpty')} />
    return <Table data={table} label={label} />
  }
  if (kind === 'list') {
    const items = listItems(data)
    if (items === null) return <JsonBox value={data} label={label} />
    if (items.length === 0) return <Empty title={t('extensions.viewEmpty')} />
    return <List items={items} />
  }
  return <JsonBox value={data} label={label} />
}

/** Loaded / failed / idle, from the three flags the host reports. */
function statusBadge(entry: ExtensionStatus, t: ViewProps['t']): React.ReactElement | null {
  if (entry.error !== null) return <Badge tone="danger">{t('extensions.failed')}</Badge>
  if (entry.loaded) return <Badge tone="on">{t('extensions.loaded')}</Badge>
  if (entry.enabled) return <Badge tone="warn">{t('extensions.failed')}</Badge>
  return null
}

// ── one extension ───────────────────────────────────────────────────────────

interface ReadState {
  loading: boolean
  data?: unknown
  error?: string
}

interface PanelProps {
  entry: ExtensionStatus
  lang: ViewProps['lang']
  t: ViewProps['t']
  busy: string | null
  run: ViewProps['run']
  runDetailed: ViewProps['runDetailed']
}

/**
 * One extension: its status row, its views, and its console.
 *
 * The panel owns its own hooks, so several extensions can sit on one page without the parent
 * keeping a record of per-extension state. A view read and a console run each carry their own
 * busy flag: the shell's busy only knows the panel's own two ops.
 */
function ExtensionPanel(props: PanelProps): React.ReactElement {
  const { entry, lang, t, busy, run, runDetailed } = props
  const [reads, setReads] = React.useState<Record<string, ReadState>>({})
  const [op, setOp] = React.useState('')
  const [payload, setPayload] = React.useState('{}')
  const [result, setResult] = React.useState<string | null>(null)
  const [failure, setFailure] = React.useState('')
  const [pending, setPending] = React.useState<unknown>(null)
  const [asking, setAsking] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const alive = React.useRef(true)

  React.useEffect(() => {
    return () => {
      alive.current = false
    }
  }, [])

  const readsOf = readOps(entry)
  const chosen = entry.ops.includes(op) ? op : entry.ops[0] ?? ''
  const write = isWriteOp(readsOf, chosen)
  const parsed = parsePayload(payload)
  const toggleKey = EXT.set + ':' + entry.id
  const reloadKey = EXT.reload + ':' + entry.id
  const toggleBusy = busy === toggleKey
  const reloadBusy = busy === reloadKey
  const anyBusy = busy !== null
  const name = nameOf(entry, lang)
  const options = entry.ops.map(id => ({ value: id, label: id }))

  const readView = (view: ExtensionViewRow): void => {
    setReads(current => ({ ...current, [view.id]: { loading: true } }))
    void runOp(view.op, {}).then(answer => {
      if (!alive.current) return
      setReads(current => ({
        ...current,
        [view.id]: answer.ok ? { loading: false, data: answer.data } : { loading: false, error: answer.message },
      }))
    })
  }

  const send = (target: string, value: unknown, confirmed: boolean): void => {
    setResult(null)
    setFailure('')
    setRunning(true)
    const body = confirmed && isRecord(value) ? { ...value, confirm: true } : value
    void runDetailed(target, body).then(outcome => {
      if (!alive.current) return
      setRunning(false)
      if (!outcome.ok) {
        setFailure(outcome.error ?? '')
        return
      }
      const text = jsonText(outcome.data)
      setResult(text === '' ? 'null' : text)
    })
  }

  const submit = (): void => {
    if (!parsed.ok || chosen === '') return
    if (isWriteOp(readsOf, chosen)) {
      setPending(parsed.value)
      setAsking(true)
      return
    }
    send(chosen, parsed.value, false)
  }

  const confirmPending = (): void => {
    const staged = pending
    setAsking(false)
    send(chosen, staged, true)
  }

  const views = entry.views.length === 0 ? null : (
    <div className="th-section">
      <div className="th-section-title">{t('extensions.views')}</div>
      <div className="th-list">
        {entry.views.map(view => {
          const state = reads[view.id]
          const label = titleOf(view, lang)
          return (
            <div key={view.id}>
              <div className="th-toolbar" style={BAR}>
                <span className="th-row-name">{label}</span>
                <Badge>{view.kind}</Badge>
                <span className="th-mono">{view.op}</span>
                <Button
                  variant="ghost"
                  busy={state !== undefined && state.loading}
                  onClick={() => {
                    readView(view)
                  }}
                >
                  {t('extensions.viewLoad')}
                </Button>
              </div>
              {state === undefined || state.loading ? null : state.error !== undefined ? (
                <Callout>{state.error}</Callout>
              ) : (
                <ViewBody kind={view.kind} data={state.data} label={label} t={t} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )

  const opConsole = entry.ops.length === 0 ? null : (
    <div className="th-section">
      <div className="th-section-title">{t('extensions.ops')}</div>
      <div className="th-toolbar" style={BAR}>
        <Select id={entry.id + '-op'} value={chosen} options={options} onChange={setOp} label={t('extensions.ops')} />
        <Badge tone={write ? 'warn' : 'neutral'}>{write ? 'write' : 'read'}</Badge>
      </div>
      <Field
        id={entry.id + '-payload'}
        label={t('extensions.payload')}
        error={parsed.ok ? undefined : t('extensions.invalidJson')}
      >
        <textarea
          id={entry.id + '-payload'}
          className="th-input"
          style={BOX_INPUT}
          value={payload}
          aria-label={t('extensions.payload')}
          onChange={event => {
            setPayload(event.target.value)
          }}
        />
      </Field>
      <div className="th-toolbar" style={BAR}>
        <Button variant="primary" busy={running} disabled={!parsed.ok || chosen === '' || anyBusy} onClick={submit}>
          {t('extensions.run')}
        </Button>
      </div>
      {failure === '' ? null : <Callout>{failure}</Callout>}
      {result === null ? null : (
        <div>
          <div className="th-section-title">{t('extensions.result')}</div>
          <pre style={BOX} aria-label={t('extensions.result')}>
            {result}
          </pre>
        </div>
      )}
    </div>
  )

  return (
    <Card label={name}>
      <div className="th-row">
        <div className="th-row-body">
          <span className="th-row-name">{name}</span>
          <span className="th-row-meta">
            <span className="th-mono">{entry.id}</span>
            {entry.version === '' ? null : (
              <Badge title={t('extensions.version')}>{t('extensions.version') + ' ' + entry.version}</Badge>
            )}
            <Badge tone={entry.enabled ? 'on' : 'off'}>
              {entry.enabled ? t('extensions.enabled') : t('extensions.disabled')}
            </Badge>
            {statusBadge(entry, t)}
            {entry.dir === '' ? null : (
              <span className="th-mono" title={t('extensions.dir')}>
                {entry.dir}
              </span>
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          busy={reloadBusy}
          disabled={anyBusy}
          onClick={() => {
            void run(EXT.reload, { id: entry.id })
          }}
        >
          {t('extensions.reload')}
        </Button>
        <Switch
          checked={entry.enabled}
          busy={toggleBusy}
          label={t('a11y.switch', { name })}
          onChange={next => {
            void run(EXT.set, { id: entry.id, enabled: next })
          }}
        />
      </div>
      {entry.error === null ? null : (
        <div style={PAD}>
          <Callout>{entry.error}</Callout>
        </div>
      )}
      <div style={PAD}>
        {views}
        {opConsole}
      </div>
      <Dialog
        open={asking}
        title={t('dialog.confirmTitle')}
        onClose={() => {
          if (!running) setAsking(false)
        }}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={running}
              onClick={() => {
                setAsking(false)
              }}
            >
              {t('action.cancel')}
            </Button>
            <Button variant="primary" busy={running} onClick={confirmPending}>
              {t('action.confirm')}
            </Button>
          </>
        }
      >
        <div className="th-row-meta">
          <span className="th-mono">{chosen}</span>
          <Badge tone="warn">write</Badge>
        </div>
        <pre style={BOX} aria-label={t('extensions.payload')}>
          {jsonText(pending)}
        </pre>
      </Dialog>
    </Card>
  )
}

// ── the page ────────────────────────────────────────────────────────────────

export function ExtensionsView(props: ViewProps): React.ReactElement {
  const { snapshot, lang, t, busy, run, runDetailed, reload } = props
  if (snapshot.extensions.length === 0) {
    return <Empty title={t('extensions.empty')} hint={t('extensions.enableHint')} />
  }
  return (
    <div>
      <Toolbar>
        <Badge tone="brand">{t('extensions.count', { n: snapshot.extensions.length })}</Badge>
        <Button
          variant="ghost"
          onClick={() => {
            void reload()
          }}
        >
          {t('action.retry')}
        </Button>
      </Toolbar>
      <p className="th-field-hint" style={{ marginTop: 0 }}>
        {t('extensions.hot')}
      </p>
      <p className="th-field-hint" style={{ marginBottom: SP.lg }}>
        {t('extensions.local')}
      </p>
      <div className="th-list">
        {snapshot.extensions.map(entry => (
          <ExtensionPanel key={entry.id} entry={entry} lang={lang} t={t} busy={busy} run={run} runDetailed={runDetailed} />
        ))}
      </div>
    </div>
  )
}
