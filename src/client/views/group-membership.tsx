import * as React from 'react'
import { Badge, Button, Dialog, SearchBox } from '../components.js'
import type { GroupRow, ViewProps } from '../types.js'

export interface GroupMemberRef {
  kind: 'plugin' | 'skill'
  id: string
  name: string
  mcp?: boolean
  bundleName?: string
  manageable?: boolean
}

interface Candidate {
  key: string
  label: string
  kind: 'plugin' | 'skill' | 'mcp'
  storageKind: 'plugin' | 'skill'
  id: string
  mcp?: boolean
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

function candidatesOf(snapshot: ViewProps['snapshot']): Candidate[] {
  return [
    ...snapshot.plugins.map(row => ({
      key: keyOf('plugin', row.id),
      label: row.name,
      kind: row.mcp === true ? 'mcp' as const : 'plugin' as const,
      storageKind: 'plugin' as const,
      id: row.id,
      mcp: row.mcp === true,
      ...(row.bundleName === undefined ? {} : { bundleName: row.bundleName }),
      manageable: row.manageable !== false && row.bundleName === undefined,
    })),
    ...snapshot.skills.map(row => ({ key: keyOf('skill', row.id), label: row.name, kind: 'skill' as const, storageKind: 'skill' as const, id: row.id, manageable: true })),
  ].sort((left, right) => left.label.localeCompare(right.label))
}

function hasMember(group: GroupRow, member: GroupMemberRef): boolean {
  return group.members.some(row => row.kind === (member.mcp === true ? 'plugin' : member.kind) && row.id === member.id)
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
    if (mode === 'member' && member !== undefined) setSelected(new Set(groups.filter(row => hasMember(row, member)).map(row => row.id)))
    else if (mode === 'group' && group !== undefined) setSelected(new Set(group.members.filter(row => row.kind !== 'tool').map(row => keyOf(row.kind, row.id))))
    else setSelected(new Set())
  }, [open, mode, member?.id, member?.kind, member?.mcp, group?.id, groups.length])

  const term = query.trim().toLowerCase()
  const allCandidates = candidatesOf(snapshot)
  const candidates = allCandidates.filter(row => term === '' || row.label.toLowerCase().includes(term) || row.id.toLowerCase().includes(term))
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
        const storedKind = member.mcp === true ? 'plugin' : member.kind
        for (const row of groups) {
          const wanted = selected.has(row.id)
          const current = hasMember(row, member)
          if (wanted === current) continue
          const ok = wanted
            ? await write(GROUP_OPS.add, { id: row.id, members: [{ kind: storedKind, id: member.id }] }, lang === 'zh' ? '加入 ' + row.name : 'Add to ' + row.name)
            : await write(GROUP_OPS.remove, { id: row.id, members: [{ kind: storedKind, id: member.id }] }, lang === 'zh' ? '移出 ' + row.name : 'Remove from ' + row.name)
          if (!ok) return
        }
        if (newName.trim() !== '') {
          const ok = await write(GROUP_OPS.save, { name: newName.trim(), members: [{ kind: storedKind, id: member.id }] }, lang === 'zh' ? '新建分组' : 'Create group')
          if (!ok) return
        }
        onClose()
        return
      }
      if (mode === 'group' && group !== undefined) {
        const wanted = allCandidates.filter(row => selected.has(row.key))
        const wantedKeys = new Set(wanted.map(row => row.key))
        const current = new Set(group.members.filter(row => row.kind !== 'tool').map(row => keyOf(row.kind, row.id)))
        const candidateKeys = new Set(allCandidates.map(row => row.key))
        const additions = wanted.filter(row => row.manageable && !current.has(row.key))
        const removals = [...current].filter(key => candidateKeys.has(key) && !wantedKeys.has(key))
        for (const row of additions) {
          if (!await write(GROUP_OPS.add, { id: group.id, members: [{ kind: row.storageKind, id: row.id }] }, lang === 'zh' ? '加入 ' + row.label : 'Add ' + row.label)) return
        }
        for (const key of removals) {
          const [kind, ...idParts] = key.split(':')
          const id = idParts.join(':')
          if ((kind === 'plugin' || kind === 'skill') && !await write(GROUP_OPS.remove, { id: group.id, members: [{ kind, id }] }, lang === 'zh' ? '移出成员' : 'Remove member')) return
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
          <div className="th-row-meta">{lang === 'zh' ? '勾选要加入的分组' : 'Select groups to join'}</div>
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
            </label>
          ))}
          <div className="th-row-meta">{lang === 'zh' ? '工具成员随 MCP/插件动态生成，只读。' : 'Tool members follow MCP/plugins dynamically and stay read-only.'}</div>
        </div>
      )}
    </Dialog>
  )
}
