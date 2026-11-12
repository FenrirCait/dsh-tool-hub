// Agent preset declarations, edited in place.
//
// A preset is one loader row in the profile patch:
//
//   - insert:
//       - id: preset-<id>
//         name: '@deepseek-ai/dsh-agent-preset'
//         config:
//           id: <id>
//           order: <n>
//           plugins: []
//
// There is no directory to scan: `$DSH_HOME/.agent-presets/<id>/` stopped being read
// ("Nothing reads that directory any more"). Everything here therefore works on the patch text
// itself and touches nothing else, so the rest of the file stays byte-for-byte identical.

export const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
export const PRESET_ROW_PREFIX = 'preset-'

/** Preset ids end up in a YAML key and in every row id, so keep them boring. */
export const PRESET_ID_RULE = /^[a-z0-9][a-z0-9_-]{0,31}$/

function leadOf(line) {
    const match = /^[ ]*/.exec(line)
    return match === null ? 0 : match[0].length
}

function unquote(value) {
    const trimmed = value.trim()
    if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed[trimmed.length - 1] === trimmed[0]) {
        return trimmed.slice(1, -1).replace(/''/g, "'")
    }
    return trimmed
}

function scalarOf(line) {
    const colon = line.indexOf(':')
    if (colon < 0) return undefined
    return unquote(line.slice(colon + 1))
}

/** Every declaration row in one patch text, with the byte range it owns. */
export function parsePresetRows(text) {
    const lines = text.split('\n')
    const rows = []
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const opened = /^([ ]*)- id:[ ]*(.+)$/.exec(line)
        if (opened === null) continue
        const indent = opened[1].length
        const rowId = unquote(opened[2])
        // A row ends where the next sibling row starts: same indent, another "- ".
        let end = index + 1
        while (end < lines.length) {
            const next = lines[end]
            if (/^[ ]*- /.test(next) && leadOf(next) === indent) break
            if (next.trim() !== '' && leadOf(next) < indent) break
            end += 1
        }
        const block = lines.slice(index, end)
        let name = ''
        let configStart = -1
        let configIndent = 0
        for (let offset = 1; offset < block.length; offset += 1) {
            const current = block[offset]
            if (/^[ ]*name:/.test(current) && name === '') name = scalarOf(current) ?? ''
            if (/^[ ]*config:[ ]*$/.test(current)) {
                configStart = index + offset
                configIndent = leadOf(current)
                break
            }
        }
        if (name !== PRESET_MODULE) continue
        const config = {}
        let plugins = 0
        let pluginsInline = false
        let pluginsStart = -1
        let pluginsEnd = -1
        const items = []
        if (configStart >= 0) {
            let cursor = configStart + 1
            let inPlugins = false
            while (cursor < end) {
                const current = lines[cursor]
                const indentHere = leadOf(current)
                if (current.trim() !== '' && indentHere <= configIndent) break
                if (/^[ ]*plugins:[ ]*\[[ ]*\][ ]*$/.test(current)) {
                    inPlugins = false
                    pluginsInline = true
                    pluginsStart = cursor
                    pluginsEnd = cursor + 1
                } else if (/^[ ]*plugins:[ ]*$/.test(current)) {
                    inPlugins = true
                    pluginsStart = cursor
                } else if (inPlugins) {
                    const started = /^[ ]*- id:[ ]*(.+)$/.exec(current)
                    if (started !== null) {
                        plugins += 1
                        items.push({ startLine: cursor, endLine: cursor + 1, indent: indentHere, id: unquote(started[1]) })
                    }
                    const item = items[items.length - 1]
                    if (item !== undefined) {
                        item.endLine = cursor + 1
                        if (started === null && indentHere === item.indent + 2) {
                            const named = /^[ ]*name:[ ]*(.+)$/.exec(current)
                            if (named !== null && item.name === undefined) item.name = unquote(named[1])
                        }
                    }
                    pluginsEnd = cursor + 1
                } else {
                    const key = /^[ ]*(id|name|description|order):[ ]*(.*)$/.exec(current)
                    if (key !== null) config[key[1]] = key[2].trim() === '' ? '' : unquote(key[2])
                }
                cursor += 1
            }
        }
        rows.push({
            rowId,
            id: config.id ?? rowId.replace(PRESET_ROW_PREFIX, ''),
            name: config.name ?? '',
            description: config.description ?? '',
            order: config.order === undefined || config.order === '' ? null : Number(config.order),
            plugins,
            pluginsInline,
            pluginsStart,
            pluginsEnd,
            pluginsIndent: pluginsStart < 0 ? configIndent + 2 : leadOf(lines[pluginsStart]),
            items: items.filter(item => item.id !== undefined || item.name !== undefined),
            startLine: index,
            endLine: end,
        })
        index = end - 1
    }
    return rows
}

/** The registry row carries the default id; deleting it would leave the profile pointing nowhere. */
export function parseRegistryDefault(text) {
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
        if (!/^[ ]*name:[ ]*['"]?@deepseek-ai\/dsh-agent-preset-registry/.test(lines[index])) continue
        for (let cursor = index + 1; cursor < lines.length && cursor < index + 40; cursor += 1) {
            const matched = /^[ ]*default:[ ]*(.+)$/.exec(lines[cursor])
            if (matched !== null) return unquote(matched[1])
            if (/^[ ]*- /.test(lines[cursor])) break
        }
    }
    return undefined
}

function yamlText(value) {
    const text = String(value)
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** One declaration block, ready to append to the patch array. */
export function presetRowLines({ id, name, description, order, plugins = [] }) {
    const lines = [
        '- insert:',
        `    - id: ${PRESET_ROW_PREFIX}${id}`,
        `      name: '${PRESET_MODULE}'`,
        '      config:',
        `        id: ${id}`,
    ]
    if (name !== undefined && name !== '') lines.push(`        name: ${yamlText(name)}`)
    if (description !== undefined && description !== '') lines.push(`        description: ${yamlText(description)}`)
    lines.push(`        order: ${Number.isFinite(order) ? order : 100}`)
    if (plugins.length === 0) {
        lines.push('        plugins: []')
    } else {
        lines.push('        plugins:')
        for (const plugin of plugins) {
            lines.push(`          - id: ${plugin.id}`)
            lines.push(`            name: '${plugin.name}'`)
        }
    }
    return lines
}

/** Append a declaration, keeping whatever the file already ended with. */
export function appendPresetRow(text, preset) {
    const body = text.endsWith('\n') ? text : `${text}\n`
    const block = presetRowLines(preset).join('\n')
    return `${body}${block}\n`
}

/** Remove exactly the lines one declaration owns. */
export function removePresetRow(text, rowId) {
    const row = parsePresetRows(text).find(entry => entry.rowId === rowId)
    if (row === undefined) return undefined
    const lines = text.split('\n')
    lines.splice(row.startLine, row.endLine - row.startLine)
    return lines.join('\n')
}

/**
 * Rewrite only the `plugins:` block of one declaration.
 *
 * Items come in two shapes: a kept item carries the raw lines it already had (so hand-written
 * config, `!!js` expressions and comments survive untouched), a new item is just id + name.
 */
export function replacePresetPlugins(text, rowId, items) {
    const row = parsePresetRows(text).find(entry => entry.rowId === rowId)
    if (row === undefined) return undefined
    const lines = text.split('\n')
    const head = `${' '.repeat(row.pluginsIndent)}plugins:`
    if (items.length === 0) {
        const empty = `${head} []`
        if (row.pluginsStart < 0) {
            lines.splice(findConfigTail(lines, row), 0, empty)
        } else {
            lines.splice(row.pluginsStart, row.pluginsEnd - row.pluginsStart, empty)
        }
        return lines.join('\n')
    }
    const body = []
    for (const item of items) {
        if (Array.isArray(item.lines)) {
            body.push(...item.lines)
            continue
        }
        const pad = ' '.repeat(row.pluginsIndent + 2)
        body.push(`${pad}- id: ${item.id}`)
        body.push(`${pad}  name: '${item.name}'`)
    }
    if (row.pluginsStart < 0) {
        // No plugins key yet: put it right after `order:` (or after `config:` when absent).
        lines.splice(findConfigTail(lines, row), 0, head, ...body)
        return lines.join('\n')
    }
    lines.splice(row.pluginsStart, row.pluginsEnd - row.pluginsStart, head, ...body)
    return lines.join('\n')
}

function findConfigTail(lines, row) {
    let cursor = row.startLine + 1
    let last = row.startLine + 1
    while (cursor < row.endLine) {
        const current = lines[cursor]
        if (/^[ ]*(id|name|description|order):/.test(current)) last = cursor + 1
        cursor += 1
    }
    return last
}
