/**
 * Managed blocks in a profile cordis.patch.yml.
 *
 * Other panels own regions of the same file between comment markers, e.g.
 *   # >>> dsh-skill-mcp-panel:mcp:begin
 *   - id: panel-mcp-foo
 *   # <<< dsh-skill-mcp-panel:mcp:end
 * Rewriting a whole block once rolled another panel's rows back (dsh-skill-mcp-panel #46), so this
 * plugin never rebuilds a block: it edits the disabled: field of one target row at a time and puts
 * new rows outside every block. This module only reads the layout and answers two questions:
 * which rows sit inside a block, and which of those the block's owner does not own.
 */
import { parseRows } from '../../lib/patch-rows.js'

/** Row-id prefixes each known block owner writes; a row without one is foreign to that block. */
export const BLOCK_OWNER_PREFIX: Readonly<Record<string, string>> = {
  'dsh-skill-mcp-panel:mcp': 'panel-mcp-',
}

const BEGIN = /^[ \t]*#[ \t]*>>>(.*?):begin[ \t]*$/
const END = /^[ \t]*#[ \t]*<<<(.*?):end[ \t]*$/

export interface PatchBlock {
  /** The owner tag between the markers, e.g. "dsh-skill-mcp-panel:mcp". */
  name: string
  beginLine: number
  endLine: number
  /** Row ids inside the block, in file order. */
  rows: string[]
  /** Ids the owner prefix says do not belong to the block's panel; left untouched. */
  foreign: string[]
  /** False when this module does not know the owner's prefix (all rows are listed, none called foreign). */
  known: boolean
}

export interface PatchScan {
  rows: number
  blocks: PatchBlock[]
  /** Blocks whose begin marker has no end marker; writes must stay out of them. */
  unclosed: string[]
  foreignTotal: number
}

/** Read the managed-block layout of one patch document. Never throws on odd input. */
export function scanPatchBlocks(text: string, owners: Readonly<Record<string, string>> = BLOCK_OWNER_PREFIX): PatchScan {
  const lines = text.split('\n')
  const blocks: PatchBlock[] = []
  const unclosed: string[] = []
  const open = new Map<string, number>()
  for (let index = 0; index < lines.length; index += 1) {
    const begin = BEGIN.exec(lines[index] ?? '')
    if (begin !== null) {
      const name = (begin[1] ?? '').trim()
      if (name !== '') open.set(name, index)
      continue
    }
    const end = END.exec(lines[index] ?? '')
    if (end === null) continue
    const name = (end[1] ?? '').trim()
    const beginLine = open.get(name)
    if (beginLine === undefined) continue
    open.delete(name)
    blocks.push({ name, beginLine, endLine: index, rows: [], foreign: [], known: owners[name] !== undefined })
  }
  for (const name of open.keys()) unclosed.push(name)

  let rows = 0
  try {
    for (const row of parseRows(text)) {
      rows += 1
      for (const block of blocks) {
        if (row.startLine > block.beginLine && row.endLine <= block.endLine) {
          block.rows.push(row.id)
          const prefix = owners[block.name]
          if (prefix !== undefined && !row.id.startsWith(prefix)) block.foreign.push(row.id)
        }
      }
    }
  }
  catch {
    // A row the 1.x parser cannot read is left out of the layout, not treated as absent.
  }
  const foreignTotal = blocks.reduce((sum, block) => sum + block.foreign.length, 0)
  return { rows, blocks, unclosed, foreignTotal }
}

/**
 * Append one row without entering any managed block: before the first begin marker when the file
 * has one, at the end otherwise. The row text is inserted verbatim.
 */
export function insertOutsideBlocks(text: string, row: string): string {
  const lines = text.split('\n')
  const firstBegin = lines.findIndex(line => BEGIN.test(line))
  const rowLines = row.replace(/\n+$/, '').split('\n')
  if (firstBegin >= 0) {
    const before = lines.slice(0, firstBegin)
    while (before.length > 0 && (before[before.length - 1] ?? '').trim() === '') before.pop()
    return [...before, ...rowLines, '', ...lines.slice(firstBegin)].join('\n')
  }
  const trimmed = text.replace(/\n+$/, '')
  return (trimmed === '' ? '' : trimmed + '\n') + rowLines.join('\n') + '\n'
}
