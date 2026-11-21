/**
 * Composer dock: a small badge that opens the panel's sessions view.
 *
 * It reads session.summary once on mount and after a switch; it never polls. The badge only shows
 * when this session has custom switches (mode === custom), because "all off" is already visible in
 * the panel and a zero badge is noise.
 */
import * as React from 'react'
import { runOp } from './api.js'
import { Button } from './components.js'
import { createT, detectLang } from './i18n.js'

export const DOCK_SLOT = 'conversation.composer.dock'
export const DOCK_ORDER = 40

const t = createT(detectLang())

interface Summary {
  enabled: number
  total: number
  disabled: number
  mode: 'all' | 'custom'
}

function summaryOf(value: unknown): Summary | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const num = (key: string): number => (typeof record[key] === 'number' ? record[key] as number : 0)
  return { enabled: num('enabled'), total: num('total'), disabled: num('disabled'), mode: record.mode === 'all' ? 'all' : 'custom' }
}

export interface DockButtonProps {
  sessionId?: string
  onOpen: () => void
}

export function DockButton(props: DockButtonProps): React.ReactElement | null {
  const { sessionId, onOpen } = props
  const [summary, setSummary] = React.useState<Summary | null>(null)

  React.useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') {
      setSummary(null)
      return
    }
    let live = true
    void runOp('session.summary', { sessionId }).then(result => {
      if (!live || !result.ok) return
      setSummary(summaryOf(result.data))
    })
    return () => { live = false }
  }, [sessionId])

  if (typeof sessionId !== 'string' || sessionId === '') return null
  const custom = summary !== null && summary.mode === 'custom' && summary.disabled > 0
  const label = custom ? t('dock.off', { n: summary.disabled }) : t('dock.tools')
  return (
    <Button variant="ghost" onClick={onOpen} label={label}>
      {label}
    </Button>
  )
}

export function dockSummaryForTest(value: unknown): Summary | null {
  return summaryOf(value)
}
