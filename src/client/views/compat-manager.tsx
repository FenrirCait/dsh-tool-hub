/**
 * 官方配套 (official packs): a remote catalog card above the extension list.
 *
 * The package ships no pack. The card reads the published index (compat.index) once when it opens,
 * lists what the catalog offers beside what is installed, and installs or updates one pack — or
 * the whole pending set — only after the owner confirms in the dialog. Nothing here picks a pack
 * on its own, and the host additionally refuses every write without confirm:true.
 *
 * Two derived rules carry the UI:
 *  - compatActionOf is the whole "what can I do" test: no local copy is an install, a local copy
 *    at another version is an update, a matching version has nothing to do;
 *  - compat.index computes installedVersion / enabled / updateAvailable from the live extension
 *    rows, so a cached catalog document never shows a stale install state.
 *
 * Copy is local and bilingual; t() is only used for keys the catalogs already carry, so tracking
 * the official packs adds no i18n entry.
 */
import * as React from 'react'
import { Badge, Button, Callout, Card, Dialog, Switch } from '../components.js'
import { SP } from '../theme.js'
import type { CompatIndex, CompatPackRow, ViewProps } from '../types.js'

// ── the ops this card sends ─────────────────────────────────────────────────

/** The catalog read and the verified install; the switch stays extension.set. */
export const COMPAT = {
  index: 'compat.index',
  install: 'compat.install',
  set: 'extension.set',
} as const

export type CompatAction = 'install' | 'update'

/** One queued action, as the confirmation and the batch runner carry it. */
export interface CompatPending {
  id: string
  action: CompatAction
}

// ── normalising the host's answer ───────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function localizedOf(value: unknown): { zh: string; en: string } | null {
  if (!isRecord(value)) return null
  const zh = text(value.zh).trim()
  const en = text(value.en).trim()
  if (zh === '' && en === '') return null
  return { zh: zh === '' ? en : zh, en: en === '' ? zh : en }
}

function packOf(value: unknown): CompatPackRow | null {
  if (!isRecord(value)) return null
  const id = text(value.id).trim()
  if (id === '') return null
  const name = localizedOf(value.name)
  if (name === null) return null
  const description = localizedOf(value.description)
  return {
    id,
    name,
    version: text(value.version).trim(),
    ...(description === null ? {} : { description }),
    fileCount: typeof value.fileCount === 'number' && Number.isFinite(value.fileCount) ? value.fileCount : 0,
    installedVersion: text(value.installedVersion).trim(),
    installedDir: text(value.installedDir).trim(),
    enabled: value.enabled === true,
    updateAvailable: value.updateAvailable === true,
  }
}

/** The catalog read, narrowed to what the card renders; null when the answer is not a catalog. */
export function indexOf(value: unknown): CompatIndex | null {
  if (!isRecord(value) || !Array.isArray(value.packs)) return null
  const packs: CompatPackRow[] = []
  for (const entry of value.packs) {
    const row = packOf(entry)
    if (row !== null) packs.push(row)
  }
  const source = value.source === 'mirror' || value.source === 'cache' ? value.source : 'index'
  return {
    packs,
    source,
    fetchedAt: text(value.fetchedAt),
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === 'string') : [],
  }
}

// ── the rules, as pure functions ────────────────────────────────────────────

/** No local copy is an install; a copy at another version is an update; equal versions do nothing. */
export function compatActionOf(row: CompatPackRow): CompatAction | null {
  if (row.installedVersion === '') return 'install'
  return row.updateAvailable ? 'update' : null
}

/** Everything one batch press would do, in catalog order. */
export function pendingActions(rows: readonly CompatPackRow[]): CompatPending[] {
  const out: CompatPending[] = []
  for (const row of rows) {
    const action = compatActionOf(row)
    if (action !== null) out.push({ id: row.id, action })
  }
  return out
}

/** The state file's folder, with forward slashes; '' when the path carries no folder. */
function stateFolderOf(statePath: string): string {
  const normalized = statePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const cut = normalized.lastIndexOf('/')
  return cut <= 0 ? '' : normalized.slice(0, cut)
}

/** The folder the host backs a replaced local copy up into, derived from the state file. */
export function backupRootOf(statePath: string): string {
  const folder = stateFolderOf(statePath)
  return folder === '' ? 'backups' : folder + '/backups'
}

/** Where installing this pack lands: the profile extension root the host writes into. */
export function installTargetOf(statePath: string, id: string): string {
  const folder = stateFolderOf(statePath)
  return (folder === '' ? '' : folder + '/') + 'extensions/' + id
}

// ── copy: local, bilingual, no new catalog keys ─────────────────────────────

function zh(lang: ViewProps['lang']): boolean {
  return lang === 'zh'
}

export function cardTitle(lang: ViewProps['lang']): string {
  return zh(lang) ? '官方配套' : 'Official packs'
}

export function cardHint(lang: ViewProps['lang']): string {
  return zh(lang)
    ? '配套从官方索引读取，安装或更新前会校验每个文件的大小和 SHA-256；已有副本先备份再替换。'
    : 'Packs come from the official index. Every file is checked against its size and SHA-256 before anything is written, and an existing copy is backed up before it is replaced.'
}

export function refreshLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '刷新索引' : 'Refresh index'
}

export function loadingLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '正在读取官方索引…' : 'Reading the official index…'
}

export function emptyLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '索引里还没有配套。' : 'The index lists no pack yet.'
}

export function shapeErrorLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '索引读取成功，但返回的内容不是配套目录。' : 'The index was read, but the answer is not a pack catalog.'
}

/** Where the catalog document came from; a cache hit is not a network read. */
export function sourceLabel(lang: ViewProps['lang'], source: CompatIndex['source']): string {
  const name = source === 'mirror'
    ? (zh(lang) ? '镜像' : 'mirror')
    : source === 'cache'
      ? (zh(lang) ? '缓存' : 'cache')
      : (zh(lang) ? '官方索引' : 'index')
  return (zh(lang) ? '来源：' : 'Source: ') + name
}

export function fetchedLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '读取于' : 'Fetched'
}

export function installLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '安装' : 'Install'
}

export function updateLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '更新' : 'Update'
}

export function batchLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '全部安装/更新' : 'Install/update all'
}

export function batchEmptyLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '没有待安装或待更新的配套' : 'Nothing to install or update'
}

export function remoteVersionLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '索引版本' : 'Index version'
}

export function installedVersionLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '已装版本' : 'Installed version'
}

export function targetLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '目标' : 'Target'
}

export function filesLabel(lang: ViewProps['lang'], count: number): string {
  return (zh(lang) ? '文件 ' : 'files ') + String(count)
}

/** The row's install state, in one badge. */
export function statusLabel(lang: ViewProps['lang'], row: CompatPackRow): string {
  if (row.installedVersion === '') return zh(lang) ? '未安装' : 'Not installed'
  if (row.updateAvailable) return zh(lang) ? '可更新' : 'Update available'
  return zh(lang) ? '已安装' : 'Installed'
}

export function statusTone(row: CompatPackRow): 'neutral' | 'on' | 'brand' {
  if (row.installedVersion === '') return 'neutral'
  return row.updateAvailable ? 'brand' : 'on'
}

export function actionLabel(lang: ViewProps['lang'], action: CompatAction): string {
  return action === 'install' ? installLabel(lang) : updateLabel(lang)
}

export function noVersion(lang: ViewProps['lang']): string {
  return zh(lang) ? '—' : '—'
}

/** The install confirmation: download, verify, back up, then write. */
export function installHint(lang: ViewProps['lang'], id: string): string {
  return zh(lang)
    ? '从官方索引安装 ' + id + '：先下载并校验每个文件的大小与 SHA-256，通过后才写入本机扩展目录；已有同名副本会先备份。'
    : 'Installs ' + id + ' from the official index: every file is downloaded and checked against its size and SHA-256 before it is written; an existing copy of the same id is backed up first.'
}

/** The update confirmation: the backup folder first, then the replacement. */
export function updateHint(lang: ViewProps['lang'], id: string, backupRoot: string): string {
  return zh(lang)
    ? '更新 ' + id + '：当前副本先整体备份到 ' + backupRoot + '/extensions-' + id + '-<时间戳>，校验通过后再用索引里的文件替换它。'
    : 'Updates ' + id + ': the current copy is backed up to ' + backupRoot + '/extensions-' + id + '-<stamp> first, then replaced by the verified files from the index.'
}

/** One confirmation for the whole batch, with the count and the same promise. */
export function batchHint(lang: ViewProps['lang'], count: number, backupRoot: string): string {
  return zh(lang)
    ? count + ' 个配套将依次处理：安装直接写入；更新先把当前副本备份到 ' + backupRoot + '，校验通过后再替换。'
    : count + ' pack(s), one after another: installs write directly; updates back the current copy up to ' + backupRoot + ' before the verified files replace it.'
}

export function reportLine(lang: ViewProps['lang'], ok: number, failed: number): string {
  return zh(lang) ? '完成 ' + ok + ' 个，失败 ' + failed + ' 个。' : ok + ' done, ' + failed + ' failed.'
}

/** The name in one language; a missing side falls back to the other, then the id. */
export function packName(row: CompatPackRow, lang: ViewProps['lang']): string {
  const preferred = zh(lang) ? row.name.zh : row.name.en
  const other = zh(lang) ? row.name.en : row.name.zh
  if (preferred !== '') return preferred
  return other !== '' ? other : row.id
}

export function packDescription(row: CompatPackRow, lang: ViewProps['lang']): string {
  if (row.description === undefined) return ''
  const preferred = zh(lang) ? row.description.zh : row.description.en
  const other = zh(lang) ? row.description.en : row.description.zh
  return preferred !== '' ? preferred : other
}

// ── styles: tokens and spacing only, never a literal colour ─────────────────

const BAR: React.CSSProperties = { marginBottom: SP.sm }
const HINT: React.CSSProperties = { marginTop: 0 }
const LIST: React.CSSProperties = { padding: '0 ' + SP.lg + 'px' }
const FOOT: React.CSSProperties = { padding: '0 ' + SP.lg + 'px ' + SP.lg + 'px' }

// ── the card ────────────────────────────────────────────────────────────────

interface CompatProps {
  /** The state file path the snapshot reports; the backup folder is derived from it. */
  statePath: string
  lang: ViewProps['lang']
  t: ViewProps['t']
  runDetailed: ViewProps['runDetailed']
}

interface CompatReport {
  ok: number
  failed: Array<{ id: string; message: string }>
}

/**
 * The card itself. It renders for every installation: with no local extension the catalog is the
 * way to get one, so there is no "no packs" early return.
 */
export function CompatManager(props: CompatProps): React.ReactElement {
  const { statePath, lang, t, runDetailed } = props
  const [index, setIndex] = React.useState<CompatIndex | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [queued, setQueued] = React.useState<CompatPending[] | null>(null)
  const [running, setRunning] = React.useState(false)
  const [report, setReport] = React.useState<CompatReport | null>(null)
  const alive = React.useRef(true)

  const load = (force: boolean): void => {
    setLoading(true)
    setError('')
    void runDetailed(COMPAT.index, force ? { force: true } : {}).then(outcome => {
      if (!alive.current) return
      setLoading(false)
      if (!outcome.ok) {
        setError(outcome.error ?? '')
        return
      }
      const next = indexOf(outcome.data)
      if (next === null) {
        setError(shapeErrorLabel(lang))
        return
      }
      setIndex(next)
    })
  }

  React.useEffect(() => {
    alive.current = true
    // A read on mount only: the catalog is what the card is for. Nothing is installed here.
    load(false)
    return () => {
      alive.current = false
    }
  }, [])

  const packs = index === null ? [] : index.packs
  const pending = pendingActions(packs)
  const backupRoot = backupRootOf(statePath)
  const anyBusy = running || loading

  const runActions = (actions: CompatPending[]): void => {
    setRunning(true)
    setReport(null)
    void (async (): Promise<void> => {
      let ok = 0
      const failed: Array<{ id: string; message: string }> = []
      // Sequential on purpose: every install rewrites one folder and rebuilds the host, and the
      // owner needs the first failure to be reportable before the next action starts.
      for (const action of actions) {
        const outcome = await runDetailed(COMPAT.install, { id: action.id, confirm: true })
        if (outcome.ok) ok += 1
        else failed.push({ id: action.id, message: outcome.error ?? '' })
      }
      if (!alive.current) return
      setRunning(false)
      setReport({ ok, failed })
      // The installed versions moved: re-read the (cached) catalog so the rows follow.
      load(false)
    })()
  }

  const toggle = (row: CompatPackRow, enabled: boolean): void => {
    setReport(null)
    setRunning(true)
    void runDetailed(COMPAT.set, { id: row.id, enabled }).then(outcome => {
      if (!alive.current) return
      setRunning(false)
      setReport(outcome.ok ? { ok: 1, failed: [] } : { ok: 0, failed: [{ id: row.id, message: outcome.error ?? '' }] })
      load(false)
    })
  }

  const only = queued !== null && queued.length === 1 ? queued[0] ?? null : null
  const dialogTitle = queued === null ? '' : only === null ? batchLabel(lang) : actionLabel(lang, only.action)
  const dialogHint = queued === null
    ? ''
    : only === null
      ? batchHint(lang, queued.length, backupRoot)
      : only.action === 'install'
        ? installHint(lang, only.id)
        : updateHint(lang, only.id, backupRoot)

  return (
    <Card label={cardTitle(lang)}>
      <div className="th-toolbar" style={BAR}>
        <span className="th-row-name">{cardTitle(lang)}</span>
        {index === null ? null : <Badge tone="brand">{packs.length}</Badge>}
        <Button variant="ghost" busy={loading} disabled={running} onClick={() => { load(true) }}>
          {refreshLabel(lang)}
        </Button>
        <Button
          variant="primary"
          busy={running}
          disabled={pending.length === 0 || loading}
          title={pending.length === 0 ? batchEmptyLabel(lang) : batchHint(lang, pending.length, backupRoot)}
          onClick={() => {
            setQueued(pending)
          }}
        >
          {batchLabel(lang)}
        </Button>
      </div>
      <p className="th-field-hint" style={HINT}>
        {cardHint(lang)}
      </p>
      {error === '' ? null : <Callout>{error}</Callout>}
      {index === null ? (
        loading ? <p className="th-field-hint" style={LIST}>{loadingLabel(lang)}</p> : null
      ) : (
        <div className="th-list" style={LIST}>
          {packs.length === 0 ? (
            <p className="th-field-hint">{emptyLabel(lang)}</p>
          ) : (
            packs.map(row => {
              const action = compatActionOf(row)
              const name = packName(row, lang)
              const description = packDescription(row, lang)
              const target = row.installedDir !== '' ? row.installedDir : installTargetOf(statePath, row.id)
              return (
                <div className="th-row" key={row.id}>
                  <div className="th-row-body">
                    <span className="th-row-name">{name}</span>
                    <span className="th-row-meta">
                      <span className="th-mono">{row.id}</span>
                      <Badge tone="neutral">{remoteVersionLabel(lang) + ' ' + (row.version === '' ? noVersion(lang) : row.version)}</Badge>
                      <Badge tone="neutral">{installedVersionLabel(lang) + ' ' + (row.installedVersion === '' ? noVersion(lang) : row.installedVersion)}</Badge>
                      <Badge tone={statusTone(row)}>{statusLabel(lang, row)}</Badge>
                      {row.installedVersion === '' ? null : (
                        <Badge tone={row.enabled ? 'on' : 'off'}>
                          {row.enabled ? t('extensions.enabled') : t('extensions.disabled')}
                        </Badge>
                      )}
                      <span className="th-mono" title={targetLabel(lang)}>
                        {target}
                      </span>
                    </span>
                    {description === '' ? null : <span className="th-field-hint">{description}</span>}
                    <span className="th-mono">{filesLabel(lang, row.fileCount)}</span>
                  </div>
                  {action === null ? null : (
                    <Button
                      variant="ghost"
                      busy={running}
                      disabled={anyBusy}
                      title={action === 'install' ? installHint(lang, row.id) : updateHint(lang, row.id, backupRoot)}
                      onClick={() => {
                        setQueued([{ id: row.id, action }])
                      }}
                    >
                      {actionLabel(lang, action)}
                    </Button>
                  )}
                  <Switch
                    checked={row.enabled}
                    busy={running}
                    disabled={row.installedVersion === '' || anyBusy}
                    label={t('a11y.switch', { name })}
                    onChange={next => {
                      toggle(row, next)
                    }}
                  />
                </div>
              )
            })
          )}
        </div>
      )}
      {index === null ? null : (
        <div className="th-row-meta" style={FOOT}>
          <span className="th-mono">{sourceLabel(lang, index.source)}</span>
          {index.fetchedAt === '' ? null : <span className="th-mono">{fetchedLabel(lang) + ' ' + index.fetchedAt}</span>}
        </div>
      )}
      {index === null ? null : index.warnings.map((warning, position) => <Callout key={position}>{warning}</Callout>)}
      {report === null ? null : (
        <div style={FOOT}>
          <div className="th-row-meta">{reportLine(lang, report.ok, report.failed.length)}</div>
          {report.failed.map(item => (
            <Callout key={item.id}>{item.id + ': ' + item.message}</Callout>
          ))}
        </div>
      )}
      <Dialog
        open={queued !== null}
        title={dialogTitle}
        onClose={() => {
          if (!running) setQueued(null)
        }}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={running}
              onClick={() => {
                setQueued(null)
              }}
            >
              {t('action.cancel')}
            </Button>
            <Button
              variant="primary"
              busy={running}
              onClick={() => {
                const actions = queued ?? []
                setQueued(null)
                runActions(actions)
              }}
            >
              {t('action.confirm')}
            </Button>
          </>
        }
      >
        <p className="th-field-hint" style={HINT}>
          {dialogHint}
        </p>
        {queued === null ? null : (
          <div className="th-mono">{queued.map(item => item.id).join(', ')}</div>
        )}
      </Dialog>
    </Card>
  )
}
