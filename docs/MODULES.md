# 模块开发指南（2.0）

## 最小模块

~~~ts
import type { DomainRegistration } from '../shared/contract.js'

export function demoDomain(): DomainRegistration {
  return {
    module: {
      id: 'demo',
      title: { zh: '演示', en: 'Demo' },
      ops: [{ id: 'demo.echo', write: false, audit: false, note: 'Returns its payload.' }],
      settings: [{ key: 'demo.enabled', type: 'boolean', default: true, label: { zh: '启用演示', en: 'Enable demo' } }],
      panels: [{ slot: 'plugins.tab', id: 'demo', order: 50 }],
    },
    handlers: {
      'demo.echo': async payload => ({ echoed: payload }),
    },
  }
}
~~~

注册：在 src/domains/index.ts 的 registerAll(registry) 里追加一行。重复的模块 id 或 op id
会让启动直接失败——这是有意的，比运行时静默覆盖好。

## 约束

- 状态只经 env.state 读、env.save(reason) 写；不要自己碰 state.json。
- 宿主能力从 env.services.get(name) 取，先判函数再调；缺席时降级并在诊断里点名。
- 面板与设置都从 Registry 派生：设置字段由模块声明，客户端通用渲染，不写一次性表单。
- 每个 op 的错误用结构化结果（{ ok:false, code, message }）或抛带 code 的 Error，二者择一但全模块一致。

## 第三方扩展（第二阶段）

沿用同一 DomainModule 形状：manifest 声明 id、ops、panels、settings 与所需能力；
加载器只接受显式白名单目录、校验 manifest、拒绝重复 id。权限按能力项授予，
默认不给写类 op。
