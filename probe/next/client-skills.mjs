#!/usr/bin/env node
/**
 * probe/next/client-skills.mjs -- the skills page (task-13), checked from outside.
 *
 * Static gates only: it reads src/client/views/skills.tsx, the catalogs in src/client/i18n.ts and
 * the op declarations in src/domains/skills.ts, and fails when the view drifts away from what the
 * domain accepts. No host, no browser, no third-party library; every line is PASS or FAIL and the
 * process exits 1 when anything fails.
 *
 * Coverage:
 *   1. the file exists, still exports SkillsView, and stays inside its line budget;
 *   2. all six skill ops appear, in a table this view owns (api.ts OPS carries none of them);
 *   3. one payload check per op, against the fields src/domains/skills.ts destructures;
 *   4. the trash read and its parser (the snapshot never carries the trash);
 *   5. empty states for "no skills" and "nothing matched", plus an empty trash;
 *   6. delete asks first: the row button only opens the dialog, the op runs on confirm;
 *   7. one check per interactive action: toggle, move, delete, restore, import, trash refresh,
 *      search, root filter;
 *   8. accessibility: a label on every switch/select/search field, a name on every button;
 *   9. colour from tokens only, imports carry .js, every t() key resolves, no unsafe HTML.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = join(ROOT, 'src', 'client', 'views', 'skills.tsx')
const I18N = join(ROOT, 'src', 'client', 'i18n.ts')
const DOMAIN = join(ROOT, 'src', 'domains', 'skills.ts')
const BT = String.fromCharCode(96)

let passed = 0
let failed = 0
const failedNames = []

function check(name, run) {
  try {
    const detail = run()
    passed += 1
    console.log('PASS ' + name + (detail === undefined || detail === '' ? '' : ' (' + detail + ')'))
  }
  catch (error) {
    failed += 1
    failedNames.push(name)
    console.log('FAIL ' + name + ' -- ' + (error instanceof Error ? error.message : String(error)))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const rel = file => relative(ROOT, file).split('\\').join('/')
const read = file => readFileSync(file, 'utf8')

/** Source with block and line comments removed: prose may name an op or a token in passing. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')
const lineAt = (text, index) => text.slice(0, Math.max(0, index)).split('\n').length

/** One JSX opening tag, from "<Name" to its own ">" (braces and quoted strings respected). */
function tagAt(source, start) {
  let index = start
  let braces = 0
  let quote = ''
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== '') {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === BT) {
      quote = char
      continue
    }
    if (char === '{') braces += 1
    else if (char === '}') braces -= 1
    else if (char === '>' && braces === 0) return source.slice(start, index + 1)
  }
  throw new Error('unterminated tag at offset ' + start)
}

/** Every opening tag of one component name, in source order. */
function tags(source, name) {
  const out = []
  const needle = '<' + name
  let index = source.indexOf(needle)
  while (index !== -1) {
    out.push({ index, text: tagAt(source, index) })
    index = source.indexOf(needle, index + needle.length)
  }
  return out
}

/** The text from one marker to the next, failing loudly when either is gone. */
function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  assert(start !== -1, 'source does not contain ' + JSON.stringify(from))
  const end = source.indexOf(to, start)
  assert(end !== -1, 'source does not contain ' + JSON.stringify(to) + ' after ' + JSON.stringify(from))
  return source.slice(start, end)
}

// -- gates -------------------------------------------------------------------

const source = read(VIEW)
const body = code(source)
const domain = read(DOMAIN)

check('file-budget', () => {
  const lines = source.split('\n').length
  const bytes = statSync(VIEW).size
  assert(lines < 450, rel(VIEW) + ' is ' + lines + ' lines (limit 450)')
  assert(bytes < 40 * 1024, rel(VIEW) + ' is ' + bytes + ' bytes (limit 40 KB)')
  return lines + ' lines, ' + bytes + ' bytes'
})

check('export-skills-view', () => {
  assert(/export function SkillsView\(props: ViewProps\): React\.ReactElement \{/.test(source), 'SkillsView must keep its exported name and ViewProps signature')
  assert(/\{trashSection\}/.test(source), 'the trash section must be rendered by the view')
  assert(/snapshot\.skills\.length === 0/.test(body), 'the view must branch on an empty snapshot, not a placeholder')
  return 'export function SkillsView(props: ViewProps)'
})

check('own-op-table', () => {
  assert(/const OPS = \{/.test(source), 'the view must own its op table')
  const apiImport = /import \{([^}]*)\} from '\.\.\/api\.js'/.exec(source)
  assert(apiImport !== null, 'the view must import from ../api.js')
  assert(/\brunOp\b/.test(apiImport[1]), 'the trash read needs runOp from ../api.js')
  assert(!/\bOPS\b/.test(apiImport[1]), 'api.ts OPS has no skill op, so the view must not import it')
  return 'runOp from api.js + a local OPS table'
})

const OPS = ['skill.toggle', 'skill.import', 'skill.move', 'skill.trash', 'skill.restore', 'skill.delete']

check('ops-declared', () => {
  for (const op of OPS) assert(source.includes("'" + op + "'"), 'the view never names ' + op)
  return OPS.length + ' ops named'
})

check('ops-known-to-domain', () => {
  for (const op of OPS) {
    assert(domain.includes("id: '" + op + "'"), 'src/domains/skills.ts does not declare ' + op)
    assert(domain.includes("'" + op + "': guarded("), 'src/domains/skills.ts has no handler for ' + op)
  }
  return 'every op is declared and handled by the domain'
})

// -- payloads: what the handlers actually destructure ------------------------

check('payload-toggle', () => {
  assert(/run\(OPS\.toggle, \{ id: row\.id, enabled: next \}\)/.test(body), 'toggle must send { id, enabled }')
  assert(/payload\.enabled === true/.test(domain), 'the domain reads payload.enabled')
  assert(/field\(payload, 'id'\)/.test(domain), 'the domain reads payload.id')
  return '{ id, enabled }'
})

check('payload-delete', () => {
  assert(/run\(OPS\.delete, \{ id: row\.id \}\)/.test(body), 'delete must send exactly { id }')
  return '{ id }'
})

check('payload-move', () => {
  assert(/run\(OPS\.move, \{ id: row\.id, targetId: moveTarget \}\)/.test(body), 'move must send { id, targetId }')
  assert(/field\(payload, 'targetId'\)/.test(domain), 'the domain reads payload.targetId')
  return '{ id, targetId }'
})

check('payload-import', () => {
  assert(/run\(OPS\.importFile, \{ targetId: targetRoot, path: source, overwrite \}\)/.test(body), 'import must send { targetId, path, overwrite }')
  assert(/field\(payload, 'targetId'\)/.test(domain), 'the domain reads payload.targetId')
  assert(/field\(payload, 'path'\)/.test(domain), 'the domain reads payload.path')
  assert(/payload\.overwrite === true/.test(domain), 'the domain reads payload.overwrite')
  return '{ targetId, path, overwrite }'
})

check('payload-restore', () => {
  assert(/run\(OPS\.restore, \{ trashPath: item\.trashPath \}\)/.test(body), 'restore must send { trashPath }')
  assert(/field\(payload, 'trashPath'\)/.test(domain), 'the domain reads payload.trashPath')
  return '{ trashPath }'
})

check('trash-read', () => {
  assert(/runOp\(OPS\.trash, \{\}\)/.test(body), 'the trash list must be read through skill.trash')
  assert(/trashRows\(result\.data\)/.test(body), 'the answer must go through the local parser')
  assert(/item\.trashPath/.test(source) && /item\.rel/.test(source) && /item\.at/.test(source), 'the parser must keep trashPath, rel and at')
  assert(/React\.useEffect\(\(\) => \{[\s\S]*?\}, \[trashTick\]\)/.test(body), 'the trash effect must depend on trashTick')
  assert(/setTrashTick\(tick => tick \+ 1\)/.test(body), 'a write must bump trashTick so the trash is re-read')
  return 'skill.trash -> trashRows -> local state, re-read after every write'
})

// -- states -------------------------------------------------------------------

check('empty-states', () => {
  assert(/<Empty/.test(source), 'the view must use the shared Empty')
  assert(/t\('skills\.empty'\)/.test(source), 'no skills at all must render skills.empty')
  assert(/t\('skills\.emptyFiltered', \{ query \}\)/.test(source), 'a filter with no hit must render skills.emptyFiltered')
  assert(/回收站是空的/.test(source), 'an empty trash must say so')
  assert(/action=\{roots\.length === 0 \? undefined :/.test(body), 'the empty state may offer an import only when a root exists')
  return 'skills.empty, skills.emptyFiltered, empty trash'
})

check('confirm-before-delete', () => {
  const opener = source.indexOf('setDeleting(row)')
  assert(opener !== -1, 'the row delete button must set the dialog subject')
  const window = source.slice(Math.max(0, opener - 300), opener)
  assert(/onClick=\{/.test(window), 'setDeleting(row) must run from a click handler')
  assert(!/run\(/.test(window), 'the delete button must not send the op itself')
  const handler = sliceBetween(source, 'const confirmDelete', 'const confirmMove')
  assert(/run\(OPS\.delete/.test(handler), 'confirmDelete is where the delete op is sent')
  const dialog = sliceBetween(source, 'open={deleting !== null}', '</Dialog>')
  assert(/void confirmDelete\(\)/.test(dialog), 'the dialog confirm button must call confirmDelete')
  assert(/variant="danger"/.test(dialog), 'the destructive confirm must be the danger button')
  assert(/t\('action\.cancel'\)/.test(dialog), 'the dialog must offer a cancel')
  assert(/onClose=\{/.test(dialog), 'the dialog must be dismissable')
  return 'list opens the dialog, confirm sends skill.delete'
})

check('dialogs-wired', () => {
  const dialogs = tags(source, 'Dialog')
  assert(dialogs.length === 3, 'expected three dialogs (import, move, delete), found ' + dialogs.length)
  for (const dialog of dialogs) {
    assert(/\bopen=\{/.test(dialog.text), 'a dialog at line ' + lineAt(source, dialog.index) + ' is missing its open binding')
    assert(/\bonClose=\{/.test(dialog.text), 'a dialog at line ' + lineAt(source, dialog.index) + ' is missing onClose')
    assert(/\btitle=\{/.test(dialog.text), 'a dialog at line ' + lineAt(source, dialog.index) + ' is missing its title')
  }
  assert(/open=\{importing\}/.test(source), 'import needs its own open binding')
  assert(/open=\{moving !== null\}/.test(source), 'move needs its own open binding')
  return '3 dialogs: open, onClose and title on each'
})

check('busy-keys', () => {
  assert(/function busyKey\(op: string, id: string\): string \{\s*return op \+ ':' \+ id\s*\}/.test(source), 'busyKey must build the shell key op:id')
  assert(/busy=\{busy === busyKey\(OPS\.toggle, row\.id\)\}/.test(source), 'the switch needs its op:id busy key')
  assert(/busy=\{moving !== null && busy === busyKey\(OPS\.move, moving\.id\)\}/.test(source), 'move needs its op:id busy key')
  assert(/busy=\{deleting !== null && busy === busyKey\(OPS\.delete, deleting\.id\)\}/.test(source), 'delete needs its op:id busy key')
  // import and restore carry no id, so the shell keys them by the bare op id.
  assert(/busy=\{busy === OPS\.importFile\}/.test(source), 'import busy must compare against the bare op id')
  assert(/busy=\{busy === OPS\.restore\}/.test(source), 'restore busy must compare against the bare op id')
  return 'toggle/move/delete by op:id, import/restore by op'
})

// -- one check per interactive action ----------------------------------------

check('action-toggle', () => {
  const switches = tags(source, 'Switch')
  assert(switches.length === 2, 'expected a row switch and an overwrite switch, found ' + switches.length)
  assert(/checked=\{row\.enabled\}/.test(source), 'the row switch reflects the skill state')
  assert(/onChange=\{next => \{/.test(source), 'the row switch reads the next value')
  return 'per-row switch -> skill.toggle'
})

check('action-move', () => {
  assert(/setMoving\(row\)/.test(body), 'the move button must open the dialog for that row')
  assert(/firstOtherRoot\(row, roots\)/.test(body), 'a move must preselect a root the skill is not in')
  assert(/roots\.filter\(item => item\.id !== /.test(body), 'the move dialog must exclude the current root')
  assert(/disabled=\{moveTarget === ''\}/.test(source), 'move must refuse an empty target')
  return 'per-row move dialog, targets exclude the current root'
})

check('action-delete', () => {
  assert(/variant="danger"\s*label=\{pick\(lang, .*Delete/.test(source), 'the row delete action must be the danger variant with a spoken name')
  assert(/setTrashTick\(tick => tick \+ 1\)/.test(sliceBetween(source, 'const confirmDelete', 'const confirmMove')), 'a delete must re-read the trash')
  return 'danger button -> dialog -> skill.delete -> refresh'
})

check('action-restore', () => {
  assert(/void restoreItem\(item\)/.test(body), 'the restore button must call restoreItem')
  assert(/const restoreItem = async/.test(source), 'restoreItem exists')
  assert(/setTrashTick\(tick => tick \+ 1\)/.test(sliceBetween(source, 'const restoreItem', 'const confirmDelete')), 'a restore must re-read the trash')
  return 'per-item restore -> skill.restore -> refresh'
})

check('action-import', () => {
  assert(/void submitImport\(\)/.test(body), 'the import confirm button must call submitImport')
  assert(/importPath\.trim\(\) === ''/.test(body), 'import must refuse an empty path before sending')
  assert(/setImporting\(false\)/.test(body), 'a successful import must close the dialog')
  assert(/targetRoot === ''/.test(body), 'import must refuse to run without a target root')
  const field = source.indexOf('th-skill-import-path')
  assert(field !== -1 && /<Field[^>]*id="th-skill-import-path"/.test(source), 'the path input must sit in a labelled Field')
  return 'dialog with a path, a target root, an overwrite switch'
})

check('action-trash-refresh', () => {
  const label = source.indexOf('刷新回收站')
  assert(label !== -1, 'the trash section needs its refresh control')
  const window = source.slice(Math.max(0, label - 300), label)
  assert(/setTrashTick/.test(window), 'refreshing must bump trashTick in the refresh button handler')
  return 'refresh button -> setTrashTick -> re-read'
})

check('action-filters', () => {
  assert(/onChange=\{setQuery\}/.test(source) && /value=\{query\}/.test(source), 'the search box must drive query')
  assert(/onChange=\{setRoot\}/.test(source) && /value=\{root\}/.test(source), 'the root select must drive root')
  assert(/id="th-skill-root-filter"/.test(source), 'the root filter needs a stable id for its label')
  assert(/rootId !== root/.test(body), 'the root filter must actually filter')
  assert(/toLowerCase\(\)\.includes\(term\)/.test(body), 'the search must be case-insensitive')
  return 'search box + root select both filter the rows'
})

// -- accessibility, tokens, hygiene -----------------------------------------

check('accessible-labels', () => {
  for (const name of ['Switch', 'Select', 'SearchBox', 'Field']) {
    const found = tags(source, name)
    assert(found.length > 0, 'the view never uses ' + name)
    for (const tag of found) {
      assert(/\blabel=\{/.test(tag.text), 'a <' + name + '> at line ' + lineAt(source, tag.index) + ' has no label')
    }
  }
  const inputs = tags(source, 'input')
  assert(inputs.length > 0, 'the import dialog needs its path input')
  for (const input of inputs) {
    assert(/aria-label=\{/.test(input.text), 'an <input> at line ' + lineAt(source, input.index) + ' has no accessible name')
  }
  const buttons = tags(source, 'Button')
  for (const button of buttons) {
    const close = source.indexOf('</Button>', button.index)
    assert(close !== -1, 'a <Button> at line ' + lineAt(source, button.index) + ' is never closed')
    assert(source.slice(button.index, close).trim() !== '', 'a <Button> at line ' + lineAt(source, button.index) + ' has no accessible name')
    assert(/\blabel=\{|t\('|pick\(lang,|children/.test(source.slice(button.index, close)), 'a <Button> at line ' + lineAt(source, button.index) + ' renders no text')
  }
  assert(/t\('a11y\.switch'/.test(source), 'row switches must be named through a11y.switch')
  return buttons.length + ' buttons named, ' + inputs.length + ' inputs labelled'
})

check('colour-tokens-only', () => {
  const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor\s*:/.exec(body)
  assert(match === null, 'line ' + lineAt(body, match === null ? 0 : match.index) + ' uses a literal colour; use a th-* class or a token')
  return 'no hex, rgb(), hsl() or color: outside tokens'
})

check('imports', () => {
  const allowed = new Set(['react', '../api.js', '../components.js', '../types.js', '../i18n.js'])
  for (const match of source.matchAll(/from '([^']+)'/g)) {
    const spec = match[1]
    if (!spec.startsWith('.')) continue
    assert(/\.js$/.test(spec), "relative import '" + spec + "' must carry a .js suffix")
  }
  for (const match of source.matchAll(/import \{[^}]*\} from '([^']+)'/g)) {
    assert(allowed.has(match[1]), "the view imports '" + match[1] + "' which is outside its scope")
  }
  return 'react + api/components/types/i18n only, all with .js'
})

check('i18n-keys-resolve', () => {
  const i18n = read(I18N)
  const catalog = name => {
    const marker = new RegExp('const ' + name + ': Catalog = \\{')
    const found = marker.exec(i18n)
    assert(found !== null, 'i18n.ts has no ' + name + ' catalog')
    const start = found.index + found[0].length - 1
    let depth = 0
    for (let cursor = start; cursor < i18n.length; cursor += 1) {
      if (i18n[cursor] === '{') depth += 1
      else if (i18n[cursor] === '}') {
        depth -= 1
        if (depth === 0) return new Set([...i18n.slice(start + 1, cursor).matchAll(/^\s*'([^']+)'\s*:/gm)].map(hit => hit[1]))
      }
    }
    throw new Error(name + ' catalog is not closed')
  }
  const zh = catalog('zh')
  const en = catalog('en')
  const used = new Set()
  for (const match of body.matchAll(/\bt\('([^']+)'/g)) {
    used.add(match[1])
    assert(zh.has(match[1]), "t('" + match[1] + "') is not in the catalog; reuse a key or use pick(lang, zh, en)")
    assert(en.has(match[1]), "t('" + match[1] + "') is missing from the en catalog")
  }
  const skillsKeys = [...used].filter(key => key.startsWith('skills.'))
  assert(skillsKeys.length >= 5, 'the view should reuse the skills.* keys, found ' + skillsKeys.length)
  return used.size + ' keys resolve, ' + skillsKeys.length + ' of them skills.*'
})

check('bilingual-inline-labels', () => {
  assert(/function pick\(lang: Lang, zh: string, en: string\): string \{\s*return lang === 'zh' \? zh : en\s*\}/.test(source), 'inline copy must go through pick(lang, zh, en)')
  const uses = [...body.matchAll(/pick\(lang,/g)].length
  assert(uses >= 10, 'expected at least 10 inline labels, found ' + uses)
  assert(/const \{ snapshot, t, lang, busy, run \} = props/.test(source), 'lang must come from ViewProps')
  return uses + ' inline labels through pick(lang, zh, en)'
})

check('no-unsafe-html', () => {
  for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write']) {
    const at = source.indexOf(pattern)
    assert(at === -1, 'line ' + lineAt(source, at) + ' uses ' + pattern)
  }
  const todo = source.search(/TODO\(|FIXME|XXX:/)
  assert(todo === -1, 'line ' + lineAt(source, todo) + ' carries a TODO marker')
  return 'no HTML injection, no TODO markers'
})

// -- report -------------------------------------------------------------------

console.log(passed + '/' + (passed + failed) + ' checks passed')
if (failed > 0) {
  console.log('failed: ' + failedNames.join(', '))
  process.exit(1)
}
