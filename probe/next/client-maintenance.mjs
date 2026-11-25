#!/usr/bin/env node
/**
 * Static gate for the MCP-row restore dialog (src/client/views/backup-restore.tsx) and the way
 * the maintenance page mounts it.
 *
 * The dialog is the only place the panel can overwrite a live MCP row from a backup, so this probe
 * pins the properties that keep that safe: a diff on screen before the write, a confirm gate that
 * cannot be bypassed, the three host ops wired with the payload their handlers parse, both catalogs
 * carrying the copy, and no literal colour or size creep in the guarded files.
 *
 * No dependencies and no build: every assertion reads source text, so a rename or a dropped op
 * fails here before the panel is ever loaded.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = 'src/client/views/backup-restore.tsx'
const PAGE = 'src/client/views/maintenance.tsx'
const CATALOG = 'src/client/i18n.ts'
const MAX_VIEW_LINES = 420
const MAX_VIEW_BYTES = 32 * 1024
const MAX_PAGE_LINES = 220
const MAX_PAGE_BYTES = 14 * 1024

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
const page = readFileSync(join(ROOT, PAGE), 'utf8')
const bytes = statSync(join(ROOT, VIEW)).size
const pageBytes = statSync(join(ROOT, PAGE)).size
const body = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n')
const pageBody = page.endsWith('\n') ? page.slice(0, -1).split('\n') : page.split('\n')
/** 1-based line of a character offset, for file:line reporting. */
const lineAt = (text, index) => text.slice(0, index).split('\n').length
const has = (text, needle) => text.includes(needle)
/** How many times a substring occurs; twice means two places to keep in step. */
const count = (text, needle) => text.split(needle).length - 1

// ── the component and its contract ───────────────────────────────────────────

check('files', () => {
  assert(bytes > 4000, VIEW + ' looks empty (' + String(bytes) + ' bytes)')
  assert(pageBytes > 3000, PAGE + ' looks empty (' + String(pageBytes) + ' bytes)')
  return VIEW + ' ' + String(bytes) + ' B, ' + PAGE + ' ' + String(pageBytes) + ' B'
})

check('dialog-export', () => {
  const at = source.indexOf('export function BackupRestoreDialog(props: BackupRestoreProps): React.ReactElement {')
  assert(at !== -1, VIEW + ' must export BackupRestoreDialog with its props type and React.ReactElement')
  return 'exported at line ' + String(lineAt(source, at))
})

check('dialog-props', () => {
  const start = source.indexOf('export interface BackupRestoreProps {')
  assert(start !== -1, VIEW + ' has no BackupRestoreProps interface')
  const end = source.indexOf('}', start)
  assert(end !== -1, 'BackupRestoreProps is not closed')
  const block = source.slice(start, end)
  for (const field of ['open: boolean', 'lang: Lang', 't: TFunction', 'busy: string | null', 'run: RunOp', 'reload: () => Promise<void>', 'onClose: () => void', 'onRestored: () => void']) {
    assert(block.includes(field), 'BackupRestoreProps is missing ' + field)
  }
  assert(has(source, 'const { open, lang, t, busy, run, reload, onClose, onRestored } = props'), 'the component must read every prop it renders from')
  return '8 props, all destructured'
})

// ── the card button and the mount ────────────────────────────────────────────

check('card-button', () => {
  const at = page.indexOf("t('backup.restore')")
  assert(at !== -1, PAGE + ' never renders the backup.restore copy')
  const line = pageBody[lineAt(page, at) - 1] ?? ''
  assert(line.includes('<Button'), 'backup.restore must label a button, not prose')
  assert(line.includes('setRestoring(true)'), 'the restore button must open the dialog through setRestoring(true)')
  assert(!line.includes('run(') && !line.includes('backup.restoreRow'), 'the restore button must not send the write itself')
  assert(line.includes('disabled={rows.length === 0}'), 'a folder with no backups has nothing to restore: disable the button')
  return 'line ' + String(lineAt(page, at)) + ': Button opens the dialog'
})

check('dialog-mounted', () => {
  const at = page.indexOf('<BackupRestoreDialog')
  assert(at !== -1, PAGE + ' never mounts BackupRestoreDialog')
  const end = page.indexOf('/>', at)
  const mount = page.slice(at, end === -1 ? page.length : end)
  for (const binding of ['open={restoring}', 'lang={lang}', 't={t}', 'busy={busy}', 'run={run}', 'reload={reload}', 'onClose={closeRestore}', 'onRestored={restored}']) {
    assert(mount.includes(binding), 'the dialog mount is missing ' + binding)
  }
  return 'all props bound'
})

check('cancel-closes', () => {
  assert(has(source, 'onClose={onClose}'), 'the dialog must hand its close handler to the shared Dialog')
  assert(has(source, "t('action.cancel')"), 'every dialog needs a way out')
  assert(has(source, "t('action.close')"), 'after a restore the footer button becomes Close')
  assert(has(page, 'const closeRestore = React.useCallback(() => { setRestoring(false) }, [])'), 'closing must clear restoring')
  assert(has(page, 'onClose={closeRestore}'), 'the page must pass the stable close callback')
  return 'Escape/backdrop/cancel all close, focus returns via Dialog'
})

// ── the three ops, each wired to its own shape ───────────────────────────────

check('ops-table', () => {
  const table = source.slice(source.indexOf('const RESTORE_OPS'), source.indexOf('} as const'))
  for (const id of ['backup.mcpIndex', 'backup.diff', 'backup.restoreRow']) {
    assert(table.includes("'" + id + "'"), 'RESTORE_OPS does not carry ' + id)
    assert(count(source, "'" + id + "'") === 1, id + ' must be named exactly once')
  }
  return 'index, diff, restoreRow'
})

check('index-read', () => {
  assert(has(source, 'void runOp(RESTORE_OPS.index, {})'), 'backup.mcpIndex is a read: it must go through runOp with an empty payload')
  assert(has(source, 'function indexOf(value: unknown): BackupEntry[]'), 'the index answer needs one normaliser')
  assert(has(source, "const rows = asRecord(value).backups"), 'the index reads backups[] off the answer')
  assert(has(source, 'rows: Array.isArray(item.rows)'), 'each backup entry keeps occurrence-aware row refs')
  return 'runOp(backup.mcpIndex, {})'
})

check('diff-read', () => {
  assert(has(source, 'void runOp(RESTORE_OPS.diff, { backup, id: target.id, occurrence: target.occurrence })'), 'backup.diff must decode the row key and send occurrence')
  assert(!has(source, 'run(RESTORE_OPS.diff'), 'backup.diff is a read: run() only reports success, so it cannot carry the lines')
  assert(has(source, 'setDiff(diffOf(result.data))'), 'the diff must come from the op answer')
  assert(has(source, "kind: DIFF_KINDS.has(item.kind as DiffKind)"), 'diff kinds are narrowed to same/add/del')
  return '{ backup, id: row }'
})

check('restore-write', () => {
  const handlerAt = source.indexOf('const restore = (): void => {')
  assert(handlerAt !== -1, 'the dialog must own a restore() handler')
  const callAt = source.indexOf('void run(RESTORE_OPS.restore, { backup, id: target.id, occurrence: target.occurrence })')
  assert(callAt !== -1, 'the view never sends backup.restoreRow')
  assert(count(source, 'run(RESTORE_OPS.restore') === 1, 'backup.restoreRow must be sent from exactly one place')
  assert(callAt > handlerAt, 'the write must be sent from restore(), never from a render path')
  assert(!page.includes("'backup.restoreRow'"), 'the card must never send the write itself')
  const after = source.slice(callAt, callAt + 400)
  assert(after.includes('await reload()'), 'a restore must reload the snapshot after the host answers')
  assert(after.includes('onRestored()'), 'a restore must tell the page to report it and refresh its list')
  assert(after.includes('setRestored(true)'), 'a restore must leave the done state visible')
  return 'sent once, then reload() and onRestored()'
})

check('busy-key', () => {
  assert(has(source, "const restoreBusy = RESTORE_OPS.restore + ':' + row"), 'the busy key must be the op plus the row id, like the shell builds it')
  assert(has(source, 'busy={busy === restoreBusy}'), 'the confirm button must show the shell busy state')
  assert(has(source, 'busy={diffLoading}'), 'reading a diff must show that it is loading')
  return 'busy = backup.restoreRow:<row>'
})

// ── the diff, and the gate in front of the write ─────────────────────────────

check('diff-render', () => {
  assert(has(source, 'diff.lines.map((line, position) => ('), 'the diff lines must be mapped into rows')
  assert(has(source, 'style={{ ...DIFF_LINE, color: toneOf(line.kind) }}'), 'each line must take its tone from its kind')
  assert(has(source, "{markOf(line.kind)}"), 'each line needs its + or - gutter')
  assert(has(source, "if (kind === 'add') return T.success"), 'added lines need the success token')
  assert(has(source, "if (kind === 'del') return T.danger"), 'removed lines need the danger token')
  assert(has(source, 'fontFamily: MONO'), 'diff lines must be monospaced')
  assert(has(source, "whiteSpace: 'pre-wrap'"), 'indentation in the row text must survive')
  assert(has(source, 'role="region"'), 'the diff needs a named region for screen readers')
  assert(has(source, '{diff.backup}') && has(source, '{diff.id}'), 'the diff header must name the backup and the row')
  return 'same/add/del, mono, tokens only'
})

check('confirm-gating', () => {
  assert(has(source, "const canRestore = diff !== null && confirmed && backup !== '' && row !== ''"), 'the restore must need a loaded diff and a ticked confirmation')
  const guardAt = source.search(/if \(!canRestore[^)]*\) return/)
  const callAt = source.indexOf('void run(RESTORE_OPS.restore')
  assert(guardAt !== -1, 'restore() must refuse to run without a diff and a confirmation')
  assert(guardAt < callAt, 'the guard must come before the write')
  assert(/disabled=\{!canRestore[^}]*\}/.test(source), 'the confirm button must be disabled until the gate passes')
  assert(has(source, "const writing = busy !== null && busy.startsWith(RESTORE_OPS.restore)"), 'the pair cannot be swapped while a restore is in flight')
  assert(has(source, 'checked={confirmed}'), 'the confirmation is a checkbox the user ticks')
  assert(has(source, 'setConfirmed(false)'), 'a new pick or a new diff must clear the confirmation')
  assert(has(source, "t('backup.restoreConfirm')"), 'the confirmation needs its own copy')
  return 'diff loaded + ticked box, or no write'
})

check('states', () => {
  assert(has(source, "t('backup.restoreEmpty')") && has(source, '<Empty title={t(\'backup.restoreEmpty\')}'), 'a backup set with no MCP rows needs the empty state')
  assert(has(source, "t('backup.loading')"), 'loading the index must say so')
  assert(has(source, 'aria-busy={loading}'), 'the loading state must be announced')
  assert(has(source, 'setIndexError(result.message)'), 'a failed index read must keep the host message')
  assert(has(source, 'setDiffError(result.message)'), 'a failed diff read must keep the host message')
  assert(count(source, "t('action.retry')") === 2, 'both failures need a retry')
  assert(has(source, 'setRestored(true)'), 'a successful restore must render its done state')
  return 'loading / empty / error / done'
})

// ── tokens, catalogs, imports, size ──────────────────────────────────────────

check('no-literal-colour', () => {
  for (const [path, text] of [[VIEW, source], [PAGE, page]]) {
    assert(!text.includes('#'), path + ' uses a hash character; a literal colour belongs in a token')
    for (const pattern of ['rgb(', 'rgba(', 'hsl(', 'hsla(']) {
      assert(!text.includes(pattern), path + ' uses ' + pattern + '; use a theme token')
    }
  }
  assert(has(source, 'T.success') && has(source, 'T.danger') && has(source, 'T.text3'), 'the diff must colour from tokens')
  assert(has(source, 'className="th-input"'), 'controls must wear the shared th-input class')
  return 'tokens only, both files'
})

check('i18n-keys', () => {
  const catalog = readFileSync(join(ROOT, CATALOG), 'utf8')
  const keys = name => {
    const marker = new RegExp('const ' + name + ': Catalog = \\{')
    const found = marker.exec(catalog)
    assert(found !== null, 'i18n.ts has no ' + name + ' catalog')
    const start = found.index + found[0].length - 1
    let depth = 0
    for (let cursor = start; cursor < catalog.length; cursor += 1) {
      if (catalog[cursor] === '{') depth += 1
      else if (catalog[cursor] === '}') {
        depth -= 1
        if (depth === 0) return new Set([...catalog.slice(start + 1, cursor).matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1]))
      }
    }
    throw new Error(name + ' catalog is not closed')
  }
  const zh = keys('zh')
  const en = keys('en')
  for (const key of ['backup.restore', 'backup.restoreTitle', 'backup.restorePick', 'backup.restoreDiff', 'backup.restoreConfirm', 'backup.restoreDone', 'backup.restoreEmpty']) {
    assert(zh.has(key), 'zh is missing ' + key)
    assert(en.has(key), 'en is missing ' + key)
  }
  const isKey = text => text.length > 0 && text.split('').every(ch => 'abcdefghijklmnopqrstuvwxyz0123456789._-'.includes(ch))
  for (const [path, text] of [[VIEW, source], [PAGE, page]]) {
    let from = 0
    for (;;) {
      const at = text.indexOf("t('", from)
      if (at === -1) break
      const end = text.indexOf("'", at + 3)
      if (end === -1) break
      const key = text.slice(at + 3, end)
      if (isKey(key)) assert(zh.has(key) && en.has(key), path + ':' + String(lineAt(text, at)) + ' calls t(' + key + ') which a catalog does not define')
      from = end
    }
  }
  const zhBackup = [...zh].filter(key => key.startsWith('backup.'))
  const enBackup = [...en].filter(key => key.startsWith('backup.'))
  assert(zhBackup.length === enBackup.length, 'the backup.* key sets drifted between zh and en')
  return '7 restore keys, both catalogs, every t() resolved'
})

check('imports', () => {
  const allowed = new Set(['../api.js', '../components.js', '../types.js', '../theme.js', '../i18n.js'])
  for (const line of source.split('\n')) {
    if (!line.startsWith('import ')) continue
    const at = line.indexOf("'")
    if (at === -1) continue
    const spec = line.slice(at + 1, line.indexOf("'", at + 1))
    if (!spec.startsWith('.')) continue
    assert(spec.endsWith('.js'), 'relative import ' + spec + ' needs its .js suffix')
    assert(allowed.has(spec), 'the dialog may only import api, components, types, theme and i18n, not ' + spec)
  }
  assert(has(source, "import { runOp } from '../api.js'"), 'reads go through the api module')
  return 'api, components, types, theme, i18n'
})

check('no-network-no-html', () => {
  for (const pattern of ['fetch(', 'XMLHttpRequest', 'innerHTML', 'dangerouslySetInnerHTML', 'outerHTML']) {
    assert(!source.includes(pattern), VIEW + ' must not use ' + pattern)
  }
  return 'reads via runOp, no HTML strings'
})

check('size-cap', () => {
  assert(body.length < MAX_VIEW_LINES, VIEW + ' has ' + String(body.length) + ' lines, cap is ' + String(MAX_VIEW_LINES))
  assert(bytes < MAX_VIEW_BYTES, VIEW + ' is ' + String(bytes) + ' bytes, cap is ' + String(MAX_VIEW_BYTES))
  assert(pageBody.length < MAX_PAGE_LINES, PAGE + ' has ' + String(pageBody.length) + ' lines, cap is ' + String(MAX_PAGE_LINES))
  assert(pageBytes < MAX_PAGE_BYTES, PAGE + ' is ' + String(pageBytes) + ' bytes, cap is ' + String(MAX_PAGE_BYTES))
  return String(body.length) + ' + ' + String(pageBody.length) + ' lines within caps'
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