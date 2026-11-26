/**
 * Canonical MCP row identity. A patch id is not unique on its own: a hand-written patch may carry
 * the same id several times, and every row operation addresses one file-order occurrence.
 *
 * The JSON tuple is deliberately collision-free for ids containing ':', '|', '#', NUL, or any other
 * separator a caller might have invented. Server and client use this one function.
 */
export function mcpRowKey(id: string, occurrence: number): string {
  return JSON.stringify([id, occurrence])
}

export function parseMcpRowKey(value: string): { id: string; occurrence: number } | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return null
    const occurrence = Number(parsed[1])
    if (!Number.isInteger(occurrence) || occurrence < 0) return null
    return { id: parsed[0], occurrence }
  }
  catch {
    return null
  }
}
