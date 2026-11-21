/**
 * The group editor half of the preset policy dialog (G11a).
 *
 * A group is a name, an optional description and a list of exact tool names or patterns; a tool
 * belongs to the first group that matches it (see memberOf in src/domains/preset-policy.ts). The
 * picker therefore only offers tools that are neither disabled nor owned by another group, and a
 * member is added as its exact name so what the user ticked is what is stored.
 *
 * The component owns no authoritative state: it edits a copy of the policy it is given and hands
 * the whole policy back, so the dialog keeps one draft and one dirty flag.
 */
import * as React from 'react'
import { Badge, Button, Field, Select } from '../components.js'
import type { PresetToolPolicy } from '../../domains/preset-policy.js'
import type { TFunction } from '../i18n.js'

export interface PolicyGroupsEditorProps {
  policy: PresetToolPolicy
  catalog: readonly string[]
  /** Tool → owning group, from memberOf(policy, catalog). */
  members: Map<string, string>
  disabled: Set<string>
  t: TFunction
  idBase: string
  onChange: (next: PresetToolPolicy) => void
}

export function PolicyGroupsEditor(props: PolicyGroupsEditorProps): React.ReactElement {
  const { policy, catalog, members, disabled, t, idBase, onChange } = props
  const [name, setName] = React.useState('')

  const mutate = (change: (next: PresetToolPolicy) => void): void => {
    const next: PresetToolPolicy = {
      disabled: [...policy.disabled],
      groups: policy.groups.map(group => ({ ...group, patterns: [...group.patterns] })),
    }
    change(next)
    onChange(next)
  }

  const addGroup = (): void => {
    const group = name.trim()
    if (group === '') return
    mutate(next => {
      next.groups = [...next.groups, { name: group, patterns: [] }]
    })
    setName('')
  }

  const patch = (index: number, change: (group: PresetToolPolicy['groups'][number]) => void): void => {
    mutate(next => {
      const group = next.groups[index]
      if (group === undefined) return
      change(group)
      next.groups = [...next.groups]
    })
  }

  return (
    <div>
      <div className="th-section-title" style={{ marginTop: 12 }}>{t('policy.groupsTitle')}</div>
      <div className="th-row-meta">{t('policy.groupHint')}</div>
      {policy.groups.length === 0 ? <div className="th-row-meta">{t('policy.noGroups')}</div> : null}

      {policy.groups.map((group, index) => {
        const eligible = catalog.filter(tool =>
          !disabled.has(tool) && (members.get(tool) === undefined || members.get(tool) === group.name))
        return (
          <div className="th-row" key={group.name + ':' + String(index)}>
            <div className="th-row-body">
              <Field id={idBase + '-name-' + String(index)} label={t('policy.groupName')}>
                <input
                  id={idBase + '-name-' + String(index)}
                  className="th-input"
                  type="text"
                  value={group.name}
                  maxLength={60}
                  aria-label={t('policy.groupName')}
                  onChange={event => {
                    const value = event.target.value
                    patch(index, entry => { entry.name = value })
                  }}
                />
              </Field>
              <Field id={idBase + '-desc-' + String(index)} label={t('policy.groupDescription')}>
                <input
                  id={idBase + '-desc-' + String(index)}
                  className="th-input"
                  type="text"
                  value={group.description ?? ''}
                  maxLength={200}
                  aria-label={t('policy.groupDescription')}
                  onChange={event => {
                    const value = event.target.value
                    patch(index, entry => {
                      if (value === '') delete entry.description
                      else entry.description = value
                    })
                  }}
                />
              </Field>
              <span className="th-row-meta">
                {group.patterns.length === 0
                  ? <Badge tone="warn">{t('policy.issueNoPatterns', { name: group.name })}</Badge>
                  : group.patterns.map(pattern => (
                    <Badge key={pattern}>
                      {pattern}
                      <button
                        type="button"
                        className="th-btn th-btn--ghost"
                        aria-label={t('policy.dropMember') + ': ' + pattern}
                        onClick={() => {
                          patch(index, entry => {
                            entry.patterns = entry.patterns.filter(entry2 => entry2 !== pattern)
                          })
                        }}
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
              </span>
              <Select
                id={idBase + '-add-' + String(index)}
                value=""
                label={t('policy.groupMembers')}
                options={[{ value: '', label: t('policy.groupMembers') }, ...eligible.map(tool => ({ value: tool, label: tool }))]}
                onChange={value => {
                  if (value === '') return
                  patch(index, entry => {
                    if (!entry.patterns.includes(value)) entry.patterns = [...entry.patterns, value]
                  })
                }}
              />
            </div>
            <Button
              variant="danger"
              label={t('policy.deleteGroup') + ': ' + group.name}
              onClick={() => {
                mutate(next => {
                  next.groups = next.groups.filter((_, at) => at !== index)
                })
              }}
            >
              {t('policy.deleteGroup')}
            </Button>
          </div>
        )
      })}

      <div className="th-row">
        <div className="th-row-body">
          <Field id={idBase + '-group'} label={t('policy.newGroup')}>
            <input
              id={idBase + '-group'}
              className="th-input"
              type="text"
              value={name}
              maxLength={60}
              aria-label={t('policy.newGroup')}
              onChange={event => {
                setName(event.target.value)
              }}
            />
          </Field>
        </div>
        <Button variant="ghost" disabled={name.trim() === ''} label={t('policy.newGroup')} onClick={addGroup}>
          {t('policy.newGroup')}
        </Button>
      </div>
    </div>
  )
}
