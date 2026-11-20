#!/usr/bin/env node
/**
 * probe/next/client-settings.mjs — the settings page (task-6), checked from outside.
 *
 * Two halves, both dependency-light: static gates read the sources (and the built bundle when
 * one exists) for the properties the page must keep, then a set of pure-function tests exercise
 * the model the page is built on. The model imports nothing at runtime, so it is bundled with
 * the project's own esbuild into a temp file and imported — the tests run against the same
 * source the bundle ships, not a copy.
 *
 * Coverage:
 *   1. files present, no HTML string injection, no TODO, imports carry .js;
 *   2. colour is tokens only (a literal may live in a var() fallback, nowhere else);
 *   3. the four field types dispatch to four controls, with labels and descriptions;
 *   4. i18n: zh/en carry the same keys and every literal t() call resolves;
 *   5. the shell wires one nav entry and one render branch, no more;
 *   6. one loader entry in dist/client.js once it is built;
 *   7. pure tests: grouping (first segment, module prefix, bare key), type dispatch, default
 *      fallback and clamping, dirty comparison, save payload, restore defaults, empty schema.
 *
 * No third-party libraries. Every line is PASS or FAIL; exit 1 when any check fails.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = join(ROOT, 'src', 'client')
const SETTINGS = join(CLIENT, 'settings')

let passed = 0
let failed = 0
const failedNames = []

function check(name, run) {
  try {
    const detail = run()
    passed += 1
    console.log('PASS ' + name + (detail === undefined || detail === '' ? '' : ' (' + detail + ')'))
  } catch (error) {
    failed += 1
    failedNames.push(name)
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
const read = file => readFileSync(file, 'utf8')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out.sort()
}

const sources = new Map(walk(SETTINGS).map(file => [rel(file), read(file)]))
const fileName = name => {
  const hit = [...sources.entries()].find(([path]) => path.endsWith('/' + name))
  assert(hit !== undefined, 'src/client/settings/' + name + ' is missing')
  return hit[1]
}
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')
const lineAt = (text, index) => text.slice(0, index).split('\n').length

function i18nCatalogs() {
  const source = read(join(CLIENT, 'i18n.ts'))
  const catalog = name => {
    const found = new RegExp('const ' + name + ': Catalog = \\{').exec(source)
    assert(found !== null, 'i18n.ts has no ' + name + ' catalog')
    const start = found.index + found[0].length - 1
    let depth = 0
    for (let cursor = start; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1
      else if (source[cursor] === '}') {
        depth -= 1
        if (depth === 0) return new Set([...source.slice(start + 1, cursor).matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1]))
      }
    }
    throw new Error(name + ' catalog is not closed')
  }
  return { zh: catalog('zh'), en: catalog('en') }
}

// ── static gates ─────────────────────────────────────────────────────────────

check('files-present', () => {
  const wanted = ['model.ts', 'fields.tsx', 'view.tsx', 'index.ts', 'ops.ts']
  for (const name of wanted) fileName(name)
  return wanted.length + ' files under src/client/settings'
})

check('no-html-injection', () => {
  for (const [path, source] of sources) {
    for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment']) {
      const at = source.indexOf(pattern)
      assert(at === -1, path + ':' + lineAt(source, at) + ' uses ' + pattern)
    }
  }
  return 'no HTML string injection'
})

check('no-todo', () => {
  for (const [path, source] of sources) {
    const at = source.search(/TODO\(|FIXME|XXX:/)
    assert(at === -1, path + ':' + lineAt(source, at) + ' still carries a TODO marker')
  }
  return 'no TODO/FIXME markers'
})

check('color-tokens-only', () => {
  const strip = text => {
    let out = ''
    let index = 0
    while (index < text.length) {
      const start = text.indexOf('var(--dsw-alias-', index)
      if (start === -1) {
        out += text.slice(index)
        break
      }
      out += text.slice(index, start)
      let depth = 0
      let cursor = start
      for (; cursor < text.length; cursor += 1) {
        const char = text[cursor]
        if (char === '(') depth += 1
        else if (char === ')') {
          depth -= 1
          if (depth === 0) {
            cursor += 1
            break
          }
        }
      }
      index = cursor
    }
    return out
  }
  for (const [path, source] of sources) {
    const rest = strip(source)
    const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(rest)
    assert(match === null, path + ':' + lineAt(rest, match === null ? 0 : match.index) + ' uses a literal colour outside a token fallback')
  }
  const theme = read(join(CLIENT, 'theme.ts'))
  assert(/--dsw-alias-/.test(theme), 'theme.ts must define the alias tokens')
  return 'colours come from theme.ts tokens only'
})

check('token-usage', () => {
  const joined = [...sources.values()].join('\n')
  assert(/from '\.\.\/theme\.js'/.test(joined), 'the page must take its spacing/colour from theme.js')
  assert(/\bT\.[a-zA-Z]/.test(joined), 'the page must read colour from the T tokens')
  return 'theme.js imported, T.* used'
})

check('import-suffix', () => {
  for (const [path, source] of sources) {
    for (const match of source.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      const spec = match[1]
      assert(/\.(js|json)$/.test(spec), path + ':' + lineAt(source, match.index) + " imports '" + spec + "' without a .js suffix")
    }
  }
  return 'relative imports carry .js'
})

check('type-dispatch', () => {
  const fields = code(fileName('fields.tsx'))
  for (const marker of ["kind === 'boolean'", "kind === 'select'", "kind === 'number'"]) {
    assert(fields.includes(marker), 'fields.tsx does not branch on ' + marker)
  }
  assert(/className="th-input"[\s\S]{0,400}type="text"/.test(fields), 'fields.tsx has no text input branch')
  const model = code(fileName('model.ts'))
  assert(/export function fieldKind/.test(model), 'model.ts must export fieldKind')
  assert(/KINDS.includes/.test(model), 'fieldKind must fall back for an unknown type')
  return 'boolean / number / select / text branches'
})

check('accessibility', () => {
  const fields = fileName('fields.tsx')
  const view = fileName('view.tsx')
  assert(/aria-label=/.test(fields), 'every control needs an accessible name')
  assert(/aria-describedby=/.test(fields), 'a field must point at its hint')
  assert(/htmlFor=/.test(fields), 'text, number and select controls must have a <label for>')
  assert(/aria-label=\{t\('settings\.a11y\.group'/.test(view), 'each section must carry an accessible name')
  assert(/role="alert"/.test(read(join(CLIENT, 'components.tsx'))), 'the shared error banner must be role="alert"')
  const actions = /<Button[\s\S]{0,200}onClick=\{save\}/.test(view)
  assert(actions, 'saving must be a real button, so Enter/Space work')
  return 'label/for, aria-label, aria-describedby, buttons'
})

check('dirty-and-busy', () => {
  const view = code(fileName('view.tsx'))
  assert(/dirtyOf\(/.test(view), 'the view must compare the draft against the snapshot')
  assert(/savePayloadOf\(/.test(view), 'the view must send only what changed')
  assert(/restoreDefaultsOf\(/.test(view), 'the view must offer restore defaults')
  assert(/busy === SAVE_OP/.test(view), 'the save button must show the op in flight')
  assert(/error === null \? null :/.test(view), 'a failed save must render an error banner')
  assert(/beforeunload/.test(view), 'unsaved changes must warn before leaving')
  assert(/settings\.dirty/.test(view), 'the toolbar must count unsaved fields')
  assert(/run\(SAVE_OP, \{ values \}\)/.test(view), 'the page must write through run(SAVE_OP, { values })')
  assert(!/from '\.\.\/api\.js'/.test(fileName('view.tsx')), 'the view must not fetch: the shell owns run/reload')
  return 'dirty, save payload, restore, busy, banner, beforeunload'
})

check('empty-state', () => {
  const view = code(fileName('view.tsx'))
  assert(/if \(fields\.length === 0\)/.test(view), 'an empty schema must take its own branch')
  assert(/settings\.emptyTitle/.test(view), 'the empty state needs a title')
  assert(/props\.reload\(\)/.test(view), 'the empty state must offer a retry')
  const model = code(fileName('model.ts'))
  assert(/export function groupFields/.test(model), 'groupFields must be exported for the probe')
  return 'empty schema renders a retryable empty state'
})

check('shell-wiring', () => {
  const shell = read(join(CLIENT, 'shell.tsx'))
  const union = /export type ViewId = ([^\n]+)/.exec(shell)
  assert(union !== null && /'settings'/.test(union[1]), "ViewId must gain 'settings'")
  assert(/\{ id: 'settings', label: 'nav\.settings' \}/.test(shell), 'the sidebar needs one settings entry')
  assert(/import \{ SettingsView \} from '\.\/settings\/index\.js'/.test(shell), 'the shell must import SettingsView from settings/index.js')
  assert(/settings: <SettingsView /.test(shell), 'the shell must render the settings view')
  const entries = [...shell.matchAll(/id: 'settings'/g)].length
  assert(entries === 1, 'exactly one nav entry may carry id settings, found ' + entries)
  const branches = [...shell.matchAll(/<SettingsView /g)].length
  assert(branches === 1, 'exactly one render branch may mount SettingsView, found ' + branches)
  return 'one nav entry, one render branch'
})

check('i18n-aligned', () => {
  const { zh, en } = i18nCatalogs()
  for (const key of zh) assert(en.has(key), 'en is missing "' + key + '"')
  for (const key of en) assert(zh.has(key), 'zh is missing "' + key + '"')
  const used = new Set()
  for (const [path, source] of sources) {
    for (const match of code(source).matchAll(/\bt\('([^']+)'/g)) {
      const key = match[1]
      used.add(key)
      assert(zh.has(key), path + ':' + lineAt(source, match.index) + " calls t('" + key + "') which no catalog defines")
    }
  }
  for (const key of ['settings.title', 'settings.save', 'settings.reset', 'settings.dirty', 'settings.emptyTitle']) {
    assert(used.has(key), 'the page never calls t(' + key + ')')
  }
  assert(zh.has('nav.settings') && en.has('nav.settings'), 'both catalogs need nav.settings for the sidebar entry')
  for (const group of ['appearance', 'general', 'tools', 'scenes', 'diagnostics', 'advanced', 'other']) {
    assert(zh.has('settings.group.' + group), 'zh is missing settings.group.' + group)
    assert(en.has('settings.group.' + group), 'en is missing settings.group.' + group)
  }
  return zh.size + ' keys, zh/en identical, ' + used.size + ' keys used by the page'
})

check('bundle-single-loader', () => {
  const bundle = join(ROOT, 'dist', 'client.js')
  if (!existsSync(bundle)) {
    skip('bundle-single-loader', 'dist/client.js not built yet; run npm run build:client')
    return ''
  }
  const text = read(bundle)
  const loads = (text.match(/__ModuleLoader__\.load\(/g) ?? []).length
  assert(loads === 1, 'dist/client.js registers ' + loads + ' loader entries, expected 1')
  for (const pattern of ['innerHTML', 'dangerouslySetInnerHTML']) {
    assert(text.indexOf(pattern) === -1, 'dist/client.js contains ' + pattern)
  }
  for (const marker of ['settings.set', 'settings.emptyTitle']) {
    assert(text.indexOf(marker) !== -1, 'dist/client.js carries no ' + marker + '; the settings page is not in the bundle')
  }
  return 'dist/client.js ' + text.length + ' bytes, one loader entry, settings page included'
})

check('file-size', () => {
  let biggest = { path: '', lines: 0 }
  for (const [path, source] of sources) {
    const lines = source.split('\n').length
    assert(lines < 3000, path + ' has ' + lines + ' lines (limit 3000)')
    assert(statSync(join(ROOT, path)).size < 150 * 1024, path + ' is over 150 KB')
    if (lines > biggest.lines) biggest = { path, lines }
  }
  return 'largest ' + biggest.path + ' at ' + biggest.lines + ' lines'
})

// ── pure model tests ────────────────────────────────────────────────────────

let model = null
try {
  // In memory, imported through a data: URL: the probe writes nothing to disk, so it runs under
  // a sandbox that refuses writes outside the project just as well as on a normal host.
  const bundled = await build({
    entryPoints: [join(SETTINGS, 'model.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })
  const text = bundled.outputFiles?.[0]?.text ?? ''
  assert(text !== '', 'esbuild produced no model bundle')
  model = await import('data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64'))
} catch (error) {
  failed += 1
  failedNames.push('model-bundle')
  console.log('FAIL model-bundle -- ' + (error instanceof Error ? error.message : String(error)))
}

const field = (key, type, fallback, extra = {}) => ({ key, type, default: fallback, label: { zh: key, en: key }, ...extra })

function modelCheck(name, run) {
  if (model === null) {
    failed += 1
    failedNames.push(name)
    console.log('FAIL ' + name + ' -- the model did not bundle')
    return
  }
  check(name, () => run(model))
}

function equal(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

modelCheck('test-group-first-segment', m => {
  const groups = m.groupFields([field('appearance.theme', 'select', 'system'), field('appearance.density', 'select', 'comfortable'), field('general.language', 'select', 'auto')])
  assert(equal(groups.map(group => group.id), ['appearance', 'general']), 'groups were ' + groups.map(group => group.id).join(','))
  assert(equal(groups.map(group => group.fields.length), [2, 1]), 'group sizes were ' + groups.map(group => group.fields.length).join(','))
  return 'appearance(2) then general(1), schema order kept'
})

modelCheck('test-group-module-prefix', m => {
  const fields = [field('settings.appearance.theme', 'select', 'system'), field('settings.general.language', 'select', 'auto'), field('settings.advanced.backupKeep', 'number', 20)]
  assert(m.modulePrefixOf(fields) === 'settings', 'prefix was "' + m.modulePrefixOf(fields) + '"')
  const groups = m.groupFields(fields)
  assert(equal(groups.map(group => group.id), ['appearance', 'general', 'advanced']), 'groups were ' + groups.map(group => group.id).join(','))
  assert(m.modulePrefixOf([field('appearance.theme', 'select', 'system')]) === '', 'a two-part key must not be stripped')
  return 'settings.* collapses to three sections'
})

modelCheck('test-group-bare-key', m => {
  assert(m.groupIdOf('appearance.theme') === 'appearance', 'first segment should name the group')
  assert(m.groupIdOf('theme') === 'other', 'a bare key belongs to other')
  assert(m.groupIdOf('settings.appearance.theme', 'settings') === 'appearance', 'the module prefix must be stripped')
  assert(m.groupTitleOf('notdeclared', key => key) === 'Notdeclared', 'an unknown section falls back to its id')
  return 'first segment, bare key, unknown title'
})

modelCheck('test-type-dispatch', m => {
  assert(m.fieldKind(field('a.b', 'boolean', false)) === 'boolean', 'boolean')
  assert(m.fieldKind(field('a.b', 'number', 0)) === 'number', 'number')
  assert(m.fieldKind(field('a.b', 'string', '')) === 'string', 'string')
  assert(m.fieldKind(field('a.b', 'select', 'x', { options: [{ value: 'x', label: { zh: 'x', en: 'x' } }] })) === 'select', 'select')
  assert(m.fieldKind(field('a.b', 'richtext', '')) === 'string', 'an unknown type renders and coerces as a string')
  return 'four kinds, unknown falls back to string'
})

modelCheck('test-default-fallback', m => {
  const toggle = field('tools.lazyDefault', 'boolean', false)
  assert(m.valueOf(toggle, {}) === false, 'a missing value shows the default')
  assert(m.valueOf(toggle, { 'tools.lazyDefault': 'yes' }) === false, 'a wrong type shows the default')
  const size = field('advanced.backupKeep', 'number', 20, { min: 1, max: 200 })
  assert(m.valueOf(size, {}) === 20, 'the declared default is used')
  assert(m.valueOf(size, { 'advanced.backupKeep': 0 }) === 1, 'a value under min clamps up')
  assert(m.valueOf(size, { 'advanced.backupKeep': 900 }) === 200, 'a value over max clamps down')
  assert(m.valueOf(size, { 'advanced.backupKeep': 'abc' }) === 20, 'an unparsable number shows the default')
  assert(m.valueOf(size, { 'advanced.backupKeep': '42' }) === 42, 'a numeric string is read as its number')
  const mode = field('appearance.theme', 'select', 'system', { options: [{ value: 'system', label: { zh: '跟随系统', en: 'System' } }, { value: 'dark', label: { zh: '深色', en: 'Dark' } }] })
  assert(m.valueOf(mode, { 'appearance.theme': 'dark' }) === 'dark', 'a declared option sticks')
  assert(m.valueOf(mode, { 'appearance.theme': 'neon' }) === 'system', 'an option nobody declares falls back')
  return 'boolean/number/select defaults, clamping, unknown option'
})

modelCheck('test-dirty-compare', m => {
  const fields = [field('appearance.theme', 'select', 'system', { options: [{ value: 'system', label: { zh: '系统', en: 'System' } }, { value: 'dark', label: { zh: '深色', en: 'Dark' } }] }), field('advanced.backupKeep', 'number', 20, { min: 1, max: 200 })]
  const stored = { 'appearance.theme': 'system', 'advanced.backupKeep': 20 }
  assert(equal(m.dirtyOf(fields, m.draftOf(fields, stored), stored), []), 'a fresh draft is clean')
  const edited = { ...m.draftOf(fields, stored), 'appearance.theme': 'dark' }
  assert(equal(m.dirtyOf(fields, edited, stored), ['appearance.theme']), 'one edit is one dirty key')
  const typed = { ...m.draftOf(fields, stored), 'advanced.backupKeep': '20' }
  assert(equal(m.dirtyOf(fields, typed, stored), []), 'a numeric string equal to the number is not a change')
  const cleared = { ...m.draftOf(fields, stored), 'advanced.backupKeep': '' }
  assert(equal(m.dirtyOf(fields, cleared, stored), []), 'an empty number equals the default, so it is clean')
  return 'clean draft, one edit, numeric string, cleared number'
})

modelCheck('test-save-payload', m => {
  const fields = [field('appearance.theme', 'select', 'system', { options: [{ value: 'system', label: { zh: '系统', en: 'System' } }, { value: 'dark', label: { zh: '深色', en: 'Dark' } }] }), field('advanced.backupKeep', 'number', 20, { min: 1, max: 200 }), field('general.language', 'select', 'auto', { options: [{ value: 'auto', label: { zh: '跟随界面', en: 'Follow UI' } }, { value: 'en', label: { zh: 'English', en: 'English' } }] })]
  const stored = { 'appearance.theme': 'system', 'advanced.backupKeep': 20, 'general.language': 'auto' }
  const draft = { ...m.draftOf(fields, stored), 'appearance.theme': 'dark', 'advanced.backupKeep': '35' }
  const payload = m.savePayloadOf(fields, draft, stored)
  assert(equal(Object.keys(payload), ['appearance.theme', 'advanced.backupKeep']), 'payload keys were ' + Object.keys(payload).join(','))
  assert(payload['appearance.theme'] === 'dark', 'the changed select travels')
  assert(payload['advanced.backupKeep'] === 35, 'the number travels as a number, not a string')
  assert(!('general.language' in payload), 'an untouched key must not travel')
  const moved = m.savePayloadOf(fields, { ...draft, 'advanced.backupKeep': '' }, { ...stored, 'advanced.backupKeep': 35 })
  assert(moved['advanced.backupKeep'] === 20, 'a cleared number travels as the declared default')
  const noop = m.savePayloadOf(fields, { ...m.draftOf(fields, stored), 'advanced.backupKeep': '' }, stored)
  assert(!('advanced.backupKeep' in noop), 'clearing a number that already holds the default writes nothing')
  return 'only changed keys, numbers coerced, clearing falls back to the default, a no-op stays unsent'
})

modelCheck('test-restore-defaults', m => {
  const fields = [field('appearance.theme', 'select', 'system', { options: [{ value: 'system', label: { zh: '系统', en: 'System' } }, { value: 'dark', label: { zh: '深色', en: 'Dark' } }] }), field('tools.lazyDefault', 'boolean', false)]
  const stored = { 'appearance.theme': 'dark', 'tools.lazyDefault': false }
  const draft = { ...m.draftOf(fields, stored), 'tools.lazyDefault': true }
  const restored = m.restoreDefaultsOf(fields, draft)
  assert(restored['appearance.theme'] === 'system', 'restore takes the declared default')
  assert(restored['tools.lazyDefault'] === false, 'restore resets a boolean')
  assert(equal(m.dirtyOf(fields, restored, stored), ['appearance.theme']), 'restoring is still a draft: it only marks the difference')
  return 'defaults only in the draft, still dirty against the store'
})

modelCheck('test-empty-schema', m => {
  assert(equal(m.groupFields([]), []), 'no schema means no sections')
  assert(equal(m.draftOf([], {}), {}), 'no schema means an empty draft')
  assert(equal(m.dirtyOf([], {}, {}), []), 'no schema means nothing is dirty')
  assert(equal(m.savePayloadOf([], {}, {}), {}), 'no schema means an empty payload')
  assert(m.modulePrefixOf([]) === '', 'an empty schema has no module prefix')
  return 'empty schema is a total case, not a crash'
})

// ── report ──────────────────────────────────────────────────────────────────

console.log(passed + '/' + (passed + failed) + ' checks passed')
if (failed > 0) {
  console.log('failed: ' + failedNames.join(', '))
  process.exit(1)
}
