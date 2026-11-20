/**
 * How one declared field renders, and the row it sits in.
 *
 * The four kinds map onto the panel's own primitives: a switch, a select, a text input, a
 * number input. Everything is a native control, so Tab/Enter/arrow keys work without a key
 * handler, and every control carries an accessible name plus the hint as its description.
 */
import * as React from 'react'
import type { SettingsField } from '../../shared/types.js'
import type { Lang, TFunction } from '../i18n.js'
import { Badge, Select, Switch } from '../components.js'
import { SP, T } from '../theme.js'
import { displayValueOf, fieldKind, pick } from './model.js'

export interface FieldRowProps {
  field: SettingsField
  value: unknown
  lang: Lang
  t: TFunction
  disabled: boolean
  dirty: boolean
  onChange: (value: unknown) => void
}

/** A number input that keeps its own text, so "-", "1." and "" stay typable while the value is a number. */
function NumberInput(props: {
  id: string
  value: unknown
  min?: number
  max?: number
  disabled: boolean
  label: string
  describedBy?: string
  onChange: (value: unknown) => void
}): React.ReactElement {
  const text = typeof props.value === 'number' && Number.isFinite(props.value) ? String(props.value) : ''
  const [buffer, setBuffer] = React.useState(text)
  const [seen, setSeen] = React.useState<unknown>(props.value)
  if (!Object.is(seen, props.value)) {
    setSeen(props.value)
    setBuffer(text)
  }
  return (
    <input
      id={props.id}
      className="th-input"
      type="number"
      inputMode="numeric"
      step={1}
      min={props.min}
      max={props.max}
      value={buffer}
      disabled={props.disabled}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      style={{ flex: '0 0 120px', textAlign: 'right' }}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
        const next = event.target.value
        setBuffer(next)
        props.onChange(next === '' ? '' : Number(next))
      }}
    />
  )
}

export function FieldRow(props: FieldRowProps): React.ReactElement {
  const { field, value, lang, t } = props
  const kind = fieldKind(field)
  const label = pick(field.label, lang)
  const hint = field.hint === undefined ? '' : pick(field.hint, lang)
  const id = `th-setting-${field.key.replace(/[^\w.-]+/g, '-')}`
  const hintId = hint === '' ? undefined : `${id}-hint`
  const range =
    kind === 'number' && (typeof field.min === 'number' || typeof field.max === 'number')
      ? t('settings.range', {
          min: typeof field.min === 'number' ? String(field.min) : '-∞',
          max: typeof field.max === 'number' ? String(field.max) : '∞',
        })
      : ''
  const defaultText = t('settings.default', { value: displayValueOf(field, field.default, lang) })

  let control: React.ReactNode
  if (kind === 'boolean') {
    control = (
      <Switch
        checked={value === true}
        disabled={props.disabled}
        label={label}
        onChange={next => {
          props.onChange(next)
        }}
      />
    )
  } else if (kind === 'select') {
    const options = (field.options ?? []).map(option => ({ value: option.value, label: pick(option.label, lang) }))
    control = (
      <Select
        id={id}
        value={typeof value === 'string' ? value : ''}
        options={options}
        label={label}
        disabled={props.disabled}
        onChange={next => {
          props.onChange(next)
        }}
      />
    )
  } else if (kind === 'number') {
    control = (
      <NumberInput
        id={id}
        value={value}
        min={field.min}
        max={field.max}
        disabled={props.disabled}
        label={label}
        describedBy={hintId}
        onChange={next => {
          props.onChange(next)
        }}
      />
    )
  } else {
    control = (
      <input
        id={id}
        className="th-input"
        type="text"
        value={typeof value === 'string' ? value : ''}
        disabled={props.disabled}
        aria-label={label}
        aria-describedby={hintId}
        style={{ flex: '1 1 200px' }}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          props.onChange(event.target.value)
        }}
      />
    )
  }

  return (
    <div className="th-row" style={{ alignItems: 'flex-start' }}>
      <div className="th-row-body">
        {kind === 'boolean' ? (
          <span className="th-field-label" id={`${id}-label`}>
            {label}
          </span>
        ) : (
          <label className="th-field-label" htmlFor={id}>
            {label}
          </label>
        )}
        <span className="th-mono" style={{ color: T.text3 }} title={defaultText}>
          {field.key}
        </span>
        {hint === '' ? null : (
          <span className="th-field-hint" id={hintId}>
            {hint}
          </span>
        )}
        {range === '' ? null : <span className="th-field-hint">{range}</span>}
      </div>
      {props.dirty ? <Badge tone="warn">{t('settings.modified')}</Badge> : null}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: SP.sm,
          minWidth: 200,
        }}
      >
        {control}
      </div>
    </div>
  )
}
