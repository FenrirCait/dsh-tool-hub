/**
 * Tools: the installation mask, the merged-surface plan, and the lazy servers.
 *
 * A row switch only edits a draft of the installation deny list; nothing is written until Save
 * collects a confirmation, because tool.save replaces the whole list. tool.plan is the read-only
 * report the view renders next to that draft. A lazy server keeps its own switch (lazy.set) plus
 * load/unload of every tool the server exposes.
 *
 * Every write travels through props.run so the shell owns busy and the error notice. tool.plan is
 * the one exception: run() reports success, not its payload, and the report is what the view
 * renders; the call is read-only and never changes the snapshot.
 */
import * as React from 'react'
import { runOp } from '../api.js'
import { Badge, Button, Callout, Card, Dialog, Empty, SearchBox, Switch, Toolbar } from '../components.js'
import type { ToolRow, ViewProps } from '../types.js'

/** Op ids this view sends; the tool-surface domain owns their payloads. */
const SAVE = 'tool.save'
const PLAN = 'tool.plan'
const LAZY_SET = 'lazy.set'
const LAZY_LOAD = 'lazy.load'
const LAZY_UNLOAD = 'lazy.unload'

/** The merge sources in the order tool-surface reports them. */
const SOURCES = ['install', 'session', 'lazy', 'onDemand'] as const
type Source = (typeof SOURCES)[number]
type PlanCounts = Partial<Record<Source, number>>

/** The report tool.plan returns; every field is optional because the host may be older. */
interface PlanReport {
  description?: string
  counts?: PlanCounts
  unreachable?: string[]
  plan?: { add?: string[]; remove?: string[]; unchanged?: string[]; changed?: boolean }
}

/** One connection request: what will be sent once the user confirms. */
interface Pending {
  op: string
  id: string
  payload: Record<string, unknown>
  body: string
}

/** One MCP server the snapshot mentions, with the tools it exposes. */
interface ServerEntry {
  server: string
  tools: string[]
  lazy: boolean
}

function readPlan(value: unknown): PlanReport {
  return typeof value === 'object' && value !== null ? (value as PlanReport) : {}
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const seen = new Set(left)
  for (const name of right) if (!seen.has(name)) return false
  return true
}

/** Servers grouped from the rows: a server is lazy when the host marked one of its tools lazy. */
function serversOf(tools: ToolRow[]): ServerEntry[] {
  const rows = new Map<string, ServerEntry>()
  for (const tool of tools) {
    if (tool.server === null || tool.server === undefined) continue
    const entry = rows.get(tool.server) ?? { server: tool.server, tools: [], lazy: false }
    entry.tools.push(tool.name)
    if (tool.lazy === true) entry.lazy = true
    rows.set(tool.server, entry)
  }
  return [...rows.values()].sort((left, right) => (left.server < right.server ? -1 : 1))
}

export function ToolsView(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run, reload } = props
  const [query, setQuery] = React.useState('')
  const [draft, setDraft] = React.useState<string[] | null>(null)
  const [pending, setPending] = React.useState<Pending | null>(null)
  const [plan, setPlan] = React.useState<PlanReport | null>(null)
  const [planError, setPlanError] = React.useState<string | null>(null)
  const [planning, setPlanning] = React.useState(false)
  const [costs, setCosts] = React.useState<Record<string, number>>({})
  const showCosts = snapshot.settings['tools.showTokenEstimate'] !== false

  React.useEffect(() => {
    if (!showCosts) return
    let live = true
    void runOp('tool.costs', {}).then(result => {
      if (!live || !result.ok) return
      const data = result.data !== null && typeof result.data === 'object' ? result.data as Record<string, unknown> : {}
      const rows = Array.isArray(data.tools) ? data.tools : []
      const next: Record<string, number> = {}
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const record = row as Record<string, unknown>
        if (typeof record.name === 'string' && typeof record.tokens === 'number') next[record.name] = record.tokens
      }
      setCosts(next)
    })
    return () => { live = false }
  }, [showCosts])

  const costTotal = Object.values(costs).reduce((sum, value) => sum + value, 0)

  // enabled is the installation mask only (snapshot.ts), so the draft starts from it.
  const baseMask = React.useMemo(
    () => snapshot.tools.filter(tool => !tool.enabled).map(tool => tool.name),
    [snapshot.tools],
  )
  const servers = React.useMemo(() => serversOf(snapshot.tools), [snapshot.tools])
  const mask = draft ?? baseMask
  const dirty = draft !== null && !sameNames(draft, baseMask)
  const masked = React.useMemo(() => new Set(mask), [mask])

  const term = query.trim().toLowerCase()
  const rows = snapshot.tools.filter(tool => {
    if (term === '') return true
    return tool.name.toLowerCase().includes(term) || (tool.server ?? '').toLowerCase().includes(term)
  })

  const loadAll = lang === 'zh' ? '全部加载' : 'Load all'
  const unloadAll = lang === 'zh' ? '全部卸载' : 'Unload all'

  const stop = React.useCallback(() => {
    setPending(null)
  }, [])

  // The shell keys busy as op:id from payload.id, and tool-surface ignores fields it does not
  // read, so every write carries the row it belongs to.
  const fire = React.useCallback((op: string, id: string, payload: Record<string, unknown>) => {
    setPlan(null)
    void run(op, { ...payload, id })
  }, [run])

  const confirm = React.useCallback(() => {
    if (pending === null) return
    const { op, payload } = pending
    setPending(null)
    setPlan(null)
    void run(op, payload)
  }, [pending, run])

  const toggleMask = React.useCallback((name: string, hide: boolean) => {
    const next = new Set(mask)
    if (hide) next.add(name)
    else next.delete(name)
    setDraft([...next].sort())
  }, [mask])

  const askSave = React.useCallback(() => {
    setPending({
      op: SAVE,
      id: 'install',
      payload: { deny: mask, id: 'install' },
      body: lang === 'zh'
        ? `用 ${mask.length} 个工具名替换安装级屏蔽清单？`
        : `Replace the installation mask with ${mask.length} tool names?`,
    })
  }, [lang, mask])

  const askLazy = React.useCallback((entry: ServerEntry, next: boolean) => {
    if (!next) {
      fire(LAZY_SET, entry.server, { server: entry.server, on: false })
      return
    }
    setPending({
      op: LAZY_SET,
      id: entry.server,
      payload: { server: entry.server, on: true, id: entry.server },
      body: lang === 'zh'
        ? `把服务器 ${entry.server} 设为懒加载？它会让该服务器上已加载的工具重新隐藏。`
        : `Turn lazy mode on for ${entry.server}? Every tool already loaded from it is hidden again.`,
    })
  }, [fire, lang])

  const loadPlan = React.useCallback(async () => {
    setPlanning(true)
    setPlanError(null)
    const result = await runOp(PLAN, {})
    setPlanning(false)
    if (!result.ok) {
      setPlan(null)
      setPlanError(result.message)
      return
    }
    setPlan(readPlan(result.data))
  }, [])

  if (snapshot.tools.length === 0) {
    return (
      <Empty
        title={t('tools.empty')}
        hint={lang === 'zh' ? '宿主还没有上报任何工具名。' : 'The host reported no tool names yet.'}
        action={
          <Button variant="ghost" onClick={() => { void reload() }}>
            {t('action.retry')}
          </Button>
        }
      />
    )
  }

  return (
    <div>
      <Toolbar>
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('tools.search')}
          label={t('tools.search')}
          onClear={() => { setQuery('') }}
          clearLabel={t('action.clear')}
        />
        <Badge tone="brand">{t('tools.count', { n: rows.length })}</Badge>
        {showCosts && costTotal > 0 ? <Badge tone="neutral">{lang === 'zh' ? `合计 ~${costTotal} tok` : `~${costTotal} tok total`}</Badge> : null}
        <Badge tone={dirty ? 'warn' : 'neutral'}>
          {t('tools.masked')} {mask.length}
        </Badge>
        <Button variant="ghost" busy={planning} onClick={() => { void loadPlan() }}>
          {t('tools.plan')}
        </Button>
        <Button
          variant="primary"
          busy={busy === `${SAVE}:install`}
          disabled={!dirty}
          onClick={askSave}
        >
          {t('action.save')}
        </Button>
      </Toolbar>

      {planError === null ? null : <Callout>{planError}</Callout>}

      {plan === null ? null : (
        <Card label={t('tools.plan')}>
          <div className="th-row">
            <div className="th-row-body">
              <span className="th-row-name">{plan.description ?? ''}</span>
              <span className="th-row-meta">
                {SOURCES.map(source => (
                  <Badge key={source} tone={(plan.counts?.[source] ?? 0) > 0 ? 'warn' : 'neutral'}>
                    {source} {plan.counts?.[source] ?? 0}
                  </Badge>
                ))}
                <Badge tone="brand">+{(plan.plan?.add ?? []).length}</Badge>
                <Badge tone="off">−{(plan.plan?.remove ?? []).length}</Badge>
              </span>
              {(plan.unreachable ?? []).length === 0 ? null : (
                <span className="th-row-meta">
                  <span>{lang === 'zh' ? '宿主无法屏蔽' : 'Not restrictable'}</span>
                  <span className="th-mono">{(plan.unreachable ?? []).join(', ')}</span>
                </span>
              )}
            </div>
            <Button variant="ghost" label={t('action.close')} onClick={() => { setPlan(null) }}>
              {t('action.close')}
            </Button>
          </div>
        </Card>
      )}

      <div className="th-section">
        <div className="th-section-title">{t('tools.title')}</div>
        {rows.length === 0 ? (
          <Empty
            title={t('tools.empty')}
            hint={lang === 'zh' ? `没有匹配“${query}”的工具。` : `No tool matches “${query}”.`}
          />
        ) : (
          <Card label={t('tools.title')}>
            <div className="th-list">
              {rows.map(tool => {
                const hidden = masked.has(tool.name)
                return (
                  <div className="th-row" key={tool.name}>
                    <div className="th-row-body">
                      <span className="th-row-name th-mono">{tool.name}</span>
                      <span className="th-row-meta">
                        {tool.server === null || tool.server === undefined ? null : (
                          <Badge>
                            {t('tools.server')} {tool.server}
                          </Badge>
                        )}
                        <Badge tone={hidden ? 'warn' : 'on'}>
                          {hidden ? t('tools.masked') : t('tools.visible')}
                        </Badge>
                        {tool.lazy === true ? <Badge tone="off">{t('tools.lazy')}</Badge> : null}
                        {showCosts && costs[tool.name] !== undefined ? <Badge tone="neutral">{'~' + String(costs[tool.name]) + ' tok'}</Badge> : null}
                      </span>
                    </div>
                    <Switch
                      checked={!hidden}
                      label={t('a11y.switch', { name: tool.name })}
                      onChange={next => { toggleMask(tool.name, !next) }}
                    />
                  </div>
                )
              })}
            </div>
          </Card>
        )}
      </div>

      <div className="th-section">
        <div className="th-section-title">{t('tools.lazy')}</div>
        {servers.length === 0 ? (
          <Empty title={t('tools.empty')} />
        ) : (
          <Card label={t('tools.lazy')}>
            <div className="th-list">
              {servers.map(entry => (
                <div className="th-row" key={entry.server}>
                  <div className="th-row-body">
                    <span className="th-row-name">{entry.server}</span>
                    <span className="th-row-meta">
                      <Badge>{t('tools.count', { n: entry.tools.length })}</Badge>
                      {entry.lazy ? <Badge tone="off">{t('tools.lazy')}</Badge> : null}
                      {entry.lazy ? (
                        <>
                          <Button
                            variant="ghost"
                            busy={busy === `${LAZY_LOAD}:${entry.server}`}
                            onClick={() => { fire(LAZY_LOAD, entry.server, { names: entry.tools, load: true }) }}
                          >
                            {loadAll}
                          </Button>
                          <Button
                            variant="ghost"
                            busy={busy === `${LAZY_UNLOAD}:${entry.server}`}
                            onClick={() => { fire(LAZY_UNLOAD, entry.server, { names: entry.tools, load: false }) }}
                          >
                            {unloadAll}
                          </Button>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <Switch
                    checked={entry.lazy}
                    busy={busy === `${LAZY_SET}:${entry.server}`}
                    label={t('a11y.switch', { name: entry.server })}
                    onChange={next => { askLazy(entry, next) }}
                  />
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      <Dialog
        open={pending !== null}
        title={t('dialog.confirmTitle')}
        onClose={stop}
        footer={
          <>
            <Button variant="ghost" onClick={stop}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={pending !== null && busy === `${pending.op}:${pending.id}`}
              onClick={confirm}
            >
              {t('action.confirm')}
            </Button>
          </>
        }
      >
        {pending === null ? '' : pending.body}
      </Dialog>
    </div>
  )
}
