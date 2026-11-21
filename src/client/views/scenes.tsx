/**
 * Scenes: the saved switch sets, the one currently applied, and the lock that freezes them.
 *
 * A locked scene refuses every write that changes the environment it describes, so the banner at
 * the top is the reason the other pages will start saying no. Locking asks first, unlocking does
 * not: one direction is a trap being set, the other a trap being lifted.
 *
 * Every row action carries its name twice: `name` is what the domain reads, `id` what the shell
 * keys its spinner on. Apply and exit restore state, so both ask first (apply only when the
 * `scenes.confirmApply` setting says so, and then the dialog lists the host's own plan line).
 */
import * as React from 'react'
import { OPS } from '../api.js'
import { Badge, Button, Callout, Card, Dialog, Empty } from '../components.js'
import type { ViewProps } from '../types.js'
import { SceneEditor, draftFromEnvironment, draftFromScene, scenePayload, type SceneDraft } from './scene-editor.js'

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** The four section sizes; a legacy numeric record still counts as "members". */
function countsOf(value: unknown): { plugins: number; skills: number; mcp: number; tools: number } {
  if (typeof value === 'number') return { plugins: 0, skills: 0, mcp: 0, tools: value }
  const record = recordOf(value)
  return {
    plugins: listOf(record.plugins).length,
    skills: listOf(record.skills).length,
    mcp: listOf(recordOf(record.mcp).off).length + listOf(recordOf(record.mcp).on).length,
    tools: listOf(recordOf(record.tools).deny).length,
  }
}

function lockedOf(value: unknown): boolean {
  return recordOf(value).locked === true
}

function since(at: number | null, lang: ViewProps['lang']): string {
  if (at === null) return ''
  try {
    return new Date(at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/** What the page is asking the user to confirm, or null. */
interface Pending {
  kind: 'apply' | 'exit' | 'delete' | 'lock'
  name: string
  description: string
}

interface EditorState {
  key: string
  draft: SceneDraft
}

export function ScenesView(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run, runDetailed } = props
  const [pending, setPending] = React.useState<Pending | null>(null)
  const [editor, setEditor] = React.useState<EditorState | null>(null)
  const mode = snapshot.scene.mode
  const names = snapshot.scene.names
  const scenes = snapshot.scene.scenes
  const lockedNames = names.filter(name => lockedOf(scenes[name]))
  const confirmApply = snapshot.settings['settings.scenes.confirmApply'] !== false

  const closeDialog = React.useCallback(() => {
    setPending(null)
  }, [])

  /** Apply asks the host for its plan line first, so the dialog says what will change. */
  const askApply = (name: string): void => {
    if (!confirmApply) {
      void run(OPS.sceneApply, { name, id: name })
      return
    }
    void runDetailed('scene.plan', { name }).then(result => {
      if (!result.ok) return
      const data = recordOf(result.data)
      setPending({ kind: 'apply', name, description: typeof data.description === 'string' ? data.description : '' })
    })
  }

  const confirm = (): void => {
    if (pending === null) return
    const { kind, name } = pending
    setPending(null)
    if (kind === 'apply') void run(OPS.sceneApply, { name, id: name })
    if (kind === 'exit') void run(OPS.sceneExit, {})
    if (kind === 'delete') void run(OPS.sceneDelete, { name, id: name })
    if (kind === 'lock') void run(OPS.sceneLock, { name, locked: true, id: name })
  }

  const saveDraft = (draft: SceneDraft): void => {
    const body = scenePayload(draft)
    void run(OPS.sceneSave, { ...body, id: draft.name.trim() }).then(ok => {
      if (ok) setEditor(null)
    })
  }

  const confirmLabel = pending === null
    ? ''
    : pending.kind === 'apply'
      ? t('action.apply')
      : pending.kind === 'delete'
        ? t('action.delete')
        : pending.kind === 'lock'
          ? t('scenes.lock')
          : t('action.exit')

  return (
    <div>
      {lockedNames.length === 0 ? null : (
        <Callout tone="info">{t('scenes.lockedBanner', { names: lockedNames.join(', ') })}</Callout>
      )}

      <div className="th-section">
        <div className="th-section-title">{t('scenes.current')}</div>
        <Card label={t('scenes.current')}>
          <div className="th-row">
            <div className="th-row-body">
              <span className="th-row-name">{mode ?? t('scenes.none')}</span>
              <span className="th-row-meta">
                {mode !== null && snapshot.scene.since !== null ? <span>{t('scenes.since', { time: since(snapshot.scene.since, lang) })}</span> : null}
                <span>{t('scenes.hint')}</span>
              </span>
            </div>
            {mode === null ? null : (
              <Button
                variant="danger"
                busy={busy === OPS.sceneExit}
                title={lockedNames.includes(mode) ? t('scenes.lockedExit') : undefined}
                onClick={() => {
                  setPending({ kind: 'exit', name: mode, description: '' })
                }}
              >
                {t('action.exit')}
              </Button>
            )}
          </div>
        </Card>
      </div>

      <div className="th-section">
        <div className="th-section-title">{t('scenes.title')}</div>
        <div className="th-toolbar">
          <Button
            variant="primary"
            onClick={() => {
              setEditor({ key: 'new', draft: draftFromEnvironment(snapshot) })
            }}
          >
            {t('scenes.new')}
          </Button>
        </div>
        {names.length === 0 ? (
          <Empty title={t('scenes.empty')} hint={t('scenes.hint')} />
        ) : (
          <Card label={t('scenes.title')}>
            <div className="th-list">
              {names.map(name => {
                const value = scenes[name]
                const counts = countsOf(value)
                const locked = lockedOf(value)
                const isCurrent = mode === name
                return (
                  <div className="th-row" key={name}>
                    <div className="th-row-body">
                      <span className="th-row-name">{name}</span>
                      <span className="th-row-meta">
                        <Badge>{t('scenes.badgePlugins', { n: counts.plugins })}</Badge>
                        <Badge>{t('scenes.badgeSkills', { n: counts.skills })}</Badge>
                        <Badge>{t('scenes.badgeMcp', { n: counts.mcp })}</Badge>
                        <Badge>{t('scenes.badgeTools', { n: counts.tools })}</Badge>
                        {isCurrent ? <Badge tone="on">{t('scenes.current')}</Badge> : null}
                        {locked ? (
                          <span role="img" aria-label={t('scenes.lockedA11y', { name })} title={t('scenes.lockedA11y', { name })}>
                            <Badge tone="warn">{'🔒 ' + t('scenes.locked')}</Badge>
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <Button
                      variant={isCurrent ? 'ghost' : 'primary'}
                      busy={busy === OPS.sceneApply + ':' + name}
                      disabled={isCurrent}
                      onClick={() => {
                        askApply(name)
                      }}
                    >
                      {t('action.apply')}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={locked}
                      title={locked ? t('scenes.lockedEdit') : undefined}
                      onClick={() => {
                        setEditor({ key: 'edit:' + name, draft: draftFromScene(name, value) })
                      }}
                    >
                      {t('action.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      busy={busy === OPS.sceneLock + ':' + name}
                      onClick={() => {
                        if (!locked) {
                          setPending({ kind: 'lock', name, description: '' })
                          return
                        }
                        void run(OPS.sceneLock, { name, locked: false, id: name })
                      }}
                    >
                      {locked ? t('scenes.unlock') : t('scenes.lock')}
                    </Button>
                    <Button
                      variant="danger"
                      busy={busy === OPS.sceneDelete + ':' + name}
                      disabled={isCurrent || locked}
                      title={locked ? t('scenes.lockedEdit') : isCurrent ? t('scenes.deleteActive') : t('scenes.deleteIrreversible')}
                      onClick={() => {
                        setPending({ kind: 'delete', name, description: '' })
                      }}
                    >
                      {t('action.delete')}
                    </Button>
                  </div>
                )
              })}
            </div>
          </Card>
        )}
      </div>

      <Dialog
        open={pending !== null}
        title={t('dialog.confirmTitle')}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              {t('action.cancel')}
            </Button>
            <Button variant={pending !== null && (pending.kind === 'exit' || pending.kind === 'delete') ? 'danger' : 'primary'} onClick={confirm}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        {pending === null ? null : (
          <div>
            <div style={{ marginBottom: 8 }}>{pending.name}</div>
            {pending.kind === 'apply' ? (
              <div>
                <div>{t('scenes.applyConfirm')}</div>
                {pending.description === '' ? null : <div className="th-field-hint">{t('scenes.planLine', { text: pending.description })}</div>}
              </div>
            ) : null}
            {pending.kind === 'exit' ? <div>{t('scenes.exitConfirm', { name: pending.name })}</div> : null}
            {pending.kind === 'delete' ? <div>{t('scenes.deleteConfirm')}</div> : null}
            {pending.kind === 'lock' ? <div>{t('scenes.lockConfirm')}</div> : null}
          </div>
        )}
      </Dialog>

      {editor === null ? null : (
        <SceneEditor
          key={editor.key}
          draft={editor.draft}
          snapshot={snapshot}
          t={t}
          busy={busy}
          onClose={() => {
            setEditor(null)
          }}
          onSave={saveDraft}
        />
      )}
    </div>
  )
}
