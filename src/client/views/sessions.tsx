/**
 * Sessions: one tool overlay per session, plus the lineage that carries it down.
 *
 * An overlay switches mcp__ tools off for one session and for every session below it, so this
 * page lists sessions and the names each one masks. Editing replaces one overlay wholesale
 * (session.set), clearing drops only that entry (session.clear), and tracing asks the host to
 * resolve the ancestry a child inherits from (session.lineage, read-only).
 *
 * The shell derives its busy key from payload.id, so each payload carries the session id twice:
 * sessionId is what the domain reads, id is what the per-row indicator keys on.
 */
import * as React from 'react'
import { Badge, Button, Card, Dialog, Empty, Field, SearchBox, Switch } from '../components.js'
import type { ViewProps } from '../types.js'

/** The three ops the sessions domain declares; the ids are the domain's, not invented here. */
const OP_SET = 'session.set'
const OP_CLEAR = 'session.clear'
const OP_LINEAGE = 'session.lineage'

/** The domain keeps only names under this prefix, so the editor offers only those. */
const MCP_PREFIX = 'mcp__'

/** What the editor holds while its dialog is open. */
interface Draft {
  sessionId: string
  names: string[]
}

/** Payload for every op: sessionId for the domain, id for the shell's busy key. */
function payloadOf(sessionId: string): { id: string; sessionId: string } {
  return { id: sessionId, sessionId }
}

/** One-off labels the catalogs do not carry; everything else comes from t(). */
function label(lang: ViewProps['lang'], zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

/** The names one session masks; a session without an entry masks nothing. */
function namesOf(overlays: Record<string, string[]>, sessionId: string): string[] {
  const names = overlays[sessionId]
  return names === undefined ? [] : names
}

export function SessionsView(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run } = props
  const [query, setQuery] = React.useState('')
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [typedName, setTypedName] = React.useState('')
  const [nameError, setNameError] = React.useState<string | null>(null)
  const [clearing, setClearing] = React.useState<string | null>(null)
  const [tracing, setTracing] = React.useState<string | null>(null)

  const overlays = snapshot.sessions
  const ids = Object.keys(overlays).sort()
  const term = query.trim().toLowerCase()
  const rows = ids.filter(id => term === '' || id.toLowerCase().includes(term))

  const closeDraft = React.useCallback(() => {
    setDraft(null)
    setTypedName('')
    setNameError(null)
  }, [])
  const closeClear = React.useCallback(() => {
    setClearing(null)
  }, [])
  const closeTrace = React.useCallback(() => {
    setTracing(null)
  }, [])

  const openCreate = (): void => {
    setTypedName('')
    setNameError(null)
    setDraft({ sessionId: '', names: [] })
  }

  const openEdit = (sessionId: string): void => {
    setTypedName('')
    setNameError(null)
    setDraft({ sessionId, names: [...namesOf(overlays, sessionId)] })
  }

  /** Candidate switches: the host's MCP tools plus whatever this draft already names. */
  const candidates = React.useMemo(() => {
    const known = snapshot.tools.filter(row => row.name.startsWith(MCP_PREFIX)).map(row => row.name)
    const extra = draft === null ? [] : draft.names
    return [...new Set([...known, ...extra])].sort()
  }, [snapshot.tools, draft])

  const toggleName = (name: string, on: boolean): void => {
    setDraft(current => {
      if (current === null) return current
      const kept = current.names.filter(item => item !== name)
      return { sessionId: current.sessionId, names: on ? [...kept, name].sort() : kept }
    })
  }

  const addTypedName = (): void => {
    const name = typedName.trim()
    if (name === '') return
    if (!name.startsWith(MCP_PREFIX)) {
      setNameError(label(lang, '名称必须以 mcp__ 开头', 'A name must start with mcp__'))
      return
    }
    setNameError(null)
    setTypedName('')
    toggleName(name, true)
  }

  /** session.set replaces the whole overlay; an empty list removes the entry host-side. */
  const saveDraft = (): void => {
    if (draft === null) return
    const sessionId = draft.sessionId.trim()
    if (sessionId === '') return
    void run(OP_SET, { ...payloadOf(sessionId), names: draft.names }).then(ok => {
      if (ok) closeDraft()
    })
  }

  /** session.clear runs only from the confirmation dialog below, never from the row. */
  const confirmClear = (): void => {
    if (clearing === null) return
    const sessionId = clearing
    void run(OP_CLEAR, payloadOf(sessionId)).then(ok => {
      if (ok) setClearing(null)
    })
  }

  /** session.lineage is read-only: it makes the host re-resolve the chain and refresh the mask. */
  const confirmTrace = (): void => {
    if (tracing === null) return
    const sessionId = tracing.trim()
    if (sessionId === '') return
    void run(OP_LINEAGE, payloadOf(sessionId)).then(ok => {
      if (ok) setTracing(null)
    })
  }

  const setKey = draft === null ? null : `${OP_SET}:${draft.sessionId.trim()}`
  const clearKey = clearing === null ? null : `${OP_CLEAR}:${clearing}`
  const traceKey = tracing === null ? null : `${OP_LINEAGE}:${tracing.trim()}`
  const traceNames = tracing === null ? [] : namesOf(overlays, tracing.trim())
  const traceLabel = label(lang, '会话血缘', 'Session lineage')
  const idLabel = label(lang, '会话 id', 'Session id')

  return (
    <div>
      <div className="th-toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('sessions.search')}
          label={t('sessions.search')}
          onClear={() => {
            setQuery('')
          }}
          clearLabel={t('action.clear')}
        />
        <Badge tone="brand">{t('sessions.count', { n: rows.length })}</Badge>
        <Button variant="primary" onClick={openCreate} label={t('action.create')}>
          {t('action.create')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setTracing('')
          }}
          label={traceLabel}
        >
          {traceLabel}
        </Button>
      </div>

      {ids.length === 0 ? (
        <Empty
          title={t('sessions.empty')}
          hint={t('sessions.hint')}
          action={<Button onClick={openCreate}>{t('action.create')}</Button>}
        />
      ) : rows.length === 0 ? (
        <Empty title={label(lang, `没有匹配“${query.trim()}”的覆盖`, `No overlay matches “${query.trim()}”`)} />
      ) : (
        <Card label={t('sessions.title')}>
          <div className="th-list">
            {rows.map(sessionId => {
              const names = namesOf(overlays, sessionId)
              return (
                <div className="th-row" key={sessionId}>
                  <div className="th-row-body">
                    <span className="th-row-name">
                      <span className="th-mono">{sessionId}</span>
                    </span>
                    <span className="th-row-meta">
                      <Badge tone={names.length === 0 ? 'warn' : 'off'}>{t('sessions.overlay', { n: names.length })}</Badge>
                      {names.map(name => (
                        <Badge key={name} tone="off">
                          {name}
                        </Badge>
                      ))}
                    </span>
                  </div>
                  <Button onClick={() => openEdit(sessionId)} label={`${t('action.edit')} ${sessionId}`}>
                    {t('action.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setTracing(sessionId)
                    }}
                    label={`${traceLabel} ${sessionId}`}
                  >
                    {label(lang, '追溯', 'Trace')}
                  </Button>
                  <Button
                    variant="danger"
                    busy={busy === `${OP_CLEAR}:${sessionId}`}
                    onClick={() => {
                      setClearing(sessionId)
                    }}
                    label={`${t('sessions.clear')} ${sessionId}`}
                  >
                    {t('sessions.clear')}
                  </Button>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <Dialog
        open={draft !== null}
        title={draft === null ? t('sessions.title') : `${t('sessions.title')} · ${draft.sessionId.trim() === '' ? label(lang, '新覆盖', 'New overlay') : draft.sessionId.trim()}`}
        onClose={closeDraft}
        footer={
          <>
            <Button variant="ghost" onClick={closeDraft}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="primary"
              busy={setKey !== null && busy === setKey}
              disabled={draft === null || draft.sessionId.trim() === ''}
              onClick={saveDraft}
            >
              {t('action.save')}
            </Button>
          </>
        }
      >
        {draft === null ? null : (
          <>
            <Field id="th-session-id" label={t('sessions.workspace')} hint={t('sessions.hint')}>
              <input
                id="th-session-id"
                className="th-input"
                type="text"
                value={draft.sessionId}
                placeholder={idLabel}
                aria-describedby="th-session-id-hint"
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                  const value = event.target.value
                  setDraft(current => (current === null ? current : { sessionId: value, names: current.names }))
                }}
              />
            </Field>

            <div className="th-section" role="group" aria-label={label(lang, '屏蔽的 MCP 工具', 'Masked MCP tools')}>
              <div className="th-section-title">{label(lang, '屏蔽的 MCP 工具', 'Masked MCP tools')}</div>
              {candidates.length === 0 ? (
                <p className="th-field-hint">
                  {label(lang, '宿主没有报告任何 MCP 工具；可以手动添加名称。', 'The host reports no MCP tool; add a name by hand.')}
                </p>
              ) : (
                <div className="th-list">
                  {candidates.map(name => (
                    <div className="th-row" key={name}>
                      <div className="th-row-body">
                        <span className="th-row-name th-mono">{name}</span>
                      </div>
                      <Switch
                        checked={draft.names.includes(name)}
                        label={t('a11y.switch', { name })}
                        onChange={next => {
                          toggleName(name, next)
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Field
              id="th-session-name"
              label={label(lang, '添加工具名', 'Add a tool name')}
              error={nameError === null ? undefined : nameError}
            >
              <div className="th-toolbar">
                <input
                  id="th-session-name"
                  className="th-input"
                  type="text"
                  value={typedName}
                  placeholder="mcp__server__tool"
                  aria-describedby={nameError === null ? undefined : 'th-session-name-error'}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    setTypedName(event.target.value)
                    setNameError(null)
                  }}
                />
                <Button onClick={addTypedName} label={label(lang, '添加', 'Add')}>
                  {label(lang, '添加', 'Add')}
                </Button>
              </div>
            </Field>
          </>
        )}
      </Dialog>

      <Dialog
        open={tracing !== null}
        title={traceLabel}
        onClose={closeTrace}
        footer={
          <>
            <Button variant="ghost" onClick={closeTrace}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="primary"
              busy={traceKey !== null && busy === traceKey}
              disabled={tracing === null || tracing.trim() === ''}
              onClick={confirmTrace}
            >
              {label(lang, '追溯', 'Trace')}
            </Button>
          </>
        }
      >
        {tracing === null ? null : (
          <>
            <Field id="th-lineage-id" label={t('sessions.workspace')} hint={t('sessions.hint')}>
              <input
                id="th-lineage-id"
                className="th-input"
                type="text"
                value={tracing}
                placeholder={idLabel}
                aria-describedby="th-lineage-id-hint"
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                  setTracing(event.target.value)
                }}
              />
            </Field>
            <p className="th-field-hint">
              {label(lang, '宿主沿父链（最多 8 层）解析该会话的覆盖，并刷新工具面。', 'The host resolves this session over its parent chain (up to 8 levels) and refreshes the tool mask.')}
            </p>
            {traceNames.length === 0 ? (
              <p className="th-field-hint">{label(lang, '该会话没有自己的覆盖，只继承上游。', 'This session has no overlay of its own; it only inherits.')}</p>
            ) : (
              <span className="th-row-meta">
                {traceNames.map(name => (
                  <Badge key={name} tone="off">
                    {name}
                  </Badge>
                ))}
              </span>
            )}
          </>
        )}
      </Dialog>

      <Dialog
        open={clearing !== null}
        title={t('dialog.confirmTitle')}
        onClose={closeClear}
        footer={
          <>
            <Button variant="ghost" onClick={closeClear}>
              {t('action.cancel')}
            </Button>
            <Button variant="danger" busy={clearKey !== null && busy === clearKey} onClick={confirmClear} label={t('sessions.clear')}>
              {t('action.confirm')}
            </Button>
          </>
        }
      >
        {clearing === null ? null : (
          <>
            <div>{`${t('sessions.clear')} · ${clearing}`}</div>
            <div className="th-field-hint">{t('sessions.hint')}</div>
          </>
        )}
      </Dialog>
    </div>
  )
}
