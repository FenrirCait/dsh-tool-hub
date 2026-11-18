# 1.20.1 — a registered tool, a cheaper snapshot

## English

**Fixed**
- `hub_tools` never reached the registry: `register()` requires `output.render`, the call threw, and the catch had no logger to warn into. It now declares a render function, and logs through `console.warn` when no logger is reachable.
- Service lookups accept both forms — `ctx.tools` (injected property) and `ctx.get('tools')` (lookup) — so a host that only implements one of them no longer silently skips registration.
- `thirdparty.off` with nothing to do no longer leaves an empty rollback snapshot behind.

**Added**
- `doctor` reports a seventh check, `hub-tools`, so a missing catalog is visible instead of silent.
- The snapshot is cached for 1.2 s with single-flight; every write invalidates it on entry and exit. Three parallel reads now cost one build instead of three.
- `GET /tool-hub/api/snapshot?fresh=1` bypasses the cache for callers that need the truth right now.

**Changed**
- The fake MCP probe server answers `tools/call` instead of failing with `-32601`.

## 中文

**修复**
- `hub_tools` 从未真正注册：`register()` 要求 `output.render`，调用抛错，而 catch 里拿不到 logger、无处告警。现在声明了 render 函数，取不到 logger 时走 `console.warn`。
- 服务解析同时接受 `ctx.tools`（注入属性）与 `ctx.get('tools')`（查找），宿主只实现其中一种也不会再静默跳过注册。
- `thirdparty.off` 没有任何改动时，不再留下空的回滚快照。

**新增**
- `doctor` 增加第七项 `hub-tools`：工具目录缺失会显式报出来，而不是无声失败。
- 快照缓存 1.2 秒并做 single-flight，写入在进入与退出各失效一次；三个并发读取只算一次。
- `GET /tool-hub/api/snapshot?fresh=1` 供需要最新数据的调用方绕过缓存。

**变更**
- 夹具 MCP 服务器补上 `tools/call`，不再返回 `-32601`。

**Install** · `dsh plugin install FenrirCait/dsh-tool-hub`
**Diff** · https://github.com/FenrirCait/dsh-tool-hub/compare/v1.20.0...v1.20.1
