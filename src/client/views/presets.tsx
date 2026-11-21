/**
 * Presets: named snapshots of what is switched on, replayed later.
 *
 * Ops and payloads come from src/domains/presets.ts, not from the shell's OPS table: save
 * { name, note? }, update { name }, delete { name }, apply { name, mode }. Every op also carries
 * the name as `id`, because the shell keys the busy flag as `${op}:${payload.id}`; without it
 * the whole list would look busy while one row works.
 *
 * Applying is reversible (apply another preset, or flip the switches back), so it fires straight
 * from the row. Overwriting disposes of a saved snapshot and deleting removes the preset; both
 * open a Dialog first, and that dialog names the preset it is about to touch.
 *
 * Apply goes through runDetailed, not run: preset.apply can answer that the tool dimension is
 * deferred — the servers it just switched on have not registered yet, so there is no live list
 * to complement against and the domain schedules no timer. The row then re-applies exactly once
 * after the delay the host asked for, and the line under the toolbar says so; a second deferral
 * is reported, never chased.
 */
import * as React from 'react'
import { Badge, Button, Callout, Card, Dialog, Empty, Field, SearchBox, Select } from '../components.js'
import { PresetPolicyDialog } from './presets-policy.js'
import type { PresetRow, RunOutcome, ViewProps } from '../types.js'

/** The ops this view sends; api.ts's OPS table covers toggles, scenes and doctor only. */
const OP = {
  apply: 'preset.apply',
  save: 'preset.save',
  update: 'preset.update',
  remove: 'preset.delete',
} as const

/** Mirrors PresetMode in src/domains/presets.ts: exact also turns things off. */
type Mode = 'exact' | 'only-enable'

/** The preset ops that need a confirmation: which one is pending, and on which preset. */
interface Pending {
  op: typeof OP.update | typeof OP.remove
  name: string
}

/** Stable ids without depending on React.useId being present in the host runtime. */
let seq = 0

function useLocalId(prefix: string): string {
  const [id] = React.useState(() => {
    seq += 1
    return `${prefix}-${seq}`
  })
  return id
}

/** The policy counts a row carries once the snapshot projects them; null while it does not. */
function policyOf(row: PresetRow): { disabled: number, groups: number } | null {
  const raw = (row as unknown as { toolPolicy?: { disabled?: unknown, groups?: unknown } }).toolPolicy
  if (typeof raw !== 'object' || raw === null) return null
  return {
    disabled: Array.isArray(raw.disabled) ? raw.disabled.length : 0,
    groups: Array.isArray(raw.groups) ? raw.groups.length : 0,
  }
}

/** How many ids a preset would switch, for the row badge. */
function entries(row: PresetRow): number {
  const plugin = row.plugin?.length ?? 0
  const skill = row.skill?.length ?? 0
  const tool = row.tool?.length ?? 0
  return plugin + skill + tool
}

/** Per-dimension counts on one line; the dimension nouns have no catalog entry of their own. */
function composition(row: PresetRow, lang: ViewProps['lang']): string {
  const noun = lang === 'zh'
    ? { plugin: '插件', skill: '技能', tool: '工具' }
    : { plugin: 'plugins', skill: 'skills', tool: 'tools' }
  const plugin = row.plugin?.length ?? 0
  const skill = row.skill?.length ?? 0
  const tool = row.tool?.length ?? 0
  return `${noun.plugin} ${plugin} · ${noun.skill} ${skill} · ${noun.tool} ${tool}`
}

/** The domain's fallback delay when a deferral arrives without one (src/domains/presets.ts). */
const RETRY_DEFAULT_MS = 1500

/** Past this a deferral is not worth holding the row busy for; one retry covers the usual case. */
const RETRY_MAX_MS = 5000

/**
 * How long preset.apply asked to wait before re-applying, or null when it did not defer.
 * The handler answers `{ tools: { decision: 'deferred', wanted, retryAfterMs } }` when the
 * servers the apply just switched on have not registered yet: there is nothing to complement
 * against, and the domain deliberately schedules no timer, leaving the re-apply to the caller.
 */
function deferralOf(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null
  const tools = (data as { tools?: unknown }).tools
  if (typeof tools !== 'object' || tools === null) return null
  const report = tools as { decision?: unknown, retryAfterMs?: unknown }
  if (report.decision !== 'deferred') return null
  const reported =
    typeof report.retryAfterMs === 'number' && Number.isFinite(report.retryAfterMs) && report.retryAfterMs > 0
      ? report.retryAfterMs
      : RETRY_DEFAULT_MS
  return Math.min(reported, RETRY_MAX_MS)
}

/**
 * Sends one apply and, when the domain deferred its tool dimension, exactly one more after the
 * delay it asked for. True means the retry was spent. Two sends and no loop: a second deferral
 * is reported to the user instead of chasing registration that never happened.
 */
async function applyTwice(send: () => Promise<RunOutcome>): Promise<boolean> {
  const first = await send()
  if (!first.ok) return false
  const delay = deferralOf(first.data)
  if (delay === null) return false
  await new Promise<void>(resolve => {
    setTimeout(resolve, delay)
  })
  await send()
  return true
}

export function PresetsView(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run, runDetailed } = props
  const [query, setQuery] = React.useState('')
  const [mode, setMode] = React.useState<Mode>('exact')
  // null means the save dialog is closed; a string is the name being typed.
  const [draft, setDraft] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState<Pending | null>(null)
  // True once an apply deferred its tool dimension and the one retry was spent.
  const [deferred, setDeferred] = React.useState(false)
  // The preset whose tool policy dialog is open; null while it is closed.
  const [policyFor, setPolicyFor] = React.useState<string | null>(null)
  const modeId = useLocalId('th-presets-mode')
  const nameId = useLocalId('th-presets-name')

  const names = Object.keys(snapshot.presets).sort()
  const term = query.trim().toLowerCase()
  const rows = term === '' ? names : names.filter(name => name.toLowerCase().includes(term))
  const draftName = (draft ?? '').trim()
  // preset.save overwrites by name, so the dialog has to warn before it ships.
  const overwriting = draftName !== '' && names.includes(draftName)

  const closeSave = (): void => {
    setDraft(null)
  }

  const closeConfirm = (): void => {
    setPending(null)
  }

  const submitSave = (): void => {
    if (draftName === '') return
    void run(OP.save, { id: draftName, name: draftName }).then(ok => {
      if (ok) setDraft(null)
    })
  }

  const confirmOverwrite = (name: string): void => {
    setPending(null)
    void run(OP.update, { id: name, name })
  }

  const confirmDelete = (name: string): void => {
    setPending(null)
    void run(OP.remove, { id: name, name })
  }

  // The one place preset.apply is sent. Both calls carry the same id, so the shell's `op:id`
  // busy key marks the row for each send; between them the wait runs with no op in flight.
  const applyRow = (name: string): void => {
    setDeferred(false)
    void applyTwice(() => runDetailed(OP.apply, { id: name, name, mode })).then(retried => {
      if (retried) setDeferred(true)
    })
  }

  return (
    <div>
      <div className="th-toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('presets.search')}
          label={t('presets.search')}
          onClear={() => {
            setQuery('')
          }}
          clearLabel={t('action.clear')}
        />
        <Select
          id={modeId}
          value={mode}
          label={lang === 'zh' ? '应用方式' : 'Apply mode'}
          options={[
            { value: 'exact', label: lang === 'zh' ? '完全匹配' : 'Exact' },
            { value: 'only-enable', label: lang === 'zh' ? '只启用' : 'Only enable' },
          ]}
          onChange={value => {
            setMode(value === 'only-enable' ? 'only-enable' : 'exact')
          }}
        />
        <span className="th-row-meta">
          {mode === 'exact'
            ? lang === 'zh' ? '会关闭预设未包含的项' : 'Turns off what the preset leaves out'
            : lang === 'zh' ? '只打开，不关闭任何项' : 'Only turns things on'}
        </span>
        <Badge tone="brand">{t('presets.count', { n: rows.length })}</Badge>
        <Button
          variant="primary"
          label={t('presets.create')}
          onClick={() => {
            setDraft('')
          }}
        >
          {t('presets.create')}
        </Button>
      </div>

      {deferred ? <Callout tone="info">{t('presets.deferred')}</Callout> : null}

      {names.length === 0 ? (
        <Empty title={t('presets.empty')} hint={t('presets.create')} />
      ) : rows.length === 0 ? (
        <Empty title={t('presets.empty')} hint={t('presets.search') + ': ' + query} />
      ) : (
        <Card label={t('presets.title')}>
          <div className="th-list">
            {rows.map(name => {
              const row = snapshot.presets[name] ?? {}
              const policy = policyOf(row)
              return (
                <div className="th-row" key={name}>
                  <div className="th-row-body">
                    <span className="th-row-name">{name}</span>
                    <span className="th-row-meta">
                      <Badge>{t('presets.entries', { n: entries(row) })}</Badge>
                      {policy === null ? null : (
                        <Badge tone="brand">{t('presets.policyBadge', { k: policy.disabled, m: policy.groups })}</Badge>
                      )}
                      <span className="th-mono">{composition(row, lang)}</span>
                    </span>
                  </div>
                  <Button
                    variant="primary"
                    busy={busy === `${OP.apply}:${name}`}
                    label={t('presets.apply') + ': ' + name}
                    onClick={() => {
                      applyRow(name)
                    }}
                  >
                    {t('presets.apply')}
                  </Button>
                  <Button
                    variant="ghost"
                    label={t('presets.policy') + ': ' + name}
                    onClick={() => {
                      setPolicyFor(name)
                    }}
                  >
                    {t('presets.policy')}
                  </Button>
                  <Button
                    variant="ghost"
                    busy={busy === `${OP.update}:${name}`}
                    label={t('presets.update') + ': ' + name}
                    onClick={() => {
                      setPending({ op: OP.update, name })
                    }}
                  >
                    {t('presets.update')}
                  </Button>
                  <Button
                    variant="danger"
                    busy={busy === `${OP.remove}:${name}`}
                    label={t('presets.delete') + ': ' + name}
                    onClick={() => {
                      setPending({ op: OP.remove, name })
                    }}
                  >
                    {t('presets.delete')}
                  </Button>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <Dialog
        open={draft !== null}
        title={t('presets.create')}
        onClose={closeSave}
        footer={
          <>
            <Button variant="ghost" onClick={closeSave}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={draftName === ''}
              busy={busy === `${OP.save}:${draftName}`}
              onClick={submitSave}
            >
              {t('action.save')}
            </Button>
          </>
        }
      >
        <Field
          id={nameId}
          label={t('presets.name')}
          hint={lang === 'zh' ? '记录此刻启用的插件、技能与工具屏蔽' : 'Records the plugins, skills and tool masking that are on right now'}
        >
          <input
            id={nameId}
            className="th-input"
            type="text"
            value={draft ?? ''}
            maxLength={60}
            aria-label={t('presets.name')}
            onChange={event => {
              setDraft(event.target.value)
            }}
          />
        </Field>
        {overwriting ? (
          <div className="th-row-meta">
            <Badge tone="warn">{lang === 'zh' ? '同名预设已存在，保存会覆盖它' : 'A preset with this name exists; saving replaces it'}</Badge>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={pending !== null}
        title={t('dialog.confirmTitle')}
        onClose={closeConfirm}
        footer={
          <>
            <Button variant="ghost" onClick={closeConfirm}>
              {t('action.cancel')}
            </Button>
            {pending === null ? null : pending.op === OP.remove ? (
              <Button
                variant="danger"
                onClick={() => {
                  confirmDelete(pending.name)
                }}
              >
                {t('presets.delete')}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => {
                  confirmOverwrite(pending.name)
                }}
              >
                {t('action.confirm')}
              </Button>
            )}
          </>
        }
      >
        {pending === null ? null : (
          <div>
            <div>{pending.op === OP.remove ? t('presets.deleteBody', { name: pending.name }) : t('presets.update') + ': ' + pending.name}</div>
            <div className="th-row-meta">
              {pending.op === OP.remove
                ? lang === 'zh' ? '删除后无法撤销。' : 'This cannot be undone.'
                : lang === 'zh' ? '旧快照会被此刻启用的状态替换。' : 'The saved snapshot is replaced by what is on now.'}
            </div>
          </div>
        )}
      </Dialog>

      <PresetPolicyDialog
        open={policyFor !== null}
        name={policyFor ?? ''}
        t={t}
        targets={Object.fromEntries(names.map(entry => [entry, snapshot.presets[entry]?.tool ?? []]))}
        runDetailed={runDetailed}
        onClose={() => {
          setPolicyFor(null)
        }}
      />
    </div>
  )
}
