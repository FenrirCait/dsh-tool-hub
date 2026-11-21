#!/usr/bin/env node
/** G5: the switch engine, /tools parsing and the tool_switch shape. */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const sessions = await import(pathToFileURL(join(distRoot, 'domains', 'sessions.js')).href)
const commands = await import(pathToFileURL(join(distRoot, 'host', 'commands.js')).href)
const switchTool = await import(pathToFileURL(join(distRoot, 'host', 'switch-tool.js')).href)
const entrypoints = await import(pathToFileURL(join(distRoot, 'host', 'entrypoints.js')).href)

let pass = 0
let fail = 0
async function check(name, run) {
  try { const detail = await run(); pass += 1; console.log('PASS ' + name + (detail === undefined ? '' : '  ' + detail)) }
  catch (error) { fail += 1; console.log('FAIL ' + name + '  ' + (error && error.message ? error.message : String(error))) }
}
function assert(condition, message) { if (!condition) throw new Error(message) }
function equal(actual, expected) {
  const left = JSON.stringify(actual); const right = JSON.stringify(expected)
  if (left !== right) throw new Error('expected ' + right + ', got ' + left)
}
const known = ['mcp__a__x', 'mcp__a__y', 'pwsh', 'run_code', 'tool_switch', 'tool_list']
const restrictable = new Set(known)
const groups = [{ name: 'Alpha', tools: ['mcp__a__x', 'mcp__a__y'] }]
function state() { return { sessions: {} } }

await check('parse: empty is list, bare target is off, "all on" is on/all', () => {
  equal(commands.parseToolsInput(''), { action: 'list' })
  equal(commands.parseToolsInput('off mcp__a__x'), { action: 'off', target: 'mcp__a__x' })
  equal(commands.parseToolsInput('pwsh'), { action: 'off', target: 'pwsh' })
  equal(commands.parseToolsInput('all on'), { action: 'on', target: 'all' })
  equal(commands.parseToolsInput('reset'), { action: 'reset' })
})
await check('targets: exact, group name (case-insensitive), prefix, all; reserved names dropped', () => {
  equal(sessions.resolveSwitchTargets(known, restrictable, groups, 'mcp__a__x'), { names: ['mcp__a__x'], label: 'mcp__a__x' })
  equal(sessions.resolveSwitchTargets(known, restrictable, groups, 'alpha'), { names: ['mcp__a__x', 'mcp__a__y'], label: 'Alpha' })
  equal(sessions.resolveSwitchTargets(known, restrictable, groups, 'mcp__a'), { names: ['mcp__a__x', 'mcp__a__y'], label: 'mcp__a*' })
  equal(sessions.resolveSwitchTargets(known, restrictable, groups, 'all').names, ['mcp__a__x', 'mcp__a__y', 'pwsh'])
  assert(sessions.resolveSwitchTargets(known, restrictable, groups, 'run_code').error !== undefined, 'reserved must not resolve')
})
await check('apply: off adds, on removes, reset clears, empty removes the key', () => {
  const s = state()
  const off = sessions.applySessionSwitch(s, 's1', 'off', 'mcp__a__x', known, restrictable, groups)
  equal(off.names, ['mcp__a__x'])
  const again = sessions.applySessionSwitch(s, 's1', 'off', 'mcp__a__x', known, restrictable, groups)
  equal(again.changed, false)
  const on = sessions.applySessionSwitch(s, 's1', 'on', 'mcp__a__x', known, restrictable, groups)
  equal(on.names, [])
  assert(s.sessions.s1 === undefined, 'empty overlay must be removed')
  sessions.applySessionSwitch(s, 's1', 'off', 'all', known, restrictable, groups)
  const reset = sessions.applySessionSwitch(s, 's1', 'reset', undefined, known, restrictable, groups)
  equal(reset.names, [])
  assert(s.sessions.s1 === undefined, 'reset removes the key')
})
await check('apply: one unknown part fails the whole call and writes nothing', () => {
  const s = state()
  const result = sessions.applySessionSwitch(s, 's1', 'off', 'mcp__a__x nope', known, restrictable, groups)
  assert(result.ok === false, 'must fail')
  assert(s.sessions.s1 === undefined, 'must not write')
})
await check('counts: total excludes reserved, fixed counts un-restrictable names, missing is reported', () => {
  const s = state()
  s.sessions.s1 = ['mcp__a__x', 'gone__tool']
  const counts = sessions.sessionCounts(s, 's1', known, new Set(['mcp__a__x', 'mcp__a__y', 'pwsh']))
  equal(counts.total, 3)
  equal(counts.disabled, 1)
  equal(counts.fixed, 3)
  equal(counts.missing, ['gone__tool'])
  equal(counts.mode, 'custom')
})
await check('counts: all switchable off reports mode all', () => {
  const s = state()
  s.sessions.s1 = ['mcp__a__x', 'mcp__a__y', 'pwsh']
  const counts = sessions.sessionCounts(s, 's1', known, new Set(['mcp__a__x', 'mcp__a__y', 'pwsh']))
  equal(counts.mode, 'all')
})
await check('command: input hint and handler shape', async () => {
  let registered = null
  const ctx = { inject: (_services, cb) => cb({ commands: { register: def => { registered = def } }, effect: fn => fn() }) }
  commands.installToolsCommand(ctx, async (op, payload) => ({ ok: true, message: op + ':' + payload.action }))
  assert(registered !== null, 'not registered')
  equal(registered.input.hint, '[list|off|on|reset] [group|tool|prefix|all]')
  const out = await registered.handler({ agent: { session: { id: 's1' } }, rawInput: 'off pwsh' })
  equal(out, { kind: 'success', text: 'session.switch:off' })
})
await check('tool_switch: schema, missing agent, render message', async () => {
  const tool = switchTool.createSwitchTool(async () => ({ ok: true, message: 'switched', counts: { enabled: 2, total: 3 } }))
  equal(tool.name, 'tool_switch')
  equal(tool.parameters.action.enum, ['list', 'off', 'on', 'reset'])
  const missing = await tool.execute({ action: 'list' })
  equal(missing.ok, false)
  const ok = await tool.execute({ action: 'off', target: 'pwsh' }, { agent: { session: { id: 's1' } } })
  equal(ok.ok, true)
  equal(tool.output.render({}, ok)[0].text, 'switched')
})
await check('entrypoints: registers /tools and tool_switch through inject', async () => {
  const registered = []
  const ctx = {
    inject: (services, cb) => cb({
      commands: { register: def => registered.push(def.name) },
      tools: { register: def => registered.push(def.name) },
      effect: fn => fn(),
    }),
    logger: { warn: () => {} },
  }
  entrypoints.installEntryPoints(ctx, async () => ({ ok: true, message: 'ok' }))
  assert(registered.includes('tools'), 'the /tools command must register')
  assert(registered.includes('tool_switch'), 'tool_switch must register')
  const duplicate = { inject: (_s, cb) => cb({ tools: { register: () => { throw new Error('duplicate') } }, effect: fn => fn() }), logger: { warn: () => {} } }
  entrypoints.installEntryPoints(duplicate, async () => ({}))
})
console.log('\ntool-switch probe: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
