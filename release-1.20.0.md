## English

- **Lazy MCP servers.** Mark a server lazy and every tool it ships leaves the model-visible schema. A small `hub_tools` tool carries the catalog: `list` shows what is available, `enable` takes names or a server and makes those tools callable from the next turn, `disable` puts them back. The panel adds one prompt paragraph while something is lazy, and nothing otherwise. State lives in `tool-hub/state.json`, so a restart keeps the choice.
- **Destructive entry points now ask.** `state.reset` needs `confirm: "reset"` and `config.import` in replace mode needs `confirm: true`; both write a copy to `backups/` first and keep the newest 20.
- **Fewer surprises in the panel.** A bulk selection over 20 rows asks first (and no longer crashes), a refused write keeps its dialog open with the reason, the help drawer yields Escape and Tab to a dialog above it, busy state counts in-flight requests instead of toggling a boolean, and host state writes are serialized so two requests cannot lose one update.
- **MCP client.** OAuth error messages go through URL redaction, zip imports reject symlinks and duplicate entries, and a failed read of the third-party state no longer renders as "nothing to turn off".
- **Also:** built-in UI rows are read-only with a badge and a reason, filters show counts per chip, the rail stays visible on every tab and scrolls on its own, and rows can be dragged into a group or moved out of one.

## 中文

- **MCP 懒启动**：把某台服务器标为懒启动后，它的工具会整体移出模型可见的工具表；一个小工具 `hub_tools` 保管目录（`list` 看清单、`enable` 收名字或整台服务器、`disable` 收回），下一轮生效。只要还有懒启动的服务器，面板会向系统提示词加一段说明，否则一个字都不加。状态存在 `tool-hub/state.json`，重启保留。
- **破坏性入口要确认**：`state.reset` 需 `confirm:"reset"`，`config.import` 的 replace 模式需 `confirm:true`；两者都先写一份到 `backups/`，只保留最近 20 份。
- **面板少踩坑**：一次勾选超过 20 行会先确认（且不再崩溃）；写入被拒时对话框留着并显示原因；帮助抽屉遇到上层对话框会让出 Esc 与 Tab；busy 改成在飞请求计数；宿主的状态写入串行化，两个请求不会互相覆盖。
- **MCP 客户端**：OAuth 报错里的 URL 全部脱敏；zip 导入拒绝符号链接与重复条目；第三方状态读取失败不再被显示成「无事可做」。
- **其余**：内置界面行只读并有徽标与原因；筛选芯片带计数；左栏在每个标签都在、自己滚；行可以拖进分组、也可以移出分组。

---

**Install** · `dsh plugin install FenrirCait/dsh-tool-hub`
**Diff** · https://github.com/FenrirCait/dsh-tool-hub/compare/v1.0.0...v1.20.0
