/**
 * Mount heartbeat probe: the contract `doctor` relies on when it decides whether this plugin is
 * mounted. The interesting cases are all failures — a heartbeat that lies (wrong pid, drifted
 * host start, missing inject) must turn red, and a broken or absent file must produce a reason
 * instead of an exception, because doctor has to keep reporting its other checks.
 *
 * Everything runs in a private temp directory and is removed at the end.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  diagnoseMount,
  heartbeatPath,
  readMountHeartbeat,
  writeMountHeartbeat,
} from '../lib/mount-heartbeat.js'

const results = []
const pass = (name, detail = '') => {
  results.push({ name, ok: true })
  console.log(`PASS  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}
const fail = (name, detail = '') => {
  results.push({ name, ok: false })
  console.log(`FAIL  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}
const check = (name, ok, detail = '') => (ok ? pass(name, detail) : fail(name, detail))

const INJ = ['tools', 'systemPrompt', 'webServer']
// Explicit clocks keep the assertions deterministic: the module must not depend on "now".
const NOW = Date.now()
const HOST = NOW - 60_000
const root = mkdtempSync(join(tmpdir(), 'dsh-tool-hub-mount-'))

try {
  // ── the happy path ────────────────────────────────────────────────────────
  // The state directory does not exist yet: apply() runs before anything else creates it.
  const stateDir = join(root, 'state')
  check('heartbeatPath is <stateDir>/mount.json', heartbeatPath(stateDir) === join(stateDir, 'mount.json'), heartbeatPath(stateDir))

  const written = writeMountHeartbeat({ stateDir, pid: process.pid, hostStartedAt: HOST, injects: INJ, now: NOW })
  const file = written.file
  check('write creates a missing state directory', existsSync(file), file)

  const back = readMountHeartbeat(stateDir)
  const data = back.ok ? back.data : {}
  check('a written heartbeat reads back', back.ok === true, back.ok ? '' : back.reason)
  check(
    'all fields survive the round trip',
    data.version === 1
      && data.pid === process.pid
      && data.hostStartedAt === HOST
      && data.writtenAt === NOW
      && JSON.stringify(data.injects) === JSON.stringify(INJ),
    JSON.stringify(data),
  )

  const green = diagnoseMount({ file, pid: process.pid, hostStartedAt: HOST, expectedInjects: INJ, now: NOW + 1000 })
  check('a fresh heartbeat for this process is green', green.ok === true, green.problems.join('; '))
  check('green facts are filled in', green.facts.pid === process.pid && green.facts.ageMs === 1000 && green.facts.injects.length === 3, JSON.stringify(green.facts))

  // ── the decisive failures ─────────────────────────────────────────────────
  const wrongPid = diagnoseMount({ file, pid: process.pid + 1, hostStartedAt: HOST, expectedInjects: INJ, now: NOW })
  check('a heartbeat from another pid is red', wrongPid.ok === false && wrongPid.problems.some(p => p.includes('heartbeat belongs to pid')), wrongPid.problems.join('; '))

  // Same process, host restarted a minute later: this boot wrote nothing, so the plugin is not mounted.
  const drift = diagnoseMount({ file, pid: process.pid, hostStartedAt: HOST + 60_000, expectedInjects: INJ, now: NOW + 60_000 })
  check('a drifted host start time is red', drift.ok === false && drift.problems.includes('host start time drifted'), drift.problems.join('; '))

  const missing = diagnoseMount({ file, pid: process.pid, hostStartedAt: HOST, expectedInjects: [...INJ, 'fakeService'], now: NOW })
  check(
    'a missing inject is red and names the service',
    missing.ok === false && missing.problems.includes('missing inject: fakeService') && missing.problems.length === 1,
    missing.problems.join('; '),
  )

  // ── broken or absent files must not throw ─────────────────────────────────
  const absent = readMountHeartbeat(join(root, 'never-written'))
  check('a missing file reports no heartbeat file', absent.ok === false && absent.reason === 'no heartbeat file', absent.reason)

  const absentDiag = diagnoseMount({ file: join(root, 'never-written', 'mount.json'), pid: process.pid, hostStartedAt: HOST, expectedInjects: INJ, now: NOW })
  check(
    'diagnose on a missing file is red with empty facts',
    absentDiag.ok === false && absentDiag.problems[0] === 'no heartbeat file' && absentDiag.facts.pid === null,
    absentDiag.problems.join('; '),
  )

  const brokenDir = join(root, 'broken')
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(heartbeatPath(brokenDir), '{ "version": 1, "pid":', 'utf8')
  let broke = null
  let threw = false
  try {
    broke = readMountHeartbeat(brokenDir)
  } catch (error) {
    threw = true
    broke = { reason: String(error?.message ?? error) }
  }
  check('bad json is red and never throws', threw === false && broke.ok === false && broke.reason.startsWith('bad heartbeat json'), broke.reason)

  // A shape error (a field dropped by a future writer) is a reason, not a crash.
  const shapeDir = join(root, 'shape')
  mkdirSync(shapeDir, { recursive: true })
  writeFileSync(heartbeatPath(shapeDir), JSON.stringify({ version: 1, pid: process.pid, writtenAt: NOW }), 'utf8')
  const shape = readMountHeartbeat(shapeDir)
  check('missing fields are red with the field named', shape.ok === false && shape.reason.includes('hostStartedAt'), shape.reason)

  const v2Dir = join(root, 'v2')
  mkdirSync(v2Dir, { recursive: true })
  writeFileSync(heartbeatPath(v2Dir), JSON.stringify({ version: 2, pid: process.pid, hostStartedAt: HOST, injects: INJ, writtenAt: NOW }), 'utf8')
  const v2 = readMountHeartbeat(v2Dir)
  check('an unknown version is red', v2.ok === false && v2.reason === 'unknown heartbeat version', v2.reason)

  // ── clock sanity ──────────────────────────────────────────────────────────
  const futureDir = join(root, 'future')
  writeMountHeartbeat({ stateDir: futureDir, pid: process.pid, hostStartedAt: HOST, injects: INJ, now: NOW + 60_000 })
  const future = diagnoseMount({ file: heartbeatPath(futureDir), pid: process.pid, hostStartedAt: HOST, expectedInjects: INJ, now: NOW })
  check('a writtenAt in the future is red', future.ok === false && future.problems.some(p => p.includes('from the future')), future.problems.join('; '))

  const staleDir = join(root, 'stale')
  writeMountHeartbeat({ stateDir: staleDir, pid: process.pid, hostStartedAt: HOST, injects: INJ, now: NOW - 25 * 60 * 60 * 1000 })
  const stale = diagnoseMount({ file: heartbeatPath(staleDir), pid: process.pid, hostStartedAt: HOST, expectedInjects: INJ, now: NOW })
  check('a heartbeat older than a day is red', stale.ok === false && stale.problems.some(p => p.includes('stale')), stale.problems.join('; '))

  // ── atomic write leaves nothing behind ────────────────────────────────────
  // Rewrite the same file: the rename must replace it, not accumulate temp files next to it.
  writeMountHeartbeat({ stateDir, pid: process.pid, hostStartedAt: HOST, injects: ['tools'], now: NOW + 2000 })
  const entries = readdirSync(stateDir)
  check('an atomic rewrite leaves no .tmp- files', entries.filter(name => name.includes('.tmp-')).length === 0, entries.join(','))
  const replaced = readMountHeartbeat(stateDir)
  check('a rewrite leaves exactly one mount.json and no leftovers', entries.length === 1 && replaced.ok === true && JSON.stringify(replaced.data.injects) === '["tools"]', entries.join(','))

  // ── the default clock ─────────────────────────────────────────────────────
  // apply() does not pass hostStartedAt; it has to land on this process's own start time.
  const defaultDir = join(root, 'defaults')
  writeMountHeartbeat({ stateDir: defaultDir, pid: process.pid, injects: ['tools'] })
  const defaults = readMountHeartbeat(defaultDir)
  const uptimeStart = Date.now() - Math.round(process.uptime() * 1000)
  check(
    'hostStartedAt defaults from process.uptime()',
    defaults.ok === true && Math.abs(defaults.data.hostStartedAt - uptimeStart) < 2000,
    defaults.ok ? `${defaults.data.hostStartedAt} vs ${uptimeStart}` : defaults.reason,
  )
}
finally {
  rmSync(root, { recursive: true, force: true })
}

const failed = results.filter(entry => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
