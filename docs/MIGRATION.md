# 1.1.0 → 2.0 迁移

1. 读取 ~/.dsh/tool-hub/state.json；解析失败则从最近备份恢复并如实报告。
2. migrate() 升到 v2（加 settings/modules，其余键原样保留），写回前备份到
   <state dir>/backups/state-<ts>.json。
3. 旧 scenes/mode 记录照旧可读：缺字段按「不碰这一域」处理，mode.snapshot 仍是回滚凭据。
   2.0 的场景扩到四域 + 预设绑定 + 锁，见下节。
4. 旧 CLI 命令继续可用；scene 子命令保持现有语义与 --force 守卫。
5. 回滚：把 main 指回 lib/index.js 并使用迁移前的备份；v2 文件里 1.x 键仍在，1.1.0 可读。

## 场景 v2

- 段（`tools` / `mcp` / `plugins` / `skills` / `preset`）：未定义 = 不动这一域；已定义（含空表）=
  按名单置定。旧档案没有 `plugins` / `skills` / `preset`，因此不会被解读成「清空」。
- 应用顺序：预设（exact）→ 插件 → 技能 → 工具遮罩 → MCP；显式段与预设撞域时以显式段为准
  （`scene.plan` 回执里的 `presetOverridden` 会点名）。
- 快照抓每一行插件/技能的开关（不只抓被改的行）；退出按 `plugins → skills → tools → mcp` 还原；
  快照里没有的新行不动；目标已消失的行报 `(skipped)`，不算失败。
- `locked` 只由 `scene.lock` 改；`scene.save` 收到 `locked` 会忽略并回报 `ignored: ['locked']`。
  锁住任一场景即冻结环境写操作，完整清单见 `src/domains/scene-lock.ts` 的 `FROZEN_OPS`；
  `scene.lock`、只读 op、`session.*`、`scope.*`、`settings.set`、`backup.*` 不受影响。
- 场景有意不覆盖：`~/.dsh/AGENTS.md` 的写入/应用（属 A 级写，走单独流程）、记忆 / 子智能体人设 /
  快捷提示词、会话覆盖（`session.*` 不是场景内容）、启动自动对账、回收站（删除后靠 `backup.*` 恢复）。
