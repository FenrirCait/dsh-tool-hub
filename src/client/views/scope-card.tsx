/**
 * Tool scope controls: one session allow list, one workspace deny override, one subagent policy.
 *
 * All three are writes through props.run (audited host ops), and each field is a plain list of
 * tool names separated by spaces, commas or newlines. Nothing here changes the installation mask.
 */
import * as React from 'react'
import { Button, Callout, Card, Field } from '../components.js'
import type { ViewProps } from '../types.js'

function namesOf(text: string): string[] {
  return text.split(/[\s,]+/u).map(name => name.trim()).filter(name => name !== '')
}

export function ScopeCard(props: ViewProps): React.ReactElement {
  const { t, busy, run } = props
  const [sessionId, setSessionId] = React.useState('')
  const [allowText, setAllowText] = React.useState('')
  const [workspace, setWorkspace] = React.useState('')
  const [workspaceText, setWorkspaceText] = React.useState('')
  const [subagentDeny, setSubagentDeny] = React.useState('')
  const [subagentAllow, setSubagentAllow] = React.useState('')
  const [status, setStatus] = React.useState('')

  const saveSession = (): void => {
    if (sessionId.trim() === '') return
    void run('session.allow', { sessionId: sessionId.trim(), allow: namesOf(allowText) }).then(ok => {
      if (ok) setStatus(t('scope.saved'))
    })
  }

  const saveWorkspace = (): void => {
    if (workspace.trim() === '') return
    void run('scope.workspace', { workspace: workspace.trim(), names: namesOf(workspaceText) }).then(ok => {
      if (ok) setStatus(t('scope.saved'))
    })
  }

  const saveSubagent = (): void => {
    void run('scope.subagent', { deny: namesOf(subagentDeny), allow: namesOf(subagentAllow) }).then(ok => {
      if (ok) setStatus(t('scope.saved'))
    })
  }

  return (
    <div className="th-section" role="region" aria-label={t('scope.title')}>
      <div className="th-section-title">{t('scope.title')}</div>
      <Card>
        <div className="th-row-meta">{t('scope.hint')}</div>

        <div className="th-row-body" style={{ marginTop: 10 }}>
          <span className="th-row-name">{t('scope.session')}</span>
          <Field id="th-scope-session" label={t('scope.sessionId')}>
            <input id="th-scope-session" className="th-input" type="text" value={sessionId} spellCheck={false} aria-label={t('scope.sessionId')} onChange={event => { setSessionId(event.target.value) }} />
          </Field>
          <Field id="th-scope-allow" label={t('scope.allow')} hint={t('scope.allowHint')}>
            <textarea id="th-scope-allow" className="th-input" rows={2} value={allowText} spellCheck={false} aria-label={t('scope.allow')} onChange={event => { setAllowText(event.target.value) }} />
          </Field>
          <Button variant="ghost" busy={busy === 'session.allow'} disabled={sessionId.trim() === ''} onClick={saveSession}>{t('action.save')}</Button>
        </div>

        <div className="th-row-body" style={{ marginTop: 10 }}>
          <span className="th-row-name">{t('scope.workspace')}</span>
          <Field id="th-scope-workspace" label={t('scope.workspaceKey')} hint={t('scope.workspaceHint')}>
            <input id="th-scope-workspace" className="th-input" type="text" value={workspace} spellCheck={false} aria-label={t('scope.workspaceKey')} onChange={event => { setWorkspace(event.target.value) }} />
          </Field>
          <Field id="th-scope-workspace-deny" label={t('scope.deny')}>
            <textarea id="th-scope-workspace-deny" className="th-input" rows={2} value={workspaceText} spellCheck={false} aria-label={t('scope.deny')} onChange={event => { setWorkspaceText(event.target.value) }} />
          </Field>
          <Button variant="ghost" busy={busy === 'scope.workspace'} disabled={workspace.trim() === ''} onClick={saveWorkspace}>{t('action.save')}</Button>
        </div>

        <div className="th-row-body" style={{ marginTop: 10 }}>
          <span className="th-row-name">{t('scope.subagent')}</span>
          <Field id="th-scope-subagent-deny" label={t('scope.deny')} hint={t('scope.subagentHint')}>
            <textarea id="th-scope-subagent-deny" className="th-input" rows={2} value={subagentDeny} spellCheck={false} aria-label={t('scope.subagent')} onChange={event => { setSubagentDeny(event.target.value) }} />
          </Field>
          <Field id="th-scope-subagent-allow" label={t('scope.allow')}>
            <textarea id="th-scope-subagent-allow" className="th-input" rows={2} value={subagentAllow} spellCheck={false} aria-label={t('scope.allow')} onChange={event => { setSubagentAllow(event.target.value) }} />
          </Field>
          <Button variant="ghost" busy={busy === 'scope.subagent'} onClick={saveSubagent}>{t('action.save')}</Button>
        </div>

        {status === '' ? null : <Callout>{status}</Callout>}
      </Card>
    </div>
  )
}
