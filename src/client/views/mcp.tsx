/**
 * MCP servers: the rows whose loader entry carries a server config.
 *
 * A server can exist in the patch file but not in the loader; those orphans are listed too,
 * because "it is in the file" is exactly what a user checks when a tool went missing.
 */
import * as React from 'react'
import { OPS } from '../api.js'
import { Badge, Callout, Card, Empty, SearchBox, Switch } from '../components.js'
import type { ViewProps } from '../types.js'

export function McpView(props: ViewProps): React.ReactElement {
  const { snapshot, t, busy, run } = props
  const [query, setQuery] = React.useState('')
  const term = query.trim().toLowerCase()
  const servers = snapshot.plugins.filter(row => row.mcp === true)
  const rows = servers.filter(row => {
    if (term === '') return true
    return row.name.toLowerCase().includes(term) || row.id.toLowerCase().includes(term)
  })

  const patchMissing = snapshot.paths.patch === null || snapshot.paths.patch === ''

  return (
    <div>
      {snapshot.mcpError === null ? null : <Callout>{t('mcp.patchError', { message: snapshot.mcpError })}</Callout>}
      {patchMissing ? <Callout tone="info">{t('mcp.patchMissing')}</Callout> : null}
      <div className="th-toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('mcp.search')}
          label={t('mcp.search')}
          onClear={() => {
            setQuery('')
          }}
          clearLabel={t('action.clear')}
        />
        <Badge tone="brand">{t('mcp.count', { n: rows.length })}</Badge>
      </div>
      {servers.length === 0 ? (
        <Empty title={t('mcp.empty')} hint={snapshot.paths.patch ?? t('mcp.patchMissing')} />
      ) : rows.length === 0 ? (
        <Empty title={t('mcp.emptyFiltered', { query })} />
      ) : (
        <Card label={t('mcp.title')}>
          <div className="th-list">
            {rows.map(row => {
              const key = `${OPS.toggle}:${row.id}`
              const rowBusy = busy === key
              const secrets = (row.secretKeys?.env.length ?? 0) + (row.secretKeys?.headers.length ?? 0)
              const detail = row.command !== null && row.command !== undefined && row.command !== '' ? row.command : row.url
              return (
                <div className="th-row" key={row.id}>
                  <div className="th-row-body">
                    <span className="th-row-name">{row.name}</span>
                    <span className="th-row-meta">
                      <Badge tone={row.enabled ? 'on' : 'off'}>{row.enabled ? t('state.on') : t('state.off')}</Badge>
                      {row.transport !== null && row.transport !== undefined ? <Badge>{row.transport}</Badge> : null}
                      {secrets > 0 ? <Badge tone="warn">{t('mcp.secrets', { n: secrets })}</Badge> : null}
                      {row.manageable === false ? <Badge>{t('mcp.orphan')}</Badge> : null}
                      {detail !== null && detail !== undefined && detail !== '' ? <span className="th-mono">{detail}</span> : null}
                      {row.mcpPatchId !== null && row.mcpPatchId !== undefined ? (
                        <span className="th-mono">{row.mcpPatchId}</span>
                      ) : null}
                    </span>
                  </div>
                  <Switch
                    checked={row.enabled}
                    busy={rowBusy}
                    disabled={row.manageable === false}
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
    </div>
  )
}
