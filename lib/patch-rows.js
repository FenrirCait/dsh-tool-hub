/**
 * Line-level editor for a profile `cordis.patch.yml`.
 *
 * A loader patch file is a YAML sequence of entries. One entry is a `- id:`
 * line plus every line indented under it, and it can sit at the top level or
 * inside an `- insert:` list; this module finds all of them the same way.
 *
 * The point of editing by lines instead of by re-serializing a YAML document is
 * that an edit must not disturb anything it did not mean to touch: comments
 * between rows, quoting styles, `!!js` expressions, blank lines and the file's
 * own line endings all survive. Only the `disabled:` value of one row is
 * rewritten, and when a row has no `disabled:` key one line is inserted at the
 * row's own indentation — the column of `id:`.
 *
 * Row shape (line numbers are 0-based, ranges half open):
 *   { startLine, endLine, indent, id, name, disabled, configStart, configEnd }
 *
 * - `indent` is the number of columns after `- `, i.e. the column where the
 *   row's keys (`id:`, `name:`, `disabled:`, `config:`) start. It is measured
 *   per row, so a file that mixes 2-space and 4-space lists still parses.
 * - `configStart` is the first line after `config:` (equal to `configEnd` when
 *   the value is inline such as `{}`), and `configEnd` is the line after the
 *   last line that belongs to the config sub-tree. Both are -1 when the row has
 *   no `config:` key at all.
 */

/** A row head: leading run of blanks, a dash, blanks, then the `id` key. */
const ROW_HEAD = /^([ \t]*)-([ \t]+)id[ \t]*:[ \t]*(.*)$/
/** The only parent a row can have: an `insert:` list entry. */
const INSERT_HEAD = /^[ \t]*-[ \t]*insert[ \t]*:[ \t]*(?:#.*)?$/
/** A `config: |` / `notes: >-` opener: the lines under it are text, not YAML keys. */
const BLOCK_SCALAR = /^[|>][+-]?[0-9]*$/

function leadOf(line) {
  return line.length - line.trimStart().length
}

/**
 * Split text into lines that remember their own terminator, so rebuilding the
 * string yields the exact same bytes including a missing final newline.
 * @returns {{ text: string, eol: string }[]}
 */
function lineRecords(text) {
  const records = []
  let index = 0
  while (index < text.length) {
    let end = index
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1
    let eol = ''
    if (end < text.length) {
      if (text[end] === '\r' && text[end + 1] === '\n') {
        eol = '\r\n'
        end += 2
      }
      else {
        eol = text[end]
        end += 1
      }
    }
    records.push({ text: text.slice(index, end - eol.length), eol })
    index = end
  }
  return records
}

function joinRecords(records) {
  return records.map(record => record.text + record.eol).join('')
}

function dominantEol(records) {
  let crlf = 0
  let lf = 0
  for (const record of records) {
    if (record.eol === '\r\n') crlf += 1
    else if (record.eol === '\n') lf += 1
  }
  return crlf > lf ? '\r\n' : '\n'
}

/**
 * Split one scalar into value and trailing `# comment`, ignoring a `#` that is
 * inside quotes. The returned `value` keeps the spaces that precede the comment
 * so a rewrite can put them back.
 */
function splitComment(value) {
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote !== '') {
      if (char === quote) {
        if (quote === "'" && value[index + 1] === "'") {
          index += 1
          continue
        }
        quote = ''
      }
      else if (quote === '"' && char === '\\') {
        index += 1
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || value[index - 1] === ' ' || value[index - 1] === '\t')) {
      return { value: value.slice(0, index), comment: value.slice(index) }
    }
  }
  return { value, comment: '' }
}

function unquote(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** The scalar text of a raw value, without quotes or a trailing comment. */
function scalarOf(raw) {
  return unquote(splitComment(String(raw ?? '')).value.trim())
}

/** `disabled: true` in the spellings a hand-written patch may use. */
function isTrue(raw) {
  const value = scalarOf(raw).toLowerCase()
  return value === 'true' || value === 'yes' || value === 'on'
}

/** `key: rest` of one line, or null for a comment / list item / non-key line. */
function keyOf(line) {
  const body = line.trimStart()
  if (body === '' || body.startsWith('#') || body.startsWith('-')) return null
  const match = /^([^:#]+?)[ \t]*:[ \t]*(.*)$/.exec(body)
  if (match === null) return null
  const key = match[1].trim()
  if (key === '') return null
  return { key, rest: match[2] }
}

/**
 * End of one row: the first non-blank line indented no deeper than the row's own dash.
 *
 * The dash's leading spaces — not the `id:` column — decide where a row stops. A patch may mix
 * `- id:` rows with `-   id:` rows, and a row's keys need not sit at its `id:` column; measuring
 * the span from `indent` then ends a row inside its own body (the `id:` column of one row is the
 * dash column of no other row). A sibling list item sits at exactly the same dash column, so the
 * same rule covers it, and it matches how `lib/mcp.js` sees a row. Trailing blank lines are left
 * out of the span so removing a row does not swallow the separator after it.
 */
function rowEnd(lines, start, dashLead) {
  let end = start + 1
  for (let cursor = start + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (line.trim() === '') continue
    if (leadOf(line) <= dashLead) return end
    end = cursor + 1
  }
  return end
}

/** The line holding `key` at the row's own key column, or -1. */
function keyLine(records, row, key) {
  for (let index = row.startLine + 1; index < row.endLine; index += 1) {
    const line = records[index].text
    if (line.trim() === '') continue
    if (leadOf(line) !== row.indent) continue
    const info = keyOf(line)
    if (info !== null && info.key === key) return index
  }
  return -1
}

/**
 * The nearest line above `start` that is indented less than `lead`, skipping
 * blank lines and comments (YAML ignores both, so neither can be a parent).
 */
function enclosingLine(lines, start, lead) {
  for (let cursor = start - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor]
    const body = line.trim()
    if (body === '' || body.startsWith('#')) continue
    if (leadOf(line) < lead) return line
  }
  return null
}

/**
 * Every `- id:` row in a patch file, in file order.
 * @param {string} text
 * @returns {{ startLine: number, endLine: number, indent: number, id: string, name: string|null, disabled: boolean, configStart: number, configEnd: number }[]}
 */
export function parseRows(text) {
  const lines = lineRecords(String(text ?? '')).map(record => record.text)
  const rows = []
  let scalarIndent = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const lead = leadOf(line)
    // Inside a block scalar every line is text; only a dedent ends it.
    if (scalarIndent >= 0) {
      if (lead > scalarIndent) continue
      scalarIndent = -1
    }
    const head = ROW_HEAD.exec(line)
    if (head === null) {
      const info = keyOf(line)
      if (info !== null && BLOCK_SCALAR.test(splitComment(info.rest).value.trim())) scalarIndent = lead
      continue
    }
    const id = scalarOf(head[3])
    if (id === '') continue
    // A patch's rows live at the top level or directly inside an `insert:` list.
    // An `id:` key that sits deeper — a mapping inside some plugin's config —
    // is configuration, not a row.
    const parent = enclosingLine(lines, index, head[1].length)
    if (parent !== null && !INSERT_HEAD.test(parent)) continue
    const indent = head[1].length + 1 + head[2].length
    // The row's extent is measured from the dash's own column (`head[1]`), never from `indent`:
    // the id column only locates this row's keys, it is not the level its siblings sit on.
    const end = rowEnd(lines, index, head[1].length)
    const row = {
      startLine: index,
      endLine: end,
      indent,
      id,
      name: null,
      disabled: false,
      configStart: -1,
      configEnd: -1,
    }
    let configLine = -1
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const candidate = lines[cursor]
      if (candidate.trim() === '') continue
      if (leadOf(candidate) !== indent) continue
      const info = keyOf(candidate)
      if (info === null) continue
      if (info.key === 'name') row.name = scalarOf(info.rest)
      else if (info.key === 'disabled') row.disabled = isTrue(info.rest)
      else if (info.key === 'config') configLine = cursor
    }
    if (configLine >= 0) {
      const afterColon = splitComment(lines[configLine].slice(lines[configLine].indexOf(':') + 1)).value.trim()
      row.configStart = configLine + 1
      let configEnd = configLine + 1
      // `config:` with nothing, or with a block scalar opener, owns the lines below
      // it; an inline value such as `{}` owns nothing.
      if (afterColon === '' || BLOCK_SCALAR.test(afterColon)) {
        for (let cursor = configLine + 1; cursor < end; cursor += 1) {
          const candidate = lines[cursor]
          if (candidate.trim() === '') continue
          if (leadOf(candidate) <= indent) break
          configEnd = cursor + 1
        }
      }
      row.configEnd = configEnd
    }
    rows.push(row)
  }
  return rows
}

function pickRow(rows, id) {
  const wanted = String(id ?? '').trim()
  const matches = rows.filter(row => row.id === wanted)
  if (matches.length === 0) {
    const error = new Error(`no patch row with id "${wanted}"`)
    error.code = 'row-not-found'
    throw error
  }
  if (matches.length > 1) {
    // Editing "the last one" silently changes a row the caller never saw; refuse and name the lines.
    const error = new Error(`patch row id "${wanted}" appears ${matches.length} times (lines ${matches.map(row => row.startLine + 1).join(', ')}); edit the file by hand`)
    error.code = 'duplicate-row'
    throw error
  }
  return matches[0]
}

/** Rewrite the boolean on a `disabled:` line, keeping its comment and spacing. */
function rewriteDisabled(line, value) {
  const body = line.trimStart()
  const lead = line.length - body.length
  const match = /^(disabled[ \t]*:[ \t]*)([\s\S]*)$/.exec(body)
  if (match === null) return null
  const split = splitComment(match[2])
  const current = split.value.trim()
  // !!js expressions (and template values) are evaluated by the loader: replacing them with a
  // literal would destroy the user's expression, so refuse instead of guessing.
  if (/^!!js\b/.test(current) || current.includes('{{')) {
    const error = new Error('disabled is controlled by an expression (' + current.slice(0, 40) + '); edit the patch file by hand')
    error.code = 'js-expression'
    throw error
  }
  const trailing = /[ \t]*$/.exec(split.value)[0]
  return `${line.slice(0, lead)}${match[1]}${value}${trailing}${split.comment}`
}

/**
 * Set one row's `disabled` flag, leaving every other byte alone.
 *
 * When the row already has a `disabled:` key only that value (and its own line
 * ending) is touched; quotes, a trailing comment and the surrounding spacing
 * stay. When it has none and the requested value is `true`, one line is added
 * after the row's `config:` block at the row's own key indentation — the style
 * the loader itself writes. Asking for `false` on a row with no key is already
 * what the file means, so no byte is written.
 *
 * @param {string} text
 * @param {string} id
 * @param {boolean} disabled
 * @returns {string}
 */
export function setRowDisabled(text, id, disabled) {
  const source = String(text ?? '')
  const row = pickRow(parseRows(source), id)
  const want = disabled === true
  const records = lineRecords(source)
  const existing = keyLine(records, row, 'disabled')
  if (existing >= 0) {
    if (row.disabled === want) return source
    const next = rewriteDisabled(records[existing].text, want ? 'true' : 'false')
    if (next === null || next === records[existing].text) return source
    records[existing] = { text: next, eol: records[existing].eol }
    return joinRecords(records)
  }
  if (!want) return source
  const at = row.configEnd >= 0 ? row.configEnd : row.endLine
  const index = Math.max(0, Math.min(at, records.length))
  const eol = index > 0 && records[index - 1].eol !== '' ? records[index - 1].eol : dominantEol(records)
  const copy = records.map(record => ({ text: record.text, eol: record.eol }))
  if (index > 0 && copy[index - 1].eol === '') {
    // The file did not end with a newline: give the previous last line one and
    // keep the new line as the (unterminated) last line.
    copy[index - 1].eol = eol
    copy.splice(index, 0, { text: `${' '.repeat(row.indent)}disabled: true`, eol: '' })
    return joinRecords(copy)
  }
  copy.splice(index, 0, { text: `${' '.repeat(row.indent)}disabled: true`, eol })
  return joinRecords(copy)
}

/**
 * Delete one row and every line it owns, leaving the rest of the file as it was.
 * @param {string} text
 * @param {string} id
 * @returns {string}
 */
export function removeRow(text, id) {
  const source = String(text ?? '')
  const row = pickRow(parseRows(source), id)
  const records = lineRecords(source)
  return joinRecords([...records.slice(0, row.startLine), ...records.slice(row.endLine)])
}
