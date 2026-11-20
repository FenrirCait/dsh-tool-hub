import type { DomainModule, OpDefinition } from '../shared/types.js'

/**
 * One registry, two consumers: the host dispatches ops through it and the client renders its
 * panels/settings from it. Keeping a single table is what stops "host knows an op the UI does
 * not" from being a silent failure.
 */
export class Registry {
  private readonly modules = new Map<string, DomainModule>()

  register(module: DomainModule): void {
    if (this.modules.has(module.id)) throw new Error(`duplicate module id: ${module.id}`)
    const seen = new Set(this.ops().map(op => op.id))
    for (const op of module.ops) {
      if (seen.has(op.id)) throw new Error(`duplicate op id: ${op.id}`)
      seen.add(op.id)
    }
    this.modules.set(module.id, module)
  }

  /** Drop one module. Only the hot-rebuild path uses it, after a failed bind. */
  remove(id: string): boolean {
    return this.modules.delete(id)
  }

  opIds(): string[] {
    return this.ops().map(op => op.id)
  }

  list(): DomainModule[] {
    return [...this.modules.values()].sort((left, right) => left.id.localeCompare(right.id))
  }

  ops(): OpDefinition[] {
    return this.list().flatMap(module => module.ops)
  }

  findOp(id: string): OpDefinition | undefined {
    return this.ops().find(op => op.id === id)
  }

  settings(): Array<{ module: string; fields: NonNullable<DomainModule['settings']> }> {
    return this.list()
      .filter(module => (module.settings ?? []).length > 0)
      .map(module => ({ module: module.id, fields: module.settings ?? [] }))
  }
}
