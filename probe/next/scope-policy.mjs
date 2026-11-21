#!/usr/bin/env node
/** The four-layer scope formula, tested directly on the pure module. */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const { agentScopeOf, normalizeWorkspaceKey, workspaceLookupKey, resolveScopedDeny } = await import(pathToFileURL(join(distRoot, 'host', 'scope-policy.js')).href)

let pass = 0
let fail = 0
function check(name, run) {
  try { const detail = run(); pass += 1; console.log('PASS ' + name + (detail === undefined ? '' : '  ' + detail)) }
  catch (error) { fail += 1; console.log('FAIL ' + name + '  ' + (error && error.message ? error.message : String(error))) }
}
function assert(condition, message) { if (!condition) throw new Error(message) }
function equal(actual, expected) {
  const left = JSON.stringify(actual); const right = JSON.stringify(expected)
  if (left !== right) throw new Error('expected ' + right + ', got ' + left)
}
function agent(header, id = 'a1') {
  return { id, session: { id: 's1', header } }
}
function resolve(overrides = {}) {
  return resolveScopedDeny({
    install: [], workspaces: {}, sessionDeny: {}, sessionAllow: {},
    subagentAllow: [], subagentDeny: [], lineage: ['s1'],
    scope: { sessionId: 's1', subagent: false },
    ...overrides,
  })
}

check('scope: origin/delegationDepth mark a subagent, parentSession alone does not', () => {
  equal(agentScopeOf(agent({})).subagent, false)
  equal(agentScopeOf(agent({ parentSessionId: 's0' })).subagent, false)
  equal(agentScopeOf(agent({ origin: 'subagent' })).subagent, true)
  equal(agentScopeOf(agent({ delegationDepth: 2 })).subagent, true)
})
check('scope: cwd is read from the header and requestHeader()', () => {
  equal(agentScopeOf(agent({ cwd: 'C:/work/a' })).cwd, 'C:/work/a')
  const viaFn = { id: 'a2', session: { id: 's2', requestHeader: () => ({ cwd: 'C:/work/b' }) } }
  equal(agentScopeOf(viaFn).cwd, 'C:/work/b')
})
check('workspace: storage normalizes the path, lookup lowercases the drive', () => {
  const stored = normalizeWorkspaceKey('C:/Work/A/')
  assert(stored !== '' && !stored.endsWith('/') && !stored.endsWith('\\'), 'normalized: ' + stored)
  equal(workspaceLookupKey('C:/Work/A'), workspaceLookupKey('c:/Work/A'))
  equal(workspaceLookupKey(stored)[0], 'c')
})
check('E1: session allow can release an installation deny', () => {
  const out = resolve({ install: ['x'], sessionAllow: { s1: ['x'] } })
  equal(out.deny, [])
  equal(out.layers.install, ['x'])
})
check('E2: workspace deny applies by exact cwd; session allow subtracts it', () => {
  const out = resolve({
    workspaces: { 'C:/p': ['y'] }, sessionDeny: { s1: ['z'] }, sessionAllow: { s1: ['y'] },
    scope: { sessionId: 's1', cwd: 'c:/p', subagent: false },
  })
  equal(out.deny, ['z'])
  equal(out.workspaceKey, 'C:/p')
  const missing = resolve({ workspaces: { 'C:/p': ['y'] }, scope: { sessionId: 's1', cwd: 'C:/other' } })
  equal(missing.deny, [])
  equal(missing.workspaceKey, null)
})
check('E3: subagent deny wins over a session allow, subagent allow is subtracted first', () => {
  const base = { install: ['x'], sessionAllow: { s1: ['x'] } }
  const normal = resolve({ ...base, scope: { sessionId: 's1', subagent: false } })
  equal(normal.deny, [])
  const child = resolve({ ...base, subagentDeny: ['x'], scope: { sessionId: 's1', subagent: true } })
  equal(child.deny, ['x'])
  const allowed = resolve({ install: ['x', 'y'], subagentAllow: ['x'], scope: { sessionId: 's1', subagent: true } })
  equal(allowed.deny, ['y'])
})
check('E4: a fork (parentSession, no origin) gets no subagent layers', () => {
  const scope = agentScopeOf(agent({ parentSessionId: 's0' }))
  const out = resolve({ install: ['x'], subagentDeny: ['x'], scope })
  equal(out.deny, ['x'])
  equal(out.layers.subagentDeny, [])
  equal(out.subagent, false)
})
check('E5: lineage allow is unioned like deny (parent releases for child)', () => {
  const out = resolve({ install: ['x'], sessionAllow: { s0: ['x'] }, lineage: ['s1', 's0'] })
  equal(out.deny, [])
})
check('signature input: two agents in different workspaces resolve differently', () => {
  const workspaces = { 'C:/a': ['x'], 'C:/b': ['y'] }
  const a = resolve({ workspaces, scope: { sessionId: 's1', cwd: 'C:/a' } })
  const b = resolve({ workspaces, scope: { sessionId: 's1', cwd: 'C:/b' } })
  equal([a.deny, b.deny], [['x'], ['y']])
})
check('layers: the report names every contributing list', () => {
  const out = resolve({ install: ['i'], workspaces: { 'C:/p': ['w'] }, sessionDeny: { s1: ['d'] }, sessionAllow: { s1: ['i'] }, scope: { sessionId: 's1', cwd: 'C:/p' } })
  equal(out.layers.install, ['i'])
  equal(out.layers.workspace, ['w'])
  equal(out.layers.sessionDeny, ['d'])
  equal(out.layers.sessionAllow, ['i'])
  equal(out.deny, ['d', 'w'])
})

console.log('\nscope-policy probe: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
