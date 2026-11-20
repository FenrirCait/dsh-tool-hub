/**
 * Tools: placeholder scaffolded by the shell; the team fills this view next.
 */
import * as React from 'react'
import { Empty } from '../components.js'
import type { ViewProps } from '../types.js'

export function ToolsView(props: ViewProps): React.ReactElement {
  const { snapshot, t } = props
  if (snapshot === null) return <Empty title={t('tools.empty')} />
  return <Empty title={t('tools.title')} hint={t('tools.empty')} />
}
