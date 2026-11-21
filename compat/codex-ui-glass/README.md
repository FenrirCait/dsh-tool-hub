# codex-ui glass compat

Copy this folder into an extension root and enable it:

- profile: `<profile>/.sandbox/extensions/codex-ui-glass/`
- shared: `~/.dsh/tool-hub/extensions/codex-ui-glass/`

The manifest declares `styles: ["style.css"]`. The host reads the CSS and the panel injects it
while the extension is loaded.

The style follows codex-ui's DOM contract, not its source: when codex-ui enables glass it sets

- `<html data-dsh-glass>`
- `data-dsh-glass-float` (mica layout) or `data-dsh-glass-compat` (flat glass)
- `--dsh-glass-blur`, `--dsh-glass-frost`, `--dsh-glass-glow`

on the document. The CSS is scoped to `.th-root`, `.th-dock-btn` and `.th-sidebar-entry`, so it
only touches this plugin's surfaces.
