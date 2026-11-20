#!/usr/bin/env node
/**
 * probe/next/client-presets.mjs — the presets view (task-9), checked from outside.
 *
 * Static gates only, no dependencies: they read the view source, the catalogs it draws copy
 * from, the component library it composes, the shell that keys the busy flag and the domain
 * whose handlers define the payloads. A gate fails as soon as a property the panel relies on
 * disappears — an op renamed, a confirm skipped, a label dropped, a colour hard-coded.
 *
 * Coverage:
 *   1. the file exists and exports PresetsView with the shell's prop type;
 *   2. exactly the four preset ops are referenced, each with the payload the handler reads;
 *   3. apply carries the mode the domain accepts, and the options match PresetMode;
 *   4. busy keys are `op:id` and the payload carries the id the shell keys on;
 *   5. empty state (unfiltered and filtered) uses the presets.empty key;
 *   6. apply fires from the row; save, overwrite and delete each fire from a dialog;
 *   7. overwrite and delete confirm first, and delete names the preset it removes;
 *   8. search filters by name, the mode select switches the apply mode;
 *   9. accessible names on every control, catalogs resolve every t() key;
 *  10. no literal colours, relative imports carry .js, file stays under 450 lines;
 *  11. the view reads the normalised snapshot (optional arrays, index fallback);
 *  12. apply is sent through runDetailed, the only caller that needs the host's answer;
 *  13. a deferred tool dimension waits retryAfterMs and is retried exactly once, then reported.
 *
 * Every line is PASS or FAIL; exit 1 when any check fails.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = join(ROOT, 'src', 'client', 'views', 'presets.tsx')
const I18N = join(ROOT, 'src', 'client', 'i18n.ts')
const COMPONENTS = join(ROOT, 'src', 'client', 'components.tsx')
const SHELL = join(ROOT, 'src', 'client', 'shell.tsx')
const DOMAIN = join(ROOT, 'src', 'domains', 'presets.ts')

const results = []

function check(name, run) {
  try {
    const detail = run()
    results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : '' })
  }
  catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const rel = file => relative(ROOT, file).split('\\').join('/')
const read = file => readFileSync(file, 'utf8')
/** 1-based line of a character offset, for file:line reporting. */
const lineAt = (text, index) => text.slice(0, Math.max(0, index)).split('\n').length
/** Source without comments: a doc comment may name a token or an op in prose. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')

assert(existsSync(VIEW), `${rel(VIEW)} is missing`)
const source = read(VIEW)
const body = code(source)

/** Balanced body of a top-level `const name = (…)` or `function name(…)` declaration. */
function functionBody(text, name) {
  const arrow = text.indexOf(`const ${name} = (`)
  const at = arrow !== -1 ? arrow : text.indexOf(`function ${name}(`)
  assert(at !== -1, `${name} is not declared at the top level`)
  const open = text.indexOf('{', at)
  assert(open !== -1, `${name} has no body`)
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, index + 1)
    }
  }
  throw new Error(`${name} body is not closed`)
}

/** The object literal passed to `marker` (e.g. `run(OP.apply,`), braces excluded. */
function runPayload(text, marker) {
  const at = text.indexOf(marker)
  assert(at !== -1, `no call to ${marker}`)
  const open = text.indexOf('{', at + marker.length)
  assert(open !== -1, `${marker} passes no payload object`)
  assert(text.slice(at + marker.length, open).indexOf(')') === -1, `${marker} passes no payload object`)
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, index)
    }
  }
  throw new Error(`${marker} payload is not closed`)
}

/** A property, written either as `key:` or as an ES shorthand. */
function hasProp(object, key) {
  // A sentinel comma lets the last property in the literal match like any other.
  return new RegExp(`(?:^|[\\s,{])${key}\\s*[,}:]`).test(object + ',')
}

function count(text, needle) {
  return text.split(needle).length - 1
}

/** Keys a catalog declares, by brace matching (same reading as probe/next/client-shell.mjs). */
function catalog(name) {
  const text = read(I18N)
  const found = new RegExp(`const ${name}: Catalog = \\{`).exec(text)
  assert(found !== null, `i18n.ts has no ${name} catalog`)
  const open = found.index + found[0].length - 1
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) {
        const block = text.slice(open + 1, index)
        return new Set([...block.matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1]))
      }
    }
  }
  throw new Error(`${name} catalog is not closed`)
}

// ── gates ────────────────────────────────────────────────────────────────────

check('view-file', () => {
  assert(statSync(VIEW).size > 0, 'presets.tsx is empty')
  assert(/import \* as React from 'react'/.test(body), 'presets.tsx must import React')
  return `${rel(VIEW)}, ${statSync(VIEW).size} bytes`
})

check('export-presetsview', () => {
  assert(/export function PresetsView\(props: ViewProps\): React\.ReactElement/.test(body),
    'presets.tsx must export PresetsView(props: ViewProps): React.ReactElement')
  return 'PresetsView keeps the shell contract'
})

check('required-ops', () => {
  const ops = [...body.matchAll(/'preset\.([a-z]+)'/g)].map(match => match[1])
  const wanted = ['apply', 'save', 'update', 'delete']
  for (const op of wanted) assert(ops.includes(op), `presets.tsx never names preset.${op}`)
  assert(ops.length === wanted.length, `presets.tsx names ${ops.length} preset ops, expected ${wanted.length}`)
  assert(new Set(ops).size === ops.length, 'a preset op is named twice')
  return wanted.map(op => `preset.${op}`).join(', ')
})

check('op-payloads', () => {
  const wanted = [
    ['runDetailed(OP.apply,', 'apply', ['id', 'name', 'mode']],
    ['run(OP.save,', 'save', ['id', 'name']],
    ['run(OP.update,', 'update', ['id', 'name']],
    ['run(OP.remove,', 'remove', ['id', 'name']],
  ]
  for (const [marker, label, props] of wanted) {
    const payload = runPayload(body, marker)
    for (const prop of props) {
      assert(hasProp(payload, prop), `${label} payload has no "${prop}"`)
    }
  }
  return 'name + id on every op, mode on apply (src/domains/presets.ts reads them)'
})

check('action-apply-mode', () => {
  const payload = runPayload(body, 'runDetailed(OP.apply,')
  assert(hasProp(payload, 'mode'), 'apply does not send a mode')
  const domain = read(DOMAIN)
  assert(/export type PresetMode = 'exact' \| 'only-enable'/.test(domain),
    'src/domains/presets.ts no longer declares PresetMode as exact | only-enable')
  for (const mode of ['exact', 'only-enable']) {
    assert(body.includes(`'${mode}'`), `the view never offers mode ${mode}`)
  }
  assert(/value === 'only-enable' \? 'only-enable' : 'exact'/.test(body), 'the select does not normalise its value')
  return 'exact / only-enable, matching PresetMode'
})

check('busy-keys', () => {
  for (const key of ['${OP.apply}:${name}', '${OP.update}:${name}', '${OP.remove}:${name}', '${OP.save}:${draftName}']) {
    assert(body.includes('`' + key + '`'), `no busy key ${key}`)
  }
  const shell = read(SHELL)
  assert(shell.includes('`${op}:${id}`'), 'shell.tsx no longer keys busy as `${op}:${id}`')
  assert(/['"]id['"] in payload/.test(shell), 'shell.tsx no longer reads payload.id')
  return 'row busy flags follow the shell op:id convention'
})

check('empty-state', () => {
  const hits = count(body, 'presets.empty')
  assert(hits >= 2, `presets.empty is used ${hits} time(s); both the empty list and the empty filter need it`)
  assert(/<Empty /.test(body), 'the view renders no Empty component')
  return 'unfiltered and filtered empty states'
})

check('action-apply-button', () => {
  assert(count(body, 'runDetailed(OP.apply,') === 1, `apply is sent from ${count(body, 'runDetailed(OP.apply,')} places`)
  const applyAt = body.indexOf('runDetailed(OP.apply,')
  const firstDialog = body.indexOf('<Dialog')
  assert(firstDialog !== -1 && applyAt < firstDialog, 'apply is not sent from a handler defined above the dialogs')
  const row = body.slice(body.indexOf('rows.map('), firstDialog)
  assert(row.includes('applyRow(name)'), 'the row buttons do not call applyRow')
  assert(functionBody(body, 'applyRow').includes('runDetailed(OP.apply,'), 'applyRow does not send the apply')
  assert(body.includes('busy={busy === `${OP.apply}:${name}`}'), 'the apply button is not marked busy')
  return 'one send site, reached from the row, with a busy key'
})

check('apply-via-rundetailed', () => {
  assert(/const \{ snapshot, t, lang, busy, run, runDetailed \} = props/.test(body),
    'the view does not take runDetailed from props')
  assert(!body.includes('run(OP.apply,'), 'apply still goes through run, which drops the host answer')
  assert(count(body, 'runDetailed(OP.apply,') === 1,
    `runDetailed(OP.apply, …) appears ${count(body, 'runDetailed(OP.apply,')} times`)
  assert(/import type \{[^}]*RunOutcome[^}]*\} from '\.\.\/types\.js'/.test(body), 'the view does not import RunOutcome')
  assert(/runDetailed: RunDetailedOp/.test(read(join(ROOT, 'src', 'client', 'types.ts'))),
    'ViewProps no longer declares runDetailed')
  const shell = read(SHELL)
  assert(/presets: <PresetsView[^>]*runDetailed=\{runDetailed\}/.test(shell),
    'shell.tsx does not pass runDetailed to PresetsView')
  return 'runDetailed(OP.apply, …) is the only apply path'
})

check('deferred-retry', () => {
  const wait = functionBody(body, 'applyTwice')
  assert(count(wait, 'send()') === 2, `applyTwice sends ${count(wait, 'send()')} times, expected exactly two`)
  assert(wait.includes('setTimeout'), 'applyTwice does not wait before the retry')
  assert(!/while\s*\(|for\s*\(/.test(wait), 'applyTwice loops; the retry must be capped at one')
  assert(!/applyTwice\s*\(/.test(wait), 'applyTwice calls itself')
  assert(/first\.ok/.test(wait), 'applyTwice retries even when the first apply failed')
  const parse = functionBody(body, 'deferralOf')
  assert(parse.includes("'deferred'"), 'deferralOf does not test decision === deferred')
  assert(parse.includes('retryAfterMs'), 'deferralOf ignores retryAfterMs')
  assert(/data as \{ tools\?: unknown \}/.test(parse), 'deferralOf does not read data.tools')
  assert(body.includes('const RETRY_DEFAULT_MS = 1500'), 'the 1500 ms default for a missing retryAfterMs is gone')
  assert(/if \(retried\) setDeferred\(true\)/.test(body), 'the spent retry is not reported')
  assert(/setDeferred\(false\)/.test(functionBody(body, 'applyRow')), 'a new apply does not clear the previous deferral')
  assert(body.includes("t('presets.deferred')"), 'the view does not show presets.deferred after the retry')
  assert(/<Callout tone=.info.>\{t\(/.test(body), 'the deferral line is not an info Callout')
  return 'deferred → wait retryAfterMs (default 1500) → one retry → reported, never looped'
})

check('action-filter', () => {
  assert(/const \[query, setQuery\] = React\.useState\(''\)/.test(body), 'no query state')
  assert(body.includes('onChange={setQuery}'), 'the search box does not drive the query')
  assert(/names\.filter\(name => name\.toLowerCase\(\)\.includes\(term\)\)/.test(body),
    'rows are not filtered by name')
  return 'filter by name, cleared through SearchBox'
})

check('action-save-dialog', () => {
  assert(count(body, 'run(OP.save,') === 1, 'save is sent from more than one place')
  assert(body.includes('open={draft !== null}'), 'save has no dialog')
  assert(functionBody(body, 'submitSave').includes('run(OP.save,'), 'save is not sent from submitSave')
  assert(body.indexOf('onClick={submitSave}') > body.indexOf('open={draft !== null}'), 'the dialog does not call submitSave')
  assert(/<Field[\s\S]{0,200}id={nameId}/.test(body), 'the name input is not wrapped in a Field')
  assert(/id={nameId}[\s\S]{0,200}className="th-input"/.test(body), 'the name input has no th-input class')
  assert(/maxLength=\{60\}/.test(body), 'the name input does not cap at MAX_PRESET_NAME (60)')
  assert(/disabled=\{draftName === ''\}/.test(body), 'an empty name can be submitted')
  assert(/overwriting/.test(body) && /names\.includes\(draftName\)/.test(body),
    'saving over an existing name is not warned about (preset.save overwrites)')
  return 'Field + input, empty name blocked, overwrite warned'
})

check('action-update-confirm', () => {
  assert(count(body, 'run(OP.update,') === 1, 'overwrite is sent from more than one place')
  assert(body.includes('setPending({ op: OP.update, name })'), 'the overwrite button does not open a dialog')
  const fn = functionBody(body, 'confirmOverwrite')
  assert(fn.includes('run(OP.update,'), 'overwrite is not sent from confirmOverwrite')
  const dialogAt = body.indexOf('open={pending !== null}')
  assert(dialogAt !== -1 && body.indexOf('confirmOverwrite(pending.name)') > dialogAt,
    'the dialog does not call confirmOverwrite')
  assert(body.includes("t('action.confirm')"), 'the overwrite dialog has no confirm button')
  return 'dialog first, op sent by confirmOverwrite'
})

check('action-delete-confirm', () => {
  assert(count(body, 'run(OP.remove,') === 1, 'delete is sent from more than one place')
  assert(body.includes('setPending({ op: OP.remove, name })'), 'the delete button does not open a dialog')
  const fn = functionBody(body, 'confirmDelete')
  assert(fn.includes('run(OP.remove,'), 'delete is not sent from confirmDelete')
  const dialogAt = body.indexOf('open={pending !== null}')
  assert(dialogAt !== -1 && body.indexOf('confirmDelete(pending.name)') > dialogAt,
    'the dialog does not call confirmDelete')
  assert(body.includes("t('presets.deleteBody', { name: pending.name })"), 'the dialog does not name the preset it deletes')
  assert(/variant="danger"[\s\S]{0,120}confirmDelete|confirmDelete[\s\S]{0,200}variant="danger"/.test(body),
    'the delete confirm is not a danger button')
  return 'dialog first, preset named, danger confirm'
})

check('accessible-labels', () => {
  for (const key of ['presets.apply', 'presets.update', 'presets.delete']) {
    assert(new RegExp(`label=\\{t\\('${key.replace('.', '\\.')}'\\) \\+ ': ' \\+ name\\}`).test(body),
      `the ${key} row button has no accessible name carrying the preset`)
  }
  assert(/<Select[\s\S]{0,200}label=\{lang === 'zh'/.test(body), 'the mode select has no accessible name')
  assert(/aria-label=\{t\('presets\.name'\)\}/.test(body), 'the name input has no accessible name')
  assert(/<Field[\s\S]{0,120}label=\{t\('presets\.name'\)\}/.test(body), 'the name field is not labelled')
  assert(/hint=\{lang === 'zh'/.test(body), 'the field hint is not bilingual')
  assert(/<SearchBox[\s\S]{0,300}label=\{t\('presets\.search'\)\}/.test(body), 'the search box has no accessible name')
  return 'buttons, select, input, search box all named'
})

check('i18n-keys-resolve', () => {
  const zh = catalog('zh')
  const en = catalog('en')
  const keys = [...body.matchAll(/\bt\('([^']+)'/g)].map(match => match[1])
  assert(keys.length > 0, 'the view calls no t() key')
  for (const key of keys) {
    assert(zh.has(key), `presets.tsx calls t('${key}') which zh does not define`)
    assert(en.has(key), `presets.tsx calls t('${key}') which en does not define`)
  }
  return `${new Set(keys).size} keys, zh + en`
})

check('no-literal-colours', () => {
  // Drop every var(--dsw-alias-…) with its balanced fallback; nothing coloured may remain.
  let rest = ''
  let index = 0
  while (index < source.length) {
    const start = source.indexOf('var(--dsw-alias-', index)
    if (start === -1) {
      rest += source.slice(index)
      break
    }
    rest += source.slice(index, start)
    let depth = 0
    let cursor = start
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === '(') depth += 1
      else if (source[cursor] === ')') {
        depth -= 1
        if (depth === 0) {
          cursor += 1
          break
        }
      }
    }
    index = cursor
  }
  const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(rest)
  assert(match === null, `presets.tsx:${lineAt(rest, match?.index ?? 0)} uses a literal colour`)
  return 'className th-* and tokens only'
})

check('imports-js', () => {
  const importLine = /import \{([^}]+)\} from '\.\.\/components\.js'/.exec(body)
  assert(importLine !== null, 'the view does not import from ../components.js')
  const named = importLine[1].split(',').map(name => name.trim()).filter(name => name !== '')
  const components = read(COMPONENTS)
  for (const name of named) {
    assert(new RegExp(`export function ${name}\\b`).test(components), `components.tsx has no ${name}`)
  }
  for (const match of body.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
    assert(/\.(js|json)$/.test(match[1]), `imports '${match[1]}' without a .js suffix`)
  }
  return `${named.length} components, all exported`
})

check('snapshot-shape', () => {
  assert(/snapshot\.presets\[name\] \?\? \{\}/.test(body), 'the row does not fall back when the entry is missing')
  for (const dim of ['plugin', 'skill', 'tool']) {
    assert(new RegExp(`row\\.${dim}\\?\\.length`).test(body), `${dim} is read without an optional-array guard`)
  }
  assert(/Object\.keys\(snapshot\.presets\)/.test(body), 'names do not come from the snapshot')
  return 'optional arrays, missing-entry fallback'
})

check('file-length', () => {
  const lines = source.split('\n').length
  const bytes = statSync(VIEW).size
  assert(lines < 450, `presets.tsx has ${lines} lines (limit 450)`)
  assert(bytes < 48 * 1024, `presets.tsx is ${bytes} bytes`)
  return `${lines} lines, ${bytes} bytes`
})

check('no-todo', () => {
  const at = body.search(/TODO\(|FIXME|XXX:/)
  assert(at === -1, `presets.tsx:${lineAt(body, at)} still carries a TODO marker`)
  return 'no TODO/FIXME markers'
})

// ── report ───────────────────────────────────────────────────────────────────

let failed = 0
for (const result of results) {
  const state = result.ok ? 'PASS' : 'FAIL'
  if (!result.ok) failed += 1
  const suffix = result.detail === '' ? '' : ` (${result.detail})`
  console.log(`${state} ${result.name}${suffix}`)
}
console.log(`${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
