/**
 * Client entry: the loader contract, and the three slots this panel fills.
 *
 * The bundle is wrapped by scripts/build-client.mjs in a __ModuleLoader__.load() call; this
 * module's only job is the NS/inject/apply triple the host expects and one registration per
 * surface, all sharing the same id so the host sees a single panel.
 */
import * as React from 'react'
import { Shell } from './shell.js'
import type { ShellSurface } from './shell.js'
import { catalogs, createT, detectLang, type TFunction } from './i18n.js'

export const NS = 'tool-hub'

/** Host services this panel uses: slot registration and locale catalogues. */
export const inject = ['slots', 'locale', 'layout'] as const

interface SlotContext {
  slots: {
    inject(name: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: () => unknown): unknown
  }
  locale?: {
    register?(ns: string, catalog: unknown): void
    bind?(ns: string): TFunction
  }
}

interface SurfaceSpec {
  slot: string
  surface: ShellSurface
  order: number
  /** Keyed slots (`main`) demand a key; the shared NS keeps one panel behind all three. */
  key?: string
}

/** The sidebar list is a row, not a panel: an 18px glyph the shell labels. */
function PanelEntry(): React.ReactElement {
  return React.createElement('svg', {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
  React.createElement('circle', { cx: 12, cy: 11, r: 3.1, fill: 'currentColor', stroke: 'none' }),
  React.createElement('circle', { cx: 4.6, cy: 6.4, r: 1.9, fill: 'currentColor', stroke: 'none' }),
  React.createElement('circle', { cx: 19.4, cy: 6.4, r: 1.9, fill: 'currentColor', stroke: 'none' }),
  React.createElement('circle', { cx: 12, cy: 20, r: 1.9, fill: 'currentColor', stroke: 'none' }),
  React.createElement('path', { d: 'M12 11 5.6 7.4M12 11l6.4-3.6M12 11v6.2' }))
}

/** One panel, three surfaces: the plugins tab, the sidebar list, and the main area. */
const SURFACES: SurfaceSpec[] = [
  { slot: 'plugins.tab', surface: 'tab', order: 100 },
  { slot: 'sidebar.panellist', surface: 'panel', order: 100 },
  { slot: 'main', surface: 'main', order: 100, key: NS },
]

export function apply(ctx: SlotContext): void {
  // The shell publishes its layout service; reading it lazily keeps the panel loadable when an
  // older host omits it (the button then does nothing rather than breaking the page).
  const backToSession = (): void => {
    try {
      const get = (ctx as unknown as { get?: (name: string) => unknown }).get
      const layout = typeof get === 'function' ? get.call(ctx, 'layout') as { selectPanel?: (key: string | null) => void } | undefined : undefined
      if (typeof layout?.selectPanel === 'function') layout.selectPanel(null)
    }
    catch {
      /* no layout service: the panel stays put */
    }
  }
  // Register the dictionaries first: the tab and sidebar labels are translated by the shell.
  try {
    ctx.locale?.register?.(NS, catalogs)
  }
  catch {
    /* an older shell without locale still gets the fallback labels below */
  }
  const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : createT(detectLang())
  for (const spec of SURFACES) {
    // The sidebar slot is one list row; only the tab and main area host the full panel.
    const component = (): unknown => spec.surface === 'panel'
      ? React.createElement(PanelEntry)
      : React.createElement(Shell, { surface: spec.surface, onBack: backToSession })
    ctx.slots.inject(spec.slot, () =>
      ctx.slots.register(
        { name: spec.slot, id: NS, order: spec.order, ...(spec.key === undefined ? {} : { key: spec.key }), label: () => t('app.title'), locale: NS },
        component,
      ),
    )
  }
}
