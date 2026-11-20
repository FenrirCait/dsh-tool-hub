/**
 * Scenes: the saved switch sets, and the one currently applied.
 *
 * Exiting a scene restores what was there before, so it is the only action here that asks
 * for confirmation first.
 */
import * as React from 'react'
import { OPS } from '../api.js'
import { Badge, Button, Card, Dialog, Empty } from '../components.js'
import type { HubSnapshot, ViewProps } from '../types.js'

function memberCount(snapshot: HubSnapshot, name: string): number {
  const value = snapshot.scene.scenes[name]
  if (typeof value === 'number') return value
  if (value === null || typeof value !== 'object') return 0
  const record = value as Record<string, unknown>
  let total = 0
  for (const key of ['plugin', 'skill', 'tool']) {
    const list = record[key]
    if (Array.isArray(list)) total += list.length
  }
  return total
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

export function ScenesView(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run } = props
  const [confirming, setConfirming] = React.useState(false)
  const mode = snapshot.scene.mode
  const names = snapshot.scene.names

  const closeDialog = React.useCallback(() => {
    setConfirming(false)
  }, [])

  return (
    <div>
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
                onClick={() => {
                  setConfirming(true)
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
        {names.length === 0 ? (
          <Empty title={t('scenes.empty')} hint={t('scenes.hint')} />
        ) : (
          <Card label={t('scenes.title')}>
            <div className="th-list">
              {names.map(name => {
                const key = `${OPS.sceneApply}:${name}`
                const isCurrent = mode === name
                return (
                  <div className="th-row" key={name}>
                    <div className="th-row-body">
                      <span className="th-row-name">{name}</span>
                      <span className="th-row-meta">
                        <Badge>{t('scenes.members', { n: memberCount(snapshot, name) })}</Badge>
                        {isCurrent ? <Badge tone="on">{t('scenes.current')}</Badge> : null}
                      </span>
                    </div>
                    <Button
                      variant={isCurrent ? 'ghost' : 'primary'}
                      busy={busy === key}
                      disabled={isCurrent}
                      onClick={() => {
                        void run(OPS.sceneApply, { name })
                      }}
                    >
                      {t('action.apply')}
                    </Button>
                  </div>
                )
              })}
            </div>
          </Card>
        )}
      </div>

      <Dialog
        open={confirming}
        title={t('dialog.confirmTitle')}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false)
                void run(OPS.sceneExit, {})
              }}
            >
              {t('action.exit')}
            </Button>
          </>
        }
      >
        {mode === null ? t('scenes.none') : `${t('action.exit')}: ${mode}`}
      </Dialog>
    </div>
  )
}
