[English](README.md) · **简体中文**

# dsh-tool-hub 工具总控台

一个面板，把一套 DSH 安装里真正在跑的**插件**和**技能**列出来：逐项开关、按分组整组开关、
把「当前开着的这一套」存成预设。入口有两个——插件页的**总控台**标签页，以及侧边栏独立面板。




## 为什么做

关一个插件通常要翻 profile 的 patch 文件，关一个技能要手改 `SKILL.md` 的文件名。而「写论文要哪
些、写代码要哪些」这类问题，每换一套配置就要重新想一遍。总控台把这件事变成一个带开关、分组和
预设的列表。

## 安装

```bash
dsh plugin install FenrirCait/dsh-tool-hub
# 或者本地目录
dsh plugin install ./dsh-tool-hub
```

装完打开**插件 → 总控台**，或侧边栏的**工具总控台**。不需要重启，插件热加载。

## 能做什么

- **一个列表**：loader 里的每一条 + 用户技能目录里的每个技能。每行写明类型、是否开启、不能开关
  的原因。随客户端一起装的行（`@deepseek-ai/*`、`cordis:*`）带**官方**标记，自带和第三方一眼分得开。
- **逐项开关**：插件走宿主自己的 pluginManager，写进 profile patch，与插件页写的是同一处；技能靠
  重命名 `SKILL.md` ↔ `SKILL.md.disabled`。
- **分组**：新建、改名、删除、把当前勾选加入分组，整组一键启停。成员超过 20 个先确认。
- **自动分组**：只给三个桶，不再猜——**官方**（随客户端一起装的）、**通用底座**（第三方的行，文字读起来像
  一层底座：上下文、记忆、市场、侧栏、运行时…）、**未排序**（其余全部，含技能）。主题词仍作为标签显示在
  组上，只用于提示，不再决定分组。应用时只替换上一次的自动分组（连旧分类遗留的也一并清掉），手建的不动。
- **左栏可塑形**：角色作为分段标题，每个组带着主题标签；左栏与列表之间的分隔条可拖动（180–460px，双击复位，
  宽度重启保留）；拖动组时插入线画在落点那一行上；↑ / ↓ 可以不用指针把组在同一节内上下移动。左栏按落盘
  顺序渲染，所以移动会保留。组内的行按「启用优先 → 插件 / MCP / 技能 → 名称」排。
- **预设**：把当前状态存成预设，之后一键应用。`应用`会打开预设列出的、关掉没列的；`只开启`不关
  任何东西。改动大时先确认。
- **MCP 服务器**：单独一栏，每行显示服务器名、传输方式与启动命令，开关与其它条目同一套机制；编辑
  对话框只改 profile 的 `cordis.patch.yml` 里那一条的 `config:` 块——只重写这条的字节，文件其余
  部分逐字保留，保存后由宿主自己的 HMR 监听热加载。对话框里的**测试连接**会按当前填的值（不论是否
  保存）临时起一次服务器，跑 initialize + tools/list，回报工具数量与耗时，然后结束进程——
  不注册任何工具，也不写文件。

- **MCP 工具级的屏蔽。** 每个 MCP 行都有一个「工具」按钮，列出该服务器的工具；取消勾选后，它会在
  **本安装的所有会话**里从模型可见的工具表中消失，而不只是界面上不显示。宿主只支持通过作用域的
  `tools.restrict` 做到这件事，所以面板会为每个 agent 挂一个极小的插件调用 `tools.restrict`/`undo`——
  并且只在可用集合真正变化时重施，否则每次 `tools/change` 都重施会把宿主拖进循环。屏蔽名单存在面板
  自己的状态里，绝不写进 MCP 服务器的 `config:`；若另一个面板也在屏蔽工具，两层同时生效（并集）。
- **从 dshmarket 导入分组。** `<profile>/.dsh-market/state.json` 里有分组时，顶栏会多一个导入按钮，
  把包名映射到实际安装的行并复制过来。同名分组跳过、不合并；未安装的包按组报告。该文件只读不写。

分组与预设全部只写一个文件：

```
<DSH_HOME>/tool-hub/state.json      # 默认 ~/.dsh/tool-hub/state.json
```

写入是原子的（临时文件 + rename），保存中途崩掉不会留下半截状态。

## 不做什么

- **MCP 只管宿主 MCP client 那三种形态**（stdio / sse / http）；服务器进程内部自己的事仍归它自己。
- **不扫描用户技能根之外的技能**：只看 `~/.dsh/skills` 与 `~/.agents/skills`。项目级
  `.dsh/skills` 属于某个工作区而不是某套安装，列进来会误导。
- **宿主托管的条目**（插件管理器本身、定时器、工具注册表等）会显示但不可开关。宿主把它们标成
  `management-required` 或 `unaddressable`，行内直接说明，而不是藏起来。
- **没有终端界面**：这是 Web / Desktop 扩展。

## 开关到底改了什么

| 类型 | 机制 | 落在哪 |
| --- | --- | --- |
| 插件 | `pluginManager.setPluginEnabled(entryId, enabled)` | profile 的 patch 文件 |
| 技能 | 重命名 `SKILL.md` → `SKILL.md.disabled`（可逆） | 技能目录 |

两者都能从同一行改回来。插件开关可能返回 `restart-required`、`overridden`、`failed`，面板照实
报告宿主的回答，不假定成功。

### 在一次性 profile 里试

默认情况下分组和预设存在 `<DSH_HOME>/tool-hub/state.json`，技能开关落在 `<DSH_HOME>/skills` 与
`~/.agents/skills`。测试 profile 通常两边都不想要，两个环境变量可以把它们指到无害的地方：

```bash
TOOL_HUB_STATE_FILE=<目录>/tool-hub-state.json     # 分组、预设、自动分组记录
TOOL_HUB_SKILL_ROOTS=<目录>/skills;<目录>/skills2  # 技能根，Windows 下用 ; 分隔
```

两个都设上，沙盒里试「整组禁用」就只动沙盒。

## 开发

```
lib/index.js         宿主部分：snapshot、各类 op、HTTP 路由（/tool-hub/api/*）
client/client.js     客户端部分：一个手写的 ModuleLoader bundle，只依赖 React
locale/{zh,en}.json  插件页显示的元数据
cordis.patch.yml     bundle 的 insert
probe/host-smoke.mjs 26 条断言，跑在临时 DSH_HOME + 假 pluginManager 上
```

```bash
node --check lib/index.js
node --check client/client.js
node probe/host-smoke.mjs
```

HTTP 只有两条 exact 路由：`GET /tool-hub/api/snapshot` 与 `POST /tool-hub/api/op`，用与内置市场
同款同源校验。

## 许可

MIT
