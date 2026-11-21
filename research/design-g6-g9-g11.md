# G6 / G9 / G11 设计：工具作用域四层、场景覆盖整环境、preset 级工具策略

**对象**：dsh-tool-hub **2.0.0-alpha.41**（`package.json`）
**日期**：2026-11-21
**性质**：只读设计文档。**未改 `src/`**，本文件是唯一写入（`research/`）。
**参考实现**（本机克隆，`%TEMP%/tool-hub-refs`）：
dsh-skill-mcp-panel **2.3.16** @ `8797c33` · dsh-plugin-tool-management **0.22.8** @ `88f38da` · dsh-tool-manager **1.3.0** @ `3f86ef0`
**宿主核对**：`D:\Software\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh-session\src\types.ts`
**读法**：§2/§3/§4 的「契约」小节是**规范**（字段名、公式、op id、载荷、helper 签名都以那里为准）；§5 是实现顺序，可按并发情况调整，但**不要调换同一阶段内的依赖**。
**行号**：采样时工作树是脏的（队友并行落补丁），行号可能前移；**函数名与文件名是稳定锚点**。

---

## 0 一页结论

1. **G6 的缺口是三层，不是一层**：参考实现的作用域是「全局 ∪ 工作区 ∪ 会话(deny+allow) − 会话 allow，再叠子代理 allow/deny」（`tool-filter.ts:13-15`）；我们只有「安装层 ∪ 会话 deny」，**没有工作区层、没有 allow、没有子代理层**（`tool-mask.ts:194-200`、`sessions.ts:55-62`）。
2. **宿主已经把 G6 需要的判据全给了**：`SessionHeader` 带 `cwd`、`parentSession`、`origin:'subagent'`、`delegationDepth`、`agentPreset`（`types.ts:106/112/122/128/135`）。**判子代理要看 `origin`/`delegationDepth`，不能看 `parentSession` 是否存在** —— 普通 fork 也可能留着 parentSession（`types.ts:107-112` 的注释就是这么写的）。
3. **状态字段只能「加键」，不能「改形状」**：把 `sessions: Record<string,string[]>` 改成对象会让旧版在 `unionNames` 的 `for…of` 上直接抛（`tool-surface.ts:91-102`），回滚即炸。方案是 `sessions` 保持数组（deny），新增 `sessionAllow` / `workspaces` / `subagentAllow` / `subagentDeny` 四个键（§2.3），旧版靠 `unknownKeys` 原样带过（`state.ts:148-156`）。
4. **应用面与报告面必须分工**：真正的四层求值只能发生在**每个 agent 的遮罩**里（`restrict()` 是按 agent 挂的，`tool-mask.ts:225-354`）；`applySurface` 只装一条全局层（`tool-surface.ts:469-530`）。报告（`tool.plan`/`tool.describe`）保留合并视图，但**逐 agent 的真相只能从遮罩里读**（新增 `scope.list`）。两条渠道各算一遍公式是这类功能最常见的分叉点，必须禁止。
5. **G9 的场景要扩成「安装级整套环境」**：现有 Scene 只有 `tools` + `mcp` 两段（`scene-engine.d.ts:19-25`），要加 `plugins` / `skills` / `preset`（绑定）/ `locked`；**会话覆盖不属于场景**（它是 G6 的更细一层），`snapshot.sessions` 今天只被记录、从不还原（`lib/scene-engine.js:64-78` vs `:103-109`），文档里必须把这条写成显式决定而不是隐藏 bug。
6. **G9 的锁是一条跨入口的判据**：参考实现是「任一场景 locked → 五个管理域整体冻结」，**HTTP 与模型侧共用同一个 `createFrozenGate`**，且**不装在场景引擎自己走的 op 表上**（`request-gate.ts:202-246`、`:248-306`、`:308-330`）。我们只有一个入口 `Dispatcher.execute`（`dispatch.ts:259-268`），在那里装一次即可覆盖 HTTP / 模型工具 / CLI（`catalog-tool.ts:47`、`routes.ts:232`）。
7. **G11 的模型是「每个 preset 一份策略」**：`{disabled, groups:[{name,description,patterns}]}`（`types.ts:17-26`），归一化去重、组员不重叠（`policy.ts:30-51`、`:84-98`），保存走 revision CAS（`config.ts:40-55`），**草稿只在界面、保存才落盘**，复制是「投影到目标 preset 的工具集、空组跳过」（`client.js:97-135`），重置只清策略。映射到我们就是给 `PresetRecord` 加 `toolPolicy`，新增三个 op（`preset.policy` / `preset.copy` / `preset.policyReset`），草稿语义直接复用 settings 页已经验证过的那套纯函数（`settings/model.ts:134-174`）。
8. **顺序**：G6 先行（它定义「安装层」是什么），G9 的锁挂在 `execute` 上、与 G6 无代码依赖可并行，G11 的 `groups` 运行时要等 G10（按需组泛化 + 曝光存储）；**G11 的 `disabled` 不依赖 G10，可以先发**（§4.8）。

---

## 1 方法与边界

- 参考侧一律给 `<包>/<路径>:<行>`，宿主给 `@deepseek-ai/dsh-session/src/types.ts:<行>`，本仓库给 `src/…:<行>`。
- 「我们缺」的判据不是「没看见」，而是给出我们的对应锚点或 grep 出来的无实现证据；写在本仓库表格的「现状」列。
- 本文件**不评价**要不要做，只回答**做成什么样**；优先级不在本文（见 `research/reference-gaps.md` §5）。
- 三块功能的共同前提：`restrict()` 只认**可限制**的工具名（`tool-mask.ts:258-260` 用 `restrictableNames` 过滤），且我们全链路只处理 `mcp__*`（`tool-surface.ts:79-102`、`tool-mask.ts:50-52`）。所以三层作用域**先只在 MCP 名字空间生效**；把内置工具（`bash`、`read` …）纳入遮罩是另一件事，不在本文范围（§2.9）。

---

## 2 G6：四层工具作用域

### 2.1 参考实现的事实

| 事实 | 证据 |
|---|---|
| 生效公式：`((global ∪ workspace ∪ sessionDeny) \ sessionAllow)`，子代理再 `(effective \ subagentAllow) ∪ subagentDeny` | `tool-filter.ts:13-15` |
| 策略形状：`{version, deny, workspaces: Record<path,string[]>, roles:{subagentAllow, subagentDeny}}` | `tool-filter.ts:32-37` |
| 会话覆盖形状：`{deny: string[], allow: string[]}`，**纯内存**，会话结束清理 | `tool-filter.ts:9`、`:39-42`、`:438-445` |
| 名字归一化：trim、去空、去重、排序 | `tool-filter.ts:44-56` |
| 工作区键归一化：`\`→`/`、去尾斜杠、盘符单写时补 `/`；**查找时盘符小写** | `tool-filter.ts:58-69` |
| 工作区匹配是**精确相等**（不做前缀/祖先） | `tool-filter.ts:213-220` |
| 子代理判据：`session.header.origin === 'subagent'` 或 `delegationDepth > 0`（也容忍 `agent.origin`） | `tool-filter.ts:180-186` |
| 工作区来源：`header.cwd ?? agent.cwd ?? agent.workspace` | `tool-filter.ts:189-192` |
| 会话覆盖查找：本会话优先，**回落到父会话**（只一层） | `tool-filter.ts:222-230` |
| 叠加顺序：先加会话 deny，再删会话 allow；子代理层**先删 allow 再加 deny**（deny 赢） | `tool-filter.ts:227-235` |
| 只对 `restrictableNames` 里的名字施加，且按排序签名去重 | `tool-filter.ts:326-333` |
| 每个 agent 一份插件、原位 `setDeny` 更新（不反复挂/卸）；`agent/created`/`agent/disposed`/`tools/change` 三个事件 | `tool-filter.ts:296-374`、`:394-429`、`:518-543` |
| RPC：`getToolFilter` 回四层；`setToolFilter({scopeKind, scopeKey, deny, allow, workspaces, roles})` 分四个分支（session/workspace/subagent/global） | `gateway.ts:435-445`、`:447-522` |
| 面板自己也只处理 `mcp__*`（`filterMcpNames`） | `gateway.ts:134-136` |

### 2.2 本仓库现状

| 能力 | 现状 | 位置 |
|---|---|---|
| 安装层 | `state.toolDeny` → `applySurface` 装一条层 | `tool-surface.ts:416-430`、`:469-530` |
| 会话层 | 只有 deny，沿 lineage 并集（深度 8、防环） | `sessions.ts:42-62` |
| 遮罩求值 | `denyFor(agent) = 安装层 ∪ 该 agent 血缘上的会话 deny` | `tool-mask.ts:194-200` |
| 会话覆盖写入口 | `session.set`（整份替换，空即删）、`session.clear`、`session.lineage` | `sessions.ts:101-136` |
| 遮罩控制面 | `toolHub.mask` = `{setSessionDeny, info}` | `tool-mask.ts:525-530`、`host/index.ts:120-121` |
| 工作区层 | **无** | `grep -rn "workspace" src/domains src/host` 只命中 `skills` 的根目录概念 |
| allow | **无** | `session.set` 只读 `names`（`sessions.ts:106`） |
| 子代理层 | **无**（子代理只按血缘继承父会话 deny） | `tool-mask.ts:165-200` |
| 提示词段落剔除 | **已有**（`mcp:<server>`、`mcp-resource-servers`、声明表） | `tool-mask.ts:483-511` |
| 报告 | `tool.plan`/`tool.describe` 走 `mergeSurface` 四源；`session` 源只在带 `sessionId` 时有值 | `tool-surface.ts:669-697` |

**关键结构判断（决定实现位置）：**

1. `applySurface` 的 `session` 源**从不参与实际安装**：所有调用点都不传 `sessionId`（`sessions.ts:95` 显式注释「不能折进全局 deny」）。真正的会话层在遮罩里按 agent 求值。所以**四层的求值位置就是 `ToolMask.denyFor`**，不是 `applySurface`。
2. `sessions.ts:96` 拿到的是 `state.sessions[sessionId]` 再调 `setSessionDeny`；`hydrate` 在启动时塞同一份（`tool-mask.ts:211-218`）。加 allow 时这两条路径必须一起改，否则重启前后语义不同。
3. 遮罩已经能读 `agent.session.header`（`tool-mask.ts:165-179` 从 `requestHeader() ?? header` 读 `parentSession`），**同一个 header 里就有 cwd/origin/delegationDepth**，不需要新宿主 seam（旧结论「无 origin/cwd」在这里被更正：宿主 `types.ts:106/122/128` 明确有）。
4. `tool.plan` 没有 agent 上下文，天然算不出工作区/子代理层。报告要诚实：全局源照旧合并，工作区按 key 列出，**逐 agent 的答案走新 op `scope.list`**（§2.6）。

### 2.3 状态字段契约（`src/core/state.ts`）

在 `StateV2` 上**加四个键，不动 `sessions` 的形状**：

```ts
export interface StateV2 {
  // …既有字段不变…
  /** 既有：每个会话的屏蔽名单。形状必须保持 string[]（旧版按数组迭代）。 */
  sessions: Record<string, string[]>
  /** 新增：每个会话的放行名单；命中者从安装/工作区/会话 deny 中减掉。 */
  sessionAllow: Record<string, string[]>
  /** 新增：工作区覆盖，键 = 归一化后的绝对路径（见 normalizeWorkspaceKey）。 */
  workspaces: Record<string, string[]>
  /** 新增：子代理例外，仅对宿主标记为 subagent 的会话生效。 */
  subagentAllow: string[]
  subagentDeny: string[]
}
```

- `emptyState()`（`state.ts:51-66`）补 `sessionAllow: {}`、`workspaces: {}`、`subagentAllow: []`、`subagentDeny: []`。
- `KNOWN_KEYS`（`state.ts:71-86`）加这四个键，否则它们会被当成「未知键」——虽然能带过，但 `migrate` 不会再做类型归一。
- `migrate`（`state.ts:166-207`）新增四路归一，复用现成校验器：
  - `sessionAllow` 用 `sessionMap`（`:118-128`，已有空键/长度/数组校验）；
  - `workspaces` 用「新的 `workspaceMap`」：键必须过 `normalizeWorkspaceKey` 且非空，值走 `stringList`；空列表的键**保留**（合法：显式清空某个工作区覆盖），但 `normalizeWorkspaceKey` 拒绝空串；
  - `subagentAllow`/`subagentDeny` 用 `stringList`（`:105-109`）。
- **为什么不做嵌套**（`sessions: {deny, allow}`）：旧版 `overlayFor` → `unionNames` 直接 `for…of` 对象会抛 `TypeError`（`tool-surface.ts:91-102`），`setSessionDeny` 里的 `mcpOnly` 也会 `.filter` 失败（`tool-mask.ts:50-52`、`:204`）。加键方案下旧版把新键当未知键原样保留（`state.ts:148-156`），回滚只丢功能、不丢数据、不崩。
- 上限：会话 id ≤200（沿用 `MAX_SESSION_ID`，`sessions.ts:31`）；工作区键 ≤260 字符、列表 ≤500 名（防手改文件炸内存），超限**截断并记一条 warn**，不抛。

### 2.4 合并公式（唯一权威）

```text
lineage(a)  = [a.session.id, parent, …]   深度 ≤8、防环          (tool-mask.ts:181-191)
D_install   = ⋃ mask.layers                                          (tool-mask.ts:118-122)
W(a)        = state.workspaces[lookup(cwd(a))] ?? []                 (新增)
D_session   = ⋃_{s∈lineage(a)} state.sessions[s]                     (不变)
A_session   = ⋃_{s∈lineage(a)} state.sessionAllow[s]                 (新增)
D_allowed   = state.subagentAllow                                    (新增，仅子代理)
D_subdeny   = state.subagentDeny                                     (新增，仅子代理)

deny(a) = (D_install ∪ W(a) ∪ D_session) \ A_session
若 isSubagent(a):
    deny(a) = (deny(a) \ D_allowed) ∪ D_subdeny
再过滤：usable = deny(a) ∩ restrictableNames(a)
签名未变 → 不重装；ustable 为空 → 撤销本 agent 的限制
```

**判据与顺序（每条都能被探针钉死）：**

| # | 规则 | 理由 / 证据 |
|---|---|---|
| R1 | 会话 allow **能放行安装层与工作区层的名字**（减号在最后） | 参考公式 `(global ∪ workspace ∪ sessionDeny) \ sessionAllow`（`tool-filter.ts:13-15`）；这是「临时放行一个全局关掉的工具」的唯一实现方式 |
| R2 | 子代理层里 **deny 赢**：先减 `subagentAllow` 再加 `subagentDeny` | `tool-filter.ts:232-235` 的顺序就是判据；反向顺序会让「全体子代理禁用」被一条 allow 悄悄击穿 |
| R3 | 子代理判据 = `header.origin === 'subagent' || delegationDepth > 0`；**不看 parentSession** | 宿主 `types.ts:107-112` 明说 parentSession 存在不代表子代理（普通 fork 也留） |
| R4 | 工作区匹配**精确相等**（归一化后），不做前缀 | 参考实现如此（`tool-filter.ts:213-220`）；前缀匹配需要按路径边界比较，否则 `C:/work` 会吞掉 `C:/workspace`，收益不抵风险 |
| R5 | 工作区键：存储保留盘符大小写，查找时盘符小写 | `tool-filter.ts:58-69`；Windows 上 `C:` 与 `c:` 是同一处 |
| R6 | 血缘并集对 allow 同样适用（父会话的放行会影响子会话） | 与我们现有 deny 的继承语义一致（`sessions.ts:5-7`、`:55-57`）；参考侧只回落到直接父会话，我们沿整条链更强 |
| R7 | 没拿到 `cwd` → 工作区层不生效（不是报错） | `cwd` 在 header 是可选的（`types.ts:106`）；`scope.list` 要把「本会话无 cwd」标出来 |
| R8 | 每个 agent 重新算一遍；两个 agent 同会话不同工作区会得到不同结果 | 遮罩本来就按 agent 挂（`tool-mask.ts:356-384`）；这正是四层比「全局一条 deny」强的地方 |

**五个worked example（写进探针）**：

| 场景 | 输入 | 期望 |
|---|---|---|
| E1 放行全局 | install=[x]；session allow=[x] | x 可见 |
| E2 放行工作区 | workspaces[C:/p]=[y]；session deny=[z]；session allow=[y] | y 可见、z 隐藏 |
| E3 子代理否决 | session allow=[x]；subagentDeny=[x] | 普通会话 x 可见；子代理 x 隐藏 |
| E4 fork 不是子代理 | header.parentSession=s1、无 origin/delegationDepth | 子代理两层都不生效 |
| E5 不可限制名字 | allow/deny 里有 `mcp__gone__t` | 不施加、进 `unreachable` 报告，不报错 |

### 2.5 导出 helper（签名即契约）

**新文件 `src/host/scope-policy.ts`**（纯函数、零依赖，便于探针直接 import dist）：

```ts
export interface AgentScope {
  sessionId?: string
  parentSessionId?: string
  cwd?: string
  subagent: boolean
}
/** header/agent 双形状都接受；判不出来就 {subagent:false}。 */
export function agentScopeOf(agent: unknown): AgentScope
export function normalizeWorkspaceKey(raw: unknown): string      // 存储形态
export function workspaceLookupKey(raw: unknown): string         // 比较形态（盘符小写）
export interface ScopeInput {
  install: readonly string[]
  workspaces: Readonly<Record<string, readonly string[]>>
  sessionDeny: Readonly<Record<string, readonly string[]>>
  sessionAllow: Readonly<Record<string, readonly string[]>>
  subagentAllow: readonly string[]
  subagentDeny: readonly string[]
  lineage: readonly string[]
  scope: AgentScope
}
export interface ScopeResolution {
  deny: string[]
  layers: { install: string[]; workspace: string[]; sessionDeny: string[]; sessionAllow: string[]; subagentAllow: string[]; subagentDeny: string[] }
  workspaceKey: string | null
  subagent: boolean
}
/** 公式的唯一实现；遮罩与 scope.list 都只准调它。 */
export function resolveScopedDeny(input: ScopeInput): ScopeResolution
```

**`src/host/tool-mask.ts` 的改动（不新增文件，避免再拆一个类）：**

```ts
export class ToolMask {
  // 既有 layers / sessionDeny / mounted …
  private readonly sessionAllow = new Map<string, string[]>()
  private workspaceDeny: Record<string, string[]> = {}
  private subagentAllow: string[] = []
  private subagentDeny: string[] = []

  hydrateScope(scope: {
    sessions?: unknown; sessionAllow?: unknown; workspaces?: unknown
    subagentAllow?: unknown; subagentDeny?: unknown
  }): void                       // 启动时一次性灌入，替代现在只灌 sessions 的 hydrate
  setSessionAllow(sessionId: string, names: readonly string[]): void
  setWorkspaceDeny(key: string, names: readonly string[]): void
  setSubagentRoles(roles: { allow: readonly string[]; deny: readonly string[] }): void
  denyFor(agent: AgentLike | undefined): string[]              // 改为调 resolveScopedDeny
  scopeOfAgent(agentId: string): AgentScopeInfo | undefined    // 新增：报告用
  agentsInfo(): AgentScopeInfo[]                               // 新增：报告用
}

export interface AgentScopeInfo {
  agentId: string
  sessionId?: string
  cwd?: string
  workspaceKey: string | null
  parentSessionId?: string
  subagent: boolean
  layers: ScopeResolution['layers']
  deny: string[]
}
```

- `Mounted`（`tool-mask.ts:96-99`）加 `agent: AgentLike`：`info()`/`agentsInfo()` 要把 cwd/origin 报出去，必须留下 agent 引用（现在只存 fiber+holder，`:374-375`）。
- `forget(id)`（`:428-430`）同时清 `mounted` 里的引用；`dispose` 不变。
- `maskControl(mask)`（`:525-530`）扩成：

```ts
export interface MaskScopePort {
  setSessionDeny(sessionId: string, names: string[]): void
  setSessionAllow(sessionId: string, names: string[]): void
  setWorkspaceDeny(key: string, names: string[]): void
  setSubagentRoles(roles: { allow: string[]; deny: string[] }): void
  agentsInfo(): AgentScopeInfo[]
  scopeOf(agentId: string): AgentScopeInfo | undefined
  info(): unknown
}
export function maskControl(mask: ToolMask): MaskScopePort
```

- **`hydrate` 的兼容**：`attachToolMask(ctx, sessions)`（`:439-473`）第二参现在传的是 `state.sessions`；改成传整个 `state`（或 `hydrateScope` 的入参对象），由 `hydrateScope` 自己挑键。调用点在 `host/index.ts` 附近（`sessions` 由 `state.sessions` 传入），一改一处。

**`src/domains/tool-surface.ts`（报告面）**：

```ts
export type SurfaceSource = 'install' | 'workspace' | 'session' | 'lazy' | 'onDemand' | 'subagent'
export const SURFACE_SOURCES: readonly SurfaceSource[]   // 顺序即归属优先：install→workspace→session→lazy→onDemand→subagent

export interface SurfaceInput extends Partial<Record<SurfaceSource, readonly string[]>> {
  sessionAllow?: readonly string[]
  subagentAllow?: readonly string[]
  subagentDeny?: readonly string[]
  known?: readonly string[] | null
}
export interface MergedSurface {
  deny: string[]
  attributed: Record<SurfaceSource, string[]>
  counts: Record<SurfaceSource, number>
  /** 新增：被 allow 减掉的名字与减它的那一层。 */
  exempted: Array<{ name: string; by: 'sessionAllow' | 'subagentAllow' }>
  unreachable: string[]
  known: boolean
  signature: string
}
export function mergeSurface(input: SurfaceInput): MergedSurface   // 无 allow 入参时输出与今天逐字节一致
```

- `surfaceInputFor(ctx, sessionId, port, extra?)` 的 `extra` 带上 `workspaceKey`/`subagent`/`allow` 列表（供 `tool.plan` 显式询问时使用）；**不传则与今天一致**。
- `tool.plan` 载荷扩为 `{sessionId?, workspaceKey?, subagent?}`：不给 `workspaceKey` 时 `workspace` 源不计入 `deny`，另给 `workspaces: Array<{key, count}>`；给了才合并。理由见 §2.2 判断 4。

### 2.6 op 契约

| op | 写 | 审计 | 载荷 | 回执 |
|---|---|---|---|---|
| `session.set`（扩） | ✓ | ✓ | `{sessionId, names?: string[], allow?: string[]}` | `{sessionId, deny, allow, sessions, sessionAllow, mask}` |
| `session.clear` | ✓ | ✓ | `{sessionId}` | 同上（两个键都清） |
| `session.lineage`（扩） | – | – | `{sessionId?}` | `{sessionId, lineage, deny, allow, sessions, sessionAllow}` |
| `scope.list`（新） | – | – | `{sessionId?, agentId?}` | `{workspaces, subagent:{allow,deny}, sessions:{deny,allow}, agents: AgentScopeInfo[]}` |
| `scope.workspace`（新） | ✓ | ✓ | `{key, deny: string[]}` | `{key, deny, workspaces, mask}` |
| `scope.roles`（新） | ✓ | ✓ | `{allow?: string[], deny?: string[]}`（缺省=保留） | `{subagent:{allow,deny}, mask}` |

**行为细则：**

- `session.set` 的 `names` 保持旧语义（deny，整份替换）；`allow` 缺省=清空放行。两者都空且键原来存在 → 删除两个条目（与今天 `deny.length === 0` 即删一致，`sessions.ts:107-108`）。
- 每个 op 都先写 state 再 `env.save('session-set' | …)`（沿用现有 reason 风格），然后**两件事都要做**：`applySurface`（安装层可能没变，但保持单一路径）+ 对应 `mask.set*` 调用（真正生效的是遮罩）。顺序：先 state→save→遮罩→applySurface，与今天 `maskAfter` 的「save 后再施加」一致（`sessions.ts:109-110`）。
- 名字过滤：所有入参走 `mcpNames()`（`tool-surface.ts:79-88`）→ 非 `mcp__` 前缀**静默丢弃**（现状如此），但回执里给 `dropped: number`，别让用户以为写进去了。
- `scope.workspace` 的 `key` 必须过 `normalizeWorkspaceKey`；空串 → `fail('bad-payload')`；`deny` 为空 → 删除该键（回执里 `workspaces` 不再含它）。
- `scope.roles` 两个列表各自 `mcpNames` + 去重；**同名字同时出现在 allow 与 deny 时保留两处并回报 `conflicts: string[]`**（生效按 R2：deny 赢），不静默删。
- 审计：`session.set` 的 `allow` 是「提权式」操作（能把全局关掉的工具放回来）。`historyDetail` 只记 `id/name/kind/targetId/mode/state` 六个短字段（`dispatch.ts:83-93`），**不会记 allow 列表**；因此 `session.set` 的 handler 在 `env.log('warn', …)` 里额外打一行「session <id> allow=N deny=M」，让终端日志留痕（历史文件不扩字段，避免破坏 CLI/客户端读取）。
- 旧客户端兼容：`session.set` 只传 `names` 时行为与今天完全一致（allow 被清空——注意：这会把用户之前设的放行清掉，**这是有意的**：整份替换语义）；若想保留，客户端必须回传 `allow`。UI 一定回传（§2.7）。

### 2.7 UI 控件

**Sessions 页（`src/client/views/sessions.tsx`）**：

1. 行内徽章拆成三段：`屏蔽 N` / `放行 M`（M=0 不显示）/ `生效 K`（来自 `scope.list` 的该 agent 解析；无 agent 时用血缘并集估算并标「估算」）。
2. 编辑弹窗（现在只有一组「屏蔽的 MCP 工具」开关，`:302-326`）拆成两个 section：
   - 「本会话屏蔽」：开关 = 在 `deny` 里；
   - 「本会话放行」：开关 = 在 `allow` 里；同屏提示「放行会盖过全局与工作区屏蔽，子代理禁用除外」；
   - 同一个名字不能同时开两个开关：打开一个自动关另一个，并在行尾标 `deny 赢` 的说明（子代理场景）。
3. 顶部加「作用域」区块（与现有血缘追溯并列）：
   - 工作区表：key（等宽）+ 屏蔽数 + 编辑/删除；新增时输入路径，失焦即归一化预览（`C:\Work\p` → `C:/Work/p`）；
   - 子代理两张多选清单（允许 / 额外禁用），带冲突提示。
4. `session.lineage` 的结果面板（`:398-413`）加一行「放行」徽章。

**Tools 页**：不用改结构；`tool.describe` 的 `description` 会多出 `workspace N` 与 `subagent N`（`describeSurface`，`tool-surface.ts:174-178`）。**不要**把逐 agent 结果塞进 tools 页——它没有会话上下文。

**i18n**：新增键写进 `src/client/i18n.ts` 的内联字典（如 `diagnostics.maskMissing` 那样，`:237`）**以及** `locale/zh.json`/`locale/en.json`（两处都要，探针会查 key 齐全）。

### 2.8 探针

`probe/next/tool-mask.mjs`（fake host 已有 `addAgent({session,parent})`，`:72-103`；**扩它**，别新建第二套 fake host）：

| # | 用例 | 断言 |
|---|---|---|
| P1 | 工作区精确匹配 | `setWorkspaceDeny('C:/p', [x])`，agent cwd=`c:\p` → deny 含 x（盘符大小写不敏感）；cwd=`C:/p/sub` → 不含 |
| P2 | 会话 allow 减安装层 | install=[x] + `setSessionAllow(s1,[x])` → restrict 不收到 x（或收到空层） |
| P3 | 会话 allow 减工作区层 | 同 E2 |
| P4 | 子代理 deny 赢 | 同 E3 |
| P5 | fork 不算子代理 | header 只给 `parentSession`（fake host 的 `parent` 形状）→ `subagent:false`；给 `origin:'subagent'` → true |
| P6 | delegationDepth 判据 | `delegationDepth:1` → true |
| P7 | 两 agent 隔离 | 同会话不同 cwd 的两个 agent，restrict 收到的名单不同 |
| P8 | 空作用域撤销 | 清空四层后 `info().deny === []` 且 host undo 被调 |
| P9 | 追加而非重建 | 重复 `setWorkspaceDeny` 同值 → restrict 调用次数不增（签名去重） |
| P10 | `agentsInfo` 形状 | 每项含 `agentId/sessionId/workspaceKey/subagent/layers/deny`，且 `layers.install` 与 `addLayer` 一致 |

`probe/next/core-state.mjs`：legacy `sessions` 数组原样保留；`sessionAllow`/`workspaces`/`subagent*` 的坏值（对象、数字、空键、超长）被丢弃/截断；未知顶层键仍原样带过；`emptyState` 含四新键。

`probe/next/client-sessions.mjs`（静态门）：新增 op 在视图里被引用、载荷带 `sessionId`+`id`、放行开关有 a11y 名称、工作区输入做了归一化提示、i18n key 两个字典齐全、文件仍 < 450 行（现有硬门，`client-presets.mjs` 头注释第 10 条）。

`probe/next/domain-workflows.mjs`：`scope.workspace`/`scope.roles`/`scope.list` 的形状与写后回读；`session.set` 只传 `names` 时 allow 被清空。

### 2.9 边界与不做

- **不做**：把非 MCP 工具（`bash`/`read`/`run_code` …）纳入作用域。全链路 `mcpOnly`/`mcpNames` 过滤（`tool-mask.ts:50-52`、`tool-surface.ts:79-102`），放开会同时改遮罩、提示词段落剔除、成本视图与所有 probe 的期望；属于独立议题。
- **不做**：工作区前缀/祖先匹配（R4）。
- **不做**：把 `sessionOverrides` 做成纯内存（参考侧的选择，`tool-filter.ts:9`）。我们已经有持久 deny，两套存储规则会制造「重启后放行消失」的惊悚；统一持久 + `session.clear` 可清。
- **不做**：在工作区层加 allow。参考侧也没有（`tool-filter.ts:32-37` 的 `workspaces` 只有名单）；需要时用户在会话层放行即可。
- **必须做**：`scope.list` 的每条都带 `source`（哪一层造成），否则「为什么这个工具看不见」仍然只能靠猜。

---

## 3 G9：场景覆盖整环境 + 锁

### 3.1 参考实现的事实

| 事实 | 证据 |
|---|---|
| 场景 = 整套环境：MCP、技能、子智能体、记忆、快捷提示词、提示词预设、模型工具表；进入整套切换、退出按快照还原 | README:23-24、`:38` |
| 场景档案字段：`mcp`（server→'\*'\|名单）、`mcpNotes`、`skills`（选集）、`subagents`、`quickPrompts`、`memories`、`toolTablePreset`（绑定方案） | `memories/archive.ts:7-39` |
| 「段未定义 = 不动；段已定义（含空表）= 整套置定」——两种语义族要分清 | `archive.ts:17-25`（选集语义）、`:33-38`（绑定语义） |
| 三作用域（全局/工作区/会话）+ 层叠「本层改过 > 进入的场景 > 创建快照 > 全局」 | README:68-78；`scope/scope-overrides.ts:1-58` |
| 场景可锁定防误改；删除进回收站；可绑定提示词预设与工具表方案 | README:86 |
| 锁的判据：任一场景 `locked=true` → 五个管理域整体冻结；三种冻结口径 `all`/`active-scene`/`self-scene` | `request-gate.ts:202-246`、`:248-306` |
| HTTP 与模型侧**共用同一份**判据；**不装在场景引擎自己用的 op 表上**（否则场景启动会被自己挡） | `request-gate.ts:203-211`、`:308-330` |
| 模型侧拒绝文案只陈述事实、不指路 UI（读者是模型） | `request-gate.ts:231-244` |
| 提示词「应用」会覆盖宿主读的 `~/.dsh/AGENTS.md`（原文留在 hub 内） | README:149 |

### 3.2 本仓库现状

| 能力 | 现状 | 位置 |
|---|---|---|
| 场景段 | 只有 `tools.deny` + `mcp.off/on` | `scene-engine.d.ts:19-25`；`lib/scene-engine.js:44-61` |
| 快照 | `{at, toolDeny, sessions, mcp}`；**`sessions` 只记录、从不还原** | `lib/scene-engine.js:64-78` vs `:103-109`、`:126-152` |
| 意图记录 | `state.mode = {version,name,at,snapshot}`，`scene.exit` 还原后清空 | `scenes.ts:101-129`、`lib/scene-engine.js:162-181` |
| 应用顺序 | 先 `tools`（一条 `applySurface`）再逐个 `mcp` server | `scenes.ts:138-161`、`lib/scene-engine.js:111-120` |
| op | `scene.save/plan/apply/exit`（**没有 delete、没有 lock**） | `scenes.ts:240-260` |
| 失败语义 | 逐目标尽力 + 诚实的不完整回滚报告 | `lib/scene-engine.js:126-152` |
| 成员开关 | `toggle`（`{kind,id,enabled}`）/`bulk`（`{items,enabled}`） | `plugins.ts:351-352`、`:406-412` |
| 单入口分发 | `Dispatcher.execute` 是所有 op 的必经之路 | `dispatch.ts:259-268`；`routes.ts:232`；`catalog-tool.ts:47` |

### 3.3 Scene 契约（`lib/scene-engine.js` + `src/domains/scene-engine.d.ts`）

```ts
export const SCENE_VERSION = 2          // 1 的档案仍可读（normalizeScene 容忍缺字段）

export interface Scene {
  version: number
  name: string
  /** 段未定义 = 不动这个域；定义了（含空数组）= 按这份名单置定。 */
  tools?: { deny: string[] }
  mcp?: { off: string[]; on: string[] }
  /** 新增：启用的插件 id 选集；未列出的插件关闭。 */
  plugins?: string[]
  /** 新增：启用的技能 id 选集；未列出的技能关闭。 */
  skills?: string[]
  /** 新增：进入时先应用这个 preset（按名引用）；与显式段冲突时显式段赢。 */
  preset?: string
  /** 新增：锁定标志，见 §3.5。 */
  locked?: boolean
}
```

**语义细则（逐条可测）：**

| 段 | 未定义 | 已定义 | 备注 |
|---|---|---|---|
| `tools` | 不碰遮罩 | `state.toolDeny = deny`（只留 `mcp__`） | 现状（`scene-engine.js:49-55`） |
| `mcp` | 不碰任何 server | `off` 先关、`on` 再开；不存在记 `missing` | 现状（`:81-100`） |
| `plugins` | 不碰 | 列出的开、其余（`manageable !== false` 且不是自己）关 | 与 `planPresetApply` 的 exact 语义一致（`presets.ts:134-152`），复用同一套 `planPresetApply` 判定，不另写一份 |
| `skills` | 不碰 | 同上 | 同上 |
| `preset` | 不应用 | 进入时先 `preset.apply(exact)`；preset 不存在 → `missing:['preset:<名>']`、继续（像 mcp 缺行） | 显式段与 preset 撞域时**显式段赢**，`plan.presetOverridden: ['plugins'\|'skills'\|'tools']` |
| `locked` | 视为未锁 | `true` 即锁 | 不参与 apply，只参与写门禁 |

- `normalizeScene` 对 `plugins`/`skills` 做：只留字符串、去重、trim、长度 ≤120；`preset` trim ≤60；`locked` 严格 `=== true`。非数组/非字符串抛 `null`（沿用现有「坏档案视为不存在」策略，`:44-48`）。
- `version` 写成 `SCENE_VERSION`；读到 `version:1` 的旧档案**不迁移写回**，只按缺字段处理（`scenes.ts:168-178` 保存时才重写）。

### 3.4 快照与还原契约

```ts
export interface SceneSnapshot {
  at: number
  toolDeny: string[]
  /** 仅报告用：场景不还原会话覆盖（见下）。 */
  sessions: Record<string, string[]>
  mcp: Record<string, { id: string; enabled: boolean }>
  /** 新增：抓取时**每一行**的开关（不是只抓被改的行）。 */
  plugins?: Record<string, boolean>
  skills?: Record<string, boolean>
}
```

- 抓全量而不是只抓被改行：退出时才能把用户「进场景后手动打开的那个插件」也放回原样（参考侧同样记录每一行，`archive.ts:41-47` 的注释）。
- **还原顺序**：`plugins` → `skills` → `tools` → `mcp`。理由：成员开关是最慢、最可能半途失败的（每行一次 IO），先做；`tools` 是一次 `applySurface`，便宜；`mcp` 最后，因为它会触发 loader 重载、改变工具清单。
- **目标消失**（快照里有、现在没有的行）：跳过并计入 `restored: ['plugin:x (skipped)']`，不算失败（沿用 `tolerateMissing`，`scenes.ts:157`）。
- **新出现的成员**（快照里没有）：不动——不能替用户决定新插件该开还是该关。
- **`sessions` 明确不还原**：快照里保留只为「当时的现场是什么样」，`planFromSnapshot` 不生成会话动作。这一点写进 `scene-engine.d.ts` 的注释，并在 `scene.exit` 的回执里给 `note: 'session overlays are not part of a scene'`（避免用户以为会话覆盖被吞了）。理由：场景是**安装级**环境（G6 的第 1 层），会话覆盖是更细的第 3 层；场景去改写别的会话的覆盖会造成跨会话惊吓。
- `plan.presetOverridden` 与 `missing` 都进 `describePlan` 的一行描述（`scene-engine.js:184-193` 的风格）。

### 3.5 锁语义（`src/domains/scene-lock.ts`，新文件）

```ts
/** 读 state 的纯函数：锁着的场景名（稳定排序）。 */
export function lockedSceneNames(state: StateV2): string[]
/** 当前生效的场景名（state.mode）。 */
export function activeSceneName(state: StateV2): string | null
export type FrozenScope = 'all' | 'active-scene' | 'self-scene'
/** 冻结口径登记表；未登记 = 不冻结。 */
export const FROZEN_OPS: Readonly<Record<string, FrozenScope>>
/** null = 放行；字符串 = 拒绝原因（**陈述事实、不指路 UI**）。 */
export function frozenRejection(state: StateV2, op: string, payload: unknown): string | null
```

**冻结清单（精确到 op id）：**

| 口径 | op id | 说明 |
|---|---|---|
| `all` | `mcp.save` `mcp.create` `mcp.delete` `mcp.rawSave` `toggle` `bulk` `skill.toggle` `skill.delete` `skill.import` `skill.move` `skill.restore` `skill.trashClean` `preset.save` `preset.update` `preset.delete` `preset.apply` `tool.save` `tool.import` `lazy.set` `lazy.load` `lazy.unload` | 这些都会改变「场景所描述的那套环境」 |
| `self-scene` | `scene.save`（目标是锁着的场景时）、`scene.delete` | 改/删被锁的档案本身 |
| `active-scene` | `scene.apply`（换到别的场景时）、`scene.exit` | 锁的是当前生效场景时，不许它被切走/退出 |
| 从不冻结 | `scene.lock` | 解锁必须是出口，否则死锁 |
| 不冻结 | `session.set/clear` `scope.workspace` `scope.roles` `settings.set` | 会话覆盖不是场景内容；设置是呈现层 |
| 不冻结 | `scene.plan` `mcp.list` 等只读 | 无副作用 |

- `scene.apply` 的 `active-scene` 细节：**当前场景已锁**且目标场景 ≠ 当前场景 → 拒；目标就是当前场景（重复提交）→ 放行（没改变任何东西）。`scene.exit` 在锁着时一律拒（退出就是改变）。
- 安装点：`Dispatcher.execute`，在 `assertConfirmed`（`dispatch.ts:264`）之后、取 handler 之前：
  ```ts
  const frozen = frozenRejection(this.state, id, payload)
  if (frozen !== null) throw new Failure('scene-locked', frozen)
  ```
  这样 HTTP（`routes.ts:232`）、模型侧 `hub_tools`（`catalog-tool.ts:47/72-75` 走 `dispatcher.execute`）、CLI 全部覆盖，且**只有一处判据**。
- **场景引擎自己不受锁影响**：`sceneIoFor` 直接改 `env.state`/`port.setEnabled`，不走 `execute`（`scenes.ts:138-161`），所以「锁着的场景仍然能被自己应用/退出」——这正是参考侧要的（`request-gate.ts:206-211`）。但 `scene.exit` 的 op 本身被 `active-scene` 挡住：锁着就退不出去，这是有意的（要么解锁、要么别锁）。
- 拒绝文案（模型也能读）：
  - `all`：`scene "<名>" is locked: this write was refused because it would change the environment that scene defines; unlock that scene first.`
  - `self-scene`：`scene "<名>" is locked: its archive cannot be modified or deleted; unlock it first.`
  - `active-scene`：`scene "<名>" is locked and currently active: switching away or exiting is refused; unlock it first.`
  （不写「去场景页点解锁」——那是对人说的；模型照着做不了。参考侧同一条纪律，`request-gate.ts:234-237`。）
- 多把锁：任意一把锁住即冻结（`any(scene.locked)`），文案里列出全部锁着的名字。**不做「锁只保护自己域」的细分**——参考侧也是整体冻结：锁的意义是「环境别再动」。

### 3.6 op 契约

| op | 写 | 审计 | 载荷 | 回执 |
|---|---|---|---|---|
| `scene.save`（扩） | ✓ | ✓ | `{name, tools?, mcp?, plugins?, skills?, preset?, locked?, note?}` | `{scene, scenes, backup}`；被锁时抛 `scene-locked` |
| `scene.plan`（扩） | – | – | `{name}` | `{scene, plan, description, preset?, missing, presetOverridden}` |
| `scene.apply` | ✓ | ✓ | `{name}` | 现有字段 + `preset`/`skipped` |
| `scene.exit` | ✓ | ✓ | `{}` | 现有字段 + `note` |
| `scene.delete`（新） | ✓ | ✓ | `{name}` | `{deleted, scenes, backup}`；不存在抛 `unknown-scene` |
| `scene.lock`（新） | ✓ | ✓ | `{name, locked: boolean}` | `{name, locked, scenes, backup}` |

- `scene.save` 目前是「整份重写这个名字」（`scenes.ts:168-178`）；扩字段后**仍整份重写**，但 `locked` 只能由 `scene.lock` 改（`scene.save` 收到 `locked` 时忽略并回报 `ignored: ['locked']`），避免「保存一下就把锁丢了」。
- `scene.delete` 要顺手处理：删的是当前生效场景 → 拒绝（`fail('scene-active')`），先 exit；模式记录里的快照保留（那是回滚依据）。
- `scene.lock` 永远不冻结；锁另一个场景不影响当前。回执里给 `lockedScenes: string[]`。

### 3.7 UI 控件（`src/client/views/scenes.tsx`）

1. 行内徽章加：`插件 N · 技能 N · MCP N · 工具 N`（`memberCount` 现在只数 `plugin/skill/tool`，`:12-23`，扩成读四段）。
2. 行按钮：应用（现状）｜编辑（新，Dialog 里改段）｜锁/解锁（新，二次确认只在「锁」时）｜删除（新，二次确认，提示不可撤销）。
3. 锁态全局提示条：有锁着的场景时，页面顶部 `Callout`：「场景「X」已锁定：插件/技能/MCP/预设/工具面的写操作会被拒绝」。列表行加锁图标与 `aria-label`。
4. `preset` 绑定：编辑弹窗里一个 select（现有 preset 名 + 空=不绑定），旁边一行说明「进入时先应用这个预设；与下面勾选的段冲突时以勾选为准」。
5. 应用前确认：现有 `scenes.confirmApply` 设置（`domains/settings.ts:22`）已经有开关，沿用；确认框里列 `describePlan` 的一行描述。

### 3.8 探针

| 文件 | 用例 |
|---|---|
| `probe/scene-smoke.mjs`（已存在，扩） | `normalizeScene` v2：`plugins/skills/preset/locked` 的合法与坏值；`captureSnapshot` 抓全量成员；`planFromScene` 段未定义 vs 空数组；`restoreSnapshot` 的顺序与 skipped 报告；`sessions` 永不还原 |
| `probe/next/scene-lock.mjs`（新） | 冻结表逐 op：`mcp.save`/`toggle`/`preset.apply`/`tool.save` 被拒；`scene.lock` 放行；`session.set` 放行；`scene.apply` 同场景放行、换场景拒；`scene.exit` 拒；解锁后全部放行；文案含场景名且不含 UI 指路词 |
| `probe/next/domain-workflows.mjs`（扩） | `scene.delete` 删当前场景被拒；`scene.save` 忽略 `locked` 并回报；`scene.plan` 的 `presetOverridden` |
| `probe/next/client-scenes.mjs`（新，静态门） | 四个行按钮的 op 与载荷、锁徽章 a11y、i18n 齐全、文件 < 300 行 |
| `probe/next/core-state.mjs` | `sceneMap` 仍原样保留含 `locked` 的记录（`state.ts:130-139`） |

### 3.9 明确不做（写进 README/设置提示，别留成隐性缺口）

- **AGENTS.md 的写入/应用**：参考侧「提示词应用」会覆盖 `~/.dsh/AGENTS.md`（README:149）。对我们这是 **A 级写入**（`~/.dsh` 下配置，操作者契约 §3.2①），场景**永远不写它**；要改提示词走单独流程（四要素 + 明确同意）。场景可以「绑定提示词预设名」只是引用，不落盘。
- **记忆域 / 子智能体人设 / 快捷提示词**：不纳入场景（参考侧的记忆层是它自己的产品定位；我们的场景只覆盖「环境开关」）。
- **会话覆盖不进场景**（§3.4）。
- **不做启动自动对账**（参考侧 `boot/reconcile.ts`）：另一个议题，不在 G9。
- **不做回收站**：`scene.delete` 直接删；要恢复靠 `backup.*`（已有备份域，`domains/backups.ts`）。

---

## 4 G11：preset 级工具策略

### 4.1 参考实现的事实

| 事实 | 证据 |
|---|---|
| 策略形状：`{presets: Record<presetId, {disabled: string[], groups:[{name, description?, patterns: string[]}]}>}` | `types.ts:6-26` |
| 落盘：`$DSH_HOME/tool-manager.json`（或 `DSH_TOOL_MANAGER_CONFIG`），单文件 | `config.ts:8-19` |
| 保存：revision CAS + 原子写（临时文件→rename，Windows 上与杀软抢锁时 rename-aside 重试） | `config.ts:40-55`、`:72-101` |
| 归一化：presetId 去空；组名 trim、按小写去重；patterns trim 去重去空 | `policy.ts:17-51` |
| 缺 preset → 空策略（不抛） | `policy.ts:53-59` |
| 组员计算：一个工具只属于第一个命中它的组；`disabled` 的成员不算进组 | `policy.ts:84-98` |
| 诊断：空组 / 组员被 disabled / 组员重复 | `policy.ts:100-122` |
| 隐藏集：`disabled` ∪ 所有组（不论开没开） | `policy.ts:124-136` |
| 实际 deny：**未打开的组员** + `disabled`；`run_code`（PTC 传输）永不被 deny；有活跃组时保留 `tool_list`，否则也 deny | `policy.ts:145-166` |
| 孤儿：`disabled` 里当前不存在的名字 / 空组 | `policy.ts:175-184` |
| 保存前校验「不许空组」，且用**页面看到的同一份目录** | `index.ts:634-665` |
| 草稿：界面 state，`dirty = settingsSignature(snapshot) !== settingsSignature(draft)`，卸载前拦截 | `client.js:290-330` |
| 复制：把源 preset 的策略**投影**到目标 preset —— 只保留两边都有的工具名，成员全消失的组跳过（并列出被跳过的组名） | `client.js:97-135` |
| 重置：确认后把当前 preset 的策略清成 `{disabled:[],groups:[]}`，**只改草稿**，保存才生效 | `client.js:366-376` |

### 4.2 本仓库现状

| 能力 | 现状 | 位置 |
|---|---|---|
| preset 记录 | `{name, enabled:{plugin,skill,tool}, toolDeny?, note, createdAt, updatedAt?}` | `presets.ts:44-52` |
| 捕获 | `presetFromSnapshot` 四维；`toolDeny` 记安装层原始名单 | `presets.ts:105-115`、`:220-249` |
| 应用 | 逐成员 `setEnabled`（60ms 间隔）+ 工具维（recorded > live > deferred > leave） | `presets.ts:276-321`、`:154-188` |
| 草稿 | settings 页有一套成熟纯函数：`draftOf/dirtyOf/savePayloadOf/restoreDefaultsOf` | `settings/model.ts:134-174` |
| preset 级策略 | **无**（`enabled.tool` 只是「当时可见的名字清单」） | `toolPolicy` 在 `src/domains/presets.ts` 0 命中；`disabled` 只出现在文件头注释 `:7`（实测 `grep -c` = 1） |
| 复制/重置 | **无** | 同上 |
| 按需组运行时 | **无**（只有懒 MCP 服务器 + `hub_tools`） | `tool-surface.ts:244-292`、`host/catalog-tool.ts:47-75` |

### 4.3 契约：schema

```ts
// src/domains/presets.ts
export interface PresetToolGroup {
  name: string
  description?: string
  /** 精确名或含 `*` 的通配模式（与参考一致，`policy.ts:215-219`）。 */
  patterns: string[]
}
export interface PresetToolPolicy {
  disabled: string[]
  groups: PresetToolGroup[]
}
export interface PresetRecord {
  name: string
  enabled: PresetEnabled
  toolDeny?: string[]
  /** 新增：这一份 preset 自己的工具策略。 */
  toolPolicy?: PresetToolPolicy
  note: string
  createdAt: number
  updatedAt?: number
}
```

**归一化（`normalizePresets`，`:66-93` 内扩）：**

- `toolPolicy` 存在才读；`disabled` 走 `mcpNames()`+去重+排序；`groups` 逐项：`name` trim 非空、按 `name.toLowerCase()` 去重（先到先得）、`patterns` 去重去空、`description` trim；组数 ≤50、每组 patterns ≤200、disabled ≤2000（超限截断 + warn）。
- **不变量 I1**：`toolPolicy` 存在时，`enabled.tool` 视为**派生视图**；保存时同步刷新成 `known − disabled − (组员)`（但保存不依赖 live 名单，见 §4.4 的 deferred）。
- 旧文件没有 `toolPolicy` → 保持 `undefined`（与 `toolDeny` 的历史语义一致：老档案不假装自己有策略，`presets.ts:85-88`）。

**捕获（`presetFromSnapshot` 扩）：**

```ts
export interface PresetSnapshot {
  enabled: PresetEnabled
  toolDeny: string[]
  toolPolicy: PresetToolPolicy          // 新
}
```

- `disabled` = 当前安装层 `state.toolDeny`（这就是用户眼里「关掉的工具」）。
- `groups` = 当前按需组（`state.modules['tool-surface'].groups`，G10 落地后才有；现在恒 `[]`）。
- `enabled.tool` 仍照旧录（`known − denied`），只用于展示与旧客户端。

### 4.4 应用语义（`preset.apply`）

优先级链保持 1.x 的：「recorded deny > live complement > deferred > leave」（`:154-188`），**再加上 policy 层**：

1. `toolPolicy` 存在 → **它赢**：`state.toolDeny = policy.disabled`；`toolDeny` 字段忽略（回执 `tools.source='policy'`）。理由：两个来源同时写 deny 必然分叉；policy 是更精确的那份。
2. 没有 `toolPolicy` → 完全按今天的逻辑（recorded / live / deferred / leave），一行不改。
3. `groups`：`exact` 模式下落成当前按需组表；`only-enable` 模式**不动组表**（只关不组，避免把用户的组定义吞掉）。
4. 应用后刷 `enabled.tool` 派生视图（若 known 为空 → 记 `deferred`，沿用现有机制，不自造定时器，`:309-312`）。
5. 回执 `tools` 增加 `policy: {disabled: N, groups: M}`。

### 4.5 草稿 / 复制 / 重置

- **草稿（界面、无 op）**：沿用 `settings/model.ts` 的纯函数模式，新增 `presets/policy.ts`（客户端可 import 的纯函数）：
  ```ts
  export function policySignature(policy: PresetToolPolicy | undefined): string      // 规范化 JSON
  export function policyDirty(saved: PresetToolPolicy | undefined, draft: PresetToolPolicy | undefined): boolean
  export function policyIssues(policy: PresetToolPolicy, toolNames: readonly string[]): {
    emptyGroups: string[]; disabledMembers: Array<{ tool: string; group: string }>; duplicateMembers: Array<{ tool: string; groups: string[] }>; orphans: string[]
  }
  ```
  与 `policy.ts:100-122`/`:175-184` 同口径；**服务端也必须有同一份**（保存校验用），放 `src/domains/preset-policy.ts`，客户端薄封装同一逻辑（或在 client 里 import 编译产物，沿用现有 client 打包方式）。
- **保存**：`preset.policy`（新 op）。校验：空组拒绝（与参考一致，`index.ts:634-665`）、组名重复拒绝、`disabled` 与组员重叠**警告但不拒**（回执 `warnings`）。并发：载荷带 `expect?: {updatedAt}`，与记录里的 `updatedAt` 不符 → `fail('stale-preset')`（我们的 state 没有全局 revision，用记录级时间戳最贴近）。
- **复制**：`preset.copy`，`{from, to: string[], what?: 'whole' | 'policy'}`：
  - `whole`：复制 `enabled`+`toolDeny`+`toolPolicy`（目标不存在则创建；存在则覆盖但保留 `createdAt`）；
  - `policy`（默认）：投影规则照 `client.js:106-135` —— 只保留目标工具集里也存在的名字（目标工具集 = 目标 preset 的 `enabled.tool` ∪ 当前 known），空组跳过并列出。
  - 回执：`{copied: Array<{to, disabled, groups, skippedGroups}>, skipped: Array<{to, reason}>}`。`reason` 取值：`'target-missing'`、`'no-common-tools'`。
- **重置**：`preset.policyReset`，`{name}` → `toolPolicy = {disabled: [], groups: []}`（保留 `enabled` 与 `toolDeny`）。要「回到没有策略」用 `preset.policy` 传 `toolPolicy: null`（新增显式 null 语义），两个动作分开，避免一个按钮两种意思。

### 4.6 op 契约

| op | 写 | 审计 | 载荷 | 回执 |
|---|---|---|---|---|
| `preset.policy`（新） | ✓ | ✓ | `{name, toolPolicy: PresetToolPolicy \| null, expect?: {updatedAt: number}}` | `{name, toolPolicy, warnings, backup}` |
| `preset.copy`（新） | ✓ | ✓ | `{from, to: string[], what?: 'whole'\|'policy'}` | `{copied, skipped, presets, backup}` |
| `preset.policyReset`（新） | ✓ | ✓ | `{name}` | `{name, toolPolicy, backup}` |
| `preset.apply`（扩） | ✓ | ✓ | 不变 | `tools.policy` 字段 |
| `preset.save`/`preset.update`（扩） | ✓ | ✓ | 不变 | 捕获时带上 `toolPolicy` |

- 三个新 op 都走 `env.save('preset-policy' | 'preset-copy' | 'preset-policy-reset')`，与现有 reason 风格一致（`presets.ts:247/263`）。
- 领域注册追加进 `presetsDomain()`（`:324-343`），模块 id 不变（`presets`），ops 数组变 7 条。
- `expect` 只是**可选**；不传就按「最后写入赢」，回执里给 `updatedAt` 让界面能刷新。

### 4.7 UI 控件（`src/client/views/presets.tsx`）

1. 行内徽章：`N 项` 后面再加 `禁用 K · 组 M`（K/M 来自 `toolPolicy`）。
2. 行按钮多一个「工具策略」，打开 Dialog（宽一些）：
   - 顶部：搜索 + 过滤（全部 / 已禁用 / 按需组 / 未分组）+ 统计卡（总数 / 未分组 / 按需 / 禁用，口径同 `client.js:182-193`）；
   - 列表：每行一个开关（禁用=开），组员行标所属组名并置灰（成员身份由组决定，见参考 `eligibleGroupTools`，`client.js:159-162`）；
   - 组编辑器：新建/改名/描述/勾选成员（只能是「未禁用且未被别的组占用」的工具）；空组、组员重复、组员被禁用三条即时提示（`groupDraftIssues` 同口径，`client.js:164-181`）；
   - 底部草稿条：`未保存 N 处变更` + 保存 + 重置 + 复制到…；未保存时关闭要确认。
3. 「复制到…」Dialog：源固定为当前 preset，目标多选（排除自己和 broken），预览每个目标会 `复制 K / 跳过组 M`，确认后调 `preset.copy`（`what:'policy'`）。
4. 「重置」二次确认文案必须说清「只清这台 preset 的禁用与组，不改插件/技能；保存后生效」。
5. 应用行仍走 `applyTwice`（`:100-110`）——`preset.apply` 的 deferred 机制不变。

### 4.8 探针

| 文件 | 用例 |
|---|---|
| `probe/next/core-state.mjs` | `toolPolicy` 坏值（组名空、重复、patterns 非数组）被丢弃；`toolPolicy: null` 与缺失可区分 |
| `probe/next/client-presets.mjs`（静态门，扩） | 新 op 被引用、载荷字段、Dialog 数量（现在是 3 个，`:264-349`）、文件行数上限（现 450，策略编辑器会超 → **拆成 `views/presets-policy.tsx` 子组件**） |
| `probe/next/domain-workflows.mjs`（扩） | `preset.policy` 保存后回读一致；空组拒绝；`expect.updatedAt` 不匹配抛 `stale-preset`；`preset.copy` 投影（目标缺成员 → 组缩小；成员全缺 → `skippedGroups`）；`policyReset` 只清策略；`preset.apply` 用 policy 时回执 `source:'policy'` |
| `probe/next/tool-catalog.mjs`（扩） | `mergeSurface` 新源与新 `exempted` 字段不破坏既有断言；`tool.plan` 在给 `workspaceKey` 前后输出不同 |
| `probe/size-budget.mjs` | `presets.ts` 343 → 约 480 行；超 1500 软线才拆文件（预计不用）；`scenes.ts` 262 → 约 420 |

### 4.9 依赖与不做

- **`groups`（按需组）运行时依赖 G10**：需要「组目录注入 + 每会话曝光状态 + 曝光状态从会话事件恢复（含 fork 前缀）」（参考 `runtime.ts:601-650`、`exposure-history.ts:1-20`）。我们可以先复用一个已有的 discovery 工具（`hub_tools`，`catalog-tool.ts:47-75`）扩展 `action:"groups"`/`action:"open"`，但**曝光状态的持久语义必须和 G10 一起定**，否则 fork 出来的子会话会随机继承/丢失。因此：**G11 拆两期**——
  - G11a（本期）：`disabled` + 草稿 + 保存 + 复制 + 重置；`groups` 可编辑与保存，但运行时不隐藏成员（UI 明写「组暂不生效」）。风险低、可独立验收。
  - G11b（G10 之后）：`groups` 落成运行时隐藏 + `hub_tools` 打开组 + 曝光状态。
- **不做**：`PTC_TRANSPORT_NAME`（`run_code`）永不被 deny 这条规则（`policy.ts:162`）。我们是 PTC 模式运行时，`run_code` 被 deny 会直接把整个执行通道关掉；**照抄**这条。
- **不做**：模型自动分组/建议（`suggest.ts`）——另一个议题。
- **不做**：按宿主 `agentPreset`（`types.ts:135`）自动切换策略。宿主确实在 header 里持久了 preset id，但把我们的策略绑到宿主 preset 需要读 registry 并处理重载竞态（参考侧为此写了 `preset-repair.ts`/`composition-watch.ts`），风险高、收益低于「用户显式 apply」。留作开放问题（§7）。

---

## 5 文件级实现顺序

三阶段可并行；同一阶段内按序。每步都自带验收门，**不通过不进下一步**。

### 阶段 A：G6（依赖链最长，先做）

| # | 文件 | 交付 | 验收 |
|---|---|---|---|
| A1 | `src/host/scope-policy.ts`（新，约 150 行） | §2.5 的纯函数 + 类型 | 新 `probe/next/scope-policy.mjs` 全绿（E1–E5、工作区键归一化、fork 判据） |
| A2 | `src/core/state.ts` | 四新键 + `emptyState` + `KNOWN_KEYS` + `migrate` | `probe/next/core-state.mjs` 扩例全绿；**旧文件（无新键）读写成逐字节等价** |
| A3 | `src/host/tool-mask.ts` | `ScopePolicy` 字段、`hydrateScope`、三个 setter、`denyFor` 改调 `resolveScopedDeny`、`Mounted.agent`、`agentsInfo` | `probe/next/tool-mask.mjs` 现有 20 例不回归 + 新 P1–P10 |
| A4 | `src/host/index.ts` | `attachToolMask` 传 `state`；`provide('toolHub.mask', maskControl(mask))` 新面 | `probe/host-contract-smoke.mjs` + `host-api.mjs` |
| A5 | `src/domains/sessions.ts` | `session.set` 扩 allow、`session.clear` 双键、`session.lineage` 扩、写后同时调遮罩与 `applySurface` | `probe/next/domain-workflows.mjs` 扩例 |
| A6 | `src/domains/scopes.ts`（新）+ `src/domains/index.ts` | `scope.list/workspace/roles` | 同上 + `op-registry-smoke.mjs`（op 数与声明一致） |
| A7 | `src/domains/tool-surface.ts` | `SurfaceSource` 扩、`exempted`、`tool.plan` 载荷 | `probe/next/tool-catalog.mjs`、`tool-costs.mjs` 不回归 |
| A8 | `src/host/snapshot.ts` | 投影 `sessionAllow/workspaces/subagent*/mask.agents` | `probe/next/client-shell.mjs`（快照形状） |
| A9 | `src/client/views/sessions.tsx` + `src/client/i18n.ts` + `locale/*.json` | §2.7 | `probe/next/client-sessions.mjs` 扩例；`npm run typecheck` |
| A10 | 文档 | `docs/API.md` 的 op 表 + `docs/ARCHITECTURE.md` 的分层图 | 与 `registry.ops()` 一致（`op-registry-smoke` 可查） |

### 阶段 B：G9（可与 A 并行到 A3 之后；锁不依赖 A）

| # | 文件 | 交付 | 验收 |
|---|---|---|---|
| B1 | `lib/scene-engine.js` + `src/domains/scene-engine.d.ts` | Scene v2（plugins/skills/preset/locked）、快照 v2、还原顺序、`sessions` 不还原的注释 | `probe/scene-smoke.mjs` 扩例 |
| B2 | `src/domains/scenes.ts` | `readMode` 扩、`sceneIoFor` 加成员端口、`scene.save/plan/apply/exit` 扩、`scene.delete/lock` | `probe/next/domain-workflows.mjs` 扩例 |
| B3 | `src/domains/scene-lock.ts`（新）+ `src/host/dispatch.ts` | 判据 + 在 `execute` 装闸 | 新 `probe/next/scene-lock.mjs` 全绿 |
| B4 | `src/client/views/scenes.tsx` + i18n | §3.7 | 新 `probe/next/client-scenes.mjs`；`typecheck` |
| B5 | `docs/API.md` / `README` 场景段 | 语义差异（会话不进场景、AGENTS.md 不做） | 文档评审 |

### 阶段 C：G11（G11a 可与 A/B 并行）

| # | 文件 | 交付 | 验收 |
|---|---|---|---|
| C1 | `src/domains/presets.ts` | `PresetToolPolicy` 类型 + `normalizePresets` 扩 + `presetFromSnapshot` 扩 | `core-state.mjs` 扩例 |
| C2 | `src/domains/preset-policy.ts`（新，纯函数） | `policyIssues`/`policySignature`/投影 `projectPolicy` | 单测式探针（`probe/next/domain-workflows.mjs` 内） |
| C3 | `src/domains/presets.ts` | `preset.policy/copy/policyReset` + `preset.apply` policy 优先 | `domain-workflows.mjs` 扩例 |
| C4 | `src/client/views/presets.tsx` + 新 `presets-policy.tsx` + i18n | §4.7 | `client-presets.mjs` 扩例；两文件各自 < 450 行 |
| C5 | 文档 | `docs/API.md` presets 段；`README.zh` 功能表 | 文档评审 |

**回归面（每阶段结束都跑）**：`npm run test:next`（`npm run build` + **33** 个探针，实测 `package.json` 链长 34）+ `npm run test:probes` + `npm run typecheck` + `probe/size-budget.mjs`。
已知会被触碰的既有断言：`tool-catalog.mjs`（合并源）、`client-tools.mjs`（describe 文案）、`client-sessions.mjs`（视图结构）、`op-registry-smoke.mjs`（op 数）、`integration.mjs`（端到端快照字段）。

---

## 6 交叉约束

1. **大小**：`tool-mask.ts` 532 → 约 660（`scope-policy.ts` 分走公式）；`presets.ts` 343 → 约 480；`scenes.ts` 262 → 约 420。全部低于 1500 行软线，不需要拆。
2. **i18n**：每个新界面字符串都要进 `src/client/i18n.ts` 内联字典 **和** `locale/zh.json`/`locale/en.json`；`client-*.mjs` 的静态门会查 key 是否两处齐全。
3. **不新增宿主 seam**：G6 只用 `header`（已可读）；G9 只用现有 `applySurface`/`setEnabled`/`Dispatcher`；G11 只用 state + 现有成员端口。若实现中发现需要新 seam，回到本文件标 `[NEEDS-SEAM]` 再讨论，不要在 handler 里猜。
4. **一套公式**：`resolveScopedDeny` 是唯一实现；遮罩（应用）、`scope.list`（报告）、`preset.apply`（策略落盘后的自检）都调它。任何地方出现第二份「合并 deny」的循环，就是 bug。
5. **A 级动作**：本设计不含任何 `~/.dsh` 下配置改写（AGENTS.md、patch、presets 都在 `state.json` 之外由 `env.save` 走备份链）。场景/策略的写入全走 `env.save`（`core/io`：备份 + 锁 + 原子写）。
6. **模型可读的拒绝文案**：G9 的锁、G6 的 `scope.list` 说明，都以「事实 + 规则」写，不写「去某页面点某按钮」。

---

## 7 待拍板（需要 lead / 用户决定）

1. **会话 allow 要不要持久化？** 本文选择持久（与现有 deny 一致，重启不丢，`session.clear` 可清）。参考侧是纯内存（`tool-filter.ts:9`）。若选内存，state 少两个键（`sessionAllow`），但重启后放行消失、且需要「会话结束清理」的钩子（我们目前没有 `agent/disposed` 之外的生命周期信号）。
2. **工作区匹配要不要祖先语义？** 本文按参考实现取精确相等。若用户的实际用法是「在一个 repo 的子目录开会话」，精确匹配命中率会低；祖先匹配必须按路径分隔符边界比较（避免 `C:/work` 吞 `C:/workspace`），建议先精确、收集一轮真实用法再定。
3. **`groups` 是否并入本期？** 本文建议 G11a 只做 `disabled`，`groups` 编辑/保存但运行时不生效，等 G10。若要求本期生效，需要先定曝光状态的持久语义（fork 前缀是否算继承），工期显著变大。
4. **锁的默认值？** 新建场景默认 `locked:false`（保持现状可用性）；参考产品鼓励给「生产环境」类场景上锁。是否在 `scene.save` 的 UI 上加一个「保存并锁定」快捷项，需要产品口径。
5. **`scene.preset` 绑定值不值得？** 它引入「绑定 vs 显式段」的优先级解释成本（§3.3）。如果用户更愿意「把 preset 的内容直接展开成场景段」，可以砍掉 `preset` 字段，改用「从 preset 复制成场景」的一次性动作（更像 `preset.copy` 的反向）。

---

## 附录 A 证据索引

**参考侧**

- 面板作用域：`src/tool-filter.ts:7-15`（公式）、`:32-42`（类型）、`:58-69`（工作区键）、`:180-186`（子代理）、`:189-198`（cwd/session）、`:206-238`（求值）、`:296-374`（每 agent 插件）、`:394-429`（applyTo）、`:438-445`（release）、`:518-543`（事件）
- 面板 RPC：`src/mcp/gateway.ts:134-136`、`:435-445`、`:447-522`；`src/mcp/wire.ts:186-205`
- 面板客户端：`src/client.ts:4589`、`:4947`、`:5050`（作用域选择器的状态来源）
- 场景/锁（ptm）：`README.md:23-24/38/40/78/86/149`；`src/memories/archive.ts:7-39/41-47`；`src/scope/scope-overrides.ts:1-58`；`src/request-gate.ts:202-246/248-306/308-330`
- preset 策略（tm）：`src/types.ts:6-26/46-62`；`src/policy.ts:17-28/30-51/53-59/61-71/84-98/100-122/124-136/145-166/175-184/215-219`；`src/config.ts:8-19/40-55/72-101`；`src/index.ts:634-665`；`src/client.js:97-135/136-139/159-162/164-181/182-193/290-330/366-376`

**宿主**

- `@deepseek-ai/dsh-session/src/types.ts:95-136`（`cwd` 106、`parentSession` 112 + 107-111 注释、`origin` 122、`delegationDepth` 128、`agentPreset` 135）、`:156-163`（meta 可写同名字段）

**本仓库**

- 状态：`src/core/state.ts:31-48/51-66/71-86/117-128/148-156/166-207`
- 合并：`src/domains/tool-surface.ts:27/79-102/106-127/135-171/416-430/469-530/625-629/728-755`
- 遮罩：`src/host/tool-mask.ts:50-52/96-131/134-147/159-218/225-354/356-384/386-413/427-436/439-473/483-511/513-530`
- 会话：`src/domains/sessions.ts:31/42-62/69-79/91-99/101-136/139-156`
- 场景：`src/domains/scenes.ts:1-11/41-44/101-129/138-161/168-237/240-260`；`lib/scene-engine.js:44-61/64-78/81-100/103-109/111-120/126-152/162-181/184-193`；`src/domains/scene-engine.d.ts:19-25/32-38/46-59/74-88/105-115`
- 预设：`src/domains/presets.ts:44-52/66-93/105-115/118-125/134-152/154-188/220-265/276-321/324-343`
- 设置纯函数：`src/client/settings/model.ts:134-174`；设置键：`src/domains/settings.ts:6-25`
- 分发：`src/host/dispatch.ts:83-93/259-268/274-294`；服务注册：`src/host/index.ts:107-130`；模型工具：`src/host/catalog-tool.ts:47/72-75`；路由：`src/host/routes.ts:232`
- 快照：`src/host/snapshot.ts:90-129/144`
- 视图：`src/client/views/sessions.tsx:16-19/41-44/112-116/139-146/302-326/398-413`；`src/client/views/presets.tsx:24-29/82-93/100-110/112-163/264-306`；`src/client/views/scenes.tsx:12-23/39-137`
- 探针：`probe/next/tool-mask.mjs:37-110`（fake host）、`:112-269`（既有 20 例）；`probe/next/client-presets.mjs:1-20`（静态门写法与行数上限）
- 脚本：`package.json` 的 `test:next` / `test:probes` / `test:size` / `typecheck`

---

## 附录 B 未核实项（UNVERIFIED，实现时先验再依赖）

| # | 断言 | 状态 | 怎么验 |
|---|---|---|---|
| U1 | 遮罩能从 `agent.session.requestHeader() ?? agent.session.header` 读到 `cwd` / `origin` / `delegationDepth` | **未在真实 agent 上抓包**；依据是宿主类型声明（`dsh-session/src/types.ts:106/122/128`）与现有 `parentSession` 读取（`tool-mask.ts:165-179`） | A1 的 fake host 必须同时覆盖 `session.header` 与 `session.requestHeader()` 两种形状；A4 之后在 sandbox profile 起一次实例，打一条 `scope.list` 看真实 `cwd/workspaceKey/subagent` |
| U2 | 面板客户端的作用域选择器（`client.ts:4589/4947/5050`）只是 grep 命中定位 | 未读上下文 | 不作为契约依据；我们的 UI 按 §2.7 自定，不抄它的形状 |
| U3 | `dsh-tool-manager` 的复制/重置语义 | 只读 1.3.0 克隆；npm 最新 1.4.1（2026-11-21）可能有变化 | 若要用到「复制预览/跳过组」的细节，先看 1.4.1 的 `client.js` 同函数再定文案 |
| U4 | 参考侧「绑定提示词预设」的字段名 | `archive.ts:7-39` 只看到 `toolTablePreset`，没看到提示词预设字段 | 我们不做提示词绑定（§3.9），不需要；若要加，先核实字段名与生效时机 |
| U5 | 参考侧「五个管理域」对应的精确冻结 op 清单 | 未逐条对照它的 `op-registry.ts` | 我们的清单按本仓库 op id 重写（§3.5），**不假设与参考一致**；B3 的探针逐 op 断言 |
| U6 | 行区间精度：`client.js:366-376`、`:290-330`、`:97-135`；`scope-overrides.ts:1-58` | 按相邻函数定位，误差约 ±5 行 | 以函数名为准；引用时写成「`resetPresetConfig`（client.js 约 366 起）」 |
| U7 | `probe/next/client-presets.mjs` 的 450 行上限是硬门 | 来自该文件头注释第 10 条（读取时原文） | C4 拆文件后重跑该探针即知 |

