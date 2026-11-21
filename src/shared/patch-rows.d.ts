/** The 1.x line editor for cordis.patch.yml, shipped as plain ESM in lib/. */
declare module '*/patch-rows.js' {
  export interface PatchRowSpan { id: string; startLine: number; endLine: number; disabled: boolean | null }
  export function parseRows(text: string): PatchRowSpan[]
  export function setRowDisabled(text: string, id: string, disabled: boolean): string
  export function removeRow(text: string, id: string): string
}
