#!/usr/bin/env node
/**
 * probe/next/client-tools.mjs — the tools view (task-10), checked from outside.
 *
 * Static gates only: the probe reads the view, the domain that owns the ops, the shell and the
 * catalogs, and asserts the properties the page must keep. No host, no browser, no writes.
 *
 * Coverage:
 *   1. the exported view exists and the shell mounts it;
 *   2. the five tool-surface ops are named by the view and registered by the domain;
 *   3. the merge plan is fetched, rendered and dismissable;
 *   4. the mask is a draft until a confirmed save, so a row switch never writes;
 *   5. the empty states are retryable and use a tools.empty key;
 *   6. every control carries an accessible name and no raw form element lives here;
 *   7. layout comes from th-* classes, never a literal colour;
 *   8. the file stays inside the agreed length;
 *   9. one check per interactive action, with busy keys in the op:id form;
 *  10. every t() key resolves in both catalogs.
 *
 * No dependencies: PASS/FAIL lines, exit 1 when anything fails.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = join(ROOT, 'src', 'client', 'views', 'tools.tsx')
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

const source = read(VIEW)
const body = code(source)
const domain = read(DOMAIN)
const shell = read(SHELL)
const i18nSource = read(I18N)

/** One function body between two anchors, used to prove a handler does or does not send. */
function section(start, end) {
  const at = body.indexOf(start)
  assert(at !== -1, 'missing "' + start + '" in ' + rel(VIEW))
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

const OPS = ['tool.save', 'tool.plan', 'lazy.set', 'lazy.load', 'lazy.unload']

// ── the view exists and is mounted ──────────────────────────────────────────

check('view-export', () => {
  assert(/export function ToolsView\(props: ViewProps\): React\.ReactElement/.test(source), 'tools.tsx must export ToolsView(props: ViewProps)')
  assert((source.match(/export function ToolsView/g) ?? []).length === 1, 'ToolsView must be exported exactly once')
  assert(/import \* as React from 'react'/.test(source), 'the view must import React')
  assert(/import type \{[^}]*\bViewProps\b[^}]*\} from '\.\.\/types\.js'/.test(source), 'ViewProps must come from ../types.js')
  return 'ToolsView exported once with ViewProps'
})

check('shell-wiring', () => {
  assert(/import \{ ToolsView \} from '\.\/views\/tools\.js'/.test(shell), 'the shell must import ToolsView from ./views/tools.js')
  assert(/tools: <ToolsView snapshot=\{snapshot\}/.test(shell), 'the shell must mount ToolsView with the snapshot')
  const entries = (shell.match(/id: 'tools'/g) ?? []).length
  assert(entries === 1, 'exactly one nav entry may carry id tools, found ' + entries)
  return 'one nav entry, one mount'
})

// ── ops: named by the view, owned by the domain ─────────────────────────────

check('required-ops', () => {
  for (const op of OPS) {
    assert(body.indexOf("'" + op + "'") !== -1, 'the view never names ' + op)
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
  assert(/const PLAN = 'tool\.plan'/.test(body), 'the plan op id must live in one constant')
  assert(/runOp\(PLAN, \{\}\)/.test(body), 'the view must call runOp(PLAN, {})')
  for (const field of ['plan.description', 'plan.counts', 'plan.unreachable', 'plan.plan?.add', 'plan.plan?.remove']) {
    assert(body.includes(field), 'the report never renders ' + field)
  }
  assert(/readPlan\(result\.data\)/.test(body), 'the plan payload must be narrowed before rendering')
  assert(/setPlan\(null\)/.test(body), 'the report must be dismissable')
  assert(/setPlanError\(result\.message\)/.test(body), 'a failed plan must keep its message')
  assert(includes(body, '<Callout>'), 'a failed plan must reach a Callout')
  return 'fetched, rendered, dismissable, failure reported'
})

// ── the mask is a draft until a confirmed save ──────────────────────────────

check('mask-draft', () => {
  assert(/snapshot\.tools\.filter\(tool => !tool\.enabled\)/.test(body), 'the draft must start from the installation mask')
  assert(/const mask = draft \?\? baseMask/.test(body), 'the draft must fall back to the snapshot')
  assert(/sameNames\(draft, baseMask\)/.test(body), 'dirty must compare the draft with the snapshot')
  const toggle = section('const toggleMask = React.useCallback(', '}, [mask])')
  assert(toggle.includes('setDraft('), 'a row switch must write the draft')
  assert(!/\brun\(/.test(toggle), 'a row switch must not send an op')
  assert(includes(body, "payload: { deny: mask, id: 'install' }"), 'the save payload must carry { deny, id }')
  assert(/disabled=\{!dirty\}/.test(body), 'save must stay disabled until the draft changes')
  return 'draft only, save carries deny'
})

check('confirm-before-write', () => {
  assert((body.match(/op: SAVE/g) ?? []).length === 1, 'tool.save may only be asked from the save handler')
  assert((body.match(/void run\(/g) ?? []).length === 2, 'writes may only leave fire() and confirm()')
  const confirm = section('const confirm = React.useCallback(', '}, [pending, run])')
  const clear = confirm.indexOf('setPending(null)')
  const send = confirm.indexOf('void run(op, payload)')
  assert(clear !== -1 && send !== -1 && clear < send, 'the dialog must close before the op is sent')
  assert(/open=\{pending !== null\}/.test(body), 'the dialog must open on a pending request')
  assert(/title=\{t\('dialog\.confirmTitle'\)\}/.test(body), 'the dialog needs the confirm title')
  assert(/onClick=\{confirm\}/.test(body), 'the confirm button must run the pending request')
  assert(/onClick=\{stop\}/.test(body), 'cancel must close without sending')
  assert(includes(body, "t('action.confirm')"), 'the confirm button needs its label')
  assert(includes(body, "t('action.cancel')"), 'the cancel button needs its label')
  return 'every write passes the dialog'
})

// ── empty states ────────────────────────────────────────────────────────────

check('empty-state', () => {
  assert(/if \(snapshot\.tools\.length === 0\)/.test(body), 'an empty inventory needs its own branch')
  assert((body.match(/t\('tools\.empty'\)/g) ?? []).length >= 2, 'both empty states must use tools.empty')
  assert(/rows\.length === 0/.test(body), 'a filtered list needs an empty state too')
  assert(/void reload\(\)/.test(body), 'the empty state must offer a reload')
  assert(includes(body, "t('action.retry')"), 'the reload must be labelled')
  return 'empty inventory and empty filter'
})

// ── accessibility, structure, colour ────────────────────────────────────────

check('accessible-labels', () => {
  const switches = (body.match(/<Switch/g) ?? []).length
  const named = (body.match(/label=\{t\('a11y\.switch'/g) ?? []).length
  assert(switches === 2, 'expected one switch per tool row and one per lazy server, found ' + switches)
  assert(named === switches, 'every switch needs an accessible name, ' + named + '/' + switches)
  assert(/label=\{t\('tools\.search'\)\}/.test(body), 'the search box needs a label')
  assert((body.match(/<Card label=/g) ?? []).length >= 2, 'cards must name their group')
  assert(/label=\{t\('action\.close'\)\}/.test(body), 'the dismiss button needs a name')
  assert(/title=\{t\('dialog\.confirmTitle'\)\}/.test(body), 'the dialog needs a title')
  assert(!/<\s*(input|button)\b/.test(body), 'raw input/button elements belong to components.tsx')
  return switches + ' named switches, labelled controls, no raw form elements'
})

check('no-literal-colours', () => {
  const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(body)
  assert(match === null, 'a literal colour at line ' + lineAt(body, match === null ? 0 : match.index))
  for (const style of body.matchAll(/style=\{\{([\s\S]*?)\}\}/g)) {
    assert(!/\b(?:color|background|backgroundColor|borderColor)\s*:/.test(style[1]), 'a style prop carries a colour')
  }
  assert(/className="th-/.test(body), 'layout comes from the th-* classes')
  return 'th-* classes only'
})

check('no-html-injection', () => {
  for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert(body.indexOf(pattern) === -1, 'the view uses ' + pattern)
  }
  return 'no HTML string injection'
})

check('no-todo', () => {
  const at = source.search(/TODO\(|FIXME|XXX:/)
  assert(at === -1, 'tools.tsx:' + lineAt(source, at) + ' still carries a TODO marker')
  return 'no TODO/FIXME'
})

check('imports', () => {
  const allowed = new Set(['react', '../api.js', '../components.js', '../types.js', './scope-card.js', './on-demand-card.js'])
  for (const match of body.matchAll(/from '([^']+)'/g)) {
    assert(allowed.has(match[1]), "unexpected import '" + match[1] + "'")
  }
  assert(!/from 'node:/.test(body), 'the view must not import node builtins')
  assert(!/\.\.\/domains\//.test(body), 'the view must not import a host domain')
  return allowed.size + ' allowed imports only'
})

check('file-length', () => {
  const lines = source.split('\n').length
  const bytes = statSync(VIEW).size
  assert(lines < 450, 'tools.tsx has ' + lines + ' lines (limit 450)')
  assert(bytes < 80 * 1024, 'tools.tsx is ' + bytes + ' bytes (limit 80 KB)')
  return lines + ' lines, ' + bytes + ' bytes'
})

// ── contract with ToolRow and with the catalogs ─────────────────────────────

check('tool-row-fields', () => {
  const stripped = body.replace(/'[^']*'/g, "''")
  const fields = new Set([...stripped.matchAll(/\btool\.([A-Za-z]+)/g)].map(match => match[1]))
  for (const field of fields) assert(['name', 'enabled', 'server', 'lazy', 'fixed'].includes(field), 'ToolRow has no field ' + field)
  for (const field of ['name', 'enabled', 'server', 'lazy', 'fixed']) assert(fields.has(field), 'the view never reads tool.' + field)
  const entries = new Set([...stripped.matchAll(/\bentry\.([A-Za-z]+)/g)].map(match => match[1]))
  for (const field of entries) assert(['server', 'tools', 'lazy'].includes(field), 'ServerEntry has no field ' + field)
  return [...fields].sort().join(', ') + ' / entry ' + [...entries].sort().join(', ')
})

check('i18n-resolved', () => {
  const zh = catalogKeys('zh')
  const en = catalogKeys('en')
  const used = new Set()
  for (const match of body.matchAll(/\bt\('([^']+)'/g)) {
    used.add(match[1])
    assert(zh.has(match[1]), "t('" + match[1] + "') is not in the zh catalog")
    assert(en.has(match[1]), "t('" + match[1] + "') is not in the en catalog")
  }
  const required = ['tools.title', 'tools.empty', 'tools.search', 'tools.count', 'tools.masked', 'tools.visible',
    'tools.lazy', 'tools.server', 'tools.plan', 'action.save', 'action.confirm', 'action.cancel', 'action.close',
    'action.retry', 'action.clear', 'a11y.switch', 'dialog.confirmTitle']
  for (const key of required) assert(used.has(key), 'the view never calls t(' + key + ')')
  return used.size + ' keys used, all resolved, no new i18n key needed'
})

// ── one check per interactive action ────────────────────────────────────────

check('action-search', () => {
  assert(/onChange=\{setQuery\}/.test(body), 'the search box must own its value')
  assert(/query\.trim\(\)\.toLowerCase\(\)/.test(body), 'the filter must be case-insensitive')
  assert(/tool\.name\.toLowerCase\(\)\.includes\(term\)/.test(body), 'the filter must match the tool name')
  assert(/\(tool\.server \?\? ''\)\.toLowerCase\(\)\.includes\(term\)/.test(body), 'the filter must match the server')
  assert(/onClear=\{\(\) => \{ setQuery\(''\) \}\}/.test(body), 'clear must reset the filter')
  assert(/clearLabel=\{t\('action\.clear'\)\}/.test(body), 'the clear control needs a label')
  return 'name or server match, clearable'
})

check('action-mask-toggle', () => {
  assert(/onChange=\{next => \{ toggleMask\(tool\.name, !next\) \}\}/.test(body), 'the row switch must feed the draft')
  const toggle = section('const toggleMask = React.useCallback(', '}, [mask])')
  assert(/new Set\(mask\)/.test(toggle), 'the draft is copied before it is edited')
  assert(/next\.add\(name\)/.test(toggle) && /next\.delete\(name\)/.test(toggle), 'the switch must mask and unmask')
  assert(/setDraft\(\[\.\.\.next\]\.sort\(\)\)/.test(toggle), 'the draft stays a sorted name list')
  return 'switch edits the draft both ways'
})

check('action-save', () => {
  assert(/onClick=\{askSave\}/.test(body), 'the save button must ask first')
  const ask = section('const askSave = React.useCallback(', '}, [lang, mask])')
  assert(ask.includes('op: SAVE'), 'the request must name tool.save')
  assert(includes(ask, "payload: { deny: mask, id: 'install' }"), 'the payload must be { deny, id }')
  assert(/mask\.length/.test(ask), 'the confirmation must state the list size')
  assert(includes(body, 'busy === `${SAVE}:install`'), 'the save button must show the op in flight')
  return 'confirmed save with { deny }'
})

check('action-plan', () => {
  assert(/busy=\{planning\}/.test(body), 'the plan button must show its own busy state')
  assert(/void loadPlan\(\)/.test(body), 'the plan button must load the report')
  const load = section('const loadPlan = React.useCallback(', '}, [])')
  assert(load.includes('setPlanning(true)'), 'the report load must mark itself busy')
  assert(load.includes('runOp(PLAN, {})'), 'the report read must go through runOp')
  assert(load.includes('setPlanning(false)'), 'the report load must clear busy in both outcomes')
  return 'read-only plan fetch with local busy'
})

check('action-lazy-switch', () => {
  assert(/onChange=\{next => \{ askLazy\(entry, next\) \}\}/.test(body), 'the server switch must ask before hiding tools')
  assert(/checked=\{entry\.lazy\}/.test(body), 'the server switch reflects the lazy flag')
  assert(includes(body, 'busy === `${LAZY_SET}:${entry.server}`'), 'the switch must key its busy state')
  const ask = section('const askLazy = React.useCallback(', '}, [fire, lang])')
  assert(ask.includes('on: true'), 'turning lazy on must be confirmed')
  assert(ask.includes('on: false'), 'turning lazy off must be a direct write')
  return 'on asks, off sends'
})

check('action-lazy-load', () => {
  assert(includes(body, 'fire(LAZY_LOAD, entry.server, { names: entry.tools, load: true })'), 'load must send the server names')
  assert(includes(body, 'busy === `${LAZY_LOAD}:${entry.server}`'), 'load must key its busy state')
  assert(includes(body, "lang === 'zh' ? '全部加载' : 'Load all'"), 'the load button needs a bilingual label')
  return 'names + load:true, per row'
})

check('action-lazy-unload', () => {
  assert(includes(body, 'fire(LAZY_UNLOAD, entry.server, { names: entry.tools, load: false })'), 'unload must send the server names')
  assert(includes(body, 'busy === `${LAZY_UNLOAD}:${entry.server}`'), 'unload must key its busy state')
  assert(includes(body, "lang === 'zh' ? '全部卸载' : 'Unload all'"), 'the unload button needs a bilingual label')
  return 'names + load:false, per row'
})

check('action-dialog-cancel', () => {
  assert(/onClose=\{stop\}/.test(body), 'closing the dialog must clear the request')
  const stop = section('const stop = React.useCallback(', '}, [])')
  assert(!/\brun\(/.test(stop), 'cancel must never send')
  assert(stop.includes('setPending(null)'), 'cancel must clear the pending request')
  return 'cancel clears, sends nothing'
})

check('action-empty-retry', () => {
  const block = section('<Empty', '/>')
  assert(includes(block, "t('tools.empty')"), 'the empty state needs its title key')
  assert(block.includes('void reload()'), 'the empty state must offer a reload')
  assert(includes(block, "t('action.retry')"), 'the reload must be labelled')
  assert(block.includes('<Button'), 'the retry must be a real button')
  return 'retry button in the empty state'
})

check('action-plan-dismiss', () => {
  const at = body.indexOf('{plan === null ? null : (')
  assert(at !== -1, 'the plan card must be conditional')
  const card = body.slice(at)
  assert(card.includes('setPlan(null)'), 'the plan card needs a dismiss control')
  assert(includes(card, "t('action.close')"), 'the dismiss control needs its label')
  return 'dismissable report card'
})

check('busy-keys', () => {
  const keys = [
    'busy === `${SAVE}:install`',
    'busy === `${LAZY_SET}:${entry.server}`',
    'busy === `${LAZY_LOAD}:${entry.server}`',
    'busy === `${LAZY_UNLOAD}:${entry.server}`',
    'busy === `${pending.op}:${pending.id}`',
  ]
  for (const key of keys) assert(body.includes(key), 'missing busy key ' + key)
  assert(body.includes('void run(op, { ...payload, id })'), 'fire() must carry the row id')
  return keys.length + ' op:id keys, ids travel in the payload'
})

// ── report ──────────────────────────────────────────────────────────────────

console.log(passed + '/' + (passed + failures.length) + ' checks passed')
if (failures.length > 0) {
  console.log('failed: ' + failures.join(', '))
  process.exit(1)
}
