#!/usr/bin/env node
/**
 * Static gate for the 2.0 MCP view (src/client/views/mcp.tsx).
 *
 * The view is the only place a user can create, edit, raw-edit or delete an MCP server, so this
 * probe pins the properties that make it safe to ship: one exported component, the five MCP ops
 * wired with the payload their handlers actually parse, an empty state, a dialog before a delete,
 * a name on every control, no literal colour, and a file that stays inside its size cap.
 *
 * No dependencies and no build: PASS/FAIL lines, exit 1 when anything fails. Every assertion reads
 * the source text, so a rename or a dropped op fails here before the panel is ever loaded.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = 'src/client/views/mcp.tsx'
const CATALOG = 'src/client/i18n.ts'
const HELPER = 'src/client/views/mcp-helpers.ts'
const MAX_LINES = 450
const MAX_BYTES = 40 * 1024

const results = []
function check(name, work) {
  try {
    const detail = work()
    results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : '' })
  }
  catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const source = readFileSync(join(ROOT, VIEW), 'utf8')
const helper = readFileSync(join(ROOT, HELPER), 'utf8')
const bytes = statSync(join(ROOT, VIEW)).size
const lines = source.split('\n')
const body = source.endsWith('\n') ? lines.slice(0, -1) : lines
/** Line number of a character offset, for file:line reporting. */
const lineAt = index => source.slice(0, index).split('\n').length
const has = text => source.includes(text)
/** How many times a substring occurs; used where twice means two places to keep in step. */
const count = text => source.split(text).length - 1
/** The busy key the shell derives from payload.id, built from parts to keep this file plain. */
const tick = String.fromCharCode(96)
const busyKey = (op, id) => tick + '${' + op + '}:' + '${' + id + '}' + tick

// ── the component ────────────────────────────────────────────────────────────

check('view-file', () => {
  assert(bytes > 2000, VIEW + ' looks empty (' + String(bytes) + ' bytes)')
  const at = source.indexOf('export function McpView')
  assert(at !== -1, VIEW + ' does not export McpView')
  return 'exported at line ' + String(lineAt(at))
})

check('export-signature', () => {
  assert(
    has('export function McpView(props: ViewProps): React.ReactElement {'),
    'McpView must keep its ViewProps signature and React.ReactElement return type',
  )
  assert(has('const { snapshot, t, lang, busy, run } = props'), 'the view must read the ViewProps it renders from')
  return 'props destructured'
})

// ── one check per op the domain declares ─────────────────────────────────────

check('ops-table', () => {
  const table = source.slice(source.indexOf('const MCP_OPS'), source.indexOf('} as const'))
  for (const id of ['mcp.create', 'mcp.save', 'mcp.raw', 'mcp.rawSave', 'mcp.delete']) {
    assert(table.includes("'" + id + "'"), 'MCP_OPS does not carry ' + id)
    assert(source.split("'" + id + "'").length - 1 === 1, id + ' must be named exactly once')
  }
  return 'create, save, raw, rawSave, delete'
})

check('action-toggle', () => {
  assert(has("run(OPS.toggle, { kind: 'plugin'"), 'the switch must send toggle with kind plugin')
  assert(has(busyKey('OPS.toggle', 'row.id')), 'the switch busy key must be the op plus the row id')
  return "toggle { kind: 'plugin', id, enabled }"
})

check('action-create', () => {
  assert(has('run(MCP_OPS.create, { config })'), 'create must send { config } and nothing else')
  assert(!has('run(MCP_OPS.create, { id:'), 'create takes no id: the host mints the row id')
  assert(has('? MCP_OPS.create :'), 'a create has no id, so it runs under the bare op busy key')
  return '{ config }'
})

check('action-save', () => {
  assert(has('run(MCP_OPS.save, { id: draft.id, occurrence: draft.occurrence, config })'), 'save must send { id, occurrence, config }')
  assert(has(busyKey('MCP_OPS.save', 'draft.id')), 'the save busy key must be the op plus the patch row id')
  return '{ id, config }'
})

check('row-boundary', () => {
  assert(has('<RowBoundary'), 'each MCP row must be wrapped in its own error boundary')
  assert(has('mcpReadOnlyReason'), 'a managed block row must carry its read-only reason')
  assert(has("mcpRowKey(id, occurrence)"), 'duplicate rows need the shared collision-free identity key')
  assert(has("id === '' ? 'loader:' + row.id"), 'orphan rows need a loader-id key, not :0')
  assert(helper.includes('mcpPatchId === null'), 'an explicit null patch id must not fall back to a stale loader patch id')
  return 'per-row fallback + read-only reason'
})

check('action-edit-prefill', () => {
  assert(has('setDraft(draftOf(row))'), 'the edit button must prefill the draft from the row')
  assert(helper.includes('export function draftOf(row: PluginRow): Draft'), 'draftOf must turn a row into an editable draft')
  assert(helper.includes('export function emptyDraft(): Draft'), 'a new row needs the empty draft')
  return 'draftOf / emptyDraft'
})

check('action-raw-read', () => {
  assert(has('runOp(MCP_OPS.raw, { id, occurrence })'), 'the raw editor must load the row through mcp.raw with { id, occurrence }')
  assert(!has('run(MCP_OPS.raw,'), 'mcp.raw is a read: run() only reports success, so it cannot carry the text')
  assert(has('result.data'), 'the raw editor must read the text out of the op result')
  return 'runOp(mcp.raw, { id })'
})

check('action-raw-save', () => {
  assert(has('run(MCP_OPS.rawSave, { id: raw.id, occurrence: raw.occurrence, text: raw.text })'), 'rawSave must send { id, occurrence, text }')
  assert(has(busyKey('MCP_OPS.rawSave', 'raw.id')), 'the rawSave busy key must be the op plus the row id')
  assert(has("raw.text.trim() === ''"), 'an empty raw buffer must not be submittable')
  return '{ id, text }'
})

check('action-delete-confirm', () => {
  const dialogAt = source.indexOf('open={pending !== null}')
  assert(dialogAt !== -1, 'the delete must go through a dialog opened by a pending row')
  const callAt = source.indexOf('run(MCP_OPS.remove')
  assert(callAt !== -1, 'the view never sends mcp.delete')
  assert(count('run(MCP_OPS.remove') === 1, 'mcp.delete must be sent from exactly one place')
  assert(callAt > dialogAt, 'mcp.delete must be sent only from inside the confirm dialog')
  assert(has('pending.name'), 'the confirm dialog must name the server it removes')
  const buttonLine = body.find(line => line.includes('setPending(row)'))
  assert(buttonLine !== undefined, 'the delete button must open the dialog through setPending(row)')
  assert(!buttonLine.includes('run(') && !buttonLine.includes('MCP_OPS'), 'the delete button must not send the op itself')
  return 'row button opens the dialog; the dialog sends mcp.delete'
})

// ── states, labels, tokens ───────────────────────────────────────────────────

check('empty-state', () => {
  assert(has("t('mcp.empty')"), 'a profile with no MCP server needs the mcp.empty copy')
  assert(has('servers.length === 0'), 'the empty state must key off the unfiltered list')
  assert(has('<Empty'), 'the empty state must use the shared Empty component')
  assert(has("t('mcp.emptyFiltered'"), 'a filtered-empty list needs its own copy')
  return 'Empty for no servers, Empty for no match'
})

check('search-and-count', () => {
  assert(has('<SearchBox'), 'the list needs the shared SearchBox')
  assert(has("t('mcp.search')"), 'the search box needs a label')
  assert(has("t('mcp.count'"), 'the toolbar must show how many rows the filter left')
  return 'SearchBox + count badge'
})

check('patch-guard', () => {
  assert(has('snapshot.paths.patch'), 'the view decides whether editing is possible from the patch path')
  assert(has('disabled={!patchReady}'), 'a profile without a patch must disable create')
  assert(has('disabled={!editable}'), 'a row without a patch id must disable edit, raw and delete')
  assert(has("t('mcp.patchMissing')"), 'the read-only case must say why')
  return 'patchReady / editable gating'
})

check('accessible-labels', () => {
  for (const tag of ['<input', '<textarea']) {
    let from = 0
    for (;;) {
      const at = source.indexOf(tag, from)
      if (at === -1) break
      const end = source.indexOf('>', at)
      const open = source.slice(at, end === -1 ? source.length : end + 1)
      assert(open.includes('aria-label='), 'the ' + tag.slice(1) + ' at line ' + String(lineAt(at)) + ' has no accessible name')
      from = at + tag.length
    }
  }
  assert(count('aria-label=') >= 3, 'every text control needs its own accessible name')
  assert(count('<Field') >= 4, 'form controls must sit in a Field so the caption is bound to them')
  assert(has('aria-busy={raw.loading}'), 'the raw editor must announce that it is loading')
  return count('aria-label=') + ' aria-label, ' + count('<Field') + ' fields'
})

check('dialog-count', () => {
  const dialogs = count('<Dialog')
  assert(dialogs === 3, 'expected three dialogs (editor, raw row, delete confirm), found ' + String(dialogs))
  assert(has("t('dialog.confirmTitle')"), 'the destructive dialog needs a title')
  assert(has("t('action.cancel')"), 'every dialog needs a way out')
  return 'editor, raw, confirm'
})

check('no-literal-colour', () => {
  assert(!source.includes('#'), 'a hash character is a literal colour in disguise; use a token')
  assert(!source.includes('rgb(') && !source.includes('rgba('), 'rgb() is a literal colour; use a th- class')
  assert(!source.includes('hsl(') && !source.includes('hsla('), 'hsl() is a literal colour; use a th- class')
  assert(has('className="th-input"'), 'controls must wear the shared th-input class')
  return 'no colour literals'
})

check('no-html-injection', () => {
  for (const pattern of ['innerHTML', 'dangerouslySetInnerHTML', 'outerHTML']) {
    assert(!source.includes(pattern), 'the view must not build HTML strings (' + pattern + ')')
  }
  return 'no HTML strings'
})

check('no-direct-network', () => {
  assert(!source.includes('fetch('), 'views never fetch; api.ts owns the one door to the host')
  assert(!source.includes('XMLHttpRequest'), 'views never fetch')
  return 'writes go through run(), the raw read through runOp()'
})

// ── catalogs, imports, size ──────────────────────────────────────────────────

check('i18n-keys', () => {
  const catalog = readFileSync(join(ROOT, CATALOG), 'utf8')
  const known = new Set()
  for (const line of catalog.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("'")) continue
    const end = trimmed.indexOf("'", 1)
    if (end === -1) continue
    known.add(trimmed.slice(1, end))
  }
  // A dotted lowercase key; anything else (split('\n'), join('\n')) is a string, not a lookup.
  const isKey = text => text.length > 0 && text.split('').every(ch => 'abcdefghijklmnopqrstuvwxyz0123456789._-'.includes(ch))
  const used = new Set()
  let from = 0
  for (;;) {
    const at = source.indexOf("t('", from)
    if (at === -1) break
    const end = source.indexOf("'", at + 3)
    if (end === -1) break
    const key = source.slice(at + 3, end)
    if (isKey(key)) used.add(key)
    from = end
  }
  assert(used.size > 0, 'the view calls no translations at all')
  for (const key of used) assert(known.has(key), 't(' + key + ') is not in the catalog')
  return used.size + ' keys, all defined'
})

check('bilingual-one-offs', () => {
  assert(helper.includes("lang === 'zh'"), 'a caption that is not an mcp.* key must be bilingual from lang')
  assert(helper.includes('export function copy(lang: ViewProps'), 'the bilingual one-off helper must take the view lang')
  return 'copy(lang, zh, en)'
})

check('oauth-surface', () => {
  const sibling = readFileSync(join(ROOT, 'src/client/views/mcp-oauth.tsx'), 'utf8')
  assert(/export function McpOauthDialog/.test(sibling), 'the OAuth dialog must stay a named component')
  for (const line of sibling.split('\n')) {
    if (!line.startsWith('import ')) continue
    const at = line.indexOf("'")
    if (at === -1) continue
    const spec = line.slice(at + 1, line.indexOf("'", at + 1))
    if (spec.startsWith('.') && !['../api.js', '../components.js', '../types.js'].includes(spec)) {
      throw new Error('the OAuth dialog imports ' + spec + '; keep it on api/components/types')
    }
  }
  return 'mcp-oauth.tsx is self-contained'
})

check('imports', () => {
  const allowed = new Set(['../api.js', '../components.js', '../types.js', '../identity.js', './mcp-oauth.js', './mcp-helpers.js'])
  for (const line of source.split('\n')) {
    if (!line.startsWith('import ')) continue
    const at = line.indexOf("'")
    if (at === -1) continue
    const spec = line.slice(at + 1, line.indexOf("'", at + 1))
    if (!spec.startsWith('.')) continue
    assert(spec.endsWith('.js'), 'relative import ' + spec + ' needs its .js suffix')
    assert(allowed.has(spec), 'the view may only import api, components and types, not ' + spec)
  }
  return 'api, components, types'
})

check('busy-keys', () => {
  const keys = [
    busyKey('OPS.toggle', 'row.id'),
    busyKey('MCP_OPS.save', 'draft.id'),
    busyKey('MCP_OPS.rawSave', 'raw.id'),
    busyKey('MCP_OPS.remove', 'patchIdOf(pending)'),
  ]
  for (const key of keys) assert(has(key), 'missing busy key ' + key)
  return 'four row-scoped busy keys'
})

check('scope', () => {
  assert(has('.filter(row => row.mcp === true)'), 'the view lists MCP rows, not every plugin')
  assert(has("t('mcp.orphan')"), 'a row the loader started without a patch entry must say so')
  assert(has('patchIdOf'), 'the patch row id must come from one helper')
  return 'mcp rows only, orphans labelled'
})

check('size-cap', () => {
  assert(body.length < MAX_LINES, VIEW + ' has ' + String(body.length) + ' lines, cap is ' + String(MAX_LINES))
  assert(bytes < MAX_BYTES, VIEW + ' is ' + String(bytes) + ' bytes, cap is ' + String(MAX_BYTES))
  return String(body.length) + ' lines, ' + String(bytes) + ' bytes'
})

// ── report ───────────────────────────────────────────────────────────────────

let failed = 0
for (const result of results) {
  const state = result.ok ? 'PASS' : 'FAIL'
  if (!result.ok) failed += 1
  const suffix = result.detail === '' ? '' : '  [' + result.detail + ']'
  console.log(state + ' ' + result.name + suffix)
}
console.log(String(results.length - failed) + '/' + String(results.length) + ' checks passed')
if (failed > 0) process.exit(1)