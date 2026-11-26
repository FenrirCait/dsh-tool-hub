/**
 * Whether a group is currently on.
 *
 * A group record stores members, not an enabled flag; the truth lives in the live plugin and skill
 * rows. A group is on when every visible member is enabled, partial when only some are, and off
 * when none are. Missing members are ignored for the count but stay visible as stale rows.
 */
import type { GroupRow, HubSnapshot } from './types.js'

export type GroupOnState = 'on' | 'off' | 'partial'
export interface GroupOnCounts {
  state: GroupOnState
  enabled: number
  visible: number
}
export type GroupOnReader = (group: GroupRow) => GroupOnState
export type GroupStatsReader = (group: GroupRow) => GroupOnCounts

export function groupOnStats(snapshot: Pick<HubSnapshot, 'plugins' | 'skills'>, group: GroupRow): GroupOnCounts {
  const pluginOn = new Map(snapshot.plugins.map(row => [row.id, row.enabled]))
  const skillOn = new Map(snapshot.skills.map(row => [row.id, row.enabled]))
  let visible = 0
  let enabled = 0
  for (const member of group.members) {
    const state = member.kind === 'skill' ? skillOn.get(member.id) : pluginOn.get(member.id)
    if (state === undefined) continue
    visible += 1
    if (state) enabled += 1
  }
  const state: GroupOnState = visible === 0 || enabled === 0 ? 'off' : enabled === visible ? 'on' : 'partial'
  return { state, enabled, visible }
}

export function groupOnReader(snapshot: Pick<HubSnapshot, 'plugins' | 'skills'>): GroupOnReader {
  return group => groupOnStats(snapshot, group).state
}

export function groupStatsReader(snapshot: Pick<HubSnapshot, 'plugins' | 'skills'>): GroupStatsReader {
  return group => groupOnStats(snapshot, group)
}