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
import { Badge, Button, Callout, Card, Dialog, Empty, SearchBox, Select, Switch, Toolbar } from '../components.js'
import type { ToolRow, ViewProps } from '../types.js'
import type { TreeGroup } from './package-tree.js'
import { ScopeCard } from './scope-card.js'
import { OnDemandCard } from './on-demand-card.js'
import { ToolsTree, buildToolTree, copyLabel, denyOf, nextDeny } from './tools-tree.js'

/** Op ids this view sends; the tool-surface domain owns their payloads. */
const SAVE = 'tool.save'
const PLAN = 'tool.plan'
const LAZY_SET = 'lazy.set'
const LAZY_LOAD = 'lazy.load'
const LAZY_UNLOAD = 'lazy.unload'
const LAZY_RESET = 'lazy.reset'

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
  hidden: number
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
    const entry = rows.get(tool.server) ?? { server: tool.server, tools: [], lazy: false, hidden: 0 }
    entry.tools.push(tool.name)
    if (tool.lazy === true) entry.lazy = true
    if (tool.lazyHidden === true) entry.hidden += 1
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
  const [lazySession, setLazySession] = React.useState('')
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
  const baseMask = React.useMemo(() => denyOf(snapshot.tools), [snapshot.tools])
  const servers = React.useMemo(() => serversOf(snapshot.tools), [snapshot.tools])
  const mask = draft ?? baseMask
  const dirty = draft !== null && !sameNames(draft, baseMask)
  const masked = React.useMemo(() => new Set(mask), [mask])

  const term = query.trim().toLowerCase()
  /* The tree owns grouping and filtering; its rows feed the toolbar count and the empty branch. */
  const tree = React.useMemo(() => buildToolTree(snapshot.tools, term, t), [snapshot.tools, term, t])
  const rows = tree.rows

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

  // A parent switch writes the whole mask at once: the next deny list is the committed one plus
  // or minus the group, never an unsaved draft. A successful write drops that draft so no row can
  // keep showing an edit the committed list no longer holds; a failed one leaves it alone.
  const bulkGroup = React.useCallback((group: TreeGroup<ToolRow>, next: boolean) => {
    // An MCP parent is the server's lazy switch: on loads every tool, off hides the server.
    if (group.key.startsWith('mcp:')) {
      const server = group.key.slice('mcp:'.length)
      fire(LAZY_SET, server, { server, on: !next })
      return
    }
    const deny = nextDeny(baseMask, group.rows.map(row => row.name), next)
    setPlan(null)
    void run(SAVE, { deny, id: group.key }).then(ok => { if (ok) setDraft(null) })
  }, [baseMask, fire, run])

  // The shell keys busy as op:id; MCP parents write lazy.set, prefix parents tool.save.
  const bulkBusy = busy !== null && busy.startsWith(SAVE + ':')
    ? busy.slice(SAVE.length + 1)
    : busy !== null && busy.startsWith(LAZY_SET + ':')
      ? busy.slice(LAZY_SET.length + 1)
      : null

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
            <ToolsTree
              groups={tree.groups}
              lang={lang}
              t={t}
              masked={masked}
              costs={costs}
              showCosts={showCosts}
              forceOpen={term !== ''}
              busyKey={bulkBusy}
              onToggle={toggleMask}
              onBulk={bulkGroup}
            />
          </Card>
        )}
      </div>

      <div className="th-section">
        <div className="th-section-title">
          {t('tools.lazy')}
          {servers.length === 0 ? null : (
            <Button
              variant="ghost"
              busy={busy === `${LAZY_RESET}:all`}
              onClick={() => { void run(LAZY_RESET, {}).then(ok => { if (ok) reload() }) }}
            >
              {copyLabel(lang, '清除全部已加载', 'Reset all loaded')}
            </Button>
          )}
        </div>
        {servers.length === 0 ? (
          <Empty title={t('tools.empty')} />
        ) : (
          <Card label={t('tools.lazy')}>
            <div className="th-row-meta">
              <Select
                id="th-lazy-session"
                value={lazySession}
                label={copyLabel(lang, '作用域', 'Scope')}
                options={[
                  { value: '', label: copyLabel(lang, '全局（所有会话）', 'Global (all sessions)') },
                  ...snapshot.sessionList.map(item => ({ value: item.id, label: item.title === item.id ? item.id : item.title + ' · ' + item.id.slice(0, 8) })),
                ]}
                onChange={setLazySession}
              />
            </div>
            <div className="th-row-meta">
              {copyLabel(lang, '面板「加载」是全局的；模型用 hub_tools 加载只对当前会话。会话结束或超过设置里的 TTL 会清理。', 'Panel loads are global; hub_tools loads apply to the current session only. Session end or the TTL in settings clears them.')}
            </div>
            <div className="th-list">
              {servers.map(entry => (
                <div className="th-row" key={entry.server}>
                  <div className="th-row-body">
                    <span className="th-row-name">{entry.server}</span>
                    <span className="th-row-meta">
                      <Badge>{t('tools.count', { n: entry.tools.length })}</Badge>
                      {entry.lazy ? <Badge tone="off">{t('tools.lazy')}</Badge> : null}
                      {entry.hidden > 0 ? <Badge tone="off">{copyLabel(lang, `${entry.hidden} 个隐藏`, `${entry.hidden} hidden`)}</Badge> : null}
                      {entry.lazy ? (
                        <>
                          <Button
                            variant="ghost"
                            busy={busy === `${LAZY_LOAD}:${entry.server}`}
                            onClick={() => { fire(LAZY_LOAD, entry.server, { names: entry.tools, load: true, ...(lazySession === '' ? {} : { sessionId: lazySession }) }) }}
                          >
                            {loadAll}
                          </Button>
                          <Button
                            variant="ghost"
                            busy={busy === `${LAZY_UNLOAD}:${entry.server}`}
                            onClick={() => { fire(LAZY_UNLOAD, entry.server, { names: entry.tools, load: false, ...(lazySession === '' ? {} : { sessionId: lazySession }) }) }}
                          >
                            {unloadAll}
                          </Button>
                          <Button
                            variant="ghost"
                            busy={busy === `${LAZY_RESET}:${entry.server}`}
                            disabled={entry.hidden >= entry.tools.length}
                            onClick={() => { fire(LAZY_RESET, entry.server, { server: entry.server, ...(lazySession === '' ? {} : { sessionId: lazySession }) }) }}
                          >
                            {copyLabel(lang, '清除已加载', 'Reset loaded')}
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

      <OnDemandCard {...props} />

      <ScopeCard {...props} />
    </div>
  )
}
