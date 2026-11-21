# G5 / G10 设计：会话级工具开关三入口 · 按需组泛化

> 范围：只读调研 + 设计契约。**未改动 `src/`**。
> 口径：每条断言带证据；形如 `path:line` 的行号均在本机实际读过（子代理回报只用于定位，关键行已自验）。
> 路径缩写：
> - `@dsh:` = `D:\Software\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai`（本机宿主源码，随安装分发，含 `src/`）
> - `SW:` = `C:\Users\fenri\AppData\Local\Temp\tool-hub-refs\dsh-tool-switch`（0.2.2）
> - `TM:` = `C:\Users\fenri\AppData\Local\Temp\tool-hub-refs\dsh-tool-manager`（克隆 1.3.0，`package.json:3`）
> - 本仓库路径相对仓根。

---

## 0 结论摘要

**G5（三入口）**：宿主三个接缝都已确认存在且可用 —— `conversation.composer.dock`（list / session）、`commands.register()`、`tools.register()`。2.0 已有全部**数据面**（`state.sessions` deny + `session.set`/`session.clear` + 掩码），缺的只是三个**写通道**与一个**聚合读**。三入口必须共用同一域函数，不能各自写状态。

**G10（按需组泛化）**：2.0 的 on-demand 今天是**死代码**：`SurfacePort.onDemandTools?()` 只有声明没有实现（`src/domains/tool-surface.ts:346-347` 声明，`src/host/tool-mask.ts:514-522` 的 `surfacePort` 未提供），且名字宇宙被 `mcp__` 前缀硬过滤在三处（`tool-surface.ts:79-102`、`tool-mask.ts:50-52/135/204/215`、`sessions.ts:106`）。泛化需要改的正是这三处 + 补一个真端口 + 一个发现工具 + 一段提示词 + 一套按会话恢复。

**两处对任务描述的事实更正**（影响实现，先写清）：

1. **「fork 前缀」不是 id 字符串前缀**。参考实现没有任何 agent/session id 前缀匹配；fork 恢复靠「从 `seq = 0` 重放会话日志，天然包含继承前缀」（`TM:src/exposure-history.ts:4-13` 的注释与 `:22-36` 的循环）。DSH 侧对应字段是 `isSeeded`（`@dsh:dsh-session/src/types.ts:117`）与 `inheritedEventCount`（`:182`）。
2. **「group catalog prompt」在参考实现里不是 systemPrompt 段**，而是 `agent/pre-step` 瀑布上合成的 **user 消息**（`TM:src/catalog.ts:89-109` + `TM:src/runtime.ts:457-482`）。本设计仍给两种选项，v1 建议用 **agent 作用域的 `systemPrompt.section`**（宿主证据：`@dsh:dsh-system-prompt/src/index.ts:53-68` 的 `text` 支持函数）。

---

### 0.1 验证状态（UNVERIFIED 清单）

本轮亲自读过并逐行核对：宿主 §2.1–§2.7 的全部行号；参考实现 `TM:src/exposure-history.ts` 全文、`TM:src/catalog.ts:40-109`、`TM:src/policy.ts:138-169`、`TM:src/runtime.ts:595-660 / 656-695 / 862-891`；`SW:index.js:30-60 / 126-260 / 262-306 / 560-660 / 660-719`；`SW:lib/client.js:7 / 740-749`。

**UNVERIFIED（未逐行复核，来源为参考项目阅读笔记；实现前请复核）**：
- `SW:lib/client.js:635-640、655-707`（徽标刷新与渲染细节；只核了 :740-749 与 :746-747 的 inject 形状）
- `SW:index.js:516-559`（目标解析优先级；已核 :614-655 的调用点）
- `TM:src/types.ts:8-26`、`TM:src/policy.ts:69、211-219`、`TM:src/catalog.ts:54-60、176-181`、`TM:src/runtime.ts:433-455、600-608、639-644`、`TM:src/composition-watch.ts:396`
- `TM` 克隆为 1.3.0；README/CHANGELOG 所述 1.4.x 行为不在本次证据范围内

## 1 现状基线（2.0 alpha.41 已有）

| 能力 | 现状 | 证据 |
|---|---|---|
| 会话覆盖层状态 | `state.sessions: Record<sessionId, string[]>`，值是**关闭**名单 | `src/core/state.ts:38`、`:117-128` |
| 会话 op | `session.set` / `session.clear` / `session.lineage` | `src/domains/sessions.ts:101-136`、`:144-148` |
| 血缘继承 | 近→远并集，深度 8、防环 | `sessions.ts:42-52`、`:55-62`；`tool-surface.ts:369-405` |
| 掩码落地 | 每 agent 作用域插件调 `tools.restrict({deny})`，先装后撤 + signature 去重 | `src/host/tool-mask.ts:225-354`（`:259-260` 去重、`:275-295` 先装后撤） |
| 会话层同步 | `maskControl.setSessionDeny` | `sessions.ts:91-99`；`tool-mask.ts:525-529` |
| 合并器 | 四源固定顺序 `install / session / lazy / onDemand` | `tool-surface.ts:106-114`、`:135-171` |
| on-demand 组标记 | `GroupRecord.onDemand`，随 `group.save` 写入 | `src/domains/groups.ts:39-50`、`:345-378`（`:352`） |
| on-demand 成员枚举 | `onDemandMembers(groups)` 返回 `Member[]`（plugin/skill） | `groups.ts:478-491` |
| on-demand → 掩码 | **断链**：端口方法只声明，无人实现 | `tool-surface.ts:346-347`；`tool-mask.ts:514-522` |
| 目录工具 | `hub_tools`（list/enable/disable），仅 MCP 懒加载 | `src/host/catalog-tool.ts:44-95`；注册 `src/host/index.ts:313-335` |
| 提示词 | `lazyPrompt()` 只在 `tool.describe` 返回值里，**没有**注册进系统提示词 | `tool-surface.ts:284-292`、`:684-697`；capability 表 `src/host/diagnostics.ts:106-114` 声明但未使用 |
| 客户端入口 | 只有 `plugins.tab` / `sidebar.panellist` / `main` 三个 slot | `src/client/entry.tsx:58-62`、`:85-96` |
| 客户端依赖 | `dsh.client.inject = [locale, ui-sidebar, ui-layout]` | `package.json:35-47` |

**结论**：G5 是「接线」，G10 是「补链 + 去 MCP 硬编码」。

---

## 2 宿主接缝（三个入口 + 组目录需要的）

### 2.1 Composer dock（入口 1）

| 事实 | 证据 |
|---|---|
| `conversation.composer.dock` 是 **list / session** 槽 | `@dsh:dsh-client-ui-conversation/src/client/contract/slots.ts:315` |
| 另有 `conversation.input.dock`（list / session，owner `InputZone`），被 goal / todo / queue 使用 | `:305`；消费方 `dsh-client-ui-goal/src/client/index.ts:102-103`、`.../skeleton/TodoPanel.tsx:116-117`、`.../queue/QueueDock.tsx:397-398` |
| 渲染位置：输入框卡片内 `data-composer-dock` 那一行，且要求 `variant === 'composer' && sessionId !== undefined` | `.../skeleton/InputBar.tsx:596-599` |
| 注册形状：`ctx.slots.inject(slot, () => ctx.slots.register(meta, Component))`，meta 含 `name/id/order/locale/inject` | `@dsh:dsh-client-ui-chat/src/client/apply.ts:341-350` |
| `inject` 是「接 sessionId、返回 props」的函数 | 同上 `:342`（`statPillInject = () => ({hooks:{performanceUsage}})`）；参考实现 `SW:lib/client.js:746-747` 直接 `inject: (sessionId) => ({ sessionId })` |
| 参考实现确实挂这个槽（不是 `input.dock`） | `SW:lib/client.js:740-749` |

> 两个 dock 都存在且都是 session 作用域；**要「输入框那条里的工具开关」用 `composer.dock`**，`input.dock` 是 goal/todo 用的另一条（1.x 交接文档里 client-smoke 校验的 slot 名与此一致：`HANDOFF-dsh-tool-hub.md:82`）。

### 2.2 斜杠命令（入口 2）

| 事实 | 证据 |
|---|---|
| 服务：`ctx.commands`（`CommandRuntime`） | `@dsh:dsh-commands/src/index.ts:263`、`:113-117` |
| 注册：`register(definition): () => void`，绑定在调用者作用域的 effect 上 | `:285-292` |
| 定义：`{name, description, input?, handler}`；`name` 必须匹配 `/^[a-z][a-z0-9_-]*$/u` | `:32`、`:61-78` |
| 处理签名：`handler(invocation)`，invocation 含 `agent`、`rawInput`、`attachments`、`signal` | `:41-58` |
| 返回值：`{kind:'success', text?} | {kind:'error', text}` | `@dsh:dsh-commands/src/types.ts:34-41` |
| 同名冲突会抛（每层唯一） | `index.ts:102-104` |
| 命令生命周期事件 `command/run` / `command/done` 会进会话日志 | `:335-342` 文档注释 |
| 参考实现用 `ctx.inject(['commands'], c => c.effect(() => c.commands.register(...)))` | `SW:index.js:638-659` |

### 2.3 模型工具（入口 3）

| 事实 | 证据 |
|---|---|
| 注册：`tools.register(definition, options?)` → disposer；`run_code` 名字保留，注册即抛 | `@dsh:dsh-tools/src/index.ts:128-153`（`:145-147`） |
| `definition` = `ToolSchema` + `output {schema, render}` + `execute(args, exec)`；**不含 owner/plugin 字段** | `@dsh:dsh-tools/src/contracts.ts:27-40` |
| `exec.agent` 是调用方 agent（`ToolExecutionInput.agent`） | `contracts.ts:186-190` |
| 插件注册范例（全局 + `ctx.inject(['tools'])` + try/catch） | 本仓库 `src/host/index.ts:313-335` |
| 参考实现把 `tool_switch` 注册为全局工具，`execute` 里取 `exec.agent` | `SW:index.js:663-717`（`:700-711`） |

### 2.4 掩码与名字宇宙（G10 相关）

| 事实 | 证据 |
|---|---|
| `restrict({allow?, deny?})` 必须**有作用域**（agent.ctx），全局调用抛 | `@dsh:dsh-tools/src/index.ts:162-166` |
| 空过滤器是 no-op 会抛；未知名字抛（列出 known global tools） | `:169-183` |
| **不能点名 `run_code`**（PTC 传输层保留） | `:176-178` |
| 限制取交集；**scope 自己的注册不受 restrict 影响** | `:184-189`、`:191-196` 注释 |
| `view()` 的 `restrictableNames` = 继承到的全局/祖先名字；自身 scope 注册只进 `visible` | `:199-227`（`:219-225`） |
| `definitions()/schemas()` 是**已过滤后**的视图 | `:305-317` |
| 我们的实现里 `tools.view` 在 TS 上是 private，运行期可调 | `:199`（`private view`）；本仓库已在用：`tool-mask.ts:64-74`、`snapshot.ts:73-84` |

### 2.5 PTC 语义

| 事实 | 证据 |
|---|---|
| PTC 只向模型声明 `run_code`：`describe()` 返回 `schemas:[run_code]`、`knownNames:[run_code]` | `@dsh:dsh-tool-executor-ptc/src/index.ts:47-49` |
| 真实工具以 **prompt 段 `tools:sdk`** 呈现，文本由 `definitions` 渲染（`text: tools => ...`） | `:35-38`、`:51-58` |
| 因此「隐藏 = 从 `definitions()` 消失 = 从 SDK 段消失」；省的是该段 token | 推论，依据同上 + `index.ts:305` |
| 直接调用非 `run_code` 的工具会被拒（PTC 下必须从程序内调） | `:39-44` |

### 2.6 会话日志（G10 恢复用）

| 事实 | 证据 |
|---|---|
| `Session.readonly seq` | `@dsh:dsh-session/src/types.ts:557` |
| `eventAt(seq)` | `@dsh:dsh-session/src/index.ts:745` |
| `parentSession?`、`isSeeded`、`inheritedEventCount` | `types.ts:112`、`:117`、`:182` |
| `agent.session` 可用 | `@dsh:dsh-agent/src/runtime-types.ts:191-195` |
| `agent/pre-step` 是 waterfall：可 `reject` 或 `enter` 换消息 | `runtime-types.ts:339-351`；`PreStepDecision` `:138-146` |

### 2.7 提示词段

| 事实 | 证据 |
|---|---|
| `PromptSection.text: string | ((ctx) => string)`，可动态 | `@dsh:dsh-system-prompt/src/index.ts:53-68`（`:66`） |
| `systemPrompt.section(section)` 注册，返回 disposer | `:485-494` |
| `getSectionOrder(name)`，`MCP_SERVERS: 3100` | `:501-503`、`:165` |
| `systemPrompt.tools(provider)`（工具目录 provider） | `:552-558` |
| 宿主 PTC 插件用函数式 `text` 的先例 | `@dsh:dsh-tool-executor-ptc/src/index.ts:37` |

---

## 3 G5 设计：会话级开关三入口

### 3.1 模型

- 状态**不新增**：沿用 `state.sessions[sessionId] = 关闭名单`（`state.ts:38`）。理由：1.x 交接的设计决定 **「掩码用 deny，不用 allow」**（`HANDOFF-dsh-tool-hub.md:124`），且 2.0 全部下游都按 deny 读（`surfaceInputFor` `tool-surface.ts:424`、`ToolMask.denyFor` `tool-mask.ts:194-200`）。
- 三入口只共享一个域函数；入口层只做「解析输入 → 调函数 → 出文本」。
- 「关闭」的判定口径（与参考实现一致）：`enabled = !restrictable || !disabled.has(name)`（`SW:index.js:368-370`）；agent 作用域内注册的工具不可关，标 `fixed`（`SW:index.js:367/382`，宿主依据 `@dsh:dsh-tools/src/index.ts:191-196/219-225`）。

### 3.2 域层契约（`src/domains/sessions.ts` 追加）

```ts
export type SwitchAction = 'list' | 'off' | 'on' | 'reset'

export interface SwitchCounts {
  total: number      // known 里的工具数（restrictable 口径）
  enabled: number
  disabled: number
  fixed: number      // known − restrictable：agent 作用域注册，关不掉
}

export interface SwitchTarget { names: string[]; label: string }

/** 目标解析：all/全部 → 精确名 → 分组名（大小写不敏感）→ 分组标签 → 前缀。任一失败即整体失败。 */
export function resolveSwitchTargets(
  known: readonly string[],
  restrictable: ReadonlySet<string>,
  groups: ReadonlyArray<{ name: string; tools: string[] }>,
  needle: string,
): SwitchTarget | { error: string }

/** 计数；missing = 已关但当前不存在的名字（脏状态暴露，不参与掩码）。 */
export function sessionCounts(
  state: StateV2, sessionId: string, known: readonly string[], restrictable: ReadonlySet<string>,
): SwitchCounts & { mode: 'all' | 'custom'; missing: string[] }

/** 动作：list 不动；off 加；on 减；reset 清空。返回 changed 供调用方决定是否落盘。 */
export function applySessionSwitch(
  state: StateV2, sessionId: string, action: SwitchAction, target: string | undefined,
  known: readonly string[], restrictable: ReadonlySet<string>,
  groups: ReadonlyArray<{ name: string; tools: string[] }>,
): { ok: boolean; message: string; names: string[]; counts: SwitchCounts; mode: 'all' | 'custom'; changed: boolean }
```

语义细节（逐条对照参考实现，避免各入口漂移）：
- 多目标以 `/[\s,]+/` 切分，**任一目标解析失败则整条不写**（`SW:index.js:614-620`）。
- `on` 只能减、`off` 只能加；重复执行幂等（Set 语义）。
- 保留名永不进入名单：`run_code`（宿主硬限制 `@dsh:dsh-tools/src/index.ts:176-178`）、`tool_switch`（自身入口，`SW:index.js:561`）、`tool_list`/`hub_tools`（发现入口，见 §4.5）。
- 存储前排序（`sort()`），空集合 `delete state.sessions[sessionId]`（与现有 `session.set` 一致：`sessions.ts:107-108`）。
- 文案带「下一条消息生效」（`SW:index.js:633`），因为掩码在下次读 schema/提示词时体现。

### 3.3 op 契约

| op | 载荷 | 写 | audit | 行为 |
|---|---|---|---|---|
| `session.switch` | `{ sessionId: string, action: 'list'/'off'/'on'/'reset', target?: string }` | ✔ | ✔ | `applySessionSwitch` → `env.save('session-switch')` → `applySurface` + `toolHub.mask.setSessionDeny`（复用 `sessions.ts:91-99` 的 `maskAfter`） |
| `session.summary` | `{ sessionId: string }` | ✘ | ✘ | `sessionCounts` + `missing`；供 dock 徽标与 `/tools` 首行 |
| `session.set` / `session.clear` / `session.lineage` | 不变 | 不变 | 不变 | 已有探针覆盖（`probe/next/client-sessions.mjs`） |

返回体（`session.switch`）：`{ ok, action, names, counts, mode, missing, message, backup, mask }`；失败用 `fail('bad-action' | 'unknown-target', ...)` 走既有 `DomainFailure` 通道（`tool-surface.ts:35-49`）。

### 3.4 命令入口（`/tools`）

新文件 `src/host/commands.ts`：

```ts
export const TOOLS_COMMAND = 'tools'
export function installToolsCommand(
  ctx: { inject?: Function },
  execute: (op: unknown, payload: unknown) => Promise<unknown>,   // dispatcher.execute
): void
```

注册（照 `SW:index.js:638-659` 的形状，失败只 warn）：

```ts
ctx.inject?.(['commands'], (scope) => {
  scope.effect?.(() => scope.commands.register({
    name: 'tools',
    description: 'List or switch the tools this session lets the model call.',
    input: { hint: '[list|off|on|reset] [group|tool|prefix|all]' },
    handler: async ({ agent, rawInput }) => {
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return { kind: 'error', text: 'no session id' }
      const { action, target } = parseToolsInput(String(rawInput ?? ''))
      const result = await execute('session.switch', { sessionId, action, target })
      return { kind: 'success', text: String((result as any)?.message ?? '') }
    },
  }), 'tool-hub: /tools command')
})
```

- 解析规则沿用参考：`all on` / `all off` 前置动词也认；空输入 = `list`（`SW:index.js:648-655`）。
- 名字冲突抛错（`@dsh:dsh-commands/src/index.ts:102-104`）→ 外层 try/catch + `ctx.logger.warn`，与 catalog 工具注册一致（`src/host/index.ts:327-329`）。
- 卸载：`scope.effect` 自带 disposer（`:285-292`）。

### 3.5 模型工具入口（`tool_switch`）

新文件 `src/host/switch-tool.ts`，形状照 `src/host/catalog-tool.ts:80-95`（可注入 execute 的纯工厂，便于探针）：

```ts
export interface SwitchToolDefinition { name: string; description: string; parameters: object; output: {...}; execute(args, exec): Promise<unknown> }
export function createSwitchTool(execute: (op, payload) => Promise<unknown>): SwitchToolDefinition
```

- `name: 'tool_switch'`；`action` 枚举 `list/off/on/reset`；`target?: string`（`SW:index.js:668-683`）。
- `execute`：`sessionId = exec?.agent?.session?.id`；拿不到就返回 `{ok:false, message:'no session'}`（`SW:index.js:700-703`）。
- 出参 `{ok, action, enabled, total, message}`，`render` 只吐 `message` 文本（`SW:index.js:684-697`）。
- 注册位置：`src/host/index.ts` 的 `apply()` 里，紧挨 catalog 工具那段（`:313-335`），全局作用域（`ctx.inject(['tools'])`）。

### 3.6 客户端入口（dock 按钮 + 徽标）

新文件 `src/client/dock.tsx`：

```tsx
export const DOCK_SLOT = 'conversation.composer.dock'
export const DOCK_ORDER = 40           // chat 的 activity=0 / usage=1；参考实现用 40（SW:lib/client.js:745）
export function createDockInjected(): (sessionId: string) => { sessionId: string }
export function DockButton(props: { sessionId?: string; onOpen: () => void; t: TFunction }): JSX.Element | null
```

- 数据：挂载时 `runOp('session.summary', { sessionId })`；每次开关后由 `onChanged` 回填；**不轮询**（参考实现同样只在挂载/开关回填：`SW:lib/client.js:635-640`）。
- 徽标：`mode === 'custom'` 时显示 `counts.disabled`，同时进 `title` 与 `aria-label`（`SW:lib/client.js:655-670`）。
- 点击：`layout.selectPanel(NS)` 打开既有面板的会话视图（`src/client/entry.tsx:67-76` 已有 `layout` 取法）。
- `entry.tsx` 追加一条注册（照 `:85-96` 的循环之外的独立注册，因为 meta 不同）：

```ts
ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register(
  { name: DOCK_SLOT, id: NS, order: DOCK_ORDER, locale: NS, inject: (sessionId: string) => ({ sessionId }) },
  () => React.createElement(DockButton, { onOpen: openPanel }),
))
```

- `package.json`：`dsh.client.inject` 加 `@deepseek-ai/dsh-client-ui-conversation`，并加 `"immediately": true`（先例：`SW:package.json` 的 `dsh.client = { platform:'web', immediately:true, inject:['@deepseek-ai/dsh-client-ui-conversation'] }`）。当前值见 `package.json:35-47`。

### 3.7 文件清单

| 文件 | 改动 |
|---|---|
| `src/domains/sessions.ts` | 追加 §3.2 函数 + `session.switch`/`session.summary` 两个 op（`:139-155` 的 domain 注册表加两行） |
| `src/host/commands.ts` | 新增：`/tools` 注册 |
| `src/host/switch-tool.ts` | 新增：`tool_switch` 定义 |
| `src/host/index.ts` | `apply()` 里接 `installToolsCommand` + `createSwitchTool`（`:313-335` 邻近） |
| `src/client/dock.tsx` | 新增：dock 组件 + i18n 文案 |
| `src/client/entry.tsx` | 注册 `composer.dock` 条目 |
| `package.json` | `dsh.client.inject` + `immediately` |
| `src/host/diagnostics.ts` | 能力表加 `commands.register`（`:99-105` 风格） |
| `probe/next/client-shell.mjs`、`client-sessions.mjs`、新增 `tool-switch.mjs` | 见 §3.8 |

### 3.8 探针用例（G5）

1. `sessions`：`applySessionSwitch` 四动作；off 两次幂等；on 清空即删 key；reset 删 key；多目标其一未知 → 全不写；保留名被剔除。
2. `session.summary`：`mode/missing/counts`；`fixed = known − restrictable`；脏名字只进 `missing`。
3. 命令：解析 `all on` / `off mcp:foo` / 空输入；handler 返回 `{kind:'success'|'error'}`；重复注册不抛（被 catch）。
4. 工具：schema 形状（action 枚举、additionalProperties:false）；缺 agent 时 `{ok:false}`；render 只吐 message。
5. 客户端：dock 注册 meta（slot/id/order/inject 参数名）、徽标仅在 custom 显示、无 timer/poll。
6. `package.json`：`client.inject` 含 ui-conversation。

---

## 4 G10 设计：按需组泛化（不止 MCP）

### 4.1 缺口清单（逐条带证据）

| # | 缺口 | 证据 |
|---|---|---|
| D1 | `mergeSurface` 只收 `mcp__` 名 | `tool-surface.ts:79-102`（`mcpNames`、`unionNames`） |
| D2 | `ToolMask` 三处再过滤 MCP（层、会话、hydrate） | `tool-mask.ts:50-52`、`:134-147`、`:202-208`、`:211-218` |
| D3 | 会话覆盖层也 MCP-only | `sessions.ts:106`（`unionNames`） |
| D4 | `tool.save` 只收 MCP 名 | `tool-surface.ts:619-623`（`requireDeny`） |
| D5 | `onDemandTools` 端口无实现（死链） | 声明 `tool-surface.ts:346-347`、消费 `:427`；提供方 `tool-mask.ts:514-522` 未实现 |
| D6 | 组成员只有 plugin/skill，无法表达「工具」 | `groups.ts:30-35`、`:478-491` |
| D7 | 无「组已打开」的会话状态与恢复 | `state.ts:38-48` 无此字段；`tool-surface.ts:199-233` 只有 lazy |
| D8 | 组目录不进提示词 | `tool-surface.ts:284-292` 仅 `tool.describe`；`diagnostics.ts:106-114` 声明未用 |
| D9 | 发现工具只覆盖懒加载服务器 | `catalog-tool.ts:44-78` |
| D10 | 无按会话日志恢复 | 全仓无 `eventAt`/`seq` 调用（grep 结果为空） |

### 4.2 参考实现事实（已逐行自验，用作算法依据）

**按需组模型**：per-preset 映射 `{disabled: string[], groups: {name, description?, patterns: string[]}[]}`（`TM:src/types.ts:8-26`）；组成员 = 基线 ∩ 模式，`tool_list`/`run_code` 永不成组员（`TM:src/policy.ts:69`、`:211-219`）。

**deny 集合（核心算法）**：

```ts
// TM:src/policy.ts:145-166 —— 已自验
for (const group of groups) {
  if (open.has(group.name.toLowerCase())) continue
  for (const name of group.tools) hidden.add(name)
}
for (const name of policy.disabled) if (toolNames.includes(name)) hidden.add(name)
hidden.delete(PTC_TRANSPORT_NAME)                 // run_code 永不 deny
if (groups.length > 0) hidden.delete(DISCOVERY_TOOL_NAME)   // 有组则保留发现工具
else if (toolNames.includes(DISCOVERY_TOOL_NAME)) hidden.add(DISCOVERY_TOOL_NAME)
return toolNames.filter(name => hidden.has(name)) // 与 baseline 取交
```

**发现工具**：`tool_list`，唯一参数 `group`，`execute` 取 `exec.agent` → `openGroup`；注册在**宿主/全局层**（理由：PTC 只把 inherited 工具投进 SDK，`TM:src/runtime.ts:600-608`）；`openGroup` 先 `syncBaseline` 再 `exposures.add` + `reconcile`（`:433-455`）。

**目录消息**：合成 `user` 消息，`source.kind='tool-manager-catalog'`（`TM:src/catalog.ts:89-109`），由 `agent/pre-step` 的 `{kind:'enter', messages}` 注入（`TM:src/runtime.ts:457-482`）；sha256 digest 去抖，只在变化时换消息（`TM:src/catalog.ts:47-52`、`:176-181`）。

**会话恢复**：从 `seq=0` 重放，只认配对成功的 `tool/call`→`tool/result`（非 error）与 `tool/ptc-dispatch`（`TM:src/exposure-history.ts:22-96`，已自验）；fork 语义见 `:4-13` 注释。**无 id 前缀匹配；`inheritedEventCount` 在该模块未使用**（只在 `composition-watch.ts:396` 用）。

**每步过滤**：参考实现为了遮住「agent 作用域注册」的工具，patch 了 `ToolsService.prototype.resolve`，在 step set 上做 `view()` 过滤（`TM:src/runtime.ts:656-671`、`:872-884`，已自验）。这是**私有面**，风险自担；我们的 v1 不做（见 §4.6 R4）。

### 4.3 目标模型（我们的）

**4.3.1 名字宇宙（一条规则，一处实现）**

`src/domains/tool-surface.ts`：

```ts
/** Any model-callable tool name; the one predicate every layer shares. */
export function toolName(value: unknown): string | null      // trim, 1..200 chars
export function toolNames(value: unknown): string[]           // 去重、保序
export const RESERVED_TOOLS: ReadonlySet<string> = new Set(['run_code', 'tool_switch', 'tool_list', 'hub_tools'])
export function maskable(names: readonly string[]): string[]  // toolNames ∩ !RESERVED_TOOLS
```

替换点（逐处）：
- `mergeSurface` 里 `mcpNames(...)` → `maskable(toolNames(...))`；`unionNames` 同步改（`:91-102`），并在 `MergedSurface` 增加 `reserved: string[]`（被剔除的保留名，供面板显示）。
- `lazyDeny` 保持 MCP 语义不变（lazy 服务器只可能是 MCP：`:237-255`）。
- `tool.save` 的 `requireDeny`：接受任意 `known` 名；保留名报 `fail('reserved-tool', ...)`（`:619-623`）。
- `tool-mask.ts` 的 `mcpOnly` → `maskable`（导入同一常量，避免两处漂移）；`addLayer`/`setSessionDeny`/`hydrate` 三处调用点保留结构不变（`:135`/`:204`/`:215`）。
- `sessions.ts` 的 `unionNames` 调用点（`:106`）随之放开。

> 影响面：install 级 deny（`tool.save`）从此可点名非 MCP 工具。这是 G5 能关 `pwsh` 之类的前提，也是 G10 的基础。**先做这一步**（见步骤 1）。

**4.3.2 组成员：显式「工具」成员**

`groups.ts`：

```ts
export type MemberKind = 'plugin' | 'skill' | 'tool'   // 原：30 行
export interface GroupRecord {
  /* ...既有字段... */
  onDemand: boolean
  /** Tool names this group owns for on-demand masking (resolved against the live view). */
  tools?: string[]                                    // NEW，默认 []
}
export function onDemandToolNames(groups: readonly GroupRecord[], known: readonly string[]): string[]
export function onDemandDeny(
  groups: readonly GroupRecord[], known: readonly string[],
  open: ReadonlySet<string>,
): string[]
```

- 为什么**不**反推「插件 → 它注册的工具」：宿主 `ToolDefinition` 没有归属字段（`@dsh:dsh-tools/src/contracts.ts:27-40`），`view()` 只给名字（`:199-227`）。要反推只能靠 fiber 反射或 patch 私有方法（参考实现的 `prompt-affinity.ts` 路线），成本与稳定性都不划算。
- 因此 `tool` 成员与 `GroupRecord.tools` 都是**显式数据**，面板从活工具列表里挑；`onDemandMembers()`（`:478-491`）继续服务「整组批量开关」（plugin/skill），互不干扰。
- `onDemandDeny`：只取 `onDemand === true` 且**未打开**的组的 `tools ∩ known`，再减 `RESERVED_TOOLS`；空则返回 `[]`。

**4.3.3 「组已打开」按会话**

- 真源（决定掩码）：**会话日志重放**，见 §4.4。
- 缓存（决定面板显示/重启后无 log 时）：`state.modules['tool-surface'].open: Record<sessionId, string[]>`。注意 `LAZY_STATE_KEY = 'tool-surface'` 已占用该键（`tool-surface.ts:205`），`readLazy/writeLazy` 只写 `{servers, loaded}`（`:220-233`）→ 新增 `open` 字段需同时改 `readLazy/writeLazy`（保留未知字段，或新增 `readOpen/writeOpen` 避免破坏 lazy 探针）。**建议后者**：`readOpen(state)` / `writeOpen(state, next)` 各自独立，最小侵入。

**4.3.4 合并输入（精确）**

```ts
// src/domains/tool-surface.ts —— surfaceInputFor 的目标形态
return {
  install: state.toolDeny,                                  // 原样
  session: unionNames(lineage.map(id => state.sessions[id] ?? [])),   // 原样
  lazy: lazyDeny(readLazy(state), known ?? []),             // 原样（MCP）
  onDemand: onDemandDeny(groups, known ?? [], openFor(sessionId)),    // 新
  known,
}
```

其中 `openFor(sessionId)`：
- 有活 agent：`restoredOpenGroups(agent.session, DISCOVERY_NAMES)`（重放）——**取重放结果**（缓存只用于无 log 场景）；
- 无 agent：缓存。
- 归一化：组名比较统一 `toLowerCase()`（参考实现 `TM:src/policy.ts:152/155`）。

**4.3.5 提示词段（组目录）**

v1 建议：**agent 作用域的 `systemPrompt.section`**，注册在 `ToolMask.pluginFor` 的 scope 插件里（那里已经 `inject: ['tools','systemPrompt']`：`tool-mask.ts:230`，并已挂 `system-prompt/assemble` 瀑布 `:312-327`）：

```ts
scope.systemPrompt?.section?.({
  name: 'tools:on-demand',
  order: scope.systemPrompt.getSectionOrder('MCP_SERVERS') + 1,   // 3100 + 1（@dsh:dsh-system-prompt:165）
  text: () => catalogText(),          // 函数式 text 合法（:66）
  interpolate: false,                 // 组名/工具名里有 ` 也不被当变量
})
```

- `catalogText()` 形态（简洁，不列全部工具）：`- <组名> (<n> 个工具): <描述>；调用 tool_list({group:"<组名>"}) 打开`。参考文案：`TM:src/catalog.ts:54-87`（保留语义，压缩长度）。
- 为什么 agent 作用域：打开集合是 per-session（`sessions.ts:1-15` 的覆盖层同理），全局段无法表达。
- 与参考实现的差异：参考用 pre-step 合成 user 消息 + digest 去抖（只在变化时发），我们每轮重算段文本。**代价**：每轮多一段固定 token；**收益**：无消息记账、无 fork 消息重放问题。若 lead 选另一条，契约改成：`ctx.on('agent/pre-step', ...)` + `PreStepDecision {kind:'enter', messages}`（`@dsh:dsh-agent/src/runtime-types.ts:138-146`），以 digest（`TM:src/catalog.ts:47-52`）判重。

**4.3.6 发现工具 `tool_list`**

新文件 `src/host/group-tool.ts`（结构与 `catalog-tool.ts` 完全同构，便于探针）：

```ts
export function createGroupTool(execute): {
  name: 'tool_list'; description; parameters: { group: { type: 'string' } }; output; execute
}
```

- `execute({group}, exec)` → `sessionId = exec.agent.session.id`；无 session 报错（`SW:index.js:700-703` 同款）。
- → `execute('session.open', { sessionId, group })`；返回 `{name, description, tools, opened}`，`render` 输出 JSON 文本（参考实现：`TM:src/runtime.ts:639-644`）。
- **全局注册**，理由与风险：PTC 只投影 inherited 工具（`TM:src/runtime.ts:600-608`）；且 `restrict` 不能点名 `run_code`（`@dsh:dsh-tools/src/index.ts:176-178`），所以发现工具必须自己永不进 deny（§4.3.2 的 `RESERVED_TOOLS`）。

### 4.4 会话事件恢复（含 fork）

新文件 `src/domains/group-exposure.ts`（纯函数，IO-free，可单测）：

```ts
export interface SessionLogLike {
  readonly seq: number
  eventAt(seq: number): unknown
}
export interface OpenGroupsResult { open: Set<string>; events: number }

/** 重放：tool/call+tool/result 配对成功、tool/ptc-dispatch 单事件、（可选）command/run 的 /tools on。 */
export function restoredOpenGroups(
  log: SessionLogLike | undefined,
  discoveryNames: ReadonlySet<string>,   // {'tool_list'}
  commandNames?: ReadonlySet<string>,    // {'tools'}，可选
): OpenGroupsResult
```

算法（逐条对齐参考实现，`TM:src/exposure-history.ts:22-96`）：
1. `for (let seq = 0; seq < log.seq; seq++)`，`event = log.eventAt(seq)`。
2. `type === 'tool/call'` 且 `data.name ∈ discoveryNames`、`callId` 是字符串 → `pending.set(callId, group)`（`group` 从 `arguments` 解析，兼容对象与 JSON 字符串：`:99-112`）。
3. `type === 'tool/result'` → 取 `toolCallId`（或 `source.callId`、或 content 里的 `tool-result` 块）→ 配对成功后 `if (!isError) open.add(group)`（`:50-83`）。
4. `type === 'tool/ptc-dispatch'` 且 `data.name ∈ discoveryNames && data.isError !== true` → `open.add(group)`（`:89-97`）。
5. （可选）`command/run` 的 `rawInput` 里 `on <group>` → 记入（新增能力，宿主命令事件见 `@dsh:dsh-commands/src/index.ts:335-342`）。

**fork 语义**：从 `seq=0` 重放即包含继承前缀（`types.ts:117` 的 `isSeeded`、`:182`；参考注释 `TM:src/exposure-history.ts:4-13`）。副作用（必须写进文档与探针）：fork 点之后父会话新开的组不会出现在子日志里 → 保持关闭。

**降级**：`log` 缺失 / `eventAt` 抛错 → 返回 `{open: new Set(), events: 0}` 并让调用方用缓存；绝不因为恢复失败而让掩码装不上（参考实现的失败哲学一致：`TM:src/runtime.ts:666-669` 注释「失败路径返回原集合」）。

### 4.5 op 契约（G10）

| op | 载荷 | 写 | audit | 说明 |
|---|---|---|---|---|
| `group.onDemand` | `{ id: string, onDemand: boolean }` | ✔ | ✔ | 只改标记；`group.save` 仍支持该字段（`groups.ts:352`） |
| `group.tools` | `{ id: string, tools: string[] }` | ✔ | ✔ | 把工具名集合写进组（过 `known` 过滤 + `RESERVED_TOOLS` 剔除） |
| `session.open` | `{ sessionId: string, group: string }` | ✔ | ✔ | 校验组存在且 `onDemand`；写缓存；`applySurface`；返回 `{group, tools, opened:true}` |
| `session.close` | `{ sessionId: string, group: string }` | ✔ | ✔ | 反向（面板用；模型侧不需要） |
| `tool.catalog` | `{ sessionId?: string }` | ✘ | ✘ | `{groups:[{id,name,description,tools,onDemand,open}], open:[], lazy:[], reserved:[]}` |
| `tool.plan` / `tool.describe` | 不变 | ✘ | ✘ | 已含 `onDemand` 归属（`tool-surface.ts:669-697`） |

错误码沿用既有风格（`DomainFailure`，`tool-surface.ts:35-49`）：`unknown-group`、`not-on-demand`、`reserved-tool`、`bad-payload`。

### 4.6 与掩码的边界（必须写清的三件事）

1. **`restrict` 只能遮「继承层」的工具**。`restrictableNames` 不含 agent 自身作用域注册（`@dsh:dsh-tools/src/index.ts:219-225`，注释 `:191-196`）。所以按需组只对全局/插件注册的工具生效；agent 作用域工具在面板标 `fixed`（与参考实现 `locked` 同义：`SW:index.js:367/382`）。
2. **保留名**：`run_code`（宿主硬拒：`:176-178`）、发现工具自身、`tool_switch`。任一被列进组也必须剔除，否则 `restrict` 抛错 → 整层掩码装不上（我们的失败方向是「无掩码」，不是「过遮」）。
3. **PTC**：隐藏即从 `definitions()` 消失（`:305-317`）→ `tools:sdk` 段（`@dsh:dsh-tool-executor-ptc/src/index.ts:51-58`）不再渲染其 schema；模型侧省的是这段 token，而 `run_code` 声明恒在（`:47-49`）。原生模式省的是 schema 数组。

**R4 可选（不建议 v1）**：若要遮 agent 作用域注册，只能 patch `ToolsService.prototype.resolve` 过滤 step set（`TM:src/runtime.ts:656-671`、`:872-884`）。代价：私有方法、宿主升级即碎；收益：覆盖 scope-local 工具。先不做，留作后续条目。

### 4.7 文件清单与步骤（含风险）

**步骤 1（基础，先做）名字宇宙放开**
- 改 `tool-surface.ts`（`toolNames/maskable/RESERVED_TOOLS`、`mergeSurface`、`unionNames`、`requireDeny`）、`tool-mask.ts`（三处 `mcpOnly`）。
- 风险：`tool.save` 语义变宽 → 面板可能把非 MCP 名写进 install deny。缓解：`known` 交集 + 保留名拒绝 + 探针。
- 验收：`domain-workflows.mjs` 新断言（非 MCP 名保留、`run_code` 被剔）；`tool-mask.mjs` 新增 3 条。

**步骤 2 组成员与计算**
- 改 `groups.ts`（`MemberKind` 加 `tool`、`GroupRecord.tools`、`onDemandToolNames`、`onDemandDeny`）；`state.ts` 的 `recordList` 已能透传未知字段（`:170-171`），无需迁移。
- 风险：`normalizeGroups` 的生成组合并逻辑（`groups.ts:240-263`）要保留 `tools`；漏了会在重载后丢工具。
- 验收：`domain-groups.mjs`（38 条）+ 新 6 条。

**步骤 3 打开状态 + 掩码接线**
- 新 `group-exposure.ts`（重放）；`tool-surface.ts` 加 `readOpen/writeOpen` + `surfaceInputFor` 接 `onDemandDeny`；`host/index.ts` 在 `installMask` 的 recompute 里传 sessionId（或让 `applySurface` 每次按 agent 重算）。
  - 注意：现 `applySurface` 的签名只带 `sessionId?`（`tool-surface.ts:458-460`），install 级 recompute 走的是 `undefined`（`host/index.ts:122-124`）。按需组是**每 agent** 的，安装层 recompute 无法表达 → 应在 `ToolMask` 的 `syncOnce()`（`tool-mask.ts:236-296`）里把 `onDemand` 并入该 agent 的 deny（它已经按 agent 计算 `denyFor`）。这是本设计的关键落点。
- 风险：两套 deny（安装层 + agent 层）重复/竞争 → 约定：`applySurface` 只管 install/session/lazy；`onDemand` 只在 agent 侧合并（`denyFor(agent) ∪ onDemandDeny(...)`）。

**步骤 4 发现工具 + op**
- 新 `group-tool.ts`；`sessions.ts` 或新 `groups` 侧加 `session.open/close`、`tool.catalog`；`host/index.ts` 注册（与 catalog 并列）。
- 风险：工具名 `tool_list` 可能与别的插件冲突（`tools.register` 同层重复会抛）→ try/catch + doctor 记录（`diagnostics.ts:98-105` 同款）。

**步骤 5 提示词段**
- `tool-mask.ts` 的 scope 插件里注册 `tools:on-demand`；`diagnostics.ts` 把 `systemPrompt.section` 的 `usedFor` 改成「懒加载 + 按需组目录」（现文只提懒加载：`:106-114`）。
- 风险：段文本每轮重算 → 若组多会顶 token；限制只列 `onDemand` 组且每行 ≤ 80 字。
- 风险：`systemPrompt` 缺失时注册抛错 → try/catch（照 `tool-mask.ts:311-330` 的既有做法）。

**步骤 6 面板/客户端**
- `views/groups.tsx` 加「按需」开关与工具成员选择；`views/tools.tsx` 显示 `onDemand` 归属（`tool.plan` 已返回 `attributed.onDemand`：`tool-surface.ts:669-682`）。
- 风险：`client-groups.mjs`/`client-tools.mjs` 已有断言，只增不改。

**步骤 7 恢复接线**
- `ToolMask` 的 `AgentLike` 加 `session?: { id?, seq?, eventAt? }`（现在只有 `id/requestHeader/header`：`tool-mask.ts:30-35`）；mount 时重放并缓存到该 agent 的掩码计算里。
- 风险：`eventAt` 在大日志上是 O(seq) → 只在该 agent 首次 mount 与 `tools/change` 时跑；缓存 key = (sessionId, seq) 水位。

**步骤 8 文档/诊断**
- `diagnostics.ts` 加能力：`commands.register`、`systemPrompt.section`（已有）、`tools.register`（已有）；`README`/`VERSIONS` 记账。

### 4.8 探针用例（G10，逐条）

新 `probe/next/group-on-demand.mjs`（目标 ≥ 26 条）：
1. `onDemandDeny`：关组 → 含成员；开组 → 不含；大小写不同的组名视为已开。
2. 保留名：`run_code`/`tool_switch`/`tool_list` 即使写进组也不进 deny。
3. 无组 / 空组 → `[]`；无 `known` → 不 panic。
4. 重放：成功 call/result → 开；error result → 不开；call 无 result → 不开（pending 未结算）。
5. 重放：`tool/ptc-dispatch` 成功 → 开；`isError:true` → 不开。
6. 重放：`arguments` 为 JSON 字符串也能解析；非 JSON → 忽略。
7. fork：把「父日志前缀 + 子事件」喂入，前缀里的开组被恢复；父在 fork 后新开的组不出现。
8. 降级：`eventAt` 抛错 → 空集 + 不抛。
9. 缓存：无 log 时用 `readOpen`；有 log 时 log 胜出。
10. `session.open`：未知组 → `unknown-group`；非 on-demand 组 → `not-on-demand`；成功返回工具名。

扩 `probe/next/tool-catalog.mjs`（现 17 条）：`tool_list` 的 list/open/unknown/无 agent 四条；确认 `hub_tools` 原 17 条不变。

扩 `probe/next/tool-mask.mjs`（现 21 条）：`addLayer` 收非 MCP、剔保留名；`setSessionDeny` 同样；`hydrate` 非 MCP。

扩 `probe/next/domain-workflows.mjs`（现 86 条）：`mergeSurface` 保留非 MCP（把 fixture `:292` 的 `onDemand` 加一个 `pwsh`）；`unreachable` 对非 MCP 生效。

扩 `probe/next/domain-groups.mjs`（现 38 条）：`MemberKind:'tool'` 归一化、`group.tools` 过 `known` 过滤、生成组合并保 `tools`。

---

## 5 未决问题（需 lead 定，影响契约细节）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| Q1 | 按需组的工具成员从哪来 | (a) 显式 `tool` 成员 + `GroupRecord.tools`；(b) 反推插件归属（需 fiber 反射/私有 patch） | **(a)**：宿主无归属字段（`contracts.ts:27-40`），(b) 成本与稳定性都差 |
| Q2 | 组目录放哪 | (a) agent 作用域 `systemPrompt.section`；(b) `agent/pre-step` 合成 user 消息 + digest（参考实现） | **(a) v1**：无消息记账、无 fork 重放问题；若 token 敏感再切 (b) |
| Q3 | dock 徽标数据 | (a) 新增 `session.summary` 轻读；(b) 复用整份 `snapshot` | **(a)**：`snapshot` 要跑 plugins/skills/MCP 全量（`snapshot.ts:90-107`），挂载时太重 |
| Q4 | `/tools` 语义 | (a) 整表替换（复用 `session.set`）；(b) 动作语义 `session.switch` | **(b)**：动作语义才支持「按组/前缀/all」，且与 `tool_switch` 同源 |

---

## 6 证据索引（宿主侧，便于复核）

| 主题 | 文件 | 行 |
|---|---|---|
| composer.dock 声明 | `@dsh:dsh-client-ui-conversation/src/client/contract/slots.ts` | 305、315、336、374 |
| dock 渲染 | `.../src/client/skeleton/InputBar.tsx` | 596-599 |
| dock 注册范例 | `@dsh:dsh-client-ui-chat/src/client/apply.ts` | 341-350 |
| commands 服务 | `@dsh:dsh-commands/src/index.ts` | 32、41-58、61-78、102-104、263、285-292、335-342 |
| CommandResult | `@dsh:dsh-commands/src/types.ts` | 34-41 |
| tools.register / restrict / view | `@dsh:dsh-tools/src/index.ts` | 128-153、162-189、191-227、305-317 |
| ToolDefinition 无归属 | `@dsh:dsh-tools/src/contracts.ts` | 27-40、186-190 |
| PromptSection / section | `@dsh:dsh-system-prompt/src/index.ts` | 53-68、165、485-494、501-503、552-558 |
| PTC 呈现 | `@dsh:dsh-tool-executor-ptc/src/index.ts` | 35-38、47-58 |
| agent/pre-step | `@dsh:dsh-agent/src/runtime-types.ts` | 138-146、191-195、339-351 |
| 会话日志 | `@dsh:dsh-session/src/types.ts` / `index.ts` | 112、117、182、557 / 745 |
| reference：tool-switch | `SW:index.js` | 37-38、131-135、182-183、198-211、226-254、267-303、516-565、588-659、663-717 |
| reference：tool-switch client | `SW:lib/client.js` | 635-640、655-707、740-749 |
| reference：tool-manager 策略 | `TM:src/policy.ts` | 69、145-166、211-219 |
| reference：tool-manager 日志恢复 | `TM:src/exposure-history.ts` | 4-38、50-97、99-112 |
| reference：tool-manager 目录/步骤 | `TM:src/catalog.ts` / `TM:src/runtime.ts` | 47-52、54-109、176-181 / 433-455、457-482、600-608、656-671、872-884 |

---

## 7 附：本轮调研的方法与可复现命令

- 宿主源码随安装分发（`@dsh` 下每个包都带 `src/`），因此宿主行为可以 `path:line` 引用，不靠猜。
- 参考实现克隆：`C:\Users\fenri\AppData\Local\Temp\tool-hub-refs\`（`dsh-tool-switch`、`dsh-tool-manager`、`dsh-skill-mcp-panel`、`dsh-plugin-tool-management`）。
- 复核一条断言的最短路径：`grep -n "<符号>" <文件> | head`，再用 read 取 ±20 行；本文所有行号均按此读过。
