/**
 * Skills: the folders under every configured root, grouped by root.
 *
 * Root filtering is a select rather than free text, because "which root did this skill come
 * from" is the question the panel has to answer when two roots carry the same name.
 */
import * as React from 'react'
import { OPS } from '../api.js'
import { Badge, Card, Empty, SearchBox, Select, Switch } from '../components.js'
import type { ViewProps } from '../types.js'

export function SkillsView(props: ViewProps): React.ReactElement {
  const { snapshot, t, busy, run } = props
  const [query, setQuery] = React.useState('')
  const [root, setRoot] = React.useState('all')
  const term = query.trim().toLowerCase()

  const roots = snapshot.paths.skills ?? []
  const rootOptions = [
    { value: 'all', label: t('skills.allRoots') },
    ...roots.map(item => ({ value: item.id, label: item.label ?? item.id })),
  ]

  const rows = snapshot.skills.filter(row => {
    if (root !== 'all' && row.rootId !== root) return false
    if (term === '') return true
    return row.name.toLowerCase().includes(term) || row.id.toLowerCase().includes(term)
  })

  if (snapshot.skills.length === 0) {
    return <Empty title={t('skills.empty')} hint={t('skills.root')} />
  }

  return (
    <div>
      <div className="th-toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('skills.search')}
          label={t('skills.search')}
          onClear={() => {
            setQuery('')
          }}
          clearLabel={t('action.clear')}
        />
        <Select id="th-skill-root" value={root} options={rootOptions} onChange={setRoot} label={t('skills.root')} />
        <Badge tone="brand">{t('skills.count', { n: rows.length })}</Badge>
      </div>
      {rows.length === 0 ? (
        <Empty title={t('skills.emptyFiltered', { query })} />
      ) : (
        <Card label={t('skills.title')}>
          <div className="th-list">
            {rows.map(row => {
              const key = `${OPS.toggle}:${row.id}`
              const rowBusy = busy === key
              const rootLabel = roots.find(item => item.id === row.rootId)?.label ?? row.rootId ?? ''
              return (
                <div className="th-row" key={row.id}>
                  <div className="th-row-body">
                    <span className="th-row-name">{row.name}</span>
                    <span className="th-row-meta">
                      {rootLabel === '' ? null : <Badge>{rootLabel}</Badge>}
                      <Badge tone={row.enabled ? 'on' : 'off'}>{row.enabled ? t('state.on') : t('state.off')}</Badge>
                      {row.packs !== undefined && row.packs > 0 ? <Badge>pack</Badge> : null}
                      {row.description !== undefined && row.description !== '' ? (
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.description}</span>
                      ) : null}
                    </span>
                  </div>
                  <Switch
                    checked={row.enabled}
                    busy={rowBusy}
                    label={t('a11y.switch', { name: row.name })}
                    onChange={next => {
                      void run(OPS.toggle, { kind: 'skill', id: row.id, enabled: next })
                    }}
                  />
                </div>
              )
            })}
          </div>
        </Card>
      )}
    </div>
  )
}
