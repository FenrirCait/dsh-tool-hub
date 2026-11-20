import * as React from 'react'

export const NS = 'tool-hub'

export function inject(): string[] {
  return ['slots', 'locale']
}

interface SlotContext {
  slots: {
    inject(name: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: () => unknown): unknown
  }
}

/** Skeleton panel: proves the single-file bundle still meets the loader contract. */
export function apply(ctx: SlotContext): void {
  const Panel = () => React.createElement('div', { style: { padding: 16, fontSize: 13 } }, 'dsh-tool-hub 2.0 (skeleton)')
  ctx.slots.inject('plugins.tab', () => ctx.slots.register({ name: 'plugins.tab', id: 'tool-hub', order: 100, label: () => 'Tool Hub', locale: NS }, Panel))
}
