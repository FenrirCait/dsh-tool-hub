# 参考插件功能缺口与优先级

**对象**：dsh-tool-hub 2.0.0-alpha.29（`package.json`）  
**日期**：2026-11-21  
**来源**：本机克隆 `%TEMP%/tool-hub-refs`（四个插件）、npm registry（2026-11-21 取数）、本机 sandbox profile 已装版本、本仓库源码  
**约束**：只读调研，未改 `src/`

---

## 0 结论先行

1. **竞争点已经从"开关"上移到三层**：提示词层（工具说明段落随工具一起消失）、作用域层（preset / workspace / session / subagent 的合法层叠）、成本层（每行 token、组净省、PTC 口径）。我们三层都缺。
2. **我们最强的是写入安全**：行级改、跨进程锁、写前备份、宿主加载校验失败即回滚、受管块只读避让。四个参考插件没有任何一个同时做到这五件；这部分不要为了"对齐"换成整块重写。
3. **P0 只有三项**：遮罩只在 op 时安装（重启 / 热装后漂移）；遮罩不处理 `tool:*` / `mcp:*` / `mcp-resource-servers` 提示词段落；2.0 的 `src/` 没有 OAuth 实现（1.x `lib/oauth.js` 才有，README 仍在宣称）。
4. **"补丁写前 diff 预览"参考侧一个都没有**。备份也只有一半（有清理、无单条恢复）。这是差异化机会，不是追赶项。
5. 18 条 backlog 中 4 条 ≤1 天；6 条需要宿主 / 上游新 seam（清单见 §7）。

---

## 1 方法与证据约定

- 四个克隆的 commit：`dsh-tool-switch` 1008959 · `dsh-tool-manager` 3f86ef0 · `dsh-skill-mcp-panel` 8797c33 · `dsh-plugin-tool-management` 88f38da。
- 引用格式：参考侧 `<包>/<路径>:<行>`（相对克隆根），本仓库 `src/...:<行>`，外部资料给 URL。
- **克隆版本可能落后 npm**：`dsh-tool-manager` 克隆是 1.3.0，npm 最新 1.4.1（2026-11-21）。1.4.x 的 token 成本视图只能引 CHANGELOG（§3.2）。
- "我们缺"的判据不是"没看见"，而是给出我们对应实现的锚点或明确的无实现证据（grep 结果写进表内）。
- 参考侧的 README 宣称与源码不一致时，以源码为准，并在表中同时标出。

---

## 2 本仓库基线（先说清我们有什么，缺口才可信）

| 能力 | 我们的实现 | 证据 |
|---|---|---|
| op 面 | 48 个 op，10 个内建域（plugins / skills / mcp / groups / presets / scenes / tool-surface / sessions / settings / config） | `src/domains/index.ts:18-30`；各域 `{ id: '…' }` 声明 |
| 入口槽位 | `plugins.tab` / `sidebar.panellist` / `main` **三个** | `src/client/entry.tsx:58-61` |
| 遮罩 | 四源合并（install/session/lazy/onDemand）→ 单次 `restrict(deny)`，signature 去抖 | `src/domains/tool-surface.ts:135` / `:469` / `:501` / `:506` |
| 会话覆盖 | 按 sessionId 存 deny，沿 lineage 继承，深度 8、环安全 | `src/domains/sessions.ts:42` / `:55` / `:98-106` |
| 懒加载 MCP | `hub_tools`（list/enable/disable）+ 仅在有懒服务器时注入一段提示词 | `src/host/catalog-tool.ts:80`；`src/domains/tool-surface.ts:284` |
| MCP 行编辑 | 行级替换、锁名与 skill-mcp-panel 相同、写前备份、宿主校验失败回滚 | `src/domains/mcp.ts:476` / `:768-781`；`src/domains/mcp.ts:11-14` |
| 受管块 | **只读**扫描（块、外来行、未闭合块）+ 新行插在块外 | `src/core/patch-blocks.ts:16` / `:45` / `:91` |
| 备份 | 写前整份 patch 副本，保留份数可配；**无列表 / 无恢复** | `src/domains/mcp.ts:134` / `:476` / `:830`；`src/domains/settings.ts:25` |
| Preset | 四维快照（plugin/skill/tool/deny），exact 与 only-enable | `src/domains/presets.ts:105` / `:164` |
| Scene | 只覆盖 **工具遮罩 + MCP** | `src/domains/scenes.ts:1-11` / `:151` |
| 配置导入导出 | groups/collections/presets/toolDeny，merge 与 replace | `src/domains/config.ts:474`；README:202-208 |
| 诊断 | doctor 6 项 + 能力表 + 心跳 | `src/host/diagnostics.ts:812` / `:210` / `:108` |
| 审计 | `history.jsonl`（op、短 id、ok）tail 保留 | `src/host/dispatch.ts:73` / `:102` / `:122` |
| CLI | 22 命令 7 族 | README:157-182 |
| 第三方扩展 | manifest 校验 + 白名单目录 + 默认不给写 op | `docs/MODULES.md:34-38`；`src/host/extensions.ts:300` |

已知**无实现**（grep 证据）：

- `tools/change` / `agent/created` 订阅：`grep -rn "tools/change\|agent/created" src` → 0 命中。遮罩只在 op 内调用 `applySurface`（`config.ts:427`、`presets.ts:305`、`scenes.ts:151`、`sessions.ts:92`、`tool-surface.ts:541`）。
- 提示词段落读写：`grep -rn "systemPrompt" src` 只命中 `diagnostics.ts:106-117`（能力探测）与能力表；没有任何 `section()` 调用/删除逻辑。
- `tools.showTokenEstimate`：`grep -rl showTokenEstimate` 只命中 `src/domains/settings.ts:21`（声明），**无消费方**。
- OAuth：`grep -rli oauth src` → 0 命中；实现在 1.x `lib/oauth.js`、`client/client.js`。
- 备份 UI / 恢复：`grep -rn "backup" src/client` → 0 命中；`mcp.ts` 无 restore 路径。

---

## 3 逐插件对照

### 3.1 dsh-tool-switch 0.2.2（会话级工具开关，定位与我们最接近）

| 它有的 | 证据 | 我们的现状 | 缺口判断 |
|---|---|---|---|
| 会话级工具开关：记「关掉哪些」，`allow = 可限制 − 关闭集` | `dsh-tool-switch/index.js:139-161`、`:225-228`、`:244` | 数据模型有（`sessions.ts:98-106`），只有面板一个入口 | **入口缺** |
| 三个入口写同一份状态：面板按钮 / `/tools` 斜杠 / `tool_switch` 模型工具（含 QQ、headless） | README:33-52；`index.js` 的 commands 与 `SWITCH_TOOL_NAME`（`:38`） | 只有 UI op；模型侧只有 `hub_tools`（只管懒加载） | **缺两条入口** |
| 输入框下方 `⚙ 工具` 按钮，关过工具后带数字徽章 | README:22；`lib/client.js:740-743`（`conversation.composer.dock`） | 入口只在插件页 / 侧栏 / main（`entry.tsx:58-61`） | **缺 dock** |
| 工具按能力族分组 + 每组 `on/total` + 整组全开/全关 + 搜索自动展开 + 默认收起 | README:24-28；`lib/client.js:194`、`:243-272`、`:354`、`:487`、`:509` | 工具页是平铺行 + 每行开关 + 搜索（`tools.tsx:187`）；无工具分组 | **缺分组/批量** |
| 监听 `agent/created` / `agent/disposed` / `tools/change`，只在 allow 真变时重装 | `index.js:267`、`:277`、`:291-298`、`:228`（signature） | 无监听（见 §2 grep） | **P0** |
| 卸载时撤销自己装的全部遮罩 | README:76（"卸载时撤掉"） | `applySurface` 保存 undo，但进程退出/插件卸载路径未覆盖 | **待验证** |
| 明确「会话固定」行：agent 作用域注册的工具关不掉，标灰并解释 | README:133-134（已知边界）；FAQ 表也有对应行；`index.js:358-396`（`fixed` 计数） | `mergeSurface` 有 `unreachable`（不能 restrict 的名字）但只是列表，无逐行解释 | **可借** |
| HTTP 状态端点（GET/POST，仅回环） | `index.js:458-462`；README:56-62 | 我们有自己的 op API（`routes.ts:257`） | 不需要 |

**它自己承认的边界**（不要照搬）：无全局默认（新会话全开）、面板文案未 i18n、HTTP 无额外鉴权。

### 3.2 dsh-tool-manager 1.4.1（按 preset 的工具策略 + 按需组 + 成本视图）

克隆为 1.3.0；1.4.x 的新增见 [CHANGELOG](https://unpkg.com/dsh-tool-manager@1.4.1/CHANGELOG.md)。

| 它有的 | 证据 | 我们的现状 | 缺口判断 |
|---|---|---|---|
| 按 **Agent Preset** 的工具策略：`disabled` + 按需组，存 `tool-manager.json` | `src/config.ts:8`；README:16-46 | Preset 是"整台机器的快照"（plugin/skill/tool），没有"每个 preset 各自的工具策略" | **缺模型** |
| **提示词段落随工具族一起消失**：`tool:<名称>` / 按族名注册的 `tool:<族>` / `mcp:<服务器>` / `mcp-resource-servers` | README:26-28；CHANGELOG 1.2.12 / 1.3.0 | 完全没有段落处理（§2） | **P0**；做法见 §3.2 证据 |
| 归属恢复不靠猜：包装 `systemPrompt.section()` 与 `tools.register()`，按 fiber 的 effect 顺序配对；启动前后两条路径都恢复 | `src/prompt-affinity.ts:1-25` | 无 | **P0 的实现参考**（需 fiber 反射或上游 API） |
| 按需组（任意工具族，不只 MCP）：模型看到目录 + `tool_list` | README:48-70；`src/runtime.ts:601-650` | 只有懒加载 MCP 服务器（`catalog-tool.ts:80`），非 MCP 工具无法按需 | **缺按需组泛化** |
| 开放状态**从会话事件恢复**（重启、fork 语义：fork 前缀算数） | `src/exposure-history.ts:1-20`；README:67-68 | `hub_tools` 的 loaded 列表存在 state.json，不按会话、不看事件 | **缺 fork/会话语义** |
| 每步（`agent/pre-step`）用 live `schemas(agent)` 核对 baseline，热装工具当步归组，不重启 | `src/runtime.ts:135`、`:380-416`、`:436-449` | 无（§2） | **P0 同族** |
| Preset 切换竞态重校准（先组合 transit preset 再组合目标） | `src/composition-watch.ts:1-30` | 无 | 中 |
| registry 重载后把活 Agent 重绑到新实例（`Symbol("dsh.scope")` 探测 + WeakMap） | `src/preset-repair.ts:1-25` | 无 | 低（依赖宿主私有结构，风险高） |
| 修复失败给用户 banner（reloading / failed，保留 20 条） | `src/notices.ts:1-25` | 有 toast，无宿主级通知箱 | 中 |
| 模型自动分组 + 建议（超时 60s/120s，提示词可预览/编辑/重置） | `src/suggest.ts:9-33`；README:30-41 | 规则式自动分组四桶（`groups.ts:571` `buildAutoPlan`），不调模型 | 中 |
| 跨 Preset 复制 / 重置（只写草稿，保存才生效） | README:42-47；CHANGELOG 1.3.0 | 无 | 中 |
| **token 成本视图**：每行 `~N tok`、组净省、五/六统计卡、PTC 用 `renderSdk()` 边际 + 平台常数、transport 徽标 | [CHANGELOG 1.4.0/1.4.1](https://unpkg.com/dsh-tool-manager@1.4.1/CHANGELOG.md) | 设置项 `showTokenEstimate` 是孤儿（§2） | **缺，且已有半成品钩子** |
| 只有打开的组才过滤提示词；未分组工具常驻 | README:204 状态表 | 无 | 同上 |

### 3.3 dsh-skill-mcp-panel 2.3.16（受管块模型 + 四层工具过滤 + OAuth/CLI）

| 它有的 | 证据 | 我们的现状 | 缺口判断 |
|---|---|---|---|
| 接管 patch 里**全部** MCP 行（不区分受管块 / id 前缀） | README:116、205；CHANGELOG 2.3.6（README:278） | 我们也按行改全部 MCP 行（`mcp.ts:270` `parseMcpRows`） | 对齐 |
| **受管块归属**：begin/end 标记、块内"外来条目"字节保真、只重建自己那段 | `src/patch-editor.ts:150-176`、`:200`、`:267`、`:299` | 只读扫描 + 从不在块内写（`patch-blocks.ts:45`/`:91`） | **策略不同，缺"搬迁"** |
| 外来顶层行搬出块（因为 DSH 配置编辑器会 append 到块尾） | `patch-editor.ts:366-408`（`evacuateForeignRows` / `writeEvacuatedForeign`） | 无 | **可借** |
| 整篇校验 + `.panel.lock`（30s 陈旧锁）+ 临时文件 rename | `patch-editor.ts:93-104`、`:334-338`、`:423` | 有锁（同名锁文件）+ 原子写 + 宿主校验回滚（`mcp.ts:11-14`、`:768-781`） | 对齐（我们多了宿主校验） |
| `!!js` 自定义 YAML 标签往返（表达式不能降级成字符串） | `patch-editor.ts:23-64` | 值级透传 `!!js ` 前缀 + `{__js}` 模板标记（`mcp.ts:363-383`、`:589-594`），非整篇标签往返 | **部分对齐** |
| 工具过滤四层：global ∪ workspace ∪ sessionDeny − sessionAllow，再叠加 subagentAllow/Deny | `src/tool-filter.ts:7-15`；检测子代理/工作区/父会话在 `:179-201` | 只有 install（全局 deny）+ session（只 deny，沿 lineage 继承） | **缺 workspace 层、session allow、subagent 例外** |
| OAuth：发现顺序、PKCE、resource、**刷新调度** | `src/oauth.ts`（774 行）、`src/oauth-scheduler.ts`（304 行） | 2.0 `src/` 无 OAuth；1.x `lib/oauth.js` 有 | **P0（2.0 回归）** |
| CLI `dsh-panel`：skill / mcp 子命令、profile 概览、更新插件（npm/tarball/github） | `src/cli.ts`、`src/cli-skill.ts`、`src/cli-mcp.ts`、`src/updater.ts:24-137` | 22 命令 7 族（README:157-182），无插件自更新 | **缺自更新** |
| 技能：三栏、批量迁移、来源分组、同名影子"用这个"、回收站 | README:108-116 | 技能：导入/删除回收站/移动/预览（`skills.ts:584`/`:629`/`:1002`/`:1099`） | 大体对齐；缺"同名影子选择" |

### 3.4 dsh-plugin-tool-management 0.22.8（六域场景 + 三作用域 + 总控台）

| 它有的 | 证据 | 我们的现状 | 缺口判断 |
|---|---|---|---|
| **场景 = 整套环境**：MCP、技能、子智能体、记忆、快捷提示词、提示词预设、模型工具表；进入切换、退出按快照还原；可锁定、可绑定提示词预设 | README:38；`src/scope/scope-overrides.ts:11-48` | 场景只覆盖工具遮罩 + MCP（`scenes.ts:1-11`） | **缺域广度**（是否扩见 §8） |
| **三作用域**（全局/工作区/会话）+ 层叠解析「本层改过 > 进场景 > 创建快照 > 全局」，baseline 冻结 | README:68-78；`scope-overrides.ts:11-39`、`:61-107` | 全局 state + 会话工具覆盖；无工作区层、无"创建快照" | **缺作用域模型** |
| 兼容页 = 总控台：版本/能力体检、访问令牌、生效层级、注入域开关、模型工具表、侧栏入口 | README:44；`src/client/22-compat-page.js` | doctor 6 项 + 能力表（`diagnostics.ts:812`/`:210`），无版本/层级/令牌 | **部分缺** |
| 审计：`audit.jsonl`、域过滤、清空（两步确认，清空本身留痕） | `src/audit-log.ts:18`、`:87`、`:111`；`22-compat-page.js:128-195` | `history.jsonl` + 历史列表（`dispatch.ts:73`/`:122`），无过滤/清除 | **缺审计页** |
| patch 备份：`hub/backups/` KEEP=5、份数/占用、清理弹窗（提示备份含明文凭据） | `src/hub.ts:25`、`:64-66`；`src/boot/reconcile.ts:93`；`22-compat-page.js:121-132` | 写前备份 + 保留份数（`mcp.ts:476`/`:830`），**不可见、不可清理、不可恢复** | **缺 UI/恢复** |
| 启动对账：重启后核对 patch 与状态，保留现场，失败给出可操作提示 | `src/boot/reconcile.ts:1-30`、`:93-174` | 无启动对账 | 中 |
| 23 条模型工具覆盖六域 + 写操作确认卡 + 关掉的工具不在 schema | README:43；`src/tools/*.ts` 可见 19 个 `name:` 声明（mcp 3 / memory 3 / prompt 2 / scene 4 / skill 4 / subagent 2 / remove 1） | 模型侧只有 `hub_tools` | **缺模型工具面**（按定位取舍） |
| 斜杠 `/` 打开「工具」段，菜单不关、输入框不留命令字 | README:39；`src/client/48-slash.js:21-25` | 无 | 中 |
| 记忆九道门：source/novelty/durability/safety/scope/conflict/quota/evidence/layer；模糊降级不二选一 | `src/evolution/gates.ts:1-45` | 无（超出本插件定位） | 不做 |
| 回收站保留期 + 到期清扫 | `src/trash-retention.ts`、`src/ops/trash-retention.ts` | 回收站有（`skills.ts:148`），无保留期 | **可借（quick win）** |

### 3.5 更新的生态（npm，2026-11-21）

| 包 | 最新版 | 它补的那一层 | 对我们的意义 | 链接 |
|---|---|---|---|---|
| dsh-tool-manager | 1.4.1（2026-11-21） | preset 工具策略 + token 成本 + 提示词段落 | 直接竞品，§3.2 | [npm](https://www.npmjs.com/package/dsh-tool-manager) |
| @drifter-yh/dsh-tool-policy | 0.2.1 | **调用前** allow/ask/deny、deny-by-default、破坏性模式拦截、参数脱敏 | 与我们的"可见性遮罩"互补：我们管"看不看得见"，它管"调不调得动" | [npm](https://www.npmjs.com/package/@drifter-yh/dsh-tool-policy) |
| @michengai/dsh-skills-manager | 1.5.0 | 技能：GitHub 安装、更新预览、**备份回退**、20+ agent 目录 | 我们只有本地 zip/目录导入，无来源/更新/回退 | [npm](https://www.npmjs.com/package/@michengai/dsh-skills-manager) |
| dsh-trust-check | 0.2.6 | 插件**静态能力披露**（权限、注入、来源、安装脚本，证据 file+line，零 token） | 可挂到我们的插件行"启用前体检" | [npm](https://www.npmjs.com/package/dsh-trust-check) |
| dsh-plugin / dshmarket / dsh-plugin-catalog | 2.4.1 / 1.75.0 / 2026.1121 | 市场与目录（catalog 称 12392 条） | 我们已能导入 dshmarket 分组（`portability.ts:100`）；目录可作为"未知插件简介"来源 | [dsh-plugin](https://www.npmjs.com/package/dsh-plugin) |
| @dungsil/dsh-preset-tools | 0.2.3 | 纯 preset 打包（不带自有工具） | 说明"preset 级工具面"是共同需求 | [npm](https://www.npmjs.com/package/@dungsil/dsh-preset-tools) |

**本机 sandbox 已装**（共存事实，影响回归面）：dsh-tool-hub 2.0.0-alpha.29、dsh-skill-mcp-panel 2.3.16、dshmarket 1.73.23、dsh-better-sidebar 0.32.1、dsh-cost-meter 1.9.77、dsh-free-search 0.9.70。其中 skill-mcp-panel 装了 2.3.16，而 npm 最新为 2.3.12（克隆也是 2.3.16，可能为本地构建或未发布版本），它与我们共写的正是同一个 `cordis.patch.yml`。

---

## 4 专项：补丁预览 / 备份 / 恢复 / managed-block 感知

### 4.1 managed-block 感知（谁做到什么程度）

| 插件 | 标记 | 归属判据 | 外来行处理 | 写入方式 |
|---|---|---|---|---|
| **我们** | 只读识别 `# >>> <owner>:begin` / `end` | 按 owner 前缀表（`patch-blocks.ts:16`） | 只统计 `foreign`，不搬；新行插在**块外**（`:91`） | 行级改 `disabled:` 或替换单条（`mcp.ts`） |
| dsh-skill-mcp-panel | 自有 begin/end | `id` 前缀 `panel-mcp-`（`patch-editor.ts:150`） | **字节保真 + 主动搬出块**（`:366-408`） | 重建自有段、外来段原样搬运 |
| dsh-plugin-tool-management | 自有标记 + `ManagedRow` | 标记 id 集合（`mcp/patch-yaml.ts:232-247`） | `appendBlock` / `removeMarked` / `spliceRanges` | 整块拼接 |
| dsh-tool-manager / dsh-tool-switch | 不碰 patch | — | — | — |

**判断**：我们的"永不重建块"策略在共存上更安全（skill-mcp-panel #46 就是整块重写把别人行卷走），但缺两件：① 块内出现**我们的行**时没有能力把它搬到块外（只能拒绝写）；② 块标记不完整（未闭合）时只能"避开"，没有修复建议。这两件正是 G13 的内容。

### 4.2 备份 / 恢复

| 插件 | 写前备份 | 可见性 | 清理 | 单条恢复 |
|---|---|---|---|---|
| **我们** | 有（整份 patch 副本，`mcp.ts:476`） | **无** | **无** | **无**（只有写失败时的即时回滚 `mcp.ts:781`） |
| dsh-plugin-tool-management | 有（`hub/backups`，KEEP=5） | 有：份数 + 占用 | 有：弹窗 + 明文凭据提醒（`22-compat-page.js:121-132`） | 无（引导手工核对） |
| dsh-skill-mcp-panel | **未见**（`src` 内无 `backup/bak` 实现） | — | — | — |
| dsh-tool-manager / dsh-tool-switch | 仅 tool-manager 写自己的 json 时临时 `.bak`（`src/config.ts:87-95`），无保留策略；两者都不备份 patch | — | — | — |

### 4.3 写前 diff 预览

- 四个参考插件**都没有** patch 的写前 diff。唯一的"预演"在 dsh-plugin-tool-management 的记忆域：`evolution/write.ts:141` / `:345`（只读预演落哪一层、是否合并），与 patch 无关。
- 我们目前是"写后校验 + 失败回滚"（`mcp.ts:768-781`），比参考侧更安全，但用户在按下保存前看不到字节差异。

### 4.4 结论（三条）

1. **可借的**：块归属 + 外来行搬迁（skill-mcp-panel `patch-editor.ts:366-408`）、备份份数/占用/清理（plugin-tool-management）、启动对账（`boot/reconcile.ts`）。
2. **没人做、值得做**：写前 diff 预览 + 从备份恢复单条。我们已有备份与行级定位，成本比参考侧低。
3. **不要做**：整块重写自己的 MCP 段。收益（少几行拼接）远小于风险（把别人行卷走），且我们已有行级改。

---

## 5 优先级 backlog（18 条）

价值/成本口径：价值 = 用户可感知收益 × 影响面；成本 S ≤1 天、M 2–3 天、L 1–2 周。  
"宿主"列写需要的新 seam；写"无"或某个现有 service 的，表示现有能力即可，不需要上游改动。

| ID | 优先级 | 条目 | 价值 | 成本 | 依据 | Quick win | 宿主 |
|---|---|---|---|---|---|---|---|
| G1 | P0 | **遮罩生命周期**：启动时按 `agents.list` 给已存在 agent 重挂；订阅 `agent/created`/`agent/disposed`/`tools/change`（防抖 + signature 去重）；`agent/pre-step` 用 live `schemas(agent)` 核对，热装工具当步归位 | 高 | M | tool-switch `index.js:267-298`；tool-manager `runtime.ts:135,380-416`；我们无监听（§2） | 否 | 现有 `tools`/`agents` |
| G2 | P0 | **提示词族段落剔除**：`tool:<名称>`、按族注册的 `tool:<族>`、`mcp:<服务器>`、`mcp-resource-servers`，族内全隐藏才删段 | 高 | L | tool-manager README:26-28 + CHANGELOG 1.2.12/1.3.0；`prompt-affinity.ts:1-25`；我们无实现 | 否 | 需 fiber/effects 反射或上游 owner API |
| G3 | P0 | **2.0 补齐 MCP OAuth**（登录 + 刷新调度），或在 README/设置里明确降级 | 高 | M–L | 我们 `src` 无 oauth（grep）；1.x `lib/oauth.js`；skill-mcp-panel `oauth.ts`/`oauth-scheduler.ts` | 否 | 现有 webServer + fetch |
| G4 | P1 | **token 成本视图**：每行 `~N tok`、组净省、统计卡；先修孤儿设置 `showTokenEstimate`（`settings.ts:21`）；PTC 模式用 `renderSdk()` 边际 + 平台常数 | 高 | M | CHANGELOG 1.4.0/1.4.1；我们只有声明 | **部分是**（原生 JSON ÷4 口径） | `tools.definitions`/`selectExecutor`/`renderSdk`（可选，缺则回落） |
| G5 | P1 | **会话级工具开关三入口**：composer dock 按钮（带徽章）、`/tools` 斜杠、`tool_switch` 模型工具 | 高 | M–L | tool-switch README:22-52；`lib/client.js:740`；我们只有面板 | 否 | `conversation.composer.dock` + `commands` + `tools.register` |
| G6 | P1 | **工具作用域四层**：全局 deny ∪ workspace 覆盖 ∪ session（deny + **allow**）− allow，再叠 subagentAllow/Deny | 高 | M | skill-mcp-panel `tool-filter.ts:7-15,179-201`；我们只有全局+会话 deny | 否 | session header（origin/cwd/parent） |
| G7 | P1 | **备份可视化与恢复**：列出 `<DSH_HOME>/backups`（份数/占用/时间）、清理（两步确认 + 明文凭据提示）、从备份恢复**单条 MCP 条目**（先 diff 再写） | 高 | M | plugin-tool-management `hub.ts:64`、`22-compat-page.js:121-132`；我们备份不可见 | 只读列表是 | 无（fs） |
| G8 | P1 | **审计页升级**：域过滤、详情、清空（两步确认且清空本身留痕）、与备份联动 | 中 | S–M | plugin-tool-management `audit-log.ts:18,87,111`、`22-compat-page.js:128-195`；我们只有 tail 列表 | **是**（过滤 + 清除） | 无 |
| G9 | P1 | **场景扩为整环境**：至少纳入插件启停 + 技能启停 + preset 引用；场景锁定；绑定提示词预设（写 AGENTS.md 属 A 级，需确认） | 高 | L | plugin-tool-management README:38、`scope-overrides.ts:11-48`；我们 `scenes.ts:1-11` 只有两域 | 否 | 插件/技能写路径已有；AGENTS.md 需文件权限 |
| G10 | P1 | **按需组泛化**（非 MCP 工具也能按组按需）：`tool_list` 工具、组目录注入、按会话事件恢复（含 fork 前缀）、PTC 语义 | 高 | L | tool-manager README:48-70；`runtime.ts:601-650`、`exposure-history.ts:1-20`；我们只有 MCP 懒加载 | 否 | `tools.schemas(agent)` + session events |
| G11 | P1 | **preset 级工具策略**：每个 preset 的 disabled + 按需组；跨 preset 复制 / 重置（草稿态，保存才生效） | 中高 | M–L | tool-manager README:42-47、`config.ts:8` | 否 | 无 |
| G12 | P1 | **诊断/兼容页升级**：宿主版本与能力表、每项降级后果、一键复制环境摘要、注入域开关 | 中 | S–M | plugin-tool-management README:44；我们 `diagnostics.ts:210,812` 已有底子 | **是**（复制摘要） | 无 |
| G13 | P2 | **受管块归属 + 外来行搬迁**：块内出现我们的行时搬出（而非拒绝）；未闭合块给修复建议；与 skill-mcp-panel 的标记互认 | 中 | M | skill-mcp-panel `patch-editor.ts:366-408`；我们 `patch-blocks.ts:45,91` | 否 | 无 |
| G14 | P2 | **写前 diff 预览**：MCP 表单/原文/批量保存前显示 unified diff（字节级、含 CRLF），确认后才写 | 中高 | M | 参考侧无实现（§4.3）；我们 `mcp.ts:768-781` 是写后校验 | 否 | 无 |
| G15 | P2 | **回收站保留期 + 到期清扫**（技能/未来 MCP 删除共用） | 中低 | S | plugin-tool-management `trash-retention.ts`；我们 `skills.ts:148` 无保留期 | **是** | 无 |
| G16 | P2 | **插件能力披露**：启用前显示权限/注入/安装脚本/来源核对（证据 file+line） | 中 | L | dsh-trust-check 0.2.6 | 否 | 无（静态扫描本机包） |
| G17 | P2 | **技能来源追踪与更新/回退**：GitHub 安装、更新预览、备份回退 | 中 | L | @michengai/dsh-skills-manager 1.5.0；我们 `skills.ts:905,1002` 只有本地导入 | 否 | 网络 + 无 |
| G18 | P2 | **调用期策略层**（allow/ask/deny、破坏性模式拦截）：与可见性遮罩互补，或明确"推荐装 dsh-tool-policy" | 中 | L | @drifter-yh/dsh-tool-policy 0.2.1 | 否 | 需 tool-call 拦截 seam 或复用宿主 approval |

**分布**：P0 3 条（G1–G3）· P1 9 条（G4–G12）· P2 6 条（G13–G18）。合计 18。

---

## 6 Quick wins（≤1 天，可独立交付）

| ID | 做什么 | 验收 |
|---|---|---|
| Q1 | 修孤儿设置：`tools.showTokenEstimate` 要么接上"每行约 N tok（schema JSON ÷4）"，要么删掉 | 设置开关改变时行内数字出现/消失；`grep showTokenEstimate` 不再只有声明 |
| Q2 | 备份只读面板：列出 `<DSH_HOME>/backups` 份数/占用/时间 + 清理（两步确认，提示含明文凭据） | 与 plugin-tool-management 的 compat 页同信息密度；清理后目录份数下降 |
| Q3 | 历史页：域过滤 + 清空（两步确认，清空本身记一条） | 过滤后只剩该域；清空后新历史首条是"cleared" |
| Q4 | 回收站保留期：默认 30 天，启动时清理过期项并可关 | 造一个 31 天前的 trash 项，启动后被清；设置关掉后不清 |

（G8 的过滤+清除、G12 的复制摘要也在这个量级，已并入 Q2–Q3 的口径。）

---

## 7 需要新宿主 / 上游能力的项

| 能力 | 用在哪 | 现状 | 缺了怎么降级 |
|---|---|---|---|
| `systemPrompt` 段落归属（fiber effects 反射或官方 owner API） | G2 | 宿主只给 `section()`/`getSectionOrder()`（`diagnostics.ts:108-117`） | 先做命名约定（`tool:<名>` / `mcp:<服务器>`）的近似剔除，按族名注册的段落不动 |
| `tools.definitions()` / `selectExecutor()` / `renderSdk()` | G4（PTC 口径） | 未知是否暴露；tool-manager 1.4.1 已按可选入口适配 | 回落 schema JSON ÷4，并标注"不含 PTC" |
| `conversation.composer.dock` + `commands` | G5 | 我们只注册了三个 slot（`entry.tsx:58-61`） | 先做 `/tools`（若 commands 可用）+ 模型工具，dock 后补 |
| session header（origin / cwd / parent） | G6 | 我们用 `parentOf`（`sessions.ts:69`）；无 origin/cwd | subagent 例外退化为"按 lineage 继承"，workspace 层用 `TOOL_HUB_WORKSPACES` 手工配置 |
| `tools.schemas(agent)` 按步读取 | G10 | 未使用 | 按需组只在 op 时重算（会有一步延迟） |
| LLM runtime（自动分组的模型调用） | 未列入 18 条（G11 之外） | 未使用 | 保持规则式四桶 |
| tool-call 拦截 seam | G18 | 无 | 明确"装 dsh-tool-policy"，我们不做 |

---

## 8 不建议照搬

1. **记忆域 / 子智能体域 / 提示词预设域**：那是 dsh-plugin-tool-management 的"六域总控台"定位，不是开关台的定位。场景扩域（G9）到"插件+技能+preset"即可，记忆不碰。
2. **整块重写自己的 MCP 段**：skill-mcp-panel 的 ADR-0003 与自己 #46 都证明这条路会把别人行卷走；我们的行级改 + 块外插入更安全。只借它的"外来行搬迁"，不借"整块重建"。
3. **每步重装 `restrict`**：会让提示词前缀每步失效。参考侧也是"只在 baseline 真变时 reconcile"（`runtime.ts:400`）。G1 按 signature 去抖即可。
4. **PTC 与原生 token 数横向比较**：tool-manager 1.4.1 自己写明两者量的是不同文本、不可横向比较；我们的 UI 也要分开标注。
5. **registry 私有结构重绑**（`preset-repair.ts`）：依赖 `Symbol("dsh.scope")` 与 WeakMap，宿主一改就废；只作为"宿主 API 缺失时的最后手段"，不放进默认路径。

---

## 9 未决问题（需要主控 / 用户拍板）

1. **2.0 的 OAuth 是有意推迟还是遗漏？** README:149-155 仍在宣称 OAuth 可用，但 `src/` 无实现、`dist/` 也没有。若 2.0 切换后 OAuth 消失，属于对用户的功能回退（G3 的优先级取决于这个答案）。
2. **`tools.showTokenEstimate` 是漏接线还是待做？** 若待做，直接并到 G4；若废弃，删设置（Q1）。
3. **场景与 preset 的边界**：G9 把插件/技能纳入场景后，scene 与 preset 会高度重叠。是"scene = preset + 工具遮罩 + MCP"的组合，还是让 preset 吸收场景？这决定 G9/G11 的先后。
4. **与已装 skill-mcp-panel 2.3.16 的共存回归**：我们插在块外，它只重建自己的块——理论上不冲突。但它的 `evacuateForeignRows` 会把"块内非 `panel-mcp-` 行"搬到块前，若我们的行被别的编辑器 append 进它的块，会被它搬走。需要一次双面板共存走查（不在本次调研范围）。
5. **工具级分组的数据从哪来**：tool-switch 用内置能力族表，tool-manager 用注册归属恢复。我们两样都没有，G5 的分组需要先定来源（硬编码族表 vs 按 MCP 服务器 vs 按插件 entry）。

---

## 10 证据索引（按文件）

**参考侧**

- `dsh-tool-switch/index.js:38`（`tool_switch`）、`:111`（state 路径）、`:139-161`（disabled 集）、`:225-228`（allow 补集 + signature）、`:244`（restrict）、`:267-298`（三类事件）、`:358-396`（目录与 fixed 计数）
- `dsh-tool-switch/lib/client.js:7`（composer.dock）、`:194`（默认收起）、`:243-272`（整组开关）、`:487`（搜索）、`:740-743`（slot 注入）
- `dsh-tool-manager/src/runtime.ts:135`（pre-step）、`:380-416`（live 核对）、`:436-449`（tool_list 兜底）、`:601-650`（tool_list 注册）、`:722`（reconcile）
- `dsh-tool-manager/src/exposure-history.ts:1-20`（事件恢复）、`catalog.ts:1-25`（目录消息 + digest）、`prompt-affinity.ts:1-25`（归属恢复）、`composition-watch.ts:1-30`（竞态重校准）、`preset-repair.ts:1-25`（重绑）、`notices.ts:1-25`（banner）、`suggest.ts:9-33`（超时）、`config.ts:8`（tool-manager.json）
- `dsh-skill-mcp-panel/src/patch-editor.ts:18-19`（标记）、`:150-176`（归属/外来）、`:200/267/299`（读/生成/替换）、`:334-338`（锁）、`:366-408`（搬迁）、`:423`（写回）；`tool-filter.ts:7-15,179-201`（四层）；`updater.ts:24-137`（自更新）
- `dsh-plugin-tool-management/src/scope/scope-overrides.ts:11-48,61-107`（层叠）、`boot/reconcile.ts:93-174`（启动对账）、`hub.ts:25,64-66`（备份目录）、`audit-log.ts:18,87,111`（审计）、`client/22-compat-page.js:121-195`（备份/审计 UI）、`evolution/gates.ts:1-45`（九道门）、`client/48-slash.js:21-25`（斜杠）

**本仓库**

- `src/client/entry.tsx:58-61`（三槽位）
- `src/domains/tool-surface.ts:135/469/501/506`（合并/应用/去抖/restrict）、`:245/284/305`（懒加载）
- `src/domains/sessions.ts:42/55/69/98-106`（lineage/覆盖/父查找/写入）
- `src/domains/mcp.ts:11-14`（写路径契约）、`:134`（备份目录）、`:476`（备份）、`:768-781`（校验/回滚）、`:547`（秘密遮蔽）
- `src/core/patch-blocks.ts:16/45/91`（owner 表/扫描/块外插入）
- `src/domains/scenes.ts:1-11/151`（两域场景）
- `src/domains/presets.ts:105/164`（四维快照/解析）
- `src/domains/settings.ts:21/25`（token 设置/备份保留）
- `src/host/catalog-tool.ts:80`（hub_tools）
- `src/host/diagnostics.ts:108-117/210/812`（段落能力/能力表/doctor）
- `src/host/dispatch.ts:73/102/122`（历史）
- `src/domains/skills.ts:148/584/629/905/1002/1099`（回收站/删除/恢复/导入/搬移）
- `src/host/portability.ts:325/361`（回滚点）
- `src/domains/config.ts:426-428/474`（导入重放遮罩/配置域）

**外部**

- [dsh-tool-manager 1.4.1 CHANGELOG](https://unpkg.com/dsh-tool-manager@1.4.1/CHANGELOG.md)（token 成本、PTC 口径）
- [@drifter-yh/dsh-tool-policy](https://www.npmjs.com/package/@drifter-yh/dsh-tool-policy) · [@michengai/dsh-skills-manager](https://www.npmjs.com/package/@michengai/dsh-skills-manager) · [dsh-trust-check](https://www.npmjs.com/package/dsh-trust-check) · [dsh-plugin](https://www.npmjs.com/package/dsh-plugin) · [dshmarket](https://www.npmjs.com/package/dshmarket)
