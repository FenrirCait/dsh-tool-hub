/**
 * The tool-name universe: one predicate every layer shares.
 *
 * A model-callable tool name is any non-empty, trimmed string of at most 200 characters. Four
 * names are reserved: `run_code` is the PTC transport (the host refuses to restrict it and a
 * restriction that names it fails as a whole), and `tool_switch`, `tool_list` and `hub_tools`
 * are this panel's own doors into a masked surface. Every layer therefore filters through
 * {@link maskable} instead of trusting what state.json, a panel payload or a group record holds.
 *
 * Pure and dependency-free so the domains, the host mask and the probes can all import it.
 */

/** Longest name any layer accepts; the host tool schema owns the real shape. */
export const MAX_TOOL_NAME = 200

/** One trimmed tool name, or null when the value cannot be one. */
export function toolName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name === '' || name.length > MAX_TOOL_NAME ? null : name
}

/** Trimmed, deduplicated names in first-seen order; reserved names stay in (see maskable). */
export function toolNames(value: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(value) ? value : []) {
    const name = toolName(entry)
    if (name === null || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * Names no mask may ever contain. `run_code` is refused by the host; the other three are the
 * panel's own tools, and hiding one would remove the model's only way back.
 */
export const RESERVED_TOOLS: ReadonlySet<string> = new Set(['run_code', 'tool_switch', 'tool_list', 'hub_tools'])

/** Names a mask may hide: trimmed, deduplicated, reserved names dropped. */
export function maskable(names: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of names) {
    const name = toolName(entry)
    if (name === null || RESERVED_TOOLS.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** Reserved names found in the given lists, first-seen order and deduplicated (reports). */
export function reservedAmong(lists: Iterable<readonly string[]>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const entry of list) {
      const name = toolName(entry)
      if (name === null || !RESERVED_TOOLS.has(name) || seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}
