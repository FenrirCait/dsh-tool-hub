/**
 * Op-registry smoke test: bidirectional reconciliation against the dispatch switch.
 *
 * It reads `lib/index.js` as text, pulls every `case '<a-z>.<a-zA-Z+>':` label out of the
 * `dispatchOnce` switch, and diffs that set against `Object.keys(OP_REGISTRY)` in both
 * directions. A label in the code with no registry entry, or an entry with no matching label,
 * is a drift the registry has to be fixed for — never silently tolerated. It then checks the
 * shape of every entry and spot-checks the semantics that are easiest to get wrong.
 *
 * Run: `node probe/op-registry-smoke.mjs`. Exit code 1 on any failure.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { OP_REGISTRY, describeOp, allOps, opsWith } from '../lib/op-registry.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const INDEX_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js')

/** One op label per `case 'x.y':` (or `case 'toggle':`) in the dispatch switch, deduplicated and sorted. */
function extractCaseOps(text) {
  const start = text.indexOf('function dispatchOnce(')
  let body = text
  if (start !== -1) {
    // Only the dispatch switch counts: other switches in this file use plain words too, and a
    // label from one of those would look like an unregistered op.
    const after = text.indexOf('\nasync function ', start + 1)
    body = after === -1 ? text.slice(start) : text.slice(start, after)
  }
  const labels = new Set()
  const re = /case\s+'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)?)'\s*:/g
  for (let match = re.exec(body); match !== null; match = re.exec(body)) {
    labels.add(match[1])
  }
  return [...labels].sort()
}

/**
 * Pure reconciliation: given the registry keys and the code labels, return what is only in
 * each side. Kept as a function so a caller can prove it reports drift with a fake key.
 */
function reconcile(registryKeys, codeOps) {
  const registry = new Set(registryKeys)
  const code = new Set(codeOps)
  return {
    onlyInCode: [...code].filter(name => !registry.has(name)).sort(),
    onlyInRegistry: [...registry].filter(name => !code.has(name)).sort(),
  }
}

const source = await readFile(INDEX_PATH, 'utf8')
const codeOps = extractCaseOps(source)
const registryKeys = Object.keys(OP_REGISTRY)

// ── bidirectional diff ──────────────────────────────────────────────────────
const { onlyInCode, onlyInRegistry } = reconcile(registryKeys, codeOps)
check(
  'no case label missing from the registry',
  onlyInCode.length === 0,
  onlyInCode.length === 0 ? '' : `missing: ${onlyInCode.join(', ')}`,
)
check(
  'no registry entry without a case label',
  onlyInRegistry.length === 0,
  onlyInRegistry.length === 0 ? '' : `orphan: ${onlyInRegistry.join(', ')}`,
)
check(
  'registry covers every dispatch op',
  registryKeys.length === codeOps.length,
  `registry=${registryKeys.length} code=${codeOps.length}`,
)
check('registry holds 49 ops (45 dotted + 4 plain words)', registryKeys.length === 49, `got ${registryKeys.length}`)

// ── entry shape ─────────────────────────────────────────────────────────────
const CONFIRM_VALUES = new Set([null, 'reset', true])
const CJK = /[\u4e00-\u9fff]/
const bad = []
for (const name of registryKeys) {
  const entry = OP_REGISTRY[name]
  if (typeof entry?.write !== 'boolean') bad.push(`${name}.write`)
  if (!CONFIRM_VALUES.has(entry?.confirm)) bad.push(`${name}.confirm`)
  if (typeof entry?.audit !== 'boolean') bad.push(`${name}.audit`)
  if (typeof entry?.note !== 'string' || entry.note.trim() === '') bad.push(`${name}.note`)
  else if (CJK.test(entry.note)) bad.push(`${name}.note-cjk`)
}
check('every entry is well-shaped', bad.length === 0, bad.length === 0 ? '' : bad.slice(0, 5).join(', '))

// ── semantic spot checks ────────────────────────────────────────────────────
check("state.reset needs the literal 'reset' token", OP_REGISTRY['state.reset']?.confirm === 'reset')
check('thirdparty.off is a write and audited', OP_REGISTRY['thirdparty.off']?.write === true && OP_REGISTRY['thirdparty.off']?.audit === true)
check('skill.read is read-only', OP_REGISTRY['skill.read']?.write === false)
check('mcp.raw is read-only', OP_REGISTRY['mcp.raw']?.write === false)
check('mcp.probe is not a confirm op', OP_REGISTRY['mcp.probe']?.confirm === null)
// The gate on `config.import` is conditional (replace only), so it must NOT claim an
// unconditional one — otherwise the dispatch guard would demand a confirmation for a merge.
check(
  'config.import records its conditional gate instead of an unconditional one',
  OP_REGISTRY['config.import']?.confirm === null && /replace mode needs confirm:true/.test(OP_REGISTRY['config.import']?.note ?? ''),
  `confirm=${OP_REGISTRY['config.import']?.confirm}`,
)

// ── helpers ─────────────────────────────────────────────────────────────────
check('describeOp misses unknown names', describeOp('nope.nope') === undefined)
check('describeOp finds a known name', describeOp('group.save') === OP_REGISTRY['group.save'])
const sorted = allOps()
check(
  'allOps is sorted and unique',
  sorted.every((name, index) => index === 0 || sorted[index - 1] < name) && new Set(sorted).size === sorted.length,
)
check(
  'opsWith filters entries',
  opsWith(entry => entry.confirm !== null).every(name => OP_REGISTRY[name].confirm !== null),
)

// ── reverse case: reconciliation must report a planted extra key ────────────
const planted = reconcile([...registryKeys, 'ghost.extra'], codeOps)
check(
  'reconcile reports a planted orphan key',
  planted.onlyInRegistry.length === 1 && planted.onlyInRegistry[0] === 'ghost.extra',
  planted.onlyInRegistry.join(','),
)

const failed = results.filter(entry => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
