# 1.20.6 — measured, not guessed

## English

**Changed**
- `thirdparty.status` answers from the plugin rows and skills it filters instead of building a whole snapshot first (1254 ms → 648 ms).

**Added**
- `pluginManager.listPlugins()` is memoised for 5 s and `listBundles()` for 60 s, both invalidated by writes. A warm snapshot now answers in 14 ms.
- `TOOL_HUB_PROFILE=1` logs per-step snapshot timings to `<state dir>/snapshot-profile.log`.

**Fixed**
- A write drops the row cache only; the bundle list survives, because flipping a switch never changes which bundles exist.

## 中文

**变更**
- `thirdparty.status` 不再先构建整个快照，而是直接读它要过滤的插件行与技能（1254 ms → 648 ms）。

**新增**
- `pluginManager.listPlugins()` 缓存 5 秒、`listBundles()` 缓存 60 秒，写入时失效；热快照从约 800 ms 降到 14 ms。
- `TOOL_HUB_PROFILE=1` 会把每一步的耗时写进 `<状态目录>/snapshot-profile.log`。

**修复**
- 写入只清除插件行缓存，bundle 列表保留——拨一个开关并不会改变「有哪些 bundle」。

实测（沙盒 profile，33 个 bundle / 225 行 / Windows）：`plugins=408 ms`、`bundles=401 ms`，其余各步 ≤2 ms；`snapshot?fresh=1` 约 800 ms，热快照约 14 ms；`toggle` 约 1.6 s，其中约 1.2 s 是宿主重载 loader 条目，不是本插件。

**Install** · `dsh plugin install FenrirCait/dsh-tool-hub`
**Diff** · https://github.com/FenrirCait/dsh-tool-hub/compare/v1.20.1...v1.20.6
