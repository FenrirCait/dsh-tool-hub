/**
 * Presets: placeholder scaffolded by the shell; the team fills this view next.
 */
import * as React from 'react'
import { Empty } from '../components.js'
import type { ViewProps } from '../types.js'

export function PresetsView(props: ViewProps): React.ReactElement {
  const { snapshot, t } = props
  if (snapshot === null) return <Empty title={t('presets.empty')} />
  return <Empty title={t('presets.title')} hint={t('presets.empty')} />
}
