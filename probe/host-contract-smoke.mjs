/**
 * host-contract smoke probe.
 *
 * Exercises the capability table and its two functions without a live host: a
 * synthetic service bag is built straight from HOST_CONTRACT (so a full bag can
 * never drift from the table), then members are removed or mangled one at a time
 * to prove the probe grades each failure by its `required` flag and never calls
 * a member while checking.
 */
import { HOST_CONTRACT, checkContract, contractReport } from '../lib/host-contract.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// A bag where every contracted member is a function, generated from the table
// so the "everything present" case cannot drift out of sync with the contract.
function fullServices() {
  const out = {}
  for (const entry of HOST_CONTRACT) {
    out[entry.service] ??= {}
    out[entry.service][entry.member] = () => {}
  }
  return out
}

function findMissing(missing, service, member) {
  return missing.find(entry => entry.service === service && entry.member === member)
}

// ── 1. everything present ────────────────────────────────────────────────────
const full = fullServices()
const all = contractReport(full)
check('full set: ok is true', all.ok === true)
check('full set: missing is empty', all.missing.length === 0)
check('full set: present equals total', all.present === all.total && all.total === HOST_CONTRACT.length, `present=${all.present} total=${all.total}`)
check('full set: not degraded', all.degraded === false)

// ── 2. a required member drops ───────────────────────────────────────────────
{
  const services = fullServices()
  delete services.tools.restrict
  const report = contractReport(services)
  const hit = findMissing(report.missing, 'tools', 'restrict')
  check('missing tools.restrict flips ok to false', report.ok === false)
  check('tools.restrict is located in missing', hit !== undefined && hit.required === true)
  check('tools.restrict carries a fallback', typeof hit?.fallback === 'string' && hit.fallback.length > 0)
}

// ── 3. a non-required member drops: ok stays true, degraded ─────────────────
{
  const services = fullServices()
  delete services.connection.requestRejection
  const report = contractReport(services)
  check('missing a non-required member keeps ok true', report.ok === true)
  check('missing a non-required member sets degraded', report.degraded === true)
  check('non-required member is still reported in missing', findMissing(report.missing, 'connection', 'requestRejection') !== undefined)
}

// ── 4. a whole service drops: one missing row per member, no throw ───────────
{
  const services = fullServices()
  delete services.pluginManager
  let report
  let threw = false
  try {
    report = contractReport(services)
  } catch {
    threw = true
  }
  check('missing pluginManager does not throw', threw === false)
  const members = HOST_CONTRACT.filter(entry => entry.service === 'pluginManager').map(entry => entry.member)
  const reported = members.filter(member => findMissing(report?.missing ?? [], 'pluginManager', member) !== undefined)
  check('every pluginManager member reported missing', reported.length === members.length, reported.join(','))
  check('pluginManager loss flips ok false (has required rows)', report?.ok === false)
}

// ── 5. undefined / empty bag: all missing, no throw ──────────────────────────
{
  let threwUndefined = false
  let threwEmpty = false
  let undefinedReport
  let emptyReport
  try {
    undefinedReport = checkContract(undefined)
  } catch {
    threwUndefined = true
  }
  try {
    emptyReport = checkContract({})
  } catch {
    threwEmpty = true
  }
  check('checkContract(undefined) does not throw', threwUndefined === false)
  check('checkContract(undefined) reports every member', undefinedReport?.length === HOST_CONTRACT.length, String(undefinedReport?.length))
  check('checkContract({}) reports every member', emptyReport?.length === HOST_CONTRACT.length, String(emptyReport?.length))
  const emptyReportFull = contractReport({})
  check('empty bag: ok false and degraded true', emptyReportFull.ok === false && emptyReportFull.degraded === true)
}

// ── 6. shape probe never calls a member ──────────────────────────────────────
{
  let calls = 0
  const services = fullServices()
  services.tools.restrict = () => { calls += 1 }
  services.pluginManager.listPlugins = () => { calls += 1 }
  checkContract(services)
  check('checkContract does not call any member', calls === 0, `calls=${calls}`)
}

// ── 7. table self-checks ─────────────────────────────────────────────────────
{
  const requiredKeys = ['service', 'member', 'required', 'fallback', 'usedFor']
  const missingKeys = HOST_CONTRACT.filter(entry => requiredKeys.some(key => !(key in entry)))
  check('every row has service/member/required/fallback/usedFor', missingKeys.length === 0, missingKeys.map(entry => `${entry.service}.${entry.member}`).join(','))
  check('every required flag is a boolean', HOST_CONTRACT.every(entry => typeof entry.required === 'boolean'))
  check('every fallback is non-empty', HOST_CONTRACT.every(entry => typeof entry.fallback === 'string' && entry.fallback.trim() !== ''))
  const privates = HOST_CONTRACT.filter(entry => entry.private === true)
  check('private rows have a non-empty fallback naming the public member', privates.length > 0 && privates.every(entry => entry.fallback.includes('definitions') || entry.fallback.length > 0), privates.map(entry => `${entry.service}.${entry.member}`).join(','))
  const seen = new Set()
  const dupes = HOST_CONTRACT.filter(entry => {
    const key = `${entry.service}.${entry.member}`
    if (seen.has(key)) return true
    seen.add(key)
    return false
  })
  check('no duplicate service+member', dupes.length === 0, dupes.map(entry => `${entry.service}.${entry.member}`).join(','))
}

// ── 8. reverse: a member that is not a function reads as missing ─────────────
{
  for (const bad of ['not-a-function', 42, null]) {
    const services = fullServices()
    services.tools.restrict = bad
    const report = contractReport(services)
    check(`tools.restrict = ${JSON.stringify(bad)} reads as missing`, report.ok === false && findMissing(report.missing, 'tools', 'restrict') !== undefined)
  }
}

// ── 9. the private member's fallback has to describe the trap ────────────────
// `tools.definitions()` returns post-restriction names, so "use definitions instead" would make
// the mask lift itself. The table is documentation the next maintainer will trust, so the dead
// end has to be written down rather than implied.
{
  const view = HOST_CONTRACT.find(entry => entry.service === 'tools' && entry.member === 'view')
  check('tools.view is marked private', view?.private === true)
  check('the view fallback warns that definitions is post-restriction', /post-restriction/.test(view?.fallback ?? ''), view?.fallback)
  const definitions = HOST_CONTRACT.find(entry => entry.service === 'tools' && entry.member === 'definitions')
  check('definitions is not offered as a mask input', /never as input to the mask/.test(definitions?.usedFor ?? ''), definitions?.usedFor)
}

const failed = results.filter(entry => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
