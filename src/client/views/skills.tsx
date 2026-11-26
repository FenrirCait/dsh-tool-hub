/**
 * Skills: every folder under every configured root, folded into one parent per name prefix.
 *
 * The switch is per row; a parent switch writes its whole group through that same per-row op, one
 * call at a time, because the host has no group op for skills. Import, move and delete each need
 * an argument the row cannot supply, so each one is a dialog. Restore reads the trash folder
 * through the read-only `skill.trash` op. Every write goes through `run`, so the shell owns the
 * busy key, the notice and the snapshot refresh.
 */
import * as React from 'react'
import { runOp } from '../api.js'
import { Badge, Button, Callout, Card, Dialog, Empty, Field, SearchBox, Select, Switch, Toolbar } from '../components.js'
import { groupByPrefix, type TreeGroup } from './package-tree.js'
import { SkillTree, skillTree } from './skills-tree.js'
import { GroupMembershipDialog, type GroupMemberRef } from './group-membership.js'
import type { SkillRootInfo, SkillRow, ViewProps } from '../types.js'
/** Op ids of the skills domain; the generic `toggle` op takes a kind, this one does not. */
const OPS = {
  toggle: 'skill.toggle',
  importFile: 'skill.import',
  move: 'skill.move',
  trash: 'skill.trash',
  restore: 'skill.restore',
  delete: 'skill.delete',
} as const
/** One trash entry as `skill.trash` reports it; anything malformed is dropped, not guessed at. */
interface TrashRow {
  trashPath: string
  name: string
  at: string
  rootId: string | null
  rel: string | null
}
type Lang = ViewProps['lang']

/**
 * Inline copy for labels no catalog key covers yet. i18n.ts is shared with every other view, so
 * this view does not extend it; a label added here is one the catalog can absorb later.
 */
function pick(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

function trashRows(data: unknown): TrashRow[] {
  const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const items = Array.isArray(record.items) ? record.items : []
  const rows: TrashRow[] = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const path = typeof row.trashPath === 'string' ? row.trashPath : ''
    if (path === '') continue
    rows.push({
      trashPath: path,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : path,
      at: typeof row.at === 'string' ? row.at : '',
      rootId: typeof row.rootId === 'string' ? row.rootId : null,
      rel: typeof row.rel === 'string' ? row.rel : null,
    })
  }
  return rows
}

/** The shell keys a row op as `${op}:${id}` when the payload carries an id; mirror it here. */
function busyKey(op: string, id: string): string {
  return op + ':' + id
}

/** The root a move defaults to: the first one that is not already where the row lives. */
function firstOtherRoot(row: SkillRow, roots: SkillRootInfo[]): string {
  const hit = roots.find(item => item.id !== row.rootId)
  return hit === undefined ? '' : hit.id
}

/** Trash timestamps are ISO strings; an unparseable one shows nothing rather than NaN. */
function when(at: string, lang: Lang): string {
  if (at === '') return ''
  try {
    return new Date(at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

export function SkillsView(props: ViewProps): React.ReactElement {
  const { snapshot, t, lang, busy, run } = props
  const [query, setQuery] = React.useState('')
  const [root, setRoot] = React.useState('all')
  const [bulkKey, setBulkKey] = React.useState<string | null>(null)
  const [importing, setImporting] = React.useState(false)
  const [importPath, setImportPath] = React.useState('')
  const [importRoot, setImportRoot] = React.useState('')
  const [overwrite, setOverwrite] = React.useState(false)
  const [moving, setMoving] = React.useState<SkillRow | null>(null)
  const [moveTarget, setMoveTarget] = React.useState('')
  const [deleting, setDeleting] = React.useState<SkillRow | null>(null)
  const [trash, setTrash] = React.useState<TrashRow[]>([])
  const [trashError, setTrashError] = React.useState<string | null>(null)
  const [trashLoading, setTrashLoading] = React.useState(false)
  const [trashTick, setTrashTick] = React.useState(0)
  const [assignMember, setAssignMember] = React.useState<GroupMemberRef | null>(null)

  const roots = snapshot.paths.skills ?? []
  const rootOptions = [
    { value: 'all', label: t('skills.allRoots') },
    ...roots.map(item => ({ value: item.id, label: item.label ?? item.id })),
  ]
  const importOptions = rootOptions.filter(option => option.value !== 'all')
  const targetRoot = importRoot !== '' ? importRoot : (roots[0] === undefined ? '' : roots[0].id)
  const term = query.trim().toLowerCase()

  // The root filter runs here and the search runs in the tree: a hit on a parent label keeps
  // every child, which a plain row filter would have thrown away.
  const scoped = snapshot.skills.filter(row => root === 'all' || row.rootId === root)
  const groups = skillTree(groupByPrefix(scoped, row => row.name, t('tree.ungrouped')), term, row => row.name + ' ' + row.id)
  const visible = groups.reduce((count, group) => count + group.rows.length, 0)

  // The one read the view performs itself: the snapshot never carries the trash, and restore
  // needs a trashPath the rows cannot supply on their own.
  React.useEffect(() => {
    let live = true
    setTrashLoading(true)
    void runOp(OPS.trash, {}).then(result => {
      if (!live) return
      if (result.ok) {
        setTrash(trashRows(result.data))
        setTrashError(null)
      } else {
        setTrashError(result.message)
      }
      setTrashLoading(false)
    })
    return () => {
      live = false
    }
  }, [trashTick])

  // One write per child, in order: a failure part-way stops the run instead of writing over the
  // error the shell already reported. The parent switch spins on the group key meanwhile.
  const bulkToggle = async (group: TreeGroup<SkillRow>, next: boolean): Promise<void> => {
    if (group.rows.length === 0) return
    setBulkKey(group.key)
    try {
      for (const row of group.rows) {
        const ok = await run(OPS.toggle, { id: row.id, enabled: next })
        if (!ok) return
      }
    } finally {
      setBulkKey(null)
    }
  }

  const openImport = (): void => {
    setImportPath('')
    setImportRoot(roots.length === 0 ? '' : (roots[0] === undefined ? '' : roots[0].id))
    setOverwrite(false)
    setImporting(true)
  }

  const restoreItem = async (item: TrashRow): Promise<void> => {
    const ok = await run(OPS.restore, { trashPath: item.trashPath })
    if (ok) setTrashTick(tick => tick + 1)
  }

  const confirmDelete = async (): Promise<void> => {
    const row = deleting
    if (row === null) return
    const ok = await run(OPS.delete, { id: row.id })
    if (ok) setTrashTick(tick => tick + 1)
    setDeleting(null)
  }

  const confirmMove = async (): Promise<void> => {
    const row = moving
    if (row === null || moveTarget === '') return
    const ok = await run(OPS.move, { id: row.id, targetId: moveTarget })
    if (ok) setMoving(null)
  }

  const submitImport = async (): Promise<void> => {
    const source = importPath.trim()
    if (source === '' || targetRoot === '') return
    const ok = await run(OPS.importFile, { targetId: targetRoot, path: source, overwrite })
    if (ok) {
      setImporting(false)
      setImportPath('')
      setOverwrite(false)
    }
  }

  const trashSection = (
    <div className="th-section">
      <div className="th-section-title">{pick(lang, '回收站', 'Trash')}</div>
      <Toolbar>
        <Button variant="ghost" busy={trashLoading} onClick={() => { setTrashTick(tick => tick + 1) }}>
          {pick(lang, '刷新回收站', 'Refresh trash')}
        </Button>
        {trashError === null ? null : (
          <Callout action={<Button variant="ghost" onClick={() => { setTrashTick(tick => tick + 1) }}>{t('action.retry')}</Button>}>
            {t('error.unknown', { message: trashError })}
          </Callout>
        )}
      </Toolbar>
      {trash.length === 0 ? (
        <Empty
          title={pick(lang, '回收站是空的', 'The trash is empty')}
          hint={pick(lang, '删除的技能先移到这里，随时可以恢复。', 'A deleted skill lands here first and can be restored.')}
        />
      ) : (
        <Card label={pick(lang, '回收站', 'Trash')}>
          <div className="th-list">
            {trash.map(item => (
              <div className="th-row" key={item.trashPath}>
                <div className="th-row-body">
                  <span className="th-row-name">{item.name}</span>
                  <span className="th-row-meta">
                    {item.rootId === null ? null : <Badge>{item.rootId}</Badge>}
                    {item.rel === null ? null : <span className="th-mono">{item.rel}</span>}
                    {item.at === '' ? null : <span>{when(item.at, lang)}</span>}
                  </span>
                </div>
                <Button
                  variant="primary"
                  busy={busy === OPS.restore}
                  label={pick(lang, `恢复 ${item.name}`, `Restore ${item.name}`)}
                  onClick={() => { void restoreItem(item) }}
                >
                  {pick(lang, '恢复', 'Restore')}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )

  return (
    <div>
      <Toolbar>
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('skills.search')}
          label={t('skills.search')}
          onClear={() => { setQuery('') }}
          clearLabel={t('action.clear')}
        />
        <Select id="th-skill-root-filter" value={root} options={rootOptions} onChange={setRoot} label={t('skills.root')} />
        <Badge tone="brand">{t('skills.count', { n: visible })}</Badge>
        <Button disabled={roots.length === 0} onClick={openImport} title={roots.length === 0 ? pick(lang, '先在设置里配置一个技能根目录', 'Configure a skill root in Settings first') : undefined}>
          {pick(lang, '导入技能', 'Import a skill')}
        </Button>
      </Toolbar>

      {snapshot.skills.length === 0 ? (
        <Empty
          title={t('skills.empty')}
          hint={pick(lang, '技能根目录在设置里配置，这里会列出每个根目录下的技能。', 'Skill roots live in Settings; every skill under one is listed here.')}
          action={roots.length === 0 ? undefined : <Button onClick={openImport}>{pick(lang, '导入技能', 'Import a skill')}</Button>}
        />
      ) : groups.length === 0 ? (
        <Empty title={t('skills.emptyFiltered', { query })} />
      ) : (
        <Card label={t('skills.title')}>
          <SkillTree
            groups={groups}
            lang={lang}
            forceOpen={term !== ''}
            resetKey={term}
            busyKey={bulkKey}
            onBulk={(group, next) => { void bulkToggle(group, next) }}
            renderRow={row => {
              const rootInfo = roots.find(item => item.id === row.rootId) ?? null
              return (
                <div className="th-row" key={row.id}>
                  <div className="th-row-body">
                    <span className="th-row-name">{row.name}</span>
                    <span className="th-row-meta">
                      {rootInfo === null ? null : <Badge>{rootInfo.label ?? rootInfo.id}</Badge>}
                      <Badge tone={row.enabled ? 'on' : 'off'}>{row.enabled ? t('state.on') : t('state.off')}</Badge>
                      {row.entry === 'file' ? <Badge>{pick(lang, '单文件', 'single file')}</Badge> : null}
                      {row.packs === undefined || row.packs <= 0 ? null : (
                        <Badge>{pick(lang, `${row.packs} 个包`, `${row.packs} packs`)}</Badge>
                      )}
                      <span className="th-mono">{row.id}</span>
                      {row.description === undefined || row.description === '' ? null : <span>{row.description}</span>}
                    </span>
                  </div>
                  <div className="th-toolbar" style={{ margin: 0 }}>
                    <Button variant="ghost" onClick={() => { setAssignMember({ kind: 'skill', id: row.id, name: row.name }) }}>{pick(lang, '分组', 'Groups')}</Button>
                    <Button
                      variant="ghost"
                      label={pick(lang, `移动 ${row.name}`, `Move ${row.name}`)}
                      onClick={() => {
                        setMoveTarget(firstOtherRoot(row, roots))
                        setMoving(row)
                      }}
                    >
                      {pick(lang, '移动', 'Move')}
                    </Button>
                    <Button
                      variant="danger"
                      label={pick(lang, `删除 ${row.name}`, `Delete ${row.name}`)}
                      onClick={() => {
                        setDeleting(row)
                      }}
                    >
                      {t('action.delete')}
                    </Button>
                    <Switch
                      checked={row.enabled}
                      busy={busy === busyKey(OPS.toggle, row.id)}
                      label={t('a11y.switch', { name: row.name })}
                      onChange={next => {
                        void run(OPS.toggle, { id: row.id, enabled: next })
                      }}
                    />
                  </div>
                </div>
              )
            }}
          />
        </Card>
      )}

      {trashSection}

      <Dialog
        open={importing}
        title={pick(lang, '导入技能', 'Import a skill')}
        onClose={() => { setImporting(false) }}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setImporting(false) }}>{t('action.cancel')}</Button>
            <Button
              variant="primary"
              busy={busy === OPS.importFile}
              disabled={importPath.trim() === '' || targetRoot === ''}
              onClick={() => { void submitImport() }}
            >
              {pick(lang, '导入', 'Import')}
            </Button>
          </>
        }
      >
        <div className="th-list">
          <Field
            id="th-skill-import-path"
            label={pick(lang, '本地路径', 'Local path')}
            hint={pick(lang, '技能文件夹、单个 .md 文件或 .zip 压缩包。', 'A skill folder, a single .md file or a .zip bundle.')}
          >
            <input
              id="th-skill-import-path"
              className="th-input"
              type="text"
              value={importPath}
              placeholder={pick(lang, 'D:/skills/my-skill', 'D:/skills/my-skill')}
              aria-label={pick(lang, '本地路径', 'Local path')}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setImportPath(event.target.value) }}
            />
          </Field>
          <Field id="th-skill-import-root" label={pick(lang, '目标根目录', 'Target root')}>
            <Select id="th-skill-import-root" value={targetRoot} options={importOptions} onChange={setImportRoot} label={pick(lang, '目标根目录', 'Target root')} />
          </Field>
          <div className="th-row">
            <div className="th-row-body">
              <span className="th-row-name">{pick(lang, '覆盖同名技能', 'Overwrite an existing skill')}</span>
              <span className="th-row-meta">{pick(lang, '关掉时同名的文件夹会被跳过。', 'When off, a folder with the same name is skipped.')}</span>
            </div>
            <Switch checked={overwrite} onChange={setOverwrite} label={pick(lang, '覆盖同名技能', 'Overwrite an existing skill')} />
          </div>
        </div>
      </Dialog>

      <Dialog
        open={moving !== null}
        title={pick(lang, '移动到另一个根目录', 'Move to another root')}
        onClose={() => { setMoving(null) }}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setMoving(null) }}>{t('action.cancel')}</Button>
            <Button
              variant="primary"
              busy={moving !== null && busy === busyKey(OPS.move, moving.id)}
              disabled={moveTarget === ''}
              onClick={() => { void confirmMove() }}
            >
              {t('action.confirm')}
            </Button>
          </>
        }
      >
        <div className="th-list">
          <div className="th-row">
            <div className="th-row-body">
              <span className="th-row-name">{moving === null ? '' : moving.name}</span>
              <span className="th-row-meta">
                <span className="th-mono">{moving === null ? '' : moving.id}</span>
              </span>
            </div>
          </div>
          <Field id="th-skill-move-root" label={pick(lang, '目标根目录', 'Target root')}>
            <Select
              id="th-skill-move-root"
              value={moveTarget}
              options={roots.filter(item => item.id !== (moving === null ? '' : moving.rootId)).map(item => ({ value: item.id, label: item.label ?? item.id }))}
              onChange={setMoveTarget}
              label={pick(lang, '目标根目录', 'Target root')}
            />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={deleting !== null}
        title={t('dialog.confirmTitle')}
        onClose={() => { setDeleting(null) }}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setDeleting(null) }}>{t('action.cancel')}</Button>
            <Button
              variant="danger"
              busy={deleting !== null && busy === busyKey(OPS.delete, deleting.id)}
              onClick={() => { void confirmDelete() }}
            >
              {t('action.delete')}
            </Button>
          </>
        }
      >
        {deleting === null
          ? ''
          : pick(
              lang,
              `把「${deleting.name}」移到回收站？技能文件夹整体搬走，之后可以在回收站里恢复。`,
              `Move “${deleting.name}” to the trash? The folder moves whole and can be restored from the trash later.`,
            )}
      </Dialog>
      <GroupMembershipDialog open={assignMember !== null} mode="member" member={assignMember ?? undefined} groups={snapshot.groups} snapshot={snapshot} lang={lang} t={t} busy={busy} run={run} onClose={() => { setAssignMember(null) }} />
    </div>
  )
}