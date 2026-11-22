/**
 * 官方配套 (official packs): the packs the plugin package ships under compat/, managed in one
 * card above the extension list.
 *
 * The card is local-only by design. It lists nothing but packs the package ships (a bundled row,
 * or the local copy that shadows one), and it never acts on its own: every install, update and
 * toggle is a button the owner pressed, and an update asks first because it replaces files.
 *
 * Two rules shape the actions, and both come from the host contract:
 *   - `bundledVersion` is the pack's version even when a local copy wins discovery, so comparing
 *     it with the winning row's `version` is the whole "the copy is behind the pack" test;
 *   - installing claims a fresh folder (never overwrites), while updating backs the local copy up
 *     and then overwrites it, so the two live behind different buttons.
 *
 * Copy is local and bilingual, like the other views: the reused keys are the catalog's, and
 * nothing here adds a key to i18n.ts.
 */
import * as React from 'react'
import { Badge, Button, Callout, Card, Dialog, Switch } from '../components.js'
import { SP } from '../theme.js'
import type { ExtensionStatus, ViewProps } from '../types.js'

// ── the ops this card sends ─────────────────────────────────────────────────

/** Install and update are the host's two bundled ops; the switch stays extension.set. */
export const COMPAT = {
  install: 'extension.installBundled',
  update: 'extension.updateBundled',
  set: 'extension.set',
} as const

export type CompatAction = 'install' | 'update'

/** One queued action, as the confirmation and the batch runner carry it. */
export interface CompatPending {
  id: string
  action: CompatAction
}

/** The row fields the rules read; a full ExtensionStatus satisfies it. */
export interface CompatRow {
  id: string
  version?: string
  bundled?: boolean
  overridesBundled?: boolean
  bundledVersion?: string
}

// ── the rules, as pure functions ────────────────────────────────────────────

/** Only packs the package ships: a bundled row, or the local copy that shadows one. */
export function officialPacks<T extends CompatRow>(rows: readonly T[]): T[] {
  return rows.filter(row => row.bundled === true || row.overridesBundled === true)
}

/** The version the package ships for this id; '' when it ships none or the host did not say. */
export function bundledVersionOf(row: CompatRow): string {
  if (typeof row.bundledVersion === 'string' && row.bundledVersion !== '') return row.bundledVersion
  return row.bundled === true && typeof row.version === 'string' ? row.version : ''
}

/** The version of the local copy; '' while there is none. */
export function localVersionOf(row: CompatRow): string {
  if (row.bundled === true) return ''
  return typeof row.version === 'string' ? row.version : ''
}

/**
 * What the card can do to this pack right now.
 *
 * A bundled row has no local copy by construction, so it is an install. A local copy that shadows
 * a pack is an update exactly while the two versions differ; equal versions mean nothing to do.
 */
export function compatActionOf(row: CompatRow): CompatAction | null {
  if (row.bundled === true) return 'install'
  if (row.overridesBundled !== true) return null
  const shipped = bundledVersionOf(row)
  return shipped !== '' && shipped !== localVersionOf(row) ? 'update' : null
}

/** Everything one batch press would do, in snapshot order. */
export function pendingActions(rows: readonly CompatRow[]): CompatPending[] {
  const out: CompatPending[] = []
  for (const row of officialPacks(rows)) {
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

/** The folder the host backs local copies up into, derived from the state file it reports. */
export function backupRootOf(statePath: string): string {
  const folder = stateFolderOf(statePath)
  return folder === '' ? 'backups' : folder + '/backups'
}

/** Where installing this pack would land: the profile extension root the host copies into. */
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
    ? '插件包自带的配套，安装后由本机副本接管；更新会先备份、再覆盖本地副本。'
    : 'Packs that ship with the plugin package. Installing hands one to a local copy; an update backs that copy up before overwriting it.'
}

export function installLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '安装到本地' : 'Install to local'
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

export function bundledVersionLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '配套版本' : 'Pack version'
}

export function localVersionLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '本地版本' : 'Local version'
}

export function targetLabel(lang: ViewProps['lang']): string {
  return zh(lang) ? '目标' : 'Target'
}

/** 插件包 / 本地覆盖: where this row's copy comes from, as the row's status badge. */
export function originLabel(lang: ViewProps['lang'], row: CompatRow): string {
  if (row.overridesBundled === true) return zh(lang) ? '本地覆盖' : 'Local override'
  return zh(lang) ? '插件包' : 'Bundled pack'
}

export function actionLabel(lang: ViewProps['lang'], action: CompatAction): string {
  return action === 'install' ? installLabel(lang) : updateLabel(lang)
}

export function noVersion(lang: ViewProps['lang']): string {
  return zh(lang) ? '—' : '—'
}

/** The install confirmation: it copies and never overwrites, which is the difference to an update. */
export function installHint(lang: ViewProps['lang'], id: string): string {
  return zh(lang)
    ? '把插件包中的 compat/' + id + ' 复制到本机扩展目录，之后由本地副本接管；已有的同名本地副本不会被覆盖。'
    : 'Copies compat/' + id + ' from the plugin package into the local extensions folder; the local copy takes over. An existing local copy is never overwritten.'
}

/** The update confirmation: backup folder first, then overwrite the local copy. */
export function updateHint(lang: ViewProps['lang'], id: string, backupRoot: string): string {
  return zh(lang)
    ? '更新会先用 compat/' + id + ' 覆盖本地副本：当前副本先整体备份到 ' + backupRoot + '/extensions-' + id + '-<时间戳>，再用插件包覆盖本地副本。'
    : 'Updating overwrites the local copy from compat/' + id + ': the current copy is backed up to ' + backupRoot + '/extensions-' + id + '-<stamp> first, then the local copy is overwritten.'
}

/** One confirmation for the whole batch, with the count and the same update promise. */
export function batchHint(lang: ViewProps['lang'], count: number, backupRoot: string): string {
  return zh(lang)
    ? count + ' 个配套将依次处理：安装直接复制；更新先把当前副本备份到 ' + backupRoot + '，再用插件包覆盖本地副本。'
    : count + ' pack(s), one after another: installs copy directly; updates back the current copy up to ' + backupRoot + ' first, then overwrite the local copy.'
}

export function reportLine(lang: ViewProps['lang'], ok: number, failed: number): string {
  return zh(lang) ? '完成 ' + ok + ' 个，失败 ' + failed + ' 个。' : ok + ' done, ' + failed + ' failed.'
}

/** The name in one language; a manifest that lost one side falls back to the other, then the id. */
export function packName(row: ExtensionStatus, lang: ViewProps['lang']): string {
  const preferred = zh(lang) ? row.name.zh : row.name.en
  const other = zh(lang) ? row.name.en : row.name.zh
  if (preferred !== '') return preferred
  return other !== '' ? other : row.id
}

export function packDescription(row: ExtensionStatus, lang: ViewProps['lang']): string {
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
  entries: ExtensionStatus[]
  /** The state file path the snapshot reports; the backup folder is derived from it. */
  statePath: string
  lang: ViewProps['lang']
  t: ViewProps['t']
  busy: string | null
  runDetailed: ViewProps['runDetailed']
}

interface CompatReport {
  ok: number
  failed: Array<{ id: string; message: string }>
}

/**
 * The card itself. It renders nothing when the package ships no pack, so an installation without
 * compat packs never grows an empty section.
 */
export function CompatManager(props: CompatProps): React.ReactElement | null {
  const { entries, statePath, lang, t, busy, runDetailed } = props
  const [queued, setQueued] = React.useState<CompatPending[] | null>(null)
  const [running, setRunning] = React.useState(false)
  const [report, setReport] = React.useState<CompatReport | null>(null)
  const alive = React.useRef(true)

  React.useEffect(() => {
    return () => {
      alive.current = false
    }
  }, [])

  const packs = officialPacks(entries)
  const pending = pendingActions(entries)
  const backupRoot = backupRootOf(statePath)
  const anyBusy = busy !== null || running
  const busyWith = (op: string, id: string): boolean => busy === op + ':' + id

  const runActions = (actions: CompatPending[]): void => {
    setRunning(true)
    setReport(null)
    const step = async (): Promise<void> => {
      let ok = 0
      const failed: Array<{ id: string; message: string }> = []
      // Sequential on purpose: every run rewrites the same folder tree and rebuilds the host, and
      // the owner needs the first failure to be reportable before the next action starts.
      for (const action of actions) {
        const outcome = await runDetailed(action.action === 'install' ? COMPAT.install : COMPAT.update, { id: action.id })
        if (outcome.ok) ok += 1
        else failed.push({ id: action.id, message: outcome.error ?? '' })
      }
      if (!alive.current) return
      setRunning(false)
      setReport({ ok, failed })
    }
    void step()
  }

  const toggle = (entry: ExtensionStatus, enabled: boolean): void => {
    setReport(null)
    setRunning(true)
    void runDetailed(COMPAT.set, { id: entry.id, enabled }).then(outcome => {
      if (!alive.current) return
      setRunning(false)
      setReport(outcome.ok ? { ok: 1, failed: [] } : { ok: 0, failed: [{ id: entry.id, message: outcome.error ?? '' }] })
    })
  }

  if (packs.length === 0) return null

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
        <Badge tone="brand">{packs.length}</Badge>
        <Button
          variant="primary"
          busy={running}
          disabled={pending.length === 0 || busy !== null}
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
      <div className="th-list" style={LIST}>
        {packs.map(entry => {
          const action = compatActionOf(entry)
          const name = packName(entry, lang)
          const description = packDescription(entry, lang)
          // A bundled row installs to the profile root; a local copy is already there.
          const target = entry.bundled === true ? installTargetOf(statePath, entry.id) : entry.dir
          return (
            <div className="th-row" key={entry.id}>
              <div className="th-row-body">
                <span className="th-row-name">{name}</span>
                <span className="th-row-meta">
                  <span className="th-mono">{entry.id}</span>
                  <Badge tone={entry.overridesBundled === true ? 'brand' : 'neutral'}>{originLabel(lang, entry)}</Badge>
                  <Badge tone={entry.enabled ? 'on' : 'off'}>
                    {entry.enabled ? t('extensions.enabled') : t('extensions.disabled')}
                  </Badge>
                  <span className="th-mono">
                    {bundledVersionLabel(lang) + ' ' + (bundledVersionOf(entry) || noVersion(lang))}
                  </span>
                  <span className="th-mono">
                    {localVersionLabel(lang) + ' ' + (localVersionOf(entry) || noVersion(lang))}
                  </span>
                </span>
                {description === '' ? null : <span className="th-field-hint">{description}</span>}
                <span className="th-mono" title={targetLabel(lang)}>
                  {target}
                </span>
              </div>
              {action === 'install' ? (
                <Button
                  variant="ghost"
                  busy={busyWith(COMPAT.install, entry.id)}
                  disabled={anyBusy}
                  title={installHint(lang, entry.id)}
                  onClick={() => {
                    setQueued([{ id: entry.id, action: 'install' }])
                  }}
                >
                  {installLabel(lang)}
                </Button>
              ) : null}
              {action === 'update' ? (
                <Button
                  variant="ghost"
                  busy={busyWith(COMPAT.update, entry.id)}
                  disabled={anyBusy}
                  title={updateHint(lang, entry.id, backupRoot)}
                  onClick={() => {
                    setQueued([{ id: entry.id, action: 'update' }])
                  }}
                >
                  {updateLabel(lang)}
                </Button>
              ) : null}
              <Switch
                checked={entry.enabled}
                busy={busyWith(COMPAT.set, entry.id)}
                disabled={anyBusy}
                label={t('a11y.switch', { name })}
                onChange={next => {
                  toggle(entry, next)
                }}
              />
            </div>
          )
        })}
      </div>
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
