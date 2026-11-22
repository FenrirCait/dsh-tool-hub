/**
 * Settings section for the official plugin baseline.
 *
 * The list is read from the host's shipped-default comparison, never from a guess. A single row
 * can be flipped with the normal plugin switch; the bulk action stays behind a preview dialog
 * because restoring official defaults and disabling third-party rows is a profile-wide change.
 * Third-party rows can be exempted in that dialog, which is how an agent-preset plugin is kept.
 */
import * as React from 'react'
import type { ViewProps } from '../types.js'
import { runOp } from '../api.js'
import { Badge, Button, Callout, Card, Dialog } from '../components.js'
import { SP } from '../theme.js'

interface BaselineEntry {
  id: string
  name: string
  moduleName: string
  official: boolean
  onBaseline: boolean
  defaultEnabled: boolean | null
  conditional: boolean
  requiresConfig: boolean
  currentEnabled: boolean | null
  action: 'enable' | 'disable' | 'leave' | 'skip'
  reason: string
}

interface ResetPlan {
  available: boolean
  profile: string
  entries: BaselineEntry[]
  official: number
  defaultOff: number
  conditional: number
  changes: number
  disableThirdParty: Array<{ id: string; name: string; moduleName: string }>
  warnings: string[]
}

interface ResetResult {
  ok: boolean
  backup: string
  applied: Array<{ id: string; enabled: boolean }>
  skipped: Array<{ id: string; reason: string }>
  failed: Array<{ id: string; error: string }>
}

function pick(lang: 'zh' | 'en', zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

function messageOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  return ''
}

function entryTone(entry: BaselineEntry): 'neutral' | 'on' | 'off' | 'warn' {
  if (entry.conditional) return 'warn'
  if (entry.currentEnabled === true) return 'on'
  return 'off'
}

export function OfficialBaseline(props: ViewProps): React.ReactElement {
  const { lang, run, runDetailed, reload } = props
  const [plan, setPlan] = React.useState<ResetPlan | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const [applying, setApplying] = React.useState(false)
  const [exempt, setExempt] = React.useState<Set<string>>(() => new Set())
  const [result, setResult] = React.useState<ResetResult | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const answer = await runOp('official.baseline')
    if (answer.ok) {
      setPlan(answer.data as ResetPlan)
    } else {
      setError(String(answer.message || pick(lang, '读取官方基线失败', 'Could not read the official baseline')))
    }
    setLoading(false)
  }, [lang])

  React.useEffect(() => {
    void load()
  }, [load])

  const toggle = async (entry: BaselineEntry): Promise<void> => {
    if (entry.currentEnabled === null || entry.conditional) return
    setSaving(entry.id)
    const ok = await run('toggle', { kind: 'plugin', id: entry.id, enabled: !entry.currentEnabled })
    setSaving(null)
    if (!ok) {
      setError(pick(lang, '切换失败，详情见右上角状态。', 'The switch failed; see the status at the top right.'))
      return
    }
    await load()
  }

  const confirm = async (): Promise<void> => {
    setApplying(true)
    const answer = await runDetailed('official.reset', { confirm: true, exempt: [...exempt] })
    setApplying(false)
    if (!answer.ok) {
      setError(String(answer.error ?? pick(lang, '恢复失败', 'Reset failed')))
      return
    }
    setResult(answer.data as ResetResult)
    setConfirming(false)
    await reload()
    await load()
  }

  const officialEntries = plan?.entries ?? []
  const changed = officialEntries.filter(entry => entry.action === 'enable' || entry.action === 'disable')
  return (
    <>
      <section className="th-section" aria-label={pick(lang, '官方插件基线', 'Official plugin baseline')}>
        <div className="th-section-title">{pick(lang, '官方插件基线', 'Official plugin baseline')}</div>
        <Card label={pick(lang, '官方插件基线', 'Official plugin baseline')}>
          <p className="th-muted" style={{ marginTop: 0 }}>
            {pick(
              lang,
              '只读对比 DSH shipped 默认配置与当前开关。这里的“默认”不是“官方全开”：默认关闭的保持关闭，条件项不改。恢复只改 profile 插件开关，不改技能、MCP、config 或任何 Agent 预设文件。',
              'Read-only comparison of the shipped DSH defaults and the live switches. “Default” does not mean “all official plugins on”: entries that ship off stay off, and conditional entries are left alone. Reset touches profile plugin switches only; skills, MCP, config and agent preset files are not modified.',
            )}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP.sm, alignItems: 'center' }}>
            <Button busy={loading} onClick={() => { void load() }}>
              {pick(lang, '刷新基线', 'Refresh')}
            </Button>
            <Button
              variant="primary"
              disabled={plan === null || !plan.available}
              onClick={() => { setExempt(new Set()); setConfirming(true) }}
            >
              {pick(lang, '预览并恢复官方基线…', 'Preview and restore…')}
            </Button>
            {plan === null ? null : (
              <>
                <Badge>{pick(lang, '官方条目', 'Official')} {plan.official}</Badge>
                <Badge tone="off">{pick(lang, '默认关闭', 'Default off')} {plan.defaultOff}</Badge>
                <Badge tone="warn">{pick(lang, '条件项', 'Conditional')} {plan.conditional}</Badge>
                <Badge tone="brand">{pick(lang, '将变更', 'Changes')} {plan.changes}</Badge>
              </>
            )}
          </div>
          {plan !== null && !plan.available ? (
            <Callout tone="info">
              {pick(lang, 'shipped 默认配置不可用，只能显示当前列表；不会执行批量恢复。', 'Shipped defaults are unavailable; the live list is shown and bulk reset is disabled.')}
            </Callout>
          ) : null}
          {plan?.warnings.map(warning => (
            <Callout tone="info" key={warning}>{warning}</Callout>
          ))}
          {error === null ? null : (
            <Callout
              tone="error"
              action={<Button variant="ghost" onClick={() => { setError(null) }}>{pick(lang, '关闭', 'Close')}</Button>}
            >
              {error}
            </Callout>
          )}
          {result === null ? null : (
            <Callout tone={result.ok ? 'info' : 'error'}>
              <div>
                {result.ok ? pick(lang, '已应用。', 'Applied.') : pick(lang, '部分失败。', 'Partially failed.')}
                {' '}
                {pick(lang, '备份：', 'Backup: ')}
                <code>{result.backup}</code>
              </div>
              <div className="th-muted">
                {pick(lang, '应用', 'Applied')} {result.applied.length} · {pick(lang, '跳过', 'Skipped')} {result.skipped.length} · {pick(lang, '失败', 'Failed')} {result.failed.length}
              </div>
              {result.failed.length === 0 ? null : (
                <ul>
                  {result.failed.slice(0, 5).map(item => <li key={item.id}><code>{item.id}</code>: {item.error}</li>)}
                </ul>
              )}
            </Callout>
          )}
          {loading && plan === null ? <div className="th-muted">{pick(lang, '读取中…', 'Reading…')}</div> : null}
          {plan === null ? null : (
            <div style={{ maxHeight: 360, overflow: 'auto', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))' }}>
              {officialEntries.length === 0 ? <div className="th-muted">{pick(lang, '没有官方条目。', 'No official entries.')}</div> : null}
              {officialEntries.map(entry => (
                <div className="th-row" key={entry.id} style={{ alignItems: 'center' }}>
                  <div className="th-row-body" style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP.xs, alignItems: 'center' }}>
                      <strong>{entry.name}</strong>
                      <Badge tone={entryTone(entry)}>
                        {entry.conditional
                          ? pick(lang, '条件默认', 'Conditional')
                          : entry.defaultEnabled === false
                            ? pick(lang, '默认关', 'Default off')
                            : entry.defaultEnabled === true
                              ? pick(lang, '默认开', 'Default on')
                              : pick(lang, '无基线', 'No baseline')}
                      </Badge>
                      {entry.requiresConfig ? <Badge tone="neutral">{pick(lang, '带配置', 'Config')}</Badge> : null}
                      {entry.currentEnabled === null ? <Badge tone="neutral">{pick(lang, '未挂载', 'Not mounted')}</Badge> : null}
                      {entry.action === 'enable' ? <Badge tone="brand">{pick(lang, '将启用', 'Will enable')}</Badge> : null}
                      {entry.action === 'disable' ? <Badge tone="warn">{pick(lang, '将禁用', 'Will disable')}</Badge> : null}
                    </div>
                    <div className="th-muted" style={{ fontSize: '0.85em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.moduleName} · {entry.reason}
                    </div>
                  </div>
                  {entry.currentEnabled === null || entry.conditional ? null : (
                    <Button
                      busy={saving === entry.id}
                      disabled={saving !== null}
                      onClick={() => { void toggle(entry) }}
                    >
                      {entry.currentEnabled ? pick(lang, '禁用', 'Disable') : pick(lang, '启用', 'Enable')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>
      <Dialog
        open={confirming}
        title={pick(lang, '恢复官方插件基线', 'Restore official plugin baseline')}
        onClose={() => { if (!applying) setConfirming(false) }}
        footer={
          <div style={{ display: 'flex', gap: SP.sm, justifyContent: 'flex-end' }}>
            <Button variant="ghost" disabled={applying} onClick={() => { setConfirming(false) }}>
              {pick(lang, '取消', 'Cancel')}
            </Button>
            <Button variant="danger" busy={applying} onClick={() => { void confirm() }}>
              {pick(lang, '确认恢复', 'Confirm restore')}
            </Button>
          </div>
        }
      >
        {plan === null ? null : (
          <div>
            <p>
              {pick(lang, '将恢复官方条目到 shipped 默认开关，并禁用下列第三方插件。不会卸载包，也不会修改技能、MCP、config 或 Agent 预设文件。操作前会备份 profile。', 'Official entries will return to shipped defaults and the third-party plugins below will be disabled. No package is uninstalled, and skills, MCP, config or agent preset files are not modified. The profile is backed up first.')}
            </p>
            {changed.length === 0 ? <p className="th-muted">{pick(lang, '官方条目已在默认状态。', 'Official entries are already at defaults.')}</p> : (
              <div style={{ maxHeight: 180, overflow: 'auto' }}>
                <strong>{pick(lang, '官方变更', 'Official changes')}</strong>
                <ul>
                  {changed.map(entry => (
                    <li key={entry.id}>
                      {entry.action === 'enable' ? pick(lang, '启用', 'Enable') : pick(lang, '禁用', 'Disable')} <code>{entry.id}</code> · {entry.moduleName}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div style={{ marginTop: SP.sm }}>
              <strong>{pick(lang, '第三方插件', 'Third-party plugins')}</strong>
              <p className="th-muted" style={{ margin: '4px 0' }}>
                {pick(lang, '默认全部禁用。若某插件的 Agent 预设会改官方开关，勾选“保留”让它继续启用。', 'Disabled by default. If a plugin’s agent preset changes official switches, tick “Keep” to leave it enabled.')}
              </p>
              <div style={{ maxHeight: 220, overflow: 'auto' }}>
                {plan.disableThirdParty.length === 0 ? <div className="th-muted">{pick(lang, '没有可禁用的第三方插件。', 'No third-party plugins to disable.')}</div> : null}
                {plan.disableThirdParty.map(row => (
                  <label key={row.id} style={{ display: 'flex', gap: SP.sm, alignItems: 'flex-start', padding: '3px 0' }}>
                    <input
                      type="checkbox"
                      checked={exempt.has(row.id)}
                      onChange={event => {
                        setExempt(current => {
                          const next = new Set(current)
                          if (event.target.checked) next.add(row.id)
                          else next.delete(row.id)
                          return next
                        })
                      }}
                    />
                    <span>{pick(lang, '保留', 'Keep')} <code>{row.name}</code> <span className="th-muted">({row.moduleName})</span></span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </>
  )
}