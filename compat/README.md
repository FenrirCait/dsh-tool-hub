# Official compat packs

First-party compatibility packs that ship with dsh-tool-hub. They are normal local extensions
(manifest + host entry + CSS), versioned with the plugin and covered by the probe suite.

| Pack | Enables |
|---|---|
| `codex-ui-glass` | Makes the tool hub panel, dock button and sidebar entry follow codex-ui's glass / mica settings. |

## Install

Copy the pack folder into an extension root and enable it in **Extensions**:

- profile: `<profile>/.sandbox/extensions/codex-ui-glass/`
- shared: `~/.dsh/tool-hub/extensions/codex-ui-glass/`

Compat packs are **not auto-enabled**: they change how the panel looks, so the owner opts in.
