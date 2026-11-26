import * as React from 'react'
import { Button, Dialog, Select } from '../components.js'
import type { GroupMemberRef } from './group-membership.js'
import type { GroupRow, ViewProps } from '../types.js'

interface Props {
  open: boolean
  source: GroupRow
  groups: GroupRow[]
  member: GroupMemberRef | null
  lang: 'zh' | 'en'
  t: ViewProps['t']
  busy: string | null
  run: ViewProps['run']
  onClose: () => void
}

export function GroupTransferDialog(props: Props): React.ReactElement {
  const { open, source, groups, member, lang, t, busy, run, onClose } = props
  const targets = groups.filter(group => group.id !== source.id)
  const [to, setTo] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    if (!open) return
    setTo(targets[0]?.id ?? '')
    setError('')
  }, [open, source.id, targets.length])

  const commit = async (): Promise<void> => {
    if (member === null || to === '' || saving || busy !== null) return
    setSaving(true)
    setError('')
    try {
      const ok = await run('group.transfer', { from: source.id, to, members: [{ kind: member.mcp === true ? 'plugin' : member.kind, id: member.id }] })
      if (!ok) {
        setError(lang === 'zh' ? '转移失败，源组和目标组都没有被写入。' : 'Transfer failed; neither group was written.')
        return
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const target = targets.find(group => group.id === to)
  return (
    <Dialog open={open} title={lang === 'zh' ? '转移成员' : 'Move member'} onClose={() => { if (!saving) onClose() }} footer={
      <>
        <Button variant="ghost" onClick={() => { if (!saving) onClose() }}>{t('action.cancel')}</Button>
        <Button variant="primary" busy={saving || busy !== null} disabled={member === null || to === '' || saving || busy !== null} onClick={() => { void commit() }}>{lang === 'zh' ? '转移' : 'Move'}</Button>
      </>
    }>
      <p>{member === null ? '' : (lang === 'zh' ? '将“' + member.name + '”从“' + source.name + '”转移到：' : 'Move “' + member.name + '” from “' + source.name + '” to:')}</p>
      {member?.bundleName === undefined ? null : <p className="th-field-hint">{lang === 'zh' ? '这是整包成员，会移动整个 ' + member.bundleName + ' 组。' : 'This is a package member; the whole ' + member.bundleName + ' group moves.'}</p>}
      {targets.length === 0 ? <p className="th-field-hint">{lang === 'zh' ? '没有其他分组可转移。' : 'No other group is available.'}</p> : (
        <Select id="group-transfer-target" value={to} options={targets.map(group => ({ value: group.id, label: group.name }))} onChange={setTo} label={lang === 'zh' ? '目标分组' : 'Target group'} />
      )}
      {target === undefined ? null : <p className="th-field-hint">{lang === 'zh' ? '目标：' + target.name : 'Target: ' + target.name}</p>}
      {error === '' ? null : <div className="th-field-error" role="alert">{error}</div>}
    </Dialog>
  )
}
