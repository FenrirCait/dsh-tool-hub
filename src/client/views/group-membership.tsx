import * as React from 'react'
import { Badge, Button, Dialog, SearchBox } from '../components.js'
import type { BundleRow, GroupRow, ViewProps } from '../types.js'

interface Member { kind: 'plugin' | 'skill'; id: string }

export interface GroupMemberRef {
  kind: 'plugin' | 'skill'
  id: string
  name: string
  mcp?: boolean
  bundleName?: string
  bundleRows?: string[]
  manageable?: boolean
}

interface Candidate {
  key: string
  label: string
  kind: 'bundle' | 'plugin' | 'skill' | 'mcp'
  members: Member[]
  bundleName?: string
  manageable: boolean
}

interface Props {
  open: boolean
  mode: 'member' | 'group'
  groups: GroupRow[]
  snapshot: ViewProps['snapshot']
  member?: GroupMemberRef
  group?: GroupRow
  lang: 'zh' | 'en'
  t: ViewProps['t']
  busy: string | null
  run: ViewProps['run']
  onClose: () => void
}

const GROUP_OPS = { add: 'group.add', remove: 'group.remove', save: 'group.save' } as const
const keyOf = (kind: string, id: string): string => kind + ':' + id

/** Bundle owner by plugin id; the same row can only belong to the first bundle naming it. */
function bundleOwners(snapshot: ViewProps['snapshot']): Map<string, BundleRow> {
  const owners = new Map<string, BundleRow>()
  for (const bundle of snapshot.bundles) {
    for (const id of bundle.rows) if (!owners.has(id)) owners.set(id, bundle)
  }
  return owners
}

function candidatesOf(snapshot: ViewProps['snapshot']): Candidate[] {
  const owners = bundleOwners(snapshot)
  const byId = new Map(snapshot.plugins.map(row => [row.id, row]))
  const bundles = snapshot.bundles.flatMap((bundle): Candidate[] => {
    const rows = bundle.rows.filter(id => byId.has(id))
    if (rows.length === 0) return []
    return [{
      key: 'bundle:' + bundle.name,
      label: bundle.name,
      kind: 'bundle' as const,
      members: rows.map(id => ({ kind: 'plugin' as const, id })),
      bundleName: bundle.name,
      manageable: rows.every(id => byId.get(id)?.manageable !== false),
    }]
  })
  const loosePlugins = snapshot.plugins
    .filter(row => !owners.has(row.id) && row.bundleName === undefined)
    .map(row => ({
      key: keyOf('plugin', row.id),
      label: row.name,
      kind: row.mcp === true ? 'mcp' as const : 'plugin' as const,
      members: [{ kind: 'plugin' as const, id: row.id }],
      manageable: row.manageable !== false,
    }))
  const skills = snapshot.skills.map(row => ({
    key: keyOf('skill', row.id),
    label: row.name,
    kind: 'skill' as const,
    members: [{ kind: 'skill' as const, id: row.id }],
    manageable: true,
  }))
  return [...bundles, ...loosePlugins, ...skills].sort((left, right) => left.label.localeCompare(right.label))
}

function memberIds(member: GroupMemberRef): Member[] {
  if (member.bundleRows !== undefined && member.bundleRows.length > 0) return member.bundleRows.map(id => ({ kind: 'plugin' as const, id }))
  return [{ kind: member.mcp === true ? 'plugin' : member.kind, id: member.id }]
}

function hasMember(group: GroupRow, member: GroupMemberRef): boolean {
  const wanted = new Set(memberIds(member).map(row => keyOf(row.kind, row.id)))
  return group.members.some(row => wanted.has(keyOf(row.kind, row.id)))
}

export function GroupMembershipDialog(props: Props): React.ReactElement {
  const { open, mode, groups, snapshot, member, group, lang, t, busy, run, onClose } = props
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [newName, setNewName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    if (!open) return
    setQuery('')
    setNewName('')
    setError('')
    if (mode === 'member' && member !== undefined) {
      setSelected(new Set(groups.filter(row => hasMember(row, member)).map(row => row.id)))
      return
    }
    if (mode === 'group' && group !== undefined) {
      const byMember = new Map(candidatesOf(snapshot).flatMap(candidate => candidate.members.map(item => [keyOf(item.kind, item.id), candidate.key])))
      setSelected(new Set(group.members.filter(row => row.kind !== 'tool').flatMap(row => {
        const key = byMember.get(keyOf(row.kind, row.id))
        return key === undefined ? [] : [key]
      })))
      return
    }
    setSelected(new Set())
  }, [open, mode, member?.id, member?.mcp, member?.bundleName, group?.id, groups.length, snapshot.plugins.length, snapshot.bundles.length])

  const term = query.trim().toLowerCase()
  const allCandidates = candidatesOf(snapshot)
  const candidates = allCandidates.filter(row => term === '' || row.label.toLowerCase().includes(term) || row.key.toLowerCase().includes(term))
  const groupsShown = groups.filter(row => term === '' || row.name.toLowerCase().includes(term) || row.id.toLowerCase().includes(term))
  const toggle = (key: string): void => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const close = (): void => { if (!saving) onClose() }
  const write = async (op: string, payload: Record<string, unknown>, label: string): Promise<boolean> => {
    const ok = await run(op, payload)
    if (!ok) setError(label + (lang === 'zh' ? '失败，已停止后续写入。' : ' failed; later writes were stopped.'))
    return ok
  }

  const commit = async (): Promise<void> => {
    if (busy !== null || saving) return
    setSaving(true)
    setError('')
    try {
      if (mode === 'member' && member !== undefined) {
        if (member.manageable === false) {
          setError(lang === 'zh' ? '这个条目是只读的，不能加入分组。' : 'This entry is read-only and cannot join a group.')
          return
        }
        const members = memberIds(member)
        for (const row of groups) {
          const wanted = selected.has(row.id)
          const current = hasMember(row, member)
          if (wanted === current && !(wanted && member.bundleRows !== undefined)) continue
          if (wanted) {
            if (!await write(GROUP_OPS.add, { id: row.id, members }, lang === 'zh' ? '加入 ' + row.name : 'Add to ' + row.name)) return
          } else if (!await write(GROUP_OPS.remove, { id: row.id, members }, lang === 'zh' ? '移出 ' + row.name : 'Remove from ' + row.name)) return
        }
        if (newName.trim() !== '') {
          if (!await write(GROUP_OPS.save, { name: newName.trim(), members }, lang === 'zh' ? '新建分组' : 'Create group')) return
        }
        onClose()
        return
      }
      if (mode === 'group' && group !== undefined) {
        const target = groups.find(row => row.id === group.id) ?? group
        const current = target.members.filter(row => row.kind !== 'tool')
        const currentKeys = new Set(current.map(row => keyOf(row.kind, row.id)))
        const byMember = new Map<string, Candidate>()
        for (const candidate of allCandidates) for (const item of candidate.members) byMember.set(keyOf(item.kind, item.id), candidate)
        const selectedCandidates = allCandidates.filter(row => selected.has(row.key))
        const wantedKeys = new Set(selectedCandidates.flatMap(row => row.members.map(item => keyOf(item.kind, item.id))))
        const additions = selectedCandidates.filter(row => row.manageable).flatMap(row => row.members).filter(item => !currentKeys.has(keyOf(item.kind, item.id)))
        const removals = current.filter(item => byMember.has(keyOf(item.kind, item.id)) && !wantedKeys.has(keyOf(item.kind, item.id)))
        for (const item of additions) {
          if (!await write(GROUP_OPS.add, { id: target.id, members: [item] }, lang === 'zh' ? '加入成员' : 'Add member')) return
        }
        for (const item of removals) {
          if (!await write(GROUP_OPS.remove, { id: target.id, members: [item] }, lang === 'zh' ? '移出成员' : 'Remove member')) return
        }
        onClose()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const title = mode === 'member' ? (lang === 'zh' ? '加入分组' : 'Add to groups') : (lang === 'zh' ? '管理成员' : 'Manage members')
  const footer = (
    <>
      <Button variant="ghost" onClick={close}>{t('action.cancel')}</Button>
      <Button variant="primary" busy={saving || busy !== null} disabled={saving || busy !== null} onClick={() => { void commit() }}>{lang === 'zh' ? '保存' : 'Save'}</Button>
    </>
  )

  return (
    <Dialog open={open} title={title} onClose={close} footer={footer}>
      <SearchBox value={query} onChange={setQuery} placeholder={lang === 'zh' ? '搜索...' : 'Search...'} label={lang === 'zh' ? '搜索' : 'Search'} onClear={() => { setQuery('') }} clearLabel={t('action.clear')} />
      {error === '' ? null : <div className="th-field-error" role="alert">{error}</div>}
      {mode === 'member' && member !== undefined ? (
        <div className="th-group-member-picker">
          <div className="th-row-meta">{member.bundleName === undefined ? (lang === 'zh' ? '勾选要加入的分组' : 'Select groups to join') : (lang === 'zh' ? `跟随父包 ${member.bundleName}，将整包加入。` : `Follows package ${member.bundleName}; the whole package is added.`)}</div>
          {groupsShown.length === 0 ? <div className="th-row-meta">{lang === 'zh' ? '还没有分组。' : 'No groups yet.'}</div> : groupsShown.map(row => (
            <label className="th-row" key={row.id}>
              <input type="checkbox" checked={selected.has(row.id)} onChange={() => { toggle(row.id) }} />
              <span className="th-row-name">{row.name}</span>
              <Badge>{row.members.length}</Badge>
            </label>
          ))}
          <label className="th-row">
            <span className="th-row-name">{lang === 'zh' ? '新建分组' : 'New group'}</span>
            <input className="th-input" value={newName} onChange={event => { setNewName(event.target.value) }} placeholder={lang === 'zh' ? '分组名称' : 'Group name'} />
          </label>
        </div>
      ) : (
        <div className="th-group-member-picker">
          {candidates.length === 0 ? <div className="th-row-meta">{lang === 'zh' ? '没有匹配项。' : 'No matches.'}</div> : candidates.map(row => (
            <label className="th-row" key={row.key}>
              <input type="checkbox" checked={selected.has(row.key)} disabled={!row.manageable} onChange={() => { if (row.manageable) toggle(row.key) }} />
              <span className="th-row-name">{row.label}</span>
              <Badge tone={row.kind === 'mcp' ? 'brand' : 'neutral'}>{row.kind}</Badge>
              {row.kind === 'bundle' ? <Badge tone="brand">{lang === 'zh' ? '整包' : 'package'}</Badge> : null}
            </label>
          ))}
          <div className="th-row-meta">{lang === 'zh' ? '工具成员随 MCP/插件动态生成，只读。' : 'Tool members follow MCP/plugins dynamically and stay read-only.'}</div>
        </div>
      )}
    </Dialog>
  )
}
