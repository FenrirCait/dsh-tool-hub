import type { PluginRow, ViewProps } from '../types.js'
import type { TreeGroup } from './package-tree.js'

export interface OfficialView {
  officialRows: PluginRow[]
  officialIds: Set<string>
  visibleGroups: Array<TreeGroup<PluginRow>>
  visibleRows: PluginRow[]
  officialExpanded: boolean
}

/** Keep the built-in DSH packages behind one collapsible entry. */
export function officialView(groups: Array<TreeGroup<PluginRow>>, showOfficial: boolean, term: string): OfficialView {
  const officialGroups = groups.filter(group => group.rows.length > 0 && group.rows.every(row => row.official === true))
  const officialRows = officialGroups.flatMap(group => group.rows)
  const officialKeys = new Set(officialGroups.map(group => group.key))
  const officialExpanded = showOfficial || term !== ''
  const visibleGroups = officialExpanded ? groups : groups.filter(group => !officialKeys.has(group.key))
  return { officialRows, officialIds: new Set(officialRows.map(row => row.id)), visibleGroups, visibleRows: visibleGroups.flatMap(group => group.rows), officialExpanded }
}
