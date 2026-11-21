**English** · [简体中文](README.zh.md)

# dsh-tool-hub

One panel that lists the **plugins**, **skills** and **MCP servers** an installation actually runs,
lets you switch them on or off one by one, keeps them in **groups** you can flip as a unit, and
stores whole **presets** of "what is on right now".

It shows up twice: as a **Hub tab** on the Plugins page, and as a **sidebar panel** of its own.




## Why

Disabling a plugin normally means digging through a profile's patch file, and skills are switched
by renaming a `SKILL.md` by hand. Deciding "which of my 200 modules do I need for writing, which for
coding" is a per-profile chore nobody wants to repeat. The hub turns that into one list with
switches, groups, and presets.

## Install

From a git checkout or a local folder:

```bash
dsh plugin install FenrirCait/dsh-tool-hub
# or, from a local copy
dsh plugin install ./dsh-tool-hub
```

Then open **Plugins → Hub**, or the **Tool Hub** entry in the sidebar. A restart is not required;
the plugin hot-loads.

The package also ships the official `compat/codex-ui-glass/` compatibility pack. It is discovered
directly from the installed package and appears in **Extensions** without copying; enable it there
to make the panel, dock button and sidebar entry follow codex-ui's mica/flat glass settings. It is
off until you turn it on.

## What it does

- **One list** of every loader entry plus every skill found under the known skill roots. Each row
  shows what it is, whether it is on, and why it cannot be switched when it cannot. Rows that ship
  with the client (`@deepseek-ai/*`, `cordis:*`) carry an **Official** badge, so built-in and
  third-party modules are told apart at a glance.
- **Per-row switch**. Plugins go through the host's own plugin manager, so enable/disable is written
  to the profile patch exactly as the Plugins page would write it. Skills are switched by renaming
  `SKILL.md` ↔ `SKILL.md.disabled`.
- **A tree, not a wall of repeats**: a plugin that mounts several loader entries — or ships a
  sub-package such as `billion-context/dsh-compaction-gate` — is one row you unfold; the parent
  carries the module name, `×n` and a switch that flips the whole set. Groups follow the parent,
  so a group never holds half an install.
- **The rail shows on 全部 only**: picking 插件 / 技能 / MCP gives the list the full width.
- **Labels are the package's own `keywords`**, up to four. Nothing inferred is shown as a label;
  the topic words we guess only make rows findable in search.
- **Live counts**: every group shows `on/total`. The drawer header carries no sum on purpose — a
  package may sit in two groups, and a number that counts it twice is worse than no number.
- **Three facet rows**, all read from the install itself: **Origin** (Official / Third-party /
  Skill / MCP, from the module name), **Shape** (Has UI / Headless, from `dsh.client` and
  `dsh.bundle` in the package's own `package.json`), and **Word** (only keywords that at least two
  packages declare). They filter and own no switch, and nothing is inferred from a description, so a
  package never vanishes because we guessed its topic wrong. Groups no longer carry chips.
- **A pinned foot**: 新建分组 and 新建分组群 stay at the bottom of the rail; only the middle scrolls.
- **Shift-click selects a range**, like a file manager, with a collapsed module contributing all of
  its entries.
- **Rows drag into groups**: select rows, drop them on a group, and the package tree expansion
  applies (`group.add`).
- **Groups**: create, rename, delete, add the current selection, and flip a whole group on or off.
  A bulk flip asks first when the group is large, when it is a base bucket, or when some members
  also live in another group: it names those members and offers *only what this group owns* or *all
  of them*. Base and official members turn red with "存在基础插件，禁用可能导致界面异常。"
- **Undo and failures**: flipping a group off leaves a ten-second undo bar. Rows the host refused
  keep a red `!`, and the toast reports both numbers instead of only the successes. A group that
  still lists an uninstalled plugin shows `n gone` and cleans them on click.
- **Auto grouping**: one button proposes exactly four buckets — **官方** (ships with the client),
  **MCP 服务器**, **第三方底座** (third-party rows that read like a layer: context, memory, market,
  sidebar, runtime…), and **用户下载** (everything else, skills included) — previewed before anything
  is written. The first three land inside **默认分组群**; 用户下载 starts with no collection. Chips under
  a group name are the package's own `keywords`, and nothing else; no keywords means no chips.
  Applying it replaces only the previous automatic groups (including leftovers from older
  taxonomies); hand-made groups are left alone.
- **Drawers**: collections are collapsed by default and hold the groups you file into them. Drag a group
  onto a drawer to file it, drag it onto 未入群 to take it out; 新建分组 lands in 未入群, 新建分组群 adds a
  drawer. Deleting a drawer moves its groups back to the default one.
- **A rail you can shape**: the divider between rail and list drags from 180 to 460px (double-click
  resets, the width survives reloads), dragging a group shows a line where it will land, and ↑ / ↓ move a
  group inside its drawer without a pointer. The rail honours the stored order, so a move sticks. Inside a
  group the list sorts switched-on first, then plugins → MCP servers → skills, then by name.
- **Motion**: rows, switches, chips and dialogs fade in over ~150ms, and every one of those animations is
  switched off under `prefers-reduced-motion: reduce`.
- **Presets**: save the current set, then apply it later. `Apply` switches on what the preset lists
  and off what it does not; `Only switch on` never turns anything off. Big changes ask first.- **MCP servers** get their own view: name, transport and command per row, the same switch as every
  other entry, and an edit dialog for that server's `config:` block in the profile's
  `cordis.patch.yml`. Only that entry's bytes are rewritten — the rest of the file is untouched —
  and the host's HMR watcher reloads it on save. A **Test** button in that dialog starts the server
  as currently typed (saved or not), runs initialize + tools/list, reports the tool count and how
  long it took, then kills the process — nothing is registered and nothing is written.

- **Tool-level masking for MCP servers.** Every MCP row has a **Tools** button listing that
  server's tools; unchecking one removes it from what the model can see in *every* session of this
  installation, not just from the UI. The host only supports this through a scoped tool restriction,
  so the panel mounts a tiny per-agent plugin that calls `tools.restrict`/`undo` — and it re-applies
  only when the usable set actually changes, because a restriction that re-fires on every
  `tools/change` drives the host into a loop. The deny list lives in the panel's own state, never in
  the MCP server's `config:`; if another panel also denies tools, both layers apply (the union wins).
- **Import groups from dshmarket.** If `<profile>/.dsh-market/state.json` has groups, a header
  button copies them in, mapping package names to the rows they installed. Same-name groups are
  skipped, never merged; uninstalled packages are reported per group. That file is only read.

Everything the panel writes about *groups and presets* lives in one file:

```
<DSH_HOME>/tool-hub/state.json      # defaults to ~/.dsh/tool-hub/state.json
```

Writes are atomic (temp file + rename), so a crash mid-save cannot leave a half-written state.

## Skills

Skills come from three kinds of roots: `~/.dsh/skills` (**全局 · 用户**), `~/.agents/skills`
(**全局 · 共享**), and every workspace the host knows (**<workspace name>**, from
`<workspace>/.dsh/skills`). The Skills tab groups its rows by scope, so a workspace skill is never
mistaken for one that exists everywhere.

`TOOL_HUB_WORKSPACES` pins the workspace list: `;`-separated paths, and `-` turns workspace discovery
off (the sandbox profile uses that to stay isolated).

- **预览** reads the skill's source file, read-only, first 200 KB.
- **删除** moves the whole skill folder (or a single `.md`) into
  `<state dir>/trash/<timestamp>-<name>/`; a `meta.json` records the root and relative path it came
  from. The toast keeps a **撤销** for ten seconds, and that undo is a move back — nothing is erased.
- **导入技能** takes a local path: one `.md`, a directory, or a `.zip`. Pick the target root and
  whether a skill of the same name may be overwritten. The zip reader refuses entries that escape the
  archive and never follows a link out of it.
- **移动到…** relocates a skill to another root. A destination that already exists is refused, never
  merged; the skill's switch is not touched.

## Lazy MCP tools

A server can be marked **Lazy** on its row. Its tools then stay out of the model-visible schema, and a small `hub_tools` tool carries the catalog: `action="list"` shows which servers are lazy and which of their tools are loaded, `action="enable"` takes `names` or a `server` and makes those tools callable from the next turn, and `action="disable"` puts them back. The panel adds one paragraph to the system prompt while any server is lazy, otherwise nothing.

Why client-side: the MCP client always advertises every tool it knows, so the only lever a panel has is the tool mask. Masked tools leave the request entirely (not merely blocked), which is what saves context. Servers that implement lazy startup themselves (for example Computer Use with `WCU_TOOL_MODE=lazy`) do not need this switch.

## MCP servers

- **Secrets stay on the host.** `env` and `headers` values come back empty; `secretKeys` says which
  keys are set, and the dialog prints "已设置，留空保持不变" under each one. Saving with the field
  blank keeps the stored value. A blank key that was never set is refused, so a typo cannot create an
  empty credential.
- **`${NAME}` templates.** A value written exactly as `${NAME}` is stored as the loader's environment
  reference (`!!js process.env.NAME`), not as text. The panel never reads or expands it.
- **查看原文** shows the exact patch fragment for one server, read-only. **高级：直接编辑** replaces
  that whole entry — indentation, fields and formatting included — after a warning and a save-time
  parse check.
- **OAuth 登录** works for a saved HTTP or SSE server. Discovery tries the protected-resource metadata
  (RFC 9728), then the authorization-server metadata (RFC 8414), then OIDC; an issuer mismatch is
  refused rather than used. The flow uses PKCE and the RFC 8707 `resource` parameter. The panel shows
  the authorize URL and asks for the `code` carried by the address the redirect lands on.
- **Tool-level masking** is unchanged: 工具 lists the server's tools and unticking one removes it from
  every session of the installation; the deny list stays in the panel's state, never in the server's
  `config:`.

## CLI

The package ships `dsh-tool-hub`, a Node CLI over the same state and patch files, for scripts and for
a machine with no panel open:

```bash
dsh-tool-hub list --json
dsh-tool-hub plugin disable <entryId>
dsh-tool-hub group off "写作"
dsh-tool-hub skill list --workspace .
dsh-tool-hub mcp raw <serverName>
dsh-tool-hub config export ./tool-hub-backup.json
```

- **22 commands** over seven families: `list`; `plugin enable|disable`; `group list|on|off`;
  `preset list|apply`; `skill list|enable|disable|delete`; `mcp list|enable|disable|raw`;
  `config export|import`. Every read and write accepts `--json`.
- `--profile <name>` picks the profile (default `web`); `--workspace <path>` adds that workspace's
  `.dsh/skills`; `--global` keeps `skill` to the global roots.
- `preset apply` is exact by default — rows a preset does not name are switched off — and
  `--only-enable` only turns things on. The panel's own row is never switched off in bulk.
- `config export` must land inside `$DSH_HOME` or the working directory (no symlink on the way);
  `--mkdir` creates a missing parent, `--force` widens the roots.
- `config import` merges by default. `--replace --yes` replaces the whole state, and a backup of the
  previous state is written first.
- Exit codes: `0` success, `1` usage, `2` not found, `3` validation failure.

## Diagnostics and history

- A row whose module failed to load carries a red bar down its left edge. **看诊断** opens that row's
  `diagnostic` text; when the host sent none, the dialog says so instead of showing an empty box, and
  points at the host log and the patch parse.
- The `doctor` host op answers six checks, each by trying it: `patch-parse`, `state-writable`,
  `failed-rows`, `stale-lock`, `skill-roots`, `trash`. One failing probe never hides the others.
- Every panel op appends one line to `<state dir>/history.jsonl` — timestamp, op, short ids, ok.
  Payloads are not copied, because a payload can carry skill text, tokens or a whole config. The file
  is trimmed to its tail once it grows past the cap; **历史** lists the newest entries first.

## Bundle view

**按 bundle** turns the left rail into the bundles the host reports (`pluginManager.listBundles()`),
each with its own row count. Picking one filters the list to the rows that bundle owns; **全部** drops
the filter. It is a lens, not a switch: nothing is enabled or disabled, and a host without
`listBundles` disables the button instead of failing the snapshot.

## Config export and import

**导出配置** downloads one JSON file with `groups`, `collections`, `presets` and `toolDeny` — nothing
that names a machine path or a credential. **导入配置** merges by default: a group with the same id
gains the incoming members, a group whose name is already used here is kept as it is, and a preset
with an existing name is skipped. Replace mode throws the current state away, so it is confirmed
first. The CLI writes a backup of the previous state; the panel's import does not.

## Row descriptions

**显示简介** adds one line under each row. For plugins and MCP rows the line comes from the first
source that has one: the row's own `meta.description`, the package's `package.json`, a small
known-package table, then nothing. The panel records which link answered instead of guessing, so a
missing line is diagnosable. Skills use their own `description` frontmatter field and nothing else.

## Help drawer

The `?` button opens eight short sections — what it solves, how to use it, one caution.
It opens by itself the first time (`localStorage toolHubHelpSeen` remembers that it has been seen) and
only on demand afterwards. Long-form documentation stays on this page; the drawer is the in-place
reminder.

## Layout

The panel is pinned to the viewport: `maxHeight: calc(100vh - 120px)` and `overflow: hidden` on the
shell, a header and tab row that stay put, and a rail that is sticky at the top. Only the list
scrolls, so a long install no longer takes the header, the tabs or the rail out of reach. The
remembered tab (`localStorage toolHubView`) still decides which tab opens.

## Collections

Hand-made groups live in **collections**. A fresh install has one, **默认分组群** (default); the
**+ 新建分组群** button at the bottom of the rail adds more, and each one can be renamed or deleted from
its header. A collection only shelves groups — switching a group still switches exactly its members.
Deleting a collection moves its groups back to the default one instead of destroying them.

**Automatic grouping** now produces four buckets, in this order: **官方** (ships with the client),
**MCP 服务器** (the client's own MCP entries), **通用** (third-party entries that sit under everything:
context, memory, market, sidebar…), and **用户下载** (everything else you installed for a job). The role
is decided from the module name, the row's meta, and the description keywords; ties go to 用户下载, and
the buckets carry the top topic words as chips so a bucket still says what is inside it.

## What it does not do

- **MCP servers** are supported for the STDIO / SSE / HTTP shape the host's own MCP client uses.
  Anything a server keeps inside its own process is still that server's business.
- **Skills outside the known roots** are not scanned: `~/.dsh/skills`, `~/.agents/skills`, and the
  `.dsh/skills` folder of each workspace the host reports (or `TOOL_HUB_WORKSPACES` names). A project
  folder that is not a known workspace is still just a folder.
- **Host-managed entries** (the plugin manager itself, the timer, the tool registry, …) are shown but
  cannot be switched. The host reports them as `management-required` or `unaddressable`; the row says
  so instead of hiding them.
- **No terminal UI.** The panel is a Web/Desktop extension.

## How switching actually works

| Kind | Mechanism | Where the change lands |
| --- | --- | --- |
| Plugin | `pluginManager.setPluginEnabled(entryId, enabled)` | the profile patch file |
| Skill | rename `SKILL.md` → `SKILL.md.disabled` (and back) | the skill folder |

Both are reversible from the same row. A plugin switch can answer `restart-required`, `overridden`,
or `failed`; the panel reports what the host answered instead of assuming success.

### Testing in a throwaway profile

By default the panel keeps its groups and presets in `<DSH_HOME>/tool-hub/state.json` and switches
skills under `<DSH_HOME>/skills` and `~/.agents/skills`. A test profile usually wants neither, so
three environment variables point it somewhere harmless:

```bash
TOOL_HUB_STATE_FILE=<dir>/tool-hub-state.json     # groups, presets, auto-group records
TOOL_HUB_SKILL_ROOTS=<dir>/skills;<dir>/skills2   # skill roots, separated by ; on Windows
TOOL_HUB_WORKSPACES=<dir>;<dir2>                  # workspace roots; "-" disables workspace discovery
```

With all three set, trying out a bulk disable in a sandbox touches only the sandbox.

## Development

```
lib/index.js        host half: snapshot, ops, HTTP routes (/tool-hub/api/*)
client/client.js    client half: one hand-written ModuleLoader bundle, React only
locale/{zh,en}.json plugin metadata shown on the Plugins page
cordis.patch.yml    the bundle insert
probe/host-smoke.mjs  28 assertions against a temp DSH_HOME and a fake plugin manager
```

```bash
node --check lib/index.js
node --check client/client.js
node probe/host-smoke.mjs
```

The HTTP surface is two exact routes on the host's own web server — `GET /tool-hub/api/snapshot`
and `POST /tool-hub/api/op` — guarded by the same origin check the bundled market uses.

## License

MIT
- Rows in a group carry a "move out" action (also on the selection bar): it drops the member from that group only, leaving switches and the group itself alone.
- Presets can be refreshed in place: "Update" overwrites the named preset with what is on right now, after a confirmation.

## Built-in UI rows are read-only

Some official rows ship inside the client's own UI bundle. The client does not let a profile override them, so the panel marks them **Built-in UI** and disables their switch; a direct API call is refused with `builtin-ui` and nothing is written. Everything else official (host-side entries, MCP clients) stays switchable. This only changes what this panel shows and refuses — the client, the profile patch and other tools are untouched.

## One switch for everything third-party

The toolbar has a red **Turn off third-party** button. It only flips switches - nothing is uninstalled - and it leaves official and host-managed rows alone. Before touching anything it writes a rollback point to `<state dir>/rollback/<timestamp>.json`.

The confirmation lists every plugin, MCP server and skill that will be turned off, groups them, and paints always-on or interface-level plugins red with the line "N of them are always-on or interface plugins, so the UI may break." You must tick "I understand the interface may break, and the rollback point is saved" before the button enables.

Afterwards a **Restore** button appears and re-opens exactly what the rollback point recorded (also confirmed once). Switching is per-entry and restarts the host each time, so a full sweep takes 30-60 seconds: the buttons grey out and say "Working..." meanwhile.

The panel never turns itself off, otherwise nothing would be left to restore with.

## Filters that show their work

Every tab keeps the rail, because that is where the filters live. Each chip shows how many rows it would leave (`Official 205`, `With a UI 81`), the active one is a solid pill, and a bar above the list says what is currently narrowing it - `Filtered: view Plugins · origin Official · shape With a UI` - with a `Clear filters` button.

Shape is only offered where it applies: the Skills and MCP tabs keep origin and drop shape.

Official packages ship inside the client rather than a profile, so their manifests were invisible to the panel and every official row vanished under either shape filter. The manifest lookup now covers the profile, the packaged app's own `node_modules`, and a source checkout, and rows that point at a subpath are resolved through their package root.
