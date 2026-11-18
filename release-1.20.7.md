# 1.20.7 — the doctor reads the stopwatch

## English

**Added**
- `doctor` reports `snapshot-profile`: the per-step timings of the most recent profiled snapshot, or a note that no profile log exists yet. Run with `TOOL_HUB_PROFILE=1` to collect samples; the panel then answers "why is it slow" with numbers.

## 中文

**新增**
- `doctor` 增加 `snapshot-profile`：显示最近一次带 profile 的快照各步耗时；没有日志时说明如何采集（`TOOL_HUB_PROFILE=1`）。以后面板卡顿可以直接看是谁慢。

**Install** · `dsh plugin install FenrirCait/dsh-tool-hub`
**Diff** · https://github.com/FenrirCait/dsh-tool-hub/compare/v1.20.6...v1.20.7
