/**
 * Design tokens and the one stylesheet the panel injects.
 *
 * Colour is never chosen here: each token is a lookup into the shell's own
 * --dsw-alias-* variables with a neutral fallback, so light and dark both follow the host.
 * Raw values exist only inside those fallbacks.
 */

export const T = {
  base: 'var(--dsw-alias-bg-base, transparent)',
  surface: 'var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.06))',
  card: 'var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.07))',
  cardHover: 'var(--dsw-alias-card-fill-hover, rgba(127, 127, 127, 0.12))',
  border: 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24))',
  borderSoft: 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14))',
  text: 'var(--dsw-alias-label-primary, inherit)',
  text2: 'var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.96))',
  text3: 'var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.78))',
  brand: 'var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1))',
  brandHover: 'var(--dsw-alias-button-primary-hover, rgba(63, 95, 224, 1))',
  onBrand: 'var(--dsw-alias-label-on-color, rgba(255, 255, 255, 1))',
  danger: 'var(--dsw-alias-state-error-primary, rgba(229, 72, 77, 1))',
  dangerHover: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(229, 72, 77, 0.16))',
  success: 'var(--dsw-alias-state-success-primary, rgba(18, 179, 168, 1))',
  warn: 'var(--dsw-alias-state-warn-primary, rgba(224, 163, 58, 1))',
  overlay: 'var(--dsw-alias-bg-overlay, rgba(0, 0, 0, 0.42))',
  switchThumb: 'var(--dsw-alias-switch-thumb, rgba(255, 255, 255, 1))',
  switchOff: 'var(--dsw-alias-switch-off, rgba(127, 127, 127, 0.36))',
  focus: 'var(--dsw-alias-border-focus, var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1)))',
  seg: 'var(--dsw-alias-bg-l3, rgba(127, 127, 127, 0.1))',
  shadow: 'var(--dsw-alias-shadow-popover, rgba(0, 0, 0, 0.28))',
} as const

export type TokenName = keyof typeof T

/** Spacing scale, in px. */
export const SP = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 22 } as const

/** Corner radii, in px. */
export const R = { sm: 6, md: 9, lg: 12, xl: 16, pill: 999 } as const

/** Type scale, in px. */
export const FONT = { xs: 11, sm: 12, md: 13, lg: 15, xl: 18 } as const

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

export const STYLE_ID = 'dsh-tool-hub-styles'

/** The stylesheet. Every colour here is a token lookup; hover and focus live in classes. */
const CSS = `
.th-root {
  display: flex;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  line-height: 1.5;
  background: var(--dsw-alias-bg-base, transparent);
}
/* palette:start — forced light/dark palettes; the only place literal colours are allowed. */
.th-root[data-th-theme='dark'] {
  color-scheme: dark;
  --dsw-alias-label-primary: rgb(242, 242, 247);
  --dsw-alias-label-secondary: rgba(235, 235, 245, 0.74);
  --dsw-alias-label-tertiary: rgba(235, 235, 245, 0.55);
  --dsw-alias-border-l1: rgba(255, 255, 255, 0.10);
  --dsw-alias-border-l2: rgba(255, 255, 255, 0.16);
  --dsw-alias-card-fill: rgba(255, 255, 255, 0.06);
  --dsw-alias-card-fill-hover: rgba(255, 255, 255, 0.10);
  --dsw-alias-bg-l2: rgba(255, 255, 255, 0.06);
  --dsw-alias-bg-base: rgb(22, 22, 24);
  --dsw-alias-bg-elevated: rgb(28, 28, 30);
}
.th-root[data-th-theme='light'] {
  color-scheme: light;
  --dsw-alias-label-primary: rgb(27, 27, 31);
  --dsw-alias-label-secondary: rgba(30, 30, 35, 0.72);
  --dsw-alias-label-tertiary: rgba(30, 30, 35, 0.54);
  --dsw-alias-border-l1: rgba(0, 0, 0, 0.10);
  --dsw-alias-border-l2: rgba(0, 0, 0, 0.16);
  --dsw-alias-card-fill: rgba(0, 0, 0, 0.045);
  --dsw-alias-card-fill-hover: rgba(0, 0, 0, 0.075);
  --dsw-alias-bg-l2: rgba(0, 0, 0, 0.05);
  --dsw-alias-bg-base: rgb(255, 255, 255);
  --dsw-alias-bg-elevated: rgb(255, 255, 255);
}
/* palette:end */
.th-root[data-th-density='compact'] { font-size: 12px; }
.th-root[data-th-density='compact'] .th-row { padding-top: 6px; padding-bottom: 6px; }
.th-root[data-th-density='compact'] .th-navitem { padding-top: 5px; padding-bottom: 5px; }
.th-root[data-th-density='compact'] .th-top { padding-top: 8px; padding-bottom: 8px; }
.th-side {
  flex: 0 0 208px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 10px;
  border-right: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
  overflow-y: auto;
}
.th-side-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 12px;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.01em;
}
.th-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1));
  flex: 0 0 auto;
}
.th-navitem {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.96));
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.th-navitem:hover { background: var(--dsw-alias-card-fill-hover, rgba(127, 127, 127, 0.12)); }
.th-navitem[aria-current='page'] {
  background: var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.07));
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 600;
}
.th-navitem:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1));
  outline-offset: 1px;
}
.th-navcount {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.78));
}
.th-main { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.th-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
  flex: 0 0 auto;
}
.th-top-title { font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.th-top-sub {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.78));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 42ch;
}
.th-top-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.th-content { flex: 1 1 auto; overflow-y: auto; padding: 16px 18px 28px; min-height: 0; }
.th-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.th-list { display: flex; flex-direction: column; gap: 8px; }
.th-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
  border-radius: 12px;
  background: var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.07));
  overflow: hidden;
}
.th-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 13px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
  background: transparent;
}
.th-row:first-child { border-top: 0; }
.th-row:hover { background: var(--dsw-alias-card-fill-hover, rgba(127, 127, 127, 0.12)); }
.th-row-body { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 3px; }
.th-row-name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.th-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.78));
}
.th-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.th-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.th-btn:hover:not(:disabled) { background: var(--dsw-alias-card-fill-hover, rgba(127, 127, 127, 0.12)); }
.th-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1));
  outline-offset: 1px;
}
.th-btn:disabled { opacity: 0.55; cursor: default; }
.th-btn--primary {
  background: var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1));
  border-color: transparent;
  color: var(--dsw-alias-label-on-color, rgba(255, 255, 255, 1));
}
.th-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, rgba(63, 95, 224, 1)); }
.th-btn--danger {
  border-color: transparent;
  color: var(--dsw-alias-state-error-primary, rgba(229, 72, 77, 1));
}
.th-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(229, 72, 77, 0.16)); }
.th-btn--ghost { border-color: transparent; color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.96)); }
.th-input {
  flex: 1 1 180px;
  min-width: 120px;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  border-radius: 9px;
  background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.06));
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
}
.th-input::placeholder { color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.78)); }
.th-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1));
  outline-offset: 0;
}
.th-switch {
  position: relative;
  flex: 0 0 auto;
  width: 38px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-switch-off, rgba(127, 127, 127, 0.36));
  cursor: pointer;
  transition: background 120ms ease;
}
.th-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1)); }
.th-switch:disabled { opacity: 0.55; cursor: default; }
.th-switch:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1));
  outline-offset: 2px;
}
.th-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--dsw-alias-switch-thumb, rgba(255, 255, 255, 1));
  transition: transform 140ms ease;
}
.th-switch[aria-checked='true'] .th-knob { transform: translateX(16px); }
.th-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.96));
  white-space: nowrap;
}
.th-badge--on {
  border-color: transparent;
  background: var(--dsw-alias-state-success-primary, rgba(18, 179, 168, 1));
  color: var(--dsw-alias-label-on-color, rgba(255, 255, 255, 1));
}
.th-badge--off { border-color: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24)); }
.th-badge--warn {
  border-color: transparent;
  background: var(--dsw-alias-state-warn-primary, rgba(224, 163, 58, 1));
  color: var(--dsw-alias-label-on-color, rgba(255, 255, 255, 1));
}
.th-badge--danger {
  border-color: transparent;
  background: var(--dsw-alias-state-error-primary, rgba(229, 72, 77, 1));
  color: var(--dsw-alias-label-on-color, rgba(255, 255, 255, 1));
}
.th-badge--brand {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1));
  color: var(--dsw-alias-label-on-color, rgba(255, 255, 255, 1));
}
.th-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 40px 16px;
  text-align: center;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  border-radius: 12px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.78));
}
.th-empty-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.96)); }
.th-skel {
  height: 14px;
  border-radius: 6px;
  background: var(--dsw-alias-card-fill-hover, rgba(127, 127, 127, 0.12));
  animation: th-pulse 1.4s ease-in-out infinite;
}
.th-skel--sm { width: 40%; }
@keyframes th-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.th-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-overlay, rgba(0, 0, 0, 0.42));
}
.th-dialog {
  width: min(460px, 100%);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  border-radius: 14px;
  background: var(--dsw-alias-bg-elevated, rgb(255, 255, 255));
  color: var(--dsw-alias-label-primary, rgb(27, 27, 31));
  box-shadow: 0 18px 44px var(--dsw-alias-shadow-popover, rgba(0, 0, 0, 0.28));
  padding: 16px 18px;
}
.th-dialog:focus { outline: none; }
@media (prefers-color-scheme: dark) {
  /* A shell without the elevated token still gets readable text in either theme. */
  .th-dialog { background: var(--dsw-alias-bg-elevated, rgb(28, 28, 30)); color: var(--dsw-alias-label-primary, rgb(242, 242, 247)); }
}
.th-dialog-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.th-dialog-body { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.96)); }
.th-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.th-field { display: flex; flex-direction: column; gap: 4px; }
.th-field-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.96)); }
.th-field-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.78)); }
.th-field-error { font-size: 11px; color: var(--dsw-alias-state-error-primary, rgba(229, 72, 77, 1)); }
.th-select {
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  border-radius: 9px;
  background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.06));
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
}
.th-select:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1));
  outline-offset: 0;
}
.th-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-state-error-primary, rgba(229, 72, 77, 1));
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(229, 72, 77, 0.16));
  font-size: 12px;
}
.th-section { margin-bottom: 18px; }
.th-section-title { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.78)); margin-bottom: 8px; }
.th-spin {
  width: 12px;
  height: 12px;
  border-radius: 999px;
  border: 2px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  border-top-color: var(--dsw-alias-brand-primary, rgba(76, 111, 255, 1));
  animation: th-spin 700ms linear infinite;
}
@keyframes th-spin { to { transform: rotate(360deg); } }
.th-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
`

/** Inject the stylesheet once; safe to call from every mounted slot. */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}
