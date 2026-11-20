#!/usr/bin/env node
/**
 * File-size budget: the ratchet that keeps hand-written source readable.
 *
 * Why a probe and not a paragraph in a doc: a size rule nobody measures is a wish. This runs in
 * the dev loop and in CI, fails when a source file crosses the hard line, and — for the files
 * that were already over it before the rule existed — fails on *growth* instead, so the debt
 * has to shrink rather than wait for a rewrite that never gets scheduled.
 *
 * Three tiers, because one number cannot mean the same thing for source, for a bundle the host
 * forces into a single file, and for data:
 *   - source  (`lib/**`, `bin/**`, `probe/**`): soft 1500 lines / 80 KiB, hard 3000 lines / 150 KiB
 *   - bundle  (`client/**`): reported, never fails — the host loads exactly one file
 *   - data    (`locale/**`, `detail/**`): not measured
 *
 * Usage: `node probe/size-budget.mjs [--baseline <file>] [--json]`
 * Exit code 1 when a file crosses the hard line, or grows past its baseline allowance.
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Lines and bytes, not kilobytes: 153_600 bytes is the 150 KiB the doc talks about. */
const TIERS = {
  source: { dirs: ['lib', 'bin', 'probe', 'src'], soft: { lines: 1500, bytes: 80 * 1024 }, hard: { lines: 3000, bytes: 150 * 1024 } },
  bundle: { dirs: ['client'], soft: null, hard: null },
  data: { dirs: ['locale', 'detail'], measure: false },
}

const DEFAULT_BASELINE = join(ROOT, 'probe', 'size-budget.baseline.json')

const args = process.argv.slice(2)
const flag = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const baselineFile = flag('--baseline') ?? DEFAULT_BASELINE
const asJson = args.includes('--json')

/** Every file worth measuring, with its tier. Kept explicit so nothing is silently skipped. */
async function measure() {
  const { readdir } = await import('node:fs/promises')
  const rows = []
  for (const [tier, spec] of Object.entries(TIERS)) {
    if (spec.measure === false) continue
    for (const dir of spec.dirs) {
      let entries
      try {
        entries = await readdir(join(ROOT, dir), { recursive: true, withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const path = join(entry.parentPath ?? entry.path, entry.name)
        const rel = relative(ROOT, path).split('\\').join('/')
        if (!/\.(mjs|js|ts|json|md)$/.test(rel)) continue
        const info = await stat(path)
        const text = await readFile(path, 'utf8')
        // A trailing newline is not a line; counting it would make every file one line bigger.
        const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
        rows.push({ path: rel, tier, bytes: info.size, lines })
      }
    }
  }
  return rows.sort((left, right) => right.bytes - left.bytes)
}

async function loadBaseline() {
  try {
    const parsed = JSON.parse(await readFile(baselineFile, 'utf8'))
    return parsed.files ?? {}
  } catch {
    return {}
  }
}

const fmt = (value, unit) => `${value} ${unit}`
const kb = bytes => `${Math.round(bytes / 1024)}K`

async function main() {
  const rows = await measure()
  const baseline = await loadBaseline()
  const findings = []

  for (const row of rows) {
    const spec = TIERS[row.tier]
    const allowance = baseline[row.path]
    const record = { ...row, status: 'ok', problems: [] }

    if (row.tier === 'bundle') {
      // The host loads one `./client` file, so a bundle cannot be split at the source of truth.
      // Report it, and let the slice+concat build (if one appears) be the answer.
      record.status = 'reported'
    } else {
      const overHard = (spec.hard.lines !== null && row.lines > spec.hard.lines)
        || (spec.hard.bytes !== null && row.bytes > spec.hard.bytes)
      const overSoft = (spec.soft.lines !== null && row.lines > spec.soft.lines)
        || (spec.soft.bytes !== null && row.bytes > spec.soft.bytes)

      if (allowance === undefined) {
        if (overHard) {
          record.status = 'fail'
          record.problems.push(`over the hard line (${fmt(spec.hard.lines, 'lines')} / ${kb(spec.hard.bytes)}) and not in the baseline`)
        } else if (overSoft) {
          record.status = 'warn'
          record.problems.push(`over the soft line (${fmt(spec.soft.lines, 'lines')} / ${kb(spec.soft.bytes)})`)
        }
      } else {
        // Known debt: the rule is "no growth", not "fix it today".
        if (row.lines > allowance.lines || row.bytes > allowance.bytes) {
          record.status = 'fail'
          record.problems.push(`grew past its baseline allowance (${allowance.lines} lines / ${allowance.bytes} B)`)
        } else if (overHard) {
          record.status = 'warn'
          record.problems.push(`known debt: over the hard line, ${row.lines - spec.hard.lines} line(s) to go`)
        } else {
          record.status = 'stale'
          record.problems.push('back inside the hard line — drop its baseline entry')
        }
      }
    }

    findings.push(record)
  }

  for (const entry of Object.keys(baseline)) {
    if (!rows.some(row => row.path === entry)) findings.push({ path: entry, tier: 'baseline', bytes: 0, lines: 0, status: 'stale', problems: ['baseline entry for a file that is gone'] })
  }

  if (asJson) {
    console.log(JSON.stringify({ findings, baseline: baselineFile }, null, 2))
  } else {
    for (const finding of findings) {
      const tag = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', stale: 'NOTE', reported: 'INFO' }[finding.status]
      console.log(`${tag}  ${finding.path.padEnd(28)} ${String(finding.lines).padStart(5)} lines  ${kb(finding.bytes).padStart(5)}${finding.problems.length === 0 ? '' : `  — ${finding.problems.join('; ')}`}`)
    }
    const failures = findings.filter(finding => finding.status === 'fail')
    console.log(`\n${failures.length === 0 ? 'size budget holds' : `${failures.length} file(s) over budget`}`)
  }

  if (findings.some(finding => finding.status === 'fail')) process.exitCode = 1
}

await main()
