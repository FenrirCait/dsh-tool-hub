# hello-extension —— 最小本地扩展示例

这是 dsh-tool-hub 2.0 的扩展示例，跑通「发现 → 启用 → 读视图 → 写 op」全流程。
契约全文见 [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md)，实现真源是 src/host/extensions.ts。

## 文件

| 文件 | 作用 |
|---|---|
| manifest.json | 清单：id=hello、apiVersion=1、host=host.mjs、一个表格视图 |
| host.mjs | 宿主入口：export default (api) => ({ module, handlers }) |
| README.md | 本文件 |

## 声明了什么

| op | 类型 | 载荷 | 返回 |
|---|---|---|---|
| hello.status | 读（write:false） | 忽略，面板传 {} | 记录数组，一行一个事实 |
| hello.echo | 写（write:true，audit） | 任意 JSON | 原样返回载荷 |

| 视图 | kind | 绑定 |
|---|---|---|
| status | table | hello.status |

hello.status 返回形如 [{ key: 'extension', value: 'hello' }, ...] 的记录数组，表格视图按记录键生成列。

## 装到哪

| 位置 | 路径 |
|---|---|
| profile 私有（优先） | <stateDir>/extensions/hello-extension/ ，默认 ~/.dsh/tool-hub/extensions/hello-extension/ |
| 所有 profile 共享 | ~/.dsh/tool-hub/extensions/hello-extension/ |

~~~bash
mkdir -p ~/.dsh/tool-hub/extensions
cp -r examples/hello-extension ~/.dsh/tool-hub/extensions/
~~~

Windows（默认 home）：把文件夹复制到 C:\Users\<你>\.dsh\tool-hub\extensions\hello-extension\

## 启用

面板「扩展」页：该行点「启用」。
或直接发 op：

~~~json
{ "op": "extension.set", "payload": { "id": "hello", "enabled": true } }
~~~

启用会即时重建 runtime，不需要重启 DSH。停用后 hello.* 立刻变成 unknown op。

## 看到的应该是

- 快照 snapshot.extensions 里一行 hello：enabled=true、loaded=true、ops 两个、views 一个。
- 视图 status 点「读取」：表格八行（extension / apiVersion / folder / enabledExtensions / platform / node / pid / servedAt）。
- 操作台选 hello.echo，载荷 {"msg":"hi"}：先弹确认，确认后结果区原样显示 {"msg":"hi"}，history 里多一行 audit 记录。
- 改 host.mjs 后发 extension.reload { "id": "hello" }，新的返回立刻生效（缓存键是入口文件的 mtime+size）。

## 改这个示例

1. 改 op 就要同时改两处：module.ops 里的声明与 handlers 里的同名函数；少一个多一个都加载失败。
2. 新增 op 必须留在 hello. 前缀下（命名空间规则）。
3. 视图只能指向本扩展的读 op；指向写 op 会在加载期被拒。
