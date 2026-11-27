import { pathToFileURL } from 'node:url'
const { SkillVisibilityRegistry } = await import(pathToFileURL('C:/Users/fenri/Documents/deepseek-harness/default-workspace/0006dfe4-工具总控台维护/dsh-tool-hub/dist/host/skill-visibility.js').href)
const activate = (await import(pathToFileURL('C:/Users/fenri/Documents/deepseek-harness/default-workspace/0006dfe4-工具总控台维护/dsh-tool-hub-packs/packs/deep-ptc-skill-compat/host.mjs').href)).default
const registry = new SkillVisibilityRegistry()
const api = { id: 'deep-ptc-skill-compat', services: { get: name => name === 'toolHub.skillVisibility' ? registry : name === 'webServer' ? { listenedPort: 1962 } : null }, onDispose: () => {} }
const out = activate(api)
const snapshot = await registry.snapshot()
console.log(JSON.stringify({ provider: snapshot.provider, available: snapshot.available, rows: snapshot.rows.length, hidden: snapshot.rows.filter(row => row.hidden).length, error: snapshot.error, ops: out.module.ops.map(op => op.id) }))
