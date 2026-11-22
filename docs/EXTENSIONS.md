# 本地扩展契约（2.0 · apiVersion 1）

本文是 dsh-tool-hub 2.0 本地扩展的契约：怎么放、怎么声明、怎么加载、怎么热启用。
实现真源是 [src/host/extensions.ts](../src/host/extensions.ts)（发现、校验、装载、命名空间规则）与
[src/host/index.ts](../src/host/index.ts)（`extension.*` 三个内建 op、重建流程）；
两者与本文冲突时以实现为准，并回来改本文。`apiVersion` 常量 = `1`。

一句话：扩展 = 一个文件夹 + `manifest.json` + 一个 ESM 宿主入口。它只能在自己的 id 命名空间下
增加 op 与设置项；不能替换内建 op、不能加面板槽位、不能访问别的扩展。

## 0. 安全边界（先读）

- 扩展与宿主**同进程**运行，拥有宿主进程的全部权限：任意本机文件读写、网络请求、子进程。没有沙箱、
  没有权限声明、没有能力清单。
- 「被发现」不等于「会执行」：只有状态为 enabled 的扩展才会被 import。**「启用」就等于「执行」**。
- 只启用你自己写的、或逐行读过的代码。来源不明的目录不要放进扩展根。
- 面板在扩展页固定显示同一句提示（i18n 键 `extensions.local`：本地扩展是受信代码，拥有本机文件访问权限）。
- v1 没有签名、没有来源校验、没有依赖声明。信任判断只能靠你。

## 1. 目录与安装位置

~~~text
<扩展根>/
  hello-extension/      # 一个子目录一个扩展；目录名只用于发现与状态行，id 取自 manifest
    manifest.json       # 清单，≤ 64 KB
    host.mjs            # 宿主入口（manifest.host 指向的相对路径）
    README.md           # 你自己的说明（可选）
~~~

扩展根有两个，按顺序发现，先命中的优先：

| 顺序 | 位置 | 说明 |
|---|---|---|
| 1 | `<stateDir>/extensions` | 当前 profile 私有。`stateDir` = state.json 所在目录，通常是 `<DSH_HOME>/tool-hub` |
| 2 | `~/.dsh/tool-hub/extensions` | 所有 profile 共享 |

- `stateDir` 的解析：设了 `TOOL_HUB_STATE_FILE` 时取该文件的目录；否则 `<DSH_HOME>/tool-hub`，
  `DSH_HOME` 缺省 `~/.dsh`。所以 profile 隔离的实例装到 `<profile>/tool-hub/extensions`，真机装到
  `~/.dsh/tool-hub/extensions`。
- 两个根在默认情况下是**同一个路径**（`stateDir` 就是 `~/.dsh/tool-hub`），加载器会去重，不会重复发现。
- 同一 id 在两个根都存在：第一个根（profile）的那份生效，共享根里的那份被静默忽略，不报错。
- 点开头的子目录跳过；非目录条目跳过；读不了的根跳过。这些都不影响宿主启动。
- 清单上限 64 KB，超了这条扩展直接变成失败状态行。

Windows 默认布局：`C:\Users\<你>\.dsh\tool-hub\extensions\hello-extension\`

## 2. manifest.json

| 字段 | 必填 | 规则（不满足的后果） |
|---|---|---|
| id | 是 | 匹配 `^[a-z0-9][a-z0-9_-]{0,31}$`（最长 32 字符）；不能是保留 id（见 §4）。这就是命名空间 |
| name | 是 | `{ zh, en }` 两个都非空，否则 `name needs zh and en` |
| version | 是 | 非空字符串；不做 semver 校验，仅展示 |
| apiVersion | 是 | 必须**严格等于数字 1**；`2` / `"1"` 都被拒：`apiVersion must be 1` |
| description | 否 | `{ zh, en }`；只用于展示 |
| host | 是 | 相对路径；不许绝对路径、不许含 `..`；指向的文件必须存在且是文件 |
| views | 否 | 必须是数组（否则整份清单失效）；元素规则见 §5 |

最小清单（本仓库示例的真身）：

~~~json
{
  "id": "hello",
  "name": { "zh": "问候示例", "en": "Hello example" },
  "version": "1.0.0",
  "apiVersion": 1,
  "host": "host.mjs",
  "views": [
    {
      "id": "status",
      "title": { "zh": "问候状态", "en": "Hello status" },
      "kind": "table",
      "op": "hello.status"
    }
  ]
}
~~~

校验是严格的，任何一条不符都会让这条扩展变成 `loaded:false` 的状态行，`error` 写明哪个字段错了
（错误原文见 §10），宿主继续启动、其它扩展照常。清单只声明「我有什么」，代码在宿主入口里。

## 3. 宿主入口

~~~js
export default (api) => ({ module, handlers })
~~~

默认导出必须是函数（同步或 async 都行）：加载器 import 这个文件，把 `api` 传进去，拿回
`{ module, handlers }`。返回别的东西会在加载期失败。

### 3.1 传进来的 `api`

| 字段 | 类型 | 含义 |
|---|---|---|
| version | number | 当前 API 版本，恒为 1 |
| id | string | 你的扩展 id（来自 manifest） |
| dir | string | 扩展目录的绝对路径 |
| log | (level, message) => void | `level` 为 `'info'` / `'warn'`；warn 会进宿主日志 |
| services.get | (name) => unknown | 取宿主服务，先判函数再调；缺席时降级，别抛 |

### 3.2 返回的 `module`

| 字段 | 必填 | 说明 |
|---|---|---|
| id | 是 | **必须等于 manifest.id**，否则 `module id "x" must equal the extension id` |
| title | 否 | `{ zh, en }`；缺省用 manifest 的 name |
| ops | 是 | 数组。每项 `{ id, write, audit?, note? }`；`write` 必须是布尔 |
| settings | 否 | SettingsField 数组，见 §8。面板槽位（panels）**不会**被透传 |

### 3.3 返回的 `handlers`

- 键集合必须与 `module.ops` 的 id 集合**完全一致**：少一个 → `op hello.x has no handler`；
  多一个 → `handler for undeclared op hello.x`；非函数 → `handler for hello.x is not a function`。
- 签名：`async (payload, env) => unknown`。返回值就是 op 结果，原样进入 HTTP 信封
  `{ ok: true, data }`；抛错则是 `{ ok: false, error: { code: "internal", message } }`
  （v1 的扩展无法自定义错误码，只有内建 `Failure` 才有稳定 code）。
- `payload` 是客户端发来的任意 JSON，可能为 `{}`、`undefined` 或任何形状——**自己校验**。

### 3.4 `env`（每个 handler 都收到）

| 字段 | 说明 |
|---|---|
| state | 活的状态文档。**约定只读**：宿主不会替你保存它，改它等于直接改宿主内存里的状态 |
| services.get | 同 `api.services.get` |
| save(reason) | 走宿主的保存路径（备份 + 跨进程锁 + 原子写），写的是整份 state；返回备份路径或 null |
| log(level, message) | 同 `api.log` |
| now() | 宿主时钟（毫秒）。用它，不要自取 Date.now()，行为才可复现 |

### 3.5 骨架

~~~js
export default function activate(api) {
  return {
    module: {
      id: 'hello',
      title: { zh: '问候示例', en: 'Hello example' },
      ops: [
        { id: 'hello.status', write: false, audit: false, note: 'One row per fact.' },
        { id: 'hello.echo', write: true, audit: true, note: 'Returns the payload unchanged.' },
      ],
    },
    handlers: {
      'hello.status': async (_payload, env) => [{ key: 'extension', value: api.id }],
      'hello.echo': async payload => payload,
    },
  }
}
~~~

完整可运行版本见 [examples/hello-extension/host.mjs](../examples/hello-extension/host.mjs)。

## 4. 命名空间规则

- 每个 op id 必须以 `<扩展 id>.` 为严格前缀：`hello.status` 合法，`other.status` 触发
  `op "other.status" must start with "hello."`。
- `module.id` 必须等于 manifest 的 `id`。
- 同一扩展内 op id 不得重复（`duplicate op hello.status`），跨扩展与内建也不得重复。
- **不能替换或覆盖内建 op**：撞名（例如内建的 `extension.set`）会让该扩展整条加载失败
  （`duplicate op id: extension.set`），宿主其余部分不受影响。
- 保留 id（不能用作扩展 id）：
  `core`、`extensions`、`plugins`、`skills`、`mcp`、`groups`、`presets`、
  `scenes`、`sessions`、`settings`、`tool-surface`、`config`。
- `extension` 不在保留名单里，但内建 op 叫 `extension.list` / `extension.set` / `extension.reload`，
  所以用 `extension` 当 id 再声明同名 op 必然撞车。
- 还有第二道闸：注册通过后仍要进 Registry。重复 module id / op id 在那里抛错，同样落到
  `status.error`，并把该模块从注册表移除——不会留下「声明了但没 handler」的半绑定状态。

官方兼容包不随主包分发，放在独立仓库（默认 `FenrirCait/dsh-tool-hub-packs`）。扩展页的「官方配套」卡片通过 `compat.index` 读取索引，`compat.install` 下载并逐文件校验 SHA-256 后安装；索引地址、镜像和缓存时间在设置里配置。包内 `compat/` 目录已移除。

## 5. 样式（styles）

`styles` 可选，是相对扩展目录的 CSS 文件数组（最多 8 个，单个 ≤256 KB，必须是 `.css`，
不允许绝对路径或 `..`）：

```json
{
  "host": "host.mjs",
  "styles": ["style.css"]
}
```

- 扩展**启用并加载成功**后，宿主读取 CSS 文本，随 `extension.list` / 快照下发；面板为每个扩展注入一个
  `<style data-extension-style="<id>">`，禁用或卸载时移除。
- CSS 是**文档级**的（扩展是受信任的本地代码），作者必须自己把选择器限定在本插件表面，例如
  `.th-root`、`.th-dock-btn`、`.th-sidebar-entry`；不要写裸 `body` / `*`。
- 修改 CSS 后调用 `extension.reload` 即可生效，不需要重启宿主；加载键包含 CSS 的 mtime/size，缓存会自动失效。
- 读取失败、文件不存在或超过体积上限时，该扩展作为一条带 `error` 的状态行，不会影响其它扩展。

## 6. 视图（views）

视图在 manifest 里声明，把一个**本扩展的读 op**接到面板上。

| 字段 | 必填 | 规则 |
|---|---|---|
| id | 否 | 不合法会回落成 `view1`、`view2`…；同 id 重复的后者丢弃 |
| title | 否 | `{ zh, en }`；缺省回落成 id |
| kind | 否 | `table` / `list` / `json`；非法值按 `json` |
| op | 是 | 必须是本扩展声明过的 op，且必须是**读 op**（`write:false`）。指向写 op 加载期就拒：`view "x" must point at a read op` |

面板行为（v1 契约，与面板实现一致）：

- 每个视图一个「读取」按钮；点击 = `runOp(view.op, {})`，读 op 收到的载荷是空对象 `{}`，
  不是 `undefined`。读 handler 要能吃 `{}`。
- **kind: table**：读 op 必须返回**裸的记录数组**，即 `Array<Record<string, unknown>>`。
  - 列 = 记录键的并集，按首次出现顺序；表头就是键名。
  - 单元格：原始类型按 `String(value)`；对象 / 数组按紧凑 JSON 显示，超过 160 字符截断。
  - 返回空数组 = 空态（`extensions.viewEmpty`）。
  - 其它形状（包括 `{ rows: [...] }` 这类包装对象、位置数组）不属于契约：面板可能容错渲染，
    也可能显示原始载荷的 JSON 框；不要依赖。面板不会因此报错，也不会白屏。
- **kind: list**：返回数组。字符串逐条列出；记录按字段展开。
- **kind: json**：任意 JSON，格式化显示。
- 停用的扩展仍会把自己的 views 列在状态行里（来自 manifest），但它的 op 没有注册，点读取会得到
  `unknown op` —— 先启用再读。

## 6. op console（操作台）

面板里每个扩展一个操作台，用来在不上模型、不写脚本的情况下打一发 op：

- 列出该扩展声明的全部 op；写类（`write:true`）带标记。
- 载荷是一个 JSON 文本框。不是合法 JSON 时面板拒绝发送并提示 `extensions.invalidJson`。
- 点「运行」走 `runDetailed(op, payload)`，宿主回执原样显示在结果区（不只看 ok/失败）。
- 写类 op：面板先弹确认对话框，确认后才发送；载荷是对象时会附 `confirm: true`（数组 / 原始值不加）。
- **重要的边界**：v1 的扩展 op **不能声明宿主级 confirm 门**——加载器只保留 `id / write / audit / note`，
  `confirm` 字段被丢弃。所以 `confirm:true` 只是客户端约定，真正的校验必须在 handler 里自己做。
- 操作台走的是分发器的 run 路径，每次调用都会在 `history.jsonl` 留一行（op、ok、audit、时间、短标识
  `id/name/kind/targetId/mode/state`）；载荷正文不落盘——这是有意的，别把凭据写进日志期望里。
  （模型侧的 `hub_tools` 走 execute 路径，不写历史；两条路径都不记录载荷。）
- 声明了 `audit: true` 的写 op，历史行会带 audit 标记；它不改变是否记录，只改变标记。

## 7. 热启用 / 停用 / 重载

三个内建 op 属于宿主模块 `extensions`（不是你的扩展）。面板在扩展页说明这件事（i18n 键
`extensions.hot`：启用或停用会即时重建运行时，无需重启宿主）。

| op | 类型 | 载荷 | 返回与行为 |
|---|---|---|---|
| `extension.list` | 读 | `{}` | `{ extensions: 状态行[], enabled: string[] }` |
| `extension.set` | 写（audit） | `{ id, enabled: boolean }` | 改 `state.extensions.enabled` → 保存 → 重建 runtime；返回 `{ enabled, extensions }` |
| `extension.reload` | 写（audit） | `{ id? }` | 丢缓存并重建；不带 id = 全部；返回 `{ extensions, reloaded }` |

- **启用**：把 id 写进 `state.extensions.enabled` 并立刻重建（registry + dispatcher + 状态表原子替换），
  不需要重启 DSH 进程。启用一个「发现不到」的 id 会失败：`missing-extension`。
- **停用**：从列表删掉并重建；它的 op 立刻变成 `unknown op`，视图读不到。
  停用一个未知 id 只是从列表删除，不报错（幂等）。
- 状态写入走宿主的保存路径（备份 + 锁 + 原子写），enabled 列表排序后落盘。
- **重载**：改完 `host.mjs` 调 `extension.reload { id }` 最稳。加载器的缓存键是入口文件的
  `mtime:size`，并以 `?v=<键>` 重新 import；只改内容不改时间戳的极端情况可能命中旧缓存，reload 会强制失效。
- `extension.reload` 传入不合法的 id 会被当成「没给 id」，也就是**重载全部**；要精确重载就传合法 id。
- 两个开关串行执行（一次只有一个重建在跑），并发点击不会交错。
- **失败隔离**：清单坏、import 抛错、命名空间违规、handler 缺失——都只是让这一行 `loaded:false` +
  `error`，宿主与其它扩展照常工作。一个坏扩展永远不是一个坏宿主。
- 状态行（也就是 `snapshot.extensions` 的元素）：

| 字段 | 说明 |
|---|---|
| id / name / version / apiVersion | 来自 manifest |
| dir | 扩展目录绝对路径（发现不到时为空串） |
| enabled | 是否在 `state.extensions.enabled` 里 |
| loaded | 代码是否真的装载成功 |
| error | 失败原因（截到 300 字符）；正常为 null |
| ops | 已注册的 op id 列表；未加载时为空 |
| views | 该扩展声明的视图（未加载时也来自 manifest） |

状态行按 id 排序。面板的启用 / 停用 / 重载按钮就是上面三个 op 的薄壳。

## 8. 设置

`module.settings` 可选，元素是 SettingsField：

| 字段 | 说明 |
|---|---|
| key | 键名；**自动加前缀** `<扩展 id>.`（已经以它开头的不重复加），例 `hello.sayHello` |
| type | `boolean` / `number` / `string` / `select` |
| default | 默认值，重建时补齐，不覆盖已有值 |
| label | `{ zh, en }` 必填 |
| hint | `{ zh, en }` 可选 |
| options | `select` 的选项 `[{ value, label: { zh, en } }]` |
| min / max | `number` 的夹取范围 |

- 值存在 `state.settings` 里，键是 `<id>.<key>`。
- 设置页按声明通用渲染（开关 / 数字 / 文本 / 下拉），扩展不用写任何 UI。
- 取值按声明强制：number 超界夹取、select 不在选项内回落默认、类型不符回落默认。
- 想让设置真的生效，就在 handler 里读 `env.state.settings['hello.sayHello']`，别自己缓存。

## 9. 示例：examples/hello-extension

| 文件 | 作用 |
|---|---|
| [manifest.json](../examples/hello-extension/manifest.json) | id `hello`、apiVersion 1、host `host.mjs`、一个 table 视图 |
| [host.mjs](../examples/hello-extension/host.mjs) | `export default (api) => ({ module, handlers })`，两个 op |
| [README.md](../examples/hello-extension/README.md) | 装、启用、验证步骤 |

| op | 类型 | 说明 |
|---|---|---|
| `hello.status` | 读 | 返回记录数组：extension / apiVersion / folder / enabledExtensions / platform / node / pid / servedAt |
| `hello.echo` | 写（audit） | 原样返回载荷，用来验证写路径与操作台回执 |

安装并启用（默认 home）：

~~~bash
mkdir -p ~/.dsh/tool-hub/extensions
cp -r examples/hello-extension ~/.dsh/tool-hub/extensions/
# 然后在面板「扩展」页启用，或发 op：
# extension.set  { "id": "hello", "enabled": true }
~~~

预期：快照 `extensions` 里一行 `hello`，enabled/loaded 都是 true，ops 两个，views 一个；
视图 status 点读取得到 8 行表格；操作台跑 `hello.echo` 得到原样载荷并留一行 audit 历史。

## 10. 错误对照表

状态行的 `error` 是这些原文（前缀 `manifest.json: ` / `host entry: ` 来自文件系统错误）：

| 原文（关键片段） | 原因 | 修法 |
|---|---|---|
| `manifest.json: ENOENT…` | 目录里没有 manifest.json | 补文件，注意大小写 |
| `manifest is larger than 64 KB` | 清单超限 | 精简清单 |
| `manifest.json is not JSON: …` | JSON 语法错（尾逗号、注释、BOM） | 用严格 JSON |
| `manifest must be a JSON object` | 顶层是数组 / 字符串 | 顶层写成对象 |
| `id must match ^[a-z0-9][a-z0-9_-]{0,31}$` | id 非法（大写、点、空格、超长） | 改 id |
| `id "core" is reserved` | 用了保留 id | 换 id，见 §4 |
| `name needs zh and en` | name 缺一半或为空 | 两种语言都写 |
| `version is required` | version 空 | 填版本号 |
| `apiVersion must be 1` | 写了 2 / "1" / 缺失 | 写数字 1 |
| `host must be a relative path inside the extension folder` | 绝对路径或含 `..` | 用同目录相对路径 |
| `views must be an array` | views 写成对象 | 写成数组 |
| `host entry: ENOENT…` | host 指向的文件不存在 | 核对文件名 |
| `host entry is not a file` | host 指向目录 | 指向文件 |
| `the host entry must default-export an activate(api) function` | 没有默认导出函数 | 补 `export default` |
| `activate() must return { module, handlers }` | 返回了别的东西 | 按 §3 返回 |
| `registration.module is missing` | 少 module | 补 module |
| `module id "x" must equal the extension id` | module.id ≠ manifest.id | 对齐 |
| `module.ops must be an array` | ops 不是数组 | 写成数组 |
| `registration.handlers must be an object` | handlers 不是对象 | 写成对象 |
| `every op needs a string id` | op 缺 id | 补 id |
| `op "x" must start with "hello."` | 越出命名空间 | 加前缀 |
| `duplicate op hello.status` | 同一扩展内重复 | 去重 |
| `op hello.status needs a boolean write` | write 缺失或非布尔 | 写 true / false |
| `handler for undeclared op hello.x` | handlers 多了一个 | 删或补声明 |
| `handler for hello.x is not a function` | 手写成了对象 / 字符串 | 写成函数 |
| `op hello.x has no handler` | 声明了没实现 | 补函数 |
| `view "x" points at undeclared op hello.y` | 视图指向没声明的 op | 对齐 |
| `view "x" must point at a read op` | 视图指向了写 op | 换读 op |
| `duplicate module id: hello` / `duplicate op id: hello.status` | Registry 层撞车（内建或别的扩展先占了） | 换 id |
| `extension folder not found` | enabled 列表里有这个 id，目录没了 | 放回目录或停用 |

## 11. v1 不提供

- **面板槽位**：`module.panels` 不会被透传，扩展不能加侧边栏 / 标签页 / 设置分区。
- **替换内建 op**、**跨扩展调用**：handlers 只看得见自己的 op。
- **宿主级 confirm 门**：`confirm` 字段被丢弃（见 §6），写类安全自己负责。
- **依赖声明、版本约束、签名校验、权限清单**：都没有，见 §0。
- **私有状态存储**：要持久化就自己写文件（放在自己的扩展目录旁或用宿主服务）；`env.state` 是宿主的文档。

## 12. 参考

| 文件 | 内容 |
|---|---|
| [src/host/extensions.ts](../src/host/extensions.ts) | 发现、manifest 校验、装载、命名空间与视图规则（本文真源） |
| [src/host/index.ts](../src/host/index.ts) | `extension.list/set/reload`、重建与失败隔离 |
| [src/host/dispatch.ts](../src/host/dispatch.ts) | op 分发、confirm 门、审计行 |
| [src/shared/types.ts](../src/shared/types.ts) | OpDefinition / SettingsField / DomainModule |
| [docs/MODULES.md](./MODULES.md) | 内建模块怎么写（同一 DomainModule 形状） |
| [docs/API.md](./API.md) | HTTP 信封与门禁 |
| [examples/hello-extension](../examples/hello-extension) | 可直接跑的示例 |
