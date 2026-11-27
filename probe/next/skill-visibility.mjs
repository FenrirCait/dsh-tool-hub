import assert from 'node:assert/strict'
import { SkillVisibilityRegistry } from '../../dist/host/skill-visibility.js'

let passed = 0
async function test(name, fn) { await fn(); passed += 1; console.log('PASS  ' + name) }

await test('no provider is the normal off state', async () => {
  const registry = new SkillVisibilityRegistry()
  assert.deepEqual(await registry.snapshot(), { provider: null, available: false, canSet: false, rows: [], error: null })
})

await test('registered rows are normalized and read-only', async () => {
  const registry = new SkillVisibilityRegistry()
  const off = registry.register({ id: 'fixture', async list() { return [
    { name: 'alpha', hidden: true, modelInvocable: true, source: 'user' },
    { name: 'beta', hidden: false, modelInvocable: false },
    { name: '', hidden: true, modelInvocable: true },
  ] } })
  const row = await registry.snapshot()
  assert.equal(row.provider, 'fixture')
  assert.equal(row.available, true)
  assert.equal(row.canSet, false)
  assert.deepEqual(row.rows, [
    { name: 'alpha', hidden: true, modelInvocable: true, source: 'user' },
    { name: 'beta', hidden: false, modelInvocable: false },
  ])
  off()
  assert.equal((await registry.snapshot()).provider, null)
})

await test('a second provider is rejected, but the same one is idempotent', async () => {
  const registry = new SkillVisibilityRegistry()
  const a = { id: 'a', list() { return [] } }
  const b = { id: 'b', list() { return [] } }
  const off = registry.register(a)
  registry.register(a)
  assert.throws(() => registry.register(b), /already registered/)
  off()
})

await test('a throwing provider becomes an unavailable row, not a failed snapshot', async () => {
  const registry = new SkillVisibilityRegistry()
  registry.register({ id: 'broken', list() { throw new Error('route 500') } })
  const row = await registry.snapshot()
  assert.equal(row.provider, 'broken')
  assert.equal(row.available, false)
  assert.equal(row.error, 'route 500')
  assert.deepEqual(row.rows, [])
})

await test('a hanging provider is cut off instead of holding the snapshot', async () => {
  const registry = new SkillVisibilityRegistry()
  registry.register({ id: 'hang', list: () => new Promise(() => {}) })
  const started = Date.now()
  const row = await registry.snapshot()
  assert.equal(row.available, false)
  assert.match(row.error, /timed out/)
  assert.ok(Date.now() - started < 4500)
})

console.log(passed + '/5 checks passed')