/**
 * Whether a group is currently on.
 *
 * A group record stores members, not an enabled flag; the truth lives in the live plugin and skill
 * rows. A group counts as on when at least one member is visible in the snapshot and every visible
 * member is enabled, so a half-applied batch reads as off instead of pretending to be on.
 */
import type { GroupRow, HubSnapshot } from './types.js'

export type GroupOnReader = (group: GroupRow) => boolean

export function groupOnReader(snapshot: Pick<HubSnapshot, 'plugins' | 'skills'>): GroupOnReader {
  const pluginOn = new Map(snapshot.plugins.map(row => [row.id, row.enabled]))
  const skillOn = new Map(snapshot.skills.map(row => [row.id, row.enabled]))
  return group => {
    let seen = false
    for (const member of group.members) {
      const state = member.kind === 'skill' ? skillOn.get(member.id) : pluginOn.get(member.id)
      if (state === undefined) continue
      seen = true
      if (!state) return false
    }
    return seen
  }
}
