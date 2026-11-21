/**
 * Extension styles: loaded extensions may declare CSS files; the host sends their text and the
 * panel injects one <style> per extension. Styles are document-scoped by design (an extension is
 * trusted local code), so authors must scope selectors to the panel's own roots.
 */
import { runOp } from './api.js'

const STYLE_ATTR = 'data-extension-style'
let installed = false

interface ExtensionRow {
  id?: unknown
  loaded?: unknown
  css?: unknown
}

export function applyExtensionStyles(rows: readonly unknown[]): void {
  if (typeof document === 'undefined') return
  for (const node of [...document.querySelectorAll('style[' + STYLE_ATTR + ']')]) node.remove()
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue
    const row = raw as ExtensionRow
    const id = typeof row.id === 'string' ? row.id : ''
    if (id === '' || row.loaded !== true || !Array.isArray(row.css)) continue
    const text = row.css.filter((item): item is string => typeof item === 'string').join('\n')
    if (text.trim() === '') continue
    const style = document.createElement('style')
    style.setAttribute(STYLE_ATTR, id)
    style.textContent = text
    document.head.appendChild(style)
  }
}

export async function refreshExtensionStyles(): Promise<void> {
  try {
    const result = await runOp('snapshot', {})
    if (!result.ok) return
    const data = result.data !== null && typeof result.data === 'object' ? result.data as Record<string, unknown> : {}
    applyExtensionStyles(Array.isArray(data.extensions) ? data.extensions : [])
  }
  catch {
    /* no snapshot yet: the panel still works without styles */
  }
}

/** Fetch once on load and again when the window regains focus (extension toggles reload the page). */
export function installExtensionStyleRefresh(): void {
  if (installed) return
  installed = true
  void refreshExtensionStyles()
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => { void refreshExtensionStyles() })
  }
}
