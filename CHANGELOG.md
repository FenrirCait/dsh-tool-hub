# Changelog

> Scope note: **1.x never shipped extension-pack management.** Early 2.0 alpha builds experimented
> with bundled packs; the final 2.0 manager ships no packs and reads the separate official catalog.

## 2.0.0-alpha.76

2.0 rewrite: the package is now a manager for a separate official-pack repository.

- No bundled `compat/` packs. Official packs are new in 2.0, read from the remote catalog, installed
  with explicit confirmation, verified (bytes + SHA-256), backed up and replaced atomically.
- Official packs can be installed, updated, uninstalled and batch-synced from the panel; uninstall
  is never part of a batch action.
- New in-panel `?` usage guide, dark/light theme, paged lists, sticky headers, deny reasons and
  per-turn lazy unload.
- Codex glass pack follows float/compat layouts, Clear/Standard/Frosted material presets and the
  floor-glow switch; panel dialogs and fields consume codex's own glass tokens.
- Fixes: dark primary buttons and count badges, white-on-white help dialog, stretched field inputs,
  rounded rail/main alignment, DSH dot-grid/wordmark ground.
- The usage-guide dialog uses codex's `--dsh-glass-card-raised` and `--dsh-glass-blur`, so its
  translucency follows the Clear / Standard / Frosted material preset too.

## 2.0.0-alpha.75

- The native usage-guide dialog follows dark mode (no more white-on-white) and uses a
  translucent glass surface with a lighter scrim so the page behind stays visible.

## 2.0.0-alpha.74

- Fix vertically stretched form inputs inside column fields (the `flex: 1 1 180px` basis applied
  to height), which made overlay dialogs enormous.

## 2.0.0-alpha.73

- Forced catalog refreshes bypass GitHub raw's CDN cache with a cache-busting query, so a
  newly pushed pack version is visible immediately.

## 2.0.0-alpha.72

- Remove the panel's brand dot; it read as a stray black blob in the sidebar.
- Glass compat pack 1.0.1: transparent panel background (the DSH wallpaper shows through),
  no painted sidebar-entry chip.

## 2.0.0-alpha.71

- The usage guide now uses a native top-layer `<dialog>`, so it opens centered with a readable
  backdrop even inside the host's transformed/glass containers.

## 2.0.0-alpha.70

- Official packs can be uninstalled from the manager: `compat.uninstall` backs up the local
  folder, removes it, drops the id from the enabled list and rebuilds; explicit confirmation.
- Added a "?" usage guide in both topbars, covering plugins, skills, MCP/tools, groups, presets,
  official packs, diagnostics and keyboard navigation.

## 2.0.0-alpha.69

- Official compat packs moved out of the package into a separate GitHub catalog
  (`FenrirCait/dsh-tool-hub-packs` by default). The package now ships only the manager.
- `compat.index` reads the catalog (raw, then jsDelivr mirror) with a configurable cache;
  `compat.install` downloads each file, verifies byte count + SHA-256, backs up an existing local
  copy and swaps it in atomically. URLs are HTTPS or loopback only.
- The manager lists remote pack versions beside installed versions, with install/update/enable
  and one batch confirmation; no auto-install or auto-update.

## 2.0.0-alpha.68

- Extensions gains an official compat manager above the list: bundled-only rows with pack/local
  versions, install/update/enable actions and one batch "安装/更新" confirmation.
- `extension.updateBundled` backs up the local pack to `backupDir()/extensions-<id>-<stamp>`
  before overwriting it from the package; the patch file is never touched.
- A local copy still reports the package version beside its own (bundledVersion), so updates are
  visible even when the local copy wins.

## 2.0.0-alpha.67

- A lazy-hidden row shows only '懒加载隐藏' + '固定'; the server's '懒加载' badge is not
  repeated when the primary badge already explains why the row is hidden.

## 2.0.0-alpha.66

- New setting `tools.lazyUnloadEachTurn` (off by default): at `agent/turn-stopping`, clear the
  current session's lazy loads only; global panel loads are untouched. The next turn starts with
  those tools hidden again.

## 2.0.0-alpha.65

- Tool rows no longer show two identical '懒加载' badges: the primary badge now reflects the
  effective state (可见 / 已屏蔽 / 懒加载隐藏), while install/lazy reasons are not repeated as
  separate reason badges. The server's lazy mode still shows once as '懒加载'.

## 2.0.0-alpha.64

- Snapshot revision now ignores the audit history written by every read and each session's
  moving `updatedAt`, so two reads of one state really return `unchanged`; real state changes
  still move the fingerprint.

## 2.0.0-alpha.63

- Extensions: detect local copies that shadow a bundled pack ('本地覆盖'), and add
  `extension.installBundled` + '复制到本地' (copy compat/<id> into the profile; never overwrite).
- Tools: search-term highlighting and keyboard navigation (arrow/home/end/escape) over rows.
- Snapshot: revision + GET `?since=` returns `unchanged` without a body; the client reuses its
  cached snapshot, while fresh refreshes stay full.
- Diagnostics: back up and clear a stale panel lock (`doctor.clearLock`, explicit confirm;
  the patch is never read or written), plus locate/copy details for patch-check failures.

## 2.0.0-alpha.62

- Extensions: source filter (all / from package / local) with counts; the bundled badge stays.
- Tools: every row carries denyReasons (install / scope / preset / onDemand / lazy) computed in
  the snapshot from the real mask layers and rendered as explanatory badges.
- Lists: expanded groups render 50 rows at a time with "Show more", resetting on a new search;
  group headers are sticky inside the scrolling content.
- Diagnostics: copy a full report (clipboard with fallback), reload one failed extension, or
  reload every failed extension; no automatic repair and no new host op.

## 2.0.0-alpha.61

- Extensions from the package's `compat/` are marked **From package / 来自插件包** in the
  Extensions page (status flag `bundled`, carried through the snapshot).

## 2.0.0-alpha.60

- `compat/` is now an extension root: official compat packs appear in **Extensions** straight
  from the installed package, with no profile copy. A profile copy still wins on an id clash.
- The pack stays opt-in; it is listed and loadable, not auto-enabled.

## 2.0.0-alpha.59

- Promote the codex-ui glass pack from `examples/` to the first-party `compat/codex-ui-glass/`
  directory; it ships in the npm tarball and is documented as an official compat pack.
- Add `compat/README.md` (official packs, opt-in install) and a pack-level changelog.

## 1.1.0

A maintenance pass: two bugs of our own, three mechanisms borrowed (with their traps written
down), and a size ratchet so the next person does not inherit a 4,000-line file by accident.

- Fixed: the tool mask used to lift the previous restriction before installing the next one. If
  `restrict()` threw, the agent was left with **no** mask while `applied` still claimed the old
  list was live. Restrictions intersect, so the new layer now lands first — the overlap
  over-denies for a moment, which is the safe direction.
- Session overlays: `state.sessions` holds per-session `mcp__*` denies, unioned with the
  installation list. Agents inherit along the session lineage (`parentSession`), which is how a
  subagent keeps its parent's switches; a broken lineage falls back to the installation list
  only. Ops `session.set` / `session.clear`, CLI `session list|set|clear`, snapshot exposure.
- Scenes: `scene.save` / `scene.apply` / `scene.exit` switch the whole tools + MCP environment.
  A missing section means "leave that domain alone", `[]` means "clear it" — one rule for both
  domains. The mode record (with a full snapshot) is written before anything changes, a failed
  apply restores the snapshot, and an incomplete restore says exactly which targets are still
  wrong instead of claiming success.
- Mount heartbeat: `apply()` drops `<state dir>/mount.json` (pid, host start, injects) from the
  REQUIRED inject callback, and `doctor` grew a ninth check that compares it with the live
  process. An inject name the host stops publishing used to make the plugin vanish silently.
- Op registry: 52 ops (48 dotted + `toggle`/`bulk`/`doctor`/`snapshot`) declare write / confirm /
  audit. Dispatch refuses unregistered ops and enforces the unconditional confirmation gates from
  the table; history entries carry the audit flag.
- Host contract: 11 services / 19 members, with the private `tools.view` marked and its fallback
  written down as a dead end — `definitions()` is post-restriction, so using it as mask input
  would make the mask lift itself.
- Panel: a failed snapshot offers Retry with `role="alert"`, empty states name the view and the
  next step, destructive icons stay red without hovering, and the MCP row badge matches the
  header's pill.
- Tooling: `probe/size-budget.mjs` enforces 1,500/3,000 lines and 80/150 KiB for hand-written
  source, with a baseline that only allows the two existing offenders to shrink; the repository
  got its first workflow. `.gitattributes` pins LF so a Windows checkout cannot rewrite a file.
- Probes: 11 suites, 833 assertions (host 339 · oauth 92 · skill-pack 73 · CLI 199 · mask 27 ·
  registry 16 · heartbeat 19 · contract 29 · client 8 · scene 31 · size budget green).
## 1.0.1

- Fixed: the two HTTP routes now ask the host first — `connection.requestRejection(request)` runs before anything else, so a browser without a DSH session (or a remote session the host policy refuses) gets `401`/`403` instead of reaching the panel API. A gate that throws refuses too (fail closed). Our own same-origin check stays as the second line of defence for hosts that expose no `connection` service.
## 1.0.0

The first release meant to be installed by somebody who did not build it. Everything below is in it:

- One panel for plugins, skills and MCP servers, reachable from the Plugins page and from the sidebar.
- Groups with four buckets (official / MCP servers / third-party base / user downloads), collapsible collections, drag order, shift-range selection and drop-to-group.
- Presets that store the whole switchboard (rows, MCP servers and the tool deny list) and can be applied exactly or additively.
- MCP servers: create/edit/delete rows in `cordis.patch.yml`, secrets masked and kept on blank, raw editing, a live `测试连接`, and OAuth (discovery, PKCE, resource indicators).
- Tool-level masking through scoped `tools.restrict`, with the panel's own deny list and a read-only import of the Skill/MCP panel's list.
- Lazy MCP servers: tools stay hidden until `hub_tools` enables them, with a prompt section that tells the model the catalogue exists.
- Skills: per-workspace scopes, preview, move, import from `.md`/folder/zip, delete into a trash you can restore from.
- `dsh-tool-hub` CLI for the same operations outside the panel, `doctor` with eight checks, configuration export/import, bundle view, history, and a kill switch that disables every third-party piece with one rollback point.

Measured on a 225-row, 33-bundle profile: warm snapshot 13–24 ms, `fresh` ≈ 800 ms (two host inventory calls at ~400 ms each), a toggle ≈ 1.6 s of which ~1.2 s is the host reloading the loader entry.
## 1.20.7

- Added: `doctor` now reports a ninth-listed check, `snapshot-profile`, with the per-step timings of the most recent profiled snapshot (or a note that no profile log exists yet).
## 1.20.6

- Changed: `thirdparty.status` no longer builds a whole snapshot to answer; it reads the plugin rows and skills it actually filters (1254 ms → 648 ms, most of the rest is the first uncached row read).
- Added: `pluginManager.listPlugins()` is memoised for 5 s and `listBundles()` for 60 s, both invalidated by writes. A warm snapshot is now 14 ms instead of ~800 ms.
- Fixed: a write only drops the row cache — the bundle list survives, because flipping a switch never changes which bundles exist. A toggle no longer pays a second 400 ms bundle listing.
- Added: `TOOL_HUB_PROFILE=1` writes per-step snapshot timings to `<state dir>/snapshot-profile.log`, so the next slow report can be answered with numbers instead of guesses.

Measured on the sandbox profile (33 bundles, 225 rows, Windows): `plugins=408 ms`, `bundles=401 ms`, everything else ≤2 ms; `snapshot?fresh=1` ≈ 800 ms, warm snapshot ≈ 14 ms, `toggle` ≈ 1.6 s (of which ~1.2 s is the host reloading the loader entry, not this plugin).
## 1.20.1

- Fixed: `hub_tools` never reached the registry — `register()` requires `output.render`, the registration threw, and the catch had no logger to warn into. It now ships a render function, resolves the service through both property and lookup forms, and falls back to `console.warn` so a failure is visible.
- Added: `doctor` reports `hub-tools`, so a missing catalog says so instead of failing silently.
- Fixed: the snapshot is cached for 1.2 s with single-flight, and every write invalidates on entry and exit; a click no longer rebuilds the inventory twice, and three parallel reads cost one build.
- Added: `GET /tool-hub/api/snapshot?fresh=1` for callers that must bypass the cache.
- Fixed: the fake MCP probe server answers `tools/call` instead of failing with `-32601`.
## 1.20.0

- Added: lazy MCP servers. A server marked lazy keeps every tool out of the model-visible schema; a small `hub_tools` tool lists the catalog and loads names or a whole server back on demand, and a one-paragraph prompt section tells the model the catalog exists.
- Added: the MCP row has a lazy toggle; the state lives in `tool-hub/state.json` (`lazyServers`, `lazyLoaded`), so a restart keeps the choice.
- Changed: the snapshot now reports the effective mask, so a tool hidden because its server is lazy reads as disabled instead of looking available.
## 1.19.10

- Added: `state.reset` needs `confirm: "reset"` and writes a copy of `state.json` to `backups/` first; the copy is pruned to the newest 20.
- Added: importing a config in replace mode needs `confirm: true` and keeps the same rollback copy; the dialog now shows a red warning and an acknowledgement checkbox before the button enables.
- Added: the same pruning applies to every state backup, so the folder cannot grow without a bound.
## 1.19.9

- Fixed: with a dialog open above the help drawer, the drawer still held its Tab trap, so keyboard focus could stay behind the dialog. The drawer now yields both Escape and Tab while a dialog is on top.

## 1.19.8

- Fixed: the confirmation dialog for a bulk selection of more than 20 rows crashed on render (the translated string was passed to `fmt` as the key, so it returned the vars object).
- Fixed: the help drawer and dialogs shared a z-index and both listened for Escape; the drawer now yields Escape while a dialog is open, sits below it, and traps Tab like the dialogs do.
- Fixed: the skill preview and MCP raw-text dialogs now reload when their row changes instead of showing the previous skill or patch.
- Fixed: busy state is an in-flight counter, so a finished request can no longer re-enable switches while another write is still running.
- Fixed: delete/import dialogs stay open when the host refuses the write, so the reason is not replaced by a vanished dialog.
- Fixed: host state transactions (group/preset/collection/tool/auto/market) are serialized; concurrent requests can no longer lose an update between load and save.
- Fixed: a third-party shutdown that turned nothing off no longer leaves a rollback point that restores nothing.
## 1.19.7

- Fixed: the shell takes a definite viewport height, so a percentage `height: 100%` can no longer collapse into `auto`. Expanding a drawer used to grow the rail past its cap, hide the two buttons under it and leave nothing scrollable.
- Fixed: the rail no longer fights the page with `position: sticky`; it stretches to the shell and only its middle list scrolls, while the footer stays pinned.
## 1.19.6

- Fixed: the header count of enabled items now includes MCP servers, so it matches the rows below (194 of 225, not 193).
- Fixed: dialogs keep keyboard focus inside themselves while open and return it to the button that opened them on close.
- Changed: transient notices (saved, imported, disabled) sit in a polite aria-live region, so a screen reader announces them instead of dropping them.
## 1.19.5

- Added: a shift-selection of more than 20 rows now asks before it flips them (group toggles already did).
- Changed: the delete-group dialog uses a verb for its button and prints the group name once.
- Changed: a group picker with no groups says so instead of borrowing the preset empty state.
- Fixed: 加载失败 / 面板已禁用 / 合并 / 替换 and three OAuth failure reasons were literal English inside a Chinese panel.
- Fixed: 20px icon buttons next to ✕ are now 24px.
- Fixed: the history dialog says 最近 50 / 共 N 条 instead of silently truncating.
- Fixed: the footer paths wrap and carry a title instead of being clipped mid-drive.
## 1.19.4

- Fixed: the snapshot and the third-party status now tell a failed read apart from an empty one (localized panel plus a retry, instead of "读取中…" forever or "nothing to disable").
- Fixed: a refresh response older than the newest one can no longer overwrite the panel.
- Fixed: the MCP editor warns once before Escape or an overlay click discards a half-filled form.
- Fixed: a preset cannot be deleted by a stray click any more; it asks first and confirms after.
- Fixed: facet labels no longer overlap the first chip in English; the secret placeholder is a value that cannot collide with real text.
- Fixed: the OAuth module no longer prints endpoint URLs with userinfo, query or fragment into error messages.
- Fixed: skill-pack refuses symlinked directory sources and duplicate zip entries instead of silently installing less than the user gave.
- Fixed: two duplicate onThirdOff props that shadowed the working handlers.
- Testing: probe/host-smoke.mjs 304 checks (rawSave rollback, foreign/lost lock, workspace fallback chain); skill-pack-smoke 73; a passing host run no longer leaves its temp fixture behind.

## 1.19.3

- **The shell has a fixed height.** `maxHeight: calc(100vh - 120px)` plus `overflow: hidden` pins the
  panel to the viewport, the header and the rail stop moving, and the list becomes the only scroller —
  a long install no longer scrolls the tabs out of reach.
- **The remembered tab stays.** 1.19.2's last-view memory (`localStorage toolHubView`) is unchanged:
  reopening the panel lands on the tab you left.

## 1.19.1

- **Header actions keep their line.** The title block takes `flex: 1 1 260px` and the action row wraps
  as one unit, so a narrow panel no longer pushes a single button onto a line of its own.
- **The shared skill root is just a label.** It reads 全局 · 共享 again, without the `#2` ordinal the
  old label carried.
- **MCP secret placeholders read the right field.** The edit dialog reads `row.secretKeys` instead of
  `config.secretKeys`, so "2 keys set" no longer comes out empty.

## 1.19.0

Internal build. The feature set:

- **Skills gained a scope.** Workspace roots (`<workspace>/.dsh/skills`) join the two global roots,
  and each row knows where it came from. `TOOL_HUB_WORKSPACES` pins the workspace list
  (`;`-separated; `-` disables workspace discovery).
- **Preview, delete, restore.** Preview reads a skill's source (first 200 KB, read-only). Delete moves
  the whole skill into `<state dir>/trash/<timestamp>-<name>/` with a `meta.json` that records its
  root and relative path; the ten-second undo moves it back. Nothing is erased.
- **MCP secrets are masked.** `env` and `headers` values never leave the host; `secretKeys` lists the
  keys that are set, and saving a blank value keeps the stored one.
- **`${NAME}` templates.** A value written exactly as `${NAME}` becomes a host-side environment
  reference, so the patch can name a variable instead of holding its value.
- **Raw MCP source.** 查看原文 shows the exact patch fragment read-only; 高级：直接编辑 replaces the
  whole entry, after a warning about indentation and formatting.
- **Skill import and move.** Import one `.md`, a directory, or a zip into any root, with an optional
  overwrite; move a skill to another root without touching its switch.
- **MCP OAuth login.** Discovery runs protected-resource metadata (RFC 9728) → authorization-server
  metadata (RFC 8414) → OIDC; PKCE and the RFC 8707 `resource` parameter are part of the flow. The
  panel shows the authorize URL and asks for the code the redirect carries.
- **CLI `dsh-tool-hub`.** 22 commands over `list` / `plugin` / `group` / `preset` / `skill` / `mcp` /
  `config`, with `--json` on reads and writes.
- **`doctor`.** Six independent checks — patch parse, state writability, failed rows, stale panel
  lock, skill roots, trash folder — each answered by doing the thing.
- **Operation history.** One JSON line per panel op in `<state dir>/history.jsonl`, with the op and
  short ids only; payloads are never copied, and the file keeps its tail once it passes the cap.
- **By-bundle view.** A rail lens lists the installed bundles and filters the list to the rows each
  one owns; 全部 drops the filter.
- **Failed rows carry a red bar** down the left edge and a 看诊断 action that prints the row's own
  diagnostic text.
- **Config export / import.** Groups, collections, presets and the tool deny list move as one JSON
  file; import merges by default, replace is confirmed first, and the CLI writes a backup.
- **Row descriptions.** 显示简介 draws one line per row from the row's meta, then the package
  manifest, then a known-package table, then nothing — the source is recorded, not guessed.
- **Help drawer.** Eight short sections (what it solves / how to use it / one caution), opened
  automatically the first time and from the `?` button afterwards.

## 1.18.4

- **Built-in UI is read-only.** 65 rows ship inside the client's own UI bundle; the client never
  lets a profile override them, so the switch used to end in a bare `failed`. They now carry a
  内置界面 badge, their switch is disabled, and a direct API call is refused with
  `builtin-ui` instead of touching the patch file.
- **Bulk switches skip them.** Closing a group counts these rows as `skippedBuiltin` instead of
  spraying one identical failure per row.
- **Refusals are explained.** A refused toggle now shows "这个开关没有生效：<reason>" rather than
  "failed".

## 1.18.3

- **Facet chips show what they will do.** Every chip carries the count it would leave:
  全部 225 / 官方 205 / 第三方 17 / 技能 2 / MCP 1, and 有界面 81 / 纯后端 142.
- **The selected chip is unmistakable**: solid brand fill, white count, bold label.
- **A filter summary row** sits above the list ("已筛选：视图 插件 · 来源 官方 · 形态 有界面")
  with a one-click 清除筛选.
- **The rail stays visible on every tab**, because the chips live there and a hidden chip row
  cannot be cleared.
- **Official manifests are found now.** Official packages live in the client install, not in the
  profile, so their shape used to read as unknown and every shape filter dropped them. The reader
  now looks in the client's node_modules and falls back to the module name.

## 1.18.2

- **关闭第三方**: one red switch turns off every enabled third-party plugin, MCP server and skill,
  after a dialog that lists them and marks the always-on / UI ones in red.
- **A rollback point is written first** (`tool-hub/rollback/<timestamp>.json`); 恢复 re-opens
  exactly the rows that were on.
- Official and host-managed rows are never touched.

## 1.18.1 / 1.18.0

- The dialog openers were declared inside the dialog's props object, so the header buttons did
  nothing. They are hoisted to the panel now.

## 1.17.4

- **Move out of a group** without deleting the group, plus 从本组移出 in the selection bar.
- **Update a preset** in place (re-records the current switches) behind a confirmation.
- The word filter is gone.
- Two blank panels fixed: a `Remove` button spliced into a module row that had no handler, and a
  bare `onUpdatePreset,` shorthand pointing at a variable that only existed inside the dialog.

## 1.16.0

- **Filters that cannot lie.** The rail has three facet rows read straight from the install:
  *Origin* (Official / Third-party / Skill / MCP, from the module name), *Shape* (Has UI /
  Headless, from `dsh.client` and `dsh.bundle` in the package's own `package.json`), and
  *Word*, which only lists keywords at least two packages declare. Nothing is inferred from a
  description, so a package never disappears because we guessed its topic wrong.
- **Group chips are gone.** A group is a name and an on/total count; the words live in the filter
  row where they can be combined instead of decorating every group.
- **The two "new" buttons are pinned.** The rail is now head / scrolling middle / foot, so a long
  list of groups can no longer push 新建分组 and 新建分组群 off the bottom.
- **Shift-click selects a range**, like a file manager: the range takes the state the clicked row
  is about to have, and a collapsed module contributes all of its entries.
- **Rows drag into groups.** Select one or more rows and drop them on a group to file them; the
  same package tree expansion applies, so a sub-package never lands without its parent
  (`group.add`).

## 1.15.1

- **A second axis you cannot break anything with.** Lenses (`Official` / `Third-party` /
  `Always on` / `Per task`) filter the list without owning a switch, so a package can be found as
  "third-party" and as "always-on" without living in two groups at once.
- **`通用` is now `第三方底座`.** The old name read like "the user's stuff"; the bucket actually holds
  third-party packages that everything else sits on.
- **Bulk flips say what they will touch.** When members of a group also sit in another group, the
  confirmation names them and offers two honest choices: only the ones this group owns, or all of
  them. Base and official members turn red with "存在基础插件，禁用可能导致界面异常。"
- **Undo, for ten seconds.** A group flip leaves an undo bar; one click puts every touched row back.
- **Refused rows stay marked**, and the toast now reads "x done, y refused by the host" instead of
  hiding the failures behind a success count.
- **Stale members are visible and cleanable**: a group that still lists an uninstalled plugin shows
  `n gone`; clicking it drops those members.
- **Search opens what it finds**, dragging near the rail edges scrolls it, and rows are memoized so a
  hundred switches do not re-render the whole list.

## 1.14.0

- **The rail tells you what is actually running**: every group shows `on/total` (`5/8`), green when
  the whole group is live, grey when nothing is; the drawer header sums its groups. Hovering any
  count spells it out ("3 on · 5 off").

## 1.13.0

- **Tags come from the package, or not at all.** Group labels are now exactly the `keywords` a
  package declares — nothing inferred is shown. The topic words we guess moved to search only, so
  `memory` still finds billion-context without putting a made-up label on the group.
- **A package is one tree.** Sub-packages (`billion-context/dsh-compaction-gate`,
  `@scope/name/sub`) fold under their parent instead of appearing as separate plugins.
- **Groups follow the parent.** Picking any row of a package puts the whole package in the group,
  so a group can never flip half an install; enabling still stays per row.

## 1.12.0

- **The list is a tree.** A plugin that mounts several loader entries is one row that unfolds into its
  entries; the parent shows `name / kind / ×n` and one switch that flips the whole set. Single-entry
  modules still render as a plain row, so nothing gets an extra click for no reason.
- **The rail belongs to 全部.** Switching to 插件 / 技能 / MCP hides the group rail and gives the list the
  full width; switching back brings it home.

## 1.11.0

- **Drawers start closed and fold the auto buckets.** The rail is a table of contents first: each
  collection is one line you open, and the 官方 / MCP 服务器 / 通用 buckets live inside 默认分组群
  instead of above it. 用户下载 starts with no collection at all, in the 未入群 pile.
- **A group belongs to at most one place.** Dragging a group onto a drawer files it there; dragging it
  back to 未入群 takes it out. 新建分组 lands in 未入群, 新建分组群 adds a drawer; the header "+" that
  used to create a group in the default drawer is gone, so there is exactly one way to do each thing.
- **Tags come from the plugin itself.** `package.json` `keywords` (up to three) are shown as the chips
  under a group name, topped up with the bucket's topic words when a package declares none — the same
  thing the GitHub plugin page shows, instead of our own invented taxonomy.
- **Motion.** Rows, switches, chips and dialogs get a short fade/slide, all of it inside
  `@media (prefers-reduced-motion: reduce)` guard rails.

## 1.10.0

- **Removed the agent-preset editor.** Writing preset declaration rows from the panel kept producing
  states the registry accepted but did not compose, and the host's own rules (`resolve()` succeeding,
  `register()` tolerating a broken record, per-layer shadowing) made every half-fix worse. The feature
  is gone; the panel no longer touches `cordis.patch.yml` for presets, and no preset row it wrote
  remains on this machine.
- **Automatic grouping is four buckets**: 官方 / MCP 服务器 / 通用 / 用户下载, decided in that order
  from the module name, the row meta and the description keywords. MCP rows are claimed before the
  official prefix swallows them, which is why they finally have their own bucket.
- **Collections**: hand-made groups sit in drawers. One 默认分组群 exists from the start, more can be
  added from the rail, and each can be renamed or deleted; deleting one moves its groups back to the
  default drawer instead of deleting them.
- An empty group keeps its rename/delete controls; only 启用/禁用 are greyed out, because there is
  nothing to switch.

## 1.9.2

- Preset contents are now editable from the panel: **Choose contents** lists every plugin and MCP server the installation runs, ticks what the preset declares, and rewrites only that row's `plugins` list. Entries that were already declared keep their original lines, so hand-written config and `!!js` expressions survive.
- Host-provided rows are listed but not selectable, and an unknown module name is refused rather than written.
- Fixed the contents dialog crashing the whole panel when it opened.

## 1.8.2

- Fixed the Modes view piling up: preset cards from an earlier visit stayed on screen, and they survived a switch back to All. Cards now use stable keys, each view renders in its own keyed container, and leaving the view drops the cached list.

## 1.8.1

- A chip that cannot be pressed (the delete button on a built-in preset) now looks inert instead of red: no tinted fill, no tinted border, and the label sits in the quiet text colour.

## 1.8.0

- Agent presets are now first-class in the panel: a **Presets** view lists every preset the registry knows,
  including the built-in ones, and a new preset is written as one declaration row in the profile
  `cordis.patch.yml` — nothing else in the file is touched, and HMR applies it without a restart.
- Creating a preset verifies itself: the row is written, the registry is asked to resolve the id, and the row
  is rolled back if the record is missing or marked broken. `register()` is allowed to succeed with a broken
  record, so believing the write alone would leave a preset that composes nothing.
- Deleting refuses the current default preset and waits for the registry to actually drop the record before
  reporting success. Every write leaves a timestamped copy in `~/.dsh/backups/`.
- Built-in presets (`standard`, `ptc`, `minimal`, `cordis`) are listed read-only, because their rows live in
  the bundle layer rather than the profile.

## 1.6.9

- The Enable / Disable chips on a group stay on one line and inside their border at any rail width, and the
  whole action row (chips plus move/rename/delete) fits on one 20px line in a narrow rail.

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
## 1.17.4

- 筛选回到两根轴：来源（官方 / 第三方 / 技能 / MCP）与形态（有界面 / 纯后端）。第三行「词」连同 `kw` 状态、`kwMatch`、`kwOptions` 一起删掉 —— 关键词能描述标签，但描述不了「这一组该不该开」。
- 分组多了一个「移出」：组内每一行右侧有「移出」，勾选多条时选择条里也有「从本组移出」（`group.remove`，只删成员，不碰开关，也不删组）。
- 预设可以原地更新：预设行多了「更新」，先弹确认再 `preset.update` 用当前开关状态覆盖，不用重打名字再存一遍。
- 修两处白屏：①「移出」按钮一度被插进模块父行（那里没有 `onRemove`），渲染即抛 ReferenceError；②DialogHost 的 props 里残留一行 `onUpdatePreset,` 简写，指到一个不存在的变量 —— 任何对话框打开时都会炸。现在两个都只改到正确的位置，并且 `node --check` + 冒烟 125/125 都过。

## 1.18.2 — 一键关闭第三方（含回滚点）

- 新增「关闭第三方」：只关不删，官方与宿主托管行不动，按下去之前先写一份回滚点 `<state dir>/rollback/<ISO>.json`。
- 确认框按 插件 / MCP 服务器 / 技能 三组列出将要禁用的条目，常开底座与界面类插件标红，并显示「其中 N 项是常开底座或界面类插件，关闭后界面可能异常。」；必须勾选「我了解界面可能异常，并已保存回滚点」才能执行。
- 关闭后顶栏出现「恢复」：按最新回滚点逐项重新打开（同样二次确认）。
- 逐项切换要重启宿主，30–60 秒；这段时间按钮变灰并显示「正在逐项处理…」，同时提示预计耗时。
- 自我排除：`dsh-tool-hub` 自己永不进入关闭清单（否则关完就没人能恢复了）。
- 冒烟：`probe/host-smoke.mjs` 130/130（第三方判定、off 写快照、只关第三方、status 报快照、restore 回开、二次 off 为 0）。
- 沙盒实测：18 项 → 已启用 193 → 177（用户下载 0/5），恢复后回到 194 且侧栏条目复现；回滚点文件 720B。

## 1.18.3 — filters you can see, and official rows that answer to shape

- The rail is back on every tab. Filters live in the rail, so hiding it while the filter still applied left lists looking mysteriously short with no way to clear them.
- Chips now carry counts (`官方 205`, `有界面 81`, ...) and the selected one is a solid brand pill instead of a faint outline.
- A summary bar above the list spells out exactly what is filtering it (`已筛选：视图 插件 · 来源 官方 · 形态 有界面`) with a one-click `清除筛选`.
- Shape is only offered where it means something: the skill and MCP tabs keep the origin row and drop the shape row.
- Official packages live next to the client, not in the profile, so their manifests were never read and every official row fell through both shape filters. `packageMeta` now looks in the profile, the packaged app's `resources/app/dsh/node_modules`, and the source checkout; subpath rows (`billion-context/dsh-compaction-gate`, `@michengai/dsh-codex-ui/theme`) resolve through their package root. Sandbox now reports ui 81 / host 142 / null 0.
- Clicking a group switches back to the unfiltered view, and switching tabs drops the shift-select anchor.