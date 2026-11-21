#!/usr/bin/env node
/**
 * tool.costs: the schema JSON ÷4 token estimate behind the tools page badge.
 *
 * The tools service is faked, so every branch is checked without a host: the two-argument form,
 * the one-argument fallback, per-tool arithmetic, the catalog total, nameless definitions, a
 * host without definitions(), and the read-only declaration. Runs against dist/ like the other
 * next probes; env.save throws here, because a cost read that writes would be a bug.
 */
import { DomainFailure, toolSurfaceDomain } from '../../dist/domains/tool-surface.js'

let checks = 0
const failures = []
function check(name, ok, detail) {
  checks += 1
  if (ok) {
    console.log('PASS ' + name)
    return
  }
  failures.push(detail === undefined ? name : name + ' -- ' + detail)
  console.log('FAIL ' + failures[failures.length - 1])
}

const domain = toolSurfaceDomain()
const handler = domain.handlers['tool.costs']

function makeState() {
  return {
    version: 2,
    groups: [],
    collections: [],
    presets: [],
    toolDeny: [],
    auto: { appliedAt: null },
    sessions: {},
    scenes: {},
    mode: null,
    settings: {},
    modules: {},
  }
}

function makeEnv(services) {
  const env = {
    state: makeState(),
    services: { get: name => services[name] },
    saves: 0,
    async save() {
      env.saves += 1
      throw new Error('tool.costs must not save')
    },
    log() {},
    now: () => 1720000000000,
  }
  return env
}

const alpha = { name: 'alpha', description: 'first schema', parameters: { type: 'object' } }
const beta = { name: 'beta', description: 'second schema' }
const nameless = { name: '   ', description: 'cannot be attributed' }
const sampleDefs = [alpha, beta, nameless]

/** The declared unit, computed independently of the implementation. */
function measure(definition) {
  const bytes = JSON.stringify(definition).length
  return { bytes, tokens: Math.max(1, Math.ceil(bytes / 4)) }
}
const alphaCost = measure(alpha)
const betaCost = measure(beta)

// ── 1. two arguments first, one-argument fallback when the host refuses ─────

const fallbackArities = []
const fallbackService = {
  definitions(...args) {
    fallbackArities.push(args.length)
    if (args.length > 1) throw new Error('this host takes one argument')
    return sampleDefs.slice()
  },
}
const fallbackReport = await handler({}, makeEnv({ tools: fallbackService }))
check(
  'costs-measures-each-schema',
  fallbackArities.join(',') === '2,1'
    && fallbackReport.mode === 'schema-json-4'
    && fallbackReport.tools.length === 2
    && fallbackReport.tools[0].name === 'alpha'
    && fallbackReport.tools[0].bytes === alphaCost.bytes
    && fallbackReport.tools[0].tokens === alphaCost.tokens
    && fallbackReport.tools[1].name === 'beta'
    && fallbackReport.tools[1].bytes === betaCost.bytes
    && fallbackReport.tools[1].tokens === betaCost.tokens,
  JSON.stringify({ arities: fallbackArities, report: fallbackReport }),
)

// ── 2. the catalog total is the sum of the rows (two arguments accepted) ───

const directArities = []
const directService = {
  definitions(...args) {
    directArities.push(args.length)
    return sampleDefs.slice()
  },
}
const directReport = await handler({}, makeEnv({ tools: directService }))
check(
  'costs-total-sums-tokens',
  directArities.join(',') === '2'
    && directReport.tools.length === 2
    && directReport.total === alphaCost.tokens + betaCost.tokens,
  JSON.stringify({ arities: directArities, total: directReport.total, expected: alphaCost.tokens + betaCost.tokens }),
)

// ── 3. nameless definitions are dropped, not counted ───────────────────────

check(
  'costs-drops-empty-names',
  fallbackReport.tools.length === sampleDefs.length - 1
    && fallbackReport.tools.every(row => typeof row.name === 'string' && row.name.trim() !== '')
    && !fallbackReport.tools.some(row => row.name === nameless.name.trim()),
  JSON.stringify(fallbackReport.tools.map(row => row.name)),
)

// ── 4. a host without definitions() fails as capability-missing ────────────

async function failureOf(services) {
  try {
    await handler({}, makeEnv(services))
    return null
  }
  catch (error) {
    return error
  }
}
const noService = await failureOf({})
const noDefinitions = await failureOf({ tools: {} })
const refusesBoth = await failureOf({
  tools: {
    definitions() {
      throw new Error('not implemented here')
    },
  },
})
function isMissing(error) {
  return error instanceof DomainFailure && error.code === 'capability-missing'
}
check(
  'costs-missing-service',
  isMissing(noService) && isMissing(noDefinitions) && isMissing(refusesBoth),
  [noService, noDefinitions, refusesBoth]
    .map(error => (error === null ? 'no error' : String(error.message)))
    .join(' | '),
)

// ── 5. the op is declared read-only and touches no state ───────────────────

const declared = domain.module.ops.find(op => op.id === 'tool.costs')
const readOnlyEnv = makeEnv({ tools: directService })
const readOnlyState = JSON.stringify(readOnlyEnv.state)
await handler({}, readOnlyEnv)
check(
  'costs-read-only',
  declared !== undefined
    && declared.write === false
    && declared.audit === false
    && typeof handler === 'function'
    && readOnlyEnv.saves === 0
    && JSON.stringify(readOnlyEnv.state) === readOnlyState,
  JSON.stringify({ declared, saves: readOnlyEnv.saves }),
)

if (failures.length > 0) {
  console.error('tool-costs probe: ' + failures.length + ' failed of ' + checks)
  for (const failure of failures) console.error('  FAIL ' + failure)
  process.exit(1)
}
console.log('tool-costs probe: ' + checks + ' checks passed')
