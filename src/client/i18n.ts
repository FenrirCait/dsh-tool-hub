/**
 * Panel copy, Chinese and English.
 *
 * Both catalogs carry the same keys: probe/next/client-shell.mjs fails when they drift, so a
 * label added on one side cannot ship as a blank on the other. Keys are flat and dotted; the
 * probe also checks that every t('...') the sources call exists here.
 */
export type Lang = 'zh' | 'en'

export type Catalog = Record<string, string>

const zh: Catalog = {
  'app.brand': '工具总控台',
  'app.title': '工具总控台',
  'app.subtitle': '插件、技能、MCP 与场景',
  'nav.label': '视图',
  'nav.plugins': '插件',
  'nav.skills': '技能',
  'nav.mcp': 'MCP',
  'nav.scenes': '场景',
  'top.updated': '更新于 {time}',
  'top.refreshing': '刷新中',
  'top.lang': '切换语言',
  'top.refresh': '刷新快照',
  'action.retry': '重试',
  'action.close': '关闭',
  'action.cancel': '取消',
  'action.apply': '应用',
  'action.exit': '退出场景',
  'action.confirm': '确认',
  'action.clear': '清除筛选',
  'state.loading': '正在读取快照',
  'state.error': '快照读取失败',
  'state.busy': '处理中',
  'state.on': '已启用',
  'state.off': '已停用',
  'state.ready': '就绪',
  'plugins.title': '插件',
  'plugins.count': '{n} 个插件',
  'plugins.search': '按名称或 id 筛选',
  'plugins.empty': '这个安装里还没有插件条目。',
  'plugins.emptyFiltered': '没有匹配“{query}”的插件。',
  'skills.title': '技能',
  'skills.count': '{n} 个技能',
  'skills.search': '按名称筛选技能',
  'skills.empty': '没有找到技能目录，先在设置里配置技能根目录。',
  'skills.emptyFiltered': '没有匹配“{query}”的技能。',
  'skills.allRoots': '全部根目录',
  'skills.root': '根目录',
  'mcp.title': 'MCP 服务器',
  'mcp.count': '{n} 个服务器',
  'mcp.search': '按名称筛选服务器',
  'mcp.empty': '这个 profile 还没有配置 MCP 服务器。',
  'mcp.emptyFiltered': '没有匹配“{query}”的服务器。',
  'mcp.patchMissing': '找不到 profile 的 patch 文件，MCP 配置不可编辑。',
  'mcp.patchError': '读取 MCP 配置失败：{message}',
  'mcp.transport': '传输',
  'mcp.command': '命令',
  'mcp.secrets': '{n} 个凭据',
  'mcp.orphan': '配置文件里有、加载器里没有',
  'scenes.title': '场景',
  'scenes.current': '当前场景',
  'scenes.none': '未进入任何场景',
  'scenes.since': '自 {time} 起',
  'scenes.members': '{n} 个成员',
  'scenes.empty': '还没有保存过场景。',
  'scenes.hint': '场景会记住整套开关状态，退出时恢复进入前的样子。',
  'nav.settings': '设置',
  'settings.title': '设置',
  'settings.count': '{n} 项声明',
  'settings.hint': '字段由各模块声明，保存后写入状态文件。',
  'settings.save': '保存',
  'settings.saving': '保存中',
  'settings.reset': '恢复默认',
  'settings.discard': '放弃更改',
  'settings.clean': '没有未保存的更改',
  'settings.dirty': '{n} 项未保存',
  'settings.unsaved': '有未保存的更改，刷新或离开会丢失。',
  'settings.modified': '已修改',
  'settings.default': '默认：{value}',
  'settings.range': '范围 {min} – {max}',
  'settings.error.save': '保存设置失败，宿主没有接受这次写入。',
  'settings.emptyTitle': '宿主没有返回设置声明',
  'settings.emptyHint': '快照里没有 settingsSchema，重新读取一次再试。',
  'settings.group.appearance': '外观',
  'settings.group.general': '通用',
  'settings.group.tools': '工具',
  'settings.group.scenes': '场景',
  'settings.group.diagnostics': '诊断',
  'settings.group.advanced': '高级',
  'settings.group.other': '其他',
  'settings.a11y.group': '{name}分组',
  'dialog.confirmTitle': '确认执行',
  'a11y.nav': '主导航',
  'a11y.content': '内容区',
  'a11y.status': '状态',
  'a11y.switch': '切换 {name}',
  'a11y.busy': '正在处理',
  'error.network': '连不上宿主：{message}',
  'error.http': '宿主返回 {status}：{message}',
  'error.timeout': '请求超时',
  'error.envelope': '宿主返回了无法识别的响应',
  'error.bad-op': '宿主不认识这个操作',
  'error.confirm-required': '这个操作需要确认',
  'error.forbidden': '没有权限执行这个操作',
  'error.unknown': '操作失败：{message}',
  'notice.done': '已完成',
  'notice.failed': '失败：{message}',
}

const en: Catalog = {
  'app.brand': 'Tool Hub',
  'app.title': 'Tool Hub',
  'app.subtitle': 'Plugins, skills, MCP and scenes',
  'nav.label': 'Views',
  'nav.plugins': 'Plugins',
  'nav.skills': 'Skills',
  'nav.mcp': 'MCP',
  'nav.scenes': 'Scenes',
  'top.updated': 'Updated {time}',
  'top.refreshing': 'Refreshing',
  'top.lang': 'Switch language',
  'top.refresh': 'Refresh snapshot',
  'action.retry': 'Retry',
  'action.close': 'Close',
  'action.cancel': 'Cancel',
  'action.apply': 'Apply',
  'action.exit': 'Exit scene',
  'action.confirm': 'Confirm',
  'action.clear': 'Clear filter',
  'state.loading': 'Reading snapshot',
  'state.error': 'Snapshot failed',
  'state.busy': 'Working',
  'state.on': 'On',
  'state.off': 'Off',
  'state.ready': 'Ready',
  'plugins.title': 'Plugins',
  'plugins.count': '{n} plugins',
  'plugins.search': 'Filter by name or id',
  'plugins.empty': 'No plugin entries in this installation.',
  'plugins.emptyFiltered': 'No plugin matches “{query}”.',
  'skills.title': 'Skills',
  'skills.count': '{n} skills',
  'skills.search': 'Filter skills by name',
  'skills.empty': 'No skill folder found; configure a skill root first.',
  'skills.emptyFiltered': 'No skill matches “{query}”.',
  'skills.allRoots': 'All roots',
  'skills.root': 'Root',
  'mcp.title': 'MCP servers',
  'mcp.count': '{n} servers',
  'mcp.search': 'Filter servers by name',
  'mcp.empty': 'This profile configures no MCP server yet.',
  'mcp.emptyFiltered': 'No server matches “{query}”.',
  'mcp.patchMissing': 'No patch file for this profile, so MCP config is read-only.',
  'mcp.patchError': 'Reading the MCP config failed: {message}',
  'mcp.transport': 'Transport',
  'mcp.command': 'Command',
  'mcp.secrets': '{n} secrets',
  'mcp.orphan': 'In the file, not in the loader',
  'scenes.title': 'Scenes',
  'scenes.current': 'Current scene',
  'scenes.none': 'No scene applied',
  'scenes.since': 'since {time}',
  'scenes.members': '{n} members',
  'scenes.empty': 'No scene saved yet.',
  'scenes.hint': 'A scene remembers a whole switch set; exiting restores what was there before.',
  'nav.settings': 'Settings',
  'settings.title': 'Settings',
  'settings.count': '{n} declared',
  'settings.hint': 'Modules declare these fields; saving writes them to the state file.',
  'settings.save': 'Save',
  'settings.saving': 'Saving',
  'settings.reset': 'Restore defaults',
  'settings.discard': 'Discard changes',
  'settings.clean': 'No unsaved changes',
  'settings.dirty': '{n} unsaved',
  'settings.unsaved': 'Unsaved changes are lost if you refresh or leave.',
  'settings.modified': 'Changed',
  'settings.default': 'Default: {value}',
  'settings.range': 'Range {min} – {max}',
  'settings.error.save': 'Saving settings failed; the host did not accept the write.',
  'settings.emptyTitle': 'The host returned no settings declaration',
  'settings.emptyHint': 'The snapshot carries no settingsSchema; read it again and retry.',
  'settings.group.appearance': 'Appearance',
  'settings.group.general': 'General',
  'settings.group.tools': 'Tools',
  'settings.group.scenes': 'Scenes',
  'settings.group.diagnostics': 'Diagnostics',
  'settings.group.advanced': 'Advanced',
  'settings.group.other': 'Other',
  'settings.a11y.group': '{name} section',
  'dialog.confirmTitle': 'Confirm',
  'a11y.nav': 'Main navigation',
  'a11y.content': 'Content',
  'a11y.status': 'Status',
  'a11y.switch': 'Toggle {name}',
  'a11y.busy': 'Working',
  'error.network': 'Cannot reach the host: {message}',
  'error.http': 'Host answered {status}: {message}',
  'error.timeout': 'Request timed out',
  'error.envelope': 'The host answered with an unknown envelope',
  'error.bad-op': 'The host does not know this op',
  'error.confirm-required': 'This op needs confirmation',
  'error.forbidden': 'Not allowed to run this op',
  'error.unknown': 'The op failed: {message}',
  'notice.done': 'Done',
  'notice.failed': 'Failed: {message}',
}

export const catalogs: Record<Lang, Catalog> = { zh, en }

export type TFunction = (key: string, vars?: Record<string, string | number>) => string

/** Replace {name} placeholders; unknown ones stay visible so a missing value is obvious. */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name]
    return value === undefined ? whole : String(value)
  })
}

/** A translator for one language, falling back to English and then to the key itself. */
export function createT(lang: Lang): TFunction {
  const primary = catalogs[lang]
  const fallback = catalogs.en
  return (key, vars) => {
    const text = primary[key] ?? fallback[key]
    if (text === undefined) return key
    return format(text, vars)
  }
}

/** Whatever the host or the browser says, clamped to a language this panel can render. */
export function normalizeLang(value: unknown): Lang {
  if (typeof value !== 'string') return 'zh'
  const lower = value.toLowerCase()
  return lower.startsWith('zh') ? 'zh' : 'en'
}

/** The host locale when it announces one, then the browser, then Chinese. */
export function detectLang(): Lang {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('lang')
    if (attr !== null && attr !== '') return normalizeLang(attr)
  }
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') return normalizeLang(navigator.language)
  return 'zh'
}
