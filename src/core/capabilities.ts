import type { CapabilitySpec, Surface } from '../shared/types.js'

/**
 * Shape-probe one capability: a member is present when it is a function. Nothing is called —
 * calling a member to "verify" it is itself the failure mode this table exists to catch.
 */
export function probeCapability(services: Record<string, unknown> | undefined, spec: CapabilitySpec): boolean {
  const service = services?.[spec.service] as Record<string, unknown> | undefined
  if (spec.member === undefined) return service !== undefined && service !== null
  return typeof service?.[spec.member] === 'function'
}

export interface CapabilityReport {
  surface: Surface
  ok: boolean
  missing: CapabilitySpec[]
  present: number
  total: number
  degraded: boolean
}

export function reportCapabilities(services: Record<string, unknown> | undefined, specs: CapabilitySpec[], surface: Surface = 'host'): CapabilityReport {
  const rows = specs.filter(spec => (spec.surface ?? 'host') === surface)
  const missing = rows.filter(spec => !probeCapability(services, spec))
  const hard = missing.filter(spec => spec.required).length
  return { surface, ok: hard === 0, missing, present: rows.length - missing.length, total: rows.length, degraded: missing.length > hard }
}
