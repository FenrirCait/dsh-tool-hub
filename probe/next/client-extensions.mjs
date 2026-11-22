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
 *  24. the 官方配套 card sits above the extension list and before the empty-installation state,
 *      and mounts through runDetailed with the state path the backup folder is derived from;
 *  25. the card's catalog answer is normalised: a row needs an id and a name, unusable rows are
 *      dropped, source / fetchedAt / warnings survive, and a non-catalog answer is null;
 *  26. install is offered with no local copy, update exactly while the host says updateAvailable,
 *      the switch sends extension.set with the next state, and the labels/status words are local;
 *  27. refresh forces compat.index while an ordinary read accepts the cache, and source, loading,
 *      error, empty and parser-warning states all render;
 *  28. the batch button computes the pending actions, confirms once with the count, runs them one
 *      at a time with confirm:true and keeps a per-action failure;
 *  29. the card reads the catalog on mount but never installs, queues or switches from an effect;
 *  30. compat-manager.tsx stays inside the allowed imports, themed styles, catalog keys and the
 *      view budget, and the panel's own writes are exactly extension.set and extension.reload.
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
  assert(/export const EXT = \{ set: 'extension\.set', reload: 'extension\.reload' \} as const/.test(body), 'every panel op must live in one constant')
  assert((body.match(/['"]extension\./g) ?? []).length === 2, 'an extension op is spelled outside the constant')
  assert(count('runOp(') === 1, 'the view may read through runOp exactly once, found ' + count('runOp('))
  assert(body.includes('runOp(view.op, {})'), 'a view read must send the declared op, not a hardcoded one')
  assert(count('void run(') === 2, 'only the two panel writes may go through run, found ' + count('void run('))
  assert(count('runDetailed(') === 1, 'the console must have one send site, found ' + count('runDetailed('))
  return 'EXT constant, one runOp site, two run sites, one runDetailed site'
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

// ── 官方配套: the online card above the list ──────────────────────────────

check('compat-mounted', () => {
  assert(/import \{ CompatManager \} from '\.\/compat-manager\.js'/.test(body), 'extensions.tsx must import the compat card from ./compat-manager.js')
  const cardAt = body.indexOf('<CompatManager')
  const listAt = body.indexOf('{snapshot.extensions.map(entry => (')
  const emptyAt = body.indexOf('snapshot.extensions.length === 0')
  assert(cardAt !== -1, 'the compat card must be rendered')
  assert(listAt !== -1 && cardAt < listAt, 'the compat card must sit above the extension list')
  assert(emptyAt !== -1 && cardAt < emptyAt, 'the card must render before the empty-installation state')
  assert(body.includes("statePath={snapshot.paths.state ?? ''}"), 'the card needs the state path to name the backup folder')
  assert(body.includes('runDetailed={runDetailed}'), 'the card sends compat ops through runDetailed')
  const stateAt = compatBody.indexOf('React.useState<CompatIndex | null>(null)')
  const effectAt = compatBody.indexOf('React.useEffect(() => {')
  assert(stateAt !== -1 && effectAt !== -1 && stateAt < effectAt, 'the card must declare its state before the effect')
  return 'card above the list and before the empty state, hooks before the effect'
})

check('compat-index-shape', () => {
  const api = requireCompat()
  for (const name of ['COMPAT', 'indexOf', 'compatActionOf', 'pendingActions', 'backupRootOf', 'installTargetOf',
    'CompatManager', 'installLabel', 'updateLabel', 'batchLabel', 'updateHint', 'installHint', 'batchHint',
    'statusLabel', 'sourceLabel', 'remoteVersionLabel', 'installedVersionLabel']) {
    assert(api[name] !== undefined, 'compat-manager.tsx does not export ' + name)
  }
  const rows = [
    { id: 'new-pack', name: { zh: '新', en: 'New' }, version: '2.0.0', installedVersion: '', installedDir: '', enabled: false, updateAvailable: false, fileCount: 3 },
    { id: 'behind', name: { zh: '旧', en: 'Old' }, version: '2.0.0', installedVersion: '1.0.0', installedDir: '/x/behind', enabled: true, updateAvailable: true, fileCount: 2 },
    { id: 'current', name: { zh: '同', en: 'Same' }, version: '2.0.0', installedVersion: '2.0.0', installedDir: '/x/current', enabled: false, updateAvailable: false, fileCount: 1 },
  ]
  const parsed = api.indexOf({ packs: rows, source: 'mirror', fetchedAt: '2026-01-01T00:00:00.000Z', warnings: ['dropped'] })
  assert(parsed !== null, 'a catalog answer must normalise')
  assert(parsed.packs.length === 3, 'every valid row must survive: ' + parsed.packs.length)
  assert(parsed.source === 'mirror', 'the source must be kept')
  assert(parsed.fetchedAt === '2026-01-01T00:00:00.000Z', 'the fetch stamp must be kept')
  assert(parsed.warnings.join(',') === 'dropped', 'the warnings must be kept')
  // A row without an id or a name cannot be rendered; the rest of the answer still counts.
  const mixed = api.indexOf({ packs: [{ id: '', name: { zh: 'x', en: 'x' } }, { id: 'ok', name: { zh: '好', en: 'Good' } }, null], source: 'nope', warnings: 'bad' })
  assert(mixed !== null && mixed.packs.length === 1, 'unusable rows must be dropped')
  assert(mixed.source === 'index', 'an unknown source falls back to index')
  assert(mixed.warnings.length === 0, 'a non-array warnings field becomes empty')
  assert(api.indexOf({}) === null, 'an answer without packs is not a catalog')
  assert(api.indexOf(null) === null, 'null is not a catalog')
  return 'rows normalised, unusable rows dropped, source kept'
})

check('compat-action-rules', () => {
  const api = requireCompat()
  const row = extra => ({ id: 'a', name: { zh: 'a', en: 'a' }, version: '2.0.0', installedVersion: '', installedDir: '', enabled: false, updateAvailable: false, fileCount: 1, ...extra })
  assert(api.compatActionOf(row({})) === 'install', 'no local copy is an install')
  assert(api.compatActionOf(row({ installedVersion: '1.0.0', updateAvailable: true })) === 'update', 'a copy behind is an update')
  assert(api.compatActionOf(row({ installedVersion: '2.0.0', updateAvailable: false })) === null, 'the same version has nothing to do')
  assert(api.compatActionOf(row({ installedVersion: '3.0.0', updateAvailable: true })) === 'update', 'the host flag alone decides an update')
  const pending = api.pendingActions([row({ id: 'a' }), row({ id: 'b', installedVersion: '1.0.0', updateAvailable: true }), row({ id: 'c', installedVersion: '2.0.0' })])
  assert(JSON.stringify(pending) === JSON.stringify([{ id: 'a', action: 'install' }, { id: 'b', action: 'update' }]), 'ready work in catalog order: ' + JSON.stringify(pending))
  assert(api.pendingActions([]).length === 0, 'no rows is an empty batch')
  return 'install / update / nothing, batch in order'
})

check('compat-labels', () => {
  const api = requireCompat()
  assert(api.installLabel('zh') === '安装', 'zh install label')
  assert(api.installLabel('en') === 'Install', 'en install label')
  assert(api.updateLabel('zh') === '更新', 'zh update label')
  assert(api.updateLabel('en') === 'Update', 'en update label')
  assert(api.batchLabel('zh') === '全部安装/更新', 'the batch button is 全部安装/更新')
  assert(api.batchLabel('en') !== api.batchLabel('zh'), 'the batch button is bilingual')
  assert(api.refreshLabel('zh') !== api.refreshLabel('en'), 'the refresh button is bilingual')
  const installed = { id: 'a', name: { zh: 'a', en: 'a' }, version: '2.0.0', installedVersion: '2.0.0', installedDir: '', enabled: true, updateAvailable: false, fileCount: 1 }
  const behind = { ...installed, installedVersion: '1.0.0', updateAvailable: true }
  const missing = { ...installed, installedVersion: '' }
  assert(api.statusLabel('zh', missing) === '未安装', 'a missing pack says 未安装')
  assert(api.statusLabel('zh', behind) === '可更新', 'a behind copy says 可更新')
  assert(api.statusLabel('zh', installed) === '已安装', 'an installed copy says 已安装')
  assert(api.statusLabel('en', missing) !== api.statusLabel('zh', missing), 'the status is bilingual')
  assert(api.sourceLabel('zh', 'cache').includes('缓存'), 'a cache hit is named')
  assert(api.sourceLabel('en', 'mirror').toLowerCase().includes('mirror'), 'the mirror is named')
  assert(api.noVersion('zh') === api.noVersion('en'), 'the empty version is the same glyph in both languages')
  assert(api.backupRootOf('/home/me/.dsh/tool-hub/state.json') === '/home/me/.dsh/tool-hub/backups', 'a posix state path maps to its backups folder')
  assert(api.backupRootOf('C:\\Users\\me\\.dsh\\tool-hub\\state.json') === 'C:/Users/me/.dsh/tool-hub/backups', 'a windows state path maps to its backups folder')
  assert(api.backupRootOf('state.json') === 'backups', 'a bare state file has no folder to derive')
  assert(api.installTargetOf('/home/me/.dsh/tool-hub/state.json', 'pack-a') === '/home/me/.dsh/tool-hub/extensions/pack-a', 'installing lands in the profile extension root')
  assert(api.installTargetOf('state.json', 'pack-a') === 'extensions/pack-a', 'a bare state file still names the extension folder')
  return 'bilingual labels, status words, backup folder derived from the state path'
})

check('compat-update-wording', () => {
  const api = requireCompat()
  const zh = api.updateHint('zh', 'pack-a', '/state/backups')
  const en = api.updateHint('en', 'pack-a', '/state/backups')
  assert(zh.includes('/state/backups') && zh.includes('extensions-pack-a-'), 'the zh update hint names the backup folder it creates')
  assert(zh.includes('校验'), 'the zh update hint promises verification')
  assert(zh !== en, 'the update hint must be bilingual')
  assert(en.includes('/state/backups') && /verified/i.test(en) && /back/i.test(en), 'the en update hint names the backup and the check')
  assert(api.installHint('zh', 'pack-a').includes('SHA-256'), 'the install hint names the hash check')
  assert(api.installHint('zh', 'pack-a') !== api.installHint('en', 'pack-a'), 'the install hint must be bilingual')
  const batch = api.batchHint('zh', 3, '/state/backups')
  assert(batch.includes('3'), 'the batch hint must carry the count')
  assert(batch.includes('/state/backups'), 'the batch hint must name the backup folder')
  assert(api.reportLine('zh', 2, 1).includes('2') && api.reportLine('zh', 2, 1).includes('1'), 'the report line carries both counts')
  return 'backup folder + verification in the copy, count in the batch copy'
})

check('compat-row-render', () => {
  assert(compatBody.includes("{remoteVersionLabel(lang) + ' ' + (row.version === '' ? noVersion(lang) : row.version)}"), 'the row must show the catalog version')
  assert(compatBody.includes("{installedVersionLabel(lang) + ' ' + (row.installedVersion === '' ? noVersion(lang) : row.installedVersion)}"), 'the row must show the installed version')
  assert(compatBody.includes('{statusLabel(lang, row)}'), 'the row must show the install status')
  assert(compatBody.includes('{statusTone(row)}'), 'the status badge must follow the row state')
  assert(compatBody.includes("{row.enabled ? t('extensions.enabled') : t('extensions.disabled')}"), 'an installed row must show the switch state')
  assert(compatBody.includes("const target = row.installedDir !== '' ? row.installedDir : installTargetOf(statePath, row.id)"), 'a missing pack must name where an install lands')
  assert(compatBody.includes('{target}'), 'the row must show that target')
  assert(compatBody.includes('title={targetLabel(lang)}'), 'the folder must be labelled as the target')
  assert(compatBody.includes('const description = packDescription(row, lang)'), 'the row must read the pack description')
  assert(compatBody.includes("description === '' ? null : <span className=\"th-field-hint\">{description}</span>"), 'the row must render the description when the index has one')
  assert(compatBody.includes('const name = packName(row, lang)'), 'the row must resolve the pack name for its language')
  assert(compatBody.includes('<span className="th-row-name">{name}</span>'), 'the row must show the pack name')
  assert(compatBody.includes('<span className="th-mono">{row.id}</span>'), 'the row must show the id beside the name')
  assert(compatBody.includes('busy={running}'), 'each action must report the batch state')
  assert(compatBody.includes('checked={row.enabled}'), 'the switch must follow the host state')
  assert(compatBody.includes('runDetailed(COMPAT.set, { id: row.id, enabled })'), 'the switch must send extension.set with the next state')
  return 'name/id, target, description, both versions, status, per-row controls'
})

check('compat-refresh', () => {
  assert(compatBody.includes('void runDetailed(COMPAT.index, force ? { force: true } : {})'), 'the read must go through compat.index and force only on refresh')
  assert(compatBody.includes('load(true)'), 'the refresh button must force a network read')
  assert(compatBody.includes('load(false)'), 'an ordinary read must accept the cache')
  assert(compatBody.includes('{refreshLabel(lang)}'), 'the refresh button needs its label')
  assert(compatBody.includes('busy={loading}'), 'the refresh button must report the read state')
  assert(compatBody.includes("{error === '' ? null : <Callout>{error}</Callout>}"), 'a failed read must be shown in a Callout')
  assert(compatBody.includes('{sourceLabel(lang, index.source)}'), 'the card must show where the catalog came from')
  assert(compatBody.includes('{loadingLabel(lang)}'), 'the first read needs a loading line')
  assert(compatBody.includes('{emptyLabel(lang)}'), 'an empty catalog needs its own state')
  assert(compatBody.includes('index.warnings.map'), 'the parser warnings must reach the page')
  return 'refresh forces, cache otherwise, source/loading/error/empty states'
})

check('compat-batch', () => {
  assert(compatBody.includes('const pending = pendingActions(packs)'), 'the batch button must compute the pending actions')
  assert(compatBody.includes('setQueued(pending)'), 'the batch button must open one confirmation')
  assert(compatBody.includes('batchHint(lang, queued.length, backupRoot)'), 'the batch confirmation must carry the count and the backup promise')
  assert(compatBody.includes('{ id: row.id, action }'), 'a row action must queue exactly that row and action')
  assert(compatBody.includes('const actions = queued ?? []'), 'the confirmation must take the queued actions')
  assert(/setQueued\(null\)[\s\S]{0,120}runActions\(actions\)/.test(compatBody), 'the confirmation must close before the batch runs')
  assert(compatBody.includes('for (const action of actions) {'), 'the batch must run one action at a time')
  assert(!/Promise\.all/.test(compatBody), 'the batch must not fan out')
  assert(compatBody.includes('runDetailed(COMPAT.install, { id: action.id, confirm: true })'), 'a confirmed install must carry confirm:true')
  assert(compatBody.includes('failed.push({ id: action.id, message: outcome.error'), 'a failed action must be recorded by id')
  assert(compatBody.includes('{report.failed.map(item => ('), 'every failure must be rendered')
  assert(compatBody.includes('{reportLine(lang, report.ok, report.failed.length)}'), 'the batch must report its counts')
  return 'pending actions, one confirmation with the count, sequential, per-action failures'
})

check('compat-no-auto-actions', () => {
  const effects = compatBody.match(/React\.useEffect\(\(\) => \{[\s\S]*?\}, \[\]\)/g) ?? []
  assert(effects.length === 1, 'the card must declare exactly one effect, found ' + effects.length)
  assert(effects[0].includes('load(false)'), 'the effect may only read the catalog')
  assert(!/COMPAT\.install|runActions|setQueued|toggle\(/.test(effects[0]), 'the card must never install, queue or switch from an effect')
  assert(effects[0].includes('alive.current = false'), 'the effect must be the unmount guard')
  assert(!/disabled=\{false\}/.test(compatBody), 'no control may be forced enabled')
  return 'mount reads the catalog only, unmount guarded'
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
  assert(compatBody.includes("t('extensions.enabled')") && compatBody.includes("t('extensions.disabled')"), 'the switch state must reuse the catalog keys')
  const lines = compatSource.split('\n').length
  assert(lines < 560, 'compat-manager.tsx has ' + lines + ' lines')
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
