/**
 * The panel's primitives.
 *
 * Nothing here knows about the hub: components take strings and callbacks, so the views own
 * copy and data. Keyboard and screen-reader behaviour lives here once — role/aria on the
 * switch and dialog, Escape to dismiss, focus returned where it came from.
 */
import * as React from 'react'
import { FONT, R, SP, T } from './theme.js'

/** Stable ids without depending on React's useId being present in the host runtime. */
let uid = 0

function useUid(prefix: string): string {
  const [id] = React.useState(() => {
    uid += 1
    return `${prefix}-${uid}`
  })
  return id
}

// ── Button ───────────────────────────────────────────────────────────────────

export interface ButtonProps {
  children?: React.ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  busy?: boolean
  title?: string
  label?: string
  type?: 'button' | 'submit'
  /** Extra class on the button element, for plugins that need a stable hook. */
  className?: string
}

export function Button(props: ButtonProps): React.ReactElement {
  const variant = props.variant === undefined ? 'default' : props.variant
  const disabled = props.disabled === true || props.busy === true
  return (
    <button
      type={props.type ?? 'button'}
      className={(variant === 'default' ? 'th-btn' : `th-btn th-btn--${variant}`) + (props.className === undefined ? '' : ' ' + props.className)}
      onClick={props.onClick}
      disabled={disabled}
      aria-busy={props.busy === true}
      aria-label={props.label}
      title={props.title}
    >
      {props.busy === true ? <span className="th-spin" aria-hidden="true" /> : null}
      {props.children}
    </button>
  )
}

// ── Switch ───────────────────────────────────────────────────────────────────

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** Accessible name: what this switch turns on and off. */
  label: string
  disabled?: boolean
  busy?: boolean
}

export function Switch(props: SwitchProps): React.ReactElement {
  const disabled = props.disabled === true || props.busy === true
  return (
    <span className="th-switch-wrap">
      {props.busy === true ? <span className="th-spin" aria-hidden="true" /> : null}
      <button
        type="button"
        role="switch"
        className="th-switch"
      aria-checked={props.checked}
      aria-label={props.label}
      aria-busy={props.busy === true}
      disabled={disabled}
      onClick={() => {
        props.onChange(!props.checked)
      }}
    >
        <span className="th-knob" aria-hidden="true" />
      </button>
    </span>
  )
}

// ── Badge ────────────────────────────────────────────────────────────────────

export interface BadgeProps {
  children: React.ReactNode
  tone?: 'neutral' | 'on' | 'off' | 'warn' | 'danger' | 'brand'
  title?: string
}

export function Badge(props: BadgeProps): React.ReactElement {
  const tone = props.tone === undefined || props.tone === 'neutral' ? '' : ` th-badge--${props.tone}`
  return (
    <span className={`th-badge${tone}`} title={props.title}>
      {props.children}
    </span>
  )
}

// ── Field ────────────────────────────────────────────────────────────────────

export interface FieldProps {
  id: string
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}

export function Field(props: FieldProps): React.ReactElement {
  return (
    <div className="th-field">
      <label className="th-field-label" htmlFor={props.id}>
        {props.label}
      </label>
      {props.children}
      {props.hint !== undefined && props.error === undefined ? (
        <span className="th-field-hint" id={`${props.id}-hint`}>
          {props.hint}
        </span>
      ) : null}
      {props.error !== undefined ? (
        <span className="th-field-error" id={`${props.id}-error`} role="alert">
          {props.error}
        </span>
      ) : null}
    </div>
  )
}

// ── Select ───────────────────────────────────────────────────────────────────

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps {
  id: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  label: string
  disabled?: boolean
}

export function Select(props: SelectProps): React.ReactElement {
  return (
    <select
      id={props.id}
      className="th-select"
      value={props.value}
      disabled={props.disabled === true}
      aria-label={props.label}
      onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
        props.onChange(event.target.value)
      }}
    >
      {props.options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

// ── Search box ───────────────────────────────────────────────────────────────

export interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
  onClear?: () => void
  clearLabel?: string
}

export function SearchBox(props: SearchBoxProps): React.ReactElement {
  const id = useUid('th-search')
  return (
    <div className="th-toolbar" style={{ flex: '1 1 240px', margin: 0 }}>
      <label className="th-visually-hidden" htmlFor={id}>
        {props.label}
      </label>
      <input
        id={id}
        className="th-input"
        type="search"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          props.onChange(event.target.value)
        }}
      />
      {props.value !== '' && props.onClear !== undefined ? (
        <Button variant="ghost" label={props.clearLabel ?? 'Clear'} onClick={props.onClear}>
          {props.clearLabel ?? 'Clear'}
        </Button>
      ) : null}
    </div>
  )
}

// ── Empty ────────────────────────────────────────────────────────────────────

export interface EmptyProps {
  title: string
  hint?: string
  action?: React.ReactNode
}

export function Empty(props: EmptyProps): React.ReactElement {
  return (
    <div className="th-empty" role="status">
      <span className="th-empty-title">{props.title}</span>
      {props.hint !== undefined ? <span>{props.hint}</span> : null}
      {props.action}
    </div>
  )
}

// ── Loading ──────────────────────────────────────────────────────────────────

export interface LoadingProps {
  label: string
  rows?: number
}

export function Loading(props: LoadingProps): React.ReactElement {
  const rows = props.rows ?? 4
  const items: React.ReactNode[] = []
  for (let index = 0; index < rows; index += 1) {
    items.push(
      <div key={index} className="th-row" aria-hidden="true">
        <div className="th-row-body">
          <div className="th-skel" style={{ width: `${58 + ((index * 13) % 30)}%` }} />
          <div className="th-skel th-skel--sm" />
        </div>
      </div>,
    )
  }
  return (
    <div className="th-card" role="status" aria-live="polite" aria-busy="true">
      <span className="th-visually-hidden">{props.label}</span>
      {items}
    </div>
  )
}

// ── Dialog ───────────────────────────────────────────────────────────────────

export interface DialogProps {
  open: boolean
  title: string
  onClose: () => void
  children?: React.ReactNode
  footer?: React.ReactNode
  /** Restore focus to this element on close; falls back to the previously focused node. */
  returnFocusTo?: HTMLElement | null
}

export function Dialog(props: DialogProps): React.ReactElement | null {
  const titleId = useUid('th-dialog-title')
  const bodyId = useUid('th-dialog-body')
  const ref = React.useRef<HTMLDivElement | null>(null)
  // Callers pass inline closures; keeping them in refs means typing in a field never re-runs the
  // focus effect (which would return focus to the previous element and break IME composition).
  const closeRef = React.useRef(props.onClose)
  closeRef.current = props.onClose
  const returnRef = React.useRef(props.returnFocusTo)
  returnRef.current = props.returnFocusTo

  React.useEffect(() => {
    if (!props.open || typeof document === 'undefined') return undefined
    const previous = returnRef.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const node = ref.current
    node?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || node === null) return
      const focusable = node.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [props.open])

  if (!props.open) return null
  return (
    <div
      className="th-backdrop"
      onMouseDown={(event: React.MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        ref={ref}
        className="th-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
      >
        <div className="th-dialog-title" id={titleId}>
          {props.title}
        </div>
        <div className="th-dialog-body" id={bodyId}>
          {props.children}
        </div>
        <div className="th-dialog-foot">{props.footer}</div>
      </div>
    </div>
  )
}

// ── Layout helpers ───────────────────────────────────────────────────────────

export interface CalloutProps {
  tone?: 'error' | 'info'
  children: React.ReactNode
  action?: React.ReactNode
}

/** Inline failure banner: a failed op or a host error the user can act on. */
export function Callout(props: CalloutProps): React.ReactElement {
  const tone = props.tone ?? 'error'
  return (
    <div
      className="th-notice"
      role={tone === 'error' ? 'alert' : 'status'}
      style={tone === 'info' ? { borderColor: T.border, background: T.surface } : undefined}
    >
      <span style={{ flex: '1 1 auto', minWidth: 0 }}>{props.children}</span>
      {props.action}
    </div>
  )
}

/**
 * A row-level boundary: one malformed row renders a local failure card instead of taking the
 * whole view down. The retry remounts just this row.
 */
export class RowBoundary extends React.Component<{ label: string; retry: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('[tool-hub] row render failed', error)
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <Callout
        action={
          <Button onClick={() => { this.setState({ failed: false }) }}>{this.props.retry}</Button>
        }
      >
        {this.props.label}
      </Callout>
    )
  }
}

export interface ToolbarProps {
  children: React.ReactNode
}

export function Toolbar(props: ToolbarProps): React.ReactElement {
  return <div className="th-toolbar">{props.children}</div>
}

export interface CardProps {
  children: React.ReactNode
  label?: string
}

export function Card(props: CardProps): React.ReactElement {
  return (
    <div className="th-card" role={props.label === undefined ? undefined : 'group'} aria-label={props.label}>
      {props.children}
    </div>
  )
}

/** Exported so a view can lay out a row without re-deriving the class names. */
export const monoStyle: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: FONT.xs, color: T.text3 }
export const rowGap = SP.md
export const radiusMd = R.md