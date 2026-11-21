#!/usr/bin/env node
/**
 * probe/next/client-tools.mjs — the tools view and its server/prefix tree, checked from outside.
 *
 * Two layers:
 *   - static gates read tools.tsx, tools-tree.tsx, the shared package-tree, the domain that owns
 *     the ops, the shell and the catalogs, and assert the properties the page must keep;
 *   - grouping, filtering, the deny arithmetic and the parent-switch guard are pure functions, so
 *     the two TSX modules are transpiled with the esbuild devDependency, react and the components
 *     are stubbed, and the rules run on a fixture: measured here, not pattern-matched.
 *
 * No host, no browser, no writes outside one temp directory that is removed before the report.
 *
 * Coverage:
 *   1. the view exists, the shell mounts it, the six tool-surface ops are named and registered;
 *   2. the merge plan is fetched, rendered and dismissable;
 *   3. the mask stays a draft until a confirmed save, and the draft starts from the committed deny;
 *   4. MCP rows group per server, the rest group per name prefix, servers first, fallback last;
 *   5. a search term filters rows and forces every parent open; a parent label match keeps all
 *      children; expansion is remembered under tool-hub-tree-tools and starts collapsed;
 *   6. the parent switch exists only for MCP groups with no fixed child, and writes the next full
 *      deny list from the snapshot through tool.save;
 *   7. the lazy card, the scope card and the on-demand card are untouched;
 *   8. names on every control, th-* layout, no raw form element, both files inside their length;
 *   9. every t() key resolves in both catalogs.
 *
 * No dependencies beyond the esbuild already in devDependencies; PASS/FAIL lines, exit 1 when
 * anything fails.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = join(ROOT, 'src', 'client', 'views', 'tools.tsx')
const TREE = join(ROOT, 'src', 'client', 'views', 'tools-tree.tsx')
const SHARED = join(ROOT, 'src', 'client', 'views', 'package-tree.tsx')
const DOMAIN = join(ROOT, 'src', 'domains', 'tool-surface.ts')
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
    const detail = error instanceof Error ? error.message : String(error)
    failures.push(name)
    console.log('FAIL ' + name + ' -- ' + detail)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const read = file => readFileSync(file, 'utf8')
const includes = (text, needle) => text.includes(needle)
const rel = file => relative(ROOT, file).split('\\').join('/')
const lineAt = (text, index) => text.slice(0, index).split('\n').length
/** Source with block comments and whole-line comments removed. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')

const FILES = { view: VIEW, tree: TREE, shared: SHARED }
const sources = { view: read(VIEW), tree: read(TREE), shared: read(SHARED) }
const bodies = { view: code(sources.view), tree: code(sources.tree), shared: code(sources.shared) }
const domain = read(DOMAIN)
const shell = read(SHELL)
const i18nSource = read(I18N)

/** Assembled so this file needs no template literal of its own. */
const TICK = String.fromCharCode(96)
const DOLLAR = String.fromCharCode(36)
const expr = inner => DOLLAR + '{' + inner + '}'
const tmpl = inner => TICK + inner + TICK

/** One function body between two anchors, used to prove what a handler does or does not send. */
function section(which, start, end) {
  const body = bodies[which]
  const at = body.indexOf(start)
  assert(at !== -1, 'missing "' + start + '" in ' + rel(FILES[which]))
  const to = body.indexOf(end, at + start.length)
  assert(to !== -1, 'missing "' + end + '" after "' + start + '"')
  return body.slice(at, to + end.length)
}

/** The keys of one i18n catalog, read by brace scanning so the probe needs no TypeScript. */
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

// ── the pure tree rules, run for real ───────────────────────────────────────
// The two TSX modules are transpiled with esbuild and imported against stubs, so grouping, the
// filter, the deny arithmetic and the switch guard are measured instead of matched as text.

const stubs = {
  'react.stub.mjs': [
    'export const Fragment = Symbol.for("Fragment")',
    'export const createElement = () => null',
    'export const useState = () => [undefined, () => {}]',
    'export const useMemo = run => run()',
    'export const useCallback = run => run',
    'export const useEffect = () => {}',
    'export const useRef = value => ({ current: value })',
    'export default { Fragment, createElement, useState, useMemo, useCallback, useEffect, useRef }',
  ].join('\n'),
  'components.stub.mjs': 'export const Badge = () => null\nexport const Switch = () => null\n',
  'i18n.stub.mjs': 'export const createT = () => key => key\n',
}

/** Import specifiers the stubs replace; every relative source path becomes a temp sibling. */
const SPECIFIERS = [
  ['react', './react.stub.mjs'],
  ['../components.js', './components.stub.mjs'],
  ['../i18n.js', './i18n.stub.mjs'],
  ['./package-tree.js', './package-tree.mjs'],
]

function rewrite(text) {
  let out = text
  for (const [from, to] of SPECIFIERS) {
    out = out.split('from "' + from + '"').join('from "' + to + '"')
    out = out.split("from '" + from + "'").join('from "' + to + '"')
  }
  return out
}

function transpile(file) {
  return transformSync(read(file), { loader: 'tsx', format: 'esm', target: 'node20', jsx: 'transform' }).code
}

let treeApi = null
let loadError = null
try {
  const dir = mkdtempSync(join(tmpdir(), 'tool-hub-tree-'))
  for (const [name, text] of Object.entries(stubs)) writeFileSync(join(dir, name), text)
  writeFileSync(join(dir, 'package-tree.mjs'), rewrite(transpile(SHARED)))
  writeFileSync(join(dir, 'tools-tree.mjs'), rewrite(transpile(TREE)))
  treeApi = await import(pathToFileURL(join(dir, 'tools-tree.mjs')).href)
  rmSync(dir, { recursive: true, force: true })
}
catch (error) {
  loadError = error instanceof Error ? error : new Error(String(error))
}

function requireTree() {
  assert(loadError === null, 'the tree module did not load: ' + (loadError === null ? '' : loadError.message))
  return treeApi
}

/** Rows as the snapshot reports them: two servers (one with a fixed tool), three built-in prefixes. */
const FIXTURE = [
  { name: 'browser_navigate', enabled: true, server: 'playwright' },
  { name: 'browser_click', enabled: false, server: 'playwright' },
  { name: 'browser_snapshot', enabled: true, server: 'playwright', lazy: true, lazyHidden: true },
  { name: 'gh_issue', enabled: true, server: 'github', fixed: true },
  { name: 'task_list', enabled: true },
  { name: 'task_get', enabled: false },
  { name: 'todo_write', enabled: true },
  { name: 'info', enabled: true },
  { name: 'util_cache', enabled: true },
  { name: 'util_read', enabled: true },
  { name: 'util_write', enabled: false },
]

const FIXTURE_JSON = JSON.stringify(FIXTURE)
const LABELS = { 'tree.builtin': 'Built-in tools', 'tree.builtinOther': 'Other built-in' }
const t = (key, vars) => {
  const base = LABELS[key] === undefined ? key : LABELS[key]
  return vars === undefined ? base : base + ' ' + String(vars.name)
}
const build = term => requireTree().buildToolTree(FIXTURE, term, t)
const groupOf = (tree, key) => tree.groups.find(group => group.key === key)
const namesOf = group => group.rows.map(row => row.name).join(',')
const OPS = ['tool.save', 'tool.plan', 'lazy.set', 'lazy.load', 'lazy.unload', 'lazy.reset']

// ── the view exists and is mounted ──────────────────────────────────────────

check('view-export', () => {
  assert(/export function ToolsView\(props: ViewProps\): React\.ReactElement/.test(sources.view), 'tools.tsx must export ToolsView(props: ViewProps)')
  assert((sources.view.match(/export function ToolsView/g) ?? []).length === 1, 'ToolsView must be exported exactly once')
  assert(/import \* as React from 'react'/.test(sources.view), 'the view must import React')
  assert(/import type \{[^}]*\bViewProps\b[^}]*\} from '\.\.\/types\.js'/.test(sources.view), 'ViewProps must come from ../types.js')
  assert(/import \{[^}]*\bToolsTree\b[^}]*\} from '\.\/tools-tree\.js'/.test(sources.view), 'the view must render the shared tools tree')
  return 'ToolsView exported once with ViewProps, tree imported'
})

check('shell-wiring', () => {
  assert(/import \{ ToolsView \} from '\.\/views\/tools\.js'/.test(shell), 'the shell must import ToolsView from ./views/tools.js')
  assert(/tools: <ToolsView snapshot=\{snapshot\}/.test(shell), 'the shell must mount ToolsView with the snapshot')
  const entries = (shell.match(/id: 'tools'/g) ?? []).length
  assert(entries === 1, 'exactly one nav entry may carry id tools, found ' + entries)
  return 'one nav entry, one mount'
})

check('tree-module-loads', () => {
  const api = requireTree()
  for (const name of ['buildToolTree', 'nextDeny', 'denyOf', 'groupSwitchable', 'ToolsTree', 'TREE_STORAGE_KEY']) {
    assert(api[name] !== undefined, 'tools-tree.tsx does not export ' + name)
  }
  return 'esbuild transpile + stub import, six exports'
})

// ── ops: named by the view, owned by the domain ─────────────────────────────

check('required-ops', () => {
  for (const op of OPS) {
    assert(bodies.view.indexOf("'" + op + "'") !== -1, 'the view never names ' + op)
  }
  return OPS.length + ' op ids named by the view'
})

check('ops-registered', () => {
  for (const op of OPS) {
    const marker = new RegExp("'" + op.replace(/\./g, '\\.') + "'\\s*:")
    assert(marker.test(domain), 'tool-surface.ts does not register ' + op)
  }
  return 'every op is a tool-surface handler'
})

check('plan-report', () => {
  assert(/const PLAN = 'tool\.plan'/.test(bodies.view), 'the plan op id must live in one constant')
  assert(/runOp\(PLAN, \{\}\)/.test(bodies.view), 'the view must call runOp(PLAN, {})')
  for (const field of ['plan.description', 'plan.counts', 'plan.unreachable', 'plan.plan?.add', 'plan.plan?.remove']) {
    assert(bodies.view.includes(field), 'the report never renders ' + field)
  }
  assert(/readPlan\(result\.data\)/.test(bodies.view), 'the plan payload must be narrowed before rendering')
  assert(/setPlan\(null\)/.test(bodies.view), 'the report must be dismissable')
  assert(/setPlanError\(result\.message\)/.test(bodies.view), 'a failed plan must keep its message')
  assert(includes(bodies.view, '<Callout>'), 'a failed plan must reach a Callout')
  return 'fetched, rendered, dismissable, failure reported'
})

// ── the mask is a draft until a confirmed save ──────────────────────────────

check('mask-draft', () => {
  assert(includes(bodies.view, 'denyOf(snapshot.tools)'), 'the draft must start from the committed deny list')
  assert(/const mask = draft \?\? baseMask/.test(bodies.view), 'the draft must fall back to the snapshot')
  assert(/sameNames\(draft, baseMask\)/.test(bodies.view), 'dirty must compare the draft with the snapshot')
  const toggle = section('view', 'const toggleMask = React.useCallback(', '}, [mask])')
  assert(toggle.includes('setDraft('), 'a row switch must write the draft')
  assert(!/\brun\(/.test(toggle), 'a row switch must not send an op')
  assert(includes(bodies.view, "payload: { deny: mask, id: 'install' }"), 'the save payload must carry { deny, id }')
  assert(/disabled=\{!dirty\}/.test(bodies.view), 'save must stay disabled until the draft changes')
  return 'draft only, save carries deny'
})

check('confirm-before-write', () => {
  assert((bodies.view.match(/op: SAVE/g) ?? []).length === 1, 'only the save handler may ask with op: SAVE')
  assert((bodies.view.match(/void run\(/g) ?? []).length === 4, 'writes leave fire(), confirm(), the reset-all action and the parent switch')
  assert((bodies.view.match(/void run\(op, payload\)/g) ?? []).length === 1, 'the confirm handler is the only generic write')
  assert((bodies.view.match(/void run\(LAZY_RESET, \{\}\)/g) ?? []).length === 1, 'the third write is the reset-all action')
  const confirm = section('view', 'const confirm = React.useCallback(', '}, [pending, run])')
  const clear = confirm.indexOf('setPending(null)')
  const send = confirm.indexOf('void run(op, payload)')
  assert(clear !== -1 && send !== -1 && clear < send, 'the dialog must close before the op is sent')
  assert(/open=\{pending !== null\}/.test(bodies.view), 'the dialog must open on a pending request')
  assert(/title=\{t\('dialog\.confirmTitle'\)\}/.test(bodies.view), 'the dialog needs the confirm title')
  assert(/onClick=\{confirm\}/.test(bodies.view), 'the confirm button must run the pending request')
  assert(/onClick=\{stop\}/.test(bodies.view), 'cancel must close without sending')
  assert(includes(bodies.view, "t('action.confirm')"), 'the confirm button needs its label')
  assert(includes(bodies.view, "t('action.cancel')"), 'the cancel button needs its label')
  return 'every generic write passes the dialog'
})

// ── grouping: servers first, then built-in prefixes ─────────────────────────

check('tree-groups-by-server', () => {
  const tree = build('')
  const servers = tree.groups.filter(group => group.kind === 'mcp')
  assert(servers.length === 2, 'the fixture has two servers, got ' + servers.length)
  assert(servers[0].key === 'mcp:github' && servers[0].label === 'github', 'github must group under mcp:github')
  assert(servers[0].meta === 'MCP', 'an MCP parent carries the MCP meta')
  assert(namesOf(servers[0]) === 'gh_issue', 'github must hold exactly its own tool')
  assert(servers[1].key === 'mcp:playwright' && namesOf(servers[1]) === 'browser_navigate,browser_click,browser_snapshot', 'playwright must hold its three tools in snapshot order')
  assert(servers[1].enabled === 2, 'two of three playwright rows are enabled, got ' + servers[1].enabled)
  return servers.map(group => group.key + '(' + group.rows.length + ')').join(' ')
})

check('tree-groups-by-prefix', () => {
  const tree = build('')
  const prefixes = tree.groups.filter(group => group.kind === 'prefix')
  assert(prefixes.map(group => group.key).join(' ') === 'prefix:util prefix:other', 'only clusters of 3+ keep a prefix group: ' + prefixes.map(group => group.key).join(' '))
  assert(namesOf(prefixes[0]) === 'util_cache,util_read,util_write', 'util keeps its three tools')
  assert(prefixes[1].label === 'Other built-in', 'the small buckets merge into the other label')
  assert(namesOf(prefixes[1]) === 'task_list,task_get,todo_write,info', 'pairs, singletons and the fallback merge: ' + namesOf(prefixes[1]))
  assert(tree.groups[0].kind === 'mcp' && tree.groups[tree.groups.length - 1].kind === 'prefix', 'servers come first, prefixes after')
  return prefixes.map(group => group.key + '(' + group.rows.length + ')').join(' ')
})

// ── filtering: rows match, a parent label keeps its children ────────────────

check('tree-filter', () => {
  assert(build('').rows.length === FIXTURE.length, 'no term shows every row')
  const byName = build('browser_click')
  assert(byName.groups.length === 1 && namesOf(byName.groups[0]) === 'browser_click', 'a name term keeps one row in its parent')
  const byServer = build('github')
  assert(byServer.groups.length === 1 && byServer.groups[0].key === 'mcp:github', 'a server term keeps its parent')
  assert(namesOf(byServer.groups[0]) === 'gh_issue', 'the server term keeps its children')
  assert(build('zzz').groups.length === 0, 'no match leaves no group')
  assert(build('zzz').rows.length === 0, 'no match leaves no row')
  assert(build('  GITHUB  ').groups.length === 1, 'the term is trimmed and lowercased')
  return 'name, server, miss, trim'
})

check('tree-parent-label-match', () => {
  const byServerLabel = build('playwright')
  assert(byServerLabel.groups.length === 1, 'the server label keeps one parent')
  assert(namesOf(byServerLabel.groups[0]) === 'browser_navigate,browser_click,browser_snapshot', 'no tool name contains the server name, yet every child stays: ' + namesOf(byServerLabel.groups[0]))
  const byFallbackLabel = build('built-in')
  assert(byFallbackLabel.groups.length === 1 && byFallbackLabel.groups[0].key === 'prefix:other', 'the other label keeps its bucket')
  assert(namesOf(byFallbackLabel.groups[0]) === 'task_list,task_get,todo_write,info', 'the other bucket keeps children whose names never match')
  return 'server label 3/3, fallback label 1/1'
})

check('tree-no-mutation', () => {
  build('playwright')
  build('zzz')
  requireTree().nextDeny(['a'], ['b'], false)
  assert(JSON.stringify(FIXTURE) === FIXTURE_JSON, 'the tree must not mutate the snapshot rows')
  const deny = ['a', 'b']
  const next = requireTree().nextDeny(deny, ['b'], true)
  assert(next.join(',') === 'a', 'next deny must drop the enabled name')
  assert(deny.join(',') === 'a,b', 'the incoming deny list must not be mutated')
  return 'inputs untouched, result sorted'
})

// ── the parent write: full deny list from the snapshot ──────────────────────

check('tree-deny-arithmetic', () => {
  const api = requireTree()
  assert(api.denyOf(FIXTURE).join(',') === 'browser_click,task_get,util_write', 'denyOf must read !enabled: ' + api.denyOf(FIXTURE).join(','))
  assert(api.nextDeny([], ['b', 'a'], false).join(',') === 'a,b', 'disable adds and sorts: ' + api.nextDeny([], ['b', 'a'], false).join(','))
  assert(api.nextDeny(['a', 'b', 'c'], ['b'], true).join(',') === 'a,c', 'enable removes the names')
  assert(api.nextDeny(['a'], ['a'], false).join(',') === 'a', 'disabling a denied name is idempotent')
  assert(api.nextDeny(['a'], ['a'], true).join(',') === '', 'enabling the only denied name empties the list')
  return 'denyOf + add/remove/idempotent'
})

check('tree-bulk-write', () => {
  const bulk = section('view', 'const bulkGroup = React.useCallback(', '}, [baseMask, fire, run])')
  assert(includes(bulk, "group.key.startsWith('mcp:')") && includes(bulk, 'fire(LAZY_SET, server, { server, on: !next })'), 'an MCP parent toggles its lazy server')
  assert(includes(bulk, 'nextDeny(baseMask, group.rows.map(row => row.name), next)'), 'a prefix parent computes from the committed deny list')
  assert(includes(bulk, 'void run(SAVE, { deny, id: group.key })'), 'a prefix parent sends tool.save with { deny, id }')
  assert(includes(bodies.view, 'onBulk={bulkGroup}'), 'the tree must receive the parent handler')
  assert(includes(bodies.view, 'busy.startsWith(SAVE + ') && includes(bodies.view, 'busy.startsWith(LAZY_SET + '), 'the parent switch tracks both write ops')
  return 'MCP parent -> lazy.set; prefix parent -> tool.save'
})

check('tree-switch-guard', () => {
  const api = requireTree()
  const tree = build('')
  assert(groupOf(tree, 'mcp:github').switchable === true, 'every MCP server gets a lazy parent switch')
  assert(groupOf(tree, 'mcp:playwright').switchable === true, 'a fully restrictable server group may switch')
  assert(groupOf(tree, 'prefix:util').switchable === false, 'built-in groups never carry a parent switch')
  assert(groupOf(tree, 'prefix:other').switchable === false, 'the merged bucket never carries a parent switch')
  assert(api.groupSwitchable([]) === false, 'an empty group is not switchable')
  assert(api.groupSwitchable([{ name: 'x', enabled: true, fixed: true }]) === false, 'groupSwitchable reads fixed')
  assert(api.groupSwitchable([{ name: 'x', enabled: true }]) === true, 'groupSwitchable accepts plain rows')
  assert(/switchable: kind === 'mcp'/.test(bodies.tree), 'the tree must gate switchable on the MCP kind')
  return 'MCP parents switch lazy, built-ins blocked'
})

// ── expansion: remembered, collapsed by default, forced open on search ─────

check('tree-storage-key', () => {
  const api = requireTree()
  assert(api.TREE_STORAGE_KEY === 'tool-hub-tree-tools', 'the storage key must be tool-hub-tree-tools, got ' + api.TREE_STORAGE_KEY)
  assert(/export const TREE_STORAGE_KEY = 'tool-hub-tree-tools'/.test(sources.tree), 'the key must be one exported constant')
  assert(includes(bodies.tree, 'useTreeExpansion(TREE_STORAGE_KEY)'), 'the component must remember its expansion under that key')
  assert(!includes(bodies.tree, 'localStorage'), 'storage access stays in the shared hook, not in this view')
  return 'tool-hub-tree-tools'
})

check('tree-default-collapsed', () => {
  const hook = section('shared', 'export function useTreeExpansion(storageKey: string)', 'return {')
  assert(includes(hook, 'new Set()'), 'the hook must start from an empty set')
  assert(!includes(hook, 'add('), 'the hook must not open anything by itself')
  assert(!/setOpen\(new Set\(\[/.test(bodies.tree), 'the tree may not seed open parents')
  return 'empty start, storage only'
})

check('tree-force-open-on-search', () => {
  assert(includes(bodies.view, "forceOpen={term !== ''}"), 'the search term must drive forceOpen')
  assert(includes(bodies.tree, 'forceOpen={forceOpen}'), 'the component must forward forceOpen to GroupTree')
  assert(includes(bodies.shared, 'const open = forceOpen || expansion.isOpen(group.key)'), 'the shared tree must honour forceOpen over the stored state')
  return 'term -> forceOpen -> every parent open'
})

check('tree-parent-switch-visible', () => {
  assert(includes(bodies.shared, 'onBulk === undefined || group.switchable !== true ? null : ('), 'the shared tree renders the parent switch only for switchable groups')
  assert(includes(bodies.tree, 'onBulk={onBulk}'), 'the tools tree must pass the parent handler down')
  return 'switch only when switchable'
})

// ── the other cards stay where they were ────────────────────────────────────

check('tree-cards-untouched', () => {
  for (const card of ['<OnDemandCard {...props} />', '<ScopeCard {...props} />']) {
    assert(includes(bodies.view, card), 'tools.tsx must keep ' + card)
  }
  assert(/<Card label=\{t\('tools\.lazy'\)\}>/.test(bodies.view), 'the lazy card must keep its own card')
  assert(/entry\.lazy \? \(/.test(bodies.view), 'the lazy card must keep its load/unload controls')
  assert(/<Select[^>]*th-lazy-session/.test(bodies.view), 'the lazy card must keep its scope selector')
  return 'lazy, scope and on-demand cards untouched'
})

// ── empty states ────────────────────────────────────────────────────────────

check('lazy-session-selector', () => {
  assert(includes(bodies.view, 'th-lazy-session'), 'the lazy card needs a scope selector')
  assert(includes(bodies.view, 'snapshot.sessionList.map'), 'the selector must offer the host session list')
  assert(includes(bodies.view, "'全局（所有会话）'"), 'the default option is global')
  assert(includes(bodies.view, 'sessionId: lazySession'), 'loads must carry the chosen session')
  return 'global default + session option'
})

check('empty-state', () => {
  assert(/if \(snapshot\.tools\.length === 0\)/.test(bodies.view), 'an empty inventory needs its own branch')
  assert((bodies.view.match(/t\('tools\.empty'\)/g) ?? []).length >= 2, 'both empty states must use tools.empty')
  assert(/rows\.length === 0/.test(bodies.view), 'a filtered list needs an empty state too')
  assert(/void reload\(\)/.test(bodies.view), 'the empty state must offer a reload')
  assert(includes(bodies.view, "t('action.retry')"), 'the reload must be labelled')
  return 'empty inventory and empty filter'
})

// ── accessibility, structure, colour ────────────────────────────────────────

check('accessible-labels', () => {
  const switches = (bodies.view.match(/<Switch/g) ?? []).length + (bodies.tree.match(/<Switch/g) ?? []).length
  const named = (bodies.view.match(/label=\{t\('a11y\.switch'/g) ?? []).length + (bodies.tree.match(/label=\{t\('a11y\.switch'/g) ?? []).length
  assert((bodies.view.match(/<Switch/g) ?? []).length === 1, 'the view keeps exactly the lazy server switch')
  assert((bodies.tree.match(/<Switch/g) ?? []).length === 1, 'the tree owns exactly the row switch')
  assert(named === switches, 'every switch needs an accessible name, ' + named + '/' + switches)
  assert(/label=\{t\('tools\.search'\)\}/.test(bodies.view), 'the search box needs a label')
  assert((bodies.view.match(/<Card label=/g) ?? []).length >= 2, 'cards must name their group')
  assert(/label=\{t\('action\.close'\)\}/.test(bodies.view), 'the dismiss button needs a name')
  assert(!/<\s*(input|button)\b/.test(bodies.view + bodies.tree), 'raw input/button elements belong to components.tsx')
  return switches + ' named switches, labelled controls, no raw form elements'
})

check('no-literal-colours', () => {
  for (const which of ['view', 'tree']) {
    const body = bodies[which]
    const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(body)
    assert(match === null, rel(FILES[which]) + ': a literal colour at line ' + lineAt(body, match === null ? 0 : match.index))
    for (const style of body.matchAll(/style=\{\{([\s\S]*?)\}\}/g)) {
      assert(!/\b(?:color|background|backgroundColor|borderColor)\s*:/.test(style[1]), 'a style prop carries a colour')
    }
  }
  assert(/className="th-/.test(bodies.view) || /className="th-/.test(bodies.tree), 'layout comes from the th-* classes')
  return 'th-* classes only'
})

check('no-html-injection', () => {
  for (const which of ['view', 'tree']) {
    for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert(bodies[which].indexOf(pattern) === -1, rel(FILES[which]) + ' uses ' + pattern)
    }
  }
  return 'no HTML string injection'
})

check('no-todo', () => {
  for (const which of ['view', 'tree']) {
    const at = sources[which].search(/TODO\(|FIXME|XXX:/)
    assert(at === -1, rel(FILES[which]) + ':' + lineAt(sources[which], at) + ' still carries a TODO marker')
  }
  return 'no TODO/FIXME'
})

check('imports', () => {
  const allowed = {
    view: new Set(['react', '../api.js', '../components.js', '../types.js', './package-tree.js', './scope-card.js', './on-demand-card.js', './tools-tree.js']),
    tree: new Set(['react', '../components.js', '../types.js', '../i18n.js', './package-tree.js']),
  }
  for (const which of ['view', 'tree']) {
    for (const match of bodies[which].matchAll(/from '([^']+)'/g)) {
      assert(allowed[which].has(match[1]), rel(FILES[which]) + ": unexpected import '" + match[1] + "'")
    }
    assert(!/from 'node:/.test(bodies[which]), rel(FILES[which]) + ' must not import node builtins')
    assert(!/\.\.\/domains\//.test(bodies[which]), rel(FILES[which]) + ' must not import a host domain')
  }
  return 'allowed imports only'
})

check('tree-shared-primitives', () => {
  assert(includes(sources.tree, "import { GroupTree, groupByPrefix, useTreeExpansion } from './package-tree.js'"), 'one import line, three shared primitives')
  assert(/import type \{ TreeGroup \} from '\.\/package-tree\.js'/.test(sources.tree), 'the tree must type its groups with the shared TreeGroup')
  assert(/export interface TreeGroup<T>/.test(sources.shared) && /export function groupByPrefix/.test(sources.shared), 'the shared module must still export what the tools tree uses')
  return 'package-tree reused, not copied'
})

check('file-length', () => {
  const viewLines = sources.view.split('\n').length
  const treeLines = sources.tree.split('\n').length
  assert(viewLines < 450, 'tools.tsx has ' + viewLines + ' lines (limit 450)')
  assert(statSync(VIEW).size < 80 * 1024, 'tools.tsx is ' + statSync(VIEW).size + ' bytes (limit 80 KB)')
  assert(treeLines < 300, 'tools-tree.tsx has ' + treeLines + ' lines (limit 300)')
  assert(statSync(TREE).size < 64 * 1024, 'tools-tree.tsx is ' + statSync(TREE).size + ' bytes (limit 64 KB)')
  return viewLines + ' + ' + treeLines + ' lines'
})

// ── contract with ToolRow and with the catalogs ─────────────────────────────

check('tool-row-fields', () => {
  const stripped = (bodies.view + '\n' + bodies.tree).replace(/'[^']*'/g, "''")
  const fields = new Set([...stripped.matchAll(/\btool\.([A-Za-z]+)/g)].map(match => match[1]))
  for (const field of fields) assert(['name', 'enabled', 'server', 'lazy', 'lazyHidden', 'fixed'].includes(field), 'ToolRow has no field ' + field)
  for (const field of ['name', 'enabled', 'server', 'lazy', 'lazyHidden', 'fixed']) assert(fields.has(field), 'the tools views never read tool.' + field)
  const entries = new Set([...bodies.view.replace(/'[^']*'/g, "''").matchAll(/\bentry\.([A-Za-z]+)/g)].map(match => match[1]))
  for (const field of entries) assert(['server', 'tools', 'lazy', 'hidden'].includes(field), 'ServerEntry has no field ' + field)
  return [...fields].sort().join(', ') + ' / entry ' + [...entries].sort().join(', ')
})

check('i18n-resolved', () => {
  const zh = catalogKeys('zh')
  const en = catalogKeys('en')
  const used = new Set()
  for (const which of ['view', 'tree']) {
    for (const match of bodies[which].matchAll(/\bt\('([^']+)'/g)) {
      used.add(match[1])
      assert(zh.has(match[1]), "t('" + match[1] + "') is not in the zh catalog")
      assert(en.has(match[1]), "t('" + match[1] + "') is not in the en catalog")
    }
  }
  const required = ['tools.title', 'tools.empty', 'tools.search', 'tools.count', 'tools.masked', 'tools.visible',
    'tools.lazy', 'tools.plan', 'action.save', 'action.confirm', 'action.cancel', 'action.close',
    'action.retry', 'action.clear', 'a11y.switch', 'dialog.confirmTitle', 'tree.builtin']
  for (const key of required) assert(used.has(key), 'the tools views never call t(' + key + ')')
  return used.size + ' keys used, all resolved, no new i18n key needed'
})

// ── one check per interactive action ────────────────────────────────────────

check('action-search', () => {
  assert(/onChange=\{setQuery\}/.test(bodies.view), 'the search box must own its value')
  assert(/query\.trim\(\)\.toLowerCase\(\)/.test(bodies.view), 'the filter must be case-insensitive')
  assert(/buildToolTree\(snapshot\.tools, term, t\)/.test(bodies.view), 'the filter must run through the tree builder')
  assert(/onClear=\{\(\) => \{ setQuery\(''\) \}\}/.test(bodies.view), 'clear must reset the filter')
  assert(/clearLabel=\{t\('action\.clear'\)\}/.test(bodies.view), 'the clear control needs a label')
  return 'name or server match through the tree, clearable'
})

check('action-mask-toggle', () => {
  assert(/onChange=\{next => \{ onToggle\(tool\.name, !next\) \}\}/.test(bodies.tree), 'the row switch must feed the draft through onToggle')
  assert(/onToggle=\{toggleMask\}/.test(bodies.view), 'the tree must receive the draft handler')
  const toggle = section('view', 'const toggleMask = React.useCallback(', '}, [mask])')
  assert(/new Set\(mask\)/.test(toggle), 'the draft is copied before it is edited')
  assert(/next\.add\(name\)/.test(toggle) && /next\.delete\(name\)/.test(toggle), 'the switch must mask and unmask')
  assert(/setDraft\(\[\.\.\.next\]\.sort\(\)\)/.test(toggle), 'the draft stays a sorted name list')
  return 'switch edits the draft both ways'
})

check('action-save', () => {
  assert(/onClick=\{askSave\}/.test(bodies.view), 'the save button must ask first')
  const ask = section('view', 'const askSave = React.useCallback(', '}, [lang, mask])')
  assert(ask.includes('op: SAVE'), 'the request must name tool.save')
  assert(includes(ask, "payload: { deny: mask, id: 'install' }"), 'the payload must be { deny, id }')
  assert(/mask\.length/.test(ask), 'the confirmation must state the list size')
  assert(includes(bodies.view, 'busy === ' + tmpl(expr('SAVE') + ':install')), 'the save button must show the op in flight')
  return 'confirmed save with { deny }'
})

check('action-plan', () => {
  assert(/busy=\{planning\}/.test(bodies.view), 'the plan button must show its own busy state')
  assert(/void loadPlan\(\)/.test(bodies.view), 'the plan button must load the report')
  const load = section('view', 'const loadPlan = React.useCallback(', '}, [])')
  assert(load.includes('setPlanning(true)'), 'the report load must mark itself busy')
  assert(load.includes('runOp(PLAN, {})'), 'the report read must go through runOp')
  assert(load.includes('setPlanning(false)'), 'the report load must clear busy in both outcomes')
  return 'read-only plan fetch with local busy'
})

check('action-lazy-switch', () => {
  assert(/onChange=\{next => \{ askLazy\(entry, next\) \}\}/.test(bodies.view), 'the server switch must ask before hiding tools')
  assert(/checked=\{entry\.lazy\}/.test(bodies.view), 'the server switch reflects the lazy flag')
  assert(includes(bodies.view, 'busy === ' + tmpl(expr('LAZY_SET') + ':' + expr('entry.server'))), 'the switch must key its busy state')
  const ask = section('view', 'const askLazy = React.useCallback(', '}, [fire, lang])')
  assert(ask.includes('on: true'), 'turning lazy on must be confirmed')
  assert(ask.includes('on: false'), 'turning lazy off must be a direct write')
  return 'on asks, off sends'
})

check('action-lazy-load', () => {
  assert(includes(bodies.view, 'fire(LAZY_LOAD, entry.server, { names: entry.tools, load: true'), 'load must send the server names and the chosen session')
  assert(includes(bodies.view, 'busy === ' + tmpl(expr('LAZY_LOAD') + ':' + expr('entry.server'))), 'load must key its busy state')
  assert(includes(bodies.view, "lang === 'zh' ? '全部加载' : 'Load all'"), 'the load button needs a bilingual label')
  return 'names + load:true, per row'
})

check('action-lazy-unload', () => {
  assert(includes(bodies.view, 'fire(LAZY_UNLOAD, entry.server, { names: entry.tools, load: false'), 'unload must send the server names and the chosen session')
  assert(includes(bodies.view, 'busy === ' + tmpl(expr('LAZY_UNLOAD') + ':' + expr('entry.server'))), 'unload must key its busy state')
  assert(includes(bodies.view, "lang === 'zh' ? '全部卸载' : 'Unload all'"), 'the unload button needs a bilingual label')
  return 'names + load:false, per row'
})

check('action-dialog-cancel', () => {
  assert(/onClose=\{stop\}/.test(bodies.view), 'closing the dialog must clear the request')
  const stop = section('view', 'const stop = React.useCallback(', '}, [])')
  assert(!/\brun\(/.test(stop), 'cancel must never send')
  assert(stop.includes('setPending(null)'), 'cancel must clear the pending request')
  return 'cancel clears, sends nothing'
})

check('action-empty-retry', () => {
  const block = section('view', '<Empty', '/>')
  assert(includes(block, "t('tools.empty')"), 'the empty state needs its title key')
  assert(block.includes('void reload()'), 'the empty state must offer a reload')
  assert(includes(block, "t('action.retry')"), 'the reload must be labelled')
  assert(block.includes('<Button'), 'the retry must be a real button')
  return 'retry button in the empty state'
})

check('action-plan-dismiss', () => {
  const at = bodies.view.indexOf('{plan === null ? null : (')
  assert(at !== -1, 'the plan card must be conditional')
  const card = bodies.view.slice(at)
  assert(card.includes('setPlan(null)'), 'the plan card needs a dismiss control')
  assert(includes(card, "t('action.close')"), 'the dismiss control needs its label')
  return 'dismissable report card'
})

check('busy-keys', () => {
  const keys = [
    'busy === ' + tmpl(expr('SAVE') + ':install'),
    'busy === ' + tmpl(expr('LAZY_SET') + ':' + expr('entry.server')),
    'busy === ' + tmpl(expr('LAZY_LOAD') + ':' + expr('entry.server')),
    'busy === ' + tmpl(expr('LAZY_UNLOAD') + ':' + expr('entry.server')),
    'busy === ' + tmpl(expr('pending.op') + ':' + expr('pending.id')),
  ]
  for (const key of keys) assert(bodies.view.includes(key), 'missing busy key ' + key)
  assert(bodies.view.includes('void run(op, { ...payload, id })'), 'fire() must carry the row id')
  assert(includes(bodies.view, 'busyKey={bulkBusy}'), 'the tree must receive the parent busy key')
  assert(includes(bodies.tree, 'busyKey={busyKey}'), 'the component must forward the busy key')
  return keys.length + ' op:id keys, ids travel in the payload'
})

// ── report ──────────────────────────────────────────────────────────────────

console.log(passed + '/' + (passed + failures.length) + ' checks passed')
if (failures.length > 0) {
  console.log('failed: ' + failures.join(', '))
  process.exit(1)
}
