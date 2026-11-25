#!/usr/bin/env node
/**
 * probe/next/client-scenes.mjs - the scenes page as source, because a static gate is the only
 * way to check a view without a browser in this repo's probe set.
 *
 * What it pins:
 *   1. the five op ids the page sends are declared in one table (api.ts), not sprinkled as
 *      literals across views;
 *   2. every row action sends the payload its domain reads (`name`) plus the `id` the shell
 *      keys its spinner on - the pair is the contract, and dropping `id` silently kills the
 *      per-row busy state;
 *   3. the lock affordance is reachable and announced: a badge with role="img" and an
 *      aria-label, a banner when anything is locked, and a lock/unlock button per row;
 *   4. the editor exposes all four sections as opt-in (so "absent" stays expressible), a preset
 *      select, and one payload builder;
 *   5. every t('...') the two files call exists in both catalogs, and both files stay under the
 *      300-line design budget for a view.
 *
 * Exit code 1 on any failure; every line is PASS or FAIL.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = join(ROOT, 'src', 'client')

let passed = 0
let failed = 0
const failures = []

function check(name, fn) {
  try {
    const detail = fn()
    passed += 1
    console.log('PASS ' + name + (detail === undefined || detail === '' ? '' : '  ' + detail))
  }
  catch (error) {
    failed += 1
    failures.push(name)
    console.log('FAIL ' + name + '  ' + String(error && error.message ? error.message : error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function read(name) {
  return readFileSync(join(CLIENT, name), 'utf8')
}

/** Source with comments stripped: prose may name a token this gate only allows in code. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')
}

function source(name) {
  try {
    return read(name)
  }
  catch {
    throw new Error('src/client/' + name + ' is missing')
  }
}

// ── 1. the ops come from one table ─────────────────────────────────────────

check('api: the five scene op ids are declared', () => {
  const api = source('api.ts')
  for (const [key, id] of [['sceneSave', 'scene.save'], ['sceneApply', 'scene.apply'], ['sceneExit', 'scene.exit'], ['sceneDelete', 'scene.delete'], ['sceneLock', 'scene.lock']]) {
    assert(new RegExp(key + ": '" + id.replace('.', '\\.') + "'").test(api), 'api.ts does not declare ' + key + ' = ' + id)
  }
  return 'OPS.scene{Save,Apply,Exit,Delete,Lock}'
})

check('scenes view: no scene op id is written as a bare literal', () => {
  const view = code(source('views/scenes.tsx'))
  for (const id of ['scene.save', 'scene.apply', 'scene.exit', 'scene.delete', 'scene.lock']) {
    assert(!view.includes("'" + id + "'"), 'views/scenes.tsx hard-codes ' + id + ' instead of OPS')
  }
  return 'ops come from OPS'
})

// ── 2. row actions: payload pairs ──────────────────────────────────────────

check('row actions: apply / delete / lock send name and id together', () => {
  const view = code(source('views/scenes.tsx'))
  const wanted = [
    'run(OPS.sceneApply, { name, id: name })',
    'run(OPS.sceneDelete, { name, id: name })',
    'run(OPS.sceneLock, { name, locked: false, id: name })',
    'run(OPS.sceneLock, { name, locked: true, id: name })',
  ]
  for (const call of wanted) assert(view.includes(call), 'views/scenes.tsx is missing: ' + call)
  return wanted.length + ' payloads'
})

check('row actions: apply asks the host for its plan before confirming', () => {
  const view = code(source('views/scenes.tsx'))
  assert(view.includes("runDetailed('scene.plan', { name })"), 'apply does not read scene.plan')
  assert(/settings\['settings\.scenes\.confirmApply'\]/.test(view), 'apply ignores the scenes.confirmApply setting')
  assert(view.includes('pending.description'), 'the confirm dialog does not show the plan line')
  return 'plan line + setting'
})

check('row actions: save goes through one payload builder', () => {
  const view = code(source('views/scenes.tsx'))
  const editor = code(source('views/scene-editor.tsx'))
  assert(view.includes('scenePayload(draft)'), 'the view does not use scenePayload')
  assert(view.includes('run(OPS.sceneSave, { ...body, id: draft.name.trim() })'), 'the save payload lost its id')
  for (const section of ['plugins', 'skills', 'tools', 'mcp', 'preset']) {
    assert(new RegExp('if \\(draft\\.' + section + 'On\\) body\\.' + section).test(editor) || new RegExp('draft\\.preset !== \'\'').test(editor), 'scenePayload does not gate ' + section)
  }
  return 'scenePayload'
})

// ── 3. the lock is reachable and announced ─────────────────────────────────

check('lock: badge, banner and button all exist', () => {
  const view = code(source('views/scenes.tsx'))
  assert(view.includes('role="img"'), 'the lock icon has no role')
  assert(view.includes("t('scenes.lockedA11y'"), 'the lock icon has no aria-label')
  assert(view.includes("t('scenes.lockedBanner'"), 'no banner when a scene is locked')
  assert(view.includes("t('scenes.unlock')") && view.includes("t('scenes.lock')"), 'no lock/unlock button')
  assert(view.includes('lockedNames.includes(mode)'), 'the exit button does not mention the locked active scene')
  // The archive of a locked scene cannot be changed, so the buttons say so instead of failing later.
  assert(/disabled=\{locked\}/.test(view), 'the editor is not disabled for a locked scene')
  assert(/disabled=\{isCurrent \|\| locked\}/.test(view), 'delete is not disabled for a locked scene')
  return 'badge + banner + lock/unlock + disabled archive edits'
})

check('lock: locking asks first, unlocking does not', () => {
  const view = code(source('views/scenes.tsx'))
  const lockBlock = /if \(!locked\) \{([\s\S]{0,120}?)\}/.exec(view)
  assert(lockBlock !== null, 'the lock button has no branch')
  assert(lockBlock[1].includes("kind: 'lock'"), 'locking does not open a confirmation')
  const unlockCall = /void run\(OPS\.sceneLock, \{ name, locked: false, id: name \}\)/.test(view)
  assert(unlockCall, 'unlocking does not run directly')
  return 'confirm on lock only'
})

// ── 4. the editor exposes the four sections and the preset ─────────────────

check('editor: synthetic bundle rows are not scene members', () => {
  const editor = code(source('views/scene-editor.tsx'))
  assert(editor.includes('row.bundleName === undefined'), 'the scene plugin picker must exclude synthetic bundle rows')
  return 'bundle rows excluded'
})

check('editor: every section is opt-in and the preset is a select', () => {
  const editor = code(source('views/scene-editor.tsx'))
  for (const [id, part] of [['th-scene-plugins', 'plugins'], ['th-scene-skills', 'skills'], ['th-scene-tools', 'tools'], ['th-scene-mcp', 'mcp']]) {
    assert(editor.includes('id="' + id + '"'), 'the editor has no ' + id + ' section')
    // The switch itself is derived (props.id + '-on'), so the section's opt-in state is the proof.
    assert(editor.includes('on={draft.' + part + 'On}'), 'the editor has no switch for ' + id)
    assert(editor.includes('patch({ ' + part + 'On: on })'), 'the ' + part + ' switch does not flip its section')
  }
  assert(editor.includes("props.id + '-on'"), 'the section switch does not derive its own id')
  assert(editor.includes('id="th-scene-preset"'), 'the editor has no preset select')
  assert(editor.includes("t('scenes.editor.presetNone')"), 'the preset select has no "none" option')
  assert(editor.includes('draftFromEnvironment'), 'a new scene does not start from the live environment')
  return '4 sections + preset'
})

// ── 5. copy and size ───────────────────────────────────────────────────────

check('i18n: every key the two files use exists in both catalogs', () => {
  const i18n = source('i18n.ts')
  const enAt = i18n.indexOf('const en: Catalog')
  assert(enAt > 0, 'i18n.ts has no en catalog')
  const keysOf = text => new Set([...text.matchAll(/'([A-Za-z0-9_.]+)':/g)].map(match => match[1]))
  const zh = keysOf(i18n.slice(0, enAt))
  const en = keysOf(i18n.slice(enAt))
  const used = new Set()
  for (const file of ['views/scenes.tsx', 'views/scene-editor.tsx']) {
    for (const match of code(source(file)).matchAll(/t\('([^']+)'/g)) used.add(match[1])
  }
  assert(used.size > 20, 'only ' + used.size + ' t() keys were found; the parser is wrong')
  for (const key of used) {
    assert(zh.has(key), 'zh is missing ' + key)
    assert(en.has(key), 'en is missing ' + key)
  }
  return used.size + ' keys'
})

check('size: both files stay under the 300-line view budget', () => {
  const rows = ['views/scenes.tsx', 'views/scene-editor.tsx'].map(name => [name, source(name).split('\n').length])
  for (const [name, lines] of rows) assert(lines <= 300, name + ' is ' + lines + ' lines')
  return rows.map(([name, lines]) => name + ' ' + lines + ' lines').join(', ')
})

console.log('')
console.log('client-scenes probe: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  console.log('failed: ' + failures.join('; '))
  process.exitCode = 1
}