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
| MCP server | `@deepseek-ai/dsh-mcp-client` entries in the profile's `cordis.patch.yml` | the same loader switch as a plugin; the dialog edits only that entry's `config:` block |

Each row says what it is, whether it is on, and why it cannot be switched when it cannot:

- **Official** — `@deepseek-ai/*` packages and the loader's own `cordis:*` entries, shipped with the client
- **Host-managed** — the plugin manager, the timer, the tool registry and the like; not switchable from outside
- **This plugin** — the panel itself. It refuses to switch itself off; that would be a one-click dead end
- `#1`, `#2` — the same module mounted more than once by the loader

## MCP servers

An MCP row switches on and off like any other entry (same loader mechanism, applied on save), and
can be created, edited and deleted from the panel:

- **Edit config** — rewrites only that entry's own `config:` block; every other byte of the file
  stays, and the host's HMR watcher picks it up
- **Test** — starts a throwaway client from the values **currently in the dialog** (saved or not),
  runs `initialize` + `tools/list`, reports the tool count and elapsed time, then kills the process;
  the timeout is 12 s and it ends the whole process tree
- **Tools** — unticking a tool removes it from the model-visible tool table of every agent in this
  install, rather than rejecting the call; that list lives in this panel's own `state.json`

With Skill / MCP panel installed too, the two masks are a union: its entries show read-only here and
one button imports them, but this panel never writes its file.

## Groups

A group holds any mix of plugins and skills. With a group selected, two explicit **Enable** /
**Disable** buttons sit under its name and flip every member at once; groups over 20 members ask
first.

**Auto group** buckets the current inventory on two axes: role first (always-on layer vs per-task),
then topic (context, interface, media, research,
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

- Only user skill roots are scanned; a workspace's `.dsh/skills` belongs to that workspace, not to
  the installation, and is not switched from here
- A server on SSE cannot be tested from the panel (stdio and streamable HTTP can)
- No terminal UI; the panel is a Web / Desktop extension

## Importing dshmarket groups

`dshmarket` stores its groups in `<profile>/.dsh-market/state.json`. When that file has groups, the header shows an import button: the panel maps each package name to the loader rows it installed and copies the groups in. A group whose name is already used here is skipped rather than merged, so a second import never duplicates or reshuffles anything you edited in between. Uninstalled packages are listed per group and skipped; the file itself is only read.

## Living next to dsh-skill-mcp-panel

Both panels read the same truth — skills are files, MCP servers are rows in the patch — so state does not need syncing; writing at the same time is the real risk. When that panel is installed and enabled, this one takes the same `<patch>.panel.lock` before rewriting the patch (exclusive create, 30s stale takeover, 5s wait) and shows a **Compat** badge in the header. Its tool deny list is merged read-only (union) and its file is never written. Reads never take the lock, so listing and the snapshot stay wait-free.
