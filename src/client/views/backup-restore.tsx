/**
 * Restore one MCP row from a backup, with the diff on screen before anything is written.
 *
 * The flow is read, read, confirm, write: backup.mcpIndex says which backups hold row ids,
 * backup.diff shows what restoring would change, and only then does backup.restoreRow run. The
 * restore button stays disabled until a diff has been loaded and the operator ticked the box,
 * because that write overwrites the row in the live profile patch. Reads go through runOp (the
 * panel needs the host's answer, not just success); the restore is a write through run, and the
 * snapshot is re-read afterwards so every view sees the row the host now serves.
 */
import * as React from 'react'
import { runOp } from '../api.js'
import { Badge, Button, Callout, Dialog, Empty, Field, Select } from '../components.js'
import type { Lang, TFunction } from '../i18n.js'
import { FONT, MONO, R, SP, T } from '../theme.js'
import type { RunOp } from '../types.js'

/** The three ops this dialog sends, in one table so a host rename stays a one-line change. */
const RESTORE_OPS = {
  index: 'backup.mcpIndex',
  diff: 'backup.diff',
  restore: 'backup.restoreRow',
} as const

interface BackupRowRef {
  id: string
  occurrence: number
  name: string
}

interface BackupEntry {
  name: string
  kind: string
  bytes: number
  modifiedAt: number
  rows: BackupRowRef[]
}

/** A JSON key keeps duplicate ids apart in the picker without relying on a reserved separator. */
function rowKeyOf(row: BackupRowRef): string {
  return JSON.stringify([row.id, row.occurrence])
}

function rowRefOf(key: string): BackupRowRef {
  try {
    const parsed = JSON.parse(key) as unknown
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      const occurrence = Number(parsed[1])
      return { id: parsed[0], occurrence: Number.isInteger(occurrence) && occurrence >= 0 ? occurrence : 0, name: '' }
    }
  }
  catch {
    /* a hand-typed id is not JSON */
  }
  return { id: key, occurrence: 0, name: key }
}

type DiffKind = 'same' | 'add' | 'del'

interface DiffLine {
  kind: DiffKind
  text: string
}

interface RowDiff {
  backup: string
  id: string
  changed: boolean
  before: string | null
  after: string | null
  lines: DiffLine[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** A host answer that is missing rows still yields a usable list: only entries with a name survive. */
function indexOf(value: unknown): BackupEntry[] {
  const rows = asRecord(value).backups
  if (!Array.isArray(rows)) return []
  return rows.map(item => asRecord(item)).filter(item => typeof item.name === 'string').map(item => ({
    name: String(item.name),
    kind: typeof item.kind === 'string' ? item.kind : '',
    bytes: typeof item.bytes === 'number' ? item.bytes : 0,
    modifiedAt: typeof item.modifiedAt === 'number' ? item.modifiedAt : 0,
    rows: Array.isArray(item.rows)
      ? item.rows.map(ref => asRecord(ref)).filter(ref => typeof ref.id === 'string').map(ref => ({
          id: String(ref.id),
          occurrence: typeof ref.occurrence === 'number' && Number.isInteger(ref.occurrence) && ref.occurrence >= 0 ? ref.occurrence : 0,
          name: typeof ref.name === 'string' ? ref.name : String(ref.id),
        }))
      : asStrings(item.ids).map(id => ({ id, occurrence: 0, name: id })),
  }))
}

const DIFF_KINDS = new Set<DiffKind>(['same', 'add', 'del'])

/** Diff lines are normalised to the three kinds the host documents; anything else reads as same. */
function diffOf(value: unknown): RowDiff {
  const record = asRecord(value)
  const rows = Array.isArray(record.lines) ? record.lines : []
  const lines = rows.map(item => asRecord(item)).map(item => ({
    kind: DIFF_KINDS.has(item.kind as DiffKind) ? item.kind as DiffKind : 'same' as DiffKind,
    text: typeof item.text === 'string' ? item.text : '',
  }))
  return {
    backup: typeof record.backup === 'string' ? record.backup : '',
    id: typeof record.id === 'string' ? record.id : '',
    changed: record.changed === true,
    before: typeof record.before === 'string' ? record.before : null,
    after: typeof record.after === 'string' ? record.after : null,
    lines,
  }
}

/** Copy that is not a catalog key: one sentence in both languages, chosen by the view. */
function copy(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

/** Kind to a token. The diff never picks its own colour, so light and dark both follow the host. */
function toneOf(kind: DiffKind): string {
  if (kind === 'add') return T.success
  if (kind === 'del') return T.danger
  return T.text3
}

/** Kind to the one-character gutter a patch reader expects. */
function markOf(kind: DiffKind): string {
  if (kind === 'add') return '+'
  if (kind === 'del') return '-'
  return '\u00b7'
}

const STACK: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: SP.md }
const ACTIONS: React.CSSProperties = { display: 'flex', gap: SP.sm, alignItems: 'center', flexWrap: 'wrap' }
const DIFF_BOX: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  maxHeight: 260,
  overflow: 'auto',
  padding: SP.md,
  border: '1px solid ' + T.borderSoft,
  borderRadius: R.sm,
  background: T.surface,
}
const DIFF_LINE: React.CSSProperties = {
  display: 'flex',
  gap: SP.sm,
  fontFamily: MONO,
  fontSize: FONT.xs,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

export interface BackupRestoreProps {
  open: boolean
  lang: Lang
  t: TFunction
  busy: string | null
  run: RunOp
  reload: () => Promise<void>
  onClose: () => void
  /** Fired after a successful restore, so the card can report it and refresh its own list. */
  onRestored: () => void
}

export function BackupRestoreDialog(props: BackupRestoreProps): React.ReactElement {
  const { open, lang, t, busy, run, reload, onClose, onRestored } = props
  const [loading, setLoading] = React.useState(false)
  const [indexError, setIndexError] = React.useState('')
  const [entries, setEntries] = React.useState<BackupEntry[]>([])
  const [backup, setBackup] = React.useState('')
  const [row, setRow] = React.useState('')
  const [diff, setDiff] = React.useState<RowDiff | null>(null)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [diffError, setDiffError] = React.useState('')
  const [confirmed, setConfirmed] = React.useState(false)
  const [restored, setRestored] = React.useState(false)

  /** Read the index. Opening the dialog always starts from a clean slate. */
  const load = React.useCallback(() => {
    setLoading(true)
    setIndexError('')
    setDiff(null)
    setDiffError('')
    setConfirmed(false)
    setRestored(false)
    void runOp(RESTORE_OPS.index, {}).then(result => {
      setLoading(false)
      if (!result.ok) {
        setEntries([])
        setBackup('')
        setRow('')
        setIndexError(result.message)
        return
      }
      const next = indexOf(result.data)
      const first = next[0]
      setEntries(next)
      setBackup(first === undefined ? '' : first.name)
      setRow(first === undefined || first.rows[0] === undefined ? '' : rowKeyOf(first.rows[0]))
    })
  }, [])

  React.useEffect(() => {
    if (open) load()
  }, [open, load])

  const entry = entries.find(item => item.name === backup) ?? null
  const rows = entry === null ? [] : entry.rows
  const canRestore = diff !== null && confirmed && backup !== '' && row !== ''
  const restoreBusy = RESTORE_OPS.restore + ':' + row
  /** A pair cannot be swapped mid-write: the payload already sent names the old backup and row. */
  const writing = busy !== null && busy.startsWith(RESTORE_OPS.restore)

  /** A new backup means a new id list, and any diff already read belongs to the old pair. */
  const resetDiff = (): void => {
    setDiff(null)
    setDiffError('')
    setConfirmed(false)
    setRestored(false)
  }

  const pickBackup = (name: string): void => {
    const next = entries.find(item => item.name === name) ?? null
    setBackup(name)
    setRow(next === null || next.rows[0] === undefined ? '' : rowKeyOf(next.rows[0]))
    resetDiff()
  }

  const pickRow = (next: string): void => {
    setRow(next)
    resetDiff()
  }

  const readDiff = (): void => {
    if (backup === '' || row === '') return
    setDiffLoading(true)
    setDiffError('')
    setConfirmed(false)
    setRestored(false)
    void runOp(RESTORE_OPS.diff, { backup, id: row }).then(result => {
      setDiffLoading(false)
      if (!result.ok) {
        setDiff(null)
        setDiffError(result.message)
        return
      }
      setDiff(diffOf(result.data))
    })
  }

  /** The only write in this dialog: it cannot run without a diff on screen and a ticked box. */
  const restore = (): void => {
    if (!canRestore || writing) return
    const target = rowRefOf(row)
    void run(RESTORE_OPS.restore, { backup, id: target.id, occurrence: target.occurrence }).then(async ok => {
      if (!ok) return
      await reload()
      setConfirmed(false)
      setDiff(null)
      setRestored(true)
      onRestored()
    })
  }

  const picker = (): React.ReactElement => (
    <>
      <Field id="th-restore-backup" label={t('backup.restorePick')}>
        <Select
          id="th-restore-backup"
          value={backup}
          options={entries.map(item => ({ value: item.name, label: item.name }))}
          label={t('backup.restorePick')}
          disabled={writing}
          onChange={pickBackup}
        />
      </Field>
      <Field
        id="th-restore-row"
        label={copy(lang, '行 id', 'Row id')}
        hint={copy(lang, '这份备份里记录的 MCP 行。', 'An MCP row this backup holds.')}
      >
        {rows.length === 0 ? (
          <input
            id="th-restore-row"
            className="th-input"
            type="text"
            value={row}
            spellCheck={false}
            disabled={writing}
            aria-label={copy(lang, '行 id', 'Row id')}
            placeholder={copy(lang, '手动输入行 id', 'Type a row id')}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              pickRow(event.target.value)
            }}
          />
        ) : (
          <Select
            id="th-restore-row"
            value={row}
            options={rows.map(ref => ({ value: rowKeyOf(ref), label: ref.name + (ref.occurrence === 0 ? '' : ' (' + String(ref.occurrence + 1) + ')') }))}
            label={copy(lang, '行 id', 'Row id')}
            disabled={writing}
            onChange={pickRow}
          />
        )}
      </Field>
      <div style={ACTIONS}>
        <Button variant="ghost" busy={diffLoading} disabled={backup === '' || row === '' || writing} onClick={readDiff}>
          {t('backup.restoreDiff')}
        </Button>
        {diff === null ? null : (
          <Badge tone={diff.changed ? 'warn' : 'on'}>
            {diff.changed ? copy(lang, '有改动', 'changed') : copy(lang, '与备份一致', 'already matches')}
          </Badge>
        )}
      </div>
      {diffError === '' ? null : <Callout action={<Button variant="ghost" onClick={readDiff}>{t('action.retry')}</Button>}>{diffError}</Callout>}
      {diff === null ? null : (
        <div
          style={DIFF_BOX}
          role="region"
          aria-label={t('backup.restoreDiff')}
          aria-busy={diffLoading}
        >
          <div className="th-row-meta">
            <span className="th-mono">{diff.backup}</span> · <span className="th-mono">{diff.id}</span>
          </div>
          {diff.lines.length === 0 ? (
            <span className="th-field-hint">{copy(lang, '没有可显示的差异。', 'No diff lines to show.')}</span>
          ) : (
            diff.lines.map((line, position) => (
              <div key={position} style={{ ...DIFF_LINE, color: toneOf(line.kind) }}>
                <span aria-hidden="true">{markOf(line.kind)}</span>
                <span>{line.text === '' ? ' ' : line.text}</span>
              </div>
            ))
          )}
        </div>
      )}
      {diff === null ? null : (
        <Field id="th-restore-confirm" label={t('backup.restoreConfirm')}>
          <input
            id="th-restore-confirm"
            type="checkbox"
            checked={confirmed}
            aria-label={t('backup.restoreConfirm')}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              setConfirmed(event.target.checked)
            }}
          />
        </Field>
      )}
    </>
  )

  return (
    <Dialog
      open={open}
      title={t('backup.restoreTitle')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{restored ? t('action.close') : t('action.cancel')}</Button>
          <Button variant="primary" disabled={!canRestore || writing} busy={busy === restoreBusy} onClick={restore}>
            {t('backup.restore')}
          </Button>
        </>
      }
    >
      <div style={STACK} aria-busy={loading}>
        {indexError === '' ? null : (
          <Callout action={<Button variant="ghost" onClick={load}>{t('action.retry')}</Button>}>{indexError}</Callout>
        )}
        {restored ? <Callout tone="info">{t('backup.restoreDone')}</Callout> : null}
        {loading ? (
          <span className="th-field-hint" role="status">{t('backup.loading')}</span>
        ) : null}
        {!loading && indexError === '' && entries.length === 0 ? (
          <Empty title={t('backup.restoreEmpty')} hint={t('backup.emptyHint')} />
        ) : null}
        {!loading && entries.length > 0 ? picker() : null}
      </div>
    </Dialog>
  )
}