/**
 * On-demand groups: a session only sees a group's tools after opening it with tool_list.
 *
 * The group's own tool list is explicit (the host has no plugin→tools ownership map), so this card
 * edits names directly. The toggle and the tool list are separate ops, each audited.
 */
import * as React from 'react'
import { Badge, Button, Card, Empty, Field, Switch } from '../components.js'
import type { ViewProps } from '../types.js'

function namesOf(text: string): string[] {
  return text.split(/[\s,]+/u).map(name => name.trim()).filter(name => name !== '')
}

export function OnDemandCard(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run, reload } = props
  const groups = snapshot.groups
  const [editing, setEditing] = React.useState<string | null>(null)
  const [text, setText] = React.useState('')
  const [status, setStatus] = React.useState('')

  const startEdit = (id: string, current: string[]): void => {
    setEditing(id)
    setText(current.join(', '))
    setStatus('')
  }

  const save = (id: string): void => {
    void run('group.tools', { id, tools: namesOf(text) }).then(ok => {
      if (ok) {
        setEditing(null)
        setStatus(t('ondemand.saved'))
        reload()
      }
    })
  }

  return (
    <div className="th-section" role="region" aria-label={t('ondemand.title')}>
      <div className="th-section-title">{t('ondemand.title')}</div>
      <Card>
        <div className="th-row-meta">{t('ondemand.hint')}</div>
        {groups.length === 0 ? <Empty title={t('ondemand.empty')} /> : (
          <div className="th-list">
            {groups.map(group => (
              <div className="th-row" key={group.id}>
                <div className="th-row-body">
                  <span className="th-row-name">{group.name}</span>
                  <span className="th-row-meta">
                    <Badge tone={group.onDemand === true ? 'on' : 'off'}>{group.onDemand === true ? t('ondemand.on') : t('ondemand.off')}</Badge>
                    <span>{(group.tools ?? []).length} {lang === 'zh' ? '个工具' : 'tool(s)'}</span>
                  </span>
                  {editing === group.id ? (
                    <Field id={'th-ondemand-' + group.id} label={t('ondemand.tools')}>
                      <textarea id={'th-ondemand-' + group.id} className="th-input" rows={2} value={text} spellCheck={false} aria-label={t('ondemand.tools')} onChange={event => { setText(event.target.value) }} />
                    </Field>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Switch
                    checked={group.onDemand === true}
                    busy={busy === 'group.onDemand:' + group.id}
                    label={t('ondemand.toggle', { name: group.name })}
                    onChange={next => { void run('group.onDemand', { id: group.id, onDemand: next }).then(ok => { if (ok) reload() }) }}
                  />
                  {editing === group.id ? (
                    <>
                      <Button variant="ghost" onClick={() => { setEditing(null) }}>{t('action.cancel')}</Button>
                      <Button variant="primary" busy={busy === 'group.tools:' + group.id} onClick={() => { save(group.id) }}>{t('action.save')}</Button>
                    </>
                  ) : (
                    <Button variant="ghost" onClick={() => { startEdit(group.id, group.tools ?? []) }}>{t('ondemand.tools')}</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {status === '' ? null : <div className="th-row-meta">{status}</div>}
      </Card>
    </div>
  )
}
