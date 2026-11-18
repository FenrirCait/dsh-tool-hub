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



- **Apply** — turns on what it lists and off what it does not
- **Only switch on** — adds, never removes

Changes over 10 rows ask first.


**Modes** are a different thing: they decide which entries a new session is assembled from, and the unit is a
declaration row in the profile `cordis.patch.yml`, not a folder. You can create one, delete one, or press
**Choose contents** to tick the plugins and MCP servers it should declare. The write touches only that row's
`plugins` list; entries that were already there keep their original config and comments. Rows the host itself
write is backed up to `~/.dsh/backups/` and verified against the registry, rolling back on failure.

## Built-in UI and the third-party switch

Official rows that ship inside the client's own UI bundle carry a **Built-in UI** badge and a disabled switch: the client does not let a profile override them, and the panel refuses to write. A refused toggle reports the reason instead of a bare "failed".

**Turn off third-party** only flips switches; it writes a rollback point to `<state dir>/rollback/<timestamp>.json` first, and a **Restore** button appears afterwards.

## Where state lives

```
<DSH_HOME>/tool-hub/state.json     defaults to ~/.dsh/tool-hub/state.json
```

Writes are atomic (temp file + rename), so a crash mid-save cannot leave a half-written state.

A sandbox or test profile can keep everything disposable:

```
TOOL_HUB_STATE_FILE=<dir>/tool-hub-state.json
TOOL_HUB_SKILL_ROOTS=<dir>/skills:<dir>/skills2   # semicolon on Windows
```

## What it does not do

- Only known skill roots are scanned: `~/.dsh/skills`, `~/.agents/skills`, and the `.dsh/skills` of
  each workspace the host reports (or `TOOL_HUB_WORKSPACES` names)
- A server on SSE cannot be tested from the panel (stdio and streamable HTTP can)
- No terminal UI; the panel is a Web / Desktop extension

## Importing dshmarket groups

`dshmarket` stores its groups in `<profile>/.dsh-market/state.json`. When that file has groups, the header shows an import button: the panel maps each package name to the loader rows it installed and copies the groups in. A group whose name is already used here is skipped rather than merged, so a second import never duplicates or reshuffles anything you edited in between. Uninstalled packages are listed per group and skipped; the file itself is only read.

## Living next to dsh-skill-mcp-panel

Both panels read the same truth — skills are files, MCP servers are rows in the patch — so state does not need syncing; writing at the same time is the real risk. When that panel is installed and enabled, this one takes the same `<patch>.panel.lock` before rewriting the patch (exclusive create, 30s stale takeover, 5s wait) and shows a **Compat** badge in the header. Its tool deny list is merged read-only (union) and its file is never written. Reads never take the lock, so listing and the snapshot stay wait-free.

Hand-made groups live in collections: one 默认分组群 exists from the start, the rail bottom adds more, each can be renamed or deleted, and deleting one moves its groups back to the default drawer. Auto grouping produces four buckets: 官方 / MCP 服务器 / 通用 / 用户下载.

## Since 1.19

- **Skill scopes**: global user (`~/.dsh/skills`), global shared (`~/.agents/skills`), and each workspace's `.dsh/skills`; `TOOL_HUB_WORKSPACES` pins the list (`;`-separated, `-` disables it).
- **Preview / delete / restore**: preview is read-only (first 200 KB); delete moves the skill to `<state dir>/trash/<ts>-<name>/` with a `meta.json`, and the 10-second undo moves it back.
- **Import / move**: import a `.md`, a folder or a `.zip` into a chosen root (optional overwrite); move to another root, refusing an existing destination.
- **MCP secrets**: `env` / `headers` values never leave the host; `secretKeys` lists what is set, and a blank field keeps the stored value.
- **`${NAME}` templates**: a value that is exactly `${NAME}` is stored as the loader's `process.env.NAME` reference.
- **Raw and advanced edit**: the raw view is read-only; advanced edit replaces the whole entry after a warning and a parse check.
- **OAuth**: for a saved HTTP/SSE server, discovery PRM (RFC 9728) → AS (RFC 8414) → OIDC with PKCE and RFC 8707 `resource`; the panel shows the authorize URL and asks for the code the redirect carries.
- **CLI**: `dsh-tool-hub` has 22 commands over list / plugin / group / preset / skill / mcp / config, `--json` on reads and writes; `dsh-tool-hub list --json`.
- **Doctor and history**: six checks (patch parse, state writable, failed rows, stale lock, skill roots, trash); failed rows carry a red bar and 看诊断. Ops append one line to `<state dir>/history.jsonl`.
- **Bundle view**: the rail lists installed bundles and filters the list to one; a lens, never a switch.
- **Config export / import**: `groups` / `collections` / `presets` / `toolDeny` as one JSON; merge by default, replace confirmed, CLI backs up first.
- **Descriptions / help / layout**: meta → package.json → known table → empty; the eight-section help drawer opens once by itself; the shell is `calc(100vh - 120px)` with a fixed header and rail, and the list is the only scroller (`localStorage toolHubView` still remembers the tab).
