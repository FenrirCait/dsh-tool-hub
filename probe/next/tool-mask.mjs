#!/usr/bin/env node
/**
 * tool-mask: the per-agent restriction lifecycle, driven through fake agent scopes.
 *
 * The fake host reproduces the two traps the 1.x implementation documented: restrict() emits
 * tools/change synchronously (re-entrancy), and restrictableNames arrives later than the deny list
 * (filtering). Every assertion is about the calls the host would actually see.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const { attachToolMask, surfacePort } = await import(pathToFileURL(join(distRoot, 'host', 'tool-mask.js')).href)

let pass = 0
let fail = 0
function check(name, run) {
  try {
    const detail = run()
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

function makeHost({ known = ['mcp__a__x', 'mcp__a__y'], viewThrows = false } = {}) {
  const handlers = new Map()
  const restrictCalls = []
  const warnings = []
  const agents = []
  let undoCount = 0
  const tools = {
    view() {
      if (viewThrows) throw new Error('no view')
      return { knownNames: [...known], restrictableNames: [...known] }
    },
    restrict(request) {
      restrictCalls.push([...request.deny])
      // The real host emits tools/change synchronously; the mask must not recurse.
      for (const callback of handlers.get('tools/change') ?? []) callback({})
      return () => { undoCount += 1 }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'tools') return tools
      if (name === 'agents') return { list: () => agents }
      if (name === 'logger') return { warn: message => warnings.push(message) }
      return undefined
    },
    on(event, callback) {
      const list = handlers.get(event) ?? []
      list.push(callback)
      handlers.set(event, list)
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter(item => item !== callback))
      }
    },
  }
  function addAgent(id, { session = id, parent = undefined } = {}) {
    const disposers = []
    const agent = {
      id,
      session: {
        id: session,
        header: parent === undefined ? undefined : { parentSessionId: parent },
      },
      ctx: {
        plugin(plugin) {
          const scope = {
            tools,
            get: name => ctx.get(name),
            effect(fn) { disposers.push(fn()) },
          }
          plugin.apply(scope)
          return {
            dispose() {
              for (const dispose of disposers.splice(0)) dispose()
            },
          }
        },
      },
    }
    agents.push(agent)
    for (const callback of handlers.get('agent/created') ?? []) callback({ agent })
    return agent
  }
  function removeAgent(agent) {
    const at = agents.indexOf(agent)
    if (at >= 0) agents.splice(at, 1)
    for (const callback of handlers.get('agent/disposed') ?? []) callback({ agent })
  }
  return { ctx, tools, agents, handlers, restrictCalls, warnings, addAgent, removeAgent, undo: () => undoCount, known }
}

check('mount: existing agents get a scope plugin and one restrict', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.addLayer(['mcp__a__x'])
  equal(host.restrictCalls, [['mcp__a__x']])
  return 'mounted ' + mask.info().mounted
})
check('filter: names the host does not restrict yet are dropped', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.addLayer(['mcp__a__x', 'mcp__late__z'])
  equal(host.restrictCalls, [['mcp__a__x']])
})
check('late tool: tools/change re-sync picks the name up', () => {
  const host = makeHost({ known: ['mcp__a__x'] })
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.addLayer(['mcp__a__x', 'mcp__late__z'])
  equal(host.restrictCalls.length, 1)
  host.known.push('mcp__late__z')
  for (const callback of host.handlers.get('tools/change') ?? []) callback({})
  equal(host.restrictCalls.length, 2, 're-restricted')
  equal(host.restrictCalls[1], ['mcp__a__x', 'mcp__late__z'])
})
check('re-entrancy: restrict emits tools/change but the pass does not recurse', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.addLayer(['mcp__a__x'])
  assert(host.restrictCalls.length === 1, 'calls ' + host.restrictCalls.length)
})
check('signature: an unchanged deny list never re-restricts', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.addLayer(['mcp__a__x'])
  mask.syncAll()
  mask.syncAll()
  equal(host.restrictCalls.length, 1)
})
check('layers: lifting one layer keeps the other installed', () => {
  const host = makeHost({ known: ['mcp__a__x', 'mcp__a__y'] })
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  const undo = mask.addLayer(['mcp__a__x'])
  const keep = mask.addLayer(['mcp__a__y'])
  void keep
  undo()
  equal(mask.info().deny, ['mcp__a__y'])
  equal(host.restrictCalls.at(-1), ['mcp__a__y'])
})
check('session overlay: one session adds names, another does not inherit them', () => {
  const host = makeHost()
  const parent = host.addAgent('parent', { session: 's1' })
  void parent
  const mask = attachToolMask(host.ctx, {})
  mask.addLayer(['mcp__a__x'])
  mask.setSessionDeny('s1', ['mcp__a__y'])
  equal(host.restrictCalls.at(-1), ['mcp__a__x', 'mcp__a__y'])
  host.addAgent('other', { session: 's2' })
  equal(host.restrictCalls.at(-1), ['mcp__a__x'])
})
check('lineage: a child session inherits its parent switches', () => {
  const host = makeHost()
  host.addAgent('parent', { session: 's1' })
  const mask = attachToolMask(host.ctx, {})
  mask.addLayer(['mcp__a__x'])
  mask.setSessionDeny('s1', ['mcp__a__y'])
  host.addAgent('child', { session: 's2', parent: 's1' })
  equal(host.restrictCalls.at(-1), ['mcp__a__x', 'mcp__a__y'])
})
check('hydrate: durable session switches apply to the first agent', () => {
  const host = makeHost()
  const mask = attachToolMask(host.ctx, { s1: ['mcp__a__y'] })
  host.addAgent('a1', { session: 's1' })
  mask.addLayer(['mcp__a__x'])
  equal(host.restrictCalls.at(-1), ['mcp__a__x', 'mcp__a__y'])
})
check('empty: clearing both layers and overlays lifts the restriction', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  const undo = mask.addLayer(['mcp__a__x'])
  mask.setSessionDeny('a1', ['mcp__a__y'])
  undo()
  mask.setSessionDeny('a1', [])
  equal(mask.info().deny, [])
  assert(host.undo() >= 1, 'host undo called')
})
check('dispose: unmounting lifts the installed restriction', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.addLayer(['mcp__a__x'])
  mask.dispose()
  assert(host.undo() >= 1, 'undo after dispose')
})
check('no view: reports a problem instead of throwing or lifting the mask', () => {
  const host = makeHost({ viewThrows: true })
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.addLayer(['mcp__a__x'])
  equal(host.restrictCalls, [])
  assert(mask.info().problems.length > 0, 'problem recorded')
})
check('surface port: restrict installs a layer and returns its lift', () => {
  const host = makeHost()
  host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  const port = surfacePort(mask)
  equal(port.known(), ['mcp__a__x', 'mcp__a__y'])
  const undo = port.restrict(['mcp__a__x'])
  equal(host.restrictCalls.at(-1), ['mcp__a__x'])
  undo()
  equal(mask.info().deny, [])
  assert(host.undo() >= 1, 'host undo called')
})
check('agent disposed: its id is forgotten, a recreated id mounts again', () => {
  const host = makeHost()
  const first = host.addAgent('a1')
  const mask = attachToolMask(host.ctx, {})
  mask.addLayer(['mcp__a__x'])
  host.removeAgent(first)
  equal(mask.info().mounted, 0)
  host.addAgent('a1')
  equal(mask.info().mounted, 1)
})

console.log('\ntool-mask probe: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
