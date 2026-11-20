#!/usr/bin/env node
/**
 * Bundle the client half into the one file the host loads.
 *
 * Loader contract: __ModuleLoader__.load({ id, factory(require) }); react is the only seed.
 * The banner opens the factory and the footer returns the bundle exports, so every external
 * require("react") lands inside the factory where require exists.
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'dist', 'client.js')

await build({
  entryPoints: [join(ROOT, 'src', 'client', 'entry.tsx')],
  outfile: OUT,
  bundle: true,
  format: 'iife',
  globalName: '__toolHubClient',
  external: ['react'],
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  target: 'es2022',
  legalComments: 'none',
  banner: { js: "window.__ModuleLoader__.load({ id: \"dsh-tool-hub\", factory: (require) => {" },
  // A plain object, not esbuild's __toCommonJS namespace: the host's import shim treats an
  // `__esModule: true` face as ESM and would read `.default` (undefined) instead of apply.
  footer: { js: 'const __m = __toolHubClient; return { NS: __m.NS, inject: __m.inject, apply: __m.apply }; } });' },
})

const text = await readFile(OUT, 'utf8')
const loads = (text.match(/__ModuleLoader__\.load\(/g) ?? []).length
if (loads !== 1) throw new Error(`bundle must register exactly one loader entry, found ${loads}`)
console.log(`dist/client.js ${text.length} bytes`)
