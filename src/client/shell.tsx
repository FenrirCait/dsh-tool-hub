/**
 * The shell: sidebar navigation, topbar, content region.
 *
 * It owns the one snapshot this panel renders and the one place an op is sent from, so a view
 * never fetches. Loading, error and empty are states of the shell; each view renders its own
 * empty copy on top of a good snapshot.
 */
import * as React from 'react'
import { getSnapshot, runOp } from './api.js'
import type { ApiFail } from './api.js'
import { Button, Callout, Loading } from './components.js'
import { createT, detectLang, normalizeLang } from './i18n.js'
import type { Lang } from './i18n.js'
import { installStyles } from './theme.js'
import type { HubSnapshot } from './types.js'
import { McpView } from './views/mcp.js'
import { PluginsView } from './views/plugins.js'
import { ScenesView } from './views/scenes.js'
import { GroupsView } from './views/groups.js'
import { PresetsView } from './views/presets.js'
import { ToolsView } from './views/tools.js'
import { SessionsView } from './views/sessions.js'
import { DiagnosticsView } from './views/diagnostics.js'
import { SettingsView } from './settings/index.js'
import { SkillsView } from './views/skills.js'

export type ViewId = 'plugins' | 'skills' | 'mcp' | 'tools' | 'groups' | 'presets' | 'sessions' | 'scenes' | 'diagnostics' | 'settings'

/** Which surface the slot asked for: the tab, the main area, or the narrow side panel. */
export type ShellSurface = 'tab' | 'main' | 'panel'

export interface ShellProps {
  surface?: ShellSurface
}

type Phase = 'loading' | 'ready' | 'error'

interface Notice {
  tone: 'done' | 'error'
  text: string
}

const LANG_KEY = 'dsh-tool-hub.lang'
const NAV: Array<{ id: ViewId; label: string }> = [
  { id: 'plugins', label: 'nav.plugins' },
  { id: 'skills', label: 'nav.skills' },
  { id: 'mcp', label: 'nav.mcp' },
  { id: 'tools', label: 'nav.tools' },
  { id: 'groups', label: 'nav.groups' },
  { id: 'presets', label: 'nav.presets' },
  { id: 'sessions', label: 'nav.sessions' },
  { id: 'scenes', label: 'nav.scenes' },
  { id: 'diagnostics', label: 'nav.diagnostics' },
  { id: 'settings', label: 'nav.settings' },
]

function readStoredLang(): Lang | null {
  try {
    const stored = window.localStorage.getItem(LANG_KEY)
    return stored === null ? null : normalizeLang(stored)
  } catch {
    return null
  }
}

function storeLang(lang: Lang): void {
  try {
    window.localStorage.setItem(LANG_KEY, lang)
  } catch {
    // A host that blocks storage simply does not remember the choice.
  }
}

function clock(at: number, lang: Lang): string {
  try {
    return new Date(at).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export function Shell(props: ShellProps): React.ReactElement {
  const surface: ShellSurface = props.surface ?? 'main'
  const [lang, setLang] = React.useState<Lang>(() => readStoredLang() ?? detectLang())
  const [view, setView] = React.useState<ViewId>('plugins')
  const [phase, setPhase] = React.useState<Phase>('loading')
  const [snapshot, setSnapshot] = React.useState<HubSnapshot | null>(null)
  const [failure, setFailure] = React.useState<ApiFail | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [notice, setNotice] = React.useState<Notice | null>(null)

  // Settings are the panel's own, not the shell's: language can be forced, density and theme
  // are expressed as attributes on the root so a compact/dark panel still lives in a light shell.
  const storedSettings = snapshot?.settings ?? {}
  const density = storedSettings['settings.appearance.density'] === 'compact' ? 'compact' : 'comfortable'
  const themeValue = storedSettings['settings.appearance.theme']
  const theme = themeValue === 'dark' || themeValue === 'light' ? themeValue : 'system'
  const forcedLang = storedSettings['settings.general.language']
  const effectiveLang: Lang = forcedLang === 'zh' || forcedLang === 'en' ? forcedLang : lang
  const t = React.useMemo(() => createT(effectiveLang), [effectiveLang])

  React.useEffect(() => {
    installStyles()
  }, [])

  const load = React.useCallback(async (silent: boolean) => {
    if (!silent) setPhase(current => (current === 'ready' ? 'ready' : 'loading'))
    const result = await getSnapshot()
    if (!result.ok) {
      setFailure(result)
      setPhase('error')
      return
    }
    setSnapshot(result.data)
    setFailure(null)
    setPhase('ready')
  }, [])

  React.useEffect(() => {
    void load(false)
  }, [load])

  React.useEffect(() => {
    if (notice === null) return undefined
    const timer = setTimeout(() => {
      setNotice(null)
    }, 4000)
    return () => {
      clearTimeout(timer)
    }
  }, [notice])

  const reload = React.useCallback(async () => {
    await load(true)
  }, [load])

  const run = React.useCallback(
    async (op: string, payload?: unknown): Promise<boolean> => {
      const id =
        typeof payload === 'object' && payload !== null && 'id' in payload
          ? String((payload as { id: unknown }).id)
          : null
      setBusy(id === null ? op : `${op}:${id}`)
      setNotice(null)
      const result = await runOp(op, payload)
      if (!result.ok) {
        setBusy(null)
        setNotice({ tone: 'error', text: t('error.unknown', { message: result.message }) })
        return false
      }
      await load(true)
      setBusy(null)
      setNotice({ tone: 'done', text: t('notice.done') })
      return true
    },
    [load, t],
  )

  const refresh = React.useCallback(() => {
    setRefreshing(true)
    void load(true).finally(() => {
      setRefreshing(false)
    })
  }, [load])

  const toggleLang = React.useCallback(() => {
    setLang(current => {
      const next: Lang = current === 'zh' ? 'en' : 'zh'
      storeLang(next)
      return next
    })
  }, [])

  const counts: Record<ViewId, number> = {
    plugins: snapshot === null ? 0 : snapshot.plugins.length,
    skills: snapshot === null ? 0 : snapshot.skills.length,
    mcp: snapshot === null ? 0 : snapshot.plugins.filter(row => row.mcp === true).length,
    tools: snapshot === null ? 0 : snapshot.tools.length,
    groups: snapshot === null ? 0 : snapshot.groups.length,
    presets: snapshot === null ? 0 : Object.keys(snapshot.presets).length,
    sessions: snapshot === null ? 0 : Object.keys(snapshot.sessions).length,
    scenes: snapshot === null ? 0 : snapshot.scene.names.length,
    diagnostics: snapshot === null ? 0 : snapshot.history.filter(entry => !entry.ok).length,
    settings: snapshot === null ? 0 : snapshot.settingsSchema.length,
  }

  const views: Record<ViewId, React.ReactElement> =
    snapshot === null
      ? { plugins: <div />, skills: <div />, mcp: <div />, tools: <div />, groups: <div />, presets: <div />, sessions: <div />, scenes: <div />, diagnostics: <div />, settings: <div /> }
      : {
          plugins: <PluginsView snapshot={snapshot} lang={effectiveLang} t={t} busy={busy} run={run} reload={reload} />,
          skills: <SkillsView snapshot={snapshot} lang={effectiveLang} t={t} busy={busy} run={run} reload={reload} />,
          mcp: <McpView snapshot={snapshot} lang={effectiveLang} t={t} busy={busy} run={run} reload={reload} />,
          tools: <ToolsView snapshot={snapshot} lang={effectiveLang} t={t} busy={busy} run={run} reload={reload} />,
          groups: <GroupsView snapshot={snapshot} lang={effectiveLang} t={t} busy={busy} run={run} reload={reload} />,
          presets: <PresetsView snapshot={snapshot} lang={effectiveLang} t={t} busy={busy} run={run} reload={reload} />,
          sessions: <SessionsView snapshot={snapshot} lang={effectiveLang} t={t} busy={busy} run={run} reload={reload} />,
          scenes: <ScenesView snapshot={snapshot} lang={effectiveLang} t={t} busy={busy} run={run} reload={reload} />,
          diagnostics: <DiagnosticsView snapshot={snapshot} lang={effectiveLang} t={t} busy={busy} run={run} reload={reload} />,
          settings: <SettingsView snapshot={snapshot} lang={effectiveLang} t={t} busy={busy} run={run} reload={reload} />,
        }

  const statusLine =
    busy !== null ? (
      <span>{t('state.busy')}</span>
    ) : phase === 'ready' && snapshot !== null ? (
      <span>{t('top.updated', { time: clock(snapshot.fetchedAt, effectiveLang) })}</span>
    ) : phase === 'error' ? (
      <span>{t('state.error')}</span>
    ) : (
      <span>{t('state.loading')}</span>
    )

  const nav = (
    <nav className="th-side" role="navigation" aria-label={t('a11y.nav')}>
      <div className="th-side-brand">
        <span className="th-dot" aria-hidden="true" />
        <span>{t('app.brand')}</span>
      </div>
      {NAV.map(item => (
        <button
          key={item.id}
          type="button"
          className="th-navitem"
          aria-current={view === item.id ? 'page' : undefined}
          onClick={() => {
            setView(item.id)
          }}
        >
          <span>{t(item.label)}</span>
          <span className="th-navcount">{counts[item.id]}</span>
        </button>
      ))}
      <div style={{ marginTop: 'auto', padding: '10px 10px 2px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.78))' }} aria-live="polite">
        {statusLine}
      </div>
    </nav>
  )

  if (surface === 'panel') {
    return (
      <div className="th-root" role="region" aria-label={t('app.title')} data-th-theme={theme} data-th-density={density}>
        {nav}
        <div className="th-main">
          <div className="th-top">
            <span className="th-top-title">{t('app.title')}</span>
            <div className="th-top-actions">
              {forcedLang === 'zh' || forcedLang === 'en' ? null : (
                <Button variant="ghost" onClick={toggleLang} label={t('top.lang')}>
                  {lang === 'zh' ? 'EN' : '中文'}
                </Button>
              )}
              <Button variant="ghost" onClick={refresh} busy={refreshing} label={t('top.refresh')}>
                {refreshing ? t('top.refreshing') : t('top.refresh')}
              </Button>
            </div>
          </div>
          <div className="th-content">
            {failure === null ? null : (
              <Callout action={<Button variant="ghost" onClick={refresh}>{t('action.retry')}</Button>}>
                {t('error.unknown', { message: failure.message })}
              </Callout>
            )}
            <div className="th-list">
              {snapshot === null ? <Loading label={t('state.loading')} rows={2} /> : null}
              {snapshot !== null
                ? NAV.map(item => (
                    <div className="th-row" key={item.id}>
                      <div className="th-row-body">
                        <span className="th-row-name">{t(item.label)}</span>
                      </div>
                      <span className="th-navcount">{counts[item.id]}</span>
                    </div>
                  ))
                : null}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="th-root" data-th-theme={theme} data-th-density={density}>
      {nav}
      <div className="th-main">
        <header className="th-top">
          <span className="th-top-title">{t('app.title')}</span>
          <span className="th-top-sub" title={snapshot?.paths.home ?? undefined}>
            {snapshot?.paths.home !== undefined && snapshot.paths.home !== '' ? snapshot.paths.home : t('app.subtitle')}
          </span>
          <div className="th-top-actions">
            {forcedLang === 'zh' || forcedLang === 'en' ? null : (
              <Button variant="ghost" onClick={toggleLang} label={t('top.lang')}>
                {lang === 'zh' ? 'EN' : '中文'}
              </Button>
            )}
            <Button onClick={refresh} busy={refreshing} label={t('top.refresh')}>
              {refreshing ? t('top.refreshing') : t('top.refresh')}
            </Button>
          </div>
        </header>
        <div className="th-content" role="region" aria-label={t('a11y.content')} aria-live="polite">
          {notice === null ? null : <Callout tone={notice.tone === 'error' ? 'error' : 'info'}>{notice.text}</Callout>}
          {phase === 'error' && failure !== null ? (
            <Callout
              action={
                <Button variant="ghost" onClick={refresh}>
                  {t('action.retry')}
                </Button>
              }
            >
              {t('error.unknown', { message: failure.message })}
            </Callout>
          ) : null}
          {phase === 'loading' && snapshot === null ? <Loading label={t('state.loading')} /> : null}
          {phase === 'ready' && failure === null ? views[view] : null}
        </div>
      </div>
    </div>
  )
}
