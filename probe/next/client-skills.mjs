#!/usr/bin/env node
/**
 * probe/next/client-skills.mjs -- the skills page, checked from outside.
 *
 * Two halves. The static gates read src/client/views/skills.tsx, the new
 * src/client/views/skills-tree.tsx, the catalogs in src/client/i18n.ts, the op declarations in
 * src/domains/skills.ts and the shared helpers in src/client/views/package-tree.tsx: the view must
 * keep its export, its op table and its payloads, and the tree must reuse package-tree rather than
 * copy it. The runtime half cuts the marked tree-helpers region out of skills-tree.tsx, bundles it
 * with the project's own esbuild and executes the grouping and search rules, so they are run
 * instead of grepped; a second bundle stubs package-tree's browser imports so the REAL
 * groupByPrefix runs against real skill names, composed exactly as the view composes it.
 *
 * The tree contract is not taste: default folded (nothing stored yet), remembered under
 * 'tool-hub-tree-skills', a search opens every parent, a parent-label hit keeps every child, and
 * the parent switch only exists when children do. The host has no group op for skills, so the
 * bulk write is one skill.toggle { id, enabled } per child, in order -- a group op or a bare ids
 * payload would pass the browser and fail the host, so it fails here first.
 *
 * No third-party libraries beyond the repo's esbuild. Every line is PASS or FAIL and the process
 * exits 1 when anything fails.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = join(ROOT, 'src', 'client', 'views', 'skills.tsx')
const TREE = join(ROOT, 'src', 'client', 'views', 'skills-tree.tsx')
const SHARED = join(ROOT, 'src', 'client', 'views', 'package-tree.tsx')
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
const treeSource = read(TREE)
const treeBody = code(treeSource)
const shared = read(SHARED)
const domain = read(DOMAIN)

check('file-budget', () => {
  const lines = source.split('\n').length
  const bytes = statSync(VIEW).size
  assert(lines < 450, rel(VIEW) + ' is ' + lines + ' lines (limit 450)')
  assert(bytes < 40 * 1024, rel(VIEW) + ' is ' + bytes + ' bytes (limit 40 KB)')
  const treeLines = treeSource.split('\n').length
  const treeBytes = statSync(TREE).size
  assert(treeLines < 200, rel(TREE) + ' is ' + treeLines + ' lines (limit 200)')
  assert(treeBytes < 24 * 1024, rel(TREE) + ' is ' + treeBytes + ' bytes (limit 24 KB)')
  return 'view ' + lines + ' lines, tree ' + treeLines + ' lines'
})

check('export-skills-view', () => {
  assert(/export function SkillsView\(props: ViewProps\): React\.ReactElement \{/.test(source), 'SkillsView must keep its exported name and ViewProps signature')
  assert(/\{trashSection\}/.test(source), 'the trash section must be rendered by the view')
  assert(/snapshot\.skills\.length === 0/.test(body), 'the view must branch on an empty snapshot, not a placeholder')
  assert(/<SkillTree/.test(source), 'the filtered list must render through SkillTree')
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

check('payload-bulk-sequential', () => {
  const handler = sliceBetween(source, 'const bulkToggle = async', 'const openImport')
  assert(/group\.rows\.length === 0/.test(handler), 'an empty group must not send anything')
  assert(/setBulkKey\(group\.key\)/.test(handler), 'the parent switch must spin on the group key')
  assert(/for \(const row of group\.rows\) \{/.test(handler), 'the bulk must walk the group children in order')
  assert(/const ok = await run\(OPS\.toggle, \{ id: row\.id, enabled: next \}\)/.test(handler),
    'each child must be written through skill.toggle with { id, enabled }')
  assert(/if \(!ok\) return/.test(handler), 'a failed child must stop the run instead of writing over the error')
  assert(/finally \{\s*setBulkKey\(null\)\s*\}/.test(handler), 'the busy key must clear even when a write fails')
  assert(!/\bids\s*:/.test(handler) && !/\bitems\s*:/.test(handler), 'the host has no group op; no ids/items payload')
  return 'one skill.toggle per child, in order, stop on failure'
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

// -- the tree: reuse, not a copy --------------------------------------------

check('tree-reuses-shared', () => {
  assert(/import \{ GroupTree, useTreeExpansion \} from '\.\/package-tree\.js'/.test(treeBody),
    'skills-tree must import GroupTree and useTreeExpansion from package-tree')
  assert(/import type \{ TreeGroup \} from '\.\/package-tree\.js'/.test(treeBody),
    'skills-tree must reuse the shared TreeGroup shape')
  assert(/<GroupTree/.test(treeBody), 'skills-tree must render the shared GroupTree')
  assert(!/function prefixOf|function groupByPrefix/.test(treeBody), 'the prefix rules belong to package-tree; do not copy them')
  assert(!/\[\^A-Za-z0-9\]/.test(treeBody), 'the prefix regex belongs to package-tree; do not copy it')
  assert(!/localStorage/.test(treeBody), 'the hook owns persistence; the tree must not touch localStorage itself')
  return 'GroupTree + useTreeExpansion + TreeGroup from package-tree'
})

check('tree-storage-key', () => {
  assert(/export const SKILLS_TREE_STORAGE = 'tool-hub-tree-skills'/.test(treeBody),
    "the fold state must live under 'tool-hub-tree-skills'")
  assert(/useTreeExpansion\(SKILLS_TREE_STORAGE\)/.test(treeBody), 'the component must pass that key to useTreeExpansion')
  assert(/raw === null \? \[\]/.test(shared), 'a first visit must expand nothing: package-tree starts from an empty set')
  assert(/localStorage\.setItem\(storageKey, JSON\.stringify\(\[\.\.\.next\]\)\)/.test(shared),
    'package-tree must persist the expanded keys, so the folds are remembered')
  assert(/const open = forceOpen \|\| expansion\.isOpen\(group\.key\)/.test(shared),
    'package-tree must stay folded unless the key is stored or a search forces it open')
  return 'empty on first visit, remembered after, open only when stored or forced'
})

check('tree-search-forces-open', () => {
  assert(/forceOpen=\{term !== ''\}/.test(body), 'any non-empty search must force every parent open')
  assert(/forceOpen=\{forceOpen\}/.test(treeBody), 'the tree must hand forceOpen to GroupTree')
  assert(/term = query\.trim\(\)\.toLowerCase\(\)/.test(body), 'the term comes from the search box, trimmed and folded')
  return 'forceOpen while searching, remembered folds after'
})

check('tree-grouping', () => {
  assert(/groupByPrefix\(scoped, row => row\.name, t\('tree\.ungrouped'\)\)/.test(body),
    "the view must group by name through groupByPrefix, with t('tree.ungrouped') as the fallback label")
  assert(/skillTree\(groupByPrefix\(/.test(body), 'the prefix groups must go through skillTree, which applies the search rules')
  assert(/row => row\.name \+ ' ' \+ row\.id/.test(body), 'a child match must search the name and the id')
  assert(/root === 'all' \|\| row\.rootId === root/.test(body), 'the root filter must still filter before grouping')
  return 'groupByPrefix(name) -> skillTree(term)'
})

check('tree-parent-facts', () => {
  assert(/switchable: rows\.length > 0/.test(treeBody), 'the parent switch must exist only when the group has children')
  assert(/allEnabled: enabled === rows\.length/.test(treeBody), 'the parent switch must read on only when every child is on')
  assert(/const enabled = rows\.reduce\(\(count, row\) => count \+ \(row\.enabled \? 1 : 0\), 0\)/.test(treeBody),
    'the parent must count its enabled children')
  assert(/if \(rows\.length === 0\) continue/.test(treeBody), 'a group without surviving rows must not render an empty parent')
  assert(/group\.rows\.length/.test(body), 'the toolbar count must follow the rows the tree actually shows')
  assert(/onBulk === undefined \|\| group\.switchable !== true \? null : \(/.test(shared),
    'package-tree must render the switch only for a switchable group')
  assert(/busy=\{busyKey === group\.key\}/.test(shared), 'the parent switch must spin on its own group key')
  return 'switchable with children, allEnabled when all on, empty groups dropped'
})

check('tree-parent-label-keeps-children', () => {
  assert(/const labelHit = needle !== '' && \(group\.label\.toLowerCase\(\)\.includes\(needle\) \|\| group\.key\.toLowerCase\(\)\.includes\(needle\)\)/.test(treeBody),
    'a parent must match on its label and on its key')
  assert(/const rows = needle === '' \|\| labelHit \? group\.rows : group\.rows\.filter\(row => haystack\(row\)\.toLowerCase\(\)\.includes\(needle\)\)/.test(treeBody),
    'a parent-label hit must keep every child; only a child hit filters')
  return 'label hit keeps all children, child hit filters'
})

check('tree-wiring', () => {
  const tagsTree = tags(source, 'SkillTree')
  assert(tagsTree.length === 1, 'expected one SkillTree element, found ' + tagsTree.length)
  for (const prop of ['groups={groups}', 'lang={lang}', 'forceOpen={term !== \'\'}', 'busyKey={bulkKey}', 'onBulk=', 'renderRow={row => {']) {
    assert(tagsTree[0].text.includes(prop) || source.slice(tagsTree[0].index, source.indexOf('/>', tagsTree[0].index)).includes(prop),
      'SkillTree is missing ' + prop)
  }
  assert(/onBulk=\{\(group, next\) => \{ void bulkToggle\(group, next\) \}\}/.test(source), 'the parent switch must call bulkToggle')
  return 'groups, lang, forceOpen, busyKey, onBulk, renderRow'
})

// -- states and dialogs ------------------------------------------------------

check('empty-states', () => {
  assert(/<Empty/.test(source), 'the view must use the shared Empty')
  assert(/t\('skills\.empty'\)/.test(source), 'no skills at all must render skills.empty')
  assert(/t\('skills\.emptyFiltered', \{ query \}\)/.test(source), 'a filter with no hit must render skills.emptyFiltered')
  assert(/groups\.length === 0/.test(body), 'the filtered-empty state must follow the tree groups, not the raw rows')
  assert(/回收站是空的/.test(source), 'an empty trash must say so')
  assert(/action=\{roots\.length === 0 \? undefined :/.test(body), 'the empty state may offer an import only when a root exists')
  return 'skills.empty, skills.emptyFiltered, empty trash'
})

check('trash-read', () => {
  assert(/runOp\(OPS\.trash, \{\}\)/.test(body), 'the trash list must be read through skill.trash')
  assert(/trashRows\(result\.data\)/.test(body), 'the answer must go through the local parser')
  assert(/item\.trashPath/.test(source) && /item\.rel/.test(source) && /item\.at/.test(source), 'the parser must keep trashPath, rel and at')
  assert(/React\.useEffect\(\(\) => \{[\s\S]*?\}, \[trashTick\]\)/.test(body), 'the trash effect must depend on trashTick')
  assert(/setTrashTick\(tick => tick \+ 1\)/.test(body), 'a write must bump trashTick so the trash is re-read')
  return 'skill.trash -> trashRows -> local state, re-read after every write'
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
  assert(/busy=\{busy === busyKey\(OPS\.toggle, row\.id\)\}/.test(source), 'the row switch needs its op:id busy key')
  assert(/busy=\{moving !== null && busy === busyKey\(OPS\.move, moving\.id\)\}/.test(source), 'move needs its op:id busy key')
  assert(/busy=\{deleting !== null && busy === busyKey\(OPS\.delete, deleting\.id\)\}/.test(source), 'delete needs its op:id busy key')
  // import and restore carry no id, so the shell keys them by the bare op id.
  assert(/busy=\{busy === OPS\.importFile\}/.test(source), 'import busy must compare against the bare op id')
  assert(/busy=\{busy === OPS\.restore\}/.test(source), 'restore busy must compare against the bare op id')
  assert(/busyKey=\{bulkKey\}/.test(source), 'the parent switch busy key must come from the bulk state')
  return 'toggle/move/delete by op:id, import/restore by op, bulk by group key'
})

// -- one check per interactive action ---------------------------------------

check('action-toggle', () => {
  const switches = tags(source, 'Switch')
  assert(switches.length === 2, 'expected a row switch and an overwrite switch, found ' + switches.length)
  assert(/checked=\{row\.enabled\}/.test(source), 'the row switch reflects the skill state')
  assert(/onChange=\{next => \{/.test(source), 'the row switch reads the next value')
  return 'per-row switch -> skill.toggle, parent switch -> bulkToggle'
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
  assert(/root === 'all' \|\| row\.rootId === root/.test(body), 'the root filter must actually filter')
  assert(/row => row\.name \+ ' ' \+ row\.id/.test(body), 'the search must cover the name and the id')
  assert(/haystack\(row\)\.toLowerCase\(\)\.includes\(needle\)/.test(treeBody), 'the child match must be case-insensitive')
  return 'search box + root select filter the rows; the term is applied by the tree'
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
  for (const [name, text] of [['skills.tsx', body], ['skills-tree.tsx', treeBody]]) {
    const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor\s*:/.exec(text)
    assert(match === null, name + ' line ' + lineAt(text, match === null ? 0 : match.index) + ' uses a literal colour; use a th-* class or a token')
  }
  return 'no hex, rgb(), hsl() or color: in either file'
})

check('imports', () => {
  const allowed = new Set(['react', '../api.js', '../components.js', '../types.js', '../i18n.js', './package-tree.js', './skills-tree.js'])
  for (const match of source.matchAll(/from '([^']+)'/g)) {
    const spec = match[1]
    if (!spec.startsWith('.')) continue
    assert(/\.js$/.test(spec), "relative import '" + spec + "' must carry a .js suffix")
  }
  for (const match of source.matchAll(/import \{[^}]*\} from '([^']+)'/g)) {
    assert(allowed.has(match[1]), "the view imports '" + match[1] + "' which is outside its scope")
  }
  const treeAllowed = new Set(['react', '../i18n.js', './package-tree.js'])
  for (const match of treeSource.matchAll(/import (?:type )?\{[^}]*\} from '([^']+)'/g)) {
    assert(treeAllowed.has(match[1]), "skills-tree.tsx imports '" + match[1] + "' which is outside its scope")
  }
  assert(/from '\.\.\/api\.js'/.test(body), 'the view sends ops through the api module')
  return 'view: components/types/api/package-tree/skills-tree; tree: react/i18n/package-tree'
})

check('single-write-path', () => {
  assert(!/\brun\(/.test(treeBody) && !/\brunOp\(/.test(treeBody), 'skills-tree must not send ops; the view owns every write')
  assert(!/fetch\(|getSnapshot|innerHTML/.test(treeBody), 'skills-tree must not read or write the host directly')
  const calls = body.match(/\brun\(/g) ?? []
  const ops = new Set([...body.matchAll(/\brun\(OPS\.([A-Za-z0-9_]+)/g)].map(match => match[1]))
  assert(calls.length === (body.match(/\brun\(OPS\./g) ?? []).length, 'an op escapes the op table')
  const keys = new Set([...sliceBetween(source, 'const OPS = {', '} as const').matchAll(/([A-Za-z0-9_]+): 'skill\./g)].map(match => match[1]))
  for (const op of ops) assert(keys.has(op), 'run(OPS.' + op + ') names no row in the op table')
  return calls.length + ' run() calls, all through OPS: ' + [...ops].join(', ')
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
  for (const match of (body + '\n' + treeBody).matchAll(/\bt\('([^']+)'/g)) {
    used.add(match[1])
    assert(zh.has(match[1]), "t('" + match[1] + "') is not in the catalog; reuse a key or use pick(lang, zh, en)")
    assert(en.has(match[1]), "t('" + match[1] + "') is missing from the en catalog")
  }
  const skillsKeys = [...used].filter(key => key.startsWith('skills.'))
  assert(skillsKeys.length >= 5, 'the view should reuse the skills.* keys, found ' + skillsKeys.length)
  for (const key of ['tree.ungrouped', 'tree.bulk', 'tree.expand', 'tree.collapse']) {
    assert(zh.has(key) && en.has(key), 'the tree labels must resolve in both catalogs: ' + key)
  }
  assert(used.has('tree.ungrouped'), 'the ungrouped fallback label must come from the catalog')
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
  for (const [name, text] of [['skills.tsx', source], ['skills-tree.tsx', treeSource]]) {
    for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write']) {
      const at = text.indexOf(pattern)
      assert(at === -1, name + ' line ' + lineAt(text, at) + ' uses ' + pattern)
    }
    const todo = text.search(/TODO\(|FIXME|XXX:/)
    assert(todo === -1, name + ' line ' + lineAt(text, todo) + ' carries a TODO marker')
  }
  return 'no HTML injection, no TODO markers in either file'
})

// -- runtime: the grouping rules, bundled and executed ----------------------

const ROW_START = '// #region tree-helpers'
const ROW_END = '// #endregion tree-helpers'
const helpersStart = treeSource.indexOf(ROW_START)
const helpersEnd = treeSource.indexOf(ROW_END)
const helpersSource = helpersStart === -1 || helpersEnd === -1 ? '' : treeSource.slice(helpersStart + ROW_START.length, helpersEnd)
const helpers = code(helpersSource)

let api = null
try {
  assert(helpers !== '', 'the tree-helpers region is missing from skills-tree.tsx')
  assert(!/\bimport\b/.test(helpers), 'the helper region must stay import-free so it can be executed in isolation')
  assert(!/React\./.test(helpers), 'the helper region must not touch React')
  const bundled = await build({
    stdin: { contents: helpers, loader: 'ts', resolveDir: ROOT, sourcefile: 'skills-tree-helpers.ts' },
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

/** Rows in the shape SkillRow offers the grouping rules. */
const rowsOf = spec => spec.map(pair => ({ name: pair[0], enabled: pair[1] }))
const groupOf = (key, label, spec) => ({ key, label, rows: rowsOf(spec) })

check('runtime-no-term', () => {
  const mod = need()
  const groups = [
    groupOf('office', 'office', [['office-docx', true], ['office-xlsx', false]]),
    groupOf('~', '未分组', [['browser-skill', true]]),
  ]
  const out = mod.skillTree(groups, '', row => row.name + ' ' + (row.id === undefined ? '' : row.id))
  assert(out.length === 2, 'both groups must survive an empty term, got ' + out.length)
  assert(out.map(group => group.key).join(',') === 'office,~', 'the prefix order must be kept, got ' + out.map(group => group.key).join(','))
  assert(out[0].label === 'office' && out[1].label === '未分组', 'labels must pass through, including the fallback')
  assert(out[0].rows.length === 2 && out[1].rows.length === 1, 'an empty term must keep every child')
  assert(out[0].rows === groups[0].rows, 'an unfiltered group must pass its own rows through, not copy them')
  assert(out[0].enabled === 1 && out[1].enabled === 1, 'the parent must count its enabled children')
  assert(out[0].allEnabled === false && out[1].allEnabled === true, 'allEnabled must be true only when every child is on')
  assert(out[0].switchable === true && out[1].switchable === true, 'a group with children is switchable')
  assert(out[0] !== groups[0], 'each rendered group must be a fresh object so React re-renders')
  return '2 groups, 3 rows, enabled 1/2 and 1/1'
})

check('runtime-child-search', () => {
  const mod = need()
  const groups = [
    groupOf('office', 'office', [['office-docx', true], ['office-xlsx', false]]),
    groupOf('~', '未分组', [['browser-skill', true]]),
  ]
  const out = mod.skillTree(groups, 'xlsx', row => row.name)
  assert(out.length === 1, 'a child hit must drop the groups with no hit, got ' + out.length)
  assert(out[0].key === 'office', 'the surviving group must be the one holding the hit')
  assert(out[0].rows.length === 1 && out[0].rows[0].name === 'office-xlsx', 'only the matching child must survive')
  assert(out[0].enabled === 0 && out[0].allEnabled === false, 'the count follows the surviving rows')
  const upper = mod.skillTree(groups, 'XLSX', row => row.name)
  assert(upper.length === 1 && upper[0].rows.length === 1, 'the child search must be case-insensitive')
  const none = mod.skillTree(groups, 'zzz', row => row.name)
  assert(none.length === 0, 'a term with no hit must render no group at all')
  return 'child hit filters, case-insensitive, no hit renders nothing'
})

check('runtime-parent-label-keeps-all', () => {
  const mod = need()
  const groups = [
    groupOf('office', 'office', [['office-docx', true], ['office-xlsx', false]]),
    groupOf('~', '未分组', [['browser-skill', true]]),
  ]
  const byLabel = mod.skillTree(groups, 'offi', row => row.name)
  assert(byLabel.length === 1 && byLabel[0].rows.length === 2, 'a parent-label hit must keep EVERY child, got ' + byLabel[0].rows.length)
  assert(byLabel[0].enabled === 1, 'the kept children keep their states')
  const byKey = mod.skillTree(groups, 'office', row => row.name)
  assert(byKey.length === 1 && byKey[0].rows.length === 2, 'a parent-key hit must keep every child too')
  const byFallback = mod.skillTree(groups, '未分组', row => row.name)
  assert(byFallback.length === 1 && byFallback[0].rows[0].name === 'browser-skill',
    'the fallback label must keep its children even though no child spells it')
  const spaced = mod.skillTree(groups, '  OFFICE  ', row => row.name)
  assert(spaced.length === 1 && spaced[0].rows.length === 2, 'the term must be trimmed and folded before matching')
  return 'label, key and fallback label all keep their children'
})

check('runtime-identity-and-purity', () => {
  const mod = need()
  const groups = [
    groupOf('office', 'office', [['office-docx', true], ['office-xlsx', false]]),
    groupOf('dsh', 'dsh', [['dsh-memory', true]]),
    groupOf('', '', []),
  ]
  const before = JSON.stringify(groups)
  const out = mod.skillTree(groups, '', row => row.name)
  assert(JSON.stringify(groups) === before, 'the input groups must not be mutated')
  assert(out.length === 2, 'an empty group must be dropped even with no term, got ' + out.length)
  assert(out[2] === undefined, 'no empty parent may be rendered')
  const cleared = mod.skillTree(groups, '', row => row.name)
  assert(cleared.length === out.length && cleared[0].rows === out[0].rows, 'the same input must produce the same rows')
  return 'no mutation, empty groups dropped, stable rows'
})

check('runtime-enabled-arithmetic', () => {
  const mod = need()
  const all = mod.skillTree([groupOf('univer', 'univer', [['univer-doc', true], ['univer-sheet', true]])], '', row => row.name)
  assert(all[0].enabled === 2 && all[0].allEnabled === true, 'all children on must read as on')
  const none = mod.skillTree([groupOf('univer', 'univer', [['univer-doc', false], ['univer-sheet', false]])], '', row => row.name)
  assert(none[0].enabled === 0 && none[0].allEnabled === false, 'no child on must read as off')
  const one = mod.skillTree([groupOf('univer', 'univer', [['univer-doc', true]])], '', row => row.name)
  assert(one[0].enabled === 1 && one[0].allEnabled === true, 'a single enabled child must read as on')
  return 'all on / all off / single child'
})

// -- runtime: the shared prefix helper, executed with the view's rules ---------

/**
 * package-tree is a React module, but groupByPrefix and prefixOf are plain functions. Stub the
 * three imports it pulls in at the top (react, components.js, i18n.js) so the REAL prefix helper
 * runs here: a copy of it in this probe would prove nothing about what the view actually calls.
 */
const treeStubs = {
  name: 'package-tree-stubs',
  setup(context) {
    context.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'tree-stub' }))
    context.onResolve({ filter: /components\.js$/ }, () => ({ path: 'components', namespace: 'tree-stub' }))
    context.onResolve({ filter: /i18n\.js$/ }, () => ({ path: 'i18n', namespace: 'tree-stub' }))
    context.onLoad({ filter: /.*/, namespace: 'tree-stub' }, args => {
      if (args.path === 'react') return { contents: 'export const useState = seed => [typeof seed === "function" ? seed() : seed, () => {}]\nexport const createElement = () => null\nexport const Fragment = "fragment"\nexport default { useState, createElement, Fragment }', loader: 'js' }
      if (args.path === 'components') return { contents: 'export const Badge = () => null\nexport const Switch = () => null', loader: 'js' }
      return { contents: 'export const createT = () => key => key', loader: 'js' }
    })
  },
}

let sharedApi = null
try {
  const bundled = await build({
    stdin: {
      contents: "export { groupByPrefix, prefixOf } from './src/client/views/package-tree.tsx'\n",
      loader: 'ts',
      resolveDir: ROOT,
      sourcefile: 'package-tree-entry.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [treeStubs],
  })
  const text = bundled.outputFiles?.[0]?.text ?? ''
  assert(text !== '', 'esbuild produced no bundle for package-tree')
  sharedApi = await import('data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64'))
} catch (error) {
  failed += 1
  failedNames.push('shared-bundle')
  console.log('FAIL shared-bundle -- ' + (error instanceof Error ? error.message : String(error)))
}

check('runtime-prefix-rules', () => {
  assert(sharedApi !== null, 'package-tree did not compile')
  assert(sharedApi.prefixOf('univer-sheet') === 'univer', 'the first token is the prefix')
  assert(sharedApi.prefixOf('office_docx') === 'office', 'an underscore separates too')
  assert(sharedApi.prefixOf('no-separator') === 'no', 'a hyphen separates too')
  assert(sharedApi.prefixOf('Agent') === '~', 'a name without a separator falls back to ~')
  return 'the prefix rules come from package-tree, not a copy'
})

check('runtime-composed-with-shared', () => {
  assert(sharedApi !== null && api !== null, 'the pipelines did not compile')
  const names = ['dsh-comfyui-workflows', 'dsh-memory', 'univer-sheet', 'univer-doc', 'browser-skill', 'lunheng_commands', 'Agent']
  const rows = names.map((name, index) => ({ name, enabled: index % 2 === 0 }))
  const groups = sharedApi.groupByPrefix(rows, row => row.name, '未分组')
  assert(groups.map(group => group.key).join(',') === 'browser,dsh,lunheng,univer,~',
    'the real groupByPrefix must order the prefixes and keep the fallback last, got ' + groups.map(group => group.key).join(','))
  assert(groups[groups.length - 1].label === '未分组', 'the fallback label must come from the caller')
  const all = api.skillTree(groups, '', row => row.name)
  assert(all.length === 5, 'every prefix must render a parent, got ' + all.length)
  assert(all[1].key === 'dsh' && all[1].rows.length === 2, 'dsh must hold its two skills')
  const byFallback = api.skillTree(groups, '未分组', row => row.name)
  assert(byFallback.length === 1 && byFallback[0].rows[0].name === 'Agent', 'the ungrouped label keeps its child')
  const byChild = api.skillTree(groups, 'sheet', row => row.name)
  assert(byChild.length === 1 && byChild[0].key === 'univer' && byChild[0].rows.length === 1, 'a child hit keeps exactly one row')
  return 'groupByPrefix -> skillTree on 7 real names: 5 parents, fallback kept'
})

// -- report -------------------------------------------------------------------

const total = passed + failed
console.log(passed + '/' + total + ' checks passed')
if (failed > 0) {
  console.log('failed: ' + failedNames.join(', '))
  process.exit(1)
}
