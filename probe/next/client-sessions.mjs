#!/usr/bin/env node
/**
 * probe/next/client-sessions.mjs -- the sessions view (task-11), checked from outside.
 *
 * Source-only gates: the view is read as text, so the probe needs no browser, no host and no
 * build. It pins the properties the page must keep:
 *   1. the view exists and still exports SessionsView(props: ViewProps);
 *   2. the three sessions ops are sent, with the payloads the domain handlers read;
 *   3. the empty state, the filtered-empty state and the hint;
 *   4. session.clear is reachable only through the confirmation dialog;
 *   5. one per-row busy key per op, matching the shell's op:id convention;
 *   6. accessible names on every control, every label bound to its input;
 *   7. colour comes from th-* class names only, never a literal or an inline style;
 *   8. the file stays inside the size budget;
 *   9. one check per interactive action: filter, create, edit, toggle, add, save, trace, cancel;
 *  10. every t('...') resolves in both catalogs; imports, markup and the shell mount stay clean;
 *  11. session.lineage goes through runDetailed and its answer (data.lineage, data.deny) is
 *      rendered under sessions.lineageChain / sessions.lineageDeny, with the local overlay as
 *      the fallback when the read fails;
 *  12. the normalizer is executed, not just grepped: junk entries dropped, chain-less replies
 *      fall back, and the host's object is never mutated.
 *
 * No third-party libraries. Every line is PASS or FAIL; exit 1 when any check fails.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = join(ROOT, 'src', 'client')
const VIEW = join(CLIENT, 'views', 'sessions.tsx')
const SHELL = join(CLIENT, 'shell.tsx')
const I18N = join(CLIENT, 'i18n.ts')

let passed = 0
const failures = []

function check(name, run) {
  try {
    const detail = run()
    passed += 1
    console.log('PASS ' + name + (detail === undefined || detail === '' ? '' : ' (' + detail + ')'))
  }
  catch (error) {
    failures.push(name)
    console.log('FAIL ' + name + ' -- ' + (error instanceof Error ? error.message : String(error)))
  }
}

function skip(name, why) {
  passed += 1
  console.log('SKIP ' + name + ' (' + why + ')')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const rel = file => relative(ROOT, file).split('\\').join('/')
const source = existsSync(VIEW) ? readFileSync(VIEW, 'utf8') : ''
const numberOf = needle => source.split(needle).length - 1
const lines = source.split('\n')

/** Block comments and full-line comments removed: prose may name an op the code does not send. */
function stripComments(text) {
  let out = ''
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('/*', index)
    if (open === -1) {
      out += text.slice(index)
      break
    }
    out += text.slice(index, open)
    const close = text.indexOf('*/', open + 2)
    if (close === -1) break
    index = close + 2
  }
  return out.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
}

const body = stripComments(source)

/** The keys a source calls t('...') with, in first-seen order. */
function keysUsed(text) {
  const keys = new Set()
  let index = 0
  while (index < text.length) {
    const at = text.indexOf("t('", index)
    if (at === -1) break
    const end = text.indexOf("'", at + 3)
    if (end === -1) break
    keys.add(text.slice(at + 3, end))
    index = end + 1
  }
  return keys
}

/** Keys of one catalog literal, parsed without a regex so a quote never has to be escaped. */
function catalogKeys(text, name) {
  const marker = 'const ' + name + ': Catalog = {'
  const start = text.indexOf(marker)
  assert(start !== -1, 'i18n.ts has no ' + name + ' catalog')
  const open = start + marker.length - 1
  let depth = 0
  let close = -1
  for (let cursor = open; cursor < text.length; cursor += 1) {
    const char = text[cursor]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        close = cursor
        break
      }
    }
  }
  assert(close !== -1, name + ' catalog is not closed')
  const keys = new Set()
  for (const line of text.slice(open + 1, close).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("'")) continue
    const end = trimmed.indexOf("'", 1)
    if (end === -1) continue
    keys.add(trimmed.slice(1, end))
  }
  return keys
}

/** Specifiers of relative imports, so a missing .js suffix cannot ship. */
function relativeImports(text) {
  const specs = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('import ')) continue
    const at = trimmed.indexOf("from '")
    if (at === -1) continue
    const start = at + 6
    const end = trimmed.indexOf("'", start)
    if (end === -1) continue
    specs.push(trimmed.slice(start, end))
  }
  return specs
}

// -- the view itself -------------------------------------------------------

check('files-present', () => {
  assert(existsSync(VIEW), 'src/client/views/sessions.tsx is missing')
  assert(source.length > 2000, 'the view is still the scaffold (' + source.length + ' bytes)')
  return rel(VIEW) + ', ' + lines.length + ' lines'
})

check('export-view', () => {
  assert(source.includes('export function SessionsView(props: ViewProps): React.ReactElement'), 'SessionsView must stay the exported entry point, typed against ViewProps')
  assert(source.includes("import type { ViewProps } from '../types.js'"), 'ViewProps must come from ../types.js')
  return 'SessionsView(props: ViewProps): React.ReactElement'
})

check('ops-wired', () => {
  for (const pair of [['OP_SET', 'session.set', 'run'], ['OP_CLEAR', 'session.clear', 'run'], ['OP_LINEAGE', 'session.lineage', 'runDetailed']]) {
    const name = pair[0]
    const op = pair[1]
    const send = pair[2]
    const quoted = "'" + op + "'"
    const declared = numberOf(quoted)
    assert(declared === 1, op + ' must be declared once as ' + quoted + ', found ' + declared)
    assert(source.includes('const ' + name + ' = ' + quoted), name + ' must carry ' + op)
    assert(numberOf(send + '(' + name + ',') === 1, op + ' must be sent from exactly one ' + send + '(' + name + ', ...) call')
  }
  return 'session.set / session.clear via run; session.lineage via runDetailed'
})

check('payload-contract', () => {
  assert(source.includes('function payloadOf(sessionId: string): { id: string; sessionId: string }'), 'payloadOf must type the shared payload')
  assert(source.includes('return { id: sessionId, sessionId }'), 'the payload carries sessionId (domain contract) and id (shell busy key)')
  assert(source.includes('void run(OP_SET, { ...payloadOf(sessionId), names: draft.names })'), 'session.set must send sessionId plus names')
  assert(source.includes('void run(OP_CLEAR, payloadOf(sessionId))'), 'session.clear must send only sessionId')
  assert(source.includes('void runDetailed(OP_LINEAGE, payloadOf(sessionId))'), 'session.lineage must send only sessionId and keep its answer')
  assert(!body.includes('run(OP_CLEAR, { names'), 'session.clear must not carry a names list')
  return 'set{sessionId,names}, clear{sessionId}, lineage{sessionId}'
})

check('empty-state', () => {
  assert(source.includes("title={t('sessions.empty')}"), 'the no-overlay state must use sessions.empty')
  assert(source.includes("hint={t('sessions.hint')}"), 'the empty state must explain what an overlay does')
  const branch = source.indexOf('rows.length === 0 ? (')
  const filtered = source.indexOf('<Empty title={label(lang,', branch)
  assert(branch !== -1, 'a filtered-to-nothing list needs its own branch')
  assert(filtered !== -1 && filtered - branch < 200, 'the filtered branch must render Empty, not an empty card')
  return 'empty state, filtered-empty state, hint'
})

check('confirm-before-clear', () => {
  assert(numberOf('run(OP_CLEAR,') === 1, 'session.clear must be sent from exactly one place, found ' + numberOf('run(OP_CLEAR,'))
  const handlerAt = body.indexOf('const confirmClear = (): void => {')
  const callAt = body.indexOf('run(OP_CLEAR,')
  assert(handlerAt !== -1, 'the confirm handler is missing')
  assert(callAt > handlerAt && callAt - handlerAt < 320, 'the single session.clear call must live in the confirm handler')
  assert(numberOf('onClick={confirmClear}') === 1, 'exactly one button may confirm the clear')
  const dialogAt = body.indexOf('open={clearing !== null}')
  assert(dialogAt !== -1, 'the clear confirmation dialog is missing')
  const closeAt = body.indexOf('</Dialog>', dialogAt)
  const confirmAt = body.indexOf('onClick={confirmClear}', dialogAt)
  assert(closeAt !== -1, 'the clear dialog is never closed')
  assert(confirmAt > dialogAt && confirmAt < closeAt, 'the confirm button must sit in the dialog footer')
  assert(body.slice(dialogAt, closeAt).includes('variant="danger"'), 'the confirming button must be the danger one')
  assert(source.includes("title={t('dialog.confirmTitle')}"), 'the clear dialog must be titled as a confirmation')
  assert(source.includes('onClick={closeClear}'), 'the dialog needs a cancel button')
  assert(source.includes('setClearing(sessionId)'), 'the row button must only arm the dialog')
  return 'row arms the dialog; one confirm button sends session.clear'
})

check('busy-keys', () => {
  assert(source.includes('const setKey = draft === null ? null :'), 'the editor needs a per-draft busy key')
  assert(numberOf('OP_SET}:') === 1, 'the editor busy key must be OP_SET:<session id>')
  assert(source.includes('const clearKey = clearing === null ? null :'), 'the clear dialog needs a per-row busy key')
  assert(numberOf('OP_CLEAR}:') === 2, 'the clear busy key must appear once in the dialog and once on the row')
  assert(source.includes('const traceKey = tracing === null ? null :'), 'the trace dialog needs a busy key')
  assert(numberOf('OP_LINEAGE}:') === 1, 'the trace busy key must be OP_LINEAGE:<session id>')
  for (const guard of ['busy={setKey !== null && busy === setKey}', 'busy={clearKey !== null && busy === clearKey}', 'busy={traceKey !== null && busy === traceKey}']) {
    assert(source.includes(guard), 'missing busy guard: ' + guard)
  }
  return 'op:id keys, null-guarded so an idle view never shows a spinner'
})

check('accessible-labels', () => {
  assert(source.includes("label={t('sessions.search')}"), 'the filter needs an accessible name')
  assert(source.includes("clearLabel={t('action.clear')}"), 'the filter clear button needs a name')
  assert(source.includes("label={t('a11y.switch', { name })}"), 'each tool switch needs an accessible name')
  assert(source.includes('role="group" aria-label={label(lang,'), 'the tool list must be a named group')
  assert(numberOf('<Field') === 3 && numberOf('<input') === 3, 'three labelled fields expected, found ' + numberOf('<Field') + ' fields / ' + numberOf('<input') + ' inputs')
  for (const id of ['th-session-id', 'th-session-name', 'th-lineage-id']) {
    assert(numberOf('"' + id + '"') === 2, id + ' must appear on the Field and on its input, found ' + numberOf('"' + id + '"'))
  }
  assert(numberOf('aria-describedby=') === 3, 'each input must point at its description')
  assert(numberOf('<Dialog') === 3, 'three dialogs expected, found ' + numberOf('<Dialog'))
  assert(numberOf('open={') === 3, 'each dialog needs its own open flag')
  assert(numberOf('label={') >= 10, 'controls must carry aria labels')
  assert(numberOf('} ${sessionId}') === 3, 'each row button must name the session it acts on')
  assert(source.includes("action={<Button onClick={openCreate}>{t('action.create')}</Button>}"), 'the empty action must be a real button with visible text')
  return 'filter, switch, 3 labelled fields, 3 dialogs, per-row names'
})

check('no-literal-colours', () => {
  assert(!source.includes('style={{'), 'the view must not style inline: th-* classes carry the theme')
  const hex = /#[0-9a-fA-F]{3,8}/.exec(source)
  assert(hex === null, 'literal colour at offset ' + (hex === null ? 0 : hex.index))
  for (const pattern of ['rgb(', 'rgba(', 'hsl(', 'hsla(']) {
    assert(!source.includes(pattern), 'the view uses ' + pattern + ' outside a token')
  }
  assert(source.includes('className="th-row"'), 'the view must lay out with the shared th-* classes')
  return 'classNames only, no colour values'
})

check('file-length', () => {
  const bytes = statSync(VIEW).size
  assert(lines.length < 450, 'the view has ' + lines.length + ' lines (limit 450)')
  assert(bytes < 60 * 1024, 'the view is ' + bytes + ' bytes (limit 60 KB)')
  return lines.length + ' lines, ' + bytes + ' bytes'
})

// -- one check per interactive action --------------------------------------

check('action-filter', () => {
  assert(source.includes('const term = query.trim().toLowerCase()'), 'the filter must compare case-insensitively')
  assert(source.includes('id.toLowerCase().includes(term)'), 'rows must be filtered by session id')
  assert(source.includes('onChange={setQuery}'), 'the search box must write the query')
  const clearAt = source.indexOf('onClear={() => {')
  const resetAt = source.indexOf("setQuery('')", clearAt)
  assert(clearAt !== -1 && resetAt !== -1 && resetAt - clearAt < 120, 'clearing the filter must empty the query')
  assert(source.includes('const rows = ids.filter('), 'visible rows must derive from the overlay ids')
  return 'filter by session id, clear resets it'
})

check('action-create', () => {
  assert(source.includes('const openCreate = (): void => {'), 'creating an overlay needs its own action')
  assert(source.includes("setDraft({ sessionId: '', names: [] })"), 'creating starts from an empty draft')
  assert(source.includes('<Button variant="primary" onClick={openCreate}'), 'the toolbar needs a primary New button')
  assert(source.includes("<Button onClick={openCreate}>{t('action.create')}</Button>"), 'the empty state must offer the same action')
  return 'toolbar and empty state open an empty draft'
})

check('action-edit', () => {
  assert(source.includes('const openEdit = (sessionId: string): void => {'), 'editing must take the row id')
  assert(source.includes('setDraft({ sessionId, names: [...namesOf(overlays, sessionId)] })'), 'the editor must start from that row overlay')
  assert(source.includes('onClick={() => openEdit(sessionId)}'), 'the row must offer Edit')
  return 'row overlay copied into the draft'
})

check('action-toggle', () => {
  assert(numberOf('<Switch') === 1, 'one switch component expected, found ' + numberOf('<Switch'))
  assert(source.includes('checked={draft.names.includes(name)}'), 'a switch reflects the draft, not the saved overlay')
  const changeAt = source.indexOf('onChange={next => {')
  const toggleAt = source.indexOf('toggleName(name, next)', changeAt)
  assert(changeAt !== -1 && toggleAt !== -1 && toggleAt - changeAt < 120, 'a switch must toggle that name')
  assert(source.includes('const kept = current.names.filter(item => item !== name)'), 'toggling off must drop the name')
  return 'per-name switches edit the draft'
})

check('action-add-name', () => {
  assert(source.includes('const addTypedName = (): void => {'), 'a hand-typed name needs its own action')
  assert(source.includes('if (!name.startsWith(MCP_PREFIX)) {'), 'the domain drops non-MCP names, so the editor refuses them early')
  assert(source.includes("setNameError(label(lang, '名称必须以 mcp__ 开头', 'A name must start with mcp__'))"), 'the refusal needs a bilingual message')
  assert(source.includes("label={label(lang, '添加', 'Add')}"), 'the add button needs a label')
  return 'typed names validated against mcp__'
})

check('action-save', () => {
  assert(source.includes('const saveDraft = (): void => {'), 'saving needs its own action')
  assert(source.includes("disabled={draft === null || draft.sessionId.trim() === ''}"), 'save stays disabled without a session id')
  assert(source.includes('void run(OP_SET, { ...payloadOf(sessionId), names: draft.names })'), 'save must send the whole overlay')
  assert(source.includes('if (ok) closeDraft()'), 'a saved overlay closes the editor; a failed one stays open')
  return 'session.set with the full name list'
})

check('action-trace', () => {
  assert(source.includes('const confirmTrace = (): void => {'), 'tracing needs its own action')
  assert(source.includes('void runDetailed(OP_LINEAGE, payloadOf(sessionId))'), 'tracing must send session.lineage and keep the host answer')
  assert(source.includes('const openTrace = (sessionId: string): void => {'), 'opening the dialog resets the previous answer')
  assert(source.includes('openTrace(sessionId)'), 'the row must open the trace dialog for its id')
  assert(source.includes("openTrace('')"), 'the toolbar must offer a trace for any session id')
  assert(source.includes('const traceNames = tracing === null ? [] : namesOf(overlays, tracing.trim())'), 'the dialog shows the local overlay before tracing')
  return 'row and toolbar open the trace dialog; one runDetailed read'
})

check('lineage-answer-rendered', () => {
  assert(source.includes('setTrace(normalizeLineage(outcome.data))'), 'the dialog must render the host answer, not guess it')
  assert(source.includes('{trace.lineage.map(id => <Badge key={id} tone="off">{id}</Badge>)}'), 'every hop of the chain must render')
  assert(source.includes('{trace.deny.map(name => <Badge key={name} tone="off">{name}</Badge>)}'), 'every merged mask must render')
  assert(source.includes("aria-label={t('sessions.lineageChain')}"), 'the chain block needs an accessible name')
  assert(source.includes("t('sessions.lineageChain')") && source.includes("t('sessions.lineageDeny')"), 'both labels must be visible titles')
  assert(source.includes("t('sessions.lineageDeny')"), 'the merged masks must be labelled')
  return 'data.lineage -> sessions.lineageChain, data.deny -> sessions.lineageDeny'
})

check('lineage-fallback-local', () => {
  assert(source.includes('if (!outcome.ok) {'), 'a failed read must be recognised')
  assert(source.includes('setTrace(null)') && source.includes("setTraceError(outcome.error ?? '')"), 'a failed read drops the answer and remembers why')
  assert(source.includes('const traceNames = tracing === null ? [] : namesOf(overlays, tracing.trim())'), 'the local overlay stays available')
  assert(source.includes('{traceNames.map(name => <Badge key={name} tone="off">{name}</Badge>)}'), 'the fallback still paints the local masks')
  assert(source.includes('traceError === null ? null :'), 'the failure is shown without hiding the fallback')
  return 'failed read -> local overlay, no stale answer'
})

check('action-cancel', () => {
  const cancels = numberOf("{t('action.cancel')}")
  assert(cancels === 3, 'each dialog needs its own Cancel button, found ' + cancels)
  assert(numberOf('onClick={closeDraft}') === 1, 'the editor needs a cancel path')
  assert(numberOf('onClick={closeClear}') === 1, 'the clear dialog needs one too')
  assert(numberOf('onClick={closeTrace}') === 1, 'so does the trace dialog')
  return 'three dialogs, three Cancel buttons; Escape is the Dialog own job'
})

// -- contracts with the rest of the panel ----------------------------------

check('i18n-keys-exist', () => {
  const i18n = readFileSync(I18N, 'utf8')
  const zh = catalogKeys(i18n, 'zh')
  const en = catalogKeys(i18n, 'en')
  for (const key of zh) assert(en.has(key), 'en is missing "' + key + '"')
  for (const key of en) assert(zh.has(key), 'zh is missing "' + key + '"')
  const used = keysUsed(body)
  for (const key of used) assert(zh.has(key), "the view calls t('" + key + "') which no catalog defines")
  const required = ['sessions.title', 'sessions.empty', 'sessions.search', 'sessions.count', 'sessions.overlay', 'sessions.workspace', 'sessions.clear', 'sessions.hint', 'sessions.lineageChain', 'sessions.lineageDeny', 'action.create', 'action.edit', 'action.save', 'action.cancel', 'action.confirm', 'action.clear', 'a11y.switch', 'dialog.confirmTitle']
  for (const key of required) assert(used.has(key), "the view never calls t('" + key + "')")
  return zh.size + ' keys aligned, ' + used.size + ' used by the view'
})

check('imports-clean', () => {
  assert(!source.includes("from '../api.js'"), 'the view must not fetch: the shell owns run/reload')
  const specs = relativeImports(source)
  const rels = specs.filter(spec => spec.startsWith('.'))
  assert(rels.length === 2, 'two relative imports expected, found: ' + rels.join(', '))
  for (const spec of rels) assert(spec.endsWith('.js'), spec + ' must carry a .js suffix')
  assert(specs.includes('react'), 'the view needs React')
  return rels.join(', ')
})

check('no-unsafe-markup', () => {
  for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment']) {
    assert(!source.includes(pattern), 'the view uses ' + pattern)
  }
  const todo = source.indexOf('TODO(') !== -1 || source.indexOf('FIXME') !== -1 || source.indexOf('XXX:') !== -1
  assert(!todo, 'the view still carries a TODO marker')
  return 'no HTML string injection, no TODO'
})

check('bilingual-oneoff', () => {
  assert(source.includes("function label(lang: ViewProps['lang'], zh: string, en: string): string {"), 'one-off labels go through one helper')
  assert(source.includes("return lang === 'zh' ? zh : en"), 'the helper must switch on the ViewProps language')
  assert(source.includes("label(lang, '追溯', 'Trace')"), 'the trace label must be bilingual')
  assert(source.includes("label(lang, '会话血缘', 'Session lineage')"), 'the lineage title must be bilingual')
  return "lang === 'zh' ? zh : en"
})

check('view-mounted', () => {
  const shell = readFileSync(SHELL, 'utf8')
  assert(shell.includes("import { SessionsView } from './views/sessions.js'"), 'the shell must import this view')
  assert(shell.split('<SessionsView ').length - 1 === 1, 'the shell must mount the view once')
  // Views get the effective language, so a forced zh/en in Settings reaches inline labels.
  assert(/<SessionsView snapshot=\{snapshot\} lang=\{effectiveLang\} t=\{t\} busy=\{busy\} run=\{run\} runDetailed=\{runDetailed\} reload=\{reload\} \/>/.test(shell), 'the shell must pass every ViewProps with the effective language and runDetailed')
  assert(shell.includes("{ id: 'sessions', label: 'nav.sessions' }"), 'the sidebar keeps one sessions entry')
  return 'one import, one mount, all props'
})

// -- runtime: the exported lineage helper, bundled and executed ---------------

let lineageApi = null
try {
  const openMarker = '// #region lineage-helpers'
  const closeMarker = '// #endregion lineage-helpers'
  const regionStart = source.indexOf(openMarker)
  const regionEnd = source.indexOf(closeMarker)
  assert(regionStart !== -1 && regionEnd > regionStart, 'sessions.tsx lost its lineage-helpers region')
  const region = stripComments(source.slice(regionStart + openMarker.length, regionEnd))
  const bundled = await build({
    stdin: { contents: region, loader: 'ts', resolveDir: ROOT, sourcefile: 'sessions-helpers.ts' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })
  const text = bundled.outputFiles?.[0]?.text ?? ''
  assert(text !== '', 'esbuild produced no bundle for the lineage helper')
  lineageApi = await import('data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64'))
} catch (error) {
  failures.push('lineage-helpers-bundle')
  console.log('FAIL lineage-helpers-bundle -- ' + (error instanceof Error ? error.message : String(error)))
}

check('runtime-lineage-normalizer', () => {
  assert(lineageApi !== null, 'the lineage helper did not compile')
  const mod = lineageApi
  assert(mod.normalizeLineage(null) === null, 'null must fall back to the local copy')
  assert(mod.normalizeLineage({}) === null, 'a chain-less answer must fall back')
  assert(mod.normalizeLineage({ lineage: [] }) === null, 'an empty chain must fall back')
  const shaped = mod.normalizeLineage({ lineage: ['s1', 7, 's2'], deny: ['mcp__a__x', null] })
  assert(JSON.stringify(shaped) === JSON.stringify({ lineage: ['s1', 's2'], deny: ['mcp__a__x'] }), 'junk entries must be dropped, got ' + JSON.stringify(shaped))
  const missingDeny = mod.normalizeLineage({ lineage: ['s1'] })
  assert(JSON.stringify(missingDeny) === JSON.stringify({ lineage: ['s1'], deny: [] }), 'a missing deny list is empty, got ' + JSON.stringify(missingDeny))
  const before = { lineage: ['s1'], deny: ['n'] }
  mod.normalizeLineage(before)
  assert(JSON.stringify(before) === JSON.stringify({ lineage: ['s1'], deny: ['n'] }), 'the host answer must not be mutated')
  return 'null/empty fall back; junk dropped; input untouched'
})

const bundle = join(ROOT, 'dist', 'client.js')
if (!existsSync(bundle)) {
  skip('bundle-sessions', 'dist/client.js not built yet; the lead builds')
}
else if (!readFileSync(bundle, 'utf8').includes('session.set')) {
  skip('bundle-sessions', 'dist/client.js predates this view; rebuild to include it')
}
else {
  check('bundle-sessions', () => {
    const text = readFileSync(bundle, 'utf8')
    for (const op of ['session.set', 'session.clear', 'session.lineage']) {
      assert(text.includes(op), 'dist/client.js carries no ' + op)
    }
    assert(text.includes('sessions.overlay'), 'dist/client.js carries no sessions copy')
    return 'the bundle carries the view and all three ops'
  })
}

console.log(passed + '/' + (passed + failures.length) + ' checks passed')
if (failures.length > 0) {
  console.log('failed: ' + failures.join(', '))
  process.exit(1)
}
