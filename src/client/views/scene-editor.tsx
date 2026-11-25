/**
 * The scene editor: one dialog for creating and editing a saved environment.
 *
 * Sections are opt-in on purpose. A scene section means "leave this domain alone" when it is
 * absent and "set exactly this" when it is present, so the editor has to expose that choice: a
 * section whose switch is off is not sent at all, and a section that is on is sent even when its
 * list is empty (which clears the domain). Flattening the two into one "empty" state is how a
 * user would wipe a mask they never meant to touch.
 *
 * The dialog owns the draft while it is open and writes nothing until Save: every keystroke
 * staying local is what makes Cancel mean what it says. The parent remounts it (a `key`) per
 * scene so the initial value is never stale.
 */
import * as React from 'react'
import { Button, Dialog, Field, Select } from '../components.js'
import type { TFunction } from '../i18n.js'
import type { HubSnapshot } from '../types.js'

/** What the dialog holds while it is open; `isNew` only decides whether the name is editable. */
export interface SceneDraft {
  isNew: boolean
  name: string
  pluginsOn: boolean
  plugins: string[]
  skillsOn: boolean
  skills: string[]
  toolsOn: boolean
  tools: string
  mcpOn: boolean
  mcpOff: string
  mcpAdd: string
  preset: string
}

/** Ids or names typed into one box: spaces, commas and newlines all separate. */
export function namesOf(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/u).map(part => part.trim()).filter(part => part !== ''))]
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** A stored scene record, as the editor needs to show it. Absent sections stay distinguishable. */
export function draftFromScene(name: string, value: unknown): SceneDraft {
  const record = recordOf(value)
  const tools = recordOf(record.tools)
  const mcp = recordOf(record.mcp)
  return {
    isNew: false,
    name,
    pluginsOn: 'plugins' in record,
    plugins: listOf(record.plugins),
    skillsOn: 'skills' in record,
    skills: listOf(record.skills),
    toolsOn: 'tools' in record,
    tools: listOf(tools.deny).join('\n'),
    mcpOn: 'mcp' in record,
    mcpOff: listOf(mcp.off).join('\n'),
    mcpAdd: listOf(mcp.on).join('\n'),
    preset: typeof record.preset === 'string' ? record.preset : '',
  }
}

/**
 * A new scene starts from the live environment: every enabled plugin and skill, the current mask
 * and the servers that are currently off. That is what "save the current environment" means; the
 * user can then switch any section off before saving.
 */
export function draftFromEnvironment(snapshot: HubSnapshot): SceneDraft {
  return {
    isNew: true,
    name: '',
    pluginsOn: true,
    plugins: snapshot.plugins.filter(row => row.enabled && row.manageable !== false).map(row => row.id),
    skillsOn: true,
    skills: snapshot.skills.filter(row => row.enabled).map(row => row.id),
    toolsOn: true,
    tools: snapshot.tools.filter(row => !row.enabled && row.name.startsWith('mcp__')).map(row => row.name).join('\n'),
    mcpOn: true,
    // The MCP section names servers, and the snapshot's display name for an MCP row is the server name.
    mcpOff: snapshot.plugins.filter(row => row.mcp === true && !row.enabled).map(row => row.name).join('\n'),
    mcpAdd: '',
    preset: '',
  }
}

/** The `scene.save` payload: only the sections that are switched on, plus a preset when bound. */
export function scenePayload(draft: SceneDraft): Record<string, unknown> {
  const body: Record<string, unknown> = { name: draft.name.trim() }
  if (draft.pluginsOn) body.plugins = draft.plugins
  if (draft.skillsOn) body.skills = draft.skills
  if (draft.toolsOn) body.tools = { deny: namesOf(draft.tools) }
  if (draft.mcpOn) body.mcp = { off: namesOf(draft.mcpOff), on: namesOf(draft.mcpAdd) }
  if (draft.preset !== '') body.preset = draft.preset
  return body
}

interface Candidate {
  id: string
  label: string
  extra: boolean
}

/** Rows a section can switch, plus ids the scene lists that the live catalog no longer has. */
function candidates(rows: Array<{ id: string; name?: string; manageable?: boolean }>, selected: readonly string[]): Candidate[] {
  const out: Candidate[] = rows.filter(row => row.manageable !== false).map(row => ({ id: row.id, label: row.name ?? row.id, extra: false }))
  const known = new Set(out.map(row => row.id))
  for (const id of selected) if (!known.has(id)) out.push({ id, label: id, extra: true })
  return out.sort((left, right) => left.label.localeCompare(right.label))
}

interface SectionProps {
  id: string
  label: string
  hint: string
  on: boolean
  onToggle: (next: boolean) => void
  children: React.ReactNode
}

/** One section: a switch that decides whether it is part of the scene, then its controls. */
function Section(props: SectionProps): React.ReactElement {
  return (
    <div className="th-row-body" style={{ marginTop: 12 }}>
      <label className="th-row-name" htmlFor={props.id + '-on'} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input id={props.id + '-on'} type="checkbox" checked={props.on} onChange={event => props.onToggle(event.target.checked)} />
        {props.label}
      </label>
      {props.on ? props.children : <span className="th-field-hint">{props.hint}</span>}
    </div>
  )
}

interface MemberListProps {
  id: string
  rows: Candidate[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  empty: string
  extraLabel: string
}

/** A checkbox per row: ticked means "this scene keeps it on". */
function MemberList(props: MemberListProps): React.ReactElement {
  if (props.rows.length === 0) return <span className="th-field-hint">{props.empty}</span>
  return (
    <div id={props.id} style={{ maxHeight: 168, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: 6, marginTop: 4 }}>
      {props.rows.map(row => (
        <label key={row.id} style={{ display: 'block', padding: '2px 0', fontSize: 12 }}>
          <input
            type="checkbox"
            checked={props.selected.includes(row.id)}
            onChange={event => {
              const rest = props.selected.filter(id => id !== row.id)
              props.onChange(event.target.checked ? [...rest, row.id] : rest)
            }}
          />{' '}
          <span className="th-mono">{row.label}</span>
          {row.extra ? <span className="th-field-hint"> {props.extraLabel}</span> : null}
        </label>
      ))}
    </div>
  )
}

export interface SceneEditorProps {
  /** Initial draft; the dialog keeps its own copy from here on. */
  draft: SceneDraft
  snapshot: HubSnapshot
  t: TFunction
  busy: string | null
  onClose: () => void
  onSave: (draft: SceneDraft) => void
}

export function SceneEditor(props: SceneEditorProps): React.ReactElement {
  const { snapshot, t } = props
  const [draft, setDraft] = React.useState<SceneDraft>(props.draft)
  const patch = (next: Partial<SceneDraft>): void => {
    setDraft(current => ({ ...current, ...next }))
  }
  // Synthetic installed-disabled bundle rows are not loader entries; scenes cannot apply them.
  const pluginRows = candidates(snapshot.plugins.filter(row => row.bundleName === undefined), draft.plugins)
  const skillRows = candidates(snapshot.skills, draft.skills)
  const presetOptions = [
    { value: '', label: t('scenes.editor.presetNone') },
    ...Object.keys(snapshot.presets).sort().map(name => ({ value: name, label: name })),
  ]
  const saving = props.busy === 'scene.save:' + draft.name.trim()
  return (
    <Dialog
      open
      title={draft.isNew ? t('scenes.editor.create') : t('scenes.editor.edit')}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" busy={saving} disabled={draft.name.trim() === ''} onClick={() => props.onSave(draft)}>
            {t('action.save')}
          </Button>
        </>
      }
    >
      <Field id="th-scene-name" label={t('scenes.editor.name')} hint={t('scenes.editor.nameHint')}>
        <input
          id="th-scene-name"
          className="th-input"
          type="text"
          value={draft.name}
          disabled={!draft.isNew}
          spellCheck={false}
          aria-label={t('scenes.editor.name')}
          onChange={event => patch({ name: event.target.value })}
        />
      </Field>
      <Field id="th-scene-preset" label={t('scenes.editor.preset')} hint={t('scenes.editor.presetHint')}>
        <Select id="th-scene-preset" label={t('scenes.editor.preset')} value={draft.preset} options={presetOptions} onChange={value => patch({ preset: value })} />
      </Field>
      <Section id="th-scene-plugins" label={t('scenes.editor.plugins')} hint={t('scenes.editor.sectionOff')} on={draft.pluginsOn} onToggle={on => patch({ pluginsOn: on })}>
        <span className="th-field-hint">{t('scenes.editor.pluginsHint')}</span>
        <MemberList id="th-scene-plugins-list" rows={pluginRows} selected={draft.plugins} onChange={next => patch({ plugins: next })} empty={t('scenes.editor.noRows')} extraLabel={t('scenes.editor.extra')} />
      </Section>
      <Section id="th-scene-skills" label={t('scenes.editor.skills')} hint={t('scenes.editor.sectionOff')} on={draft.skillsOn} onToggle={on => patch({ skillsOn: on })}>
        <span className="th-field-hint">{t('scenes.editor.skillsHint')}</span>
        <MemberList id="th-scene-skills-list" rows={skillRows} selected={draft.skills} onChange={next => patch({ skills: next })} empty={t('scenes.editor.noRows')} extraLabel={t('scenes.editor.extra')} />
      </Section>
      <Section id="th-scene-tools" label={t('scenes.editor.tools')} hint={t('scenes.editor.sectionOff')} on={draft.toolsOn} onToggle={on => patch({ toolsOn: on })}>
        <Field id="th-scene-tools-list" label={t('scenes.editor.deny')} hint={t('scenes.editor.toolsHint')}>
          <textarea id="th-scene-tools-list" className="th-input" rows={3} value={draft.tools} spellCheck={false} aria-label={t('scenes.editor.deny')} onChange={event => patch({ tools: event.target.value })} />
        </Field>
      </Section>
      <Section id="th-scene-mcp" label={t('scenes.editor.mcp')} hint={t('scenes.editor.sectionOff')} on={draft.mcpOn} onToggle={on => patch({ mcpOn: on })}>
        <span className="th-field-hint">{t('scenes.editor.mcpHint')}</span>
        <Field id="th-scene-mcp-off" label={t('scenes.editor.mcpOff')}>
          <textarea id="th-scene-mcp-off" className="th-input" rows={2} value={draft.mcpOff} spellCheck={false} aria-label={t('scenes.editor.mcpOff')} onChange={event => patch({ mcpOff: event.target.value })} />
        </Field>
        <Field id="th-scene-mcp-on" label={t('scenes.editor.mcpAdd')}>
          <textarea id="th-scene-mcp-on" className="th-input" rows={2} value={draft.mcpAdd} spellCheck={false} aria-label={t('scenes.editor.mcpAdd')} onChange={event => patch({ mcpAdd: event.target.value })} />
        </Field>
      </Section>
    </Dialog>
  )
}