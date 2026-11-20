import type { DomainModule } from './types.js'
import type { StateV2 } from '../core/state.js'

/** What a domain may reach: the loaded state, the host services, and the one save path. */
export interface HostEnv {
  state: StateV2
  services: { get(name: string): unknown }
  /** Persist through core/io: backup, lock, atomic write. Never write the file directly. */
  save(reason: string): Promise<string | null>
  log(level: 'info' | 'warn', message: string): void
  now(): number
}

export type OpHandler = (payload: unknown, env: HostEnv) => Promise<unknown>

/** A domain hands back its declarative module plus one handler per declared op. */
export interface DomainRegistration {
  module: DomainModule
  handlers: Record<string, OpHandler>
}
