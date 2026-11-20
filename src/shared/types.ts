/** Shared vocabulary for the host and client halves. No runtime imports here. */

export type Surface = 'host' | 'client'

/** One host member the plugin calls, with the consequence of it being absent. */
export interface CapabilitySpec {
  id: string
  service: string
  member?: string
  surface?: Surface
  required: boolean
  fallback: string
  usedFor: string
}

/** One dispatch op: what it does to the world, and whether it needs confirmation. */
export interface OpDefinition {
  id: string
  write: boolean
  audit: boolean
  confirm?: true | 'reset' | null
  note: string
}

export interface LocalizedText { zh: string; en: string }

export interface SettingsField {
  key: string
  type: 'boolean' | 'number' | 'string' | 'select'
  default: unknown
  label: LocalizedText
  hint?: LocalizedText
  options?: Array<{ value: string; label: LocalizedText }>
  min?: number
  max?: number
}

export interface PanelContribution {
  slot: 'plugins.tab' | 'sidebar.panellist' | 'main' | 'settings.section'
  id: string
  order?: number
}

/** A feature area: owns its ops, settings and panels. Third-party modules use the same shape. */
export interface DomainModule {
  id: string
  title: LocalizedText
  ops: OpDefinition[]
  panels?: PanelContribution[]
  settings?: SettingsField[]
}

/** The narrow slice of a cordis context the host half relies on. */
export interface HubContext {
  get(name: string): unknown
  effect?(fn: () => (() => void) | void): void
  logger?: { info?(message: string): void; warn(message: string): void }
}
