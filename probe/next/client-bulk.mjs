#!/usr/bin/env node
/**
 * probe/next/client-bulk.mjs — the plugins view's batch switch, checked from outside.
 *
 * Two halves. The static gates read src/client/views/plugins.tsx and pin what the view must keep:
 * the exported name the shell imports, the single-row switch and the search box that shipped
 * before this task, the bulk op with the host's exact payload ({ items: [{ kind, id }], enabled }),
 * the 1.x "confirm past 20" rule, the snapshot's batch cap, accessible names on both checkboxes,
 * tokens instead of colours, and the existing empty states. It also pins the result path: the
 * batch reads the host answer through runDetailed and reports it with plugins.bulkDone
 * ({changed} / {skipped} / {truncated}). The runtime half cuts the exported helper region out of
 * the same file, bundles it with the project's own esbuild and imports it — so the payload
 * builder, the confirmation line, the selection set, the post-failure rule and the answer
 * normalizer are executed, not just grepped.
 *
 * The payload and the threshold are not taste: they are src/domains/plugins.ts (bulk items/enabled,
 * MAX_BULK 400, "the panel confirms past 20"). A view that sent { ids } or confirmed at 20 would
 * pass the browser and fail the host, so it fails here first.
 *
 * No third-party libraries beyond the repo's esbuild. Every line is PASS or FAIL; exit 1 when any
 * check fails.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = join(ROOT, 'src', 'client', 'views', 'plugins.tsx')
const I18N = join(ROOT, 'src', 'client', 'i18n.ts')

let passed = 0
let failed = 0
const failedNames = []

function check(name, run) {
  try {
    const detail = run()
    passed += 1
    console.log('PASS ' + name + (detail === undefined || detail === '' ? '' : ' (' + detail + ')'))
  } catch (error) {
    failed += 1
    failedNames.push(name)
    console.log('FAIL ' + name + ' -- ' + (error instanceof Error ? error.message : String(error)))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const source = readFileSync(VIEW, 'utf8')
const i18n = readFileSync(I18N, 'utf8')

/** Source with comments removed: a doc comment may name an op or a payload key in prose. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')
const body = code(source)
const lineCount = source.split('\n').length

/** Body of one declaration, from its marker to the next one. */
function slice(from, to) {
  const start = body.indexOf(from)
  assert(start !== -1, 'plugins.tsx has no ' + from)
  const end = body.indexOf(to, start + from.length)
  assert(end !== -1, 'plugins.tsx has no ' + to + ' after ' + from)
  return body.slice(start, end)
}

const ROW_START = '// #region bulk-helpers'
const ROW_END = '// #endregion bulk-helpers'
const helpersStart = source.indexOf(ROW_START)
const helpersEnd = source.indexOf(ROW_END)
const helpersSource =
  helpersStart === -1 || helpersEnd === -1 ? '' : source.slice(helpersStart + ROW_START.length, helpersEnd)

/** Comments stripped, so the bundle carries no prose; the region is pure JS/TS. */
const helpers = code(helpersSource)

const confirmBlock = slice('const confirmText', 'return (')
const commitBlock = slice('const commit = React.useCallback', 'const ask = React.useCallback')
const askBlock = slice('const ask = React.useCallback', 'if (snapshot.plugins.length === 0)')
const dialogIndex = body.search(/<Dialog\s+open=\{/)
const dialogRegion = dialogIndex === -1 ? '' : body.slice(dialogIndex)
const rowsRegion = body.indexOf('rows.map(row =>') === -1 ? '' : body.slice(body.indexOf('rows.map(row =>'))
const committed = body.slice(body.indexOf('const commit = React.useCallback'))

// ── static gates ─────────────────────────────────────────────────────────────

check('source-and-export', () => {
  assert(/export function PluginsView\(props: ViewProps\): React\.ReactElement \{/.test(body),
    'PluginsView must keep its exported name and (props: ViewProps) signature')
  assert(/import \* as React from 'react'/.test(body), 'the view must import React')
  assert(helpers !== '', 'the exported helper region (bulk-helpers) is missing')
  assert(!/\bimport\b/.test(helpers), 'the helper region must stay import-free so it can be executed in isolation')
  assert(!/React\./.test(helpers), 'the helper region must not touch React')
  return 'PluginsView kept, helper region standalone'
})

check('view-props', () => {
  assert(/const \{ snapshot, lang, t, busy, run, runDetailed \} = props/.test(body),
    'the view must read snapshot, lang, t, busy, run and runDetailed off ViewProps')
  assert(/snapshot\.plugins/.test(body), 'plugins must come from the snapshot, not a local fetch')
  return 'snapshot, lang, t, busy, run, runDetailed'
})

check('existing-single-switch-kept', () => {
  assert(/<Switch/.test(body), 'the per-row switch must stay')
  assert(/checked=\{row\.enabled\}/.test(body), 'the row switch must read the row state')
  assert(/label=\{t\('a11y\.switch', \{ name: row\.name \}\)\}/.test(body), 'the row switch keeps its accessible name')
  assert(/run\(OPS\.toggle, \{ kind: 'plugin', id: row\.id, enabled: next/.test(body),
    'a single row must still flip through toggle with { kind: plugin, id, enabled }')
  return 'Switch -> toggle, unchanged'
})

check('existing-search-and-states-kept', () => {
  assert(/<SearchBox/.test(body), 'the search box must stay')
  assert(/placeholder=\{t\('plugins\.search'\)\}/.test(body), 'the search keeps its placeholder')
  assert(/row\.name\.toLowerCase\(\)\.includes\(term\)/.test(body), 'the term still matches the name')
  assert(/row\.id\.toLowerCase\(\)\.includes\(term\)/.test(body), 'the term still matches the id')
  assert(/title=\{t\('plugins\.empty'\)\}/.test(body), 'the no-plugins empty state stays')
  assert(/t\('plugins\.emptyFiltered', \{ query \}\)/.test(body), 'the filtered-empty state stays')
  assert(/void props\.reload\(\)/.test(body), 'the retry action stays')
  return 'search + two empty states + retry'
})

check('bulk-op-and-payload', () => {
  assert(/runDetailed\(OPS\.bulk, \{ items: bulkItems\(ids, snapshot\.plugins\), enabled \}\)/.test(body),
    'the batch must go through runDetailed(OPS.bulk, { items: bulkItems(ids, snapshot.plugins), enabled }) to keep the host counts')
  assert(/bulkItems\(ids, snapshot\.plugins\)/.test(commitBlock), 'the payload is built by bulkItems with bundle names, not inline literals')
  assert(/if \(ids\.length === 0 \|\| ids\.length > cap\) return/.test(commitBlock),
    'an empty or over-cap batch must not be sent')
  assert(!/\{\s*ids\s*:/.test(body), 'the host takes items, not a bare ids array')
  assert(!/kind: 'skill'/.test(body), 'this view only batches plugins')
  return 'bulk { items: [{ kind: plugin, id }], enabled }'
})

check('confirm-past-20', () => {
  assert(/if \(needsConfirm\(picked\.length\)\) \{/.test(askBlock), 'ask() must route batches through needsConfirm')
  assert(/setConfirming\(enabled\)/.test(askBlock), 'a large batch must open the dialog instead of sending')
  assert(/commit\(enabled\)/.test(askBlock), 'a small batch sends without the dialog')
  assert(/commit\(enabled\)/.test(askBlock) && askBlock.indexOf('needsConfirm') < askBlock.indexOf('commit(enabled)'),
    'the confirm branch must be checked before commit')
  assert(/open=\{confirming !== null\}/.test(dialogRegion), 'the Dialog must be driven by the pending direction')
  assert(/if \(confirming !== null\) commit\(confirming\)/.test(dialogRegion), 'only the dialog confirm button sends the batch')
  assert(/t\('dialog\.confirmTitle'\)/.test(dialogRegion), 'the dialog keeps the shared confirm title')
  assert(/将启用/.test(confirmBlock) && /将停用/.test(confirmBlock), 'the dialog must name both directions')
  assert(/picked\.length/.test(confirmBlock), 'the dialog must say how many rows it will write')
  assert(/跳过|skipped/.test(confirmBlock), 'the disable copy must mention the entries the host skips')
  return 'needsConfirm -> dialog -> commit'
})

check('batch-cap', () => {
  assert(/snapshot\.limits === null \? BULK_CAP : snapshot\.limits\.bulk/.test(body),
    'the cap must come from snapshot.limits.bulk with BULK_CAP as the fallback')
  assert(/picked\.length > cap/.test(body), 'the view must compute the over-cap state')
  assert(/disabled=\{picked\.length === 0 \|\| overCap \|\| anyBusy\}/.test(body),
    'both batch buttons must be disabled when empty, over cap, or while an op runs')
  assert(/一批最多/.test(body) && /\$\{cap\}/.test(body), 'the over-cap state must tell the user the cap')
  assert(/BULK_CAP = 400/.test(body), 'BULK_CAP must match the host MAX_BULK (400)')
  return 'limits.bulk, fallback 400'
})

check('accessible-labels', () => {
  assert(/aria-label=\{zh \? `选择 \$\{row\.name\}` : `Select \$\{row\.name\}`\}/.test(body),
    'each row checkbox needs an accessible name that includes the row')
  assert(/aria-label=\{zh \? '全选当前可见的插件' : 'Select all visible plugins'\}/.test(body),
    'the select-all checkbox needs an accessible name')
  assert(/visibleIds\.length === 0 \|\| bulkBusy/.test(body), 'select-all must be disabled when nothing is selectable')
  assert(/t\('action\.cancel'\)/.test(dialogRegion) && /t\('action\.confirm'\)/.test(dialogRegion),
    'the dialog buttons need visible text')
  const labels = (body.match(/aria-label=/g) ?? []).length
  assert(labels >= 2, 'expected aria-label on the row and select-all checkboxes, found ' + labels)
  return labels + ' aria-label(s), plus the switch label'
})

check('selection-clears-on-success', () => {
  assert(/\.then\(outcome => \{/.test(committed), 'the batch must inspect its result')
  assert(/setSelected\(current => selectionAfter\(outcome\.ok, current\)\)/.test(committed),
    'a failed batch must keep the selection for a retry')
  assert(/if \(!outcome\.ok\) return/.test(committed), 'a failed batch stops before closing the dialog')
  assert(/setConfirming\(null\)/.test(committed), 'the dialog closes only after a successful batch')
  return 'selectionAfter(outcome.ok): clear on success, keep on failure'
})

check('detailed-write-path', () => {
  const detailed = [...body.matchAll(/\brunDetailed\(OPS\.([A-Za-z0-9_]+)/g)].map(match => match[1])
  assert(detailed.length === 1 && detailed[0] === 'bulk', 'only the batch needs the host answer, found ' + detailed.join(', '))
  assert(/runDetailed\(OPS\.bulk, \{ items: bulkItems\(ids, snapshot\.plugins\), enabled \}\)/.test(commitBlock),
    'the batch payload keeps bundle names; only the call keeps its answer')
  assert(!/\brun\(OPS\.bulk/.test(body), 'the batch must not fall back to run(), which drops the counts')
  return 'bulk -> runDetailed; toggle and third-party stay on run'
})

check('bulk-result-surfaced', () => {
  assert(/setBulkReport\(null\)/.test(commitBlock), 'a new batch clears the previous report')
  assert(/setBulkReport\(normalizeBulk\(outcome\.data\)\)/.test(commitBlock),
    'the batch must keep the host answer for display')
  assert(/t\('plugins\.bulkDone', \{/.test(body), 'the summary must use the shared plugins.bulkDone copy')
  for (const key of ['changed: bulkReport.changed', 'skipped: bulkReport.skipped', 'truncated: bulkReport.truncated ?']) {
    assert(body.includes(key), 'the summary must pass ' + key)
  }
  assert(/role="status"/.test(body), 'the summary must be announced as a status line')
  assert(/truncated: bulkReport\.truncated \? \(zh \? '是' : 'yes'\) : \(zh \? '否' : 'no'\)/.test(body),
    'truncated is a boolean; the copy takes a word')
  return 'plugins.bulkDone with changed / skipped / truncated'
})

check('no-literal-colours', () => {
  const strip = text => {
    let out = ''
    let index = 0
    while (index < text.length) {
      const start = text.indexOf('var(--dsw-alias-', index)
      if (start === -1) {
        out += text.slice(index)
        break
      }
      out += text.slice(index, start)
      let depth = 0
      let cursor = start
      for (; cursor < text.length; cursor += 1) {
        const char = text[cursor]
        if (char === '(') depth += 1
        else if (char === ')') {
          depth -= 1
          if (depth === 0) {
            cursor += 1
            break
          }
        }
      }
      index = cursor
    }
    return out
  }
  const rest = strip(body)
  const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(rest)
  assert(match === null, 'a literal colour at char ' + (match === null ? 0 : match.index) + '; use a th-* class or a token')
  const inline = (body.match(/style=\{\{/g) ?? []).length
  return 'tokens only, ' + inline + ' inline layout style block(s)'
})

check('i18n-keys', () => {
  const catalog = name => {
    const marker = new RegExp('const ' + name + ': Catalog = \\{').exec(i18n)
    assert(marker !== null, 'i18n.ts has no ' + name + ' catalog')
    const start = marker.index + marker[0].length - 1
    let depth = 0
    let end = -1
    for (let cursor = start; cursor < i18n.length; cursor += 1) {
      if (i18n[cursor] === '{') depth += 1
      else if (i18n[cursor] === '}') {
        depth -= 1
        if (depth === 0) {
          end = cursor
          break
        }
      }
    }
    assert(end !== -1, name + ' catalog is not closed')
    return new Set([...i18n.slice(start + 1, end).matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1]))
  }
  const zh = catalog('zh')
  const en = catalog('en')
  const zhOnly = [...zh].filter(key => !en.has(key))
  const enOnly = [...en].filter(key => !zh.has(key))
  assert(zhOnly.length === 0 && enOnly.length === 0, 'catalog drift: zh-only ' + zhOnly.join(',') + ' en-only ' + enOnly.join(','))
  const used = [...body.matchAll(/\bt\('([^']+)'/g)].map(match => match[1])
  const missing = [...new Set(used)].filter(key => !zh.has(key) || !en.has(key))
  assert(missing.length === 0, 'no catalog defines ' + missing.join(', '))
  return used.length + ' calls, ' + new Set(used).size + ' distinct keys, all defined twice'
})

check('import-contract', () => {
  for (const match of body.matchAll(/from '(\.\/[^']+|\.\.\/[^']+)'/g)) {
    assert(/\.js$/.test(match[1]), 'import ' + match[1] + ' needs a .js suffix')
  }
  assert(/from '\.\.\/components\.js'/.test(body), 'the view must reuse components.tsx')
  for (const name of ['Badge', 'Button', 'Dialog', 'Switch', 'SearchBox']) {
    assert(new RegExp('\\b' + name + '\\b').test(body), 'the view must use the ' + name + ' component')
  }
  assert(/from '\.\.\/types\.js'/.test(body), 'the view must import its props from types.ts')
  assert(/from '\.\.\/api\.js'/.test(body), 'the view sends ops through the api module')
  return 'components.js + types.js + api.js, all .js'
})

check('single-write-path', () => {
  for (const pattern of ['fetch(', 'getSnapshot', 'innerHTML', 'dangerouslySetInnerHTML']) {
    assert(body.indexOf(pattern) === -1, 'plugins.tsx uses ' + pattern + '; every write goes through run()')
  }
  // The third-party dialog reads its status; that one read is the only direct IO allowed.
  const reads = [...body.matchAll(/runOp\(\s*(THIRD\.[A-Za-z0-9_]+)/g)].map(match => match[1])
  assert(reads.length === 1 && reads[0] === 'THIRD.status', 'runOp may only read third.status')
  const calls = body.match(/\brun\(/g) ?? []
  assert(calls.length >= 2, 'expected both toggle and bulk to go through run(), found ' + calls.length)
  assert(calls.length === (body.match(/\brun\((OPS|THIRD)\./g) ?? []).length, 'an op escapes the op tables')
  const ops = new Set([...body.matchAll(/\brun\(OPS\.([A-Za-z0-9_]+)/g)].map(match => match[1]))
  assert([...ops].every(op => op === 'bulk' || op === 'toggle'), 'unexpected op(s): ' + [...ops].join(', '))
  const third = new Set([...body.matchAll(/\brun\(THIRD\.([A-Za-z0-9_]+)/g)].map(match => match[1]))
  assert([...third].every(op => op === 'off' || op === 'restore'), 'unexpected third op(s): ' + [...third].join(', '))
  return calls.length + ' run() calls: ' + [...ops, ...third].join(', ')
})

check('file-length', () => {
  const bytes = statSync(VIEW).size
  assert(lineCount <= 450, 'plugins.tsx is ' + lineCount + ' lines (limit 450)')
  assert(bytes < 64 * 1024, 'plugins.tsx is ' + bytes + ' bytes')
  return lineCount + ' lines, ' + bytes + ' bytes'
})

// ── runtime: the exported helpers, bundled and executed ──────────────────────

let api = null
try {
  const bundled = await build({
    stdin: { contents: helpers, loader: 'ts', resolveDir: ROOT, sourcefile: 'plugins-helpers.ts' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })
  const text = bundled.outputFiles?.[0]?.text ?? ''
  assert(text !== '', 'esbuild produced no bundle for the helper region')
  api = await import('data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64'))
} catch (error) {
  failed += 1
  failedNames.push('helpers-bundle')
  console.log('FAIL helpers-bundle -- ' + (error instanceof Error ? error.message : String(error)))
}

function need() {
  assert(api !== null, 'the helper region did not compile')
  return api
}

check('runtime-bulk-items', () => {
  const mod = need()
  const input = ['alpha', 'beta']
  const items = mod.bulkItems(input)
  assert(Array.isArray(items) && items.length === 2, 'bulkItems returned ' + JSON.stringify(items))
  assert(JSON.stringify(items) === JSON.stringify([{ kind: 'plugin', id: 'alpha' }, { kind: 'plugin', id: 'beta' }]),
    'bulkItems must produce { kind: plugin, id } in the picked order, got ' + JSON.stringify(items))
  assert(items !== input, 'bulkItems must build new objects, not pass ids through')
  assert(JSON.stringify(mod.bulkItems([])) === '[]', 'an empty selection must produce an empty items array')
  assert(JSON.stringify(mod.bulkItems(['bundle:dsh-univer-office'], [{ id: 'bundle:dsh-univer-office', bundleName: 'dsh-univer-office' }])) === JSON.stringify([{ kind: 'plugin', id: 'bundle:dsh-univer-office', bundleName: 'dsh-univer-office' }]), 'a bundle row must carry its bundleName into the bulk payload')
  const later = mod.bulkItems(['alpha'])
  assert(later[0].id === 'alpha' && later[0].kind === 'plugin', 'the member shape is kind + id')
  return '2 members, exact host shape'
})

check('runtime-confirm-threshold', () => {
  const mod = need()
  const at = mod.BULK_CONFIRM_ABOVE
  assert(at === 20, 'BULK_CONFIRM_ABOVE must be the 1.x value 20, got ' + at)
  assert(mod.needsConfirm(0) === false, 'an empty batch needs no dialog')
  assert(mod.needsConfirm(20) === false, 'exactly 20 must not ask: the host says "past 20"')
  assert(mod.needsConfirm(21) === true, '21 must ask')
  assert(mod.needsConfirm(400) === true, '400 must ask')
  assert(mod.needsConfirm(5, 5) === false && mod.needsConfirm(6, 5) === true, 'the threshold must stay configurable and exclusive')
  return '20 false, 21 true'
})

check('runtime-toggle-selected', () => {
  const mod = need()
  assert(JSON.stringify(mod.toggleSelected([], 'a', true)) === '["a"]', 'ticking must add the id')
  assert(JSON.stringify(mod.toggleSelected(['a'], 'b', true)) === '["a","b"]', 'picking keeps the click order')
  assert(JSON.stringify(mod.toggleSelected(['a', 'b'], 'a', true)) === '["a","b"]', 'ticking twice must not duplicate')
  assert(JSON.stringify(mod.toggleSelected(['a', 'b'], 'a', false)) === '["b"]', 'unticking removes only that id')
  assert(JSON.stringify(mod.toggleSelected(['b'], 'a', false)) === '["b"]', 'unticking an absent id is a no-op')
  const before = ['a']
  const after = mod.toggleSelected(before, 'b', true)
  assert(JSON.stringify(before) === '["a"]', 'the previous selection must not be mutated')
  assert(after !== before, 'a new array is returned so React re-renders')
  return 'add/remove/order/no-dup/immutable'
})

check('runtime-select-visible', () => {
  const mod = need()
  assert(JSON.stringify(mod.selectVisible([], ['a', 'b'], true)) === '["a","b"]', 'select-all adds every visible id')
  assert(JSON.stringify(mod.selectVisible(['b'], ['a', 'b'], true)) === '["b","a"]', 'already-picked ids keep their place')
  assert(JSON.stringify(mod.selectVisible(['a', 'b', 'c'], ['b'], false)) === '["a","c"]', 'unselect-all drops only visible ids')
  assert(JSON.stringify(mod.selectVisible(['a'], [], true)) === '["a"]', 'an empty filter leaves the selection alone')
  assert(JSON.stringify(mod.selectVisible(['a'], ['a'], false)) === '[]', 'clearing the last visible id empties the batch')
  return 'select / merge / unselect-visible'
})

check('runtime-selection-after', () => {
  const mod = need()
  const picked = ['a', 'b']
  assert(JSON.stringify(mod.selectionAfter(true, picked)) === '[]', 'a successful batch clears the selection')
  assert(JSON.stringify(mod.selectionAfter(false, picked)) === '["a","b"]', 'a failed batch keeps it for retry')
  assert(mod.selectionAfter(false, picked) === picked, 'the failed path returns the same selection')
  return 'clear on ok, keep on fail'
})

check('runtime-normalize-bulk', () => {
  const mod = need()
  assert(mod.normalizeBulk(null) === null, 'a null answer must not report anything')
  assert(mod.normalizeBulk('nope') === null, 'a non-object answer must not report anything')
  const full = { changed: 3, skippedBuiltin: 2, truncated: true, results: [] }
  assert(JSON.stringify(mod.normalizeBulk(full)) === JSON.stringify({ changed: 3, skipped: 2, truncated: true }),
    'the host answer must map to changed / skippedBuiltin -> skipped / truncated, got ' + JSON.stringify(mod.normalizeBulk(full)))
  const partial = mod.normalizeBulk({})
  assert(JSON.stringify(partial) === JSON.stringify({ changed: 0, skipped: 0, truncated: false }),
    'an answer without counts reports zeros, got ' + JSON.stringify(partial))
  const junk = mod.normalizeBulk({ changed: 'many', skippedBuiltin: null, truncated: 'yes' })
  assert(JSON.stringify(junk) === JSON.stringify({ changed: 0, skipped: 0, truncated: false }),
    'non-numbers and non-true flags must not leak into the copy, got ' + JSON.stringify(junk))
  const before = JSON.stringify(full)
  mod.normalizeBulk(full)
  assert(JSON.stringify(full) === before, 'the host answer must not be mutated')
  return 'null/partial/junk answers become a safe report'
})

check('runtime-selectable-ids', () => {
  const mod = need()
  const rows = [
    { id: 'p1', name: 'P1', enabled: true, manageable: true },
    { id: 'ro', name: 'RO', enabled: false, manageable: false, readOnlyReason: 'read-only' },
    { id: 'legacy', name: 'L', enabled: false },
  ]
  const ids = mod.selectableIds(rows)
  assert(JSON.stringify(ids) === '["p1","legacy"]', 'read-only rows must be excluded, got ' + JSON.stringify(ids))
  assert(JSON.stringify(mod.selectableIds([])) === '[]', 'no rows means no selectable ids')
  return 'read-only rows are not selectable'
})

// ── report ───────────────────────────────────────────────────────────────────

const total = passed + failed
console.log(passed + '/' + total + ' checks passed')
if (failed > 0) {
  console.log('failed: ' + failedNames.join(', '))
  process.exit(1)
}