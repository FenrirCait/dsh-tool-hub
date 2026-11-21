# dsh-skill-mcp-panel 研究：受管块 / 外来行 / 返回会话按钮 / 可抄清单

> 研究对象（本地安装源码）：C:/Users/fenri/.dsh/profiles/sandbox/node_modules/dsh-skill-mcp-panel
> 版本 **2.3.16**（package.json:3）。npm registry 的 latest 是 **2.3.12**，比本地低 —— 说明这份安装
> 来自 GitHub Release 渠道，本地源码就是当前最新，不需要再去别处取证。
> 我们这边（下称 **hub**）：本仓库 dsh-tool-hub，2.0.0-alpha.29。
> 采样时间 2026-11-21；工作树是脏的（队友正在并行落 src/core/patch-blocks.ts 与 onBack 接线），
> 凡标注「现状」的段落都以那一刻的实际文件为准，引用行号可能随队友提交前移，函数名不变。

---

## 0. 一页结论

1. **受管块只剩两个用途**：面板新建行的落点、非 MCP 外来行的字节保真边界。**MCP 行已经不再靠块或
   panel-mcp- 前缀判归属** —— 文件里每一条 @deepseek-ai/dsh-mcp-client 都算面板的，改动走「就地字节
   跨度替换」（lib/patch-editor.js:4-9）。
2. 外来行不是「忽略」而是**必须可见**：服务端在 patch.foreign 里报 {id?, name?, managed}，GUI 出双侧
   提示、CLI 打印提示，另外给一个**只搬顶层行**的「移出受管块」动作（保守放弃条件一大堆，异常一律不写盘）。
3. 返回会话按钮 = layout 服务的 selectPanel(null)；要点是**两处都要声明**：package.json 的
   dsh.client.inject 和代码里的 inject（package.json:30-35 + lib/client.js:6058）。取不到就静默空操作。
4. hub 现状是「已经接了一半」：entry.tsx:64-76, 89 与 shell.tsx:310-314 已接线，**但 entry.tsx:16 的
   inject 和 package.json:38-41 都还没声明 layout** —— 这是唯一剩余缺口（见 §2.6）。
5. 补丁写入的两条必修缺陷**在本次研究期间已被并发修掉**（!!js 现在抛 js-expression：lib/patch-rows.js:295-301；
   重复 id 现在抛 duplicate-row 并列出所有行号：:278-282），报告保留它们作为回归测试点（§4 W5 / W6）。
   仍待处理的是一处路径不一致：MCP 新建行走 appendMcpRow（src/domains/mcp.ts:893），而 groups.ts 走
   insertOutsideBlocks —— 实测「块在尾部且闭合」时追加落在 end 之后（安全），begin 未闭合时会落进块里。见 §4.1。

---

## 1. 受管块、行归属、外来行的暴露与疏散

### 1.1 标记与常量（唯一真源）

| 项 | 值 | 坐标 |
|---|---|---|
| 块开始 | # >>> dsh-skill-mcp-panel:mcp:begin | lib/patch-editor.js:16 |
| 块结束 | # <<< dsh-skill-mcp-panel:mcp:end | lib/patch-editor.js:17 |
| 面板行 id 前缀 | panel-mcp- | lib/patch-editor.js:19 |
| MCP 插件名 | @deepseek-ai/dsh-mcp-client | lib/patch-editor.js:18 |

标记只是**两行注释**，成对出现；每个 profile 各自一份，都写在它的 cordis.patch.yml 里。

### 1.2 归属判据（两层，别混淆）

**第一层：行是不是面板的** —— 只看这一行的 id 前缀（lib/patch-editor.js:131-133）：

~~~js
export function isManagedRow(row) {
    return typeof row.id === "string" && row.id.startsWith(MANAGED_ROW_ID_PREFIX);
}
~~~

注释（:124-130）写了两件事：判据只能看**这一行**；块里允许存在别的工具、旧版本或用户手写的条目，
它们不是我们的，一律原样保留。

**第二层：行是不是 MCP 行** —— row.name === MCP_PLUGIN_NAME（lib/patch-editor.js:223-231 的
listMcpPatchRows）。

两层合起来才是现在的实际语义（lib/patch-editor.js:4-9 的文件头注释，比任何文档都准）：

> 每一条 @deepseek-ai/dsh-mcp-client 行都归面板管（启停、表单编辑、删除、原文编辑），**不再用受管块
> 或 panel-mcp-* 前缀区分「受管 / 外部」**。对这些行的改动都是就地拼接：只替换目标 entry 的字节跨度，
> 文件其余部分逐字节保留。
> begin/end 受管块仍然是「面板新建的行」落点，也仍然是非 MCP 外来行的字节保真边界（ADR-0003）。

产品侧说法见 README.md:116（「文件里每一条都能操作，不区分受管块内外，也不看 id 前缀」）与
README.md:278（v2.3.6 起接管全部 MCP 行）。

> **给 hub 的推论**：不要把「id 前缀不是 panel-mcp-」当成「面板不管这一行」。判断「这一行能不能由
> 我们改」时，前缀只是**保守下限**，不是充分条件。

### 1.3 读块：readManagedBlock（lib/patch-editor.js:164-217）

返回 { managed, foreign: { top, insert, entries } }：

| 步骤 | 行为 | 坐标 |
|---|---|---|
| 两个标记都不在 | 返回空结果（不是报错） | :167-168 |
| 只有一半 / end 在 begin 前 | 抛错「受管块标记不完整（begin/end 必须成对）」 | :169-170 |
| 块内容解析失败 | 抛错「受管块解析失败」 | :176-180 |
| 切分 | 按顶层序列项切，跨度「按下一个条目的行首界定并首尾相接铺满整块」 | :143-149 |
| insert 条目 | 成员**全部**是面板行才归面板；混进外来成员的整条原样保留 | :190-205 |
| 其它顶层条目 | 面板行归 managed；非面板行进 foreign.top + entries 记 {id,name,managed:false} | :207-216 |

两个值得抄的细节：

- **跨度铺满**（:136-149 注释）：不能用节点自身的 range —— 嵌套块集合的 range 末尾不覆盖内容，而注释
  与空行不属于任何节点。铺满之后块内每个字节都有着落，外来部分才可能逐字节搬运。
- **混成员的 insert 整条不认领**（:192-193）：认领其中「长得像面板行」的那几条会同时触发重复写入。

### 1.4 写块：generateManagedBlock + replaceManagedBlock

生成顺序固定（lib/patch-editor.js:238-251）：**外来 top → 外来 insert → 面板自己的 insert 列表**。
外来部分逐字节搬运（:240-243），面板只重建自己那一段（:244-247，用 yaml stringify 生成一个
[ { insert: rows } ]）。

替换（:275-308）：

| 情形 | 行为 | 坐标 |
|---|---|---|
| 有标记 | 只换「begin 所在行首」到「end 所在行尾」这一段 | :283-286 |
| 块变空 | 整块删掉；删完只剩注释/空白则补回 []（否则不再是合法顶层数组） | :287-294 |
| 无标记且有行 | 追加到文件末尾 | :296-307 |
| 空 profile 模板 [] | 先把 [] 换成块序列，否则变成 [] - insert（非法 YAML） | :298-305 |
| 整块被缩进 | 按原缩进对齐（blockBaseIndent） | :252-270 |

落盘链路：withPatchLock（:314-346，锁文件 <path>.panel.lock，写 pid + 时间，30 秒视为陈旧、5 秒超时）
→ validatePatchText → writeFileAtomic（lib/fs-utils.js:32-55）。

### 1.5 外来行怎么被「暴露」—— 三条通道

**通道 1：服务端 RPC。** lib/mcp/gateway.js:159-181：

~~~js
// 非 MCP 的外来行仍要报给界面（ADR-0003）。MCP 行已经在 servers 里，不再当成「未管理」。
const foreignEntries = foreign.entries.filter((entry) => entry.name !== MCP_PLUGIN_NAME);
patch = { path, ok: true, error: null, foreign: foreignEntries };
~~~

契约在 lib/mcp/wire.js:64-77，注释就是这条规矩的理由：

> 受管块内**不属于面板**的条目：面板永不改写它们，但必须让用户看见（否则就回到「面板动过却不显示」
> 的静默改写，见 ADR-0003）。

**通道 2：GUI 双侧提示。** lib/client.js:4758-4772：

| 分类 | 判据 | 文案（zh） | 坐标 |
|---|---|---|---|
| 别人的行在块里 | managed !== true | 「受管块内还有 {count} 条不属于面板的行（{list}），面板不会改动它们。」 | client.js:3730 |
| 面板的行被塞进外来 insert | managed === true | 「另有 {count} 条面板行被放在外来 insert 列表里（{list}），面板暂不管理它们。」 | client.js:3731 |

两条提示最多各列 3 个标识，多余用「等」（:4766）。旁边还有「查看机制」说明面板（:3738-3742），三段话
讲清：为什么会进块（DSH 自己的配置编辑器首次写配置时往数组末尾 add，而 end 注释正好是最后一行）／
留在块里为什么没影响（DSH 整份读取，位置不改语义）／面板为什么永不改写（宁可让它留在里面）。

**通道 3：CLI 提示。** lib/cli-mcp.js:40-45 的 describeForeign，在 add / list / remove / enable / disable
之后打印（:351-353、:358、:374-375、:402、:414-415）。

### 1.6 疏散：evacuateForeignRows（lib/patch-editor.js:357-389）

只搬 foreign.top（**顶层**行），**不搬 insert 成员** —— 注释（:354）：「搬出去会改变『插入哪些插件』的
语义，留原样」。

搬法：先把块重写成不含 top 的版本（:385），再把 top 文本插到 begin 行的**行首之前**（:386-388）——
仍在标记外、语义不变。

保守放弃的条件（有一条就原样返回，绝不半途改文件）：

| 条件 | 坐标 |
|---|---|
| 标记不齐 | :358-361 |
| 整块被缩进（嵌在别的结构里） | :362-364 |
| 块读取抛错 | :365-371 |
| foreign.top 为空 | :372-373 |
| 数不出条数 / 解析失败 / 条数为 0 | :374-384 |

落盘走 writeEvacuatedForeign（:394-404）：加锁 → 读 → 疏散 → validatePatchText → 原子写；moved === 0 时
**不写盘**（:398-399）。触发链：GUI 按钮（client.js:4775-4789）→ 注入面 evacuateForeign（:6174）→
wire 方法（lib/mcp/wire.js:359-362）→ gateway.evacuateForeign（lib/mcp/gateway.js:363-366）。

### 1.7 块收尾与删除

- **删光面板行后收标记**：stripEmptyManagedBlock（lib/patch-editor.js:617-635）—— 块里只剩注释时连
  begin/end 一起收掉，注释原样留在原位。理由（:613-616）：留下「只有一半标记」的文件会让之后**所有**
  写操作被标记校验挡住。
- **补 []**：ensurePatchArray（:637-648）—— 删完不是合法数组且只剩注释时补回 []。
- **insert 只剩一条**：删除时连 - insert: 一起删（:865-871），避免留空列表。
- **!!js 不能动刀**：setEntryDisabledInText 发现 disabled 是表达式就抛错让人改用原文编辑（:677-685）。

### 1.8 真实文件里长什么样

当前 ~/.dsh/profiles/sandbox/cordis.patch.yml（822 字节）**没有**受管块标记，但第 23-26 行留着四个
光秃秃的 - insert:：

~~~yaml
23  - insert:
24  - insert:
25  - insert:
26  - insert:
27  - id: ui-theme
~~~

它们不是当前版面板写的（当前版把面板行收进**一个** - insert:，见 patch-editor.js:245），但正好说明
**空壳会长期留在文件里**。对我们的意义：删行只删自己那几行，别去清别人的空壳；也别把新行插在它们旁边
（那已经在别人的结构区里）。

### 1.9 hub 现状对照

| 能力 | 面板 | hub 现状 | 坐标 |
|---|---|---|---|
| 受管块识别 | 有 | **有**（队友新落，未提交） | src/core/patch-blocks.ts:45-85 |
| 新行插在块外 | 有（有标记时只换块内） | **一半**：groups.ts 用 insertOutsideBlocks；MCP 新建仍 appendMcpRow（实测落 end 之后=块外，未闭合块不安全） | src/core/patch-blocks.ts:91-102；src/domains/mcp.ts:893 |
| 外来行可见化 | 有（RPC + GUI + CLI） | 无（只有 scanPatchBlocks 的 foreign 计数） | — |
| 疏散动作 | 有 | 无 | — |
| 单行不是整体重建 | 有 | 有（setRowDisabled 只改一行） | lib/patch-rows.js:307-334 |
| 重复 id 处理 | 报错 + 处置建议，只拒新增 | **已修（并发）**：报 duplicate-row + 列出所有行号 | lib/patch-rows.js:278-282 |
| !!js 保护 | 抛错不动 | **已修（并发）**：抛 js-expression，拒绝把表达式换成字面量 | lib/patch-rows.js:295-301 |
| 空文件 / [] 收尾 | 有 | 空文件写成空串 | src/domains/mcp.ts:201-206 |
| 锁 | withPatchLock（简单） | **更强**（token + pid 存活 + 陈旧破解） | src/core/atomic.ts:230-243 |
| 写后校验/回滚 | 无 | **有**（备份 → 写 → verify → 回滚） | src/domains/mcp.ts:761-785 |

---

## 2. 返回会话按钮：怎么拿到 layout 服务

### 2.1 两处声明，缺一不可

**宿主侧（package.json）**：dsh.client.inject 里必须有 @deepseek-ai/dsh-client-ui-layout
（package.json:27-36）：

~~~json
"dsh": { "client": { "platform": "web", "inject": [
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-sidebar" ] } }
~~~

**插件侧（代码）**：const inject = ["slots", "locale", "remote", "sessions", "layout"];
（lib/client.js:6058）。

### 2.2 取服务与调用

~~~js
// 返回会话：layout 服务由宿主 shell 提供（已声明进 inject）；取不到时箭头是空操作，
// 不影响其它功能。
const backToConversation = () => {
    const layout = ctx.get("layout");
    if (layout === null || typeof layout !== "object")
        return;
    if (typeof layout.selectPanel === "function")
        layout.selectPanel(null);
};
~~~

（lib/client.js:6127-6135）

为什么是 selectPanel(null)，lib/client.js:5854-5857 的注释讲得最清楚：

> 宿主 layout 服务的 selectPanel(null) 就是「把主区还给 Conversation」，而且它不改当前选中会话 ——
> 面板本来也没换过会话，所以返回的就是进来之前那个会话。

### 2.3 按钮外观

PageBack（lib/client.js:5859-5878）：IconChevronLeftOutlineRegular 14px（取不到就内联一条 SVG 折线），
文案来自字典 back（zh：「返回会话」，:499；en：「Back to session」，:3823），title 也设成同一个 label，
className 复用宿主面包屑样式。

### 2.4 页面骨架契约

页头必须是页面的**第 1 个**孩子、页签是**第 2 个**（lib/client.js:6026-6032、:6050-6054），注释点名了
守护测试 test-panel-slots.mjs。返回按钮就在页头里（:6032），onBack 从注入面传进来
（sectionFace :6136-6137、mcpSectionFace :6154-6155）。

### 2.5 槽位注册

~~~js
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist", id: PANEL_ID, order: 1, label: () => t("navCombined"), locale: NS }, PanelIcon));
// 中央主区页面：key 必须与上面的行 id 一致，选中缺失 key 宿主会直接抛错。
ctx.slots.inject("main", () => ctx.slots.register({
  name: "main", key: PANEL_ID, locale: NS, inject: combinedFace }, CombinedPanelPage));
~~~

（lib/client.js:6188-6201）

### 2.6 hub 现状与唯一缺口（实测）

| 环节 | 现状 | 坐标 |
|---|---|---|
| 取 layout + selectPanel(null) | **已做**（lazy ctx.get('layout')，带 try/catch） | src/client/entry.tsx:64-76 |
| 传给 Shell | **已做**（onBack: backToSession） | src/client/entry.tsx:89 |
| 顶栏渲染按钮 | **已做**（← 返回会话，i18n action.backToSession） | src/client/shell.tsx:310-314 |
| 代码内 inject | **缺 layout**（现为 ['slots','locale']） | src/client/entry.tsx:16 |
| package.json 的 dsh.client.inject | **缺 @deepseek-ai/dsh-client-ui-layout**（现为 locale + sidebar） | package.json:38-41 |

所以要补的就两行（外加类型声明别漏）：

1. src/client/entry.tsx：export const inject = ['slots', 'locale', 'layout'] as const，并在 SlotContext
   里加可选 get?(name: string): unknown（现在这行是 as unknown as 强转绕过去的，补上就不用绕）。
2. package.json：dsh.client.inject 追加 @deepseek-ai/dsh-client-ui-layout。

顺带（可选，成本很小）：src/host/diagnostics.ts 已经有 slots.inject / slots.register / locale.bind /
locale.register 四条探针（:150-200 一带），照同样格式加一条 layout.selectPanel（required: false，
fallback: 'the back button does nothing'），诊断页就能自己暴露这个缺口。

---

## 3. 值得抄给 hub 的 15 条（价值 / 工作量 / 证据 / 抄还是重写）

工作量口径：**S** ≤ 半天且单文件；**M** 1–2 天或多文件；**L** > 2 天或需要新数据面。
「抄」= 语义与实现几乎可以照搬；「重写」= 语义值得要，但代码要按我们的分层重做。

| # | 特性 | 价值 | 量 | 证据 | 处置 | 落点 |
|---|---|---|---|---|---|---|
| R1 | **受管块扫描 + 插入点避让**：识别 begin/end 与 id 前缀，新行只插块外 | 高（不然会踩别人的块） | S | patch-editor.js:164-217、:357-389；我们已有 patch-blocks.ts:45-102 | 已重写，补两条：标记缩进→拒写、未闭合块→拒写并告警 | src/core/patch-blocks.ts |
| R2 | **外来行双侧可见化**：「别人的行在块里」与「自己的行被塞进别人 insert」分开报 | 高（ADR-0003 的整个由来就是「改了不显示」） | S/M | client.js:4758-4772；wire.js:64-77；gateway.js:166-168 | 抄语义，重写文案（我们的提示体系不同） | src/host/snapshot.ts + src/client/views/mcp.tsx |
| R3 | **「移出受管块」动作 + 一堆保守放弃条件** | 中高（把提醒变成可解决） | M | patch-editor.js:357-389、:394-404；gateway.js:363-366；client.js:4775-4789 | 重写（我们走 commitPatch） | src/domains/mcp.ts 新 op |
| R4 | **「查看机制」内联说明**（为什么会在块里／留在里面为什么没影响／为什么永不改写） | 中（省掉一整类工单） | S | client.js:3738-3742 | 抄结构，文案照我们口吻 | MCP 视图底部 |
| R5 | **归属必须双判据**（id 前缀 + 插件名），且知道「前缀不是充分条件」 | 高（防误判） | S | patch-editor.js:131-133、:223-231、:4-9；gateway.js:166-167 | 抄结论，改 patch-blocks.ts 的注释与告警措辞 | src/core/patch-blocks.ts:16-21 |
| R6 | **!!js 表达式保护**：读时往返、写时拒绝对表达式动刀 | 高（会毁用户令牌/开关） | S | patch-editor.js:29-51、:677-685；我们曾缺口，已修 lib/patch-rows.js:295-301 | 抄判据（已落），剩 UI 侧禁用开关 | lib/patch-rows.js + MCP 视图 |
| R7 | **注释归属边界**：跨度算到内容末，不吞下一行的说明注释 | 高 | S | patch-editor.js:460-465（nodeContentEndOf 注释）、:136-149 | 抄思想，补测试（我们 rowEnd 只排除尾部空行） | lib/patch-rows.js:156-168 |
| R8 | **重复 id/serverName：只拒新增，允许修既有；双键定位；CLI 与 GUI 给不同处置提示** | 高（静默改错行是最坏的一类） | S/M | patch-editor.js:558-579、:581-611；mcp/rows.js:18-49；我们已修 :278-282 | 抄判据（已落），剩报错文案与出口 | lib/patch-rows.js + CLI |
| R9 | **原文编辑不许改位置**：缩进与 insert 成员身份写回后必须一致 | 中高（append ↔ override 语义会变） | S | patch-editor.js:780-814 | 抄判据 | src/domains/mcp.ts 的 mcp.rawSave |
| R10 | **空文件 / [] 模板 / 空块收尾** | 中（写坏一次就是一屏红） | S | patch-editor.js:287-294、:298-305、:617-648；我们 mcp.ts:201-206 空文件返回空串 | 抄 | src/domains/mcp.ts |
| R11 | **Windows rename 重试**（EPERM/EEXIST/EACCES，退避 6 次）+ fsync best-effort | 中高（杀软/索引器会锁文件） | S | fs-utils.js:6、:32-55；我们 mcp.ts:468-473 无重试、无 fsync | 抄（补进 core/atomic.ts:66-85） | src/core/atomic.ts |
| R12 | **单卡兜底**：一张卡渲染炸了不能连累外壳与返回按钮 | 高（面板史上被这个教过） | S | client.js:5490-5511（注释点名 PR #87 现场）、i18n :3668-3671 | 重写：用 class 错误边界包视图（我们卡片是 hooks 组件，try/catch 不适用） | src/client/shell.tsx |
| R13 | **更新检查状态机**（idle/checking/available/updating/done/error + 按钮四态） | 中（我们完全没有） | M | client.js:5893-5900、:6039-6048；lib/updater.js:25-45,116；lib/version.js:51,120,125 | 先只做「检查 + 提示」，不自动装 | 新 src/host/updates.ts |
| R14 | **CLI 与 GUI 共用同一套写盘器**（CLI 直接 import patch-editor，不另写一份） | 中（两条入口不会各写一套） | S | cli-mcp.js:30-38 | 照做：确认 bin/dsh-tool-hub.mjs 只走 domains，不自己拼 YAML | bin/ |
| R15 | **双面插槽契约**：main.key 必须等于侧栏行 id，否则宿主抛错 | 中（我们已做对，缺断言） | S | client.js:6188-6201；我们 entry.tsx:58-62, 92 | 已有，补探针断言 | probe/next/client-shell.mjs |

### 3.1 明确「不要抄」的四项（我们已经等强或更强）

| 项 | 我们更强的地方 | 坐标 |
|---|---|---|
| 跨进程锁 | token 校验 + pid 存活判定 + rename-aside 破锁 + 宽限期 | src/core/atomic.ts:144-243 |
| 写后校验/回滚 | 备份 → 写 → verifyWritten → 失败回滚 | src/domains/mcp.ts:702-785 |
| 密钥只写不读 | maskConfigSecrets，env/headers 只回键名、留空保留原值 | src/domains/mcp.ts:503, 559 |
| 分组不入 patch | 面板把分组存 <dshHome>/skills/.system/skill-viewer/mcp-groups.json；我们同理 | lib/mcp/groups.js:1-16 |

---

## 4. hub 的补丁写入安全规则（W1–W13）

这些不是「最佳实践」，每一条都对应面板踩过的坑或我们代码里能被证伪的缺口；括号里给出处。

**W1 只写自己创建的行。** 别人块内的行一律只读，即使它长得像我们的也不认领。（面板 :192-193 的
「混成员整条不认领」是同一原则的另一面。）

**W2 新行只插块外，插入后要断言。** 两个落点都合法：追加到文件末尾（实测：块在尾部且闭合时，行落在
end 标记之后 = 块外）、或插在第一个 begin 行之前（面板疏散外来行也放这里，patch-editor.js:386-388）。
**禁止**的是落进 begin..end 之间。判据别靠「追加还是前插」猜，插入后用 scanPatchBlocks 断言行不在任何
块内（patch-blocks.ts:45-85）。**另两条硬条件**：标记行有缩进 → 这个文件不写（块可能嵌在别的结构里，
面板同样拒搬，:362-364）；begin 没有配对的 end → 不写并告警（patch-blocks.ts:36-43 已记录 unclosed）。

**W3 绝不整体重建别人的块。** 这是 #46 的原样复现路径：面板自己重写块曾把 dsh-market 的更新全部回滚
（patch-editor.js:8-9、README.md:284）。我们的写入从不重建块（setRowDisabled 只改一行、appendMcpRow 只是
追加、groups.ts 走 insertOutsideBlocks），这条守住了。**要守的是别为了「整理文件」去重排块内结构**，
也别去删别人的空壳（真实文件那几个 - insert: 就是历史遗骸）。

**W4 单行修改只换字节跨度，跨度算到「内容末」，不含尾随注释。** 面板专门为这个写了 nodeContentEndOf
（patch-editor.js:460-465），因为 yaml 的 range[2] 会把下一条的说明注释算进来。我们的 rowEnd
（lib/patch-rows.js:156-168）只排除了尾部空行，缩进到 key 列的注释会被一起吃进删除跨度 —— 补测试再改。

**W5 !!js 一律不写。** disabled: !!js '…' 由宿主求值，任何 true/false 改写都是把表达式毁成字面量。
面板的处理是**抛错**并叫人用原文编辑（patch-editor.js:677-685）。我们的 rewriteDisabled 现在同样先判
!!js / {{ 并在命中时抛 code: 'js-expression'（lib/patch-rows.js:295-301，本次研究期间已修）。**剩下的活是 UI**：
拿到这个 code 就禁用开关并标「由表达式控制」（面板同款做法）。回归测试：改一次 !!js 行必须仍抛。

**W6 定位必须唯一。** 同一 id/serverName 出现多条时：报错 + 给处置建议，不许静默挑一条。面板用
serverName + entryId 双键，命中多条时按入口给不同提示（CLI 让加 --id，GUI 让从卡片进）
（patch-editor.js:558-579、mcp/rows.js:18-49）。pickRow 现在命中多条即抛 duplicate-row 并列出全部行号
（lib/patch-rows.js:278-282，本次研究期间已修）。**剩下的活是报错文案与出口**：CLI 提示加 --id、GUI 提示
从卡片进入（对照 mcp/rows.js:18-49 的两套提示）。

**W7 重复判定只看「新增」。** 文件里本来就有重名不算错（用户可以一条条修），只有写完之后比写之前**更多**
才拒绝（patch-editor.js:600-611）。

**W8 原文编辑保位。** 写回后必须校验：缩进不变、insert 成员身份不变，否则拒绝并说明
（patch-editor.js:780-814）。我们 mcp.rawSave（src/domains/mcp.ts:951-980）现在只校验「一条、是 MCP 行、
从 - id: 开始」。

**W9 写盘必过「合法顶层数组」这一关。** 写前 assertPatchText，写后也要；空文件/只剩注释 → 补 []
（patch-editor.js:287-294, 637-648）。我们 finishDocument（src/domains/mcp.ts:201-206）在删掉最后一行时
返回空串 —— 空文件是 YAML null 不是数组，至少面板的 readManagedBlock 会认为「没有块」。建议对齐成 []。

**W10 换行符跟着文件走。** eolOf（patch-editor.js:502-505）—— CRLF 文件不能被掺进 LF 行。我们
splitDocument/finishDocument 已记 eol，但 appendMcpRow 拼的是裸换行行数组，靠 finishDocument 的 join 还原
—— 补一条 CRLF 的测试。

**W11 锁内重读，绝不用锁外快照写。** 面板每个写操作都在 withPatchLock 里重新 readPatchFile
（patch-editor.js:394-404、:409-417）；我们的 mcp.rawSave 注释也明确这么做了（src/domains/mcp.ts:968-971）。
保持一致，别在锁外算好再进锁。

**W12 与面板共用同一个锁文件。** 我们已经是 <patch>.panel.lock（src/domains/mcp.ts:645-652，理由写在
lib/index.js:1594-1607）。**不要改锁名**，也不要加第二把锁（两把锁等于没有锁）。

**W13 提醒不得静默，也不得假装已修。** 外来行必须能看见（wire.js:68-71 的注释就是这条的出处）；
「移出块」这类动作只在真的写盘成功后才清提示（client.js:4775-4789 用返回的 moved 决定文案）。我们
noteWrite / warn 已有类似结构，沿用。

### 4.1 实测记录（2026-11-21，node 直接跑 lib/ 里的真实函数）

用一段「块在尾部」的 patch 与三组输入实测；结论替换掉了本报告初稿里一条错的推断（原写「追加会落进块里」）。

| 用例 | 输入 | 实测结果 | 结论 |
|---|---|---|---|
| A 追加落点 | 文件 = [web 行, begin, insert + panel-mcp-github, end, 换行] | 新行落在第 11 行，end 在第 10 行；面板 readManagedBlock 只认领 [panel-mcp-github]，foreign 为空 | **追加到末尾 = 块外**，不会落进别人的块 |
| B 块后有内容 | 同上，end 之后再放一行注释 | 新行第 12 行，end 仍第 10 行 | 同上，仍块外 |
| C !!js 表达式 | 一行 disabled: !!js 表达式 | 输出 disabled: true，表达式里的 process.env.X 消失 | **表达式被毁** → W5 必修 |
| D 重复 id | 两行同 id、不同 name | setRowDisabled 改的是后一条（第 5 行），前一条未动，无报错 | **静默改错行** → W6 必修 |

复现脚本放在 %TEMP%/panel-probe.mjs（临时文件，不随仓库提交）。

---

## 5. 两个面板同写一份 patch：交互矩阵

| 事件 | 面板的动作 | 我们的动作 | 结果 / 风险 |
|---|---|---|---|
| 我们新建 MCP 行 | 不会把它收进块：它在 end 标记之后，块替换范围不含它（实测） | 追加到文件末尾 | 安全：行留在块外，面板既不认领也不搬。行号随块重写漂移 → 必须按 id 重定位（我们已按 id） |
| 我们新建非 MCP 行（如插件行） | 块外的不归它管；只有落进块内才会被当外来 top 提示并可被搬走 | groups.ts 走 insertOutsideBlocks（插 begin 前） | 安全，不会制造别人的告警。若哪条路径退回 append 且 begin 未闭合，就变成面板 UI 里的「有 N 条不属于面板的行」 |
| 面板整体重建块 | 只换块内字节，块外逐字节保留 | 只改单行 | 安全；前提是我们不动块内别人的行 |
| 我们删块内面板行 | 块少一行；- insert: 若变空，成为外来 top | 只删行 | 空 - insert: 壳会留下（真实文件 23-26 行就是历史遗骸）→ 我们别去清，也别在它旁边插行 |
| 两边同时写 | 抢同一把 <patch>.panel.lock | 抢同一把 | 串行化成立；谁后写谁看到对方的结果（都锁内重读） |

---

## 6. 需要 lead 拍板的三件事

1. **MCP 页要不要显示「本 profile 装了 dsh-skill-mcp-panel，它的行由它管理」？** 我们已经有检测
   （lib/index.js:1594-1607 的 panelOf），加一行提示成本 S，但会改变 MCP 页信息密度。
2. **「移出受管块」要不要做？** 它是**写操作**（改别人的文件区），按我们的分级要么做成显式按钮 + 二次
   确认，要么只做「查看机制」不做疏散（R3 vs R4）。面板的做法是显式按钮 + 每次只在成功写盘后清提示。
3. **更新检查要不要做？** 面板是「检查 + 原地 dsh plugin add」（lib/updater.js:116），我们连检查都没有；
   建议先只做检查与提示（M），自动装留到后面（L，且要处理 npm/GitHub 双渠道，见 updater.js:25-45）。

---

## 7. 坐标索引（本报告引用过的位置）

**面板（C:/Users/fenri/.dsh/profiles/sandbox/node_modules/dsh-skill-mcp-panel/）**

| 主题 | 位置 |
|---|---|
| 受管块设计说明（文件头） | lib/patch-editor.js:1-12 |
| 标记 / 前缀 / 插件名常量 | lib/patch-editor.js:16-19 |
| !!js 自定义标签 | lib/patch-editor.js:20-55 |
| 行归属判据 | lib/patch-editor.js:124-133 |
| 块内跨度铺满 | lib/patch-editor.js:136-149 |
| 读块 | lib/patch-editor.js:160-221 |
| 生成块 | lib/patch-editor.js:232-270 |
| 替换块 | lib/patch-editor.js:271-308 |
| 写锁 | lib/patch-editor.js:310-346 |
| 疏散外来行 | lib/patch-editor.js:347-404 |
| 就地开关 + !!js 拒绝 | lib/patch-editor.js:649-742 |
| 原文读取/替换/保位 | lib/patch-editor.js:743-823 |
| 删除 + 空块收尾 | lib/patch-editor.js:824-884 |
| 原子写 + rename 重试 | lib/fs-utils.js:28-55 |
| MCP 列表 + foreign 上抛 | lib/mcp/gateway.js:159-181、:359-366 |
| wire 契约 | lib/mcp/wire.js:60-82、:94-104、:355-365 |
| 行定位（双键 + 分入口提示） | lib/mcp/rows.js:10-49 |
| CLI 外来行提示 | lib/cli-mcp.js:39-45 |
| GUI 外来行提示 / 疏散 / 机制说明 | lib/client.js:3729-3742、:4758-4789 |
| 返回按钮 | lib/client.js:5854-5878、:6127-6137 |
| 页面骨架 / 槽位 / inject | lib/client.js:6026-6058、:6184-6201 |
| 单卡兜底 | lib/client.js:5490-5511 |
| 更新状态机 + 执行器 | lib/client.js:5893-5900；lib/updater.js:25-45,116；lib/version.js:51,120,125 |
| 分组存盘（不入 patch） | lib/mcp/groups.js:1-16 |
| 宿主侧 inject 声明 | package.json:27-36 |

**hub（本仓库）**

| 主题 | 位置 |
|---|---|
| 客户端 inject | src/client/entry.tsx:16 |
| 返回会话接线 | src/client/entry.tsx:64-76, 89；src/client/shell.tsx:310-314 |
| 三面插槽注册 | src/client/entry.tsx:58-62, 90-95 |
| 宿主 inject 声明 | package.json:35-46 |
| 受管块扫描 / 块外插入（新） | src/core/patch-blocks.ts:16-21, 45-85, 91-102 |
| 行解析 / 开关 / 删除 | lib/patch-rows.js:198-268, 282-334, 342-347 |
| 重复 id 已改为报错（duplicate-row） | lib/patch-rows.js:278-282 |
| 追加 MCP 行到末尾 | src/domains/mcp.ts:429-440 |
| 写盘 / 备份 / 校验回滚 | src/domains/mcp.ts:468-486, 702-785 |
| 锁（共用面板锁名） | src/domains/mcp.ts:645-652；src/core/atomic.ts:66-85, 230-243 |
| 与面板的兼容说明 | lib/index.js:1594-1607 |
| 诊断探针格式 | src/host/diagnostics.ts:150-200 |
| 真实 patch 文件（四个空 insert） | ~/.dsh/profiles/sandbox/cordis.patch.yml:23-26 |
