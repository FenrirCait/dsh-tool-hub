# Changelog

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
