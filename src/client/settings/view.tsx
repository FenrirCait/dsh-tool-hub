/**
 * Settings: every declared field, grouped, edited as a draft, written once on save.
 *
 * The page never writes per keystroke. The draft holds exactly what the user typed (raw, not
 * coerced, so clearing a number keeps it clearable); comparison and the payload coerce it against
 * the declaration, and only the keys that differ are sent as one settings.set. A
 * missing schema is not an error state in the host: it is the empty state with a retry, because
 * a host that has not wired the declaration yet will have it after one more read.
 */
import * as React from 'react'
import type { SettingsField } from '../../shared/types.js'
import type { ViewProps } from '../types.js'
import { SAVE_OP } from './ops.js'
import { Badge, Button, Callout, Card, Empty } from '../components.js'
import { SP } from '../theme.js'
import { FieldRow } from './fields.js'
import { OfficialBaseline } from './official.js'
import {
  dirtyOf,
  draftOf,
  groupFields,
  groupTitleOf,
  restoreDefaultsOf,
  savePayloadOf,
} from './model.js'

export function SettingsView(props: ViewProps): React.ReactElement {
  const { snapshot, lang, t, busy, run } = props
  const fields = snapshot.settingsSchema
  const settings = snapshot.settings
  const [draft, setDraft] = React.useState<Record<string, unknown>>(() => draftOf(fields, settings))
  const [error, setError] = React.useState<string | null>(null)

  const dirty = dirtyOf(fields, draft, settings)
  const saving = busy === SAVE_OP
  const dirtyRef = React.useRef(0)
  dirtyRef.current = dirty.length

  // A fresh snapshot replaces the draft only when nothing is pending: a background refresh must
  // not throw away what the user typed, and after a save the draft already equals the store.
  const stampRef = React.useRef(snapshot.fetchedAt)
  React.useEffect(() => {
    if (stampRef.current === snapshot.fetchedAt) return
    stampRef.current = snapshot.fetchedAt
    if (dirtyRef.current > 0) return
    setDraft(draftOf(fields, settings))
  }, [snapshot.fetchedAt, fields, settings])

  React.useEffect(() => {
    if (dirty.length === 0 || typeof window === 'undefined') return undefined
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
    }
  }, [dirty.length])

  if (fields.length === 0) {
    return (
      <Empty
        title={t('settings.emptyTitle')}
        hint={t('settings.emptyHint')}
        action={
          <Button
            onClick={() => {
              void props.reload()
            }}
          >
            {t('action.retry')}
          </Button>
        }
      />
    )
  }

  const groups = groupFields(fields)

  const save = (): void => {
    if (saving || dirty.length === 0) return
    setError(null)
    const values = savePayloadOf(fields, draft, settings)
    void run(SAVE_OP, { values }).then(ok => {
      if (!ok) setError(t('settings.error.save'))
    })
  }

  return (
    <div>
      <div className="th-toolbar">
        <span className="th-top-title">{t('settings.title')}</span>
        <Badge tone="brand">{t('settings.count', { n: fields.length })}</Badge>
        {dirty.length === 0 ? (
          <Badge>{t('settings.clean')}</Badge>
        ) : (
          <Badge tone="warn">{t('settings.dirty', { n: dirty.length })}</Badge>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: SP.sm }}>
          <Button variant="primary" onClick={save} busy={saving} disabled={dirty.length === 0}>
            {saving ? t('settings.saving') : t('settings.save')}
          </Button>
          <Button
            disabled={saving}
            onClick={() => {
              setDraft(restoreDefaultsOf(fields, draft))
            }}
          >
            {t('settings.reset')}
          </Button>
          <Button
            variant="ghost"
            disabled={saving || dirty.length === 0}
            onClick={() => {
              setDraft(draftOf(fields, settings))
              setError(null)
            }}
          >
            {t('settings.discard')}
          </Button>
        </div>
      </div>
      {error === null ? null : (
        <Callout
          action={
            <Button
              variant="ghost"
              onClick={() => {
                setError(null)
              }}
            >
              {t('action.close')}
            </Button>
          }
        >
          {error}
        </Callout>
      )}
      {dirty.length === 0 ? null : (
        <Callout tone="info">
          <span>{t('settings.unsaved')}</span>
          <span style={{ marginLeft: SP.sm, opacity: 0.8 }}>{t('settings.hint')}</span>
        </Callout>
      )}
      {groups.map(group => {
        const title = groupTitleOf(group.id, t)
        return (
          <section className="th-section" key={group.id} aria-label={t('settings.a11y.group', { name: title })}>
            <div className="th-section-title">{title}</div>
            <Card label={title}>
              {group.fields.map((field: SettingsField) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  value={draft[field.key]}
                  lang={lang}
                  t={t}
                  disabled={saving}
                  dirty={dirty.includes(field.key)}
                  onChange={next => {
                    setDraft(current => ({ ...current, [field.key]: next }))
                  }}
                />
              ))}
            </Card>
          </section>
        )
      })}
      <OfficialBaseline {...props} />
    </div>
  )
}
