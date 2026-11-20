# 1.1.0 → 2.0 迁移

1. 读取 ~/.dsh/tool-hub/state.json；解析失败则从最近备份恢复并如实报告。
2. migrate() 升到 v2（加 settings/modules，其余键原样保留），写回前备份到
   <state dir>/backups/state-<ts>.json。
3. 旧 scenes/mode 记录不改语义：场景仍是工具 + MCP 两域，mode.snapshot 仍是回滚凭据。
4. 旧 CLI 命令继续可用；scene 子命令保持现有语义与 --force 守卫。
5. 回滚：把 main 指回 lib/index.js 并使用迁移前的备份；v2 文件里 1.x 键仍在，1.1.0 可读。
