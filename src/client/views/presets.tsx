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
 */
import * as React from 'react'
import { Badge, Button, Card, Dialog, Empty, Field, SearchBox, Select } from '../components.js'
import type { PresetRow, ViewProps } from '../types.js'

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

export function PresetsView(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run } = props
  const [query, setQuery] = React.useState('')
  const [mode, setMode] = React.useState<Mode>('exact')
  // null means the save dialog is closed; a string is the name being typed.
  const [draft, setDraft] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState<Pending | null>(null)
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

      {names.length === 0 ? (
        <Empty title={t('presets.empty')} hint={t('presets.create')} />
      ) : rows.length === 0 ? (
        <Empty title={t('presets.empty')} hint={t('presets.search') + ': ' + query} />
      ) : (
        <Card label={t('presets.title')}>
          <div className="th-list">
            {rows.map(name => {
              const row = snapshot.presets[name] ?? {}
              return (
                <div className="th-row" key={name}>
                  <div className="th-row-body">
                    <span className="th-row-name">{name}</span>
                    <span className="th-row-meta">
                      <Badge>{t('presets.entries', { n: entries(row) })}</Badge>
                      <span className="th-mono">{composition(row, lang)}</span>
                    </span>
                  </div>
                  <Button
                    variant="primary"
                    busy={busy === `${OP.apply}:${name}`}
                    label={t('presets.apply') + ': ' + name}
                    onClick={() => {
                      void run(OP.apply, { id: name, name, mode })
                    }}
                  >
                    {t('presets.apply')}
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
    </div>
  )
}
