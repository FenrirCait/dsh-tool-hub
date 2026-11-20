/**
 * Config: the four portable sections, out and back in.
 *
 * The export is a read (runOp), because run() reports success rather than its payload and the
 * JSON itself is what this page renders. The import is a write through run(): the shell owns
 * busy and the failure notice, so the summary under the form is derived from the bundle and the
 * groups the snapshot held before the write instead of from a response the shell discards.
 *
 * Replace is the only destructive path: it sits behind a Dialog confirmation with the exact
 * counts that will be dropped, and merge stays the default so a mis-click adds rather than wipes.
 * The config domain refuses a replace without confirm:true, so the dialog's answer travels in
 * that flag instead of prompting the host a second time.
 */
import * as React from 'react'
import { runOp } from '../api.js'
import { Badge, Button, Callout, Card, Dialog, Empty, Field, Loading, Select, Toolbar, monoStyle } from '../components.js'
import type { ViewProps } from '../types.js'

/** Op ids this view sends; the config domain owns their payloads. */
const EXPORT = 'config.export'
const IMPORT = 'config.import'

const EXPORT_BOX_ID = 'th-config-export'
const PASTE_ID = 'th-config-paste'
const FILE_ID = 'th-config-file'
const MODE_ID = 'th-config-mode'

const BOX: React.CSSProperties = { ...monoStyle, width: '100%', resize: 'vertical' }

type Mode = 'merge' | 'replace'

/** The four sections a bundle carries; nothing here names a credential or a path. */
interface BundleData {
  groups?: unknown
  collections?: unknown
  presets?: unknown
  toolDeny?: unknown
}

interface Counts {
  groups: number
  collections: number
  presets: number
  deny: number
}

/** One parsed import: the object to send, its counts, and the group identities the preview saw. */
interface Parsed {
  bundle: unknown
  counts: Counts
  groups: Array<{ id: string; name: string }>
}

/** What the summary line reports after a successful write. */
interface Imported {
  added: number
  merged: number
}

/** A form caption that is not a catalog noun is bilingual here. */
function copy(lang: ViewProps['lang'], zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Presets travel as an object keyed by name in 2.0 and as a list in a 1.x file. */
function presetCount(value: unknown): number {
  if (Array.isArray(value)) return value.length
  return typeof value === 'object' && value !== null ? Object.keys(value).length : 0
}

/**
 * The sections of one bundle, or null when the value carries none of them. The 2.0 export wraps
 * them in data ({ kind, version, exportedAt, data }); a hand-written or 1.x file keeps them at
 * the top level, and both are accepted so a bundle can be pasted either way.
 */
function dataOf(value: unknown): BundleData | null {
  const record = asRecord(value)
  const nested = asRecord(record.data)
  const source = Object.keys(nested).length > 0 ? nested : record
  const sections = ['groups', 'collections', 'presets', 'toolDeny']
  const present = sections.some(key => source[key] !== undefined && source[key] !== null)
  return present ? (source as BundleData) : null
}

/**
 * Parse one pasted or loaded bundle and count what it would import. A wrong shape is rejected
 * here rather than at the host, so the preview never promises counts the write cannot honour.
 */
function parseBundle(text: string): Parsed | null {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return null
  }
  const data = dataOf(value)
  if (data === null) return null
  for (const key of ['groups', 'collections', 'toolDeny'] as const) {
    if (data[key] !== undefined && !Array.isArray(data[key])) return null
  }
  if (data.presets !== undefined && (typeof data.presets !== 'object' || data.presets === null)) return null
  const groups = listOf(data.groups).flatMap(entry => {
    const row = asRecord(entry)
    const id = typeof row.id === 'string' ? row.id : ''
    const name = typeof row.name === 'string' ? row.name : id
    return id === '' && name === '' ? [] : [{ id, name }]
  })
  return {
    bundle: value,
    counts: {
      groups: groups.length,
      collections: listOf(data.collections).length,
      presets: presetCount(data.presets),
      deny: listOf(data.toolDeny).length,
    },
    groups,
  }
}

/** The JSON to show and download: a 1.x host answers { json }, the 2.0 host answers the bundle. */
function exportTextOf(value: unknown): string {
  const record = asRecord(value)
  if (typeof record.json === 'string') return record.json
  return JSON.stringify(value, null, 2)
}

/** A stable, filesystem-safe stamp; exportedAt when the host sent one, else now. */
function stampOf(value: unknown): string {
  const at = asRecord(value).exportedAt
  const cleaned = typeof at === 'string' ? at.replace(/[^0-9A-Za-z]/g, '-').replace(/-+$/, '') : ''
  return cleaned === '' ? String(Date.now()) : cleaned
}

/** Hand the text to the browser as a download; false when this host has no Blob/URL support. */
function download(name: string, text: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Give the browser a tick to start the download before the blob goes away.
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
  return true
}

/** File.text() when the runtime has it; FileReader otherwise, so an older host still reads a file. */
function readFile(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(typeof reader.result === 'string' ? reader.result : '') }
    reader.onerror = () => { reject(new Error('unreadable')) }
    reader.readAsText(file)
  })
}

export function ConfigView(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run } = props
  const [exportText, setExportText] = React.useState('')
  const [exported, setExported] = React.useState<unknown>(null)
  const [exportError, setExportError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [importText, setImportText] = React.useState('')
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [downloadError, setDownloadError] = React.useState(false)
  const [mode, setMode] = React.useState<Mode>('merge')
  const [pending, setPending] = React.useState<Parsed | null>(null)
  const [result, setResult] = React.useState<Imported | null>(null)

  const loadExport = React.useCallback(async () => {
    setLoading(true)
    setExportError(null)
    const answer = await runOp(EXPORT, {})
    setLoading(false)
    if (!answer.ok) {
      setExportText('')
      setExported(null)
      setExportError(answer.message)
      return
    }
    setExportText(exportTextOf(answer.data))
    setExported(answer.data)
  }, [])

  React.useEffect(() => {
    void loadExport()
  }, [loadExport])

  // Paste and file both write importText, so one memo covers both and the preview cannot drift.
  const parsed = React.useMemo(() => (importText.trim() === '' ? null : parseBundle(importText)), [importText])
  const invalid = importText.trim() !== '' && parsed === null

  // Merge appends a group only when neither its id nor its name exists; the rest merge in place.
  const before = React.useMemo(() => {
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const group of snapshot.groups) {
      ids.add(group.id)
      names.add(group.name)
    }
    return { ids, names }
  }, [snapshot.groups])

  const apply = React.useCallback((target: Parsed, how: Mode) => {
    const added = target.groups.filter(group => !before.ids.has(group.id) && !before.names.has(group.name)).length
    setResult(null)
    // Only replace needs the host's confirm gate; the dialog already asked, so the flag is the answer.
    const payload = how === 'replace'
      ? { bundle: target.bundle, mode: how, confirm: true }
      : { bundle: target.bundle, mode: how }
    void run(IMPORT, payload).then(ok => {
      if (!ok) return
      setResult({ added, merged: target.counts.groups - added })
      setImportText('')
      setFileError(null)
      void loadExport()
    })
  }, [before, loadExport, run])

  const askReplace = React.useCallback(() => {
    if (parsed !== null) setPending(parsed)
  }, [parsed])

  const close = React.useCallback(() => {
    setPending(null)
  }, [])

  const confirm = React.useCallback(() => {
    if (pending === null) return
    setPending(null)
    apply(pending, 'replace')
  }, [apply, pending])

  const onFile = React.useCallback((file: File | null) => {
    if (file === null) return
    setFileError(null)
    setResult(null)
    void readFile(file).then(text => {
      setImportText(text)
    }).catch(() => {
      setFileError(copy(lang, '这个文件读不出来。', 'That file could not be read.'))
    })
  }, [lang])

  const save = React.useCallback(() => {
    setDownloadError(!download(`dsh-tool-hub-config-${stampOf(exported)}.json`, exportText))
  }, [exportText, exported])

  return (
    <div>
      <div className="th-section-title">{t('config.title')}</div>

      <div className="th-section">
        <div className="th-section-title">{t('config.export')}</div>
        <Card label={t('config.export')}>
          <Toolbar>
            <Button variant="ghost" busy={loading} onClick={() => { void loadExport() }}>
              {t('config.export')}
            </Button>
            <Button variant="primary" disabled={exportText === ''} onClick={save}>
              {t('config.download')}
            </Button>
            {exportText === '' ? null : (
              <span className="th-field-hint">{t('config.exported')}</span>
            )}
          </Toolbar>
          {exportError === null ? null : (
            <Callout
              action={
                <Button variant="ghost" onClick={() => { void loadExport() }}>
                  {t('action.retry')}
                </Button>
              }
            >
              {exportError}
            </Callout>
          )}
          {downloadError ? (
            <Callout>{copy(lang, '这个宿主不支持浏览器下载。', 'This host cannot save files from the browser.')}</Callout>
          ) : null}
          {exportText !== '' ? (
            <Field id={EXPORT_BOX_ID} label={t('config.export')} hint={t('config.exportHint')}>
              <textarea
                id={EXPORT_BOX_ID}
                className="th-input"
                style={BOX}
                rows={10}
                readOnly
                spellCheck={false}
                value={exportText}
                aria-label={t('config.export')}
              />
            </Field>
          ) : loading ? (
            <Loading label={t('state.loading')} rows={2} />
          ) : (
            <Empty
              title={t('config.empty')}
              hint={t('config.exportHint')}
              action={
                <Button variant="ghost" onClick={() => { void loadExport() }}>
                  {t('action.retry')}
                </Button>
              }
            />
          )}
        </Card>
      </div>

      <div className="th-section">
        <div className="th-section-title">{t('config.import')}</div>
        <Card label={t('config.import')}>
          <Field id={PASTE_ID} label={t('config.paste')} hint={t('config.importHint')}>
            <textarea
              id={PASTE_ID}
              className="th-input"
              style={BOX}
              rows={8}
              spellCheck={false}
              value={importText}
              placeholder={t('config.importHint')}
              aria-label={t('config.paste')}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                setImportText(event.target.value)
                setResult(null)
              }}
            />
          </Field>
          <Toolbar>
            <label className="th-btn th-btn--ghost" htmlFor={FILE_ID}>
              {t('config.pickFile')}
            </label>
            <input
              id={FILE_ID}
              className="th-visually-hidden"
              type="file"
              accept=".json,application/json"
              aria-label={t('config.pickFile')}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                onFile(event.target.files?.[0] ?? null)
                event.target.value = ''
              }}
            />
            {importText === '' ? null : (
              <Button variant="ghost" onClick={() => { setImportText(''); setFileError(null); setResult(null) }}>
                {t('action.clear')}
              </Button>
            )}
          </Toolbar>
          {fileError === null ? null : <Callout>{fileError}</Callout>}
          {invalid ? <Callout>{t('config.invalid')}</Callout> : null}
          {parsed === null ? null : (
            <div className="th-row">
              <div className="th-row-body">
                <span className="th-row-name">
                  {t('config.preview', {
                    groups: parsed.counts.groups,
                    collections: parsed.counts.collections,
                    presets: parsed.counts.presets,
                    deny: parsed.counts.deny,
                  })}
                </span>
              </div>
              <Badge tone={mode === 'replace' ? 'danger' : 'brand'}>
                {mode === 'replace' ? t('config.replace') : t('config.merge')}
              </Badge>
            </div>
          )}
          <Field id={MODE_ID} label={t('config.mode')}>
            <Select
              id={MODE_ID}
              value={mode}
              label={t('config.mode')}
              options={[
                { value: 'merge', label: t('config.merge') },
                { value: 'replace', label: t('config.replace') },
              ]}
              onChange={next => { setMode(next === 'replace' ? 'replace' : 'merge') }}
            />
          </Field>
          {mode === 'replace' ? <Callout tone="info">{t('config.replaceWarn')}</Callout> : null}
          <Toolbar>
            <Button
              variant={mode === 'replace' ? 'danger' : 'primary'}
              disabled={parsed === null}
              busy={busy === IMPORT}
              onClick={() => {
                if (parsed === null) return
                if (mode === 'replace') askReplace()
                else apply(parsed, 'merge')
              }}
            >
              {t('config.apply')}
            </Button>
          </Toolbar>
          {result === null ? null : (
            <Callout tone="info">{t('config.result', { groups: result.added, merged: result.merged })}</Callout>
          )}
        </Card>
      </div>

      <Dialog
        open={pending !== null}
        title={t('dialog.confirmTitle')}
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              {t('action.cancel')}
            </Button>
            <Button variant="danger" busy={busy === IMPORT} onClick={confirm}>
              {t('action.confirm')}
            </Button>
          </>
        }
      >
        {pending === null ? '' : (
          <>
            <div>{t('config.replaceWarn')}</div>
            <div className="th-field-hint">
              {t('config.preview', {
                groups: pending.counts.groups,
                collections: pending.counts.collections,
                presets: pending.counts.presets,
                deny: pending.counts.deny,
              })}
            </div>
          </>
        )}
      </Dialog>
    </div>
  )
}
