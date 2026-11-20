/**
 * Plugins: every loader entry, its state, and its one switch.
 *
 * The switch is the whole point of the panel, so it is per row, disabled while that row's op
 * is in flight, and disabled with a reason when the host says the row is not manageable.
 */
import * as React from 'react'
import { OPS } from '../api.js'
import { Badge, Button, Card, Empty, SearchBox, Switch } from '../components.js'
import type { ViewProps } from '../types.js'

export function PluginsView(props: ViewProps): React.ReactElement {
  const { snapshot, t, busy, run } = props
  const [query, setQuery] = React.useState('')
  const term = query.trim().toLowerCase()
  const rows = snapshot.plugins.filter(row => {
    if (term === '') return true
    return row.name.toLowerCase().includes(term) || row.id.toLowerCase().includes(term)
  })

  if (snapshot.plugins.length === 0) {
    return <Empty title={t('plugins.empty')} hint={t('app.subtitle')} />
  }

  return (
    <div>
      <div className="th-toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('plugins.search')}
          label={t('plugins.search')}
          onClear={() => {
            setQuery('')
          }}
          clearLabel={t('action.clear')}
        />
        <Badge tone="brand">{t('plugins.count', { n: rows.length })}</Badge>
      </div>
      {rows.length === 0 ? (
        <Empty title={t('plugins.emptyFiltered', { query })} />
      ) : (
        <Card label={t('plugins.title')}>
          <div className="th-list">
            {rows.map(row => {
              const key = `${OPS.toggle}:${row.id}`
              const rowBusy = busy === key
              const disabled = row.manageable === false
              return (
                <div className="th-row" key={row.id}>
                  <div className="th-row-body">
                    <span className="th-row-name">{row.name}</span>
                    <span className="th-row-meta">
                      <span className="th-mono">{row.id}</span>
                      <Badge tone={row.enabled ? 'on' : 'off'}>{row.enabled ? t('state.on') : t('state.off')}</Badge>
                      {row.mcp === true ? <Badge>MCP</Badge> : null}
                      {row.self === true ? <Badge>self</Badge> : null}
                      {row.official === true ? <Badge>official</Badge> : null}
                      {row.phase !== null && row.phase !== 'active' ? <Badge tone="warn">{row.phase}</Badge> : null}
                      {disabled ? <Badge tone="warn">{row.readOnlyReason ?? 'read-only'}</Badge> : null}
                    </span>
                  </div>
                  <Switch
                    checked={row.enabled}
                    busy={rowBusy}
                    disabled={disabled}
                    label={t('a11y.switch', { name: row.name })}
                    onChange={next => {
                      void run(OPS.toggle, { kind: 'plugin', id: row.id, enabled: next })
                    }}
                  />
                </div>
              )
            })}
          </div>
        </Card>
      )}
      <div style={{ marginTop: 12 }}>
        <Button
          variant="ghost"
          onClick={() => {
            void props.reload()
          }}
        >
          {t('action.retry')}
        </Button>
      </div>
    </div>
  )
}
