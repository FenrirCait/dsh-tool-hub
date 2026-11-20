# dsh-tool-hub 2.0 架构

## 目标

把 1.x 的两块巨石（lib/index.js 3742 行、client/client.js 5088 行）换成可并行开发、
可被第三方扩展、且换宿主版本不整块挂掉的结构；功能与 1.1.0 对齐后再加新域。

## 分层

~~~text
src/shared/types.ts       宿主与客户端共用的词汇：CapabilitySpec / OpDefinition / DomainModule / SettingsField
src/core/                 registry、state schema + 迁移、原子写与跨进程锁、能力探测
src/host/                 cordis 接线、HTTP API（/api/v1）、op 分发、诊断
src/domains/              plugins / skills / mcp / groups / presets / scenes / sessions / tool-surface / lazy
src/client/               shell、views、components、settings、i18n、theme（TS/TSX → esbuild 单文件）
scripts/build-client.mjs  把客户端打成宿主契约要求的单文件
docs/                     架构、迁移、模块开发指南
~~~

## 模块契约

每个域是一个 DomainModule：id、title、ops、可选 panels 与 settings。
Registry.register 拒绝重复的模块 id 与 op id。宿主与客户端都从同一份注册表取数据，
所以“UI 不知道某个 op”或“设置项没被读”在启动时就会暴露，而不是在运行时静默失败。

第三方扩展点（第二阶段）沿用同一形状：模块清单 + 注册表 + 所需能力，不引入新的加载协议。

## 状态

state.json 升到 v2：version: 2，保留 1.x 的全部键（groups/collections/presets/toolDeny/
sessions/scenes/mode），新增 settings 与 modules。v1 → v2 是纯函数 migrate；写回前备份，
失败不改原文件。

## 兼容

- 包名、插件 id、市场条目不变；1.x 的 lib/index.js 保留到切换点。
- 宿主形态探测两种：本插件的 webServer exact 路由 + 自注册 slot；以及 typert/manifest 形态。
  缺哪个就降级并在诊断里点名，不抛。
- capabilities.ts 的每一项写清缺席后果；doctor 与设置页读同一份表。
- engines.dsh 与客户端 peer 版本同源，上界显式。

## 构建与切换

~~~bash
npm run build        # tsc 宿主 → dist/；esbuild 客户端 → dist/client.js
npm run typecheck    # 两侧类型检查，不产文件
~~~

切换点：2.0 通过 11 套探针 + state 迁移回归 + 沙盒走查后，package.json 的 main/exports
改指 dist/，lib/ 与旧 client/ 在一个版本内保留作回滚。
