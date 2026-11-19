#!/usr/bin/env node
/**
 * client-smoke.mjs — static gates for the client half of dsh-tool-hub.
 *
 * Pure Node, zero dependencies. It does NOT execute the bundle (that needs the host's
 * `window.__ModuleLoader__`); it only proves the file is parseable and that the
 * conventions the panel depends on still hold:
 *
 *   1. `client/client.js` parses under `new vm.Script()`          — syntax gate
 *   2. exactly one `__ModuleLoader__.load(`                       — single-bundle entry
 *   3. `plugins.tab` and `sidebar.panellist` slots are registered — the two panel entries
 *   4. no `innerHTML =`                                           — no raw-HTML XSS surface
 *   5. hex colours only appear as `--dsw-alias-*` fallbacks       — theme-token discipline
 *   6. `fmt()` never receives a `t(...)` result as its key        — §1.19.8 regression guard
 *   7. no `TODO(` / `FIXME(` left behind                          — commit hygiene
 *   8. print line + byte count                                    — compare against size-budget baseline
 *
 * Exit 0 when every gate passes, 1 otherwise. The last line is always `N/N passed`.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'client', 'client.js')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

const src = await readFile(CLIENT, 'utf8')
const bytes = Buffer.byteLength(src, 'utf8')
const lines = src === '' ? 0 : src.split('\n').length - (src.endsWith('\n') ? 1 : 0)

// 1 — syntax gate
{
  let ok = false
  let detail = ''
  try {
    new vm.Script(src, { filename: 'client/client.js' })
    ok = true
  } catch (err) {
    detail = `${err.name}: ${err.message}`
  }
  check('1 · vm.Script() parses', ok, detail)
}

// 2 — single bundle entry
{
  const n = (src.match(/__ModuleLoader__\.load\(/g) ?? []).length
  check('2 · one __ModuleLoader__.load(', n === 1, `found ${n}`)
}

// 3 — both panel entry slots are registered
{
  const hasSlot = name => src.includes(`"${name}"`)
  const a = hasSlot('plugins.tab')
  const b = hasSlot('sidebar.panellist')
  check('3 · slots plugins.tab + sidebar.panellist', a && b, `plugins.tab=${a} sidebar.panellist=${b}`)
}

// 4 — no innerHTML assignment (raw-HTML injection surface)
{
  const hits = src.match(/innerHTML\s*=/g) ?? []
  check('4 · no innerHTML =', hits.length === 0, `${hits.length} hit(s)`)
}

// 5 — hex colours only in --dsw-alias-* fallbacks
{
  const hexRe = /#[0-9a-fA-F]{3,8}\b/g
  const hexes = src.match(hexRe) ?? []
  const lineOf = idx => src.slice(0, idx).split('\n').length
  const stray = []
  for (let m = hexRe.exec(src); m !== null; m = hexRe.exec(src)) {
    const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index) === -1 ? src.length : src.indexOf('\n', m.index))
    if (!line.includes('var(--dsw-alias-')) stray.push(`L${lineOf(m.index)}: ${m[0]}`)
  }
  // Bundles ship a handful of literal fallbacks for old shells; the ceiling is a guard rail,
  // not a target. If a future edit balloons past it, that is a signal to re-check the theme
  // discipline rather than silently raising the number.
  const ceiling = 40
  const ok = hexes.length <= ceiling && stray.length === 0
  check('5 · hex colours only as --dsw-alias-* fallbacks', ok,
    `${hexes.length} hex(es), ${stray.length} outside fallback${stray.length ? ' → ' + stray.join(', ') : ''}`)
}

// 6 — fmt() key must be a string literal, never a t(...) result (VERSIONS §1.19.8)
{
  // Walk every `fmt(` call site, skip the `function fmt(` definition, and pull out the
  // top-level positional arguments. The guard is against the §1.19.8 bug: passing the
  // already-translated string (`t(key)`) as the key, which made fmt return the vars object.
  const sites = []
  let i = 0
  while (i < src.length) {
    const idx = src.indexOf('fmt(', i)
    if (idx === -1) break
    // Skip `fmt(` that only appears inside a line comment (e.g. "// by fmt() below.").
    const lineStart = src.lastIndexOf('\n', idx) + 1
    if (src.slice(lineStart, idx).includes('//')) { i = idx + 4; continue }
    const before = src.slice(0, idx).trimEnd()
    if (/function\s+fmt$/.test(before)) { i = idx + 4; continue }
    const args = []
    let depth = 0
    let inStr = null
    let cur = ''
    let j = idx + 4
    for (; j < src.length; j++) {
      const ch = src[j]
      if (inStr !== null) {
        cur += ch
        if (ch === '\\') { cur += src[j + 1] ?? ''; j++; continue }
        if (ch === inStr) inStr = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break
        depth--; cur += ch; continue
      }
      if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    if (cur.trim() !== '') args.push(cur.trim())
    sites.push({ args, line: src.slice(0, idx).split('\n').length })
    i = idx + 4
  }
  const bad = sites
    .filter(site => site.args.length < 2 || /^t\s*\(/.test(site.args[1] ?? ''))
    .map(site => `L${site.line}`)
  check('6 · fmt() key is a string literal, not t(...)', bad.length === 0,
    `${sites.length} fmt() call(s)${bad.length ? ', bad: ' + bad.join(', ') : ''}`)
}

// 7 — no leftover TODO / FIXME
{
  const hits = src.match(/TODO\(|FIXME\(/g) ?? []
  check('7 · no TODO( / FIXME(', hits.length === 0, `${hits.length} hit(s)`)
}

// 8 — size report (informational, compared against probe/size-budget.baseline.json by hand)
{
  check('8 · size report printed', true, `${lines} lines · ${bytes} bytes`)
}

// ── report ─────────────────────────────────────────────────────────────────
let failed = 0
for (const { name, ok, detail } of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
console.log('')
console.log(`client/client.js: ${lines} lines · ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`)
console.log(`${checks.length - failed}/${checks.length} passed`)
if (failed > 0) process.exitCode = 1
