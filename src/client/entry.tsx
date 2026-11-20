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

export const NS = 'tool-hub'

/** Host services this panel uses: slot registration and locale catalogues. */
export function inject(): string[] {
  return ['slots', 'locale']
}

interface SlotContext {
  slots: {
    inject(name: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: () => unknown): unknown
  }
}

interface SurfaceSpec {
  slot: string
  surface: ShellSurface
  order: number
}

/** One panel, three surfaces: the plugins tab, the sidebar list, and the main area. */
const SURFACES: SurfaceSpec[] = [
  { slot: 'plugins.tab', surface: 'tab', order: 100 },
  { slot: 'sidebar.panellist', surface: 'panel', order: 100 },
  { slot: 'main', surface: 'main', order: 100 },
]

export function apply(ctx: SlotContext): void {
  for (const spec of SURFACES) {
    const component = (): unknown => React.createElement(Shell, { surface: spec.surface })
    ctx.slots.inject(spec.slot, () =>
      ctx.slots.register(
        { name: spec.slot, id: NS, order: spec.order, label: () => 'Tool Hub', locale: NS },
        component,
      ),
    )
  }
}
