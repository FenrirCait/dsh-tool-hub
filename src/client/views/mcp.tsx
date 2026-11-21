/**
 * MCP servers: every loader row that carries the MCP client module, and the config it was given.
 *
 * All five ops here read or write the profile patch, so a row the loader started without a patch
 * id is listed read-only: a row with no config block is nothing this panel may write, and "it is
 * in the file" is exactly what someone checks when a tool went missing.
 */
import * as React from 'react'
import { OPS, runOp } from '../api.js'
import { Badge, Button, Callout, Card, Dialog, Empty, Field, SearchBox, Select, Switch, monoStyle } from '../components.js'
import { McpOauthDialog } from './mcp-oauth.js'
import type { PluginRow, ViewProps } from '../types.js'

/**
 * The ops this view owns, next to the payload each one takes (declared in src/domains/mcp.ts).
 * api.ts only tables the ops the shell sends itself, so the ids live here rather than there.
 */
const MCP_OPS = {
  create: 'mcp.create',
  save: 'mcp.save',
  raw: 'mcp.raw',
  rawSave: 'mcp.rawSave',
  remove: 'mcp.delete',
} as const

/** The transports the host's MCP client accepts; the domain passes the string straight through. */
const TRANSPORTS = ['stdio', 'streamable-http']

/** Server names the domain accepts: 1-32 letters, digits, dash or underscore. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const STACK: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const ACTIONS: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const RAW_BOX: React.CSSProperties = { ...monoStyle, width: '100%', minHeight: 200, resize: 'vertical' }

/** One editable row: the patch row id plus the fields cleanMcpConfig keeps. */
interface Draft {
  id: string
  name: string
  transport: string
  command: string
  args: string
  cwd: string
  url: string
  env: string
  headers: string
}

interface RawState {
  id: string
  text: string
  error: string
  loading: boolean
}

/** The catalogs carry the mcp.* nouns only, so a form caption that is not one is bilingual here. */
function copy(lang: ViewProps['lang'], zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** The patch row id a write needs; '' when the row only exists in the loader. */
function patchIdOf(row: PluginRow): string {
  const direct = row.patchId ?? row.mcpPatchId ?? ''
  return typeof direct === 'string' ? direct : ''
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/** Masked secret maps arrive as { KEY: '' }; the key is shown so a new value can be typed in. */
function pairsText(value: unknown, glue: string): string {
  return Object.keys(asRecord(value)).map(key => key + glue).join('\n')
}

/** A blank value is skipped: to the host, empty means "keep the one already stored". */
function parsePairs(source: string, separator: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf(separator)
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + separator.length).trim()
    if (key === '' || value === '') continue
    out[key] = value
  }
  return out
}

function draftOf(row: PluginRow): Draft {
  const config = asRecord(row.config)
  const declared = stringOf(config, 'serverName')
  const transport = stringOf(config, 'transport')
  return {
    id: patchIdOf(row),
    name: declared === '' ? row.name : declared,
    transport: transport === '' ? 'stdio' : transport,
    command: stringOf(config, 'command'),
    args: Array.isArray(config.args) ? config.args.filter(item => typeof item === 'string').join(' ') : '',
    cwd: stringOf(config, 'cwd'),
    url: stringOf(config, 'url'),
    env: pairsText(config.env, '='),
    headers: pairsText(config.headers, ': '),
  }
}

function emptyDraft(): Draft {
  return { id: '', name: '', transport: 'stdio', command: '', args: '', cwd: '', url: '', env: '', headers: '' }
}

/**
 * Only the keys the domain keeps, in its shape: a filled field is written, a field the user
 * cleared on a row that still carries it becomes null (delete), anything else is left alone.
 */
function buildConfig(draft: Draft, current: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = { serverName: draft.name.trim(), transport: draft.transport }
  for (const key of ['command', 'cwd', 'url'] as const) {
    const value = draft[key].trim()
    if (value !== '') config[key] = value
    else if (stringOf(current, key) !== '') config[key] = null
  }
  const args = draft.args.trim() === '' ? [] : draft.args.trim().split(/\s+/)
  if (args.length > 0) config.args = args
  else if (Array.isArray(current.args) && current.args.length > 0) config.args = null
  const env = parsePairs(draft.env, '=')
  if (Object.keys(env).length > 0) config.env = env
  const headers = parsePairs(draft.headers, ':')
  if (Object.keys(headers).length > 0) config.headers = headers
  return config
}

export function McpView(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run } = props
  const [query, setQuery] = React.useState('')
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [pending, setPending] = React.useState<PluginRow | null>(null)
  const [raw, setRaw] = React.useState<RawState | null>(null)
  const [oauthRow, setOauthRow] = React.useState<PluginRow | null>(null)

  const servers = snapshot.plugins.filter(row => row.mcp === true)
  const term = query.trim().toLowerCase()
  const rows = servers.filter(row => {
    if (term === '') return true
    return row.name.toLowerCase().includes(term) || row.id.toLowerCase().includes(term)
  })
  const patchReady = (snapshot.paths.patch ?? '') !== ''
  const trimmedName = draft === null ? '' : draft.name.trim()
  const nameError =
    draft !== null && trimmedName !== '' && !NAME_PATTERN.test(trimmedName)
      ? copy(lang, '1-32 位字母、数字、- 或 _', '1-32 letters, digits, - or _')
      : undefined
  const canSave = draft !== null && NAME_PATTERN.test(trimmedName)
  const nameHint = copy(lang, '1-32 位字母、数字、- 或 _', '1-32 letters, digits, - or _')

  const closeDraft = React.useCallback(() => { setDraft(null) }, [])
  const closePending = React.useCallback(() => { setPending(null) }, [])
  const closeRaw = React.useCallback(() => { setRaw(null) }, [])

  const edit = (patch: Partial<Draft>): void => {
    setDraft(current => (current === null ? current : { ...current, ...patch }))
  }

  /**
   * A read, not a write: run() reports success and re-reads the snapshot, but the editor needs
   * the row text itself, so this one call goes to the api module directly. Writes stay on run().
   */
  const openRaw = (row: PluginRow): void => {
    const id = patchIdOf(row)
    setRaw({ id, text: '', error: '', loading: true })
    void runOp(MCP_OPS.raw, { id }).then(result => {
      if (!result.ok) {
        setRaw(current => (current === null ? current : { ...current, loading: false, error: result.message }))
        return
      }
      const loaded = asRecord(result.data)
      const text = typeof loaded.text === 'string' ? loaded.text : ''
      setRaw(current => (current === null ? current : { ...current, loading: false, text }))
    })
  }

  const submitDraft = (): void => {
    if (draft === null || !NAME_PATTERN.test(draft.name.trim())) return
    const existing = servers.find(row => patchIdOf(row) === draft.id)
    const config = buildConfig(draft, existing === undefined ? {} : asRecord(existing.config))
    const done = (ok: boolean): void => {
      if (ok) setDraft(null)
    }
    // The shell keys its busy state off payload.id, so a create (no id) reads as just the op.
    if (draft.id === '') void run(MCP_OPS.create, { config }).then(done)
    else void run(MCP_OPS.save, { id: draft.id, config }).then(done)
  }

  const saveRaw = (): void => {
    if (raw === null || raw.text.trim() === '') return
    void run(MCP_OPS.rawSave, { id: raw.id, text: raw.text }).then(ok => {
      if (ok) setRaw(null)
    })
  }

  const textField = (id: string, caption: string, value: string, set: (next: string) => void, hint?: string): React.ReactElement => (
    <Field id={id} label={caption} hint={hint}>
      <input
        id={id}
        className="th-input"
        type="text"
        value={value}
        aria-label={caption}
        spellCheck={false}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          set(event.target.value)
        }}
      />
    </Field>
  )

  const pairField = (id: string, caption: string, value: string, set: (next: string) => void, hint: string): React.ReactElement => (
    <Field id={id} label={caption} hint={hint}>
      <textarea
        id={id}
        className="th-input"
        style={RAW_BOX}
        rows={3}
        spellCheck={false}
        value={value}
        aria-label={caption}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
          set(event.target.value)
        }}
      />
    </Field>
  )

  return (
    <div>
      {snapshot.mcpError === null ? null : <Callout>{t('mcp.patchError', { message: snapshot.mcpError })}</Callout>}
      {patchReady ? null : <Callout tone="info">{t('mcp.patchMissing')}</Callout>}
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
        <Button variant="primary" disabled={!patchReady} onClick={() => { setDraft(emptyDraft()) }}>
          {t('action.create')}
        </Button>
      </div>

      {servers.length === 0 ? (
        <Empty
          title={t('mcp.empty')}
          hint={snapshot.paths.patch ?? t('mcp.patchMissing')}
          action={
            <Button variant="primary" disabled={!patchReady} onClick={() => { setDraft(emptyDraft()) }}>
              {t('action.create')}
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <Empty title={t('mcp.emptyFiltered', { query })} />
      ) : (
        <Card label={t('mcp.title')}>
          <div className="th-list">
            {rows.map(row => {
              const id = patchIdOf(row)
              const editable = patchReady && id !== ''
              const secrets = (row.secretKeys?.env.length ?? 0) + (row.secretKeys?.headers.length ?? 0)
              const command = row.command ?? ''
              const detail = command !== '' ? command : row.url ?? ''
              const rawBusy = raw !== null && raw.loading && raw.id === id
              return (
                <div className="th-row" key={row.id}>
                  <div className="th-row-body">
                    <span className="th-row-name">{row.name}</span>
                    <span className="th-row-meta">
                      <Badge tone={row.enabled ? 'on' : 'off'}>{row.enabled ? t('state.on') : t('state.off')}</Badge>
                      {row.transport === null || row.transport === undefined || row.transport === '' ? null : (
                        <Badge>{row.transport}</Badge>
                      )}
                      {secrets > 0 ? <Badge tone="warn">{t('mcp.secrets', { n: secrets })}</Badge> : null}
                      {id === '' ? <Badge tone="warn">{t('mcp.orphan')}</Badge> : null}
                      {detail === '' ? null : <span className="th-mono">{detail}</span>}
                      {id === '' ? null : <span className="th-mono">{id}</span>}
                    </span>
                  </div>
                  <div style={ACTIONS}>
                    <Switch
                      checked={row.enabled}
                      busy={busy === `${OPS.toggle}:${row.id}`}
                      disabled={row.manageable === false}
                      label={t('a11y.switch', { name: row.name })}
                      onChange={next => {
                        void run(OPS.toggle, { kind: 'plugin', id: row.id, enabled: next })
                      }}
                    />
                    <Button variant="ghost" disabled={!editable} onClick={() => { setDraft(draftOf(row)) }}>
                      {t('action.edit')}
                    </Button>
                    <Button variant="ghost" disabled={!editable} busy={rawBusy} onClick={() => { openRaw(row) }}>
                      {copy(lang, '原文', 'Raw')}
                    </Button>
                    {editable && (row.transport === 'streamable-http' || (row.url ?? '') !== '') ? (
                      <Button variant="ghost" onClick={() => { setOauthRow(row) }}>
                        {t('mcp.oauth')}
                      </Button>
                    ) : null}
                    <Button variant="danger" disabled={!editable} onClick={() => { setPending(row) }}>
                      {t('action.delete')}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <Dialog
        open={draft !== null}
        title={draft !== null && draft.id === '' ? t('action.create') : t('action.edit')}
        onClose={closeDraft}
        footer={
          <>
            <Button variant="ghost" onClick={closeDraft}>{t('action.cancel')}</Button>
            <Button variant="primary" disabled={!canSave} onClick={submitDraft}
              busy={draft !== null && busy === (draft.id === '' ? MCP_OPS.create : `${MCP_OPS.save}:${draft.id}`)}>
              {draft !== null && draft.id === '' ? t('action.create') : t('action.save')}
            </Button>
          </>
        }
      >
        {draft === null ? null : (
          <div style={STACK}>
            {textField('th-mcp-name', copy(lang, '服务器名', 'Server name'), draft.name, next => edit({ name: next }), nameError ?? nameHint)}
            <Field id="th-mcp-transport" label={t('mcp.transport')}>
              <Select
                id="th-mcp-transport"
                value={draft.transport}
                options={TRANSPORTS.map(item => ({ value: item, label: item }))}
                label={t('mcp.transport')}
                onChange={next => {
                  edit({ transport: next })
                }}
              />
            </Field>
            {textField('th-mcp-command', t('mcp.command'), draft.command, next => edit({ command: next }))}
            {textField('th-mcp-args', copy(lang, '命令参数', 'Arguments'), draft.args, next => edit({ args: next }), copy(lang, '用空格分隔', 'Space separated'))}
            {textField('th-mcp-cwd', copy(lang, '工作目录', 'Working directory'), draft.cwd, next => edit({ cwd: next }))}
            {textField('th-mcp-url', 'URL', draft.url, next => edit({ url: next }))}
            {pairField('th-mcp-env', copy(lang, '环境变量', 'Environment'), draft.env, next => edit({ env: next }), copy(lang, '每行 KEY=值；留空表示保留原值', 'One KEY=value per line; blank keeps the stored value'))}
            {pairField('th-mcp-headers', copy(lang, '请求头', 'Headers'), draft.headers, next => edit({ headers: next }), copy(lang, '每行 Name: 值；留空表示保留原值', 'One Name: value per line; blank keeps the stored value'))}
          </div>
        )}
      </Dialog>

      <Dialog
        open={raw !== null}
        title={copy(lang, 'MCP 行原文', 'Raw MCP row')}
        onClose={closeRaw}
        footer={
          <>
            <Button variant="ghost" onClick={closeRaw}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={saveRaw}
              busy={raw !== null && busy === `${MCP_OPS.rawSave}:${raw.id}`}
              disabled={raw === null || raw.loading || raw.text.trim() === ''}>
              {t('action.save')}
            </Button>
          </>
        }
      >
        {raw === null ? null : (
          <div style={STACK}>
            <span className="th-mono">{raw.id}</span>
            {raw.error === '' ? null : <Callout>{raw.error}</Callout>}
            {raw.loading ? <span className="th-field-hint">{t('a11y.busy')}</span> : null}
            <Field
              id="th-mcp-raw"
              label={copy(lang, '这一行在 patch 文件里的原文', 'The row exactly as the patch file holds it')}
              hint={copy(lang, 'id 与缩进必须保持不变；空内容会被拒绝。', 'The id and indentation must stay as they are; an empty buffer is rejected.')}
            >
              <textarea
                id="th-mcp-raw"
                className="th-input"
                style={RAW_BOX}
                rows={12}
                spellCheck={false}
                value={raw.text}
                aria-label={copy(lang, 'MCP 行原文', 'MCP row text')}
                aria-busy={raw.loading}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                  const next = event.target.value
                  setRaw(current => (current === null ? current : { ...current, text: next }))
                }}
              />
            </Field>
          </div>
        )}
      </Dialog>

      <Dialog
        open={pending !== null}
        title={t('dialog.confirmTitle')}
        onClose={closePending}
        footer={
          <>
            <Button variant="ghost" onClick={closePending}>{t('action.cancel')}</Button>
            <Button
              variant="danger"
              busy={pending !== null && busy === `${MCP_OPS.remove}:${patchIdOf(pending)}`}
              onClick={() => {
                if (pending === null) return
                const id = patchIdOf(pending)
                setPending(null)
                void run(MCP_OPS.remove, { id })
              }}
            >
              {t('action.delete')}
            </Button>
          </>
        }
      >
        {pending === null ? null : `${t('action.delete')}: ${pending.name}`}
      </Dialog>

      <McpOauthDialog
        open={oauthRow !== null}
        row={oauthRow}
        id={oauthRow === null ? '' : patchIdOf(oauthRow)}
        t={t}
        busy={busy}
        run={run}
        onClose={() => { setOauthRow(null) }}
      />
    </div>
  )
}
