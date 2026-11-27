import type { HubContext } from '../shared/types.js'

/** Narrow, optional capability for a provider that owns an external skill visibility layer. */
export const SKILL_VISIBILITY_SERVICE = 'toolHub.skillVisibility'
const PROVIDER_TIMEOUT_MS = 3000

export interface SkillVisibilityRow {
  name: string
  hidden: boolean
  modelInvocable: boolean
  source?: string
  provider?: string
}

export interface SkillVisibilityProvider {
  id: string
  list(): Promise<readonly SkillVisibilityRow[]> | readonly SkillVisibilityRow[]
}

export interface SkillVisibilitySnapshot {
  provider: string | null
  available: boolean
  canSet: boolean
  rows: SkillVisibilityRow[]
  error: string | null
}

/**
 * One provider per host. A missing provider is the normal no-Deep-PTC state; a provider that
 * throws is reported as unavailable instead of failing the whole snapshot.
 */
export class SkillVisibilityRegistry {
  private current: SkillVisibilityProvider | null = null

  register(provider: SkillVisibilityProvider): () => void {
    if (provider === null || typeof provider !== 'object' || typeof provider.id !== 'string' || provider.id.trim() === '') {
      throw new Error('skill visibility provider needs a non-empty id')
    }
    if (typeof provider.list !== 'function') throw new Error('skill visibility provider needs list()')
    if (this.current !== null && this.current !== provider) throw new Error('a skill visibility provider is already registered')
    this.current = provider
    return () => {
      if (this.current === provider) this.current = null
    }
  }

  async snapshot(): Promise<SkillVisibilitySnapshot> {
    const provider = this.current
    if (provider === null) return { provider: null, available: false, canSet: false, rows: [], error: null }
    try {
      const rows = await withTimeout(Promise.resolve().then(() => provider.list()), PROVIDER_TIMEOUT_MS)
      if (!Array.isArray(rows)) throw new Error('provider list() did not return an array')
      return {
        provider: provider.id,
        available: true,
        canSet: false,
        rows: rows.filter(row => row !== null && typeof row === 'object' && typeof row.name === 'string' && row.name !== '')
          .map(row => ({
            name: row.name,
            hidden: row.hidden === true,
            modelInvocable: row.modelInvocable !== false,
            ...(typeof row.source === 'string' && row.source !== '' ? { source: row.source } : {}),
            ...(typeof row.provider === 'string' && row.provider !== '' ? { provider: row.provider } : {}),
          })),
        error: null,
      }
    }
    catch (error) {
      return { provider: provider.id, available: false, canSet: false, rows: [], error: error instanceof Error ? error.message : String(error) }
    }
  }
}


export function skillVisibilityRegistry(ctx: HubContext): SkillVisibilityRegistry | null {
  const service = ctx.get(SKILL_VISIBILITY_SERVICE)
  return service !== null && typeof service === 'object' && service instanceof SkillVisibilityRegistry ? service : null
}
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('provider timed out after ' + String(ms) + 'ms')), ms)
    task.then(value => { if (timer !== undefined) clearTimeout(timer); resolve(value) }, error => { if (timer !== undefined) clearTimeout(timer); reject(error) })
  })
}