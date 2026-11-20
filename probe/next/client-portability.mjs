#!/usr/bin/env node
/**
 * probe/next/client-portability.mjs — the two portability dialogs, checked from outside.
 *
 * The groups view gains a dshmarket preview (read) and an import (write); the plugins view gains
 * the third-party panic switch (a read, an off behind its own confirm, and a restore). The gate
 * pins the split the host needs — reads through runOp, writes through run() — and the op ids and
 * payloads src/host/portability.ts registers: market.status {}, market.import {}, third.status {},
 * third.off {}, third.restore {}.
 *
 * Two halves. The static half reads both views and checks the wiring: the preview is fetched
 * before any write leaves, the import and the off/restore calls carry {} and are reachable only
 * from the dialogs, the confirm sits in front of third.off, every string is a defined key in both
 * catalogs, and no colour is written as a literal. The runtime half cuts the exported helper
 * regions out of the two files, bundles them with the project's own esbuild and imports them, so
 * normalizeMarket / normalizeThird / thirdCounts / rollbackCount are executed against the shapes
 * the 1.x handlers actually return, not merely grepped.
 *
 * No third-party libraries beyond the repo's esbuild. Every line is PASS or FAIL; exit 1 when any
 * check fails.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GROUPS = join(ROOT, 'src', 'client', 'views', 'groups.tsx')
const PLUGINS = join(ROOT, 'src', 'client', 'views', 'plugins.tsx')
const I18N = join(ROOT, 'src', 'client', 'i18n.ts')

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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const groupsSource = readFileSync(GROUPS, 'utf8')
const pluginsSource = readFileSync(PLUGINS, 'utf8')
const i18n = readFileSync(I18N, 'utf8')

/** Comments stripped: a doc comment may name an op or a payload key in prose. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')
const groups = code(groupsSource)
const plugins = code(pluginsSource)

/** Body of one declaration, from its marker to the next one. */
function slice(text, from, to) {
  const start = text.indexOf(from)
  assert(start !== -1, 'no ' + from)
  const end = text.indexOf(to, start + from.length)
  assert(end !== -1, 'no ' + to + ' after ' + from)
  return text.slice(start, end)
}

const REGION = /\/\/ #region ([\w-]+)[\s\S]*?\/\/ #endregion \1/g
const regions = source => [...source.matchAll(REGION)].map(match => ({ name: match[1], body: match[0] }))
const marketRegion = regions(groupsSource).find(region => region.name === 'market-helpers')
const thirdRegion = regions(pluginsSource).find(region => region.name === 'third-helpers')

/** i18n catalogs as key -> template, so both existence and placeholders are checkable. */
function catalog(name) {
  const marker = new RegExp('const ' + name + ': Catalog = \\{').exec(i18n)
  assert(marker !== null, 'i18n.ts has no ' + name + ' catalog')
  const start = marker.index + marker[0].length - 1
  let depth = 0
  let end = -1
  for (let cursor = start; cursor < i18n.length; cursor += 1) {
    if (i18n[cursor] === '{') depth += 1
    else if (i18n[cursor] === '}') {
      depth -= 1
      if (depth === 0) { end = cursor; break }
    }
  }
  assert(end !== -1, name + ' catalog is not closed')
  const map = new Map()
  for (const match of i18n.slice(start + 1, end).matchAll(/^\s*'([^']+)'\s*:\s*'((?:[^'\\]|\\.)*)'/gm)) map.set(match[1], match[2])
  return map
}

const zh = catalog('zh')
const en = catalog('en')
const keysUsed = source => new Set([...source.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]))

/** A call argument is the empty object literal: portability writes take no payload fields. */
function emptyPayloadCalls(source, call) {
  return [...source.matchAll(new RegExp('\\b' + call + '\\(\\s*([^,)]+),\\s*(\\{\\s*\\})', 'g'))].map(match => match[1])
}

// ── static gates: groups view ────────────────────────────────────────────────

check('sources-and-exports', () => {
  assert(/export function GroupsView\(props: ViewProps\): React\.ReactElement \{/.test(groups),
    'GroupsView must keep its exported name and (props: ViewProps) signature')
  assert(/export function PluginsView\(props: ViewProps\): React\.ReactElement \{/.test(plugins),
    'PluginsView must keep its exported name and (props: ViewProps) signature')
  assert(/import \* as React from 'react'/.test(groups) && /import \* as React from 'react'/.test(plugins),
    'both views must import React')
  assert(marketRegion !== undefined, 'groups.tsx lost its market-helpers region')
  assert(thirdRegion !== undefined, 'plugins.tsx lost its third-helpers region')
  return 'two views, two helper regions'
})

check('helpers-standalone', () => {
  for (const region of [marketRegion, thirdRegion]) {
    assert(!/\bimport\b/.test(region.body), region.name + ' must stay import-free so it can be executed alone')
    assert(!/React\./.test(region.body), region.name + ' must not touch React')
    assert(!/\bfetch\(|innerHTML/.test(region.body), region.name + ' must not talk to the host')
  }
  return 'no imports, no React, no io'
})

check('market-button', () => {
  assert(/t\('market\.import'\)/.test(groups), 'the dshmarket button must use the market.import label')
  assert(/t\('market\.importHint'\)/.test(groups), 'the button must carry the market.importHint title')
  const openAt = groups.indexOf('void openMarket()')
  assert(openAt !== -1, 'the button must open the preview through openMarket()')
  const createAt = groups.indexOf('onClick={openCreate}')
  assert(createAt !== -1 && openAt < createAt, 'the import action belongs in the toolbar, before New group')
  return 'toolbar -> openMarket()'
})

check('market-read-through-runop', () => {
  const reads = [...groups.matchAll(/runOp\(\s*(OPS\.[A-Za-z0-9_]+)/g)].map(match => match[1])
  assert(reads.includes('OPS.marketStatus'), 'market.status must be read through runOp')
  const unexpected = reads.filter(target => target !== 'OPS.autoPreview' && target !== 'OPS.marketStatus')
  assert(unexpected.length === 0, 'runOp is for reads only; unexpected ' + unexpected.join(', '))
  assert(/runOp\(OPS\.marketStatus, \{\}\)/.test(groups), 'market.status takes an empty payload')
  return reads.join(', ')
})

check('market-preview-dialog', () => {
  const copy = slice(groups, "let title = ''", 'return (')
  assert(/dialog === 'market'/.test(copy), 'the dialog needs a market branch')
  assert(/t\('market\.preview', totals\)/.test(copy), 'the preview must print market.preview with the totals')
  assert(/t\('market\.none'\)/.test(copy), 'an empty preview must print market.none')
  assert(/const totals = \{ groups: list\.length, members:/.test(copy), 'the totals must count groups and members')
  assert(/confirmDisabled = list\.length === 0/.test(copy), 'a preview with no group must not be submittable')
  return 'market.preview + market.none + disabled when empty'
})

check('market-write-through-run', () => {
  const confirmFn = slice(groups, 'const confirmAction', 'const newDrawerLabel')
  assert(/run\(OPS\.marketImport, \{\}\)/.test(confirmFn),
    'market.import must leave from the dialog confirm handler')
  const calls = [...groups.matchAll(/run\(OPS\.marketImport/g)]
  assert(calls.length === 1, 'market.import must have exactly one call site, found ' + calls.length)
  assert(!/runOp\(OPS\.marketImport/.test(groups), 'a write must not go through runOp')
  return 'one run(OPS.marketImport, {}) inside confirmAction'
})

check('market-preview-before-write', () => {
  const readAt = groups.indexOf('runOp(OPS.marketStatus')
  const writeAt = groups.indexOf('run(OPS.marketImport')
  assert(readAt !== -1 && writeAt !== -1, 'both the preview and the import must exist')
  assert(readAt < writeAt, 'the preview must be fetched before the write, not after it')
  const dialogAt = groups.indexOf("setDialog('market')")
  assert(dialogAt !== -1 && dialogAt < writeAt, 'the preview must open a dialog before the import is reachable')
  return 'status -> dialog -> import'
})

// ── static gates: plugins view ──────────────────────────────────────────────

check('third-button', () => {
  assert(/t\('third\.title'\)/.test(plugins), 'the plugins toolbar needs the third.title action')
  assert(/void openThird\(\)/.test(plugins), 'the action must open the dialog through openThird()')
  return 'toolbar -> openThird()'
})

check('third-read-through-runop', () => {
  const reads = [...plugins.matchAll(/runOp\(\s*(THIRD\.[A-Za-z0-9_]+)/g)].map(match => match[1])
  assert(reads.includes('THIRD.status'), 'third.status must be read through runOp')
  const unexpected = reads.filter(target => target !== 'THIRD.status')
  assert(unexpected.length === 0, 'runOp is for the status read only; unexpected ' + unexpected.join(', '))
  assert(/runOp\(THIRD\.status, \{\}\)/.test(plugins), 'third.status takes an empty payload')
  return reads.join(', ')
})

check('third-off-behind-confirm', () => {
  const footerStart = plugins.indexOf('footer={')
  assert(footerStart !== -1, 'the third-party dialog needs a footer')
  const confirmBranchAt = plugins.indexOf('thirdConfirm ? (', footerStart)
  const otherBranchAt = plugins.indexOf(') : (', footerStart)
  assert(confirmBranchAt !== -1 && otherBranchAt !== -1, 'the footer must switch between status and confirm')
  const offAt = plugins.indexOf('onClick={disableThird}', footerStart)
  assert(offAt > confirmBranchAt && offAt < otherBranchAt,
    'run third.off only from the confirm branch, never straight from the status footer')
  assert(/onClick=\{\(\) => \{ setThirdConfirm\(true\) \}\}/.test(plugins),
    'the status footer must open the confirm instead of writing')
  assert(/t\('third\.confirmOff', \{ n: thirdTargets \}\)/.test(plugins),
    'the confirm must say how many targets it will disable')
  const calls = [...plugins.matchAll(/run\(THIRD\.off/g)]
  assert(calls.length === 1, 'third.off must have exactly one call site, found ' + calls.length)
  return 'status footer -> confirm -> third.off'
})

check('third-restore-through-run', () => {
  const restoreFn = slice(plugins, 'const restoreThird', 'if (snapshot.plugins.length === 0)')
  assert(/run\(THIRD\.restore, \{\}\)/.test(restoreFn), 'third.restore must be sent by restoreThird')
  const restoreAt = plugins.indexOf('onClick={restoreThird}')
  const footerStart = plugins.indexOf('footer={')
  const confirmBranchAt = plugins.indexOf('thirdConfirm ? (', footerStart)
  assert(restoreAt > confirmBranchAt, 'restore is offered in the status footer, not hidden behind the off confirm')
  assert(!/runOp\(THIRD\.restore/.test(plugins), 'a write must not go through runOp')
  return 'restore in the status footer, through run()'
})

check('third-status-render', () => {
  assert(/t\('third\.status', thirdCounts\(third\)\)/.test(plugins),
    'the dialog must print third.status with the counts')
  assert(/t\('third\.noSnapshot'\)/.test(plugins), 'a missing rollback point must print third.noSnapshot')
  assert(/t\('third\.none'\)/.test(plugins), 'no target must print third.none')
  assert(/rollbackCount\(third\.snapshot\)/.test(plugins), 'the rollback point must show how many items it holds')
  return 'counts + rollback point + empty state'
})

check('op-ids-match-contract', () => {
  const ids = ['market.status', 'market.import', 'third.status', 'third.off', 'third.restore']
  const missing = ids.filter(id => !groups.includes("'" + id + "'") && !plugins.includes("'" + id + "'"))
  assert(missing.length === 0, 'no view names ' + missing.join(', '))
  assert(!/thirdparty\./.test(groups + plugins), 'the 1.x thirdparty.* names must not survive in the panel')
  const table = slice(plugins, 'export const THIRD', 'const stringList')
  for (const id of ['third.status', 'third.off', 'third.restore']) {
    assert(table.includes("'" + id + "'"), 'THIRD must map ' + id)
  }
  return ids.join(', ')
})

check('payloads-are-empty-objects', () => {
  const market = emptyPayloadCalls(groups, 'run')
  const third = emptyPayloadCalls(plugins, 'run')
  assert(market.includes('OPS.marketImport'), 'market.import is sent ' + JSON.stringify(market))
  assert(third.includes('THIRD.off') && third.includes('THIRD.restore'), 'third writes are sent ' + JSON.stringify(third))
  assert(groups.includes('runOp(OPS.marketStatus, {})'), 'market.status must send {} as its payload')
  assert(plugins.includes('runOp(THIRD.status, {})'), 'third.status must send {} as its payload')
  return 'market/third ops all carry {}'
})

// ── shared gates ────────────────────────────────────────────────────────────

check('no-literal-colours', () => {
  const strip = text => {
    let out = ''
    let index = 0
    while (index < text.length) {
      const start = text.indexOf('var(--dsw-alias-', index)
      if (start === -1) { out += text.slice(index); break }
      out += text.slice(index, start)
      let depth = 0
      let cursor = start
      for (; cursor < text.length; cursor += 1) {
        const char = text[cursor]
        if (char === '(') depth += 1
        else if (char === ')') { depth -= 1; if (depth === 0) { cursor += 1; break } }
      }
      index = cursor
    }
    return out
  }
  for (const [name, text] of [['groups.tsx', groups], ['plugins.tsx', plugins]]) {
    const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(strip(text))
    assert(match === null, name + ' has a literal colour at char ' + (match === null ? 0 : match.index))
  }
  return 'tokens only in both views'
})

check('no-direct-io', () => {
  for (const [name, text] of [['groups.tsx', groups], ['plugins.tsx', plugins]]) {
    for (const pattern of ['fetch(', 'getSnapshot', 'innerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML']) {
      assert(text.indexOf(pattern) === -1, name + ' calls ' + pattern)
    }
  }
  return 'no fetch, no innerHTML'
})

check('i18n-keys', () => {
  const used = new Set([...keysUsed(groups), ...keysUsed(plugins)])
  const missing = [...used].filter(key => !zh.has(key) || !en.has(key))
  assert(missing.length === 0, 'no catalog defines ' + missing.join(', '))
  const drift = [...zh.keys()].filter(key => !en.has(key))
  assert(drift.length === 0, 'catalog drift: zh-only ' + drift.join(','))
  const placeholders = {
    'market.preview': ['groups', 'members'],
    'third.status': ['plugins', 'skills', 'snapshots'],
    'third.confirmOff': ['n'],
    'third.result': ['n'],
    'third.restored': ['n'],
  }
  for (const [key, names] of Object.entries(placeholders)) {
    for (const lang of [zh, en]) {
      const template = lang.get(key)
      assert(template !== undefined, key + ' is undefined')
      assert(names.every(name => template.includes('{' + name + '}')), key + ' lost a placeholder: ' + template)
    }
  }
  const marketKeys = [...used].filter(key => key.startsWith('market.') || key.startsWith('third.'))
  assert(marketKeys.length >= 8, 'expected the whole market./third. copy to be used, found ' + marketKeys.length)
  return used.size + ' keys used, ' + marketKeys.length + ' of them portability copy'
})

check('file-length', () => {
  for (const [name, file] of [['groups.tsx', GROUPS], ['plugins.tsx', PLUGINS]]) {
    const source = readFileSync(file, 'utf8')
    const lines = source.split('\n').length
    assert(lines <= 450, name + ' is ' + lines + ' lines (limit 450)')
    assert(statSync(file).size < 64 * 1024, name + ' grew past 64 KiB')
  }
  return 'both views inside the 450-line cap'
})

// ── runtime: both helper regions, bundled and executed ──────────────────────

async function loadRegion(region, sourcefile) {
  assert(region !== undefined, sourcefile + ' has no helper region')
  const bundled = await build({
    stdin: { contents: code(region.body), loader: 'ts', resolveDir: ROOT, sourcefile },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })
  const text = bundled.outputFiles?.[0]?.text ?? ''
  assert(text !== '', 'esbuild produced no bundle for ' + sourcefile)
  return await import('data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64'))
}

let marketApi = null
let thirdApi = null
try {
  marketApi = await loadRegion(marketRegion, 'market-helpers.ts')
  thirdApi = await loadRegion(thirdRegion, 'third-helpers.ts')
} catch (error) {
  failed += 1
  failedNames.push('helpers-bundle')
  console.log('FAIL helpers-bundle -- ' + (error instanceof Error ? error.message : String(error)))
}

function market() {
  assert(marketApi !== null, 'the market helper region did not compile')
  return marketApi
}

function third() {
  assert(thirdApi !== null, 'the third helper region did not compile')
  return thirdApi
}

check('runtime-market-total', () => {
  const mod = market()
  for (const raw of [null, undefined, [], 7, 'x', {}, { groups: 'nope' }]) {
    const status = mod.normalizeMarket(raw)
    assert(status.available === false && status.file === null && status.error === null, 'garbage must become an empty status: ' + JSON.stringify(raw))
    assert(Array.isArray(status.groups) && status.groups.length === 0, 'garbage must carry no group')
  }
  return '7 malformed answers stay renderable'
})

check('runtime-market-mapping', () => {
  const mod = market()
  const status = mod.normalizeMarket({
    available: true,
    file: '/profile/.dsh-market/state.json',
    error: null,
    groups: [
      { name: 'foundation', packages: 2, members: 1, ids: ['e1'], missing: ['pkg-b'] },
      { name: '', members: 9, missing: [] },
      { name: 'empty', members: 0, missing: 'not-an-array' },
    ],
  })
  assert(status.available === true && status.file === '/profile/.dsh-market/state.json', 'available and file must survive')
  assert(status.groups.length === 2, 'nameless groups must be dropped, got ' + status.groups.length)
  assert(status.groups[1].members === 0 && status.groups[1].missing === 0, 'non-array missing must read as 0')
  assert(JSON.stringify(status.groups[0]) === JSON.stringify({ name: 'foundation', members: 1, missing: 1 }),
    'a group is name + members + missing, got ' + JSON.stringify(status.groups[0]))
  const error = mod.normalizeMarket({ available: false, error: 'cannot read dshmarket state: EACCES' })
  assert(error.error === 'cannot read dshmarket state: EACCES', 'the host error must be shown, not swallowed')
  return 'mapped, dropped the nameless, kept the error'
})

check('runtime-third-total', () => {
  const mod = third()
  for (const raw of [null, undefined, [], 7, 'x', {}, { targets: 'nope' }]) {
    const status = mod.normalizeThird(raw)
    assert(Array.isArray(status.targets) && status.targets.length === 0, 'garbage must carry no target')
    assert(status.snapshot === null, 'garbage must carry no rollback point')
  }
  return '6 malformed answers stay renderable'
})

check('runtime-third-mapping', () => {
  const mod = third()
  const status = mod.normalizeThird({
    targets: [
      { kind: 'plugin', id: 'e2', name: 'Extra', moduleName: 'dsh-extra', mcp: false, role: null },
      { id: 's1', name: 'Skill One', kind: 'skill' },
      { kind: 'plugin', id: '', name: 'nameless' },
    ],
    snapshot: { file: '2026-01-01.json', at: '2026-01-01T00:00:00.000Z', plugins: ['e2', 7], skills: ['s1'] },
  })
  assert(status.targets.length === 2, 'targets without an id must be dropped, got ' + status.targets.length)
  assert(status.targets[0].kind === 'plugin' && status.targets[0].mcp === false, 'kind and mcp must survive')
  assert(status.targets[1].kind === 'skill', 'the second target is a skill')
  assert(status.targets[1].name === 'Skill One', 'the name defaults to the id only when absent')
  assert(status.snapshot !== null && status.snapshot.file === '2026-01-01.json', 'the rollback file must survive')
  assert(JSON.stringify(status.snapshot.plugins) === '["e2"]', 'non-string ids must be filtered out')
  const bare = mod.normalizeThird({ targets: [{ id: 'x' }], snapshot: { plugins: [] } })
  assert(bare.targets[0].kind === 'plugin' && bare.targets[0].name === 'x', 'kind defaults to plugin and name to id')
  assert(bare.snapshot !== null && bare.snapshot.file === '' && bare.snapshot.at === '', 'a sparse snapshot must not crash')
  return 'targets mapped, snapshot normalised'
})

check('runtime-third-counts', () => {
  const mod = third()
  const status = mod.normalizeThird({
    targets: [{ id: 'a', kind: 'plugin' }, { id: 'b', kind: 'plugin' }, { id: 'c', kind: 'skill' }],
    snapshot: { file: 'f.json', plugins: ['a', 'b'], skills: ['c'] },
  })
  const counts = mod.thirdCounts(status)
  assert(counts.plugins === 2 && counts.skills === 1, 'thirdCounts must split by kind: ' + JSON.stringify(counts))
  assert(counts.snapshots === 1, 'one rollback point must read as 1')
  assert(mod.thirdCounts(mod.normalizeThird({})).snapshots === 0, 'no rollback point must read as 0')
  assert(mod.rollbackCount(status.snapshot) === 3, 'the rollback point holds every captured id')
  assert(mod.rollbackCount(null) === 0, 'no snapshot means nothing to restore')
  return '2 plugins / 1 skill / 1 snapshot; 3 restorable'
})

// ── report ───────────────────────────────────────────────────────────────────

const total = passed + failed
console.log(passed + '/' + total + ' checks passed')
if (failed > 0) {
  console.log('failed: ' + failedNames.join(', '))
  process.exit(1)
}
