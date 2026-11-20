#!/usr/bin/env node
/**
 * probe/next/client-config.mjs — the config view (task-18), checked from outside.
 *
 * Static gates only: the probe reads the view, the shell and the catalogs, and asserts the
 * properties the page must keep. No host, no browser, no writes.
 *
 * Coverage:
 *   1. the exported view exists, the scaffold is gone and the shell mounts it;
 *   2. a read (config.export) and a write (config.import) are the only two ops;
 *   3. the export is fetched with runOp, rendered read-only and downloadable as a Blob;
 *   4. paste and file feed one import text, so one parser covers both inputs;
 *   5. the preview counts the four sections and rejects a wrong shape before any write;
 *   6. merge is the default and replace is the only path behind a Dialog confirmation;
 *   7. the write sends { bundle, mode } and keys its busy state as the bare op id;
 *   8. the summary line reports the groups the bundle added or merged;
 *   9. every control carries an accessible name and no raw button lives here;
 *  10. layout comes from th-* classes and no style prop carries a literal colour;
 *  11. imports stay inside the client modules and the file stays inside the agreed length;
 *  12. every t() key resolves in both catalogs, and the config catalogs agree.
 *
 * No dependencies: PASS/FAIL lines, exit 1 when anything fails.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = join(ROOT, 'src', 'client', 'views', 'config.tsx')
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
const rel = file => relative(ROOT, file).split('\\').join('/')
const lineAt = (text, index) => text.slice(0, index).split('\n').length
/** Source with block comments and whole-line comments removed. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')

const source = read(VIEW)
const body = code(source)
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

/** True when a state value reaches a Callout somewhere in the view. */
function reachesCallout(name) {
  return body.includes(name + ' === null ? null :') || body.includes(name + ' ? (')
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

// ── the view exists and is mounted ──────────────────────────────────────────

check('view-export', () => {
  assert(/export function ConfigView\(props: ViewProps\): React\.ReactElement/.test(source), 'config.tsx must export ConfigView(props: ViewProps)')
  assert((source.match(/export function ConfigView/g) ?? []).length === 1, 'ConfigView must be exported exactly once')
  assert(/import \* as React from 'react'/.test(source), 'the view must import React')
  assert(/import type \{[^}]*\bViewProps\b[^}]*\} from '\.\.\/types\.js'/.test(source), 'ViewProps must come from ../types.js')
  // The scaffold rendered a single Empty; a real page renders both sections.
  assert(!/<Empty title=\{props\.t\('config\.empty'\)\}/.test(source), 'the scaffold Empty return is still there')
  assert(body.includes('<Card label={t(\'config.export\')}'), 'the export section must render a Card')
  assert(body.includes('<Card label={t(\'config.import\')}'), 'the import section must render a Card')
  return 'ConfigView exported once, scaffold replaced, two sections'
})

check('shell-wiring', () => {
  assert(/import \{ ConfigView \} from '\.\/views\/config\.js'/.test(shell), 'the shell must import ConfigView from ./views/config.js')
  assert(/config: <ConfigView snapshot=\{snapshot\}/.test(shell), 'the shell must mount ConfigView with the snapshot')
  const entries = (shell.match(/id: 'config'/g) ?? []).length
  assert(entries === 1, 'exactly one nav entry may carry id config, found ' + entries)
  return 'one nav entry, one mount'
})

// ── two ops, one read and one write ─────────────────────────────────────────

check('op-ids', () => {
  assert(/const EXPORT = 'config\.export'/.test(body), 'the export op id must live in one constant')
  assert(/const IMPORT = 'config\.import'/.test(body), 'the import op id must live in one constant')
  assert((body.match(/(?:runOp|run)\(EXPORT/g) ?? []).length === 1, 'the export op must only be sent once, through its constant')
  assert((body.match(/(?:runOp|run)\(IMPORT/g) ?? []).length === 1, 'the import op must only be sent once, through its constant')
  assert(!/(?:runOp|run)\(\s*'config\./.test(body), 'no op may be spelled inline, only through its constant')
  return 'config.export / config.import, one constant each'
})

check('export-read', () => {
  const load = section('const loadExport = React.useCallback(async () => {', '}, [])')
  assert(load.includes('await runOp(EXPORT, {})'), 'the export must be read through runOp(EXPORT, {})')
  assert(!/\brun\(EXPORT/.test(load), 'the export must not travel through the write helper')
  const start = load.indexOf('setLoading(true)')
  const awaitAt = load.indexOf('await runOp(EXPORT, {})')
  const settle = load.indexOf('setLoading(false)')
  assert(start !== -1 && awaitAt !== -1 && settle !== -1 && start < awaitAt && awaitAt < settle, 'busy must bracket the read')
  assert(load.includes('setExportError(answer.message)'), 'a failed read must keep the host message')
  assert(load.includes('setExportText(exportTextOf(answer.data))'), 'a successful read must render the payload')
  assert(reachesCallout('exportError'), 'the failed read must reach a Callout')
  const effect = section('React.useEffect(() => {', '}, [loadExport])')
  assert(effect.includes('void loadExport()'), 'mounting the view must read the export once')
  assert(!/\brun\(/.test(effect), 'mounting must never send a write')
  return 'runOp on mount, busy bracketed, failure kept'
})

check('export-download', () => {
  const fn = section('function download(', 'return true')
  assert(fn.includes("new Blob([text], { type: 'application/json' })"), 'the download must be a JSON Blob')
  assert(fn.includes("document.createElement('a')"), 'the download needs an anchor')
  assert(fn.includes('anchor.download = name'), 'the anchor must carry a download name')
  assert(fn.includes('const url = URL.createObjectURL('), 'the blob must be served through an object URL')
  assert(fn.includes('URL.revokeObjectURL(url)'), 'the object URL must be revoked')
  assert(fn.includes("typeof URL.createObjectURL !== 'function'"), 'a host without Blob support must be reported, not assumed')
  assert(fn.includes('anchor.click()'), 'the download must be triggered')
  const save = section('const save = React.useCallback(', '}, [exportText, exported])')
  assert(save.includes('stampOf(exported)'), 'the filename stamp must come from the export payload')
  assert(save.includes('.json'), 'the download must be a .json file')
  assert(save.includes('setDownloadError(!download('), 'a refused download must be surfaced')
  assert(/onClick=\{save\}/.test(body), 'the download button must call save')
  assert(/disabled=\{exportText === ''\}/.test(body), 'download must stay disabled until the export is loaded')
  assert(reachesCallout('downloadError'), 'a refused download must reach a Callout')
  return 'Blob download, stamped name, revoked URL, disabled until loaded'
})

check('export-panel', () => {
  const box = section('<Field id={EXPORT_BOX_ID}', '</Field>')
  assert(box.includes('readOnly'), 'the exported JSON must be read-only')
  assert(box.includes('value={exportText}'), 'the box must render the exported text')
  assert(box.includes("aria-label={t('config.export')}"), 'the export box needs an accessible name')
  assert(body.includes("t('config.exported')"), 'a loaded export must say so')
  assert(body.includes('<Loading label={t(\'state.loading\')}'), 'the first read must show a loading state')
  assert(body.includes('<Empty'), 'an empty export must fall back to an empty state')
  assert(body.includes("t('config.empty')"), 'the empty state needs its key')
  assert(body.includes("t('action.retry')"), 'the empty and failed states must offer a retry')
  assert(body.includes('function exportTextOf('), 'the payload needs one narrowing helper')
  assert(body.includes("if (typeof record.json === 'string')"), 'a 1.x host answering { json } must still render')
  return 'read-only box, loading and empty states, retry'
})

// ── import: one text, two inputs ────────────────────────────────────────────

check('paste-input', () => {
  const box = section('<Field id={PASTE_ID}', '</Field>')
  assert(box.includes('id={PASTE_ID}'), 'the paste box needs its id')
  assert(box.includes('value={importText}'), 'the paste box must own its value')
  assert(box.includes('setImportText(event.target.value)'), 'typing must feed the import text')
  assert(box.includes("aria-label={t('config.paste')}"), 'the paste box needs an accessible name')
  assert(box.includes("placeholder={t('config.importHint')}"), 'the paste box must show what to paste')
  assert(/const parsed = React\.useMemo\(\(\) => \(importText\.trim\(\) === '' \? null : parseBundle\(importText\)\), \[importText\]\)/.test(body), 'one memo must parse whatever the inputs produced')
  assert(/const invalid = importText\.trim\(\) !== '' && parsed === null/.test(body), 'invalid must mean non-empty text that does not parse')
  return 'paste owns the text, one memo parses it'
})

check('file-input', () => {
  const input = section('className="th-visually-hidden"', '/>')
  assert(input.includes('type="file"'), 'the file control must be a file input')
  assert(input.includes('accept=".json,application/json"'), 'the file control must accept JSON')
  assert(input.includes("aria-label={t('config.pickFile')}"), 'the file input needs an accessible name')
  assert(body.includes('htmlFor={FILE_ID}'), 'a label must open the file picker')
  assert(body.includes("t('config.pickFile')"), 'the label must name the picker')
  assert(input.includes('onFile(event.target.files?.[0] ?? null)'), 'the chosen file must be read')
  assert(input.includes("event.target.value = ''"), 'the input must reset so the same file can be picked twice')
  const read = section('function readFile(', 'readAsText(file)')
  assert(read.includes('return file.text()'), 'File.text() must be the first choice')
  assert(read.includes('new FileReader()'), 'an older runtime must fall back to FileReader')
  const onFile = section('const onFile = React.useCallback(', '}, [lang])')
  assert(onFile.includes('setImportText(text)'), 'the file contents must feed the same import text')
  assert(onFile.includes('setFileError('), 'a failed read must be reported')
  assert(reachesCallout('fileError'), 'a failed read must reach a Callout')
  assert(onFile.includes("copy(lang, '这个文件读不出来。'"), 'the read failure must be bilingual and must not leak a host error')
  return 'labelled picker, File.text with FileReader fallback, one import text'
})

check('preview-counts', () => {
  const parse = section('function parseBundle(', '  groups,')
  assert(parse.includes('JSON.parse(text)'), 'the bundle must be parsed as JSON')
  assert(parse.includes('catch {') && parse.includes('return null'), 'invalid JSON must parse to null')
  assert(body.includes('function dataOf('), 'the bundle shape needs one narrowing helper')
  assert(body.includes('const nested = asRecord(record.data)'), 'the 2.0 data wrapper must be read')
  assert(body.includes('Object.keys(nested).length > 0 ? nested : record'), 'a bare 1.x file must be accepted too')
  for (const key of ['groups', 'collections', 'presets', 'toolDeny']) {
    assert(body.includes("'" + key + "'"), 'the bundle section ' + key + ' is never read')
  }
  assert(parse.includes('listOf(data.groups).flatMap'), 'groups must be counted as rows')
  assert(parse.includes('listOf(data.collections).length'), 'collections must be counted')
  assert(parse.includes('presetCount(data.presets)'), 'presets must be counted')
  assert(parse.includes('listOf(data.toolDeny).length'), 'masks must be counted')
  assert(body.includes('function presetCount('), 'presets need one counter that accepts a list or a map')
  assert(parse.includes('bundle: value'), 'the parsed object must travel unchanged')
  assert(body.includes('groups: parsed.counts.groups'), 'the preview must render the group count')
  assert(body.includes('collections: parsed.counts.collections'), 'the preview must render the drawer count')
  assert(body.includes('presets: parsed.counts.presets'), 'the preview must render the preset count')
  assert(body.includes('deny: parsed.counts.deny'), 'the preview must render the mask count')
  assert(body.includes("{mode === 'replace' ? t('config.replace') : t('config.merge')}"), 'the preview must show the chosen mode')
  return 'four sections counted, shape narrowed before display'
})

check('invalid-bundle', () => {
  assert(/\{invalid \? <Callout>\{t\('config\.invalid'\)\}<\/Callout> : null\}/.test(body), 'an invalid bundle must show config.invalid')
  const parse = section('function parseBundle(', '  groups,')
  assert(parse.includes("for (const key of ['groups', 'collections', 'toolDeny'] as const)"), 'the array sections must be typed as arrays')
  assert(parse.includes('!Array.isArray(data[key])'), 'a non-array section must be rejected')
  assert(parse.includes("typeof data.presets !== 'object'"), 'presets must be an object or a list')
  assert(/disabled=\{parsed === null\}/.test(body), 'apply must stay disabled while nothing parsed')
  return 'wrong shape rejected in the view, apply gated on a parsed bundle'
})

check('mode-select', () => {
  assert(/const \[mode, setMode\] = React\.useState<Mode>\('merge'\)/.test(body), 'merge must be the default mode')
  assert(/type Mode = 'merge' \| 'replace'/.test(body), 'the two modes must be typed once')
  assert(body.includes("{ value: 'merge', label: t('config.merge') }"), 'the select needs the merge option')
  assert(body.includes("{ value: 'replace', label: t('config.replace') }"), 'the select needs the replace option')
  assert(/onChange=\{next => \{ setMode\(next === 'replace' \? 'replace' : 'merge'\) \}\}/.test(body), 'an unknown mode must fall back to merge')
  assert(/\{mode === 'replace' \? <Callout tone="info">\{t\('config\.replaceWarn'\)\}<\/Callout> : null\}/.test(body), 'replace must warn before it is chosen')
  assert(/variant=\{mode === 'replace' \? 'danger' : 'primary'\}/.test(body), 'the apply button must change tone with the mode')
  return 'merge default, replace warns, tone follows the mode'
})

check('replace-confirm', () => {
  const ask = section('const askReplace = React.useCallback(', '}, [parsed])')
  assert(ask.includes('setPending(parsed)'), 'asking must stage the parsed bundle')
  assert(!/\brun\(/.test(ask), 'asking must never send')
  assert(/if \(mode === 'replace'\) askReplace\(\)\s*\n\s*else apply\(parsed, 'merge'\)/.test(body), 'only replace may open the dialog; merge must send directly')
  assert((body.match(/askReplace\(\)/g) ?? []).length === 1, 'askReplace may only be called from the replace branch')
  const confirm = section('const confirm = React.useCallback(', '}, [apply, pending])')
  const clear = confirm.indexOf('setPending(null)')
  const send = confirm.indexOf("apply(pending, 'replace')")
  assert(clear !== -1 && send !== -1 && clear < send, 'the dialog must close before the op is sent')
  assert(/open=\{pending !== null\}/.test(body), 'the dialog must open on a staged bundle')
  assert(/title=\{t\('dialog\.confirmTitle'\)\}/.test(body), 'the dialog needs the confirm title')
  assert(/onClose=\{close\}/.test(body), 'closing the dialog must clear the staged bundle')
  const close = section('const close = React.useCallback(', '}, [])')
  assert(!/\brun\(/.test(close), 'cancel must never send')
  assert(close.includes('setPending(null)'), 'cancel must clear the staged bundle')
  assert(/onClick=\{close\}/.test(body), 'cancel must use the clearing handler')
  assert(/onClick=\{confirm\}/.test(body), 'confirm must run the staged bundle')
  assert(/\{t\('action\.cancel'\)\}/.test(body) && /\{t\('action\.confirm'\)\}/.test(body), 'the dialog buttons need their labels')
  assert(body.includes("<div>{t('config.replaceWarn')}</div>"), 'the dialog must state what replace drops')
  const dialogPreview = body.slice(body.lastIndexOf("{t('config.preview', {"))
  assert(dialogPreview.includes('groups: pending.counts.groups'), 'the dialog must show the exact counts')
  assert(/busy=\{busy === IMPORT\}/.test(body), 'the confirm button must show the op in flight')
  return 'replace behind a dialog, merge direct, cancel never sends'
})

check('write-payload', () => {
  const apply = section('const apply = React.useCallback(', '}, [before, loadExport, run])')
  assert(apply.includes('{ bundle: target.bundle, mode: how }'), 'the write must send { bundle, mode }')
  assert(apply.includes('{ bundle: target.bundle, mode: how, confirm: true }'), 'a replace must carry confirm:true, which the config domain requires')
  assert((apply.match(/confirm: true/g) ?? []).length === 1, 'only the replace branch may confirm')
  assert(/how === 'replace'\s*\n\s*\? \{ bundle: target\.bundle, mode: how, confirm: true \}\s*\n\s*: \{ bundle: target\.bundle, mode: how \}/.test(apply), 'confirm may only travel with the replace mode')
  assert(apply.includes('void run(IMPORT, payload)'), 'the write must send the built payload')
  assert((body.match(/void run\(/g) ?? []).length === 1, 'exactly one write site may exist')
  assert(apply.includes('if (!ok) return'), 'a failed write must not report a result')
  assert(apply.includes('void loadExport()'), 'a successful write must refresh the exported JSON')
  assert((body.match(/apply\(/g) ?? []).length === 2, 'apply may only be called from the merge button and the dialog')
  assert(body.includes("apply(pending, 'replace')"), 'the dialog must send replace')
  assert(body.includes("apply(parsed, 'merge')"), 'the merge button must send merge')
  return 'one send site, { bundle, mode }, refreshed after success'
})

check('result-summary', () => {
  const before = section('const before = React.useMemo(', '}, [snapshot.groups])')
  assert(before.includes('ids.add(group.id)'), 'the snapshot group ids must be remembered')
  assert(before.includes('names.add(group.name)'), 'the snapshot group names must be remembered')
  const apply = section('const apply = React.useCallback(', '}, [before, loadExport, run])')
  assert(apply.includes('!before.ids.has(group.id) && !before.names.has(group.name)'), 'a group counts as added only when neither id nor name exists')
  assert(apply.includes('setResult({ added, merged: target.counts.groups - added })'), 'the summary must split added from merged')
  assert(/\{t\('config\.result', \{ groups: result\.added, merged: result\.merged \}\)\}/.test(body), 'the summary must use the result counts')
  assert(body.includes('interface Imported'), 'the summary shape must be declared')
  assert(apply.indexOf('setResult(null)') !== -1 && apply.indexOf('setResult(null)') < apply.indexOf('void run('), 'the old summary must clear before the write')
  return 'added vs merged from the pre-write snapshot'
})

// ── accessibility, structure, colour ────────────────────────────────────────

check('accessible-labels', () => {
  const fields = (body.match(/<Field id=\{/g) ?? []).length
  assert(fields === 3, 'expected one Field per input (export box, paste, mode), found ' + fields)
  assert((body.match(/label=\{t\('config\.(?:export|paste|mode)'\)\}/g) ?? []).length >= 3, 'every Field needs its label')
  assert((body.match(/<textarea/g) ?? []).length === 2, 'both textareas must be labelled by a Field')
  assert((body.match(/aria-label=\{t\('config\.(?:export|paste|pickFile)'\)\}/g) ?? []).length >= 3, 'every raw control needs an accessible name')
  assert(/label=\{t\('config\.mode'\)\}/.test(body), 'the select needs an accessible name')
  assert((body.match(/<Card label=/g) ?? []).length === 2, 'both cards must name their group')
  assert((body.match(/<Button/g) ?? []).length >= 7, 'actions must be buttons from components.tsx')
  assert(!/<button\b/.test(body), 'raw buttons belong to components.tsx')
  assert(/title=\{t\('dialog\.confirmTitle'\)\}/.test(body), 'the dialog needs a title')
  return fields + ' labelled fields, no raw buttons'
})

check('no-literal-colours', () => {
  const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(body)
  assert(match === null, 'a literal colour at line ' + lineAt(body, match === null ? 0 : match.index))
  for (const style of body.matchAll(/style=\{\{([\s\S]*?)\}\}/g)) {
    assert(!/\b(?:color|background|backgroundColor|borderColor)\s*:/.test(style[1]), 'a style prop carries a colour')
  }
  assert(body.includes('style={BOX}'), 'the JSON boxes must take their look from one style constant')
  assert(body.includes('...monoStyle'), 'the monospace look must come from the themed token')
  assert(/className="th-/.test(body), 'layout comes from the th-* classes')
  return 'th-* classes and themed tokens only'
})

check('no-html-injection', () => {
  for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert(body.indexOf(pattern) === -1, 'the view uses ' + pattern)
  }
  return 'no HTML string injection'
})

check('no-todo', () => {
  const at = source.search(/TODO\(|FIXME|XXX:/)
  assert(at === -1, 'config.tsx:' + lineAt(source, at) + ' still carries a TODO marker')
  return 'no TODO/FIXME'
})

check('imports', () => {
  const allowed = new Set(['react', '../api.js', '../components.js', '../types.js'])
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
  assert(lines < 480, 'config.tsx has ' + lines + ' lines (limit 480)')
  assert(bytes < 80 * 1024, 'config.tsx is ' + bytes + ' bytes (limit 80 KB)')
  return lines + ' lines, ' + bytes + ' bytes'
})

// ── the catalogs ───────────────────────────────────────────────────────────

check('i18n-resolved', () => {
  const zh = catalogKeys('zh')
  const en = catalogKeys('en')
  const used = new Set()
  for (const match of body.matchAll(/\bt\('([^']+)'/g)) {
    used.add(match[1])
    assert(zh.has(match[1]), "t('" + match[1] + "') is not in the zh catalog")
    assert(en.has(match[1]), "t('" + match[1] + "') is not in the en catalog")
  }
  const required = ['config.title', 'config.export', 'config.exportHint', 'config.download', 'config.import',
    'config.importHint', 'config.paste', 'config.pickFile', 'config.preview', 'config.mode', 'config.merge',
    'config.replace', 'config.replaceWarn', 'config.apply', 'config.result', 'config.invalid', 'config.empty',
    'config.exported', 'dialog.confirmTitle', 'action.retry', 'action.clear', 'action.cancel', 'action.confirm',
    'state.loading']
  for (const key of required) assert(used.has(key), 'the view never calls t(' + key + ')')
  const zhConfig = [...zh].filter(key => key.startsWith('config.'))
  const enConfig = [...en].filter(key => key.startsWith('config.'))
  assert(zhConfig.length === enConfig.length, 'the two catalogs disagree on config key count')
  for (const key of zhConfig) assert(en.has(key), 'en is missing ' + key)
  return used.size + ' keys used, all resolved, ' + zhConfig.length + ' config keys in both catalogs'
})

// ── report ──────────────────────────────────────────────────────────────────

console.log(passed + '/' + (passed + failures.length) + ' checks passed')
if (failures.length > 0) {
  console.log('failed: ' + failures.join(', '))
  process.exit(1)
}
