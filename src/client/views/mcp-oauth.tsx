/**
 * The MCP OAuth dialog: start a login, show the authorize URL, accept the pasted callback.
 *
 * The token never comes back to the browser: oauthFinish stores it in the row's Authorization
 * header and the reply is just { id, saved }. Closing the dialog cancels the pending login so an
 * abandoned state cannot be completed later by accident.
 */
import * as React from 'react'
import { runOp } from '../api.js'
import { Button, Callout, Dialog, Field } from '../components.js'
import type { PluginRow, ViewProps } from '../types.js'

const OPS = {
  start: 'mcp.oauthStart',
  finish: 'mcp.oauthFinish',
  cancel: 'mcp.oauthCancel',
} as const

interface OauthState {
  authorizeUrl: string
  state: string
  input: string
  loading: boolean
  error: string
}

export interface McpOauthDialogProps {
  open: boolean
  row: PluginRow | null
  id: string
  t: ViewProps['t']
  busy: string | null
  run: ViewProps['run']
  onClose: () => void
}

export function McpOauthDialog(props: McpOauthDialogProps): React.ReactElement {
  const { open, row, id, t, busy, run, onClose } = props
  const [oauth, setOauth] = React.useState<OauthState | null>(null)

  React.useEffect(() => {
    if (!open || row === null || id === '') {
      setOauth(null)
      return
    }
    setOauth({ authorizeUrl: '', state: '', input: '', loading: true, error: '' })
    let live = true
    // Discovery and dynamic registration are network reads; give them more than the default 15s.
    void runOp(OPS.start, { id }, 60000).then(result => {
      if (!live) return
      if (!result.ok) {
        setOauth(current => (current === null ? current : { ...current, loading: false, error: result.message }))
        return
      }
      const data = result.data !== null && typeof result.data === 'object' ? result.data as Record<string, unknown> : {}
      setOauth(current => current === null ? current : ({
        ...current,
        loading: false,
        authorizeUrl: typeof data.authorizeUrl === 'string' ? data.authorizeUrl : '',
        state: typeof data.state === 'string' ? data.state : '',
      }))
    })
    return () => { live = false }
  }, [open, row, id])

  const close = (): void => {
    const state = oauth?.state ?? ''
    if (state !== '') void runOp(OPS.cancel, { state })
    onClose()
  }

  const finish = (): void => {
    if (oauth === null || oauth.state === '' || oauth.input.trim() === '') return
    void run(OPS.finish, { state: oauth.state, code: oauth.input.trim() }).then(ok => {
      if (ok) onClose()
    })
  }

  return (
    <Dialog
      open={open}
      title={t('mcp.oauthTitle')}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>{t('action.cancel')}</Button>
          <Button
            variant="primary"
            disabled={oauth === null || oauth.state === '' || oauth.input.trim() === ''}
            busy={busy === OPS.finish}
            onClick={finish}
          >
            {t('mcp.oauthFinish')}
          </Button>
        </>
      }
    >
      {oauth === null ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="th-row-meta">{t('mcp.oauthHint')}</div>
          {oauth.loading ? <div className="th-row-meta">{t('state.loading')}</div> : null}
          {oauth.error === '' ? null : <Callout tone="error">{t('mcp.oauthFailed', { message: oauth.error })}</Callout>}
          <Field id="th-mcp-oauth-url" label={t('mcp.oauthUrl')}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input id="th-mcp-oauth-url" className="th-input" type="text" readOnly value={oauth.authorizeUrl} aria-label={t('mcp.oauthUrl')} />
              <Button
                variant="ghost"
                disabled={oauth.authorizeUrl === ''}
                onClick={() => {
                  if (oauth.authorizeUrl !== '') window.open(oauth.authorizeUrl, '_blank', 'noopener')
                }}
              >
                {t('mcp.oauthOpen')}
              </Button>
            </div>
          </Field>
          <Field id="th-mcp-oauth-code" label={t('mcp.oauthCode')}>
            <textarea
              id="th-mcp-oauth-code"
              className="th-input"
              rows={3}
              spellCheck={false}
              value={oauth.input}
              aria-label={t('mcp.oauthCode')}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                const next = event.target.value
                setOauth(current => (current === null ? current : { ...current, input: next }))
              }}
            />
          </Field>
        </div>
      )}
    </Dialog>
  )
}
