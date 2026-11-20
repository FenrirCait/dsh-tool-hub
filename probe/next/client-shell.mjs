#!/usr/bin/env node
/**
 * Static gate for the 2.0 client half.
 *
 * It reads the sources (and the built bundle when one exists) and fails on the properties the
 * panel is supposed to keep: one loader entry, no innerHTML, no colour outside a token
 * fallback, zh/en catalogs with the same keys, relative imports carrying .js, the eight
 * components, the accessibility hooks, and the four UI states.
 *
 * No dependencies: PASS/FAIL lines, exit 1 when anything fails.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = join(ROOT, 'src', 'client')

const results = []

function check(name, run) {
  try {
    const detail = run()
    results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : '' })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function skip(name, why) {
  results.push({ name, ok: true, skipped: true, detail: why })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Every .ts/.tsx under src/client, with posix-style relative paths for the report. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'settings') continue
      out.push(...walk(full))
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out.sort()
}

const files = walk(CLIENT)
const rel = file => relative(ROOT, file).split('\\').join('/')
const read = file => readFileSync(file, 'utf8')
const sources = new Map(files.map(file => [rel(file), read(file)]))
const joined = [...sources.values()].join('\n')
const byName = name => {
  const hit = [...sources.entries()].find(([path]) => path.endsWith('/' + name))
  assert(hit !== undefined, `src/client/${name} is missing`)
  return hit[1]
}
/** 1-based line of a character offset, for file:line reporting. */
const lineAt = (text, index) => text.slice(0, index).split('\n').length
/** Source with block and star-comment lines removed: a doc comment may name a token in prose. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')

// ── gates ────────────────────────────────────────────────────────────────────

check('required-files', () => {
  const wanted = ['entry.tsx', 'shell.tsx', 'components.tsx', 'i18n.ts', 'theme.ts', 'api.ts', 'types.ts',
    'views/plugins.tsx', 'views/skills.tsx', 'views/mcp.tsx', 'views/scenes.tsx']
  for (const name of wanted) byName(name)
  return `${wanted.length} files under src/client`
})

check('component-exports', () => {
  const source = byName('components.tsx')
  const wanted = ['Button', 'Switch', 'Badge', 'Dialog', 'Select', 'Field', 'Empty', 'Loading']
  for (const name of wanted) {
    assert(new RegExp(`export function ${name}\\b`).test(source), `components.tsx does not export ${name}`)
  }
  return wanted.join(', ')
})

check('entry-contract', () => {
  const source = byName('entry.tsx')
  assert(/export const NS = 'tool-hub'/.test(source), "entry.tsx must export NS = 'tool-hub'")
  // The host reads inject as an array; exporting a function silently skips apply().
  assert(/export const inject = \['slots', 'locale'\]/.test(source), "entry.tsx must export inject as ['slots', 'locale']")
  assert(/export function apply\(ctx/.test(source), 'entry.tsx must export apply(ctx)')
  assert(/id: NS\b/.test(source), 'the slot registration must use the shared NS as its id')
  const table = /const SURFACES: SurfaceSpec\[\] = \[([\s\S]*?)\]/.exec(source)
  assert(table !== null, 'entry.tsx has no SURFACES table')
  const slots = [...(table[1] ?? '').matchAll(/slot: '([^']+)'/g)].map(match => match[1])
  assert(slots.length === 3, `entry.tsx registers ${slots.length} slots, expected 3`)
  // The `main` slot is keyed: registering it without options.key throws at apply time.
  assert(/slot: 'main'[^}]*key: NS/.test(source), 'the main surface must pass key: NS')
  return `NS + inject + apply, ${slots.join(' / ')}`
})

check('three-slots', () => {
  const source = byName('entry.tsx')
  for (const slot of ['plugins.tab', 'sidebar.panellist', 'main']) {
    assert(source.includes(`'${slot}'`), `entry.tsx does not register ${slot}`)
  }
  return 'plugins.tab, sidebar.panellist, main'
})

check('single-loader-owner', () => {
  for (const [path, source] of sources) {
    if (path.endsWith('globals.d.ts')) continue
    const body = code(source)
    const at = body.indexOf('__ModuleLoader__')
    assert(at === -1, `${path}:${lineAt(body, at)} registers with __ModuleLoader__; only the build banner may`)
  }
  return 'loader registration lives in scripts/build-client.mjs only'
})

check('no-innerhtml', () => {
  for (const [path, source] of sources) {
    for (const pattern of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write']) {
      const at = source.indexOf(pattern)
      assert(at === -1, `${path}:${lineAt(source, at)} uses ${pattern}`)
    }
  }
  return 'no HTML string injection'
})

check('no-todo', () => {
  for (const [path, source] of sources) {
    const at = source.search(/TODO\(|FIXME|XXX:/)
    assert(at === -1, `${path}:${lineAt(source, at)} still carries a TODO marker`)
  }
  return 'no TODO/FIXME markers'
})

check('color-tokens-only', () => {
  // Drop every var(--dsw-alias-...) with its balanced fallback, then nothing coloured may remain.
  const strip = text => {
    let out = ''
    let index = 0
    while (index < text.length) {
      const start = text.indexOf('var(--dsw-alias-', index)
      if (start === -1) {
        out += text.slice(index)
        break
      }
      out += text.slice(index, start)
      let depth = 0
      let cursor = start
      for (; cursor < text.length; cursor += 1) {
        const char = text[cursor]
        if (char === '(') depth += 1
        else if (char === ')') {
          depth -= 1
          if (depth === 0) {
            cursor += 1
            break
          }
        }
      }
      index = cursor
    }
    return out
  }
  for (const [path, source] of sources) {
    const rest = strip(source)
    const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(rest)
    assert(match === null, `${path}:${lineAt(rest, match?.index ?? 0)} uses a literal colour outside a token fallback`)
  }
  return 'every colour is var(--dsw-alias-*) with a fallback'
})

check('i18n-parity', () => {
  const source = byName('i18n.ts')
  const catalog = name => {
    const marker = new RegExp(`const ${name}: Catalog = \\{`)
    const found = marker.exec(source)
    assert(found !== null, `i18n.ts has no ${name} catalog`)
    const start = found.index + found[0].length - 1
    let depth = 0
    for (let cursor = start; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1
      else if (source[cursor] === '}') {
        depth -= 1
        if (depth === 0) {
          const body = source.slice(start + 1, cursor)
          return new Set([...body.matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1]))
        }
      }
    }
    throw new Error(`${name} catalog is not closed`)
  }
  const zh = catalog('zh')
  const en = catalog('en')
  assert(zh.size > 0, 'zh catalog is empty')
  for (const key of zh) assert(en.has(key), `en is missing "${key}"`)
  for (const key of en) assert(zh.has(key), `zh is missing "${key}"`)
  for (const [path, text] of sources) {
    for (const match of code(text).matchAll(/\bt\('([^']+)'/g)) {
      const key = match[1]
      assert(zh.has(key), `${path}:${lineAt(text, match.index)} calls t('${key}') which no catalog defines`)
    }
  }
  return `${zh.size} keys, zh/en aligned, all t() calls resolved`
})

check('import-suffix', () => {
  for (const [path, source] of sources) {
    for (const match of source.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      const spec = match[1]
      assert(/\.(js|json)$/.test(spec), `${path}:${lineAt(source, match.index)} imports '${spec}' without a .js suffix`)
    }
  }
  return 'relative imports carry .js'
})

check('accessibility', () => {
  const components = byName('components.tsx')
  assert(/role="switch"/.test(components), 'the switch must expose role="switch"')
  assert(/aria-checked=/.test(components), 'the switch must expose aria-checked')
  assert(/role="dialog"/.test(components), 'the dialog must expose role="dialog"')
  assert(/aria-modal="true"/.test(components), 'the dialog must be aria-modal')
  assert(/aria-labelledby=/.test(components), 'the dialog must be labelled')
  assert(/'Escape'/.test(components), 'the dialog must close on Escape')
  const shell = byName('shell.tsx')
  assert(/role="navigation"/.test(shell), 'the sidebar must be a navigation landmark')
  assert(/aria-current=/.test(shell), 'the active view must be marked with aria-current')
  assert(/aria-live="polite"/.test(shell), 'the shell must announce status politely')
  const views = joined
  assert(/aria-busy=/.test(views), 'busy state must be announced with aria-busy')
  assert(/aria-label=/.test(views), 'controls must carry accessible names')
  return 'navigation, tabs, switch, dialog, live regions'
})

check('ui-states', () => {
  const shell = byName('shell.tsx')
  assert(/state\.loading/.test(shell), 'the shell must render a loading state')
  assert(/state\.error/.test(shell), 'the shell must render an error state')
  assert(/action\.retry/.test(shell), 'the error state must offer a retry')
  for (const view of ['plugins', 'skills', 'mcp', 'scenes']) {
    const source = byName(`views/${view}.tsx`)
    assert(new RegExp(`${view}\\.empty`).test(source), `views/${view}.tsx has no empty state`)
  }
  assert(/OPS\.toggle/.test(joined), 'switches must send the toggle op')
  assert(/OPS\.scene(Apply|Exit)/.test(joined), 'scenes must send scene.apply / scene.exit')
  return 'loading, empty, error, busy wired to ops'
})

check('api-structured-errors', () => {
  const source = byName('api.ts')
  assert(/export interface ApiFail/.test(source), 'api.ts must define a structured failure')
  assert(/ok: false/.test(source), 'api.ts must return { ok: false } rather than throwing')
  assert(!/^\s*throw\b/m.test(source), 'api.ts must not throw out of its boundary')
  assert(/normalizeSnapshot/.test(source), 'api.ts must normalise the snapshot')
  return 'structured results, normalised snapshot'
})

check('file-size', () => {
  const limits = { lines: 3000, bytes: 150 * 1024 }
  let biggest = { path: '', lines: 0 }
  for (const [path, source] of sources) {
    const lines = source.split('\n').length
    const bytes = statSync(join(ROOT, path)).size
    assert(lines < limits.lines, `${path} has ${lines} lines (limit ${limits.lines})`)
    assert(bytes < limits.bytes, `${path} is ${bytes} bytes (limit ${limits.bytes})`)
    if (lines > biggest.lines) biggest = { path, lines }
  }
  return `largest ${biggest.path} at ${biggest.lines} lines`
})

check('bundle-single-loader', () => {
  const bundle = join(ROOT, 'dist', 'client.js')
  if (!existsSync(bundle)) {
    skip('bundle-single-loader', 'dist/client.js not built yet; run npm run build:client')
    return ''
  }
  const text = readFileSync(bundle, 'utf8')
  const loads = (text.match(/__ModuleLoader__\.load\(/g) ?? []).length
  assert(loads === 1, `dist/client.js registers ${loads} loader entries, expected 1`)
  for (const pattern of ['innerHTML', 'dangerouslySetInnerHTML']) {
    assert(text.indexOf(pattern) === -1, `dist/client.js contains ${pattern}`)
  }
  // The host reads `inject` as a dependency array; a function here silently skips apply().
  assert(/var inject = \["slots", "locale"\]/.test(text), 'bundle must export inject as an array')
  return `dist/client.js ${text.length} bytes, one loader entry`
})

// ── report ───────────────────────────────────────────────────────────────────

let failed = 0
for (const result of results) {
  const state = result.skipped === true ? 'SKIP' : result.ok ? 'PASS' : 'FAIL'
  if (state === 'FAIL') failed += 1
  const suffix = result.detail === '' ? '' : ` (${result.detail})`
  console.log(`${state} ${result.name}${suffix}`)
}
console.log(`${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
