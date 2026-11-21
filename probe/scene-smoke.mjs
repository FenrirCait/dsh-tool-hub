/**
 * Scene engine probe: the sequence, not the plumbing.
 *
 * Every write goes through a fake `io`, which is what makes the interesting cases reachable —
 * a server that refuses to come back, a tool write that throws halfway, a restore that only
 * half succeeds. The engine's job is to keep the state consistent and to say exactly what is
 * still wrong; those are the assertions.
 */
import {
  SCENE_VERSION,
  normalizeScene,
  captureSnapshot,
  planFromScene,
  planFromSnapshot,
  restoreSnapshot,
  runScene,
  describePlan,
} from '../lib/scene-engine.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const rows = [
  { id: 'entry-a', serverName: 'alpha', disabled: false },
  { id: 'entry-b', serverName: 'beta', disabled: true },
]

/**
 * A fake io with two kinds of fault: `failOn` is permanent (the server is simply broken),
 * `failOnce` fires a single time — which is what a transient host failure looks like, and the
 * difference decides whether a rollback can finish.
 */
function makeIo({ failOn, failOnce } = {}) {
  const calls = []
  const state = { tools: null, servers: new Map(), mode: null, cleared: 0 }
  let once = failOnce
  const fault = key => {
    if (failOn === key) return true
    if (once === key) {
      once = null
      return true
    }
    return false
  }
  return {
    calls,
    state,
    io: {
      async writeMode(mode) {
        calls.push(['mode', mode.name])
        state.mode = mode
      },
      async clearMode() {
        calls.push(['clear'])
        state.mode = null
        state.cleared += 1
      },
      async setTools(deny) {
        calls.push(['tools', deny.join(',')])
        if (fault('tools')) throw new Error('tool write refused')
        state.tools = [...deny]
      },
      async setServer(entry) {
        calls.push(['server', entry.serverName, entry.enabled])
        if (fault(`server:${entry.serverName}`)) throw new Error(`${entry.serverName} refused`)
        state.servers.set(entry.serverName, entry.enabled)
      },
    },
  }
}

// ── 1. normalization ────────────────────────────────────────────────────────
{
  check('a scene needs a name', normalizeScene({ tools: { deny: [] } }) === null)
  const scene = normalizeScene({ name: '  work  ', tools: { deny: ['mcp__a__x', 'not_a_tool', 'mcp__a__x'] }, mcp: { off: ['alpha', 'bad name', 'alpha'], on: ['beta'] } })
  check('normalize trims the name', scene?.name === 'work', scene?.name)
  check('normalize keeps maskable names, deduplicated', JSON.stringify(scene?.tools?.deny) === '["mcp__a__x","not_a_tool"]', JSON.stringify(scene?.tools?.deny))
  check('normalize drops illegal server names', JSON.stringify(scene?.mcp) === '{"off":["alpha"],"on":["beta"]}', JSON.stringify(scene?.mcp))
  check('a missing section stays undefined', normalizeScene({ name: 'quiet' })?.tools === undefined && normalizeScene({ name: 'quiet' })?.mcp === undefined)
  check('an explicitly empty section stays empty', JSON.stringify(normalizeScene({ name: 'clear', tools: { deny: [] } })?.tools) === '{"deny":[]}')
  check('version is stamped', scene?.version === SCENE_VERSION)
}

// ── 2. snapshots ────────────────────────────────────────────────────────────
const snapshot = captureSnapshot({ toolDeny: ['mcp__a__x'], sessions: { s1: ['mcp__a__y'] }, mcpRows: rows, at: 111 })
{
  check('snapshot records both domains', JSON.stringify(snapshot.toolDeny) === '["mcp__a__x"]' && snapshot.mcp.alpha?.enabled === true && snapshot.mcp.beta?.enabled === false, JSON.stringify(snapshot.mcp))
  check('snapshot keeps a copy of the session overlays', JSON.stringify(snapshot.sessions) === '{"s1":["mcp__a__y"]}', JSON.stringify(snapshot.sessions))
  const restorePlan = planFromSnapshot(snapshot)
  check('the restore plan turns beta back on, because the snapshot found it off', restorePlan.mcp.find(entry => entry.serverName === 'beta')?.enabled === false && restorePlan.mcp.find(entry => entry.serverName === 'alpha')?.enabled === true, JSON.stringify(restorePlan.mcp))
}

// ── 3. empty-section semantics ──────────────────────────────────────────────
{
  const quiet = normalizeScene({ name: 'quiet' })
  const quietPlan = planFromScene(quiet, snapshot)
  check('a scene without a tools section leaves tools alone', quietPlan.tools === null, JSON.stringify(quietPlan.tools))
  const clear = normalizeScene({ name: 'clear', tools: { deny: [] } })
  check('a scene with an empty deny list clears the mask', JSON.stringify(planFromScene(clear, snapshot).tools) === '{"deny":[]}')
  const partial = normalizeScene({ name: 'partial', mcp: { off: ['alpha'] } })
  check('only the named servers are planned', planFromScene(partial, snapshot).mcp.length === 1 && planFromScene(partial, snapshot).mcp[0].enabled === false)
  const unknown = normalizeScene({ name: 'unknown', mcp: { off: ['ghost'] } })
  const unknownPlan = planFromScene(unknown, snapshot)
  check('a server that is not installed is reported missing, not planned', unknownPlan.mcp.length === 0 && unknownPlan.missing.join(',') === 'ghost', JSON.stringify(unknownPlan.missing))
}

// ── 4. applying ─────────────────────────────────────────────────────────────
{
  const scene = normalizeScene({ name: 'work', tools: { deny: ['mcp__a__x'] }, mcp: { off: ['alpha'], on: ['beta'] } })
  const fake = makeIo()
  const run = await runScene({ scene, snapshot, io: fake.io })
  check('apply succeeds end to end', run.ok === true && run.applied.length === 3, JSON.stringify(run.applied))
  check('intent is recorded before any state change', fake.calls[0][0] === 'mode' && fake.calls[0][1] === 'work', JSON.stringify(fake.calls.slice(0, 2)))
  check('both servers moved', fake.state.servers.get('alpha') === false && fake.state.servers.get('beta') === true, JSON.stringify([...fake.state.servers]))
  check('tools were written once', fake.state.tools !== null && fake.state.tools.join(',') === 'mcp__a__x', JSON.stringify(fake.state.tools))
  check('a clean apply leaves the mode record in place', fake.state.mode?.name === 'work' && fake.state.cleared === 0)
  check('describePlan names what will change', /servers off: alpha/.test(describePlan(run.plan)) && /servers on: beta/.test(describePlan(run.plan)), describePlan(run.plan))
}

// ── 5. failure halfway, then restore ────────────────────────────────────────
{
  const scene = normalizeScene({ name: 'work', tools: { deny: [] }, mcp: { off: ['alpha'], on: ['beta'] } })
  const fake = makeIo({ failOnce: 'server:beta' })
  const run = await runScene({ scene, snapshot, io: fake.io })
  check('a refused server fails the apply', run.ok === false && /beta refused/.test(run.error ?? ''), run.error)
  check('the rollback puts both domains back', run.rollback?.ok === true && fake.state.tools.join(',') === 'mcp__a__x' && fake.state.servers.get('alpha') === true, JSON.stringify([...fake.state.servers]))
  check('a failed apply clears the mode record', fake.state.mode === null && fake.state.cleared === 1)
  check('the rollback report lists what it restored', (run.rollback?.restored ?? []).includes('tools') && (run.rollback?.restored ?? []).includes('mcp:beta'), JSON.stringify(run.rollback?.restored))
}

// ── 6. a restore that itself fails says so ──────────────────────────────────
{
  const fake = makeIo({ failOn: 'server:alpha' })
  const report = await restoreSnapshot(snapshot, fake.io)
  check('a partial restore is not ok', report.ok === false)
  check('the incomplete list names the target', report.incomplete.length === 1 && report.incomplete[0].target === 'mcp:alpha', JSON.stringify(report.incomplete))
  check('the message says rollback is incomplete', /rollback incomplete/.test(report.message), report.message)
  check('the tools domain still reports as restored', report.restored.includes('tools'), JSON.stringify(report.restored))
}

// ── 7. exit and idempotency ─────────────────────────────────────────────────
{
  const fake = makeIo()
  const first = await runScene({ snapshot, io: fake.io, restoreOnly: true })
  check('restore-only succeeds', first.ok === true)
  check('restore-only clears the mode record', fake.state.mode === null && fake.state.cleared === 1)
  const second = await runScene({ snapshot, io: fake.io, restoreOnly: true })
  check('running the restore twice changes nothing extra', second.ok === true && fake.state.cleared === 2 && fake.state.tools.join(',') === 'mcp__a__x')
}

const failed = results.filter(entry => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
