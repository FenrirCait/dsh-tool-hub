# Changelog

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
