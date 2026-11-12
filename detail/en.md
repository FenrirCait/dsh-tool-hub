# Tool Hub

One page for everything this DSH installation actually runs: every loader entry, and every skill in
the user skill roots.

It shows up twice, with the same list behind both:

- the **Hub** tab at the top of the Plugins page
- the **Tool Hub** panel in the sidebar

## What a row is

| Row | Where it comes from | How it switches |
| --- | --- | --- |
| Plugin | the host's plugin manager (`pluginManager.listPlugins()`) | writes the profile patch layer, exactly where the Plugins page writes |
| Skill | `~/.dsh/skills`, `~/.agents/skills` | renames `SKILL.md` to `SKILL.md.disabled` (reversible) |

Each row says what it is, whether it is on, and why it cannot be switched when it cannot:

- **Official** — `@deepseek-ai/*` packages and the loader's own `cordis:*` entries, shipped with the client
- **Host-managed** — the plugin manager, the timer, the tool registry and the like; not switchable from outside
- **This plugin** — the panel itself. It refuses to switch itself off; that would be a one-click dead end
- `#1`, `#2` — the same module mounted more than once by the loader

## Groups

A group holds any mix of plugins and skills. With a group selected, two explicit **Enable** /
**Disable** buttons sit under its name and flip every member at once; groups over 20 members ask
first.

**Auto group** buckets the current inventory from a rule table: core, interface, media, research,
dev, integrations, skills. It previews the plan before writing anything, and re-running it replaces
only the groups it generated — hand-made groups stay as they are.

## Presets

A preset stores the set you have switched on. Applying one has two modes:

- **Apply** — turns on what it lists and off what it does not
- **Only switch on** — adds, never removes

Changes over 10 rows ask first.

## Where state lives

```
<DSH_HOME>/tool-hub/state.json     defaults to ~/.dsh/tool-hub/state.json
```

Writes are atomic (temp file + rename), so a crash mid-save cannot leave a half-written state.
Deleting the file clears groups and presets; it does not touch plugin or skill switches.

A sandbox or test profile can keep everything disposable:

```
TOOL_HUB_STATE_FILE=<dir>/tool-hub-state.json
TOOL_HUB_SKILL_ROOTS=<dir>/skills:<dir>/skills2   # semicolon on Windows
```

## What it does not do

- MCP servers are not listed yet; they are edited in their own config block and are next
- Only user skill roots are scanned; a workspace's `.dsh/skills` belongs to that workspace, not to
  the installation, and is not switched from here
- No terminal UI; the panel is a Web / Desktop extension
