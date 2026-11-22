#!/usr/bin/env node
/**
 * probe/next/client-extensions.mjs — the extensions view (task-23), checked from outside.
 *
 * Static gates only: the probe reads the view, the shell and the catalogs, and asserts the
 * properties the page must keep. No host, no browser, no writes.
 *
 * Coverage:
 *   1. the exported view exists, the scaffold is gone and the shell mounts it once;
 *   2. the panel's two ops live in one constant, and no extension op is ever spelled inline;
 *   3. the hot switch sends extension.set with the row id and the next state, nothing else;
 *   4. reload sends extension.reload with the row id, and busy keys follow the shell's "$op:$id";
 *   5. the toolbar refresh calls reload(), not a write;
 *   6. the status row carries name, id, version, folder, enabled and a loaded/failed badge;
 *   7. a host error is shown verbatim in a Callout, not swallowed;
 *   8. every declared view renders a Read button that calls runOp(view.op, {}) with the view's op;
 *   9. the read brackets its own loading flag, keeps a failure, and guards the unmount case;
 *  10. the table helper accepts a record array, a { rows } wrapper and positional rows;
 *  11. the table renders a real <table> with scope="col" headers and a hidden caption;
 *  12. the list renders rows, and json renders a pretty-printed box;
 *  13. an empty payload or an empty array lands on extensions.viewEmpty, a wrong shape on json;
 *  14. the console chooses an op from entry.ops and shows whether that op writes;
 *  15. the console's payload box is labelled, its bad JSON is refused before any send, and Run
 *      stays disabled while the payload does not parse;
 *  16. a write op opens a Dialog first, and the payload only leaves with confirm:true;
 *  17. cancel and close never send, and the dialog closes before the op is sent;
 *  18. the console goes through runDetailed and renders the host's answer, keeping a failure;
 *  19. nothing is sent on mount;
 *  20. every control carries an accessible name, and no raw button lives here;
 *  21. layout comes from th-* classes and every colour is a theme token;
 *  22. no HTML injection, no TODO marker, no import outside the client modules, and the file
 *      stays inside the view budget;
 *  23. every t() key resolves in both catalogs, and the extensions catalogs agree;
 *  24. the source filter is one exported pure rule: all / bundled / local, a missing bundled
 *      flag is local, snapshot order is kept and the input is never mutated;
 *  25. the toolbar renders that rule as one radio group with per-source counts, defaulting to
 *      all, and labels the group in the page's language;
 *  26. the cards render the filtered rows, an empty source has its own state, and the bundled
 *      badge stays on every bundled card;
 *  27. a local copy over a bundled pack carries the 本地覆盖 badge in the page's language, and only
 *      a bundled row without a local copy offers 复制到本地;
 *  28. that copy action confirms first, sends extension.installBundled with the row id through the
 *      shell's write path, and the shell reloads the snapshot afterwards;
 *  29. the 官方配套 card sits above the list, lists only official packs (a bundled row or the local
 *      copy shadowing one) and shows both versions, the origin status and the row's controls;
 *  30. install is offered for a bundled row with no local copy, update exactly while the local copy
 *      is behind bundledVersion, and the switch sends extension.set with the next state;
 *  31. the update confirmation names the backup folder and the overwrite, and the batch button
 *      computes the pending actions, confirms once with the count and runs them one at a time,
 *      keeping a per-action failure;
 *  32. the card never acts on mount, its copy is bilingual local text, and it adds no catalog key;
 *  33. compat-manager.tsx stays inside the allowed imports, themed styles and the view budget.
 *
 * The source rules are transpiled with the esbuild devDependency and imported against stubs, so
 * checks 24-26 are measured on a fixture instead of matched as text. PASS/FAIL lines, exit 1
 * when anything fails.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = join(ROOT, 'src', 'client', 'views', 'extensions.tsx')
const COMPAT = join(ROOT, 'src', 'client', 'views', 'compat-manager.tsx')
const SHELL = join(ROOT, 'src', 'client', 'shell.tsx')
const I18N = join(ROOT, 'src', 'client', 'i18n.ts')

let passed = 0
const failures = []

function check(name, run) {
  try {
    const detail = run()
    passed += 1
    console.log('PASS ' + name + (detail === undefined || detail === '' ? '' : ' (' + detail + ')'))
  } catch (error) {
    failures.push(name)
    console.log('FAIL ' + name + ' -- ' + (error instanceof Error ? error.message : String(error)))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const read = file => readFileSync(file, 'utf8')
const rel = file => relative(ROOT, file).split('\\').join('/')
const lineAt = (text, index) => text.slice(0, index).split('\n').length
/** Source with block comments and whole-line comments removed. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')

const source = read(VIEW)
const body = code(source)
const compatSource = read(COMPAT)
const compatBody = code(compatSource)
const shell = read(SHELL)
const i18nSource = read(I18N)

// ── the pure source filter, transpiled and run ──────────────────────────────
// esbuild is already a devDependency (the tools probe uses it). React and the view's runtime
// imports are stubbed, so the filter rules are measured on a fixture, not matched as text.

const STUBS = {
  'react.stub.mjs': [
    'export const createElement = () => null',
    'export const useState = () => [undefined, () => {}]',
    'export const useEffect = () => {}',
    'export const useRef = value => ({ current: value })',
    'export default { createElement, useState, useEffect, useRef }',
  ].join('\n'),
  'api.stub.mjs': 'export const runOp = async () => ({ ok: true, data: null })\n',
  'components.stub.mjs': [
    'export const Badge = () => null',
    'export const Button = () => null',
    'export const Callout = () => null',
    'export const Card = () => null',
    'export const Dialog = () => null',
    'export const Empty = () => null',
    'export const Field = () => null',
    'export const Select = () => null',
    'export const Switch = () => null',
    'export const Toolbar = () => null',
    'export const monoStyle = {}',
  ].join('\n') + '\n',
  'theme.stub.mjs': [
    'export const FONT = { xs: 11 }',
    'export const R = { sm: 6, md: 10 }',
    'export const SP = { xs: 4, sm: 8, md: 10, lg: 16 }',
    'export const T = { borderSoft: "", text2: "", text3: "", surface: "" }',
  ].join('\n') + '\n',
}

/** The view's runtime imports, pointed at the stub siblings written beside it. */
const SPECIFIERS = [
  ['react', './react.stub.mjs'],
  ['../api.js', './api.stub.mjs'],
  ['../components.js', './components.stub.mjs'],
  ['../theme.js', './theme.stub.mjs'],
]

function rewrite(text) {
  let out = text
  for (const [from, to] of SPECIFIERS) {
    out = out.split('from "' + from + '"').join('from "' + to + '"')
    out = out.split("from '" + from + "'").join('from "' + to + '"')
  }
  return out
}

let viewModule = null
let compatModule = null
let viewModuleError = null
try {
  const dir = mkdtempSync(join(tmpdir(), 'tool-hub-ext-'))
  try {
    for (const [name, text] of Object.entries(STUBS)) writeFileSync(join(dir, name), text)
    const compile = file => rewrite(transformSync(read(file), { loader: 'tsx', format: 'esm', target: 'node20', jsx: 'transform' }).code)
    // The card is written beside its importer and under the name the import spells, so
    // extensions.tsx's './compat-manager.js' resolves to the real transpiled module instead of a
    // stub: the card's rules are measured, not matched. The marker makes .js an ES module here.
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n')
    writeFileSync(join(dir, 'compat-manager.js'), compile(COMPAT))
    writeFileSync(join(dir, 'extensions.mjs'), compile(VIEW))
    compatModule = await import(pathToFileURL(join(dir, 'compat-manager.js')).href)
    viewModule = await import(pathToFileURL(join(dir, 'extensions.mjs')).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
} catch (error) {
  viewModuleError = error instanceof Error ? error : new Error(String(error))
}

function requireView() {
  assert(viewModuleError === null, 'the view module did not load: ' + (viewModuleError === null ? '' : viewModuleError.message))
  return viewModule
}

function requireCompat() {
  assert(viewModuleError === null, 'the compat module did not load: ' + (viewModuleError === null ? '' : viewModuleError.message))
  return compatModule
}

/** Rows as the snapshot reports them: two bundled, one local without the flag, one local false. */
const SOURCE_ROWS = [
  { id: 'bundled-a', bundled: true },
  { id: 'local-a', bundled: false },
  { id: 'legacy-no-flag' },
  { id: 'bundled-b', bundled: true },
]

const count = needle => body.split(needle).length - 1

/** One function body between two anchors, used to prove a handler does or does not send. */
function section(start, end) {
  const at = body.indexOf(start)
  assert(at !== -1, 'missing "' + start + '" in ' + rel(VIEW))
  const to = body.indexOf(end, at + start.length)
  assert(to !== -1, 'missing "' + end + '" after "' + start + '"')
  return body.slice(at, to)
}

/** True when a state value reaches a Callout somewhere in the view. */
function reachesCallout(name) {
  return body.indexOf(name) !== -1 && new RegExp('<Callout>\\{' + name + '\\}</Callout>').test(body)
}

// ── the view exists and is mounted ──────────────────────────────────────────

check('view-export', () => {
  assert(/export function ExtensionsView\(props: ViewProps\): React\.ReactElement/.test(source), 'extensions.tsx must export ExtensionsView(props: ViewProps)')
  assert((source.match(/export function ExtensionsView/g) ?? []).length === 1, 'ExtensionsView must be exported exactly once')
  assert(/import \* as React from 'react'/.test(source), 'the view must import React')
  assert(/import type \{[^}]*\bViewProps\b[^}]*\} from '\.\.\/types\.js'/.test(source), 'ViewProps must come from ../types.js')
  // The scaffold rendered one Empty and nothing else; the real page renders the list.
  assert(!/<Empty title=\{props\.t\('extensions\.empty'\)\}/.test(source), 'the scaffold Empty return is still there')
  assert(body.includes("<Empty title={t('extensions.empty')} hint={t('extensions.enableHint')} />"), 'an installation with no extension needs the empty state')
  assert(body.includes('<Card label={name}>'), 'each extension must render a Card named by its own title')
  assert(body.includes('key={entry.id}'), 'the extension cards must be keyed by id')
  return 'ExtensionsView exported once, scaffold replaced, cards per extension'
})

check('shell-wiring', () => {
  assert(/import \{ ExtensionsView \} from '\.\/views\/extensions\.js'/.test(shell), 'the shell must import ExtensionsView from ./views/extensions.js')
  assert(/extensions: <ExtensionsView snapshot=\{snapshot\}/.test(shell), 'the shell must mount ExtensionsView with the snapshot')
  const entries = (shell.match(/id: 'extensions'/g) ?? []).length
  assert(entries === 1, 'exactly one nav entry may carry id extensions, found ' + entries)
  assert(shell.includes("'nav.extensions'"), 'the nav entry needs its label key')
  assert(/extensions: snapshot === null \? 0 : snapshot\.extensions\.filter\(entry => entry\.enabled\)\.length/.test(shell), 'the nav count must be the enabled extensions')
  return 'one nav entry, one mount, count = enabled extensions'
})

// ── the panel's own two ops ────────────────────────────────────────────────

check('op-constants', () => {
  assert(/export const EXT = \{ set: 'extension\.set', reload: 'extension\.reload', installBundled: 'extension\.installBundled' \} as const/.test(body), 'every panel op must live in one constant')
  assert((body.match(/['"]extension\./g) ?? []).length === 3, 'an extension op is spelled outside the constant')
  assert(count('runOp(') === 1, 'the view may read through runOp exactly once, found ' + count('runOp('))
  assert(body.includes('runOp(view.op, {})'), 'a view read must send the declared op, not a hardcoded one')
  assert(count('void run(') === 3, 'only the three panel writes may go through run, found ' + count('void run('))
  assert(count('runDetailed(') === 1, 'the console must have one send site, found ' + count('runDetailed('))
  return 'EXT constant, one runOp site, three run sites, one runDetailed site'
})

check('hot-toggle', () => {
  assert(body.includes('checked={entry.enabled}'), 'the switch must follow the host state')
  assert(body.includes('void run(EXT.set, { id: entry.id, enabled: next })'), 'the switch must send { id, enabled }')
  assert(body.includes("const toggleKey = EXT.set + ':' + entry.id"), 'the busy key must follow the shell convention')
  assert(body.includes('busy={toggleBusy}'), 'the switch must report its own busy state')
  assert(body.includes("label={t('a11y.switch', { name })}"), 'the switch needs an accessible name')
  const toggle = section('const toggleKey', 'const anyBusy')
  assert(!/setAsking|setPending/.test(toggle), 'the hot switch must not open the console dialog')
  return 'extension.set, shell busy key, accessible name, no dialog'
})

check('reload-code', () => {
  assert(body.includes('void run(EXT.reload, { id: entry.id })'), 'reload must send the row id')
  assert(body.includes("const reloadKey = EXT.reload + ':' + entry.id"), 'reload needs its own busy key')
  assert(body.includes('busy={reloadBusy}'), 'the reload button must report its own busy state')
  assert(body.includes("{t('extensions.reload')}"), 'the reload button needs its label')
  return 'extension.reload with the id, own busy flag'
})

check('list-refresh', () => {
  assert(body.includes('const { snapshot, lang, t, busy, run, runDetailed, reload } = props'), 'the view must take reload from its props')
  assert(body.includes('void reload()'), 'the toolbar must refresh through reload()')
  assert(body.includes("{t('action.retry')}"), 'the refresh control needs a label')
  assert((body.match(/void reload\(\)/g) ?? []).length === 1, 'one refresh site only')
  return 'reload() from the toolbar, one site'
})

// ── the status row ─────────────────────────────────────────────────────────

check('status-row', () => {
  assert(body.includes('const name = nameOf(entry, lang)'), 'the row title must respect the language')
  assert(body.includes('{name}') && body.includes('<span className="th-mono">{entry.id}</span>'), 'the row must show the id beside the name')
  assert(body.includes("{t('extensions.version') + ' ' + entry.version}"), 'the row must show the version')
  assert(body.includes('title={t(\'extensions.dir\')}'), 'the folder must be labelled as the folder')
  assert(body.includes("{entry.enabled ? t('extensions.enabled') : t('extensions.disabled')}"), 'the row must show the enabled state')
  assert(body.includes('{statusBadge(entry, t)}'), 'the row must show the load state')
  const badge = section('function statusBadge(', 'interface ReadState')
  assert(badge.includes("if (entry.error !== null) return <Badge tone=\"danger\">{t('extensions.failed')}</Badge>"), 'an error must win over loaded')
  assert(badge.includes("if (entry.loaded) return <Badge tone=\"on\">{t('extensions.loaded')}</Badge>"), 'a loaded extension must say loaded')
  assert(badge.includes("if (entry.enabled) return <Badge tone=\"warn\">{t('extensions.failed')}</Badge>"), 'enabled but not loaded is a failure, not a blank')
  return 'name, id, version, folder, enabled, load badge'
})

check('host-error', () => {
  assert(body.includes("<Callout>{entry.error}</Callout>"), 'a host error must be shown verbatim')
  assert(reachesCallout('entry.error'), 'the error must reach a Callout')
  assert(body.includes("{t('extensions.hot')}") && body.includes("{t('extensions.local')}"), 'the hot-reload and trusted-code notes must be on the page')
  return 'error in a Callout, both hints present'
})

// ── declared views ─────────────────────────────────────────────────────────

check('declared-views', () => {
  assert(body.includes('{entry.views.map(view => {'), 'the page must render every declared view')
  assert(body.includes("{t('extensions.viewLoad')}"), 'each view needs its Read label')
  assert(body.includes('readView(view)'), 'the Read button must call the read handler')
  assert(body.includes("<Badge>{view.kind}</Badge>") && body.includes('<span className="th-mono">{view.op}</span>'), 'each view must show its kind and op')
  assert(body.includes('{t(\'extensions.views\')}'), 'the views section needs its title')
  const read = section('const readView = (view: ExtensionViewRow): void => {', 'const send = (')
  assert(read.includes('runOp(view.op, {})'), 'the read must go through runOp with the view op')
  assert(!/\brun\(/.test(read), 'a read must never travel through the write helper')
  assert(!/runDetailed/.test(read), 'a read must not use the write helper that reloads the snapshot')
  return 'per-view Read, runOp(view.op), kind and op shown'
})

check('read-states', () => {
  const read = section('const readView = (view: ExtensionViewRow): void => {', 'const send = (')
  const start = read.indexOf('{ loading: true }')
  const sendAt = read.indexOf('runOp(view.op')
  const settle = read.indexOf('loading: false')
  assert(start !== -1 && sendAt !== -1 && settle !== -1 && start < sendAt && sendAt < settle, 'busy must bracket the read')
  assert(read.includes('{ loading: false, data: answer.data }'), 'a successful read must keep the payload')
  assert(read.includes('{ loading: false, error: answer.message }'), 'a failed read must keep the host message')
  assert(read.includes('if (!alive.current) return'), 'a read must not set state after unmount')
  assert(body.includes('{state === undefined || state.loading ? null : state.error !== undefined ? ('), 'a pending read must not render a stale body')
  assert(body.includes('<Callout>{state.error}</Callout>'), 'a failed read must reach a Callout')
  return 'loading bracketed, data kept, failure kept, unmount guarded'
})

// ── renderers ──────────────────────────────────────────────────────────────

check('table-helper', () => {
  assert(body.includes('export function tableData('), 'the table shape needs one narrowing helper')
  assert(body.includes('if (Array.isArray(value)) return value'), 'a bare array of records must be accepted')
  assert(body.includes('if (Array.isArray(value.rows)) return value.rows'), 'the { rows } wrapper must be accepted')
  assert(body.includes('if (Array.isArray(value.items)) return value.items'), 'the { items } wrapper must be accepted')
  assert(body.includes('for (const key of Object.keys(entry)) if (!keys.includes(key)) keys.push(key)'), 'columns must be the union of record keys in first-seen order')
  assert(body.includes('function positionalNames('), 'positional rows need generated headers')
  const helper = section('export function tableData(', 'export interface ListItem')
  for (const key of ['declared', 'keys', 'cellText']) assert(helper.includes(key), 'tableData never uses ' + key)
  return 'record array, rows/items wrapper, positional rows, union columns'
})

check('table-render', () => {
  assert(body.includes('<table style={TABLE}>'), 'the table kind must render a real table')
  assert(body.includes('<caption className="th-visually-hidden">{props.label}</caption>'), 'the table needs a hidden caption for screen readers')
  assert(body.includes('<th key={index} scope="col" style={TH}>'), 'header cells need scope=col')
  assert(body.includes('for (const column of columns) row.push(cellText(entry[column]))'), 'cells must go through the one stringifier')
  assert(body.includes('<td key={cellIndex} style={TD}>'), 'body cells must be table cells')
  assert(body.includes('...monoStyle'), 'the boxes must take their look from the themed token')
  assert(body.includes('style={TABLE}') && body.includes('style={SCROLL}'), 'the table takes its look from the style constants')
  return 'real table, scoped headers, hidden caption, one stringifier'
})

check('list-render', () => {
  assert(body.includes('export function listItems('), 'the list shape needs one narrowing helper')
  assert(body.includes('<ul className="th-list">'), 'the list must be a ul')
  assert(body.includes('<li className="th-row" key={index}>'), 'each list item must be a row')
  assert(body.includes("{item.detail === '' ? null : <span className=\"th-row-meta\">{item.detail}</span>}"), 'a list item must show its remaining fields')
  assert(body.includes('items.push({ label: key, detail: cellText(entry) })'), 'a record payload must list its fields')
  return 'ul/li rows, detail line, record payload as fields'
})

check('json-render', () => {
  assert(body.includes('export function jsonText('), 'the JSON box needs one formatter')
  assert(body.includes('JSON.stringify(value, null, 2)'), 'the JSON box must be pretty-printed')
  assert(count('<pre style={BOX}') === 3, 'expected three JSON boxes (view, result, dialog), found ' + count('<pre style={BOX}'))
  assert(body.includes('function JsonBox('), 'the JSON box must be one component')
  return 'pretty JSON, three boxes, one component'
})

check('empty-view', () => {
  assert(body.includes('{t(\'extensions.viewEmpty\')}'), 'an empty answer needs its empty state')
  assert(body.includes('if (table === null) return <JsonBox value={data} label={label} />'), 'a non-tabular payload must fall back to json')
  assert(body.includes('if (table.rows.length === 0) return <Empty title={t(\'extensions.viewEmpty\')} />'), 'an empty table is an empty state, not a json dump')
  assert(body.includes('if (items.length === 0) return <Empty title={t(\'extensions.viewEmpty\')} />'), 'an empty list is an empty state')
  assert(body.includes('if (data === null || data === undefined) return <Empty title={t(\'extensions.viewEmpty\')} />'), 'a null payload needs the empty state')
  return 'empty => viewEmpty, wrong shape => json'
})

// ── the source filter ─────────────────────────────────────────────────────

check('source-module', () => {
  const api = requireView()
  for (const name of ['EXTENSION_SOURCES', 'extensionSourceOf', 'filterExtensions', 'extensionSourceCounts',
    'sourceLabel', 'sourceHeading', 'sourceEmptyLabel']) {
    assert(api[name] !== undefined, 'extensions.tsx does not export ' + name)
  }
  assert(api.EXTENSION_SOURCES.join(',') === 'all,bundled,local', 'the chips must be all, bundled, local in that order')
  return 'esbuild transpile + stub import, seven source exports'
})

check('source-runtime', () => {
  const api = requireView()
  const rows = SOURCE_ROWS.map(row => ({ ...row }))
  const before = JSON.stringify(rows)
  const all = api.filterExtensions(rows, 'all')
  assert(all.length === 4, 'all must keep every row')
  assert(all !== rows, 'all must return a new array')
  assert(all.map(row => row.id).join(',') === 'bundled-a,local-a,legacy-no-flag,bundled-b', 'all must keep snapshot order')
  assert(api.filterExtensions(rows, 'bundled').map(row => row.id).join(',') === 'bundled-a,bundled-b', 'bundled must keep only bundled rows')
  assert(api.filterExtensions(rows, 'local').map(row => row.id).join(',') === 'local-a,legacy-no-flag', 'local must keep rows without the bundled flag')
  assert(JSON.stringify(rows) === before, 'filtering must not mutate the snapshot')
  assert(api.extensionSourceOf({ bundled: true }) === 'bundled', 'bundled:true is the bundled source')
  assert(api.extensionSourceOf({ bundled: false }) === 'local', 'bundled:false is local')
  assert(api.extensionSourceOf({}) === 'local', 'a missing flag is local')
  const counts = api.extensionSourceCounts(rows)
  assert(counts.all === 4 && counts.bundled === 2 && counts.local === 2, 'counts must add up: ' + JSON.stringify(counts))
  const empty = api.extensionSourceCounts([])
  assert(empty.all === 0 && empty.bundled === 0 && empty.local === 0, 'an empty snapshot counts zero')
  return 'all/bundled/local, missing flag local, order kept, no mutation, counts'
})

check('source-labels', () => {
  const api = requireView()
  const t = key => key
  assert(api.sourceLabel('all', 'zh', t) === '全部', 'zh all label')
  assert(api.sourceLabel('all', 'en', t) === 'All', 'en all label')
  assert(api.sourceLabel('local', 'zh', t) === '本地', 'zh local label')
  assert(api.sourceLabel('local', 'en', t) === 'Local', 'en local label')
  assert(api.sourceLabel('bundled', 'zh', t) === 'extensions.bundled', 'the bundled chip must reuse the catalog key, not add copy')
  assert(api.sourceHeading('zh') !== api.sourceHeading('en'), 'the radio group needs a name in both languages')
  assert(api.sourceEmptyLabel('zh') !== api.sourceEmptyLabel('en'), 'the filtered empty state needs copy in both languages')
  return 'bilingual local copy, bundled reuses extensions.bundled'
})

check('source-toolbar', () => {
  assert(body.includes("const [source, setSource] = React.useState<ExtensionSource>('all')"), 'the filter must default to all')
  assert(body.includes('role="radiogroup"'), 'the chips must be one radio group')
  assert(body.includes('aria-label={sourceHeading(lang)}'), 'the radio group needs an accessible name')
  assert(body.includes('{EXTENSION_SOURCES.map(item => {'), 'the chips must follow the exported order')
  assert((body.match(/type="radio"/g) ?? []).length === 1, 'one radio declaration inside the map')
  assert(body.includes("className={'th-btn' + (active ? ' th-btn--primary' : ' th-btn--ghost')}"), 'the active chip must take the primary style')
  assert(body.includes('checked={active}'), 'a chip must follow the chosen source')
  assert(body.includes('setSource(item)'), 'a chip must set the source')
  assert(body.includes("sourceLabel(item, lang, t) + ' (' + counts[item] + ')'"), 'each chip must show its count')
  assert(body.includes('const counts = extensionSourceCounts(snapshot.extensions)'), 'counts must cover the whole snapshot')
  return 'radiogroup, one radio per chip, counts, default all'
})

check('source-filtered-list', () => {
  assert(body.includes('const shown = filterExtensions(snapshot.extensions, source)'), 'the page must filter the snapshot')
  assert(body.includes('{shown.map(entry => ('), 'the cards must render the filtered rows')
  assert(!body.includes('{snapshot.extensions.map(entry => ('), 'the cards must not bypass the filter')
  assert(body.includes('{shown.length === 0 ? ('), 'an empty source needs its own state')
  assert(body.includes('<Empty title={sourceEmptyLabel(lang)} />'), 'an empty source must use the local label')
  assert(body.includes("{entry.bundled === true ? <Badge tone=\"neutral\">{t('extensions.bundled')}</Badge> : null}"), 'the bundled badge must stay on every bundled card')
  return 'filtered cards, per-source empty state, bundled badge kept'
})

check('source-hooks-order', () => {
  const stateAt = body.indexOf("const [source, setSource] = React.useState<ExtensionSource>('all')")
  const emptyAt = body.indexOf('if (snapshot.extensions.length === 0)')
  assert(stateAt !== -1 && emptyAt !== -1, 'the filter state and the installation empty return must both exist')
  assert(stateAt < emptyAt, 'the filter hook must be declared before the conditional return')
  return 'useState before the empty return (rules of hooks)'
})

// ── a local copy over a bundled pack ──────────────────────────────────────

check('override-module', () => {
  const api = requireView()
  for (const name of ['overrideLabel', 'copyLabel', 'copyHint', 'canCopyToLocal']) {
    assert(api[name] !== undefined, 'extensions.tsx does not export ' + name)
  }
  assert(api.overrideLabel('zh') === '本地覆盖', 'zh override label')
  assert(api.overrideLabel('en') === 'Local override', 'en override label')
  assert(api.copyLabel('zh') === '复制到本地', 'zh copy label')
  assert(api.copyLabel('en') === 'Copy to local', 'en copy label')
  assert(api.copyHint('zh', 'pack-a').includes('compat/pack-a'), 'the zh hint must name the bundled folder')
  assert(api.copyHint('en', 'pack-a').includes('compat/pack-a'), 'the en hint must name the bundled folder')
  assert(api.copyHint('zh', 'pack-a') !== api.copyHint('en', 'pack-a'), 'the hint must be bilingual')
  return 'bilingual override/copy copy naming compat/<id>'
})

check('override-runtime', () => {
  const api = requireView()
  assert(api.canCopyToLocal({ bundled: true }) === true, 'a bundled row with no local copy can be copied')
  assert(api.canCopyToLocal({ bundled: true, overridesBundled: false }) === true, 'an explicit false is still copyable')
  assert(api.canCopyToLocal({ bundled: true, overridesBundled: true }) === false, 'a shadowed bundled row is never offered')
  assert(api.canCopyToLocal({ bundled: false, overridesBundled: true }) === false, 'the local override row is already local')
  assert(api.canCopyToLocal({ bundled: false }) === false, 'a plain local row is not a bundled pack')
  return 'only a bundled row without a local copy is copyable'
})

check('override-badge', () => {
  assert(body.includes('{entry.overridesBundled === true ? <Badge tone="brand">{overrideLabel(lang)}</Badge> : null}'), 'a local copy must carry the override badge')
  const card = body.slice(body.indexOf('<Card label={name}>'))
  const bundledAt = card.indexOf("t('extensions.bundled')")
  const overrideAt = card.indexOf('{overrideLabel(lang)}')
  assert(bundledAt !== -1 && overrideAt !== -1 && bundledAt < overrideAt, 'the override badge must sit beside the bundled badge')
  assert(card.includes('{entry.overridesBundled === true ?'), 'the badge must follow the host flag alone')
  return '本地覆盖 badge beside the bundled badge'
})

check('copy-to-profile', () => {
  const card = body.slice(body.indexOf('<Card label={name}>'))
  const buttonAt = card.indexOf('{copyable ? (')
  assert(buttonAt !== -1, 'the copy action must be conditional on canCopyToLocal')
  const button = card.slice(buttonAt, card.indexOf(') : null}', buttonAt))
  assert(button.includes('setCopyAsk(true)'), 'the copy button must open the confirm dialog')
  assert(!/void run\(/.test(button), 'the copy button must not send before confirmation')
  assert(button.includes('busy={copyBusy}') && button.includes('disabled={anyBusy}'), 'the copy button reports its own busy state')
  assert(button.includes('{copyLabel(lang)}'), 'the copy button needs its label')
  const dialogAt = card.indexOf('open={copyAsk}')
  assert(dialogAt !== -1, 'the copy confirm dialog is missing')
  const dialog = card.slice(dialogAt, card.indexOf('</Dialog>', dialogAt))
  assert(dialog.includes('title={copyLabel(lang)}'), 'the copy dialog must name the action')
  assert(dialog.includes("{t('action.cancel')}") && dialog.includes("{t('action.confirm')}"), 'the copy dialog needs cancel and confirm')
  assert(dialog.includes('{copyHint(lang, entry.id)}'), 'the copy dialog must say what will be copied')
  const runAt = dialog.indexOf('void run(EXT.installBundled, { id: entry.id })')
  assert(runAt !== -1, 'the copy confirm must call the op with the row id')
  assert(dialog.lastIndexOf('setCopyAsk(false)', runAt) !== -1, 'the copy dialog must close before the op is sent')
  assert(/const result = await runOp\(op, payload, WRITE_TIMEOUT_MS\)[\s\S]*?await load\(true\)/.test(shell), 'the shell must reload the snapshot after a write')
  return 'confirm first, extension.installBundled with the id, reload after the write'
})

// ── 官方配套: the card above the list ─────────────────────────────────────

check('compat-mounted', () => {
  assert(/import \{ CompatManager \} from '\.\/compat-manager\.js'/.test(body), 'extensions.tsx must import the compat card from ./compat-manager.js')
  const cardAt = body.indexOf('<CompatManager')
  const listAt = body.indexOf('{shown.map(entry => (')
  assert(cardAt !== -1, 'the compat card must be rendered')
  assert(listAt !== -1 && cardAt < listAt, 'the compat card must sit above the extension list')
  assert(body.includes('entries={snapshot.extensions}'), 'the card lists the snapshot rows')
  assert(body.includes("statePath={snapshot.paths.state ?? ''}"), 'the card needs the state path to name the backup folder')
  const stateAt = compatBody.indexOf('React.useState<CompatPending[] | null>(null)')
  const returnAt = compatBody.indexOf('if (packs.length === 0) return null')
  assert(stateAt !== -1 && returnAt !== -1 && stateAt < returnAt, 'the card must declare its hooks before the early return')
  return 'card above the list, hooks before the empty return'
})

check('compat-official-only', () => {
  const api = requireCompat()
  for (const name of ['COMPAT', 'officialPacks', 'bundledVersionOf', 'localVersionOf', 'compatActionOf',
    'pendingActions', 'backupRootOf', 'installTargetOf', 'CompatManager', 'installLabel', 'updateLabel',
    'batchLabel', 'updateHint', 'installHint', 'batchHint', 'originLabel']) {
    assert(api[name] !== undefined, 'compat-manager.tsx does not export ' + name)
  }
  const rows = [
    { id: 'pack-only', version: '1.0.0', bundled: true, bundledVersion: '1.0.0' },
    { id: 'behind', version: '1.0.0', overridesBundled: true, bundledVersion: '2.0.0' },
    { id: 'current', version: '2.0.0', overridesBundled: true, bundledVersion: '2.0.0' },
    { id: 'plain-local', version: '1.0.0' },
    { id: 'legacy-local', bundled: false, overridesBundled: false },
  ]
  const before = JSON.stringify(rows)
  const packs = api.officialPacks(rows)
  assert(packs !== rows, 'officialPacks must return a new array')
  assert(packs.map(row => row.id).join(',') === 'pack-only,behind,current', 'officialPacks keeps only bundled/override rows in order: ' + packs.map(row => row.id).join(','))
  assert(api.officialPacks([]).length === 0, 'no rows is no packs')
  assert(JSON.stringify(rows) === before, 'officialPacks must not mutate the snapshot')
  assert(api.bundledVersionOf(rows[0]) === '1.0.0', 'a bundled row reports its own version as the pack version')
  assert(api.bundledVersionOf(rows[1]) === '2.0.0', 'an override row reports the pack version it shadows')
  assert(api.bundledVersionOf({ id: 'x', bundled: true, version: '3.0.0' }) === '3.0.0', 'a host without bundledVersion falls back to the row version')
  assert(api.bundledVersionOf(rows[3]) === '', 'a plain local row has no pack version')
  assert(api.localVersionOf(rows[0]) === '', 'a bundled row has no local version')
  assert(api.localVersionOf(rows[1]) === '1.0.0', 'an override row reports its own version as the local version')
  return 'official packs only, both versions, snapshot never mutated'
})

check('compat-action-rules', () => {
  const api = requireCompat()
  const packOnly = { id: 'a', version: '1.0.0', bundled: true, bundledVersion: '1.0.0' }
  const behind = { id: 'b', version: '1.0.0', overridesBundled: true, bundledVersion: '2.0.0' }
  const current = { id: 'c', version: '2.0.0', overridesBundled: true, bundledVersion: '2.0.0' }
  assert(api.compatActionOf(packOnly) === 'install', 'a bundled row without a local copy is an install')
  assert(api.compatActionOf(behind) === 'update', 'a copy behind the pack is an update')
  assert(api.compatActionOf(current) === null, 'a copy at the pack version has nothing to do')
  assert(api.compatActionOf({ id: 'd', version: '1.0.0' }) === null, 'a plain local row is not an official pack')
  assert(api.compatActionOf({ id: 'e', overridesBundled: true }) === null, 'no recorded pack version means no update')
  const pending = api.pendingActions([packOnly, behind, current, { id: 'f', version: '1.0.0' }])
  assert(JSON.stringify(pending) === JSON.stringify([{ id: 'a', action: 'install' }, { id: 'b', action: 'update' }]), 'pendingActions is every install/update in order: ' + JSON.stringify(pending))
  assert(api.pendingActions([]).length === 0, 'nothing to do is an empty batch')
  return 'install / update / nothing, batch in order'
})

check('compat-labels', () => {
  const api = requireCompat()
  assert(api.installLabel('zh') === '安装到本地', 'zh install label')
  assert(api.installLabel('en') === 'Install to local', 'en install label')
  assert(api.updateLabel('zh') === '更新', 'zh update label')
  assert(api.updateLabel('en') === 'Update', 'en update label')
  assert(api.batchLabel('zh') === '全部安装/更新', 'the batch button is 全部安装/更新')
  assert(api.batchLabel('en') !== api.batchLabel('zh'), 'the batch button is bilingual')
  assert(api.originLabel('zh', { id: 'a', overridesBundled: true }) === '本地覆盖', 'an override row says 本地覆盖')
  assert(api.originLabel('zh', { id: 'a', bundled: true }) === '插件包', 'a bundled row says 插件包')
  assert(api.originLabel('en', { id: 'a', bundled: true }) !== api.originLabel('zh', { id: 'a', bundled: true }), 'the origin label is bilingual')
  assert(api.noVersion('zh') === api.noVersion('en'), 'the empty version is the same glyph in both languages')
  assert(api.backupRootOf('/home/me/.dsh/tool-hub/state.json') === '/home/me/.dsh/tool-hub/backups', 'a posix state path maps to its backups folder')
  assert(api.backupRootOf('C:\\Users\\me\\.dsh\\tool-hub\\state.json') === 'C:/Users/me/.dsh/tool-hub/backups', 'a windows state path maps to its backups folder')
  assert(api.backupRootOf('state.json') === 'backups', 'a bare state file has no folder to derive')
  assert(api.installTargetOf('/home/me/.dsh/tool-hub/state.json', 'pack-a') === '/home/me/.dsh/tool-hub/extensions/pack-a', 'installing lands in the profile extension root')
  assert(api.installTargetOf('C:\\Users\\me\\state.json', 'pack-a') === 'C:/Users/me/extensions/pack-a', 'a windows state path lands in the profile extension root')
  assert(api.installTargetOf('state.json', 'pack-a') === 'extensions/pack-a', 'a bare state file still names the extension folder')
  return 'bilingual labels, backup folder derived from the state path'
})

check('compat-update-wording', () => {
  const api = requireCompat()
  const zh = api.updateHint('zh', 'pack-a', '/state/backups')
  const en = api.updateHint('en', 'pack-a', '/state/backups')
  assert(zh.includes('compat/pack-a'), 'the zh update hint must name the pack it reads')
  assert(zh.includes('/state/backups') && zh.includes('extensions-pack-a-'), 'the zh update hint must name the backup folder it creates')
  assert(zh.includes('覆盖'), 'the zh update hint must say the local copy is overwritten')
  assert(zh !== en, 'the update hint must be bilingual')
  assert(en.includes('compat/pack-a') && en.includes('/state/backups') && /overwrit/i.test(en), 'the en update hint must say backup then overwrite')
  assert(api.installHint('zh', 'pack-a').includes('compat/pack-a'), 'the install hint names the pack')
  assert(api.installHint('zh', 'pack-a') !== api.installHint('en', 'pack-a'), 'the install hint must be bilingual')
  const batch = api.batchHint('zh', 3, '/state/backups')
  assert(batch.includes('3'), 'the batch hint must carry the count')
  assert(batch.includes('/state/backups'), 'the batch hint must name the backup folder')
  assert(api.reportLine('zh', 2, 1).includes('2') && api.reportLine('zh', 2, 1).includes('1'), 'the report line carries both counts')
  return 'backup folder + overwrite in the update copy, count in the batch copy'
})

check('compat-row-render', () => {
  assert(compatBody.includes("{bundledVersionLabel(lang) + ' ' + (bundledVersionOf(entry) || noVersion(lang))}"), 'the row must show the pack version')
  assert(compatBody.includes("{localVersionLabel(lang) + ' ' + (localVersionOf(entry) || noVersion(lang))}"), 'the row must show the local version')
  assert(compatBody.includes('{originLabel(lang, entry)}'), 'the row must show where the copy comes from')
  assert(compatBody.includes("{entry.enabled ? t('extensions.enabled') : t('extensions.disabled')}"), 'the row must show the enabled state')
  assert(compatBody.includes('const target = entry.bundled === true ? installTargetOf(statePath, entry.id) : entry.dir'), 'a bundled row must name the folder an install lands in')
  assert(compatBody.includes('{target}'), 'the row must show that target')
  assert(compatBody.includes('title={targetLabel(lang)}'), 'the folder must be labelled as the target')
  assert(compatBody.includes('const description = packDescription(entry, lang)'), 'the row must read the pack description')
  assert(compatBody.includes("description === '' ? null : <span className=\"th-field-hint\">{description}</span>"), 'the row must render the description when the manifest has one')
  assert(compatBody.includes('const name = packName(entry, lang)'), 'the row must resolve the pack name for its language')
  assert(compatBody.includes('<span className="th-row-name">{name}</span>'), 'the row must show the pack name')
  assert(compatBody.includes('<span className="th-mono">{entry.id}</span>'), 'the row must show the id beside the name')
  assert(compatBody.includes('busy={busyWith(COMPAT.install, entry.id)}') && compatBody.includes('busy={busyWith(COMPAT.update, entry.id)}'), 'each action needs its own busy key')
  assert(compatBody.includes('checked={entry.enabled}'), 'the switch must follow the host state')
  assert(compatBody.includes('runDetailed(COMPAT.set, { id: entry.id, enabled })'), 'the switch must send extension.set with the next state')
  return 'name/id, target, description, both versions, status, per-row controls'
})

check('compat-batch', () => {
  assert(compatBody.includes('const pending = pendingActions(entries)'), 'the batch button must compute the pending actions')
  assert(compatBody.includes('setQueued(pending)'), 'the batch button must open one confirmation')
  assert(compatBody.includes('batchHint(lang, queued.length, backupRoot)'), 'the batch confirmation must carry the count and the backup promise')
  assert(compatBody.includes("{ id: entry.id, action: 'install' }") && compatBody.includes("{ id: entry.id, action: 'update' }"), 'a row action must queue exactly that row and action')
  assert(compatBody.includes('const actions = queued ?? []'), 'the confirmation must take the queued actions')
  assert(/setQueued\(null\)[\s\S]{0,120}runActions\(actions\)/.test(compatBody), 'the confirmation must close before the batch runs')
  assert(compatBody.includes('for (const action of actions) {'), 'the batch must run one action at a time')
  assert(!/Promise\.all/.test(compatBody), 'the batch must not fan out')
  assert(compatBody.includes('failed.push({ id: action.id, message: outcome.error'), 'a failed action must be recorded by id')
  assert(compatBody.includes('{report.failed.map(item => ('), 'every failure must be rendered')
  assert(compatBody.includes('{reportLine(lang, report.ok, report.failed.length)}'), 'the batch must report its counts')
  return 'pending actions, one confirmation with the count, sequential, per-action failures'
})

check('compat-no-auto-actions', () => {
  const effects = compatBody.match(/React\.useEffect\(\(\) => \{[\s\S]*?\}, \[\]\)/g) ?? []
  assert(effects.length === 1, 'the card must declare exactly one effect, found ' + effects.length)
  assert(!/runDetailed\(|runActions\(|setQueued\(/.test(effects[0]), 'the card must never send or queue from an effect')
  assert(effects[0].includes('alive.current = false'), 'the effect must be the unmount guard')
  assert(!/disabled=\{false\}/.test(compatBody), 'no control may be forced enabled')
  return 'no op on mount, unmount guarded'
})

check('compat-discipline', () => {
  const allowed = new Set(['react', '../components.js', '../theme.js', '../types.js'])
  for (const match of compatBody.matchAll(/from '([^']+)'/g)) {
    assert(allowed.has(match[1]), "unexpected import '" + match[1] + "' in compat-manager.tsx")
  }
  assert(!/<button\b/.test(compatBody), 'raw buttons belong to components.tsx')
  for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'document.write']) {
    assert(compatBody.indexOf(pattern) === -1, 'compat-manager.tsx uses ' + pattern)
  }
  assert(!/TODO\(|FIXME/.test(compatSource), 'compat-manager.tsx still carries a TODO marker')
  const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(compatBody)
  assert(literal === null, 'a literal colour in compat-manager.tsx')
  const zhKeys = catalogKeys('zh')
  const enKeys = catalogKeys('en')
  for (const match of compatBody.matchAll(/\bt\('([^']+)'/g)) {
    assert(zhKeys.has(match[1]) && enKeys.has(match[1]), "t('" + match[1] + "') is not a catalog key")
  }
  assert(compatBody.includes("t('extensions.enabled')") && compatBody.includes("t('extensions.disabled')"), 'the status badges must reuse the catalog keys')
  const lines = compatSource.split('\n').length
  assert(lines < 520, 'compat-manager.tsx has ' + lines + ' lines')
  return 'stubs-only imports, no raw buttons, themed styles, catalog keys only, ' + lines + ' lines'
})

// ── the op console ─────────────────────────────────────────────────────────


check('console-select', () => {
  assert(body.includes("<Select id={entry.id + '-op'} value={chosen} options={options} onChange={setOp} label={t('extensions.ops')} />"), 'the console must choose from the declared ops')
  assert(body.includes('const options = entry.ops.map(id => ({ value: id, label: id }))'), 'the options must come from entry.ops')
  assert(body.includes('const chosen = entry.ops.includes(op) ? op : entry.ops[0] ?? \'\''), 'an unknown choice must fall back to the first op')
  assert(body.includes('const write = isWriteOp(readsOf, chosen)'), 'the console must know whether the chosen op writes')
  assert(body.includes("<Badge tone={write ? 'warn' : 'neutral'}>{write ? 'write' : 'read'}</Badge>"), 'the console must show read vs write')
  assert(body.includes('{t(\'extensions.ops\')}'), 'the console needs its section title')
  assert(body.includes('entry.ops.length === 0 ? null : ('), 'an extension with no op shows no console')
  return 'op select from entry.ops, read/write badge, hidden when empty'
})

check('console-payload', () => {
  assert(body.includes('const parsed = parsePayload(payload)'), 'the payload must be parsed before any send')
  assert(body.includes('export function parsePayload('), 'the payload parser must be one helper')
  assert(body.includes("error={parsed.ok ? undefined : t('extensions.invalidJson')}"), 'bad JSON must be reported under the field')
  assert(body.includes("aria-label={t('extensions.payload')}"), 'the payload box needs an accessible name')
  assert(body.includes('disabled={!parsed.ok || chosen === \'\' || anyBusy}'), 'Run must stay disabled while the payload does not parse')
  assert(body.includes("{t('extensions.run')}"), 'the console needs its Run label')
  assert(body.includes("label={t('extensions.payload')}"), 'the payload box needs its field label')
  return 'parsed payload, labelled box, invalid JSON refused, Run gated'
})

check('write-dialog', () => {
  const submit = section('const submit = (): void => {', 'const confirmPending')
  assert(submit.includes('if (isWriteOp(readsOf, chosen)) {'), 'the console must branch on read vs write')
  assert(submit.includes('setPending(parsed.value)'), 'a write must stage the parsed payload')
  assert(submit.includes('setAsking(true)'), 'a write must open the dialog')
  const ask = submit.indexOf('setAsking(true)')
  const send = submit.indexOf('send(chosen, parsed.value, false)')
  assert(ask !== -1 && send !== -1 && ask < send, 'only the read branch may send without asking')
  assert(body.includes('open={asking}'), 'the dialog must open on a staged write')
  assert(body.includes("title={t('dialog.confirmTitle')}"), 'the dialog needs the confirm title')
  assert(body.includes("{t('action.cancel')}") && body.includes("{t('action.confirm')}"), 'the dialog buttons need their labels')
  assert(body.includes('<Badge tone="warn">write</Badge>'), 'the dialog must say that this op writes')
  return 'write staged, dialog first, read direct'
})

check('confirm-flag', () => {
  assert(body.includes('const body = confirmed && isRecord(value) ? { ...value, confirm: true } : value'), 'a confirmed write must carry confirm:true')
  assert((body.match(/confirm: true/g) ?? []).length === 1, 'confirm:true may only be attached in one place')
  const confirm = section('const confirmPending = (): void => {', 'const views =')
  const close = confirm.indexOf('setAsking(false)')
  const send = confirm.indexOf('send(chosen, staged, true)')
  assert(close !== -1 && send !== -1 && close < send, 'the dialog must close before the op is sent')
  assert(confirm.includes('const staged = pending'), 'the confirm must send the staged payload, not the live box')
  assert(!/run\(/.test(confirm), 'the confirm must go through runDetailed')
  const footer = section('footer={', '</Dialog>')
  assert(!/send\(|runDetailed\(|void run\(/.test(footer), 'the dialog footer must never send on its own')
  assert((body.match(/setAsking\(false\)/g) ?? []).length === 3, 'close, cancel and confirm must all clear the dialog flag')
  return 'confirm:true once, close before send, cancel never sends'
})

check('console-result', () => {
  const send = section('const send = (target: string, value: unknown, confirmed: boolean): void => {', 'const submit = (')
  assert(send.includes('runDetailed(target, body)'), 'the console must send through runDetailed')
  assert(send.includes('setResult(null)') && send.includes("setFailure('')"), 'a new run must clear the previous answer')
  assert(send.includes('if (!outcome.ok)'), 'a failed run must be reported')
  assert(send.includes('setFailure(outcome.error ?? \'\')'), 'a failed run must keep the host message')
  assert(send.includes('jsonText(outcome.data)'), 'a successful run must render the host payload')
  assert(reachesCallout('failure'), 'a failed run must reach a Callout')
  assert(body.includes("{t('extensions.result')}"), 'the answer needs its result label')
  assert(body.includes('busy={running}'), 'the Run button must report its own busy state')
  return 'runDetailed, answer rendered, failure kept'
})

// ── discipline ─────────────────────────────────────────────────────────────

check('no-mount-write', () => {
  const effect = section('React.useEffect(() => {', '}, [])')
  assert(!/runOp\(|runDetailed\(|void run\(/.test(effect), 'the only effect must not send anything')
  assert(effect.includes('alive.current = false'), 'the effect must be the unmount guard')
  return 'no op on mount'
})

check('accessible-names', () => {
  assert(!/<button\b/.test(body), 'raw buttons belong to components.tsx')
  assert((body.match(/<Button/g) ?? []).length >= 5, 'actions must be buttons from components.tsx')
  assert(body.includes("<Switch") && body.includes("label={t('a11y.switch', { name })}"), 'the switch needs an accessible name')
  assert(body.includes('label={t(\'extensions.ops\')}'), 'the op select needs an accessible name')
  assert((body.match(/aria-label=\{t\('extensions\.(?:payload|result)'\)\}/g) ?? []).length === 3, 'the payload boxes need accessible names')
  assert(body.includes('<Card label={name}>'), 'the extension card must name its group')
  assert((body.match(/<Field/g) ?? []).length === 1, 'the console payload needs its one field')
  return 'no raw buttons, every control named'
})

check('no-literal-colours', () => {
  const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(body)
  assert(match === null, 'a literal colour at line ' + lineAt(body, match === null ? 0 : match.index))
  const COLOUR = /^\s*(?:color|background|backgroundColor|border|borderTop|borderBottom|borderLeft|borderRight|borderColor|outline|outlineColor|boxShadow|fill|stroke)\s*:/
  for (const line of body.split('\n')) {
    if (!COLOUR.test(line)) continue
    assert(line.includes('T.'), 'a style carries a colour that is not a theme token: ' + line.trim())
  }
  assert(body.includes('style={BOX}') && body.includes('style={TH}') && body.includes('style={TD}'), 'the boxes and table must take their look from constants')
  assert(/className="th-/.test(body), 'layout comes from the th-* classes')
  return 'tokens only, th-* classes'
})

check('no-html-injection', () => {
  for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert(body.indexOf(pattern) === -1, 'the view uses ' + pattern)
  }
  return 'no HTML string injection'
})

check('no-todo', () => {
  const at = source.search(/TODO\(|FIXME|XXX:/)
  assert(at === -1, 'extensions.tsx:' + lineAt(source, at) + ' still carries a TODO marker')
  return 'no TODO/FIXME'
})

check('imports', () => {
  const allowed = new Set(['react', '../api.js', '../components.js', '../theme.js', '../types.js', './compat-manager.js'])
  for (const match of body.matchAll(/from '([^']+)'/g)) {
    assert(allowed.has(match[1]), "unexpected import '" + match[1] + "'")
  }
  assert(!/from 'node:/.test(body), 'the view must not import node builtins')
  assert(!/\.\.\/domains\//.test(body), 'the view must not import a host domain')
  assert(!/\.\.\/host\//.test(body), 'the view must not import the host')
  return allowed.size + ' allowed imports only'
})

check('file-length', () => {
  const lines = source.split('\n').length
  const bytes = statSync(VIEW).size
  assert(lines < 760, 'extensions.tsx has ' + lines + ' lines (limit 760)')
  assert(bytes < 60 * 1024, 'extensions.tsx is ' + bytes + ' bytes (limit 60 KB)')
  return lines + ' lines, ' + bytes + ' bytes'
})

// ── the catalogs ───────────────────────────────────────────────────────────

/** The keys of one i18n catalog, parsed by brace scanning so the probe needs no TypeScript. */
function catalogKeys(name) {
  const marker = new RegExp('const ' + name + ': Catalog = \\{')
  const found = marker.exec(i18nSource)
  assert(found !== null, 'i18n.ts has no ' + name + ' catalog')
  const open = found.index + found[0].length - 1
  let cursor = open
  let depth = 0
  for (; cursor < i18nSource.length; cursor += 1) {
    const char = i18nSource[cursor]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  assert(depth === 0, name + ' catalog is not closed')
  const inner = i18nSource.slice(open + 1, cursor)
  return new Set([...inner.matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1]))
}

check('i18n-resolved', () => {
  const zh = catalogKeys('zh')
  const en = catalogKeys('en')
  const used = new Set()
  for (const match of body.matchAll(/\bt\('([^']+)'/g)) {
    used.add(match[1])
    assert(zh.has(match[1]), "t('" + match[1] + "') is not in the zh catalog")
    assert(en.has(match[1]), "t('" + match[1] + "') is not in the en catalog")
  }
  const required = ['extensions.empty', 'extensions.enableHint', 'extensions.count', 'extensions.hot',
    'extensions.local', 'extensions.version', 'extensions.dir', 'extensions.enabled', 'extensions.disabled',
    'extensions.loaded', 'extensions.failed', 'extensions.reload', 'extensions.views', 'extensions.ops',
    'extensions.payload', 'extensions.invalidJson', 'extensions.run', 'extensions.result',
    'extensions.viewLoad', 'extensions.viewEmpty', 'dialog.confirmTitle', 'action.retry', 'action.cancel',
    'action.confirm', 'a11y.switch']
  for (const key of required) assert(used.has(key), 'the view never calls t(' + key + ')')
  const zhExtensions = [...zh].filter(key => key.startsWith('extensions.'))
  const enExtensions = [...en].filter(key => key.startsWith('extensions.'))
  assert(zhExtensions.length === enExtensions.length, 'the two catalogs disagree on extensions key count')
  for (const key of zhExtensions) assert(en.has(key), 'en is missing ' + key)
  return used.size + ' keys used, all resolved, ' + zhExtensions.length + ' extensions keys in both catalogs'
})

// ── report ──────────────────────────────────────────────────────────────────

console.log(passed + '/' + (passed + failures.length) + ' checks passed')
if (failures.length > 0) {
  console.log('failed: ' + failures.join(', '))
  process.exit(1)
}
