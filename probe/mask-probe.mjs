/**
 * ToolMask probe: a fake host that behaves like the real one in the ways that matter —
 * `tools.restrict()` emits `tools/change` synchronously, restrictions **stack** (the host
 * intersects them), a restriction only accepts names that are currently restrictable, and a
 * failed `restrict()` leaves whatever is already installed untouched. Getting the first one
 * wrong turns the host into a spin loop; getting the last one wrong turns a failed re-apply
 * into a silently unmasked agent.
 */
import { attachToolMask, splitToolName } from '../lib/tool-filter.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const known = ['mcp__alpha__one', 'mcp__alpha__two', 'read_file']
let restrictCalls = 0
let undoCount = 0
let failMode = false
let layerSeq = 0
const layers = new Map()
const events = []
let budget = 500

const activeNow = () => {
  const out = new Set()
  for (const layer of layers.values()) for (const name of layer.names) out.add(name)
  return out
}

/** What one agent is actually restricted by: the union of the layers its own scope installed. */
const activeFor = owner => {
  const out = new Set()
  for (const layer of layers.values()) {
    if (layer.owner !== owner) continue
    for (const name of layer.names) out.add(name)
  }
  return out
}

const toolsService = {
  view: () => ({ knownNames: known, restrictableNames: known }),
  restrictFor(owner, { deny }) {
    if (++restrictCalls > budget) throw new Error('restrict() called in a loop')
    if (failMode) {
      events.push('restrict-failed')
      throw new Error('host refused the mask')
    }
    for (const name of deny) {
      if (!known.includes(name)) throw new Error(`not restrictable: ${name}`)
    }
    const id = ++layerSeq
    layers.set(id, { names: new Set(deny), owner })
    events.push('restrict')
    // The real host emits this synchronously inside restrict(); that is the loop risk.
    host.emit('tools/change')
    return () => {
      undoCount += 1
      layers.delete(id)
      events.push('undo')
      host.emit('tools/change')
    }
  },
  // Kept for the paths that mount without an owner (there are none today, but a probe should
  // fail loudly rather than silently attribute a layer to the wrong agent).
  restrict(args) {
    return this.restrictFor('global', args)
  },
}

const listeners = new Map()
const host = {
  get(name) {
    if (name === 'tools') return toolsService
    if (name === 'agents') return { list: () => [...agents] }
    return undefined
  },
  on(event, fn) {
    const list = listeners.get(event) ?? []
    list.push(fn)
    listeners.set(event, list)
    return () => {
      const now = listeners.get(event) ?? []
      listeners.set(event, now.filter(entry => entry !== fn))
    }
  },
  emit(event, payload = {}) {
    for (const fn of listeners.get(event) ?? []) fn(payload)
  },
  effect(fn) {
    const off = fn()
    return typeof off === 'function' ? off : () => {}
  },
}

const agents = []
function makeAgent(id, { sessionId = id, parentSession } = {}) {
  const mounted = []
  const cleanups = []
  const header = parentSession === undefined ? {} : { parentSession }
  const agent = {
    id,
    session: {
      id: sessionId,
      requestHeader: () => header,
    },
    ctx: {
      plugin(plugin) {
        mounted.push(plugin)
        // A scoped ctx in the real host is the agent's own context; here it just
        // has to expose the same surface the restriction plugin uses, and to run
        // the effect cleanups when the plugin is disposed.
        const scope = {
          // Owner-tagged so the assertions can tell one agent's layer from another's.
          tools: { view: toolsService.view, restrict: args => toolsService.restrictFor(id, args) },
          effect(fn) {
            const off = fn()
            if (typeof off === 'function') cleanups.push(off)
            return typeof off === 'function' ? off : () => {}
          },
        }
        plugin.apply(scope)
        return {
          dispose: () => {
            mounted.pop()
            for (const off of cleanups.splice(0)) off()
          },
        }
      },
    },
    mounted,
  }
  return agent
}

const mask = attachToolMask(host, ['mcp__alpha__two'])
check('splitToolName parses a full name', JSON.stringify(splitToolName('mcp__alpha__one')) === '{"server":"alpha","tool":"one"}')

const first = makeAgent('a1')
agents.push(first)
host.emit('agent/created', { agent: first })
// attachToolMask seeds existing agents; creation of new ones goes through the event.
const second = makeAgent('a2')
agents.push(second)
host.emit('agent/created', { agent: second })

check('mask mounted once per agent', mask.mounted.size === 2, `mounted=${mask.mounted.size}`)
check('restriction applied on each agent', restrictCalls === 2, `calls=${restrictCalls}`)
check('deny list reaches the host', [...activeNow()].join(',') === 'mcp__alpha__two', [...activeNow()].join(','))
check('no runaway loop', restrictCalls < 20, `calls=${restrictCalls}`)

host.emit('tools/change')
check('a no-op change does not re-restrict', restrictCalls === 2, `calls=${restrictCalls}`)

// A tool showing up later must not force a re-apply: the signature only covers usable names.
known.push('mcp__alpha__three')
host.emit('tools/change')
check('new unrelated tool keeps the signature stable', restrictCalls === 2, `calls=${restrictCalls}`)

mask.setDeny(['mcp__alpha__one', 'mcp__alpha__two'])
check('setDeny lifts the old mask', undoCount >= 2, `undos=${undoCount}`)
check('setDeny applies the new list everywhere', restrictCalls === 4 && activeNow().size === 2, `calls=${restrictCalls} active=${[...activeNow()].join(',')}`)

mask.setDeny([])
check('empty deny lifts everything', undoCount >= 4 && activeNow().size === 0, `undos=${undoCount} active=${activeNow().size}`)

mask.setDeny(['mcp__gone__x'])
check('unknown names never reach the host', activeNow().size === 0, `active=${activeNow().size}`)

// --- session overlays and lineage ------------------------------------------------------
// a1 and a2 are separate sessions; a3 is a subagent whose parent session is a1's.
mask.setDeny(['mcp__alpha__two'])
const third = makeAgent('a3', { sessionId: 'sub-1', parentSession: 'a1' })
agents.push(third)
host.emit('agent/created', { agent: third })
check('a subagent mounts like any other agent', mask.mounted.size === 3, `mounted=${mask.mounted.size}`)

mask.setSessionDeny('a1', ['mcp__alpha__one'])
check('a session overlay reaches its own agent',
  [...activeFor('a1')].sort().join(',') === 'mcp__alpha__one,mcp__alpha__two',
  [...activeFor('a1')].sort().join(','))
check('a session overlay does not touch another session',
  [...activeFor('a2')].join(',') === 'mcp__alpha__two',
  [...activeFor('a2')].join(','))
check('a subagent inherits the overlay of its parent session',
  [...activeFor('a3')].sort().join(',') === 'mcp__alpha__one,mcp__alpha__two',
  [...activeFor('a3')].sort().join(','))
check('the mask reports the overlay it holds',
  mask.info().sessions.some(row => row.sessionId === 'a1' && row.deny.includes('mcp__alpha__one')),
  JSON.stringify(mask.info().sessions))

mask.setSessionDeny('a1', [])
check('clearing an overlay lifts it along the whole lineage',
  [...activeFor('a1')].join(',') === 'mcp__alpha__two' && [...activeFor('a3')].join(',') === 'mcp__alpha__two',
  `${[...activeFor('a1')].join(',')} | ${[...activeFor('a3')].join(',')}`)
check('an empty overlay is dropped from the report', mask.info().sessions.length === 0, JSON.stringify(mask.info().sessions))

// --- the install-before-lift fix -------------------------------------------------------
// Re-mount a two-name mask, then narrow the host view so the usable subset changes. The new
// layer has to land before the old one is lifted: a failed install must leave a mask in place.
mask.setDeny(['mcp__alpha__one', 'mcp__alpha__two'])
check('two names installed before the ordering test', activeNow().size === 2, `active=${[...activeNow()].join(',')}`)

const swapBefore = restrictCalls
const swapUndos = undoCount
events.length = 0
known.length = 0
known.push('mcp__alpha__two', 'read_file') // alpha__one disappears from the host view
host.emit('tools/change')

const restrikes = events.map((event, index) => (event === 'restrict' ? index : -1)).filter(index => index >= 0)
const undos = events.map((event, index) => (event === 'undo' ? index : -1)).filter(index => index >= 0)
// A layer can only be lifted after it was installed: at no point may the undo count run ahead
// of the install count. The old code lifted first, which this prefix walk catches immediately.
let live = 0
let orderingHolds = true
for (const event of events) {
  if (event === 'restrict') live += 1
  if (event === 'restrict-failed') continue
  if (event === 'undo') {
    live -= 1
    if (live < 0) orderingHolds = false
  }
}
check('a narrowed view re-installs the mask', restrictCalls === swapBefore + mask.mounted.size, `calls=${restrictCalls} before=${swapBefore}`)
check('every install lands before its lift', orderingHolds && restrikes.length > 0 && undos.length > 0, events.join(','))
check('exactly one layer survives per agent', layers.size === mask.mounted.size, `layers=${layers.size} undos=${undoCount - swapUndos}`)
check('the narrowed list is what stays', [...activeNow()].join(',') === 'mcp__alpha__two', [...activeNow()].join(','))

// A host that refuses the next install must not cost us the mask we already have.
failMode = true
known.push('mcp__alpha__one')
host.emit('tools/change')
check('a refused install keeps the old mask', layers.size === mask.mounted.size && [...activeNow()].join(',') === 'mcp__alpha__two', `layers=${layers.size} active=${[...activeNow()].join(',')}`)
check('the refused attempt was reported, not swallowed', events.includes('restrict-failed'), events.join(','))

// `applied` still describes what is live, so the next pass retries and succeeds.
failMode = false
host.emit('tools/change')
check('the next pass retries and succeeds', [...activeNow()].sort().join(',') === 'mcp__alpha__one,mcp__alpha__two', [...activeNow()].join(','))

// Dispose must detach listeners and unmount every agent plugin.
mask.dispose()
const before = restrictCalls
host.emit('tools/change')
host.emit('agent/created', { agent: first })
check('disposed mask stops reacting', restrictCalls === before && mask.mounted.size === 0, `calls=${restrictCalls} mounted=${mask.mounted.size}`)

const failed = results.filter(entry => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
