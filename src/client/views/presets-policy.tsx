/**
 * Preset tool policy editor (G11a): one preset's disabled tools and its named groups.
 *
 * The dialog is a draft over the stored policy. Opening it reads `preset.policy` with only a name
 * (the read path - no write, no backup), which is also where the live catalog comes from; nothing
 * is written until 保存. Two actions clear, and they mean different things: 重置 calls
 * `preset.policyReset` (an empty policy that still wins over the recorded deny list) while
 * 移除策略 saves `toolPolicy: null` (the preset stops having a policy at all). Both ask first;
 * neither touches `enabled` or `toolDeny`, and the confirmation text says so.
 *
 * Groups are stored, not enforced: G11b makes their members disappear at runtime, and until then
 * the notice above the list says so instead of pretending. The copy dialog projects the SAVED
 * policy onto each target's tool catalog (the server does the real projection), so it is disabled
 * while the draft is dirty rather than copying something the user has not saved.
 *
 * The group editor lives in presets-policy-groups.tsx so this file stays one screen of reading.
 */
import * as React from 'react'
import { Badge, Button, Callout, Dialog, SearchBox, Select, Switch } from '../components.js'
import { PolicyGroupsEditor } from './presets-policy-groups.js'
import {
  emptyPolicy,
  memberOf,
  policyChangeCount,
  policyDirty,
  policyIssues,
  projectPolicy,
} from '../../domains/preset-policy.js'
import type { PresetToolPolicy } from '../../domains/preset-policy.js'
import type { TFunction } from '../i18n.js'
import type { RunDetailedOp } from '../types.js'

/** The prefix the host mask understands; a tool the mask cannot deny is not offered. */
const MASKABLE = 'mcp__'

const OP = {
  policy: 'preset.policy',
  reset: 'preset.policyReset',
  copy: 'preset.copy',
} as const

type Filter = 'all' | 'disabled' | 'grouped' | 'ungrouped'

interface Loaded {
  saved: PresetToolPolicy | null
  updatedAt: number | null
  catalog: string[]
}

function catalogOf(value: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!name.startsWith(MASKABLE) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out.sort()
}

/** A policy from a host answer; null means "this preset has no policy", not "an empty one". */
function policyOf(value: unknown): PresetToolPolicy | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as { disabled?: unknown, groups?: unknown }
  const disabled = Array.isArray(raw.disabled) ? raw.disabled.filter((name): name is string => typeof name === 'string') : []
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map(entry => {
      const group = (typeof entry === 'object' && entry !== null ? entry : {}) as { name?: unknown, description?: unknown, patterns?: unknown }
      return {
        name: typeof group.name === 'string' ? group.name : '',
        ...(typeof group.description === 'string' && group.description !== '' ? { description: group.description } : {}),
        patterns: Array.isArray(group.patterns) ? group.patterns.filter((pattern): pattern is string => typeof pattern === 'string') : [],
      }
    }).filter(group => group.name !== '')
    : []
  return { disabled, groups }
}

export interface PresetPolicyDialogProps {
  open: boolean
  /** The preset being edited; the dialog renders nothing while this is empty. */
  name: string
  t: TFunction
  /** Every preset the copy dialog may target, with the tools its snapshot records. */
  targets: Record<string, string[]>
  runDetailed: RunDetailedOp
  onClose: () => void
}

export function PresetPolicyDialog(props: PresetPolicyDialogProps): React.ReactElement | null {
  const { open, name, t, targets, runDetailed, onClose } = props
  const [loaded, setLoaded] = React.useState<Loaded | null>(null)
  const [draft, setDraft] = React.useState<PresetToolPolicy | null>(null)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<Filter>('all')
  const [confirm, setConfirm] = React.useState<'reset' | 'remove' | 'close' | null>(null)
  const [copyOpen, setCopyOpen] = React.useState(false)
  const [copyTo, setCopyTo] = React.useState<string[]>([])
  const idBase = 'th-policy'

  const applyLoaded = React.useCallback((data: unknown, known?: readonly string[]) => {
    const raw = (typeof data === 'object' && data !== null ? data : {}) as { toolPolicy?: unknown, updatedAt?: unknown, known?: unknown }
    const saved = policyOf(raw.toolPolicy)
    const catalog = known === undefined ? catalogOf(raw.known) : [...known]
    setLoaded({ saved, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null, catalog })
    setDraft(saved)
  }, [])

  React.useEffect(() => {
    if (!open || name === '') return
    setLoaded(null)
    setDraft(null)
    setError('')
    setNotice('')
    setQuery('')
    setFilter('all')
    setConfirm(null)
    setCopyOpen(false)
    setCopyTo([])
    void runDetailed(OP.policy, { id: name, name }).then(outcome => {
      if (!outcome.ok) {
        setError(outcome.error ?? 'load-failed')
        setLoaded({ saved: null, updatedAt: null, catalog: [] })
        return
      }
      applyLoaded(outcome.data)
    })
  }, [open, name, runDetailed, applyLoaded])

  if (!open || name === '') return null

  const catalog = loaded?.catalog ?? []
  const saved = loaded?.saved ?? null
  const dirty = policyDirty(saved ?? undefined, draft ?? undefined)
  const changes = policyChangeCount(saved ?? undefined, draft ?? undefined)
  const members = draft === null ? new Map<string, string>() : memberOf(draft, catalog)
  const disabled = new Set(draft === null ? [] : draft.disabled)
  const terms = query.trim().toLowerCase()
  const visible = catalog.filter(tool => {
    if (terms !== '' && !tool.toLowerCase().includes(terms)) return false
    if (filter === 'disabled') return disabled.has(tool)
    if (filter === 'grouped') return members.has(tool)
    if (filter === 'ungrouped') return !members.has(tool)
    return true
  })
  const issues = draft === null ? null : policyIssues(draft, catalog)

  const toggleDisabled = (tool: string, enabled: boolean): void => {
    const next: PresetToolPolicy = draft === null
      ? emptyPolicy()
      : { disabled: [...draft.disabled], groups: draft.groups.map(group => ({ ...group, patterns: [...group.patterns] })) }
    next.disabled = enabled ? next.disabled.filter(entry => entry !== tool) : [...next.disabled, tool]
    next.disabled.sort()
    setDraft(next)
    setNotice('')
  }

  const save = (): void => {
    setBusy(true)
    const stamp = loaded?.updatedAt ?? null
    void runDetailed(OP.policy, {
      id: name,
      name,
      toolPolicy: draft,
      ...(stamp === null ? {} : { expect: { updatedAt: stamp } }),
    }).then(outcome => {
      setBusy(false)
      if (!outcome.ok) {
        setError(outcome.error === 'stale-preset' ? t('policy.stale') : (outcome.error ?? 'save-failed'))
        return
      }
      setError('')
      const raw = (typeof outcome.data === 'object' && outcome.data !== null ? outcome.data : {}) as { warnings?: unknown }
      const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((entry): entry is string => typeof entry === 'string') : []
      setNotice(warnings.length === 0 ? t('policy.saved') : t('policy.warnings', { n: warnings.length }))
      applyLoaded(outcome.data, catalog)
    })
  }

  const applyOp = (op: string, payload: Record<string, unknown>): void => {
    setBusy(true)
    void runDetailed(op, { id: name, ...payload }).then(outcome => {
      setBusy(false)
      if (!outcome.ok) {
        setError(outcome.error ?? 'failed')
        return
      }
      setError('')
      setNotice(t('policy.saved'))
      applyLoaded(outcome.data, catalog)
    })
  }

  const close = (): void => {
    if (dirty) {
      setConfirm('close')
      return
    }
    onClose()
  }

  const copy = (): void => {
    if (copyTo.length === 0) return
    setBusy(true)
    void runDetailed(OP.copy, { id: name, from: name, to: copyTo, what: 'policy' }).then(outcome => {
      setBusy(false)
      if (!outcome.ok) {
        setError(outcome.error ?? 'copy-failed')
        return
      }
      setError('')
      setCopyOpen(false)
      setCopyTo([])
      setNotice(t('policy.saved'))
    })
  }

  const filterOptions = [
    { value: 'all', label: t('policy.filterAll') },
    { value: 'disabled', label: t('policy.filterDisabled') },
    { value: 'grouped', label: t('policy.filterGrouped') },
    { value: 'ungrouped', label: t('policy.filterUngrouped') },
  ]

  return (
    <Dialog
      open
      title={t('policy.title') + ': ' + name}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>{t('action.cancel')}</Button>
          <Button variant="ghost" disabled={loaded === null || busy || dirty} onClick={() => { setCopyOpen(true) }}>
            {t('policy.copy')}
          </Button>
          <Button variant="ghost" busy={busy} onClick={() => { setConfirm('reset') }}>{t('policy.reset')}</Button>
          <Button variant="primary" busy={busy} disabled={!dirty || loaded === null} onClick={save}>{t('policy.save')}</Button>
        </>
      }
    >
      {loaded === null ? (
        <div className="th-row-meta">{t('policy.loading')}</div>
      ) : (
        <div>
          {error === '' ? null : <Callout tone="error">{error}</Callout>}
          {notice === '' ? null : <Callout tone="info">{notice}</Callout>}
          <Callout tone="info">{t('policy.groupsDeferred')}</Callout>

          <div className="th-toolbar">
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder={t('policy.search')}
              label={t('policy.search')}
              onClear={() => { setQuery('') }}
              clearLabel={t('action.clear')}
            />
            <Select
              id={idBase + '-filter'}
              value={filter}
              label={t('policy.title')}
              options={filterOptions}
              onChange={value => {
                setFilter(value === 'disabled' || value === 'grouped' || value === 'ungrouped' ? value : 'all')
              }}
            />
            <Badge>{t('policy.statsTotal', { n: catalog.length })}</Badge>
            <Badge tone="off">{t('policy.statsDisabled', { n: disabled.size })}</Badge>
            <Badge tone="brand">{t('policy.statsGrouped', { n: members.size })}</Badge>
            <Badge>{t('policy.statsUngrouped', { n: catalog.length - members.size })}</Badge>
          </div>

          {catalog.length === 0 ? (
            <div className="th-row-meta">{t('policy.empty')}</div>
          ) : visible.length === 0 ? (
            <div className="th-row-meta">{t('policy.search')}: {query}</div>
          ) : (
            <div className="th-list" role="list">
              {visible.map(tool => {
                const owner = members.get(tool)
                return (
                  <div className="th-row" key={tool} role="listitem">
                    <div className="th-row-body">
                      <span className="th-row-name">{tool}</span>
                      <span className="th-row-meta">
                        {owner === undefined ? null : <Badge tone="brand">{t('policy.memberOf', { name: owner })}</Badge>}
                        {disabled.has(tool) ? <Badge tone="off">{t('tools.masked')}</Badge> : null}
                      </span>
                    </div>
                    <Switch
                      checked={!disabled.has(tool)}
                      disabled={owner !== undefined}
                      label={tool}
                      onChange={next => {
                        toggleDisabled(tool, next)
                      }}
                    />
                  </div>
                )
              })}
            </div>
          )}

          <PolicyGroupsEditor
            policy={draft ?? emptyPolicy()}
            catalog={catalog}
            members={members}
            disabled={disabled}
            t={t}
            idBase={idBase}
            onChange={setDraft}
          />

          {issues === null ? null : (
            <div className="th-row-meta">
              {issues.emptyGroups.map(group => <Badge tone="warn" key={group}>{t('policy.issueEmpty', { name: group })}</Badge>)}
              {issues.duplicateMembers.map(entry => <Badge tone="warn" key={entry.tool}>{t('policy.issueDuplicate', { tool: entry.tool })}</Badge>)}
              {issues.disabledMembers.map(entry => <Badge tone="warn" key={entry.tool}>{t('policy.issueDisabled', { tool: entry.tool })}</Badge>)}
              {issues.orphans.length === 0 ? null : <Badge tone="warn">{t('policy.orphans', { n: issues.orphans.length })}</Badge>}
            </div>
          )}

          <div className="th-toolbar">
            <span className="th-row-meta">{dirty ? t('policy.dirty', { n: changes }) : t('policy.clean')}</span>
            {saved === null ? null : (
              <Button variant="danger" disabled={busy} onClick={() => { setConfirm('remove') }}>{t('policy.remove')}</Button>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={confirm !== null}
        title={t('dialog.confirmTitle')}
        onClose={() => { setConfirm(null) }}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setConfirm(null) }}>{t('action.cancel')}</Button>
            {confirm === 'close' ? (
              <Button variant="danger" onClick={() => { setConfirm(null); onClose() }}>{t('policy.discard')}</Button>
            ) : confirm === 'reset' ? (
              <Button variant="primary" busy={busy} onClick={() => { setConfirm(null); applyOp(OP.reset, { name }) }}>{t('action.confirm')}</Button>
            ) : (
              <Button variant="danger" busy={busy} onClick={() => { setConfirm(null); applyOp(OP.policy, { name, toolPolicy: null }) }}>{t('action.confirm')}</Button>
            )}
          </>
        }
      >
        <div>
          {confirm === 'close'
            ? t('policy.discardBody', { n: changes })
            : confirm === 'reset' ? t('policy.resetBody', { name }) : t('policy.removeBody', { name })}
        </div>
        {confirm === 'close' ? null : <div className="th-row-meta">{t('policy.untouched')}</div>}
      </Dialog>

      <Dialog
        open={copyOpen}
        title={t('policy.copyTitle')}
        onClose={() => { setCopyOpen(false) }}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCopyOpen(false) }}>{t('action.cancel')}</Button>
            <Button variant="primary" busy={busy} disabled={copyTo.length === 0} onClick={copy}>{t('action.confirm')}</Button>
          </>
        }
      >
        {dirty ? <Callout tone="error">{t('policy.copyNeedSave')}</Callout> : null}
        <div className="th-list">
          {Object.keys(targets).filter(to => to !== name).sort().map(to => {
            const plan = projectPolicy(saved ?? emptyPolicy(), [...new Set([...(targets[to] ?? []), ...catalog])])
            return (
              <div className="th-row" key={to}>
                <div className="th-row-body">
                  <span className="th-row-name">{to}</span>
                  <span className="th-row-meta">
                    <Badge tone={plan.entries === 0 ? 'warn' : 'neutral'}>
                      {plan.entries === 0
                        ? t('policy.copyNothing')
                        : t('policy.copyPreview', { tools: plan.entries, groups: plan.skippedGroups.length })}
                    </Badge>
                  </span>
                </div>
                <Switch
                  checked={copyTo.includes(to)}
                  label={t('policy.copy') + ': ' + to}
                  onChange={next => {
                    setCopyTo(next ? [...copyTo, to] : copyTo.filter(entry => entry !== to))
                  }}
                />
              </div>
            )
          })}
        </div>
      </Dialog>
    </Dialog>
  )
}
