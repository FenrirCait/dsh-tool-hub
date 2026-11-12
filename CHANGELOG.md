# Changelog

## 1.6.8

- Auto grouping now makes three buckets and stops guessing: **official** (anything that ships with the
  client), **always-on base** (third-party rows whose text reads like a layer: context, memory, market,
  sidebar, runtime…), and **unsorted** — everything else, skills included. Topic words are still shown as
  chips on each group, but they no longer decide the group.
- Inside a group the list sorts by what you came to do: switched-on first, then plugins, MCP servers and
  skills, then by name.
- Dragging a group works again. The rail now renders the stored order (it used to re-sort by size, so a
  drop was written and then ignored), and the insertion line is painted straight onto the row instead of
  going through React state, which cancelled the drag mid-gesture.
- Each group also has ↑ / ↓ buttons that move it inside its section — same write, reachable without a
  pointer.
- Applying auto grouping drops leftover automatic groups from the old taxonomy instead of leaving them in
  the rail next to the new ones.

## 1.6.6

- Fewer, heavier buckets: a topic with one or two rows is folded into that role's catch-all instead of
  taking a line of its own, and each role now reads biggest-first.
- Automatic buckets that collapse to the same role + name are merged on load, so a leftover pair from an
  earlier apply cannot show up as two identical rows.
- The rail is resizable — drag the divider (180-460px), double-click to reset; the width survives reloads.
- Dragging a group shows where it will land: a brand-coloured line on the half of the target row the
  pointer is over, instead of only dimming the row you picked up.
- The rail is resizable: drag the divider (180-460px), double-click to reset; the width is remembered
  across reloads.
- Dragging a group now shows where it will land — a brand-coloured line on the half of the target row
  the pointer is over — instead of only dimming the row you picked up.

## 1.6.2

- Fixed groups disappearing when two of them share a name. Identity is the group id, which matters now
  that the same topic can appear once under always-on and once under per-task.
- The tag chips no longer repeat the role that the section header already states.

## 1.6.1

- The auto-grouping preview labels every bucket with its role (always on / per task / skills), so the
  split you are about to apply is readable before it is written, not only in the rail afterwards.

## 1.6.0

- **Auto grouping now separates "always on" from "per task".** The first axis is role: official
  infrastructure and anything whose name/description reads like a layer (context, session, sidebar,
  theme, market, runtime, tools) lands under **always on**; everything whose text reads like a job
  (generate, search, crawl, convert, render, notify) lands under **per task**. The second axis is
  the topic it belongs to. Classification is scoring, not first-match, so a module that hits
  several topics no longer lands wherever rule order happened to put it.
- **The rail groups by role.** Two labelled sections, always-on first, so the difference is visible
  without reading names. Switching off a whole always-on group always asks first, whatever its size.
- **Groups carry tags.** The signal words that decided the classification are stored with the group
  and shown as small chips, so "why is this here" is answerable from the row itself.
- **Drag to reorder.** Dropping a group in front of another moves it there, across sections too; the
  order is written to state.json and survives a restart. An op that is rejected leaves the order
  untouched (the list re-reads the snapshot).

## 1.5.0

- **Compatibility with dsh-skill-mcp-panel is detected, not configured.** Both panels read the same
  truth — skills are files, MCP servers are rows in the profile patch — so the only way they can
  hurt each other is by writing at the same moment. When that panel is installed and enabled, this
  panel now takes the same `<patch>.panel.lock` (exclusive create, 30s stale takeover, 5s wait)
  before rewriting the patch, and shows a small **Compat** badge in the header. Its tool deny list
  stays read-only here and is merged as a union; its file is never written.
- Releasing the lock is unconditional: a failed write, a rejected op, or a crash during the write
  all remove the file in the same `finally`.
- The lock is only taken while writing the patch, never while reading, so listing and the snapshot
  stay wait-free.

## 1.4.0

- **Groups can be imported from dshmarket.** `dshmarket` keeps its groups in
  `<profile>/.dsh-market/state.json`, as a name-to-package list. The import button in the header
  (only shown when that file actually has groups) copies them in, mapping each package name to the
  loader rows it corresponds to. A group whose name is already used here is skipped, never merged,
  so importing twice does not duplicate or reshuffle groups you edited in between. The file is read
  and never written.
- Packages listed in a dshmarket group but not installed here are reported per group instead of
  being silently dropped; the group is still imported with the members that do exist.

## 1.3.1

- **A preset now replays its tool masks in one press.** Applying a preset used to compute the mask
  from the tools that exist right now, so a preset whose MCP servers were switched off found no
  tools to compare against, masked nothing, and only worked when applied a second time — after the
  servers had come back. A preset now records the deny list alongside the enabled list, and that
  list is name-based: it applies even while the servers it mentions are off, and takes effect as
  their tools register.
- Presets saved before this change carry no deny list; they are applied the old way and, if the
  tools were not there yet, retried once when they appear. Nothing is masked for presets that were
  never about tools.

## 1.3.0

- **Test a server before you trust it.** The MCP edit dialog has a *Test* button: it starts the
  server exactly as configured, runs `initialize` and `tools/list`, reports how many tools came back
  and how long it took, then kills the process. It tests the values **as they sit in the form**, so
  a draft that was never saved can be tried first.
- **Nothing is registered or written by a test.** The probe is a throwaway client in this plugin; it
  does not touch the host's MCP client, does not add tools to any session, and does not modify
  `cordis.patch.yml`.
- Failures are reported in place, with the reason: a command that cannot start, a server that exits
  before answering (last lines of stderr included), a server that does not answer within 12 s, or a
  transport this panel cannot probe (SSE). The process tree is killed on timeout, so a hung `npx`
  wrapper does not survive the dialog.

## 1.2.1

- **Per-tool switches for MCP servers.** Each server row now opens a tool list: unchecked tools are
  masked out of the model-visible tool table for every session of this install, not merely blocked
  when called. The mask is installed per agent (a context-global restriction is refused by the
  host), with re-entrancy guards so `tools/change` cannot loop.
- **The mask is ours, and only ours.** It lives in this panel's `state.json` (`toolDeny`), never in
  another panel's file. If dsh-skill-mcp-panel is installed too, both masks apply and the union
  wins; its entries are shown read-only per tool, and one button imports them into our list.
- **Presets gained a fourth dimension.** A preset now records which tools were on. Presets saved
  before 1.2.0 carry no tool list and leave tools untouched, so an old preset never re-enables a
  tool you switched off by hand.

## 1.1.0

- **Presets cover MCP servers, and say so.** A preset already stored every enabled entry, MCP
  servers included; now the preset row shows how many of its entries are MCP servers, and the
  confirmation before a big apply spells out how many servers it will start and stop.
- Applying a preset still leaves the panel itself alone, and still never touches entries the host
  manages.

## 1.0.0

First stable release: plugins, skills and MCP servers in one panel.

- **MCP servers have their own view.** A server shows its name, transport and start command, and
  switches on and off through the same loader mechanism as any other entry, so a save needs no
  restart.
- **You can add and remove MCP servers from the panel.** The create dialog validates the server
  name while you type, asks only for the fields the chosen transport uses (stdio: command, args,
  env, cwd — HTTP/SSE: url, headers), keeps advanced options behind a fold, and writes a new
  `@deepseek-ai/dsh-mcp-client` entry to the profile's `cordis.patch.yml` — disabled by default.
  Deleting asks once and removes exactly that entry.
- **Editing rewrites only that entry's `config:` block.** Every other byte of the file, including
  comments, neighbour entries and the entry's own `disabled:` line, stays exactly as it was, and the
  host's HMR watcher picks the change up on save.
- **Group dots carry size.** The marker next to a group name takes a colour per order of magnitude
  (few → blue, then green, amber, red), so a rail of groups reads by weight at a glance.
- Dialogs got their contrast back: a disabled primary button is readable instead of white on white,
  and the name rule stays neutral until the name is actually invalid.

## 0.4.3

- The MCP server dialog gives its fields the full dialog width: a Windows start command or a long
  argument list was being clipped to a few characters, and the args / env boxes now fit three lines
  before they scroll.

## 0.4.1

- Saving an MCP server no longer drops the entry's `disabled:` line. The rewrite ends where the next
  key of the same entry begins, not at the next non-blank line, so turning a server off stays off.

## 0.4.0

- MCP servers are part of the panel. They show up as their own view with the server name, transport
  and command, they switch on and off through the same loader mechanism as any other entry, and the
  config dialog edits the `config:` block of that entry in the profile's `cordis.patch.yml` — only
  that entry's bytes are rewritten, everything else in the file stays exactly as it was, and the
  host's own HMR watcher picks the change up on save.
- Auto grouping leaves MCP entries alone: a server is not a feature to sort, it is a connection you
  turn on when you need it.

## 0.3.6

- The whole panel carries colour instead of reading grey-on-grey: the header shows its counts as
  green / amber / neutral pills, the selected view is a brand tab, kind and origin badges are
  tinted pills (blue plugin, amber skill, green official, amber host-managed), and every
  auto-generated group gets an accent dot that cycles through brand, success, warn and danger.
- Row state follows the same palette: enabled is green, disabled is neutral grey.

## 0.3.4

- The selection UI carries colour now: picked rows get a brand tint and a brand border, the
  selection bar is a brand-tinted strip, the count is a brand pill, and its actions are chips —
  green Enable, red Disable, brand Add to group, neutral Clear. Row and group actions share one
  chip component, so every button in the panel speaks the same colour language.

## 0.3.3

- Rename and Delete on a group are no longer faded icons at rest: both are 22px buttons with a
  visible border, Rename darkens to the primary label colour on hover, and Delete turns red.

## 0.3.2

- The group rail reads at a glance now: group names use the primary label colour at 14px, the
  member count is a pill instead of faint grey text, an auto-generated group carries a brand dot,
  and the selected group gets a brand tint plus a left accent bar.
- Enable / Disable are chips: Enable is tinted with the success colour, Disable stays neutral and
  darkens on hover. Both tints are `color-mix` over theme tokens, so they follow light and dark
  themes instead of hard-coding a colour.
- Screenshots are out of the README until the interface settles; `screenshots.json` went with them.
  The market listing will pick images up again once they are stable enough to stop re-shooting.

## 0.3.1

- Group rows carry explicit **Enable** / **Disable** buttons under the group name instead of
  hover-only arrows, and the name is larger — a bulk switch nobody can find is a bulk switch that
  does not exist.
- The plugin detail page now shows a real document. `meta.detail` is a path, not prose: the host
  read our sentence as a file name and answered "the plugin declares an invalid details file".
  It now points at `detail/zh.md` / `detail/en.md`, both shipped in the package.

## 0.3.0

- Every row now says where it came from: `@deepseek-ai/*` packages and the loader's own `cordis:`
  entries carry an `Official` badge, third-party installs do not, so a 200-row list can be read at
  a glance instead of by module-name guessing. Skills are never official — the panel only scans
  user roots.

## 0.2.0

- The panel refuses to switch itself off, and says so on its own row with a `This plugin` badge.
  A panel you can disable from inside itself is a one-click dead end.
- Applying a preset no longer touches the panel's own entry, even when the preset predates it.
- First run: an empty group rail now explains what auto grouping does and offers the button,
  instead of showing an empty column next to 200+ rows.
- README: how to keep a throwaway profile isolated (`TOOL_HUB_STATE_FILE`, `TOOL_HUB_SKILL_ROOTS`).

## 0.1.1

- `TOOL_HUB_STATE_FILE` and `TOOL_HUB_SKILL_ROOTS` so a test profile can point the panel at
  disposable stores instead of the user's real ones.

## 0.1.0

- One list for plugins and skills, per-row switches, groups with bulk enable/disable,
  presets, rule-based auto grouping, and two entry points (Plugins tab + sidebar panel).
