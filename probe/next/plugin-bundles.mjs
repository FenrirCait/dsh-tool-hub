#!/usr/bin/env node
/**
 * Installed-but-disabled bundles: listBundles() is the only host view that knows about them, so the
 * snapshot synthesizes one switchable row per such bundle and routes the switch through
 * setBundleEnabled(). The loader's listPlugins() intentionally contains loaded entries only.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const plugins = await import(pathToFileURL(join(distRoot, 'domains', 'plugins.js')).href)

let pass = 0
let fail = 0
async function check(name, run) {
  try {
    const detail = await run()
    pass += 1
    console.log('PASS ' + name + (detail === undefined ? '' : '  ' + detail))
  }
  catch (error) {
    fail += 1
    console.log('FAIL ' + name + '  ' + (error && error.message ? error.message : String(error)))
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function equal(actual, expected, message) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error((message ?? 'expected') + ' ' + right + ', got ' + left)
}

const disabled = {
  name: 'dsh-univer-office',
  version: '0.6.1',
  enabled: false,
  official: false,
  installed: true,
  rows: [],
}

await check('listBundles keeps installed and rowId members', async () => {
  const env = { services: { get: name => name === 'pluginManager' ? { listBundles: async () => [{ name: 'dsh-univer-office', installed: true, enabled: false, rows: [{ rowId: 'univer-row', moduleName: 'dsh-univer-office' }] }] } : undefined }, now: () => 1 }
  const result = await plugins.listBundles(env, true)
  equal(result.rows.map(row => [row.name, row.installed, row.enabled, row.rows]), [['dsh-univer-office', true, false, ['univer-row']]])
})

await check('installed disabled bundle becomes a switchable row', () => {
  const result = plugins.withInstalledBundles([], [disabled])
  equal(result.plugins.map(row => [row.id, row.name, row.bundleName, row.enabled, row.manageable]), [
    ['bundle:dsh-univer-office', 'dsh-univer-office', 'dsh-univer-office', false, true],
  ])
  equal(disabled.rows, [], 'the cached bundle object must not be mutated')
  equal(result.bundles[0].rows, ['bundle:dsh-univer-office'])
})

await check('a loaded member prevents a duplicate synthetic row', () => {
  const bundle = { ...disabled, rows: ['loaded-member'] }
  const result = plugins.withInstalledBundles([{ id: 'loaded-member', name: 'member' }], [bundle])
  equal(result.plugins.map(row => row.id), ['loaded-member'])
  equal(bundle.rows, ['loaded-member'])
})

await check('an enabled or uninstalled bundle is not synthesized', () => {
  const enabled = { ...disabled, name: 'enabled', enabled: true, rows: [] }
  const missing = { ...disabled, name: 'missing', installed: false, rows: [] }
  equal(plugins.withInstalledBundles([], [enabled, missing]).plugins, [])
})

await check('bundle toggle validates id and self-protection', async () => {
  const calls = []
  const env = { now: () => 1, services: { get: () => ({ listBundles: async () => [{ name: 'other-bundle', installed: true, enabled: false, rows: [] }], setBundleEnabled: async (name, enabled) => { calls.push([name, enabled]); return { application: 'applied' } } }) } }
  const self = await plugins.toggleOne(env, 'plugin', 'bundle:dsh-tool-hub', false, 'dsh-tool-hub').then(() => null, error => error)
  equal(self && self.code, 'self-protected')
  const mismatch = await plugins.toggleOne(env, 'plugin', 'bundle:wrong', true, 'other-bundle').then(() => null, error => error)
  equal(mismatch && mismatch.code, 'bad-bundle')
  const ok = await plugins.toggleOne(env, 'plugin', 'bundle:other-bundle', true, 'other-bundle')
  equal(ok.ok, true)
  equal(calls, [['other-bundle', true]])
})

await check('setBundleEnabled calls the host manager and invalidates', async () => {
  const calls = []
  const env = { services: { get: name => name === 'pluginManager' ? { setBundleEnabled: async (name, enabled) => { calls.push([name, enabled]); return { application: 'applied' } } } : undefined } }
  const result = await plugins.setBundleEnabled(env, 'dsh-univer-office', true)
  equal(calls, [['dsh-univer-office', true]])
  equal(result.ok, true)
  equal(result.id, 'bundle:dsh-univer-office')
})

console.log('\nbundle probe: ' + pass + ' PASS / ' + fail + ' FAIL')
if (fail > 0) process.exit(1)