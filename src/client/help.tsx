/**
 * In-panel usage guide. Opened from the "?" button in either topbar, so it is reachable from every
 * view without adding another sidebar entry. Content is local bilingual copy; links go to the
 * public plugin and pack repositories.
 */
import * as React from 'react'
import { Button, Dialog } from './components.js'
import type { Lang } from './i18n.js'

function copy(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

interface Section {
  title: string
  lines: string[]
}

function sections(lang: Lang): Section[] {
  const zh = lang === 'zh'
  return [
    {
      title: zh ? '快速开始' : 'Quick start',
      lines: zh ? [
        '左侧栏切换插件、技能、MCP、工具面、分组、预设、会话、场景、诊断、扩展、设置。',
        '右上角「刷新快照」重新读取宿主状态；语言按钮在中文/English 间切换。',
        '大多数开关即时写入宿主；带确认的按钮会先显示影响再执行。',
      ] : [
        'Use the left rail for Plugins, Skills, MCP, Tools, Groups, Presets, Sessions, Scenes, Diagnostics, Extensions and Settings.',
        'Refresh snapshot in the top-right re-reads the host state; the language button toggles Chinese/English.',
        'Most switches write immediately; buttons that need confirmation show the impact first.',
      ],
    },
    {
      title: zh ? '插件与技能' : 'Plugins and skills',
      lines: zh ? [
        '插件行来自宿主 loader，按安装 bundle 分组；父级开关整组启用/停用，超过 20 项会再次确认。',
        '技能按名称前缀分组；父级开关逐个切换子项。技能停用靠重命名 SKILL.md，不会删除文件。',
        '「来自插件包」标记只表示来源，不代表已启用。',
      ] : [
        'Plugin rows come from the host loader and group by installed bundle; the parent switch toggles the whole group (extra confirmation above 20 items).',
        'Skills group by name prefix; the parent switch toggles each child. Disabling renames SKILL.md and never deletes files.',
        'The "From package" badge describes provenance, not whether the extension is enabled.',
      ],
    },
    {
      title: zh ? 'MCP 与工具面' : 'MCP and tool surface',
      lines: zh ? [
        'MCP 服务器可以设懒加载：未加载时工具对模型隐藏，需要时在工具面加载；支持按会话加载和全局加载。',
        '工具面每行显示主状态（可见/已屏蔽/懒加载隐藏）和屏蔽原因（作用域、预设、按需组）；「固定」表示不可屏蔽。',
        '搜索框支持高亮；在工具列表里用 ↑/↓、Home/End 移动，Esc 回到搜索框。',
        '设置里可开启「每回合结束卸载本会话懒加载」。',
      ] : [
        'MCP servers can be lazy: unloaded tools stay hidden from the model; load them from the Tools view. Loads can be global or per session.',
        'Each tool row shows its primary state (visible / masked / lazy hidden) and reasons (scope, preset, on-demand); "fixed" means it cannot be masked.',
        'Search highlights matches; use Arrow keys, Home/End to move through rows and Escape to return to search.',
        'Settings can unload this session’s lazy tools at every turn end.',
      ],
    },
    {
      title: zh ? '分组与预设' : 'Groups and presets',
      lines: zh ? [
        '分组用于整组启停；成员来自插件、技能、MCP 或工具。圆点按成员数分档，避免误组超大集合。',
        '预设记录一套启用集合，可应用、只开启或删除；应用前会展示差异。',
      ] : [
        'Groups toggle a set together; members can be plugins, skills, MCP servers or tools. The dot scales with size so huge groups are obvious.',
        'Presets store an enabled set; apply, enable-only or delete. The diff is shown before applying.',
      ],
    },
    {
      title: zh ? '官方配套与扩展' : 'Official packs and extensions',
      lines: zh ? [
        '扩展页顶部「官方配套」读取独立 GitHub 仓库的索引；安装/更新会逐文件校验 SHA-256，更新和卸载前先备份。',
        '兼容包默认关闭；安装后需在行内启用。卸载只移除本地副本，不影响远端仓库。',
        '本地扩展放在 profile 的 extensions 目录，可由扩展页启用、重载或复制。',
      ] : [
        'Official packs at the top of Extensions read a separate GitHub catalog; every file is SHA-256 checked, and update/uninstall back up first.',
        'Packs are disabled by default and must be enabled on their row after install. Uninstall removes only the local copy, never the remote repository.',
        'Local extensions live in the profile extensions folder and can be enabled, reloaded or copied from the Extensions page.',
      ],
    },
    {
      title: zh ? '诊断与安全' : 'Diagnostics and safety',
      lines: zh ? [
        '诊断页检查 patch、锁、扩展、技能根、心跳等；可复制报告、重载失败扩展、清理 stale lock。',
        '清理锁只处理超过 30 秒的锁，先备份再删除，绝不改 patch；patch 冲突只定位和复制详情。',
        '所有写操作都记入审计历史；需要确认的动作不会自动执行。',
      ] : [
        'Diagnostics checks patch, locks, extensions, skill roots and heartbeat; copy the report, reload failed extensions or clear a stale lock.',
        'Lock clearing only acts on locks older than 30s, backs up first and never edits the patch; patch conflicts are located and copied, not rewritten.',
        'Every write is audited; actions that need confirmation never run automatically.',
      ],
    },
  ]
}

export interface HelpButtonProps {
  lang: Lang
}

/** Topbar "?" with the usage guide. */
export function HelpButton(props: HelpButtonProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const zh = props.lang === 'zh'
  const list = sections(props.lang)
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} label={zh ? '使用指引' : 'Usage guide'}>
        ?
      </Button>
      <Dialog
        open={open}
        title={zh ? '工具总控台使用指引' : 'Tool Hub usage guide'}
        onClose={() => setOpen(false)}
        footer={<Button onClick={() => setOpen(false)}>{zh ? '知道了' : 'Got it'}</Button>}
      >
        <div style={{ maxHeight: '58vh', overflowY: 'auto', paddingRight: 4 }}>
          <p style={{ marginTop: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.96))' }}>
            {zh ? '从左侧栏选择功能；下面按页面说明常用操作。' : 'Pick a view on the left; the notes below cover the common actions.'}
          </p>
          {list.map(section => (
            <section key={section.title} style={{ marginBottom: 14 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>{section.title}</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.65 }}>
                {section.lines.map((line, index) => <li key={index}>{line}</li>)}
              </ul>
            </section>
          ))}
          <p style={{ marginBottom: 0, fontSize: 12 }}>
            {zh ? '项目与配套包：' : 'Project and packs: '}
            <a href="https://github.com/FenrirCait/dsh-tool-hub" target="_blank" rel="noreferrer">dsh-tool-hub</a>
            {', '}
            <a href="https://github.com/FenrirCait/dsh-tool-hub-packs" target="_blank" rel="noreferrer">dsh-tool-hub-packs</a>
          </p>
        </div>
      </Dialog>
    </>
  )
}
