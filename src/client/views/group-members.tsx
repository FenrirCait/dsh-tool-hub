import * as React from 'react'
import { Badge, Switch } from '../components.js'
import type { GroupRow, ViewProps } from '../types.js'

const MEMBER_TOGGLE = 'toggle'

export interface MemberView {
  key: string
  label: string
  kind: 'plugin' | 'skill' | 'mcp' | 'tool'
  actionKind: 'plugin' | 'skill'
  id: string
  bundleName?: string
  enabled: boolean
  manageable: boolean
  readOnlyReason: string | null
  tools?: Array<{ name: string; enabled: boolean }>
}

export function memberViews(group: GroupRow, snapshot: ViewProps['snapshot']): MemberView[] {
  return group.members.map(member => {
    const key = member.kind + ':' + member.id
    if (member.kind === 'tool') {
      const tool = snapshot.tools.find(row => row.name === member.id)
      return { key, label: tool?.name ?? member.id, kind: 'tool', actionKind: 'plugin', id: member.id, enabled: tool?.enabled === true, manageable: false, readOnlyReason: 'tool member is read-only' }
    }
    if (member.kind === 'skill') {
      const skill = snapshot.skills.find(row => row.id === member.id)
      return { key, label: skill?.name ?? member.id, kind: 'skill', actionKind: 'skill', id: member.id, enabled: skill?.enabled === true, manageable: skill !== undefined, readOnlyReason: skill === undefined ? 'missing skill' : null }
    }
    const plugin = snapshot.plugins.find(row => row.id === member.id)
    const tools = plugin?.mcp === true ? snapshot.tools.filter(tool => tool.name.startsWith('mcp__' + plugin.name + '__')).map(tool => ({ name: tool.name, enabled: tool.enabled })) : undefined
    return { key, label: plugin?.name ?? member.id, kind: plugin?.mcp === true ? 'mcp' : 'plugin', actionKind: 'plugin', id: member.id, enabled: plugin?.enabled === true, manageable: plugin !== undefined && plugin.manageable !== false, readOnlyReason: plugin === undefined ? 'missing plugin' : plugin.readOnlyReason ?? null, ...(plugin?.bundleName === undefined ? {} : { bundleName: plugin.bundleName }), ...(tools === undefined ? {} : { tools }) }
  })
}

export interface GroupMembersProps {
  group: GroupRow
  snapshot: ViewProps['snapshot']
  lang: 'zh' | 'en'
  t: ViewProps['t']
  busy: string | null
  run: ViewProps['run']
}

export function GroupMembers(props: GroupMembersProps): React.ReactElement {
  const { group, snapshot, lang, t, busy, run } = props
  return (
    <div className="th-group-members">
      {memberViews(group, snapshot).map(member => (
        <div className="th-row" key={member.key}>
          <div className="th-row-body">
            <span className="th-row-name">{member.label}</span>
            <span className="th-row-meta">
              <Badge tone={member.kind === 'mcp' ? 'brand' : 'neutral'}>{member.kind}</Badge>
              {member.readOnlyReason === null ? null : <Badge tone="warn">{member.readOnlyReason}</Badge>}
            </span>
            {member.tools === undefined ? null : <div className="th-group-tools">{member.tools.map(tool => <div className="th-row-meta" key={tool.name}><span className="th-row-name">{tool.name}</span><Badge tone={tool.enabled ? 'on' : 'off'}>{tool.enabled ? 'on' : 'off'}</Badge><Badge>{lang === 'zh' ? '只读' : 'read-only'}</Badge></div>)}</div>}
          </div>
          {member.kind === 'tool' || !member.manageable ? <Badge>{lang === 'zh' ? '只读' : 'read-only'}</Badge> : (
            <Switch
              checked={member.enabled}
              busy={busy === 'toggle:' + member.id}
              label={t('a11y.switch', { name: member.label })}
              onChange={next => {
                void run(MEMBER_TOGGLE, { kind: member.actionKind, id: member.id, enabled: next, ...(member.bundleName === undefined ? {} : { bundleName: member.bundleName }) })
              }}
            />
          )}
        </div>
      ))}
    </div>
  )
}