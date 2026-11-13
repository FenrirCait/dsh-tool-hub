/**
 * ToolMask probe: a fake host that behaves like the real one in the two ways that matter —
 * `tools.restrict()` emits `tools/change` synchronously, and a restriction only accepts names
 * that are currently restrictable. Getting either wrong turns the host into a spin loop, so
 * this runs with a hard iteration budget.
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
let active = new Set()
let budget = 500

const toolsService = {
  view: () => ({ knownNames: known, restrictableNames: known }),
  restrict({ deny }) {
    if (++restrictCalls > budget) throw new Error('restrict() called in a loop')
    for (const name of deny) {
      if (!known.includes(name)) throw new Error(`not restrictable: ${name}`)
    }
    active = new Set(deny)
    // The real host emits this synchronously inside restrict(); that is the loop risk.
    host.emit('tools/change')
    return () => {
      undoCount += 1
      active = new Set()
      host.emit('tools/change')
    }
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
function makeAgent(id) {
  const mounted = []
  const cleanups = []
  const agent = {
    id,
    ctx: {
      plugin(plugin) {
        mounted.push(plugin)
        // A scoped ctx in the real host is the agent's own context; here it just
        // has to expose the same surface the restriction plugin uses, and to run
        // the effect cleanups when the plugin is disposed.
        const scope = {
          tools: toolsService,
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
check('deny list reaches the host', [...active].join(',') === 'mcp__alpha__two', [...active].join(','))
check('no runaway loop', restrictCalls < 20, `calls=${restrictCalls}`)

host.emit('tools/change')
check('a no-op change does not re-restrict', restrictCalls === 2, `calls=${restrictCalls}`)

// A tool showing up later must not force a re-apply: the signature only covers usable names.
known.push('mcp__alpha__three')
host.emit('tools/change')
check('new unrelated tool keeps the signature stable', restrictCalls === 2, `calls=${restrictCalls}`)

mask.setDeny(['mcp__alpha__one', 'mcp__alpha__two'])
check('setDeny lifts the old mask first', undoCount >= 2, `undos=${undoCount}`)
check('setDeny applies the new list everywhere', restrictCalls === 4 && active.size === 2, `calls=${restrictCalls} active=${[...active].join(',')}`)

mask.setDeny([])
check('empty deny lifts everything', undoCount >= 4 && active.size === 0, `undos=${undoCount} active=${active.size}`)

mask.setDeny(['mcp__gone__x'])
check('unknown names never reach the host', active.size === 0, `active=${active.size}`)

// Dispose must detach listeners and unmount every agent plugin.
mask.dispose()
const before = restrictCalls
host.emit('tools/change')
host.emit('agent/created', { agent: first })
check('disposed mask stops reacting', restrictCalls === before && mask.mounted.size === 0, `calls=${restrictCalls} mounted=${mask.mounted.size}`)

const failed = results.filter(entry => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
