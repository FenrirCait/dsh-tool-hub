import type { DomainRegistration } from '../shared/contract.js'
import type { SettingsField } from '../shared/types.js'

/** One place for the settings the panel's Settings page renders; defaults come from here. */
const FIELDS: SettingsField[] = [
  { key: 'appearance.theme', type: 'select', default: 'system', label: { zh: '外观', en: 'Appearance' }, options: [
    { value: 'system', label: { zh: '跟随系统', en: 'System' } },
    { value: 'light', label: { zh: '浅色', en: 'Light' } },
    { value: 'dark', label: { zh: '深色', en: 'Dark' } },
  ] },
  { key: 'appearance.density', type: 'select', default: 'comfortable', label: { zh: '密度', en: 'Density' }, options: [
    { value: 'comfortable', label: { zh: '舒展', en: 'Comfortable' } },
    { value: 'compact', label: { zh: '紧凑', en: 'Compact' } },
  ] },
  { key: 'general.language', type: 'select', default: 'auto', label: { zh: '语言', en: 'Language' }, options: [
    { value: 'auto', label: { zh: '跟随界面', en: 'Follow UI' } },
    { value: 'zh', label: { zh: '中文', en: 'Chinese' } },
    { value: 'en', label: { zh: 'English', en: 'English' } },
  ] },
  { key: 'tools.lazyDefault', type: 'boolean', default: false, label: { zh: '新 MCP 服务器默认懒启动', en: 'Lazy-load new MCP servers' } },
  { key: 'tools.lazyLoadTtlMinutes', type: 'number', default: 60, min: 0, max: 10080, label: { zh: '懒加载自动卸载（分钟）', en: 'Auto-unload lazy tools after (minutes)' }, hint: { zh: '0 = 不按时间清理；会话结束仍会清掉该会话的加载。', en: '0 disables the time sweep; session-end cleanup still applies.' } },
  { key: 'tools.lazyUnloadEachTurn', type: 'boolean', default: false, label: { zh: '每回合结束卸载本会话懒加载', en: 'Unload this session\'s lazy tools after each turn' }, hint: { zh: '只清当前会话的加载，不影响面板全局加载；默认关闭。', en: 'Clears only this session\'s loads; global panel loads stay. Off by default.' } },
  { key: 'tools.showTokenEstimate', type: 'boolean', default: true, label: { zh: '显示工具 token 估算', en: 'Show tool token estimates' }, hint: { zh: '工具页每行按 schema JSON ÷4 估算，关闭后隐藏。', en: 'The tools page estimates each schema as JSON ÷4; turn this off to hide it.' } },
  { key: 'scenes.confirmApply', type: 'boolean', default: true, label: { zh: '应用场景前确认', en: 'Confirm before applying a scene' } },
  { key: 'scenes.autoApply', type: 'string', default: '', label: { zh: '启动时自动应用的场景', en: 'Scene to apply on mount' }, hint: { zh: '留空表示不自动应用', en: 'Empty means none' } },
  { key: 'diagnostics.includeOptional', type: 'boolean', default: true, label: { zh: '诊断包含可选能力', en: 'Include optional capabilities in diagnostics' } },
  { key: 'advanced.backupKeep', type: 'number', default: 20, min: 1, max: 200, label: { zh: '保留备份数量', en: 'Backups to keep' } },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function settingsDomain(): DomainRegistration {
  return {
    module: {
      id: 'settings',
      title: { zh: '设置', en: 'Settings' },
      settings: FIELDS,
      ops: [
        { id: 'settings.set', write: true, audit: true, note: 'Merges declared settings into state.settings; unknown keys are stored but not rendered.' },
      ],
    },
    handlers: {
      'settings.set': async (payload, env) => {
        const values = isRecord(payload) && isRecord((payload as { values?: unknown }).values) ? (payload as { values: Record<string, unknown> }).values : null
        if (values === null) {
          const error = new Error('settings.set needs values: an object') as Error & { code?: string }
          error.code = 'bad-payload'
          throw error
        }
        env.state.settings = { ...env.state.settings, ...values }
        const backup = await env.save('settings')
        return { settings: env.state.settings, backup }
      },
    },
  }
}
