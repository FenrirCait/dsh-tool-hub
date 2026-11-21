#!/usr/bin/env node
/** G5 client surface: composer dock registration, badge rules, package inject. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8')
const entry = read('src/client/entry.tsx')
const dock = read('src/client/dock.tsx')
const pkg = JSON.parse(read('package.json'))
let pass = 0
let fail = 0
function check(name, run) {
  try { const detail = run(); pass += 1; console.log('PASS ' + name + (detail === undefined ? '' : '  ' + detail)) }
  catch (error) { fail += 1; console.log('FAIL ' + name + '  ' + (error && error.message ? error.message : String(error))) }
}
function assert(condition, message) { if (!condition) throw new Error(message) }

check('slot: conversation.composer.dock at order 40', () => {
  assert(/DOCK_SLOT = 'conversation\.composer\.dock'/.test(dock), 'slot constant')
  assert(/DOCK_ORDER = 40/.test(dock), 'order')
  assert(/ctx\.slots\.inject\(DOCK_SLOT/.test(entry), 'entry must inject the dock slot')
})
check('register: locale + sessionId inject + openPanel', () => {
  assert(/inject: \(sessionId: string\) => \(\{ sessionId \}\)/.test(entry), 'sessionId inject')
  assert(/locale: NS/.test(entry), 'locale NS')
  assert(/onOpen: openPanel/.test(entry), 'open action')
  assert(/selectPanel\(NS\)/.test(entry), 'opens the panel key')
})
check('summary: one read on mount, no polling', () => {
  assert(/runOp\('session\.summary'/.test(dock), 'summary read')
  assert(!/setInterval|setTimeout/.test(dock), 'no timer')
  assert(/\[sessionId\]/.test(dock), 're-reads when the session changes')
})
check('badge: only custom sessions with disabled tools show a count', () => {
  assert(/mode === 'custom' && summary\.disabled > 0/.test(dock), 'badge condition')
  assert(/t\('dock\.off'/.test(dock), 'badge label key')
})
check('hide: no session id renders nothing', () => {
  assert(/if \(typeof sessionId !== 'string' \|\| sessionId === ''\) return null/.test(dock), 'null without session')
})
check('package: client injects ui-conversation and loads immediately', () => {
  assert(Array.isArray(pkg.dsh?.client?.inject), 'inject array')
  assert(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'), 'ui-conversation inject')
  assert(pkg.dsh.client.immediately === true, 'immediately true')
})
check('size: dock stays a small component', () => {
  assert(dock.split('\n').length < 150, 'dock lines')
})
console.log('\nclient-dock probe: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
