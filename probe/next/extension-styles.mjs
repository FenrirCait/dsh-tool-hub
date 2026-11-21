#!/usr/bin/env node
/**
 * extension styles: manifest paths are validated, CSS is read only while enabled, and a CSS edit
 * changes the load key so extension.reload picks it up without a host restart.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { normalizeManifest, ExtensionManager, extensionRoots } from '../../dist/host/extensions.js'

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log('PASS ' + name) }
  else { failed += 1; console.log('FAIL ' + name + (detail === '' ? '' : '  ' + detail)) }
}
function assert(condition, message) { if (!condition) throw new Error(message) }

const base = {
  id: 'style-demo', name: { zh: '样式示例', en: 'Style demo' }, version: '1.0.0', apiVersion: 1,
  host: 'host.mjs',
}
const root = await mkdtemp(join(tmpdir(), 'tool-hub-styles-'))
const dir = join(root, 'style-demo')
await writeFile(join(root, 'keep'), '')
await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }))
await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...base, styles: ['style.css'] }), 'utf8')
await writeFile(join(dir, 'host.mjs'), `export default () => ({ module: { id: 'style-demo', title: { zh: '样式示例', en: 'Style demo' }, ops: [] }, handlers: {} })\n`, 'utf8')
await writeFile(join(dir, 'style.css'), '.th-root { --demo: 1; }\n', 'utf8')

try {
  const roots = extensionRoots().map(root => root.replace(/\\/g, '/'))
  check('the package compat directory is an extension root', roots.some(root => root.endsWith('/compat')), roots.join(' '))
  const bundled = extensionRoots().find(root => root.replace(/\\/g, '/').endsWith('/compat'))
  const bundledManifest = bundled === undefined ? null : await import('node:fs/promises').then(fs => fs.readFile(join(bundled, 'codex-ui-glass', 'manifest.json'), 'utf8'))
  check('the official pack is discoverable there', bundledManifest !== null && JSON.parse(bundledManifest).id === 'codex-ui-glass')
  const bundledManager = new ExtensionManager({ roots: [resolve('compat')], services: { get: () => undefined }, log: () => {} })
  const bundledRows = await bundledManager.load([])
  const bundledRow = bundledRows.statuses.find(status => status.id === 'codex-ui-glass')
  check('the bundled row is flagged as bundled', bundledRow?.bundled === true, JSON.stringify(bundledRow))

  const ok = normalizeManifest({ ...base, styles: ['style.css'] })
  check('manifest accepts a relative css path', ok.ok && ok.manifest.styles[0] === 'style.css')

  for (const [label, value] of [
    ['traversal', ['../x.css']],
    ['absolute', ['C:/x.css']],
    ['not-css', ['x.txt']],
    ['not-array', 'style.css'],
  ]) {
    const result = normalizeManifest({ ...base, styles: value })
    check('manifest rejects ' + label, result.ok === false, result.ok ? 'accepted' : '')
  }

  const manager = new ExtensionManager({ roots: [root], services: { get: () => undefined }, log: () => {} })
  const loaded = await manager.load(['style-demo'])
  const row = loaded.statuses.find(status => status.id === 'style-demo')
  assert(row !== undefined, 'status row missing')
  check('enabled extension reports its style path', row.styles[0] === 'style.css')
  check('enabled extension ships the css text', row.css.length === 1 && row.css[0].includes('--demo: 1'))
  check('the registration still loads', row.loaded === true && row.error === null, String(row.error))

  const disabled = await manager.load([])
  const off = disabled.statuses.find(status => status.id === 'style-demo')
  check('disabled extension keeps the declared path', off.styles[0] === 'style.css')
  check('disabled extension ships no css', off.css.length === 0)

  await writeFile(join(dir, 'style.css'), '.th-root { --demo: 2; }\n', 'utf8')
  manager.invalidate('style-demo')
  const reloaded = await manager.load(['style-demo'])
  const again = reloaded.statuses.find(status => status.id === 'style-demo')
  check('editing the css changes what reload serves', again.css[0].includes('--demo: 2'))
}
finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
