# Changelog

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
