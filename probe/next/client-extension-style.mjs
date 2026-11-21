#!/usr/bin/env node
/** The panel injects one style tag per loaded extension, driven by the snapshot. */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log('PASS ' + name) }
  else { failed += 1; console.log('FAIL ' + name + (detail === '' ? '' : '  ' + detail)) }
}
const read = path => readFile(resolve(repo, path), 'utf8')
const [style, shell, entry, dock, components] = await Promise.all([
  read('src/client/extension-style.ts'),
  read('src/client/shell.tsx'),
  read('src/client/entry.tsx'),
  read('src/client/dock.tsx'),
  read('src/client/components.tsx'),
])

check('style module removes stale tags', style.includes("querySelectorAll('style[' + STYLE_ATTR + ']')"))
check('style module only uses loaded css', style.includes("row.loaded !== true") && style.includes("Array.isArray(row.css)"))
check('style module tags by extension id', style.includes("style.setAttribute(STYLE_ATTR, id)"))
check('shell injects on every snapshot', /applyExtensionStyles\(snapshot\.extensions\)/.test(shell))
check('entry installs the fallback fetch', entry.includes('installExtensionStyleRefresh()'))
check('dock button has a stable hook', dock.includes('className="th-dock-btn"'))
check('sidebar entry has a stable hook', entry.includes("className: 'th-sidebar-entry'"))
check('button forwards className', components.includes("props.className") && components.includes('className?: string'))

const styleTag = 'data-extension-style'
check('style tags are identified', style.includes("const STYLE_ATTR = '" + styleTag + "'"))

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
