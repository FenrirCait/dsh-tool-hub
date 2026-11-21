# Official compat packs

First-party compatibility packs that ship with dsh-tool-hub. They are normal local extensions
(manifest + host entry + CSS), versioned with the plugin and covered by the probe suite.

| Pack | Enables |
|---|---|
| `codex-ui-glass` | Makes the tool hub panel, dock button and sidebar entry follow codex-ui's glass / mica settings. |

## Use

The package's `compat/` folder is an extension root, so every pack here appears in **Extensions**
as soon as the plugin is installed — no copying. Enable the pack there.

A profile copy under `<profile>/.sandbox/extensions/codex-ui-glass/` (or the shared
`~/.dsh/tool-hub/extensions/`) wins over the bundled one if you need to customize it.

Compat packs are **not auto-enabled**: they change how the panel looks, so the owner opts in.
