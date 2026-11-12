# Changelog

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
