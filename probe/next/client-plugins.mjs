#!/usr/bin/env node
/**
 * probe/next/client-plugins.mjs — the plugins view's bundle tree, checked from outside.
 *
 * Two halves, the same shape as client-bulk.mjs. The static gates read src/client/views/plugins.tsx
 * and src/client/views/plugins-tree.tsx and pin what must stay true: the rows arrive from
 * snapshot.plugins grouped by snapshot.bundles (no extra request, no local fetch), the toolbar's
 * count, select-all and empty state follow the rows the tree actually shows, the parent switch
 * writes the manageable children of its own group through the same OPS.bulk payload and the same
 * "confirm past twenty" dialog as the toolbar, the shared GroupTree stays the only renderer, and
 * expansion is remembered under 'tool-hub-tree-plugins' with a non-empty search forcing every group
 * open. The runtime half cuts the exported helper region out of plugins-tree.tsx, bundles it with
 * the project's own esbuild and imports it, so grouping, membership, counting and filtering are
 * executed against fixtures instead of grepped.
 *
 * The membership rule is not taste: src/host/snapshot.ts puts listBundles() into snapshot.bundles and
 * src/domains/plugins.ts defines a BundleRow as { name, version, enabled, official, rows: plugin ids }.
 * A group built from anything else would pass the browser and disagree with the host.
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
const TREE = join(ROOT, 'src', 'client', 'views', 'plugins-tree.tsx')
const SHARED = join(ROOT, 'src', 'client', 'views', 'package-tree.tsx')
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
const treeSource = readFileSync(TREE, 'utf8')
const i18n = readFileSync(I18N, 'utf8')

/** Source with comments removed: a doc comment may name an op or a field in prose. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')
const body = code(source)
const tree = code(treeSource)
const lineCount = source.split('\n').length

/** Body of one declaration, from its marker to the next one. */
function slice(from, to) {
  const start = body.indexOf(from)
  assert(start !== -1, 'plugins.tsx has no ' + from)
  const end = body.indexOf(to, start + from.length)
  assert(end !== -1, 'plugins.tsx has no ' + to + ' after ' + from)
  return body.slice(start, end)
}

const REGION_START = '// #region tree-helpers'
const REGION_END = '// #endregion tree-helpers'
const regionStart = treeSource.indexOf(REGION_START)
const regionEnd = treeSource.indexOf(REGION_END)
const helpers = regionStart === -1 || regionEnd === -1
  ? ''
  : code(treeSource.slice(regionStart + REGION_START.length, regionEnd))

const groupCall = slice('const groups = pluginTreeGroups(', 'const visibleRows')
const commitBlock = slice('const commit = React.useCallback', 'const ask = React.useCallback')
const parentBlock = slice('const onGroupBulk = React.useCallback', 'const readThird =')
const renderRowBlock = slice('const renderRow = (row: PluginRow)', 'const confirmText =')
const treeUse = body.slice(body.indexOf('<PluginsTree'), body.indexOf('</Card>') === -1 ? undefined : body.indexOf('</Card>'))
const committed = body.slice(body.indexOf('const commit = React.useCallback'))

// ── static gates: plugins.tsx ────────────────────────────────────────────────

check('source-and-export', () => {
  assert(/export function PluginsView\(props: ViewProps\): React\.ReactElement \{/.test(body),
    'PluginsView must keep its exported name and (props: ViewProps) signature')
  assert(/import \* as React from 'react'/.test(body), 'the view must import React')
  assert(/from '\.\/plugins-tree\.js'/.test(body), 'the view must import the tree module with a .js suffix')
  assert(/from '\.\/package-tree\.js'/.test(body), 'the view types its parent groups against package-tree.js')
  assert(/pluginTreeGroups/.test(body), 'the view must build its groups with pluginTreeGroups')
  assert(/PluginsTree/.test(body), 'the view must render PluginsTree')
  return 'PluginsView kept, tree module wired'
})

check('groups-come-from-the-snapshot', () => {
  assert(/pluginTreeGroups\(\{/.test(groupCall), 'groups must be built by pluginTreeGroups')
  for (const needle of ['rows: snapshot.plugins', 'bundles: snapshot.bundles', 'term,', "ungrouped: t('tree.ungrouped')", 'matches,']) {
    assert(groupCall.includes(needle), 'pluginTreeGroups must receive ' + needle)
  }
  assert(/const term = query\.trim\(\)\.toLowerCase\(\)/.test(body),
    'the term is lowercased once here; the tree compares it against lowercased labels')
  assert(/row\.name\.toLowerCase\(\)\.includes\(term\)/.test(body), 'the term still matches the plugin name')
  assert(/row\.id\.toLowerCase\(\)\.includes\(term\)/.test(body), 'the term still matches the plugin id')
  assert(!/plugin\.bundles/.test(body), 'the view must not request plugin.bundles; the snapshot carries the bundles')
  assert(!/\bfetch\(/.test(body), 'the view must not fetch')
  assert(!/getSnapshot/.test(body), 'the view must not read the snapshot itself')
  assert(!/useEffect/.test(body), 'the view stays free of effects: bundles arrive with the snapshot')
  return 'rows + bundles from snapshot, no request'
})

check('visible-rows-drive-the-toolbar', () => {
  assert(/const visibleRows = groups\.flatMap\(group => group\.rows\)/.test(body),
    'visibleRows must be flattened from the filtered groups')
  assert(/t\('plugins\.count', \{ n: visibleRows\.length \}\)/.test(body),
    'the count badge must count the rows the tree shows, not a second filter')
  assert(/selectableIds\(visibleRows\)/.test(body), 'select-all must use the visible rows')
  assert(/visibleRows\.length === 0 \?/.test(body), 'the filtered-empty state must key off the visible rows')
  assert(/t\('plugins\.emptyFiltered', \{ query \}\)/.test(body), 'the filtered-empty state stays')
  assert(/title=\{t\('plugins\.empty'\)\}/.test(body), 'the no-plugins empty state stays')
  assert(!/const rows = /.test(body), 'the old row-local filter must not come back beside the tree')
  assert(!/rows\.map\(/.test(body), 'the view must not map rows itself; the shared GroupTree does')
  assert((body.match(/visibleRows\.length/g) ?? []).length >= 2, 'the count badge and the empty state both read visibleRows')
  return 'count, select-all and empty state follow the tree'
})

check('tree-render-and-expansion', () => {
  for (const needle of ['groups={groups}', 'lang={lang}', 'term={term}', 'busyKey={bulkGroup}', 'renderRow={renderRow}', 'onBulk={onGroupBulk}']) {
    assert(treeUse.includes(needle), '<PluginsTree must receive ' + needle)
  }
  assert(/const \[bulkGroup, setBulkGroup\] = React\.useState<string \| null>\(null\)/.test(body),
    'the running parent must be tracked so its own switch shows the busy state')
  assert(/setBulkGroup\(null\)/.test(commitBlock), 'a finished batch must clear the parent busy key')
  assert(/setBulkGroup\(group\.key\)/.test(parentBlock), 'a parent batch must mark its own group busy')
  assert(/<Card label=\{t\('plugins\.title'\)\}>/.test(body), 'the tree keeps the shared card')
  assert(/const cancelConfirm = \(\): void => \{[\s\S]*?setConfirming\(null\)[\s\S]*?setBulkGroup\(null\)/.test(body),
    'closing the confirm must clear both the staged dialog and the parent busy key')
  assert(/onClose=\{cancelConfirm\}/.test(body), 'the dialog close path uses the same cancel')
  return 'groups, lang, term, busyKey, renderRow, onBulk, cancel clears the busy mark'
})

check('parent-switch-acts-on-its-own-children', () => {
  assert(/const ids = selectableIds\(group\.rows\)/.test(parentBlock),
    'the parent batch is the manageable children of that group')
  assert(/if \(ids\.length === 0\) return/.test(parentBlock), 'a group with nothing manageable sends nothing')
  assert(/if \(ids\.length > cap\) \{/.test(parentBlock), 'the parent batch is bounded by the snapshot cap')
  assert(/if \(needsConfirm\(ids\.length\)\) \{/.test(parentBlock), 'a large parent batch opens the confirm dialog')
  assert(/setSelected\(ids\)/.test(parentBlock), 'the dialog reads the staged selection')
  assert(/setConfirming\(next\)/.test(parentBlock), 'the dialog opens on the direction the switch asked for')
  assert(/commit\(next, ids\)/.test(parentBlock), 'a small parent batch sends without the dialog')
  assert(/if \(anyBusy\) return/.test(parentBlock), 'a parent switch must not fire while an op runs')
  assert(parentBlock.indexOf('ids.length > cap') < parentBlock.indexOf('commit(next, ids)'),
    'the cap must be checked before anything is sent')
  return 'manageable children, cap, needsConfirm, commit(next, ids)'
})

check('one-bulk-payload', () => {
  assert(/\(enabled: boolean, ids: string\[\] = picked\)/.test(commitBlock),
    'commit must take an explicit batch and default to the selection')
  assert(/runDetailed\(OPS\.bulk, \{ items: bulkItems\(ids\), enabled \}\)/.test(commitBlock),
    'the payload stays { items: bulkItems(ids), enabled }')
  assert(/if \(ids\.length === 0 \|\| ids\.length > cap\) return/.test(commitBlock),
    'an empty or over-cap batch must not be sent')
  assert(!/\{\s*ids\s*:/.test(body), 'the host takes items, not a bare ids array')
  assert(!/kind: 'skill'/.test(body), 'this view only batches plugins')
  const detailed = [...body.matchAll(/\brunDetailed\(OPS\.([A-Za-z0-9_]+)/g)].map(match => match[1])
  assert(detailed.length === 1 && detailed[0] === 'bulk', 'exactly one detailed call, bulk; found ' + detailed.join(', '))
  return 'both entry points send the same payload'
})

check('row-switch-kept', () => {
  assert(/<Switch/.test(renderRowBlock), 'the per-row switch must stay')
  assert(/checked=\{row\.enabled\}/.test(renderRowBlock), 'the row switch must read the row state')
  assert(/label=\{t\('a11y\.switch', \{ name: row\.name \}\)\}/.test(renderRowBlock), 'the row switch keeps its accessible name')
  assert(/run\(OPS\.toggle, \{ kind: 'plugin', id: row\.id, enabled: next \}\)/.test(renderRowBlock),
    'a single row still flips through toggle with { kind: plugin, id, enabled }')
  assert(/aria-label=\{zh \? `选择 \$\{row\.name\}`/.test(renderRowBlock), 'each row checkbox keeps its accessible name')
  return 'Switch -> toggle, checkbox -> selection, unchanged'
})

check('single-write-path', () => {
  for (const pattern of ['fetch(', 'getSnapshot', 'innerHTML', 'dangerouslySetInnerHTML']) {
    assert(body.indexOf(pattern) === -1, 'plugins.tsx uses ' + pattern)
  }
  const reads = [...body.matchAll(/runOp\(\s*(THIRD\.[A-Za-z0-9_]+)/g)].map(match => match[1])
  assert(reads.length === 1 && reads[0] === 'THIRD.status', 'runOp may only read third.status, found ' + reads.join(', '))
  const ops = new Set([...body.matchAll(/\brun\(OPS\.([A-Za-z0-9_]+)/g)].map(match => match[1]))
  assert([...ops].every(op => op === 'bulk' || op === 'toggle'), 'unexpected op(s): ' + [...ops].join(', '))
  const third = new Set([...body.matchAll(/\brun\(THIRD\.([A-Za-z0-9_]+)/g)].map(match => match[1]))
  assert([...third].every(op => op === 'off' || op === 'restore'), 'unexpected third op(s): ' + [...third].join(', '))
  return 'toggle, bulk, third.off, third.restore only'
})

check('import-contract', () => {
  for (const match of body.matchAll(/from '(\.\/[^']+|\.\.\/[^']+)'/g)) {
    assert(/\.js$/.test(match[1]), 'import ' + match[1] + ' needs a .js suffix')
  }
  assert(/from '\.\.\/components\.js'/.test(body), 'the view reuses components.tsx')
  assert(/from '\.\.\/types\.js'/.test(body), 'the view imports its props from types.ts')
  assert(/from '\.\.\/api\.js'/.test(body), 'the view sends ops through the api module')
  return 'all relative imports carry .js'
})

check('file-length', () => {
  const bytes = statSync(VIEW).size
  assert(lineCount <= 450, 'plugins.tsx is ' + lineCount + ' lines (limit 450)')
  assert(bytes < 64 * 1024, 'plugins.tsx is ' + bytes + ' bytes')
  return lineCount + ' lines, ' + bytes + ' bytes'
})

// ── static gates: plugins-tree.tsx ───────────────────────────────────────────

check('helper-region-standalone', () => {
  assert(helpers !== '', 'the exported helper region (tree-helpers) is missing')
  assert(!/\bimport\b/.test(helpers), 'the helper region must stay import-free so it can be executed in isolation')
  assert(!/React\./.test(helpers), 'the helper region must not touch React')
  for (const name of ['manageableRows', 'bundleMembership', 'groupPlugins', 'filterPluginGroups', 'pluginTreeGroups']) {
    assert(new RegExp('export function ' + name + '\\(').test(helpers), 'the region must export ' + name)
  }
  return 'grouping, membership, filtering all executable'
})

check('storage-key-and-force-open', () => {
  assert(/export const PLUGINS_TREE_KEY = 'tool-hub-tree-plugins'/.test(tree),
    'the expansion key must be exactly tool-hub-tree-plugins')
  for (const other of ['tool-hub-tree-tools', 'tool-hub-tree-skills', 'tool-hub-tree-mcp']) {
    assert(tree.indexOf(other) === -1, 'the plugins view must not borrow ' + other)
  }
  assert(/useTreeExpansion\(PLUGINS_TREE_KEY\)/.test(tree), 'expansion must be remembered under the view key')
  assert(/forceOpen=\{term !== ''\}/.test(tree), 'a non-empty search forces every group open')
  assert(/from '\.\/package-tree\.js'/.test(tree), 'the tree reuses the shared package-tree.js')
  assert(/<GroupTree/.test(tree), 'the parent rows are drawn by the shared GroupTree')
  assert(!/useState/.test(tree), 'the tree component carries no state of its own')
  return 'collapsed by default (empty set), remembered, forced open on search'
})

check('tree-has-no-io', () => {
  for (const pattern of ['fetch(', 'runOp(', 'getSnapshot', 'plugin.bundles', 'localStorage.setItem']) {
    assert(tree.indexOf(pattern) === -1, 'plugins-tree.tsx must not use ' + pattern)
  }
  const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(tree)
  assert(match === null, 'a literal colour at char ' + (match === null ? 0 : match.index) + '; the shared classes own colour')
  return 'no IO, no literal colour'
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
  const used = [...body.matchAll(/\bt\('([^']+)'/g), ...tree.matchAll(/\bt\('([^']+)'/g)].map(match => match[1])
  const missing = [...new Set(used)].filter(key => !zh.has(key) || !en.has(key))
  assert(missing.length === 0, 'no catalog defines ' + missing.join(', '))
  assert(zh.has('tree.ungrouped'), 'tree.ungrouped must exist: the tree names the leftover group')
  return used.length + ' calls, ' + new Set(used).size + ' distinct keys, all defined twice'
})

// ── runtime: the exported helpers, bundled and executed ──────────────────────

let api = null
try {
  const bundled = await build({
    stdin: { contents: helpers, loader: 'ts', resolveDir: ROOT, sourcefile: 'plugins-tree-helpers.ts' },
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

/**
 * The real normaliser, so the grouping is checked against what the panel actually receives:
 * api.ts drops unknown fields, so a field renamed there would silently empty every group.
 */
let snapshotApi = null
try {
  const bundled = await build({
    stdin: { contents: "export { normalizeSnapshot } from './src/client/api.ts'", loader: 'ts', resolveDir: ROOT, sourcefile: 'snapshot-contract.ts' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })
  const text = bundled.outputFiles?.[0]?.text ?? ''
  assert(text !== '', 'esbuild produced no bundle for api.ts')
  snapshotApi = await import('data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64'))
} catch (error) {
  failed += 1
  failedNames.push('snapshot-normaliser-bundle')
  console.log('FAIL snapshot-normaliser-bundle -- ' + (error instanceof Error ? error.message : String(error)))
}

function needSnapshot() {
  assert(snapshotApi !== null, 'api.ts did not compile')
  return snapshotApi
}

const plugin = (id, enabled, manageable) => ({ id, name: id.toUpperCase(), enabled, ...(manageable === undefined ? {} : { manageable }) })
const bundle = (name, version, rows) => ({ name, version, enabled: true, official: false, rows })

/** A comparable picture of the groups: key, label, meta, child ids, then the three switch facts. */
const shape = groups => groups.map(group => [group.key, group.label, group.meta ?? null, group.rows.map(row => row.id).join('|'), group.enabled, group.switchable ?? null, group.allEnabled ?? null])
/** Compare built groups against a fixture written in shape() form, never shape() the fixture. */
const same = (groups, expected) => JSON.stringify(shape(groups)) === JSON.stringify(expected)
const clone = value => JSON.parse(JSON.stringify(value))

check('runtime-manageable', () => {
  const mod = need()
  const rows = [plugin('a', true, true), plugin('b', true, false), plugin('c', true)]
  assert(JSON.stringify(mod.manageableRows(rows).map(row => row.id)) === '["a","c"]',
    'read-only rows must not join a parent batch, got ' + JSON.stringify(mod.manageableRows(rows).map(row => row.id)))
  assert(JSON.stringify(mod.manageableRows([])) === '[]', 'no rows means nothing manageable')
  const before = JSON.stringify(rows)
  mod.manageableRows(rows)
  assert(JSON.stringify(rows) === before, 'manageableRows must not mutate its input')
  return 'manageable undefined counts as writable, false does not'
})

check('runtime-membership-first-wins', () => {
  const mod = need()
  const membership = mod.bundleMembership([bundle('b1', '1.0.0', ['x', 'y']), bundle('b2', '2.0.0', ['y', 'z'])])
  assert(membership.get('x') === 0, 'x belongs to the first bundle')
  assert(membership.get('y') === 0, 'a shared id stays with the first bundle that names it')
  assert(membership.get('z') === 1, 'z belongs to the second bundle')
  assert(membership.get('nope') === undefined, 'an unlisted id has no owner')
  return 'first bundle wins, unlisted ids have no owner'
})

check('runtime-grouping', () => {
  const mod = need()
  const rows = [plugin('a', true), plugin('b', false), plugin('loose', true), plugin('c', true)]
  const groups = mod.groupPlugins(rows, [bundle('zeta', '2.0.0', ['b', 'c']), bundle('alpha', '1.0.0', ['a']), bundle('empty', '9.9.9', ['ghost'])], '未分组')
  assert(same(groups, [
    ['bundle:alpha', 'alpha', '1.0.0', 'a', 1, true, true],
    ['bundle:zeta', 'zeta', '2.0.0', 'b|c', 1, true, false],
    ['ungrouped', '未分组', null, 'loose', 1, true, true],
  ]), 'bundle order, meta, counts and the ungrouped tail are wrong: ' + JSON.stringify(shape(groups)))
  assert(groups[groups.length - 1].label === '未分组', 'the ungrouped group must be last')
  const noVersion = mod.groupPlugins([plugin('a', true)], [bundle('alpha', undefined, ['a'])], 'x')
  assert(noVersion[0].meta === undefined, 'a bundle without a version must not invent a meta line')
  const noLoose = mod.groupPlugins([plugin('a', true)], [bundle('alpha', '1', ['a'])], '未分组')
  assert(noLoose.every(group => group.label !== '未分组'), 'an empty ungrouped group must not be rendered')
  return 'alpha, zeta, ungrouped; empty bundle dropped'
})

check('runtime-duplicate-rows-collapse', () => {
  const mod = need()
  const groups = mod.groupPlugins([plugin('a', true), plugin('a', false)], [bundle('alpha', '1', ['a'])], 'x')
  assert(groups.length === 1 && groups[0].rows.length === 1, 'a repeated row id must render once')
  assert(groups[0].rows[0].enabled === true, 'the first occurrence of a row id wins')
  return 'one row per id'
})

check('runtime-parent-switch-facts', () => {
  const mod = need()
  const all = mod.groupPlugins([plugin('a', true, true), plugin('b', true, true), plugin('ro', false, false)], [bundle('one', '1', ['a', 'b', 'ro'])], 'x')
  assert(all[0].switchable === true && all[0].allEnabled === true, 'all manageable children on -> switch on')
  assert(all[0].enabled === 2, 'the enabled count includes the read-only row, got ' + all[0].enabled)
  const half = mod.groupPlugins([plugin('a', true, true), plugin('b', false, true)], [bundle('one', '1', ['a', 'b'])], 'x')
  assert(half[0].switchable === true && half[0].allEnabled === false, 'one manageable child off means the switch reads off')
  const readOnly = mod.groupPlugins([plugin('ro1', true, false), plugin('ro2', false, false)], [bundle('one', '1', ['ro1', 'ro2'])], 'x')
  assert(readOnly[0].switchable === false, 'a group of read-only rows must not be switchable')
  assert(readOnly[0].allEnabled === false, 'an unswitchable group must never claim all-enabled')
  const vacuous = mod.groupPlugins([plugin('ro', true, false), plugin('on', true, true)], [bundle('one', '1', ['ro', 'on'])], 'x')
  assert(vacuous[0].allEnabled === true, 'a read-only row must not block all-enabled when every manageable child is on')
  return 'switchable and allEnabled follow the manageable children only'
})

check('runtime-filter-children', () => {
  const mod = need()
  const rows = [plugin('alpha-on', true, true), plugin('alpha-off', false, true), plugin('beta-on', true, true)]
  const groups = mod.groupPlugins(rows, [bundle('alpha', '1', ['alpha-on', 'alpha-off']), bundle('beta', '2', ['beta-on'])], 'x')
  const term = 'beta'
  const matches = row => row.name.toLowerCase().includes(term)
  const filtered = mod.filterPluginGroups(groups, term, matches)
  assert(filtered.length === 1 && filtered[0].label === 'beta', 'only the matching group survives, got ' + JSON.stringify(shape(filtered)))
  assert(filtered[0].enabled === 1 && filtered[0].switchable === true, 'a filtered group reports its visible rows')
  const partial = mod.filterPluginGroups(groups, 'needle', row => row.id === 'alpha-on')
  assert(partial.length === 1 && partial[0].rows.length === 1, 'children are filtered by the row matcher, got ' + JSON.stringify(shape(partial)))
  assert(partial[0].rows[0].id === 'alpha-on', 'the surviving child is the one that matched')
  assert(partial[0].enabled === 1 && partial[0].allEnabled === true, 'the filtered group recomputes its counts')
  const offOnly = mod.filterPluginGroups(groups, 'needle', row => row.id === 'alpha-off')
  assert(offOnly[0].enabled === 0 && offOnly[0].allEnabled === false, 'a group left with only off rows reads off')
  return 'groups dropped when empty, counts recomputed on what is visible'
})

check('runtime-filter-parent-label-keeps-children', () => {
  const mod = need()
  const rows = [plugin('a1', true), plugin('a2', false)]
  const groups = mod.groupPlugins(rows, [bundle('mcp', '3.1.0', ['a1', 'a2'])], 'x')
  const filtered = mod.filterPluginGroups(groups, 'mcp', () => false)
  assert(filtered.length === 1 && filtered[0].rows.length === 2,
    'a parent label match must keep every child, got ' + JSON.stringify(shape(filtered)))
  assert(filtered[0].enabled === 1 && filtered[0].allEnabled === false, 'the unfiltered counts must survive a label match')
  const partialLabel = mod.filterPluginGroups(groups, 'mc', () => false)
  assert(partialLabel.length === 1 && partialLabel[0].rows.length === 2, 'a prefix of the label still keeps every child')
  return 'label match keeps all children; labels compare lowercased against the lowercased term'
})

check('runtime-filter-empty-term-is-identity', () => {
  const mod = need()
  const groups = mod.groupPlugins([plugin('a', true)], [bundle('alpha', '1', ['a'])], 'x')
  const sameArray = mod.filterPluginGroups(groups, '', () => false)
  assert(sameArray === groups, 'an empty term must return the same array, not a rebuilt copy')
  return 'no search -> untouched groups'
})

check('runtime-composed', () => {
  const mod = need()
  const rows = [plugin('a', true, true), plugin('loose1', false, true), plugin('loose2', true, false)]
  const bundles = [bundle('beta', '2', ['a'])]
  const matches = row => row.id.startsWith('loose')
  const composed = mod.pluginTreeGroups({ rows, bundles, term: 'loose', ungrouped: '未分组', matches })
  assert(composed.length === 1 && composed[0].key === 'ungrouped', 'only the leftover group matches, got ' + JSON.stringify(shape(composed)))
  assert(composed[0].rows.length === 2, 'both leftover rows match the term')
  assert(composed[0].switchable === true && composed[0].allEnabled === false, 'the leftover group reports its own rows')
  const unfiltered = mod.pluginTreeGroups({ rows, bundles, term: '', ungrouped: '未分组', matches })
  assert(same(unfiltered, [
    ['bundle:beta', 'beta', '2', 'a', 1, true, true],
    ['ungrouped', '未分组', null, 'loose1|loose2', 1, true, false],
  ]), 'the composed helper must equal grouping plus filtering, got ' + JSON.stringify(shape(unfiltered)))
  const clash = mod.pluginTreeGroups({ rows, bundles: [bundle('x', '1', ['a']), bundle('x', '2', [])], term: '', ungrouped: 'x', matches })
  assert(new Set(clash.map(group => group.key)).size === clash.length, 'group keys must stay unique even when names collide')
  return 'group + filter compose, keys unique'
})

check('runtime-snapshot-contract', () => {
  const mod = need()
  const normalise = needSnapshot().normalizeSnapshot
  const raw = {
    plugins: [
      { id: 'p1', name: 'P1', enabled: true, manageable: true },
      { id: 'p2', name: 'P2', enabled: false, manageable: true },
      { id: 'p3', name: 'P3', enabled: true, manageable: false, readOnlyReason: 'read-only' },
    ],
    bundles: [{ name: 'alpha', version: '1.2.3', enabled: true, official: true, rows: ['p1', 'p2'] }],
  }
  const snapshot = normalise(raw)
  assert(Array.isArray(snapshot.bundles) && snapshot.bundles.length === 1, 'normalizeSnapshot must carry the bundles through')
  const groups = mod.pluginTreeGroups({ rows: snapshot.plugins, bundles: snapshot.bundles, term: '', ungrouped: '未分组', matches: () => true })
  assert(same(groups, [
    ['bundle:alpha', 'alpha', '1.2.3', 'p1|p2', 1, true, false],
    ['ungrouped', '未分组', null, 'p3', 1, false, false],
  ]), 'the normalised snapshot must drive the tree: ' + JSON.stringify(shape(groups)))
  const plain = normalise({ plugins: [{ id: 'lonely', name: 'Lonely', enabled: true }] })
  assert(plain.bundles.length === 0, 'an older host without bundles normalises to an empty list')
  const fallback = mod.pluginTreeGroups({ rows: plain.plugins, bundles: plain.bundles, term: '', ungrouped: '未分组', matches: () => true })
  assert(same(fallback, [['ungrouped', '未分组', null, 'lonely', 1, true, true]]),
    'a host without bundles must render one ungrouped group, not nothing: ' + JSON.stringify(shape(fallback)))
  return 'api.ts -> snapshot.bundles -> groups, older host falls back to one group'
})

check('runtime-purity', () => {
  const mod = need()
  const rows = [plugin('a', true), plugin('b', false)]
  const bundles = [bundle('alpha', '1', ['a', 'b'])]
  const beforeRows = clone(rows)
  const beforeBundles = clone(bundles)
  mod.pluginTreeGroups({ rows, bundles, term: 'a', ungrouped: 'x', matches: row => row.id === 'a' })
  assert(JSON.stringify(rows) === JSON.stringify(beforeRows), 'grouping must not mutate the rows')
  assert(JSON.stringify(bundles) === JSON.stringify(beforeBundles), 'grouping must not mutate the bundles')
  return 'inputs untouched'
})

// ── report ───────────────────────────────────────────────────────────────────

const total = passed + failed
console.log(passed + '/' + total + ' checks passed')
if (failed > 0) {
  console.log('failed: ' + failedNames.join(', '))
  process.exit(1)
}
