/**
 * Groups: the rail's groups, their members, their drawer and the one bulk switch.
 *
 * Payloads mirror src/domains/groups.ts exactly: save sends the whole member list (or members
 * drop), delete/clean send an id, and the bulk switch sends { id, enabled, skipShared }.
 *
 * The dshmarket import is the one read this view makes: `market.status` previews the groups the
 * host matched by package name, and only the dialog's confirm sends `market.import`.
 *
 * Deleting a group or dropping its stale members rewrites state the panel cannot undo, so both
 * go through a Dialog first; the group switch is reversible and therefore does not.
 */
import * as React from 'react'
import { Badge, Button, Card, Dialog, Empty, Field, SearchBox, Select, Switch, Toolbar } from '../components.js'
import { runOp } from '../api.js'
import { groupOnReader } from '../group-state.js'
import type { GroupMember, GroupRow, ViewProps } from '../types.js'

/** Op ids this view owns; api.ts keeps the shell's shared table, not the groups domain. */
const OPS = {
  save: 'group.save',
  del: 'group.delete',
  toggle: 'group.toggle',
  batch: 'group.batch',
  clean: 'group.clean',
  collection: 'collection.save',
  autoPreview: 'auto.preview',
  autoApply: 'auto.apply',
  marketStatus: 'market.status',
  marketImport: 'market.import',
} as const

/** Sentinels for the drawer filter: a drawer id matches /^[a-z0-9][a-z0-9_-]{0,31}$/, so neither collides. */
const ALL = '*'
const NONE = '-none-'
const NAME_MAX = 60
const DRAWER_NAME_MAX = 40
const DRAWER_ID_MAX = 32
const DRAWER_ID = /^[a-z0-9][a-z0-9_-]*$/

type DialogKind = 'create' | 'edit' | 'delete' | 'clean' | 'drawer' | 'auto' | 'market'

interface Drawer {
  id: string
  name: string
}

/** The drawer id derived from a typed name; empty means the name cannot become an id. */
function slugify(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, DRAWER_ID_MAX)
  return DRAWER_ID.test(base) ? base : ''
}

/** group.save's payload: the handler drops members it is not sent, so an edit resends them. */
function savePayload(id: string | null, name: string, drawer: string, members: GroupMember[] | null): Record<string, unknown> {
  return {
    ...(id === null ? {} : { id }),
    name,
    members: members ?? [],
    collection: drawer === NONE ? null : drawer,
  }
}

// #region market-helpers
export type MarketGroup = { name: string; members: number; missing: number }
export type MarketStatus = { available: boolean; file: string | null; groups: MarketGroup[]; error: string | null }

/** market.status, made total: the dialog previews before a single group is written. */
export function normalizeMarket(raw: unknown): MarketStatus {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const groups = (Array.isArray(record.groups) ? record.groups : []).flatMap((entry): MarketGroup[] => {
    const row = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null
    if (row === null || typeof row.name !== 'string' || row.name === '') return []
    return [{ name: row.name, members: typeof row.members === 'number' ? row.members : 0, missing: Array.isArray(row.missing) ? row.missing.length : 0 }]
  })
  return { available: record.available === true, file: typeof record.file === 'string' ? record.file : null, groups, error: typeof record.error === 'string' ? record.error : null }
}
// #endregion market-helpers

interface MemberView {
  key: string
  label: string
  kind: 'plugin' | 'skill' | 'mcp' | 'tool'
  actionKind: 'plugin' | 'skill'
  id: string
  bundleName?: string
  enabled: boolean
  manageable: boolean
  readOnlyReason: string | null
}

function memberViews(group: GroupRow, snapshot: ViewProps['snapshot']): MemberView[] {
  return group.members.map((member: GroupMember): MemberView => {
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
    return { key, label: plugin?.name ?? member.id, kind: plugin?.mcp === true ? 'mcp' : 'plugin', actionKind: 'plugin', id: member.id, enabled: plugin?.enabled === true, manageable: plugin !== undefined && plugin.manageable !== false, readOnlyReason: plugin === undefined ? 'missing plugin' : plugin.readOnlyReason ?? null, ...(plugin?.bundleName === undefined ? {} : { bundleName: plugin.bundleName }) }
  })
}

export function GroupsView(props: ViewProps): React.ReactElement {
  const { snapshot, lang, t, busy, run } = props
  const groups = snapshot.groups
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState(ALL)
  const [dialog, setDialog] = React.useState<DialogKind | null>(null)
  const [targetId, setTargetId] = React.useState('')
  const [targetName, setTargetName] = React.useState('')
  const [formName, setFormName] = React.useState('')
  const [formDrawer, setFormDrawer] = React.useState(NONE)
  const [drawerName, setDrawerName] = React.useState('')
  // Drawer names come from the snapshot; a drawer created in this session is merged in until
  // the next reload returns it, and a group pointing at an unknown drawer still shows its id.
  const [created, setCreated] = React.useState<Drawer[]>([])
  const [autoPlan, setAutoPlan] = React.useState<Array<{ name: string; members: unknown[] }>>([])
  const [market, setMarket] = React.useState<MarketStatus | null>(null)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const toggleExpanded = (id: string): void => { setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next }) }

  const drawers = React.useMemo(() => {
    const seen = new Map<string, string>()
    for (const drawer of snapshot.collections) seen.set(drawer.id, drawer.name)
    for (const group of groups) {
      const id = group.collection
      if (typeof id === 'string' && id !== '' && !seen.has(id)) seen.set(id, id)
    }
    for (const drawer of created) if (!seen.has(drawer.id)) seen.set(drawer.id, drawer.name)
    return [...seen.entries()].map(([id, name]) => ({ id, name }))
  }, [groups, created, snapshot.collections])

  // A group has no stored on/off flag: read the live state of its members instead.
  const isOn = React.useMemo(() => groupOnReader(snapshot), [snapshot])
  const term = query.trim().toLowerCase()
  const rows = groups.filter(group => {
    const drawer = typeof group.collection === 'string' ? group.collection : ''
    if (filter === NONE ? drawer !== '' : filter !== ALL && drawer !== filter) return false
    if (term === '') return true
    return group.name.toLowerCase().includes(term) || group.id.toLowerCase().includes(term)
  })

  const drawerLabel = (id: string | null | undefined): string =>
    typeof id === 'string' && id !== '' ? id : t('groups.ungrouped')

  const openCreate = (): void => {
    setTargetId('')
    setTargetName('')
    setFormName('')
    setFormDrawer(filter === ALL || filter === NONE ? NONE : filter)
    setDialog('create')
  }

  const openEdit = (group: GroupRow): void => {
    setTargetId(group.id)
    setTargetName(group.name)
    setFormName(group.name)
    setFormDrawer(typeof group.collection === 'string' && group.collection !== '' ? group.collection : NONE)
    setDialog('edit')
  }

  const openConfirm = (kind: 'delete' | 'clean', group: GroupRow): void => {
    setTargetId(group.id)
    setTargetName(group.name)
    setDialog(kind)
  }

  const close = (): void => {
    setDialog(null)
  }

  // auto.preview is a read; the plan is only shown, the write leaves from confirmAction.
  const openAuto = async (): Promise<void> => {
    const result = await runOp(OPS.autoPreview, {})
    if (!result.ok) return
    const data = result.data as { plan?: unknown } | null
    const plan = Array.isArray(data?.plan) ? data.plan : []
    setAutoPlan(plan.map(entry => {
      const row = entry as { name?: unknown; members?: unknown }
      return { name: typeof row.name === 'string' ? row.name : '', members: Array.isArray(row.members) ? row.members : [] }
    }))
    setDialog('auto')
  }

  // market.status is a read; the import itself only leaves from the dialog's confirm button.
  const openMarket = async (): Promise<void> => {
    const result = await runOp(OPS.marketStatus, {})
    if (!result.ok) return
    setMarket(normalizeMarket(result.data))
    setDialog('market')
  }

  // Every write leaves from here: the row buttons only open a dialog, they never send an op.
  const confirmAction = (): void => {
    if (dialog === 'delete') {
      close()
      void run(OPS.del, { id: targetId })
      return
    }
    if (dialog === 'clean') {
      close()
      void run(OPS.clean, { id: targetId })
      return
    }
    if (dialog === 'auto') {
      close()
      void run(OPS.autoApply, {})
      return
    }
    if (dialog === 'market') {
      close()
      void run(OPS.marketImport, {})
      return
    }
    if (dialog === 'drawer') {
      const name = drawerName.trim()
      const slug = slugify(name)
      if (name === '' || slug === '') return
      close()
      void run(OPS.collection, { id: slug, name }).then(ok => {
        if (!ok) return
        setCreated(current => (current.some(drawer => drawer.id === slug) ? current : [...current, { id: slug, name }]))
      })
      return
    }
    if (dialog === null) {
      close()
      return
    }
    const name = formName.trim().slice(0, NAME_MAX)
    if (name === '') return
    const editing = dialog === 'edit' ? groups.find(group => group.id === targetId) : undefined
    close()
    void run(OPS.save, savePayload(editing === undefined ? null : editing.id, name, formDrawer, editing?.members ?? null))
  }

  const newDrawerLabel = lang === 'zh' ? '新建抽屉' : 'New drawer'
  const drawerIdHint = `${lang === 'zh' ? '用途 id' : 'id'}: ${slugify(drawerName) || '—'}`

  const drawerOptions = [
    { value: NONE, label: t('groups.ungrouped') },
    ...drawers.map(drawer => ({ value: drawer.id, label: drawer.name })),
  ]
  const filterOptions = [{ value: ALL, label: lang === 'zh' ? '全部抽屉' : 'All drawers' }, ...drawerOptions]
  const emptyQuery = term !== '' ? query.trim() : filter === ALL ? '' : filter === NONE ? t('groups.ungrouped') : filter
  const staleCount = groups.find(group => group.id === targetId)?.stale ?? 0

  let title = ''
  let body: React.ReactNode = null
  let confirmLabel = t('action.confirm')
  let confirmVariant: 'primary' | 'danger' = 'primary'
  let confirmBusy = false
  let confirmDisabled = false

  if (dialog === 'create' || dialog === 'edit') {
    title = dialog === 'create' ? t('groups.create') : `${t('action.edit')} · ${targetName}`
    body = (
      <>
        <Field id="th-group-name" label={t('groups.name')} hint={t('groups.membersHint')}>
          <input id="th-group-name" className="th-input" type="text" value={formName} maxLength={NAME_MAX} onChange={event => { setFormName(event.target.value) }} />
        </Field>
        <Field id="th-group-drawer" label={t('groups.collection')}>
          <Select id="th-group-drawer" value={formDrawer} options={drawerOptions} onChange={setFormDrawer} label={t('groups.collection')} />
        </Field>
      </>
    )
    confirmLabel = dialog === 'create' ? t('action.create') : t('action.save')
    confirmBusy = busy === (dialog === 'create' ? OPS.save : `${OPS.save}:${targetId}`)
    confirmDisabled = formName.trim() === ''
  } else if (dialog === 'delete') {
    title = t('dialog.confirmTitle')
    body = t('groups.deleteBody', { name: targetName })
    confirmLabel = t('action.delete')
    confirmVariant = 'danger'
    confirmBusy = busy === `${OPS.del}:${targetId}`
  } else if (dialog === 'clean') {
    title = t('dialog.confirmTitle')
    body = `${t('groups.clean')}: ${targetName} — ${t('groups.stale', { n: staleCount })}`
    confirmLabel = t('groups.clean')
    confirmVariant = 'danger'
    confirmBusy = busy === `${OPS.clean}:${targetId}`
  } else if (dialog === 'auto') {
    const total = autoPlan.reduce((sum, entry) => sum + entry.members.length, 0)
    title = lang === 'zh' ? '自动分组' : 'Auto groups'
    body = (
      <div>
        <div>{lang === 'zh' ? `将重建 ${autoPlan.length} 个分组、${total} 个成员，现有手工分组保留。` : `Rebuild ${autoPlan.length} groups with ${total} members; manual groups stay.`}</div>
        <ul className="th-list">{autoPlan.map(entry => (
          <li key={entry.name} className="th-row"><span className="th-row-name">{entry.name}</span><Badge>{t('groups.members', { n: entry.members.length })}</Badge></li>
        ))}</ul>
      </div>
    )
    confirmLabel = lang === 'zh' ? '重建自动分组' : 'Rebuild'
    confirmBusy = busy === OPS.autoApply
  } else if (dialog === 'market') {
    const list = market === null ? [] : market.groups
    const totals = { groups: list.length, members: list.reduce((sum, entry) => sum + entry.members, 0) }
    title = t('market.import')
    body = (
      <div>
        <div>{t('market.importHint')}</div>
        {list.length === 0 ? <div>{t('market.none')}</div> : (
          <>
            <div>{t('market.preview', totals)}</div>
            <div className="th-row-meta">{list.map(group => (group.missing === 0 ? group.name : `${group.name} −${group.missing}`)).join(', ')}</div>
          </>
        )}
        {market === null || market.error === null ? null : <div>{market.error}</div>}
      </div>
    )
    confirmLabel = t('market.import')
    confirmDisabled = list.length === 0
    confirmBusy = busy === OPS.marketImport
  } else if (dialog === 'drawer') {
    title = t('groups.collection')
    body = (
      <Field id="th-drawer-name" label={lang === 'zh' ? '抽屉名称' : 'Drawer name'} hint={drawerIdHint}>
        <input id="th-drawer-name" className="th-input" type="text" value={drawerName} maxLength={DRAWER_NAME_MAX} onChange={event => { setDrawerName(event.target.value) }} />
      </Field>
    )
    confirmLabel = t('action.create')
    confirmBusy = busy === `${OPS.collection}:${slugify(drawerName)}`
    confirmDisabled = slugify(drawerName) === ''
  }

  return (
    <div>
      <Toolbar>
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('groups.search')}
          label={t('groups.search')}
          onClear={() => {
            setQuery('')
          }}
          clearLabel={t('action.clear')}
        />
        <Select id="th-groups-filter" value={filter} options={filterOptions} onChange={setFilter} label={t('groups.collection')} />
        <Badge tone="brand">{t('groups.count', { n: rows.length })}</Badge>
        <Button
          variant="ghost"
          label={lang === 'zh' ? '自动分组' : 'Auto groups'}
          onClick={() => {
            void openAuto()
          }}
        >
          {lang === 'zh' ? '自动分组' : 'Auto groups'}
        </Button>
        <Button
          variant="ghost"
          label={newDrawerLabel}
          onClick={() => {
            setDrawerName('')
            setDialog('drawer')
          }}
        >
          {newDrawerLabel}
        </Button>
        <Button variant="ghost" label={t('market.import')} title={t('market.importHint')} onClick={() => { void openMarket() }}>
          {t('market.import')}
        </Button>
        <Button variant="primary" onClick={openCreate}>
          {t('groups.create')}
        </Button>
      </Toolbar>

      {groups.length === 0 ? (
        // Rendered inside the same subtree as the dialog: deleting the last group must leave
        // the New group dialog usable, not strand it behind an early return.
        <Empty
          title={t('groups.empty')}
          hint={t('groups.membersHint')}
          action={
            <Button variant="primary" onClick={openCreate}>
              {t('groups.create')}
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <Empty title={t('groups.emptyFiltered', { query: emptyQuery })} />
      ) : (
        <Card label={t('groups.title')}>
          <div className="th-list">
            {rows.map(group => {
              const stale = group.stale ?? 0
              const on = isOn(group)
              return (
                <React.Fragment key={group.id}>
                <div className="th-row">
                  <div className="th-row-body">
                    <span className="th-row-name">{group.name}</span>
                    <span className="th-row-meta">
                      <span className="th-mono">{group.id}</span>
                      <Badge>{t('groups.members', { n: group.members.length })}</Badge>
                      <Badge tone="brand">{drawerLabel(group.collection)}</Badge>
                      {stale > 0 ? <Badge tone="warn">{t('groups.stale', { n: stale })}</Badge> : null}
                      <Badge tone={on ? 'on' : 'off'}>{on ? t('state.on') : t('state.off')}</Badge>
                    </span>
                  </div>
                  {stale > 0 ? (
                    <Button
                      variant="ghost"
                      label={`${t('groups.clean')}: ${group.name}`}
                      busy={busy === `${OPS.clean}:${group.id}`}
                      onClick={() => {
                        openConfirm('clean', group)
                      }}
                    >
                      {t('groups.clean')}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={() => { toggleExpanded(group.id) }}>
                    {lang === 'zh' ? `成员 ${group.members.length}` : `Members ${group.members.length}`}
                  </Button>
                  <Button
                    variant="ghost"
                    label={`${t('action.edit')}: ${group.name}`}
                    busy={busy === `${OPS.save}:${group.id}`}
                    onClick={() => {
                      openEdit(group)
                    }}
                  >
                    {t('action.edit')}
                  </Button>
                  <Button
                    variant="danger"
                    label={`${t('groups.delete')}: ${group.name}`}
                    busy={busy === `${OPS.del}:${group.id}`}
                    onClick={() => {
                      openConfirm('delete', group)
                    }}
                  >
                    {t('groups.delete')}
                  </Button>
                  <Switch
                    checked={on}
                    busy={busy === `${OPS.batch}:${group.id}`}
                    label={t('a11y.switch', { name: group.name })}
                    onChange={next => {
                      // skipShared=false flips every member, including one another group lists.
                      void run(OPS.batch, { id: group.id, enabled: next, skipShared: false })
                    }}
                  />
                </div>
                {expanded.has(group.id) ? (
                  <div className="th-group-members">
                    {memberViews(group, snapshot).map(member => (
                      <div className="th-row" key={member.key}>
                        <div className="th-row-body">
                          <span className="th-row-name">{member.label}</span>
                          <span className="th-row-meta">
                            <Badge tone={member.kind === 'mcp' ? 'brand' : 'neutral'}>{member.kind}</Badge>
                            {member.readOnlyReason === null ? null : <Badge tone="warn">{member.readOnlyReason}</Badge>}
                          </span>
                        </div>
                        {member.kind === 'tool' || !member.manageable ? <Badge>{lang === 'zh' ? '只读' : 'read-only'}</Badge> : (
                          <Switch
                            checked={member.enabled}
                            busy={busy === `toggle:${member.id}`}
                            label={t('a11y.switch', { name: member.label })}
                            onChange={next => {
                              void run('toggle', { kind: member.actionKind, id: member.id, enabled: next, ...(member.bundleName === undefined ? {} : { bundleName: member.bundleName }) })
                            }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
                </React.Fragment>
              )
            })}
          </div>
        </Card>
      )}

      <Dialog
        open={dialog !== null}
        title={title}
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              {t('action.cancel')}
            </Button>
            <Button variant={confirmVariant} busy={confirmBusy} disabled={confirmDisabled} onClick={confirmAction}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        {body}
      </Dialog>
    </div>
  )
}