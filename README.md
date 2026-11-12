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

## What it does

- **One list** of every loader entry plus every skill found under the user skill roots. Each row
  shows what it is, whether it is on, and why it cannot be switched when it cannot. Rows that ship
  with the client (`@deepseek-ai/*`, `cordis:*`) carry an **Official** badge, so built-in and
  third-party modules are told apart at a glance.
- **Per-row switch**. Plugins go through the host's own plugin manager, so enable/disable is written
  to the profile patch exactly as the Plugins page would write it. Skills are switched by renaming
  `SKILL.md` ↔ `SKILL.md.disabled`.
- **Groups**: create, rename, delete, add the current selection, and flip a whole group on or off.
  Groups over 20 members ask first.
- **Auto grouping**: one button proposes groups from a rule table (core / interface / media /
  research / dev / integrations / skills), previewed before anything is written. Applying it replaces
  only the previous automatic groups; hand-made groups are left alone.
- **Presets**: save the current set, then apply it later. `Apply` switches on what the preset lists
  and off what it does not; `Only switch on` never turns anything off. Big changes ask first.
- **MCP servers** get their own view: name, transport and command per row, the same switch as every
  other entry, and an edit dialog for that server's `config:` block in the profile's
  `cordis.patch.yml`. Only that entry's bytes are rewritten — the rest of the file is untouched —
  and the host's HMR watcher reloads it on save.

Everything the panel writes about *groups and presets* lives in one file:

```
<DSH_HOME>/tool-hub/state.json      # defaults to ~/.dsh/tool-hub/state.json
```

Writes are atomic (temp file + rename), so a crash mid-save cannot leave a half-written state.

## What it does not do

- **MCP servers** are supported for the STDIO / SSE / HTTP shape the host's own MCP client uses.
  Anything a server keeps inside its own process is still that server's business.
- **Skills outside the user roots** (`~/.dsh/skills`, `~/.agents/skills`) are not scanned. Project
  level `.dsh/skills` folders belong to a workspace, not to an installation, and switching them here
  would be misleading.
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
skills under `<DSH_HOME>/skills` and `~/.agents/skills`. A test profile usually wants neither, so two
environment variables point it somewhere harmless:

```bash
TOOL_HUB_STATE_FILE=<dir>/tool-hub-state.json     # groups, presets, auto-group records
TOOL_HUB_SKILL_ROOTS=<dir>/skills;<dir>/skills2   # skill roots, separated by ; on Windows
```

With both set, trying out a bulk disable in a sandbox touches only the sandbox.

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
