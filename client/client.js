/*
 * dsh-tool-hub — client half.
 *
 * Hand-written module-loader bundle: react and jsx-runtime are the only seeds
 * this file requires, and every control below is plain DOM with inline styles
 * over the shell's own `--dsw-alias-*` tokens. That is deliberate — a client
 * package import here would tie the panel to one shell build, and a throw
 * inside a slot entry blanks the whole tab.
 */
window.__ModuleLoader__.load({
    id: "dsh-tool-hub",
    factory: (require) => {
        const bundleModule = { exports: {} };
        Object.defineProperty(bundleModule.exports, Symbol.toStringTag, { value: "Module" });

        const React = require("react");
        const h = React.createElement;
        const { useCallback, useEffect, useMemo, useRef, useState } = React;

        const NS = "tool-hub";

        // ── theme tokens ────────────────────────────────────────────────────
        // Only aliases the shell publishes; each carries a literal fallback so
        // the panel still reads on an older shell.
        // Motion lives in one <style> inside our own tree: a few milliseconds of feedback, and
        // nothing when the system asks for less motion.
        const HUB_CSS = `
            @keyframes hub-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
            @keyframes hub-pop { from { opacity: 0; transform: translateY(6px) scale(.985); } to { opacity: 1; transform: none; } }
            @keyframes hub-fade { from { opacity: 0; } to { opacity: 1; } }
            .hub-row { transition: background-color .12s ease, border-color .12s ease, opacity .12s ease; animation: hub-in .16s ease-out; }
            .hub-row:active { transform: scale(.997); }
            .hub-swatch { transition: background-color .12s ease, color .12s ease, border-color .12s ease, transform .08s ease; }
            .hub-swatch:active { transform: scale(.97); }
            .hub-card { animation: hub-in .18s ease-out; }
            .hub-pop { animation: hub-pop .16s ease-out; }
            .hub-scrim { animation: hub-fade .12s ease-out; }
            .hub-switch span { transition: left .16s cubic-bezier(.2,.8,.2,1), background-color .16s ease; }
            @media (prefers-reduced-motion: reduce) {
                .hub-row, .hub-card, .hub-pop, .hub-scrim, .hub-swatch, .hub-switch span { animation: none !important; transition: none !important; }
            }
        `;

        const T = {
            card: "var(--dsw-alias-card-fill, rgba(127,127,127,.07))",
            cardHover: "var(--dsw-alias-card-fill-hover, rgba(127,127,127,.12))",
            seg: "var(--dsw-alias-bg-l2, rgba(127,127,127,.09))",
            base: "var(--dsw-alias-bg-base, transparent)",
            border: "var(--dsw-alias-border-l2, rgba(127,127,127,.24))",
            borderSoft: "var(--dsw-alias-border-l1, rgba(127,127,127,.14))",
            text: "var(--dsw-alias-label-primary, inherit)",
            text2: "var(--dsw-alias-label-secondary, rgba(127,127,127,.96))",
            text3: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.78))",
            brand: "var(--dsw-alias-brand-primary, #4c6fff)",
            onBrand: "var(--dsw-alias-label-on-color, #fff)",
            danger: "var(--dsw-alias-state-error-primary, #e5484d)",
            success: "var(--dsw-alias-state-success-primary, #12b3a8)",
            warn: "var(--dsw-alias-state-warn-primary, #e0a33a)",
            overlay: "var(--dsw-alias-bg-overlay, rgba(0,0,0,.42))",
        };

        /**
         * A translucent version of a theme token. color-mix keeps the plugin on
         * the theme's own colours instead of hard-coding a tint that breaks in
         * dark mode; the token's own fallback still applies when the host is old.
         */
        function tint(token, percent) {
            return `color-mix(in srgb, ${token} ${percent}%, transparent)`;
        }

        const groupTint = {
            activeBg: tint(T.brand, 12),
            activeBar: T.brand,
            enableBg: tint(T.success, 14),
            enableBorder: tint(T.success, 34),
            disableBg: tint(T.text3, 14),
            countBg: T.seg,
        };

        // ── i18n ───────────────────────────────────────────────────────────
        // Dictionaries hold plain strings only: a function here would reach
        // React as a child and blank the slot. `{name}` placeholders are filled
        // by fmt() below.
        const zh = {
                navTitle: '工具总控台',
                tabLabel: '总控台',
                heading: '工具总控台',
                sub: '{p} 个插件已启用 · 共 {s} 个技能',
                pillOn: '{n} 已启用',
                pillSkills: '{n} 个技能',
                pillAll: '{n} 项合计',
                viewAll: '全部',
                viewPlugins: '插件',
                viewSkills: '技能',
                viewMcp: 'MCP · {n}',
                pillMcp: '{n} 个 MCP',
                mcpBadge: 'MCP',
                mcpEdit: '编辑配置',
                mcpEditTitle: 'MCP 服务器配置',
                mcpEditHint: '编辑配置：改名字、命令、环境变量或请求头（只写回这一条 config，保存后 HMR 生效）',
                mcpBadgeHint: 'MCP：外部服务进程，展开可改工具白名单',
                mcpName: '服务器名',
                mcpTransport: '传输方式',
                mcpCommand: '启动命令',
                mcpArgs: '参数（每行一个）',
                mcpEnv: '环境变量（每行 KEY=VALUE）',
                mcpCwd: '工作目录',
                mcpUrl: '地址 URL',
                mcpTimeout: '调用超时（毫秒）',
                mcpFailFast: '启动失败即报错',
                mcpSave: '保存',
                mcpSaved: '已写入，等待热加载…',
            mcpTest: '测试连接',
            mcpTesting: '连接中…',
            mcpTestOk: '连接成功 · {n} 个工具 · {ms}ms',
            mcpTestFail: '连接失败：{message}',
            mcpTestAborted: '测试没有完成',
                mcpNoConfig: '这一条不在 profile patch 里，配置不能在面板里改。',
                mcpCreate: '添加服务器',
                mcpCreateTitle: '添加 MCP 服务器',
                mcpNameRule: '名字只能是字母、数字、- 和 _，最长 32 个字符。',
                mcpBadName: '名字不合法：只能是字母、数字、- 和 _，1–32 个字符。',
                mcpHeaders: '请求头（每行 KEY=VALUE）',
                mcpAdvanced: '高级设置',
                mcpReconnect: '自动重连',
                mcpReconnectInit: '首次重连延迟（毫秒）',
                mcpReconnectMax: '最大重连延迟（毫秒）',
                mcpReconnectTries: '最大重连次数',
                mcpDelete: '删除',
                mcpDeleteHint: '删除：移除这条 MCP 连接，它的工具也会消失',
                mcpDeleteTitle: '删除 MCP 服务器',
                mcpDeleteBody: '将从 profile 的 cordis.patch.yml 里删掉「{name}」这一条，文件其余部分不动。',
                mcpDeleteDone: '已删除，等待热加载…',
                mcpInvalidNumber: '超时要是数字',
                mcpBadEnv: '这一行不是 KEY=VALUE：{line}',
                toolsButton: '工具 · {on}/{total}',
                toolsTitle: 'MCP 工具',
                toolsHint: '工具：从模型工具表里隐藏选中项（全安装的所有会话生效）',
                toolsEmpty: '这个服务器还没有注册工具。先启用它，等宿主连上，再回来刷新。',
                toolsSearch: '筛选工具名',
                toolsAll: '全选',
                toolsNone: '全不选',
                toolsSaved: '工具设置已保存',
                toolsPanelNote: '另有 {n} 项被 Skill / MCP 面板禁用（只读）',
                toolsImport: '导入他们的 {n} 项',
                toolsImported: '已导入 {n} 项',
    lazyOn: '懒启动',
    lazyActive: '懒加载中',
    lazyHint: '把这台服务器的工具全部移出模型工具表，只留 hub_tools 入口；需要时让模型 enable。',
    lazyDone: '懒启动已开启',
    lazyOff: '已取消懒启动',
                toolsCount: '共 {n} 个工具',
                groups: '分组',
                newGroup: '新建分组',
                search: '搜索名称或模块名',
                empty: '这里还没有东西',
                emptyGroup: '这个分组是空的，勾选右侧条目后点「加入分组」',
                loading: '读取中…',
                reload: '刷新',
                enable: '启用',
                disable: '禁用',
                enabled: '已启用',
                disabled: '已禁用',
                selected: '已选 {n} 项',
                addToGroup: '加入分组',
                clearSelection: '取消选择',
                toggleGroupOn: '启用整组（组内成员按各自状态逐个打开）',
                toggleGroupOff: '禁用整组（会先列出共有成员）',
                rename: '改名（只改分组名，不动成员）',
            moveUp: '上移（在本组里提前一位）',
            moveDown: '下移（在本组里后退一位）',
                remove: '删除分组（成员和技能都不删）',
                removeConfirm: '删除分组「{name}」？成员本身不会被开关。',
                readonly: '宿主托管',
                readonlyHint: '宿主托管：由客户端配置决定，面板里改不动',
                autoTag: '自动分组生成',
                officialBadge: '官方',
                officialHint: '官方：随客户端安装，升级会覆盖改动',
                selfBadge: '本插件',
                selfHint: '本插件：面板自己，不能禁用自己',
                restart: '需重启生效',
                overridden: '被更高优先层覆盖',
                preset: '预设',
                presetTitle: '预设',
                presetHint: '预设记录当前开启的那一套。应用时打开它列出的、关掉它没列的。',
                presetSave: '把当前状态存为预设',
                presetName: '预设名称',
                presetApply: '应用',
                presetDelete: '删除',
                presetEmpty: '还没有预设',
                presetApplied: '已应用 {n}/{total} 项变更',
            presetDeferred: '已换上预设；相关服务器的工具注册后会自动补上屏蔽',
            compatBadge: '兼容',
            compatHint: '兼容：检测到旧版面板，写入 patch 前先拿它的锁，工具屏蔽只读并入',
            marketImport: '导入 dshmarket 分组（{n}）',
            marketImportTitle: '导入 dshmarket 分组',
            marketImportHint: '只读 dshmarket 的 state.json，把它的分组复制进来；同名分组会跳过。',
            marketImportConfirm: '导入',
            marketImportDone: '已导入 {n} 个分组',
            marketImportRow: '{members} 个插件 / {packages} 个包',
            marketImportMissing: '有 {n} 个包未安装，已跳过',
            marketNoGroups: '没有可导入的分组',
                presetOnlyOn: '只开启，不关闭',
                presetUpdate: '更新',
                presetUpdateTitle: '更新预设',
                presetUpdateBody: '用当前开关状态覆盖「{name}」？原来的记录会被替换。',
                presetUpdated: '已更新「{name}」',
            thirdOff: '关闭第三方',
            thirdOffTitle: '关闭所有第三方功能',
            thirdOffHint: '只关不删：插件与技能会被禁用，官方与宿主托管项不动；按下去之前先写一份回滚点。',
            thirdOffWarn: '其中 {n} 项是常开底座或界面类插件，关闭后界面可能异常。',
            thirdOffAck: '我了解界面可能异常，并已保存回滚点',
            thirdOffApply: '全部关闭（{n} 项）',
            thirdWorking: '正在逐项处理…',
            builtinUiBadge: '内置界面',
            builtinUiHint: '内置界面：随客户端打包，改不动',
            toggleRefused: '这个开关没有生效：{why}',
            filterLead: '已筛选：',
            filterClear: '清除筛选',
            filterView: '视图 {label}',
            filterOrigin: '来源 {label}',
            filterShape: '形态 {label}',
            viewMcpShort: 'MCP',
            thirdOffDone: '已关闭 {n} 项，回滚点 {file}',
            thirdOffBusy: '正在关闭 {n} 项（逐项重启，约 30–60 秒），期间按钮会变灰。',
            thirdOffEmpty: '没有可关闭的第三方功能。',
            thirdRestore: '恢复',
            thirdRestoreTitle: '恢复到关闭前',
            thirdRestoreBody: '按回滚点 {file} 重新打开 {n} 项？',
            thirdRestoreBusy: '正在恢复 {n} 项（约 30–60 秒），期间按钮会变灰。',
            thirdRestoreDone: '已恢复 {n} 项',
            thirdRollback: '回滚点 {file}',
            thirdKindPlugin: '插件',
            thirdKindSkill: '技能',
            thirdKindMcp: 'MCP 服务器',
                groupRemove: '移出',
                groupRemoved: '已从本组移出 {n} 项',
                removeFromGroup: '从本组移出',
                auto: '自动分组',
                autoTitle: '自动分组预览',
                autoHint: '按规则表分组，还没生效。确认后再写。',
                autoApply: '应用到分组',
                autoEmpty: '没有可自动分组的条目',
                resizeRail: '拖动调整左栏宽度，双击复位',
            roleOfficial: '官方',
            roleBase: '通用',
            roleRest: '用户下载',
            toggleBaseOff: '禁用底座组（可能连累整条链，会先确认）',
            roleMcp: 'MCP 服务器',
            roleSkill: '技能',
            roleLoose: '手动分组',
            railEmptyTitle: '还没有分组',
                railEmptyBody: '一键自动分组会按规则把插件和技能分成几组，先看预览，确认后才写盘。',
                railEmptyAction: '自动分组',
                autoDone: '已建 {n} 个自动分组',
                cancel: '取消',
                close: '关闭',
                mcpDiscardHint: '再按一次 Esc 或点空白处就丢弃这些修改。',
                retry: '重试',
                historyCapped: '最近 {shown} / 共 {total} 条',
                deleteVerb: '删除',
                rowFailed: '加载失败',
                badgePanel: '面板已禁用',
                modeMerge: '合并',
                modeReplace: '替换',
                oauthNoUrl: '宿主没有返回授权地址或状态值',
                oauthClipboardBlocked: '浏览器拒绝了剪贴板访问',
                oauthClipboardUnavailable: '当前环境没有剪贴板',
                groupPickEmpty: '还没有分组，先建一个',
                bulkOnTitle: '启用选中的项',
                bulkOffTitle: '禁用选中的项',
                bulkOnBody: '将逐个打开选中的 {n} 项。',
                bulkOffBody: '将逐个关闭选中的 {n} 项；其中基础插件被关掉后界面可能异常。',
                bulkGo: '继续（{n} 项）',
                thirdOffFailed: '读不到第三方列表：{why}',
                presetDeleted: '预设已删除。',
                presetDeleteTitle: '删除预设',
                presetDeleteBody: '删除「{name}」？这条记录会消失，已经应用的开关不受影响。',
                save: '保存',
                groupName: '分组名称',
            collectionNew: '新建分组群',
            collectionHint: '分组群只是把分组收在一起，不改变分组的开关行为。',
            collectionName: '分组群名称',
            collectionAddGroup: '在这个分组群里新建分组',
            collectionRename: '重命名分组群',
            collectionDelete: '删除分组群',
            collectionDeleteTitle: '删除分组群',
            collectionDeleteBody: '「{name}」会被删掉，里面的分组移到默认分组群，分组本身不会消失。',
            collectionDeleted: '分组群已删除',
            collapseModule: '收起这个插件的条目',
            expandModule: '展开这个插件的条目',
            collectionCollapse: '收起这个分组群',
            collectionExpand: '展开这个分组群',
            looseTitle: '未入群',
            looseHint: '不属于任何分组群的分组；把分组拖到某个分组群上可以放进去，拖回这里则移出来。',
                stale: '{n} 个成员已不在清单里',
                moved: '{n} 项已更新',
                failed: '{n} 项失败',
                statePath: '状态文件',
                noManager: '这个宿主没有暴露插件管理器，插件一栏暂不可用。',
                confirmExact: '应用将同时关闭 {off} 个当前启用的条目。继续？',
                applyAnyway: '继续应用',
                membersCount: '{n} 项',
            statHint: "已启用 {on} 个 · 未启用 {off} 个",
                kindPlugin: '插件',
                kindSkill: '技能',
                skillRoots: '技能目录',
                skillScopeGlobal: '全局',
                skillScopeWorkspace: '工作区 · {name}',
                skillPreview: '预览',
                skillPreviewTitle: '技能原文',
                skillPreviewHint: '预览：只读查看技能原文，不改动文件',
                skillPreviewTruncated: '文件较大，只显示前 200 KB',
                skillDelete: '删除',
                skillDeleteHint: '删除：移到废纸篓，10 秒内可撤销',
                skillDeleteTitle: '删除技能',
                skillDeleteBody: '会把「{name}」移到回收目录，10 秒内可撤销。',
                skillDeleted: '已移到回收目录',
                undoDelete: '撤销',
                skillRestored: '已恢复',
                secretKeep: '已设置，留空保持不变',
                secretHint: '值里写 ${NAME} 会读取该环境变量',
                rawView: '查看原文',
                rawViewHint: '查看原文：直接看这条 MCP 的配置片段（只读）',
                rawTitle: '{name} 的原文',
                rawEdit: '高级：直接编辑',
                rawWarn: '整条替换：缩进、字段与格式都要自己保证。',
                rawSaved: '原文已保存',
                rawInvalid: '这一条不合法：{why}',
                copy: '复制',
                copied: '已复制',
                skillImport: '导入技能',
                skillImportTitle: '导入技能',
                skillImportPath: '本地路径（.md / 目录 / .zip）',
                skillImportTarget: '目标根',
                skillImportOverwrite: '覆盖同名技能',
                skillImportDone: '已导入 {added} 个，跳过 {skipped} 个',
                skillMove: '移动到…',
                skillMoveTitle: '移动技能',
                skillMoveTarget: '目标根',
                skillMoveHint: '移动：把技能文件夹挪到另一个技能目录',
                skillMoveNone: '没有其它可选的技能目录',
                skillMoved: '已移到 {name}',
                bundleView: '按 bundle',
                bundleAll: '全部',
                bundleRows: '{n} 行',
                showDesc: '显示简介',
                hideDesc: '隐藏简介',
                helpOpen: '打开帮助（八节，每节三行）',
                helpTitle: '这个面板怎么用',
                helpHint: '每节三行：它解决什么 / 怎么用 / 一个注意',
                helpFilterT: '筛掉你不想看的东西',
                helpFilterB: '按来源、形态、关键词或 bundle 过滤；再点一次取消。注意：只改列表，不动任何开关。',
                helpGroupT: '把常用工具收进一个抽屉',
                helpGroupB: '左栏「+」建分组，把行拖进去；分组群再把分组分类。注意：组内开关改的是成员本身。',
                helpAutoT: '一次把同类项分好',
                helpAutoB: '按官方 / 第三方 / MCP 等规则批量建组，同名分组跳过。注意：执行前先列出计划。',
                helpPresetT: '保存并还原一整套开关',
                helpPresetB: '底部存下当前状态；应用时可精确还原或只补开。注意：能导出 JSON 备份。',
                helpThirdT: '一键只留官方与宿主托管',
                helpThirdB: '先把当前状态写成回滚点，再禁用第三方。注意：随时可以一键还原。',
                helpMcpT: '接上外部的工具服务',
                helpMcpB: '新建时填命令或 URL；已保存的密钥留空即保持不变。注意：查看原文是整段替换，保存前会警告。',
                helpToolsT: '只留模型真正需要的工具',
                helpToolsB: '点「工具 n/m」勾选保留项。注意：对该安装的所有会话生效。',
                helpBuiltinT: '有些行为什么改不动',
                helpBuiltinB: '内置界面随客户端打包；宿主托管由客户端配置决定。注意：面板只读，改要动 profile。',
                helpDetailHint: '完整说明在插件详情页',
                diagView: '看诊断',
                diagTitle: '诊断',
                diagEmpty: '这一行没有附带诊断文本；先看宿主日志与 patch 解析结果。',
                historyView: '历史',
                historyTitle: '操作历史',
                historyEmpty: '还没有记录',
                configExport: '导出配置',
                configImport: '导入配置',
                configImported: '配置已导入',
            configReplaceWarn: '替换会把现有的分组、分组群、预设与工具屏蔽整体覆盖，只保留回滚点。',
            configReplaceAck: '我了解现有分组与预设会被覆盖',
                configMode: '导入方式',
                oauthLogin: 'OAuth 登录',
                oauthTitle: 'OAuth 授权',
                oauthOpen: '打开授权页',
                oauthCode: '授权码',
                oauthCodeHint: '授权后浏览器会跳到一个打不开的地址，把地址里的 code 参数粘到这里',
                oauthDone: 'OAuth 登录成功',
                oauthFailed: 'OAuth 失败：{why}',
                lensAll: '全部',
                lensMcp: 'MCP',
                facetOrigin: '来源',
                facetShape: '形态',
                facetSkill: '技能',
                facetUi: '有界面',
                facetHost: '纯后端',
                rowsFiled: '已把 {n} 项加入「{name}」',
            lensOfficial: '官方',
            lensThird: '第三方',
            lensBase: '常开',
            lensTask: '按需',
            confirmSharedTitle: '有成员也在别的分组里',
            confirmSharedBody: '「{name}」里有 {shared} 项同时属于别的分组：{names}。只处理本组独有的 {own} 项，还是连这些一起处理？',
            confirmOnlyOwn: '只处理本组独有（{own} 项）',
            confirmAll: '连共有的也一起处理（{all} 项）',
            baseWarning: '存在基础插件，禁用可能导致界面异常。',
            undoSaved: '已切换「{name}」的 {n} 项。',
            undoActionOff: '禁用',
            undoActionOn: '启用',
            failHint: '宿主拒绝了这次操作',
            undoLabel: '撤销',
            undoDone: '已撤销',
            failSummary: '成功 {ok} 项，失败 {failed} 项（被宿主托管拒绝）',
            staleChip: '{n} 项已失效',
            staleHint: '清理：成员对应的插件已不在，点一下从分组里移除',
            staleDone: '已清理 {n} 项失效成员',
            confirmGroupTitle: '确认整组操作',
                confirmGroupBody: '将对「{name}」的 {n} 项执行「{action}」。已经写下的状态可以再改回来。',
                confirmPresetTitle: '确认应用预设',
                confirmPresetBody: '将开启 {on} 项、关闭 {off} 项。',
                confirmPresetMcp: '其中 MCP 服务器：开启 {on} 个、关闭 {off} 个。',
                presetMcpCount: '含 MCP {n} 个',
                applyNow: '执行',
        };
        const en = {
                navTitle: 'Tool Hub',
                tabLabel: 'Hub',
                heading: 'Tool Hub',
                sub: '{p} plugins on · {s} skills',
                pillOn: '{n} on',
                pillSkills: '{n} skills',
                pillAll: '{n} total',
                viewAll: 'All',
                viewPlugins: 'Plugins',
                viewSkills: 'Skills',
                viewMcp: 'MCP · {n}',
                pillMcp: '{n} MCP',
                mcpBadge: 'MCP',
                mcpEdit: 'Edit config',
                mcpEditTitle: 'MCP server config',
                mcpEditHint: 'Edit config: name, command, env or headers (rewrites only this config block; HMR applies it)',
                mcpBadgeHint: 'MCP: an external server; expand it to edit the tool allow-list',
                mcpName: 'Server name',
                mcpTransport: 'Transport',
                mcpCommand: 'Command',
                mcpArgs: 'Arguments (one per line)',
                mcpEnv: 'Environment (KEY=VALUE per line)',
                mcpCwd: 'Working directory',
                mcpUrl: 'URL',
                mcpTimeout: 'Call timeout (ms)',
                mcpFailFast: 'Fail when startup fails',
                mcpSave: 'Save',
                mcpSaved: 'Written, waiting for the reload…',
            mcpTest: 'Test',
            mcpTesting: 'Connecting…',
            mcpTestOk: 'Connected · {n} tools · {ms}ms',
            mcpTestFail: 'Failed: {message}',
            mcpTestAborted: 'The test did not finish',
                mcpNoConfig: 'This row is not in the profile patch, so its config cannot be edited here.',
                mcpCreate: 'Add server',
                mcpCreateTitle: 'Add an MCP server',
                mcpNameRule: 'Letters, digits, - and _ only, up to 32 characters.',
                mcpBadName: 'Invalid name: letters, digits, - and _ only, 1–32 characters.',
                mcpHeaders: 'Headers (one KEY=VALUE per line)',
                mcpAdvanced: 'Advanced',
                mcpReconnect: 'Reconnect automatically',
                mcpReconnectInit: 'First retry delay (ms)',
                mcpReconnectMax: 'Max retry delay (ms)',
                mcpReconnectTries: 'Max attempts',
                mcpDelete: 'Delete',
                mcpDeleteHint: 'Delete: removes this MCP connection and its tools',
                mcpDeleteTitle: 'Delete an MCP server',
                mcpDeleteBody: 'Removes the “{name}” entry from the profile cordis.patch.yml and leaves the rest of the file untouched.',
                mcpDeleteDone: 'Deleted, waiting for the reload…',
                mcpInvalidNumber: 'The timeout has to be a number.',
                mcpBadEnv: 'This line is not KEY=VALUE: {line}',
                toolsButton: 'Tools · {on}/{total}',
                toolsTitle: 'MCP tools',
                toolsHint: 'Tools: hide the checked ones from the model tool list (all sessions in this install)',
                toolsEmpty: 'This server has not registered any tool yet. Enable it, wait for the host to connect, then reload.',
                toolsSearch: 'Filter tools',
                toolsAll: 'All',
                toolsNone: 'None',
                toolsSaved: 'Tool settings saved',
                toolsPanelNote: '{n} more are disabled by the Skill / MCP panel (read-only)',
                toolsImport: 'Import their {n}',
                toolsImported: 'Imported {n}',
    lazyOn: 'Lazy',
    lazyActive: 'Lazy on',
    lazyHint: 'Hide every tool of this server from the model tool list; hub_tools loads them on demand.',
    lazyDone: 'Lazy loading on',
    lazyOff: 'Lazy loading off',
                toolsCount: '{n} tools',
                groups: 'Groups',
                newGroup: 'New group',
                search: 'Search name or module',
                empty: 'Nothing here yet',
                emptyGroup: 'This group is empty. Tick rows on the right, then Add to group.',
                loading: 'Loading…',
                reload: 'Refresh',
                enable: 'Enable',
                disable: 'Disable',
                enabled: 'On',
                disabled: 'Off',
                selected: '{n} selected',
                addToGroup: 'Add to group',
                clearSelection: 'Clear',
                toggleGroupOn: 'Enable all (each member keeps its own state)',
                toggleGroupOff: 'Disable all (lists shared members first)',
                rename: 'Rename (changes the group name only)',
            moveUp: 'Move up (one place earlier in this group)',
            moveDown: 'Move down (one place later in this group)',
                remove: 'Delete group (members and skills are kept)',
                removeConfirm: 'Delete the group “{name}”? Its members keep their own state.',
                readonly: 'Host-managed',
                readonlyHint: 'Host-managed: set by the client config, read-only here',
                autoTag: 'Generated by auto grouping',
                officialBadge: 'Official',
                officialHint: 'Official: ships with the client; upgrades overwrite local edits',
                selfBadge: 'This plugin',
                selfHint: 'This plugin: the panel itself cannot be disabled',
                restart: 'Needs restart',
                overridden: 'Overridden by a higher layer',
                preset: 'Presets',
                presetTitle: 'Presets',
                presetHint: 'A preset stores the set you have on. Applying one turns on what it lists and turns off what it does not.',
                presetSave: 'Save current as preset',
                presetName: 'Preset name',
                presetApply: 'Apply',
                presetDelete: 'Delete',
                presetEmpty: 'No presets yet',
                presetApplied: 'Applied {n}/{total} changes',
            presetDeferred: 'Preset applied; masks for its servers land once their tools register',
            compatBadge: 'Compat',
            compatHint: 'Compat: an older panel is present; patch writes take its lock first',
            marketImport: 'Import dshmarket groups ({n})',
            marketImportTitle: 'Import dshmarket groups',
            marketImportHint: 'Reads dshmarket state.json and copies its groups here; groups with a name you already use are skipped.',
            marketImportConfirm: 'Import',
            marketImportDone: 'Imported {n} groups',
            marketImportRow: '{members} plugins / {packages} packages',
            marketImportMissing: '{n} packages are not installed and were skipped',
            marketNoGroups: 'Nothing to import',
                presetOnlyOn: 'Only switch on',
                presetUpdate: 'Update',
                presetUpdateTitle: 'Update preset',
                presetUpdateBody: 'Overwrite "{name}" with what is on right now? The old record is replaced.',
                presetUpdated: 'Updated "{name}"',
            thirdOff: 'Third-party off',
            thirdOffTitle: 'Turn off every third-party feature',
            thirdOffHint: 'Switches only: nothing is uninstalled. Official and host-managed rows stay; a rollback point is written first.',
            thirdOffWarn: '{n} of them are always-on or interface plugins, so the UI may break.',
            thirdOffAck: 'I understand the interface may break, and the rollback point is saved',
            thirdOffApply: 'Turn off all ({n})',
            thirdWorking: 'Working…',
            builtinUiBadge: 'Built-in UI',
            builtinUiHint: 'Built-in UI: packed with the client, cannot be changed here',
            toggleRefused: 'That switch did not take effect: {why}',
            filterLead: 'Filtered:',
            filterClear: 'Clear filters',
            filterView: 'view {label}',
            filterOrigin: 'origin {label}',
            filterShape: 'shape {label}',
            viewMcpShort: 'MCP',
            thirdOffDone: 'Turned off {n}, rollback {file}',
            thirdOffBusy: 'Turning off {n} items one by one (~30–60s); the buttons grey out meanwhile.',
            thirdOffEmpty: 'Nothing third-party is on.',
            thirdRestore: 'Restore',
            thirdRestoreTitle: 'Restore what was on',
            thirdRestoreBody: 'Re-open {n} items from {file}?',
            thirdRestoreBusy: 'Restoring {n} items (~30–60s); the buttons grey out meanwhile.',
            thirdRestoreDone: 'Restored {n}',
            thirdRollback: 'rollback {file}',
            thirdKindPlugin: 'Plugins',
            thirdKindSkill: 'Skills',
            thirdKindMcp: 'MCP servers',
                groupRemove: 'Remove',
                groupRemoved: 'Removed {n} from this group',
                removeFromGroup: 'Remove from group',
                auto: 'Auto group',
                autoTitle: 'Auto group preview',
                autoHint: 'Grouped by the rule table. Nothing is written until you confirm.',
                autoApply: 'Apply to groups',
                autoEmpty: 'Nothing to auto group',
                resizeRail: 'Drag to resize the rail, double-click to reset',
            roleOfficial: 'OFFICIAL',
            roleBase: 'GENERAL',
            roleRest: 'DOWNLOADED',
            toggleBaseOff: 'Disable the base group (can break the chain; asks first)',
            roleMcp: 'MCP SERVERS',
            roleSkill: 'SKILLS',
            roleLoose: 'MANUAL',
            railEmptyTitle: 'No groups yet',
                railEmptyBody: 'Auto grouping sorts plugins and skills into a few groups by rule. You see a preview first; nothing is written until you apply it.',
                railEmptyAction: 'Auto group',
                autoDone: 'Created {n} automatic groups',
                cancel: 'Cancel',
                close: 'Close',
                mcpDiscardHint: 'Press Esc again, or click outside, to discard these edits.',
                retry: 'Retry',
                historyCapped: 'latest {shown} of {total}',
                deleteVerb: 'Delete',
                rowFailed: 'failed',
                badgePanel: 'panel',
                modeMerge: 'Merge',
                modeReplace: 'Replace',
                oauthNoUrl: 'the host returned no authorize URL or state',
                oauthClipboardBlocked: 'the browser blocked the clipboard',
                oauthClipboardUnavailable: 'no clipboard in this environment',
                groupPickEmpty: 'No groups yet — create one first',
                bulkOnTitle: 'Turn the selection on',
                bulkOffTitle: 'Turn the selection off',
                bulkOnBody: 'This opens {n} selected items one by one.',
                bulkOffBody: 'This closes {n} selected items one by one; a base plugin going off can break the UI.',
                bulkGo: 'Continue ({n})',
                thirdOffFailed: 'Could not read the third-party list: {why}',
                presetDeleted: 'Preset deleted.',
                presetDeleteTitle: 'Delete preset',
                presetDeleteBody: 'Delete "{name}"? The record goes away; switches it applied stay as they are.',
                save: 'Save',
                groupName: 'Group name',
            collectionNew: 'New collection',
            collectionHint: 'A collection only shelves groups together; it does not change what they switch.',
            collectionName: 'Collection name',
            collectionAddGroup: 'New group in this collection',
            collectionRename: 'Rename collection',
            collectionDelete: 'Delete collection',
            collectionDeleteTitle: 'Delete collection',
            collectionDeleteBody: '“{name}” goes away and its groups move to the default collection. The groups themselves stay.',
            collectionDeleted: 'Collection deleted',
            collapseModule: 'Collapse these entries',
            expandModule: 'Expand these entries',
            collectionCollapse: 'Collapse this collection',
            collectionExpand: 'Expand this collection',
            looseTitle: 'No collection',
            looseHint: 'Groups that belong to no collection. Drag a group onto a collection to file it, or back here to take it out.',
                stale: '{n} members are no longer listed',
                moved: '{n} updated',
                failed: '{n} failed',
                statePath: 'State file',
                noManager: 'This host exposes no plugin manager, so the plugin list is unavailable.',
                confirmExact: 'Applying also switches off {off} rows that are on now. Continue?',
                applyAnyway: 'Apply anyway',
                membersCount: '{n} items',
            statHint: "{on} on · {off} off",
                kindPlugin: 'Plugin',
                kindSkill: 'Skill',
                skillRoots: 'Skill folders',
                skillScopeGlobal: 'Global',
                skillScopeWorkspace: 'Workspace · {name}',
                skillPreview: 'Preview',
                skillPreviewTitle: 'Skill source',
                skillPreviewHint: 'Preview: read the skill source without changing the file',
                skillPreviewTruncated: 'Large file: only the first 200 KB is shown',
                skillDelete: 'Delete',
                skillDeleteHint: 'Delete: moves it to the trash; undo within 10 s',
                skillDeleteTitle: 'Delete skill',
                skillDeleteBody: 'Moves “{name}” to the trash folder; you have 10 seconds to undo.',
                skillDeleted: 'Moved to the trash folder',
                undoDelete: 'Undo',
                skillRestored: 'Restored',
                secretKeep: 'Set — leave blank to keep it',
                secretHint: 'A value of ${NAME} reads that environment variable',
                rawView: 'View source',
                rawViewHint: 'View source: read this MCP entry’s config fragment (read-only)',
                rawTitle: 'Source of {name}',
                rawEdit: 'Advanced: edit directly',
                rawWarn: 'Whole-entry replace: the indentation, fields and formatting are yours to keep correct.',
                rawSaved: 'Source saved',
                rawInvalid: 'That entry is not valid: {why}',
                copy: 'Copy',
                copied: 'Copied',
                skillImport: 'Import skills',
                skillImportTitle: 'Import skills',
                skillImportPath: 'Local path (.md / folder / .zip)',
                skillImportTarget: 'Target folder',
                skillImportOverwrite: 'Overwrite a skill with the same name',
                skillImportDone: 'Imported {added}, skipped {skipped}',
                skillMove: 'Move to…',
                skillMoveTitle: 'Move skill',
                skillMoveTarget: 'Target folder',
                skillMoveHint: 'Move: relocate the skill folder to another root',
                skillMoveNone: 'No other skill folder is available',
                skillMoved: 'Moved to {name}',
                bundleView: 'By bundle',
                bundleAll: 'All',
                bundleRows: '{n} rows',
                showDesc: 'Show descriptions',
                hideDesc: 'Hide descriptions',
                helpOpen: 'Open help (eight sections, three lines each)',
                helpTitle: 'How this panel works',
                helpHint: 'Three lines per section: what it solves / how to use it / one caution',
                helpFilterT: 'Hide what you do not want to see',
                helpFilterB: 'Filter by origin, shape, keyword or bundle; click again to clear. Caution: it only changes the list, never a switch.',
                helpGroupT: 'Collect frequent tools in one drawer',
                helpGroupB: 'Use + in the rail, then drag rows in; collections sort the groups. Caution: a group switch flips its members themselves.',
                helpAutoT: 'Sort the same kind of thing at once',
                helpAutoB: 'Builds groups from official / third-party / MCP rules, skipping names that already exist. Caution: it lists the plan first.',
                helpPresetT: 'Save and restore a whole switch state',
                helpPresetB: 'Save the current state at the bottom; apply exactly or only enable. Caution: export a JSON backup any time.',
                helpThirdT: 'Keep only official and host-managed rows',
                helpThirdB: 'Writes a rollback point first, then disables third-party entries. Caution: one click restores it.',
                helpMcpT: 'Attach an external tool server',
                helpMcpB: 'Enter a command or URL; leave a saved secret blank to keep it. Caution: the raw view replaces the whole entry and warns first.',
                helpToolsT: 'Keep only the tools the model needs',
                helpToolsB: 'Open “tools n/m” and tick what stays. Caution: this affects every session in the install.',
                helpBuiltinT: 'Why some rows cannot change',
                helpBuiltinB: 'Built-in UI ships in the client bundle; host-managed rows follow the client config. Caution: edit the profile instead.',
                helpDetailHint: 'Full documentation lives on the plugin detail page',
                diagView: 'Diagnose',
                diagTitle: 'Diagnostics',
                diagEmpty: 'This row carries no diagnostic text; check the host log and the patch parse result.',
                historyView: 'History',
                historyTitle: 'Operation history',
                historyEmpty: 'Nothing recorded yet',
                configExport: 'Export config',
                configImport: 'Import config',
                configImported: 'Config imported',
            configReplaceWarn: 'Replace overwrites every group, collection, preset and tool mask; only a rollback copy is kept.',
            configReplaceAck: 'I understand the current groups and presets will be overwritten',
                configMode: 'Import mode',
                oauthLogin: 'OAuth login',
                oauthTitle: 'OAuth authorisation',
                oauthOpen: 'Open the authorisation page',
                oauthCode: 'Authorisation code',
                oauthCodeHint: 'After approving, the browser lands on an unreachable URL — paste its code parameter here',
                oauthDone: 'OAuth login complete',
                oauthFailed: 'OAuth failed: {why}',
                lensAll: 'All',
                lensMcp: 'MCP',
                facetOrigin: 'Origin',
                facetShape: 'Shape',
                facetSkill: 'Skill',
                facetUi: 'Has UI',
                facetHost: 'Headless',
                rowsFiled: 'Filed {n} into "{name}"',
            lensOfficial: 'Official',
            lensThird: 'Third-party',
            lensBase: 'Always on',
            lensTask: 'Per task',
            confirmSharedTitle: 'Some members live in other groups too',
            confirmSharedBody: '{shared} of the {all} items in “{name}” are also listed elsewhere: {names}. Handle only the {own} this group owns, or all of them?',
            confirmOnlyOwn: 'Only this group owns ({own})',
            confirmAll: 'All of them ({all})',
            baseWarning: 'Base plugins are in this group; disabling them can break the interface.',
            undoSaved: '{n} items in “{name}” were switched. ',
            undoActionOff: '',
            undoActionOn: '',
            failHint: 'The host refused this change',
            undoLabel: 'Undo',
            undoDone: 'Undone',
            failSummary: '{ok} done, {failed} refused by the host',
            staleChip: '{n} gone',
            staleHint: 'Clean up: these members no longer exist; click to drop them',
            staleDone: 'Dropped {n} stale members',
            confirmGroupTitle: 'Confirm group action',
                confirmGroupBody: 'This will {action} all {n} items in “{name}”. Anything written here can be switched back.',
                confirmPresetTitle: 'Confirm preset',
                confirmPresetBody: 'This turns on {on} and turns off {off}.',
                confirmPresetMcp: 'Of those, MCP servers: {on} on, {off} off.',
                presetMcpCount: '{n} of them MCP',
                applyNow: 'Apply',
        };

        /** Fill {name} placeholders in a dictionary string. */
        function fmt(t, key, vars) {
            const raw = typeof t === 'function' ? t(key) : key;
            if (typeof raw !== 'string') return key;
            if (vars === undefined) return raw;
            return raw.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
        }

        // Section labels for a group's role. Old state files may still say task/skill; those groups
        // are migrated to "rest" on load, but the label stays readable if one slips through.
        // A role that is not a string (hand-edited state, a row without one) yields "" instead of
        // throwing: this runs during render, so a bad value must not blank the whole panel.
        function roleLabel(t, role) {
            if (typeof role !== "string") return "";
            const key = role === "official" ? "roleOfficial"
                : role === "mcp" ? "roleMcp"
                    : role === "base" ? "roleBase"
                        : "roleRest";
            const label = typeof t === "function" ? t(key) : key;
            return typeof label === "string" ? label : "";
        }

        // ── host calls ─────────────────────────────────────────────────────
        async function call(path, init) {
            const response = await fetch(path, init);
            let body = null;
            try {
                body = await response.json();
            }
            catch {
                throw new Error(`tool-hub: ${response.status} ${response.statusText}`);
            }
            if (body === null || body.ok !== true) {
                const message = body && body.error && body.error.message ? body.error.message : "request failed";
                const error = new Error(message);
                error.code = body && body.error ? body.error.code : "unknown";
                throw error;
            }
            return body.data;
        }

        function readSnapshot() {
            return call("/tool-hub/api/snapshot", { method: "GET", headers: { accept: "application/json" } });
        }

        function runOp(op, payload) {
            return call("/tool-hub/api/op", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ op, payload }),
            });
        }

        // ── small pieces ───────────────────────────────────────────────────
        function Switch({ checked, disabled, onChange, label }) {
            return h("button", {
                type: "button",
                role: "switch",
                "aria-checked": checked === true,
                "aria-label": label,
                disabled: disabled === true,
                onClick: () => {
                    if (disabled !== true) onChange(checked !== true);
                },
                className: "hub-switch",
                style: {
                    position: "relative",
                    flex: "0 0 auto",
                    width: 34,
                    height: 20,
                    padding: 0,
                    borderRadius: 999,
                    border: `1px solid ${checked === true ? "transparent" : T.border}`,
                    background: checked === true ? T.brand : T.seg,
                    cursor: disabled === true ? "not-allowed" : "pointer",
                    opacity: disabled === true ? 0.45 : 1,
                    transition: "background .15s ease",
                },
            }, h("span", {
                style: {
                    position: "absolute",
                    top: 2,
                    left: checked === true ? 16 : 2,
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    background: checked === true ? T.onBrand : "var(--dsw-alias-switch-thumb, #fff)",
                    boxShadow: "0 1px 2px rgba(0,0,0,.28)",
                    transition: "left .15s ease",
                },
            }));
        }

        function Badge({ children, tone, title }) {
            const palette = tone === "warn"
                ? { fg: T.warn, bg: tint(T.warn, 12), border: tint(T.warn, 30) }
                : tone === "danger"
                    ? { fg: T.danger, bg: tint(T.danger, 12), border: tint(T.danger, 30) }
                    : tone === "brand"
                        ? { fg: T.brand, bg: tint(T.brand, 12), border: tint(T.brand, 30) }
                        : tone === "success"
                            ? { fg: T.success, bg: tint(T.success, 12), border: tint(T.success, 30) }
                            : { fg: T.text3, bg: "transparent", border: T.borderSoft };
            return h("span", {
                title,
                "aria-label": title,
                style: {
                    flex: "0 0 auto",
                    padding: "1px 6px",
                    borderRadius: 5,
                    border: `1px solid ${palette.border}`,
                    background: palette.bg,
                    color: palette.fg,
                    fontSize: 11,
                    lineHeight: "16px",
                    whiteSpace: "nowrap",
                },
            }, children);
        }

        function Button({ children, onClick, tone, disabled, title, small }) {
            const [hover, setHover] = React.useState(false);
            const primary = tone === "primary";
            const danger = tone === "danger";
            const background = disabled === true
                ? T.seg
                : primary
                    ? (hover ? "var(--dsw-alias-button-primary-hover, #3f5fe0)" : T.brand)
                    : danger
                        ? (hover ? "var(--dsw-alias-interactive-bg-hover-danger, rgba(229,72,77,.16))" : "transparent")
                        : (hover ? T.cardHover : T.card);
            return h("button", {
                type: "button",
                title,
                "aria-label": title,
                disabled: disabled === true,
                onClick: disabled === true ? undefined : onClick,
                onMouseEnter: () => setHover(true),
                onMouseLeave: () => setHover(false),
                style: {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    height: small === true ? 26 : 30,
                    padding: small === true ? "0 9px" : "0 12px",
                    borderRadius: 8,
                    border: `1px solid ${primary ? "transparent" : danger ? T.borderSoft : T.border}`,
                    background,
                    color: disabled === true ? T.text3 : primary ? T.onBrand : danger ? T.danger : T.text,
                    fontSize: 12.5,
                    fontWeight: primary ? 600 : 500,
                    cursor: disabled === true ? "not-allowed" : "pointer",
                    opacity: 1,
                    whiteSpace: "nowrap",
                    transition: "background .12s ease",
                    fontFamily: "inherit",
                },
            }, children);
        }

        function Input({ value, onChange, placeholder, onEnter, autoFocus, grow }) {
            return h("input", {
                value,
                autoFocus: autoFocus === true,
                placeholder,
                onChange: event => onChange(event.target.value),
                onKeyDown: (event) => {
                    if (event.key === "Enter" && typeof onEnter === "function") onEnter();
                },
                style: {
                    height: 30,
                    width: grow === true ? "100%" : undefined,
                    boxSizing: "border-box",
                    padding: "0 10px",
                    borderRadius: 8,
                    border: `1px solid ${T.border}`,
                    background: T.base,
                    color: T.text,
                    fontSize: 12.5,
                    outline: "none",
                    minWidth: 0,
                    fontFamily: "inherit",
                },
            });
        }

        function Dialog({ title, hint, onClose, children, footer, width }) {
            // The keydown listener is installed once, but `onClose` is a fresh closure on every
            // parent render. Reading it through a ref keeps Escape from calling the first render's
            // callback (a stale dialog state), without re-subscribing on every render.
            const closeRef = useRef(onClose);
            const boxRef = useRef(null);
            useEffect(() => {
                closeRef.current = onClose;
            }, [onClose]);
            // Focus lives inside the dialog while it is open (Tab cycles there), and goes back to
            // whatever was focused before when it closes; otherwise a keyboard user lands on the
            // page behind the scrim after the first Tab.
            useEffect(() => {
                if (typeof document === "undefined") return undefined;
                const box = boxRef.current;
                const previous = document.activeElement;
                const focusables = () => Array.prototype.slice
                    .call(box === null ? [] : box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
                    .filter(node => node.disabled !== true && node.offsetParent !== null);
                const first = focusables()[0];
                if (first !== undefined) first.focus();
                const trap = (event) => {
                    if (event.key !== "Tab") return;
                    const list = focusables();
                    if (list.length === 0) return;
                    const firstNode = list[0];
                    const lastNode = list[list.length - 1];
                    if (event.shiftKey === true && document.activeElement === firstNode) {
                        event.preventDefault();
                        lastNode.focus();
                    } else if (event.shiftKey === false && document.activeElement === lastNode) {
                        event.preventDefault();
                        firstNode.focus();
                    }
                };
                document.addEventListener("keydown", trap, true);
                return () => {
                    document.removeEventListener("keydown", trap, true);
                    if (previous !== null && previous.isConnected === true && typeof previous.focus === "function") previous.focus();
                };
            }, []);
            useEffect(() => {
                if (typeof document === "undefined") return undefined;
                const onKey = (event) => {
                    if (event.key === "Escape") closeRef.current();
                };
                document.addEventListener("keydown", onKey);
                return () => document.removeEventListener("keydown", onKey);
            }, []);
            return h("div", {
                className: "hub-scrim",
                onClick: event => {
                    if (event.target === event.currentTarget) onClose();
                },
                style: {
                    position: "fixed",
                    inset: 0,
                    zIndex: 80,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: T.overlay,
                    padding: 24,
                },
            }, h("div", {
                className: "hub-pop",
                ref: boxRef,
                role: "dialog",
                "aria-modal": "true",
                "aria-label": title,
                style: {
                    width: width === undefined ? 520 : width,
                    maxWidth: "100%",
                    maxHeight: "82vh",
                    display: "flex",
                    flexDirection: "column",
                    borderRadius: 14,
                    border: `1px solid ${T.border}`,
                    background: "var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-layer-2, #1c1c1e))",
                    boxShadow: "0 18px 48px rgba(0,0,0,.34)",
                    color: T.text,
                    overflow: "hidden",
                },
            }, h("div", {
                style: { padding: "14px 16px 10px", borderBottom: `1px solid ${T.borderSoft}` },
            }, h("div", { style: { fontSize: 14, fontWeight: 600 } }, title),
            hint === undefined ? null : h("div", { style: { marginTop: 4, fontSize: 12, color: T.text3, lineHeight: 1.5 } }, hint)),
            children === undefined ? null : h("div", { style: { padding: "12px 16px", overflow: "auto", minHeight: 0 } }, children),
            footer === undefined ? null : h("div", {
                style: {
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                    padding: "10px 16px 14px",
                    borderTop: `1px solid ${T.borderSoft}`,
                },
            }, footer)));
        }

        // ── main view ──────────────────────────────────────────────────────
        function ToolHub({ t, embedded }) {
            const [data, setData] = useState(null);
            const [error, setError] = useState(null);
            const [busy, setBusy] = useState(false);
            // Several requests can be in flight (a bulk plus a refresh, two row switches);
            // a boolean lets the first completion re-enable the switches mid-write.
            const busyCount = useRef(0);
            const beginBusy = useCallback(() => {
                busyCount.current += 1;
                setBusy(true);
            }, []);
            const endBusy = useCallback(() => {
                busyCount.current = Math.max(0, busyCount.current - 1);
                if (busyCount.current === 0) setBusy(false);
            }, []);
            const [note, setNote] = useState(null);
            // The last tab is worth remembering: people come back to the same view (skills, MCP,
            // a lens) far more often than they start over from "all".
            const [view, setView] = useState(() => {
                try {
                    const kept = window.localStorage.getItem("toolHubView");
                    return kept === "plugin" || kept === "skill" || kept === "mcp" || kept === "all" ? kept : "all";
                }
                catch {
                    return "all";
                }
            });
            useEffect(() => {
                try {
                    window.localStorage.setItem("toolHubView", view);
                }
                catch { /* ignore */ }
            }, [view]);
            const [groupId, setGroupId] = useState(null);
            const [query, setQuery] = useState("");
            const [picked, setPicked] = useState(() => new Set());
            const [dialog, setDialog] = useState(null);
            const dirty = useRef(false);

            const [thirdSnapshot, setThirdSnapshot] = useState(null);
            const [thirdError, setThirdError] = useState(null);

            const loadThird = useCallback(async () => {
                try {
                    const result = await runOp("thirdparty.status");
                    setThirdSnapshot(result.snapshot ?? null);
                    setThirdError(null);
                    return result;
                }
                catch (failure) {
                    // An empty list reads as "nothing third-party is on"; a failed read must not look like that.
                    setThirdSnapshot(null);
                    setThirdError(failure?.message ?? "thirdparty.status failed");
                    return { targets: [], snapshot: null, error: failure?.message ?? "thirdparty.status failed" };
                }
            }, []);

            const openThird = useCallback(async () => {
                const status = await loadThird();
                const rows = Array.isArray(status.targets) ? status.targets : [];
                setDialog({ kind: "thirdOffer", rows, snapshot: status.snapshot ?? null, error: status.error ?? thirdError });
            }, [loadThird]);

            const openRestore = useCallback(() => {
                setDialog({ kind: "thirdRestore", snapshot: thirdSnapshot });
            }, [thirdSnapshot]);

            // Two ops in flight can resolve out of order; a stale GET must not overwrite a newer one.
            const refreshSeq = useRef(0);
            const refresh = useCallback(async () => {
                const seq = ++refreshSeq.current;
                try {
                    const next = await readSnapshot();
                    if (seq !== refreshSeq.current) return;
                    setData(next);
                    setError(null);
                }
                catch (failure) {
                    if (seq !== refreshSeq.current) return;
                    setError(failure.message);
                }
            }, []);

            useEffect(() => {
                refresh();
                void loadThird();
            }, []);

            const flash = useCallback((message) => {
                setNote(message);
                setTimeout(() => setNote(current => (current === message ? null : current)), 3200);
            }, []);

            const act = useCallback(async (op, payload, after) => {
                beginBusy();
                try {
                    const result = await runOp(op, payload);
                    if (typeof after === "function") after(result);
                    await refresh();
                    return result;
                }
                catch (failure) {
                    // The host sends a code with every refusal; a client-bundled UI plugin has
                    // its own wording so the toast does not read like a crash.
                    if (failure?.code === "builtin-ui") flash(fmt(t, "toggleRefused", { why: failure.message }));
                    else flash(failure.message);
                    return null;
                }
                finally {
                    endBusy();
                }
            }, [refresh, flash]);

            const groups = data === null ? [] : data.groups;
        const collections = data === null ? [] : (data.collections ?? []);
        const [dragId, setDragId] = useState(null);
        const [expanded, setExpanded] = useState(() => {
            try {
                const raw = window.localStorage.getItem("toolHubExpanded");
                const list = raw === null ? [] : JSON.parse(raw);
                return new Set(Array.isArray(list) ? list : []);
            }
            catch {
                return new Set();
            }
        });
        const toggleCollapsed = (id) => {
            setExpanded((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                try {
                    window.localStorage.setItem("toolHubExpanded", JSON.stringify([...next]));
                }
                catch { /* private mode: the rail simply forgets */ }
                return next;
            });
        };
        const moveInto = async (groupId, collection) => {
            await act("group.move", { id: groupId, collection });
        };
        const [dropAt, setDropAt] = useState(null);
        // One row per module is the default; a module that mounts several loader entries unfolds
        // into its entries, so the list reads as a tree instead of the same name eight times.
        const [openModules, setOpenModules] = useState(() => new Set());
        const [railWidth, setRailWidth] = useState(() => {
            try {
                const stored = Number(window.localStorage.getItem("toolHubRailWidth"));
                return Number.isFinite(stored) && stored >= 180 && stored <= 460 ? stored : 220;
            }
            catch {
                return 220;
            }
        });
        const [resizing, setResizing] = useState(false);
        const railDrag = useRef(null);
        // The rail keeps its width across reloads because the number is the only thing a window
        // resize should not decide; 180-460 keeps both columns usable.
        const startResize = event => {
            event.preventDefault();
            railDrag.current = { x: event.clientX, width: railWidth };
            setResizing(true);
            const move = ev => {
                const start = railDrag.current;
                if (start === null) return;
                setRailWidth(Math.max(180, Math.min(460, start.width + (ev.clientX - start.x))));
            };
            const finish = () => {
                railDrag.current = null;
                setResizing(false);
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", finish);
                setRailWidth(current => {
                    try { window.localStorage.setItem("toolHubRailWidth", String(current)); }
                    catch { /* storage may be unavailable; the width simply will not persist */ }
                    return current;
                });
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", finish);
        };
        // Inside a drawer the three kept-on buckets come first, then whatever was downloaded.
        const roleRank = { official: 0, mcp: 1, base: 2, rest: 3 };
        const byRole = (left, right) =>
            (roleRank[left.role] ?? 9) - (roleRank[right.role] ?? 9) || left.name.localeCompare(right.name);
        // Facets answer "show me only…" and own no switch, so a package can be found as
        // third-party and as headless without being flippable from two places at once. Every
        // facet is read from data the package itself declares: its module name or its
        // package.json. Nothing here is inferred from a description.
        const [origin, setOrigin] = useState("all");
        const [shape, setShape] = useState("all");
        const ORIGINS = [
            { id: "official", label: t("lensOfficial") },
            { id: "third", label: t("lensThird") },
            { id: "skill", label: t("facetSkill") },
            { id: "mcp", label: t("lensMcp") },
        ];
        const SHAPES = [
            { id: "ui", label: t("facetUi") },
            { id: "host", label: t("facetHost") },
        ];
        const [failKeys, setFailKeys] = useState(() => new Set());
        const [undoInfo, setUndoInfo] = useState(null);
        useEffect(() => {
            if (undoInfo === null) return undefined;
            const timer = setTimeout(() => setUndoInfo(null), 10000);
            return () => clearTimeout(timer);
        }, [undoInfo]);
        // A deleted skill sits in the trash for ten seconds with a way back; the timer only
        // drops the button, the trash entry itself stays until the host prunes it.
        const [skillUndo, setSkillUndo] = useState(null);
        useEffect(() => {
            if (skillUndo === null) return undefined;
            const timer = setTimeout(() => setSkillUndo(null), 10000);
            return () => clearTimeout(timer);
        }, [skillUndo]);
        const undoSkillDelete = useCallback(async () => {
            const current = skillUndo;
            if (current === null) return;
            setSkillUndo(null);
            await act("skill.restore", { trashPath: current.trashPath }, () => flash(t("skillRestored")));
        }, [skillUndo, act, flash]);
        // The bundle lens swaps the left rail for the bundle list. `bundleSel` is the bundle
        // being looked at, so closing the lens has to clear it instead of leaving a filter that
        // no longer has a control.
        const [bundleMode, setBundleMode] = useState(false);
        const [bundleSel, setBundleSel] = useState(null);
        // Descriptions are noisy on a long list, so they get a switch. The choice sticks across
        // sessions; a browser that refuses localStorage just keeps the default (on).
        const [showDesc, setShowDesc] = useState(() => {
            try {
                if (typeof localStorage === "undefined") return true;
                return localStorage.getItem("toolHubShowDesc") !== "0";
            }
            catch (failure) {
                return true;
            }
        });
        useEffect(() => {
            try {
                if (typeof localStorage !== "undefined") localStorage.setItem("toolHubShowDesc", showDesc === true ? "1" : "0");
            }
            catch (failure) {
                // Private mode or a full quota: the switch still works for this session.
            }
        }, [showDesc]);
        // The help drawer introduces itself once, then only on demand. Without storage there is
        // nothing to remember, so it stays shut instead of reopening on every render.
        const [helpOpen, setHelpOpen] = useState(false);
        useEffect(() => {
            try {
                if (typeof localStorage === "undefined") return;
                if (localStorage.getItem("toolHubHelpSeen") === "1") return;
            }
            catch (failure) {
                return;
            }
            setHelpOpen(true);
        }, []);
        const closeHelp = useCallback(() => {
            setHelpOpen(false);
            try {
                localStorage.setItem("toolHubHelpSeen", "1");
            }
            catch (failure) {
                // Nothing to remember; the ? button still opens it again.
            }
        }, []);
        const originMatch = (row) => {
            if (origin === "all") return true;
            if (origin === "official") return row.official === true;
            if (origin === "third") return row.official !== true && row.kind === "plugin";
            if (origin === "skill") return row.kind === "skill";
            return row.mcp === true;
        };
        const shapeMatch = (row) => {
            if (shape === "all") return true;
            return row.surface === shape;
        };
        const facetMatch = (row) => originMatch(row) && shapeMatch(row);

        const drawers = collections.map(collection => ({
            collection,
            list: groups.filter(group => group.collection === collection.id).sort(byRole),
        }));
        // Groups that belong to no collection at all. Auto grouping parks 用户下载 here so the
        // drawers only carry the three things you keep on.
        const looseGroups = groups.filter(group => (group.collection ?? null) === null).sort(byRole);
        const sectionKey = group => (group.role !== null ? `role:${group.role}` : `col:${group.collection ?? "loose"}`);
        // The order array has to be the order on screen, or the move is computed against a list the
        // user cannot see; flatten the rail first, then move inside that array.
        const railIds = () => [
            ...drawers.flatMap(drawer => drawer.list.map(group => group.id)),
            ...looseGroups.map(group => group.id),
        ];
        // Dropping a row moves it in front of the row it was dropped on. A group belongs to a role
        // section, so a move within the section is meaningful; a drop from one section onto another
        // would be written and then ignored by the renderer, which is the "nothing happened" bug, so
        // it is refused instead of silently lost.
        const reorderGroups = (fromId, toId, after) => {
            if (fromId === "" || fromId === toId) return;
            const fromGroup = groups.find(group => group.id === fromId);
            const toGroup = groups.find(group => group.id === toId);
            if (fromGroup === undefined || toGroup === undefined) return;
            if (sectionKey(fromGroup) !== sectionKey(toGroup)) return;
            const ids = railIds();
            const from = ids.indexOf(fromId);
            if (from < 0 || ids.indexOf(toId) < 0) return;
            const moved = ids.splice(from, 1)[0];
            // Re-read the target index: removing the dragged row shifts everything after it.
            const to = ids.indexOf(toId) + (after === true ? 1 : 0);
            ids.splice(to, 0, moved);
            void act("group.reorder", { order: ids });
        };
        // Move a group one slot up or down inside the rail. Dragging is a pointer gesture that a
        // re-render can cancel halfway; these two buttons are the keyboard-reachable path to the
        // same write, and they make the persisted order visible without a drag.
        const moveGroup = (id, delta) => {
            const group = groups.find(entry => entry.id === id);
            if (group === undefined) return;
            // Same-section neighbours only: the section a group belongs to is part of its identity,
            // so "move up" past the section header would land in an order the renderer re-sorts away.
            const siblings = groups.filter(entry => sectionKey(entry) === sectionKey(group)).map(entry => entry.id);
            const at = siblings.indexOf(id);
            const next = at + delta;
            if (at < 0 || next < 0 || next >= siblings.length) return;
            const ids = railIds();
            const slot = ids.indexOf(id);
            const neighbour = ids.indexOf(siblings[next]);
            if (slot < 0 || neighbour < 0) return;
            const [moved] = ids.splice(slot, 1);
            ids.splice(neighbour + (delta > 0 ? 1 : 0), 0, moved);
            void act("group.reorder", { order: ids });
        };
        // The insertion line is drawn by writing to the DOM node directly. Keeping it in React state
        // re-rendered the row on every dragover, which is what made drops land nowhere.
        let dropLine = null;
        const clearDropLine = () => {
            if (dropLine === null) return;
            dropLine.style.borderTop = "2px solid transparent";
            dropLine.style.borderBottom = "2px solid transparent";
            dropLine = null;
        };
        const markDropLine = (node, after) => {
            if (dropLine !== null && dropLine !== node) clearDropLine();
            dropLine = node;
            node.style.borderTop = after === true ? "2px solid transparent" : `2px solid ${T.brand}`;
            node.style.borderBottom = after === true ? `2px solid ${T.brand}` : "2px solid transparent";
        };
        const groupRow = group => h("div", {
            key: group.id,
            draggable: true,
            "data-group-id": group.id,
            onDragStart: event => {
                setDragId(group.id);
                try { event.dataTransfer.setData("text/plain", group.id); }
                catch { /* some engines refuse to write during a drag */ }
            },
            onDragEnd: () => {
                setDragId(null);
                clearDropLine();
            },
            onDragOver: event => {
                // Dragging rows over a group means "file them here", which must not also reorder
                // groups; the two gestures carry different payloads, so the payload decides.
                if (dragRows !== null) {
                    event.preventDefault();
                    return;
                }
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                markDropLine(event.currentTarget, event.clientY > rect.top + rect.height / 2);
            },
            onDragLeave: event => {
                if (event.currentTarget.contains(event.relatedTarget)) return;
                if (dropLine === event.currentTarget) clearDropLine();
            },
            onDrop: event => {
                const rowsPayload = event.dataTransfer.getData("application/x-tool-hub-rows");
                if (rowsPayload !== "" && dragRows !== null) {
                    event.preventDefault();
                    clearDropLine();
                    let items = [];
                    try { items = JSON.parse(rowsPayload); }
                    catch { items = []; }
                    if (Array.isArray(items) && items.length > 0) void addRowsToGroup(group, items);
                    setDragRows(null);
                    return;
                }
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                const after = event.clientY > rect.top + rect.height / 2;
                const fromId = dragId ?? event.dataTransfer.getData("text/plain") ?? "";
                clearDropLine();
                reorderGroups(fromId, group.id, after);
                setDragId(null);
            },
            style: {
                opacity: dragId === group.id ? 0.4 : 1,
                borderTop: "2px solid transparent",
                borderBottom: "2px solid transparent",
            },
        }, h(GroupRow, {
            group,
            stats: groupStats.get(group.id) ?? null,
            accent: groupAccent(group.members.length).accent,
            accentDepth: groupAccent(group.members.length).accentDepth,
            t,
            active: groupId === group.id,
            onSelect: () => {
                setGroupId(group.id);
                setView("all");
                setPicked(new Set());
                lastPickRef.current = null;
            },
            onEnable: value => enableAllInGroup(group, value),
            onRename: () => setDialog({ kind: "rename", group }),
            onDelete: () => setDialog({ kind: "deleteGroup", group }),
            stale: staleByGroup.get(group.id) ?? 0,
            onClean: () => {
                void act("group.clean", { id: group.id }, result => flash(fmt(t, "staleDone", { n: result.removed })));
            },
            onMoveUp: () => moveGroup(group.id, -1),
            onMoveDown: () => moveGroup(group.id, 1),
            onDropRows: (items) => { void addRowsToGroup(group, items); },
        }));
            const plugins = data === null ? [] : data.plugins;
            const skills = data === null ? [] : data.skills;
        // P2 snapshot fields. Each one is optional in the contract, so an older host gets an empty
        // lens instead of a crash.
        const bundles = data === null || !Array.isArray(data.bundles) ? [] : data.bundles;
        const history = data === null || !Array.isArray(data.history) ? [] : data.history;
        const roots = skillRootList(data);
        // How much of each group is actually running. The rail answers "what will I break if I
        // flip this?" — a group whose members are all on is a different thing from a half-on one.
        const liveByMember = useMemo(() => {
            const map = new Map();
            for (const row of plugins) map.set(`plugin:${row.id}`, row.enabled === true);
            for (const row of skills) map.set(`skill:${row.id}`, row.enabled === true);
            return map;
        }, [plugins, skills]);
        const knownKeys = useMemo(() => {
            const set = new Set();
            for (const row of plugins) set.add(`plugin:${row.id}`);
            for (const row of skills) set.add(`skill:${row.id}`);
            return set;
        }, [plugins, skills]);
        const staleByGroup = useMemo(() => {
            const out = new Map();
            for (const group of groups) {
                let gone = 0;
                for (const member of group.members) if (!knownKeys.has(`${member.kind}:${member.id}`)) gone += 1;
                out.set(group.id, gone);
            }
            return out;
        }, [groups, knownKeys]);

        const groupStats = useMemo(() => {
            const out = new Map();
            for (const group of groups) {
                let on = 0;
                for (const member of group.members) if (liveByMember.get(`${member.kind}:${member.id}`) === true) on += 1;
                out.set(group.id, { on, total: group.members.length });
            }
            return out;
        }, [groups, liveByMember]);
        const sumStats = list => list.reduce((acc, group) => {
            const stat = groupStats.get(group.id);
            if (stat !== undefined) {
                acc.on += stat.on;
                acc.total += stat.total;
            }
            return acc;
        }, { on: 0, total: 0 });
        const statText = stat => (stat.total === 0 ? "0" : `${stat.on}/${stat.total}`);


            const memberKey = (kind, id) => `${kind}:${id}`;

            const groupMembers = useMemo(() => {
                const map = new Map();
                for (const group of groups) {
                    const set = new Set();
                    for (const member of group.members) set.add(memberKey(member.kind, member.id));
                    map.set(group.id, set);
                }
                return map;
            }, [groups]);

        const facetPool = useMemo(() => {
                const wanted = `${query}`.trim().toLowerCase();
                const isMcpRow = row => row.mcp === true;
                let pool = [];
                if (view !== "skill") pool = pool.concat(plugins);
                if (view !== "plugin" && view !== "mcp") pool = pool.concat(skills);
                pool = pool.filter((row) => {
                    if (wanted !== "") {
                        const haystack = `${row.name} ${row.moduleName || ""} ${row.description || ""} ${row.serverName || ""} ${row.alias || ""}`.toLowerCase();
                        if (!haystack.includes(wanted)) return false;
                    }
                    if (view === "plugin" && (row.kind !== "plugin" || isMcpRow(row))) return false;
                    if (view === "mcp" && !isMcpRow(row)) return false;
                    if (view === "skill" && row.kind !== "skill") return false;
                    return true;
                });
                if (groupId !== null) {
                    const set = groupMembers.get(groupId);
                    if (set !== undefined) pool = pool.filter(row => set.has(memberKey(row.kind, row.id)));
                }
                return pool;
            }, [plugins, skills, query, view, groupId, groupMembers]);

        const facetCounts = useMemo(() => {
                const origin = { all: facetPool.length, official: 0, third: 0, skill: 0, mcp: 0 };
                const shape = { all: facetPool.length, ui: 0, host: 0 };
                for (const row of facetPool) {
                    if (row.mcp === true) origin.mcp += 1;
                    else if (row.kind === "skill") origin.skill += 1;
                    else if (row.official === true) origin.official += 1;
                    else origin.third += 1;
                    if (row.surface === "ui") shape.ui += 1;
                    else if (row.surface === "host") shape.host += 1;
                }
                return { origin, shape };
            }, [facetPool]);

        const rows = useMemo(() => {
                const wanted = `${query}`.trim().toLowerCase();
                const isMcp = row => row.mcp === true;
                const match = (row) => {
                    if (wanted !== "") {
                        const haystack = `${row.name} ${row.moduleName || ""} ${row.description || ""} ${row.serverName || ""} ${row.alias || ""}`.toLowerCase();
                        if (!haystack.includes(wanted)) return false;
                    }
                    if (view === "plugin" && (row.kind !== "plugin" || isMcp(row))) return false;
                    if (view === "mcp" && !isMcp(row)) return false;
                    if (view === "skill" && row.kind !== "skill") return false;
                    return true;
                };
                let combined = [];
                if (view !== "skill") combined = combined.concat(plugins);
                if (view !== "plugin" && view !== "mcp") combined = combined.concat(skills);
                combined = combined.filter(match);
                combined = combined.filter(facetMatch);
                if (groupId !== null) {
                    const set = groupMembers.get(groupId);
                    if (set !== undefined) combined = combined.filter(row => set.has(memberKey(row.kind, row.id)));
                }
                // The bundle lens narrows the same list as every other filter. A bundle the host
                // no longer reports is ignored rather than emptying the panel with no explanation.
                if (bundleSel !== null) {
                    const lens = bundles.find(item => item !== null && item !== undefined && item.name === bundleSel);
                    if (lens !== undefined) {
                        const ids = new Set(Array.isArray(lens.rows) ? lens.rows : []);
                        combined = combined.filter(row => ids.has(row.id));
                    }
                }
                // Inside a group the useful order is "what is on first, then by what kind of thing
                // it is": plugins, then MCP servers, then skills, each alphabetically. Sorting by
                // module name alone buries the switches you actually came to flip.
                const kindRank = row => (row.mcp === true ? 1 : row.kind === "plugin" ? 0 : 2);
                combined.sort((a, b) => {
                    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
                    if (kindRank(a) !== kindRank(b)) return kindRank(a) - kindRank(b);
                    return `${a.name}`.localeCompare(`${b.name}`);
                });
                // One module can be mounted by several loader rows. Without a
                // suffix the list looks like the same switch repeated four times,
                // so repeats carry an index and the row title keeps the entry id.
                const totals = new Map();
                for (const row of combined) {
                    const label = row.kind === "plugin" ? row.moduleName : row.name;
                    totals.set(label, (totals.get(label) ?? 0) + 1);
                }
                const seen = new Map();
                const toolStats = new Map();
                for (const tool of data?.tools ?? []) {
                    const stat = toolStats.get(tool.server) ?? { total: 0, on: 0 };
                    stat.total += 1;
                    if (tool.enabled) stat.on += 1;
                    toolStats.set(tool.server, stat);
                }
                return combined.map((row) => {
                    const label = row.kind === "plugin" ? row.moduleName : row.name;
                    const index = (seen.get(label) ?? 0) + 1;
                    seen.set(label, index);
                    const server = row.config?.serverName ?? row.name;
                    return {
                        ...row,
                        dupeLabel: (totals.get(label) ?? 0) > 1 ? `#${index}` : "",
                        toolStats: row.mcp === true ? toolStats.get(server) ?? null : null,
                        lazy: Array.isArray(data?.lazy) && data.lazy.includes(server),
                    };
                });
            }, [plugins, skills, query, view, groupId, groupMembers, data, origin, shape, bundleSel, bundles]);
            const tree = useMemo(() => {
                const order = [];
                const byModule = new Map();
                for (const row of rows) {
                    // Tree and group membership both key on the package root, so a sub-package
                    // (`billion-context/dsh-compaction-gate`) sits under its parent instead of
                    // showing up as an unrelated plugin.
                    const root = row.kind === "plugin" ? row.root || row.moduleName : row.name;
                    const key = row.kind === "plugin" ? root : `skill:${row.name}`;
                    if (!byModule.has(key)) {
                        byModule.set(key, { key, module: root, kind: row.kind, entries: [] });
                        order.push(key);
                    }
                    byModule.get(key).entries.push(row);
                }
                return order.map(key => byModule.get(key));
        }, [rows]);


            const counts = useMemo(() => {
                const value = { plugin: [0, 0], skill: [0, 0], mcp: [0, 0] };
                for (const row of plugins) {
                    if (row.mcp === true) {
                        value.mcp[0] += 1;
                        if (row.enabled) value.mcp[1] += 1;
                        continue;
                    }
                    value.plugin[0] += 1;
                    if (row.enabled) value.plugin[1] += 1;
                }
                for (const row of skills) {
                    value.skill[0] += 1;
                    if (row.enabled) value.skill[1] += 1;
                }
                return value;
            }, [plugins, skills]);

            const toggleRow = (kind, id, enabled) => act("toggle", { kind, id, enabled }, (result) => {
                if (result && result.ok === false) {
                    // The host refuses a client-bundled UI plugin with a reason; print it and
                    // reload so the switch does not stay in a state the write never reached.
                    flash(fmt(t, "toggleRefused", { why: result.message || result.code || "failed" }));
                    if (result.code === "builtin-ui") void refresh();
                }
                else if (result && result.application === "restart-required") flash(t("restart"));
            });

            const selectedMembers = () => rows
                .filter(row => picked.has(memberKey(row.kind, row.id)))
                .map(row => ({ kind: row.kind, id: row.id }));

            // Shift-click works like a file manager: the range takes the state the clicked row is
            // about to have, and a collapsed module contributes all of its entries, so one shift
            // grabs the four loader rows of a package together.
            const lastPickRef = useRef(null);
            const [dragRows, setDragRows] = useState(null);
            const selectRange = (row, value, shift) => {
                const key = memberKey(row.kind, row.id);
                const anchor = lastPickRef.current;
                const next = new Set(picked);
                if (shift === true && anchor !== null && anchor !== key) {
                    const from = rows.findIndex(item => memberKey(item.kind, item.id) === anchor);
                    const to = rows.findIndex(item => memberKey(item.kind, item.id) === key);
                    if (from >= 0 && to >= 0) {
                        const start = Math.min(from, to);
                        const end = Math.max(from, to);
                        for (let index = start; index <= end; index += 1) {
                            const target = memberKey(rows[index].kind, rows[index].id);
                            if (value === true) next.add(target);
                            else next.delete(target);
                        }
                        setPicked(next);
                        return;
                    }
                }
                if (value === true) next.add(key);
                else next.delete(key);
                setPicked(next);
                lastPickRef.current = key;
            };
            const removeRowsFromGroup = async (items) => {
                if (groupId === null || items.length === 0) return;
                await act("group.remove", { id: groupId, members: items }, (result) => {
                    flash(fmt(t, "groupRemoved", { n: result?.removed ?? items.length }));
                });
            };
            const addRowsToGroup = async (group, items) => {
                await act("group.add", { id: group.id, members: items }, (result) => {
                    flash(fmt(t, "rowsFiled", { n: result?.added ?? items.length, name: group.name }));
                    setPicked(new Set());
                });
            };

            const runBulk = async (items, enabled) => {
                await act("bulk", { items, enabled }, (result) => {
                    const failed = result.results.filter(row => row.ok !== true).length;
                    flash(failed === 0 ? fmt(t, "moved", { n: items.length }) : `${fmt(t, "moved", { n: items.length - failed })} · ${fmt(t, "failed", { n: failed })}`);
                    setPicked(new Set());
                });
            };

            const togglePicked = async (enabled) => {
                const items = selectedMembers();
                if (items.length === 0) return;
                // Group toggles ask above 20 because one click can take the whole install down;
                // a shift-range can select just as many without ever touching a group.
                if (items.length > 20) {
                    setDialog({ kind: "bulkConfirm", items, enabled });
                    return;
                }
                await runBulk(items, enabled);
            };

            const openAuto = async () => {
                beginBusy();
                try {
                    const preview = await runOp("auto.preview", {});
                    if (preview.plan.length === 0) {
                        flash(t("autoEmpty"));
                        return;
                    }
                    setDialog({ kind: "auto", plan: preview.plan });
                }
                catch (failure) {
                    flash(failure.message);
                }
                finally {
                    endBusy();
                }
            };

            const openPresets = () => setDialog({ kind: "presets" });

            const runGroupToggle = async (group, enabled, skipShared) => {
                const before = group.members
                    .map(member => ({ kind: member.kind, id: member.id, enabled: liveByMember.get(memberKey(member.kind, member.id)) === true }))
                    .filter(row => row.enabled !== enabled);
                await act("group.toggle", { id: group.id, enabled, skipShared: skipShared === true }, (result) => {
                    const bad = result.results.filter(row => row.ok !== true);
                    const failed = bad.length;
                    setFailKeys(new Set(bad.map(row => `${row.kind}:${row.id}`)));
                    if (failed === 0) flash(fmt(t, "moved", { n: result.changed }));
                    else flash(fmt(t, "failSummary", { ok: result.changed, failed }));
                    if (enabled === false && before.length > 0) setUndoInfo({ group, rows: before });
                });
            };

            // A big group is a hundred switches at once; ask before writing that,
            // and show how many rows it actually touches. Switching off part of the
            // always-on layer is confirmed whatever its size: it can take the rest down.
            const enableAllInGroup = async (group, enabled) => {
                const own = new Set(group.members.map(member => memberKey(member.kind, member.id)));
                const shared = [];
                for (const other of groups) {
                    if (other.id === group.id) continue;
                    for (const member of other.members) {
                        const key = memberKey(member.kind, member.id);
                        if (own.has(key) && !shared.includes(key)) shared.push(key);
                    }
                }
                const labelOf = (key) => {
                    const row = [...plugins, ...skills].find(item => memberKey(item.kind, item.id) === key);
                    return row === undefined ? key : row.name;
                };
                const risky = group.members.filter((member) => {
                    const row = [...plugins, ...skills].find(item => memberKey(item.kind, item.id) === memberKey(member.kind, member.id));
                    return row !== undefined && (row.role === "base" || row.official === true);
                });
                if (group.members.length > 20 || (enabled === false && group.role === "base") || (enabled === false && shared.length > 0)) {
                    setDialog({
                        kind: "confirmGroup",
                        group,
                        enabled,
                        shared: shared.map(key => ({ key, name: labelOf(key) })),
                        riskyNames: risky.slice(0, 8).map(member => labelOf(memberKey(member.kind, member.id))),
                        riskyCount: risky.length,
                    });
                    return;
                }
                await runGroupToggle(group, enabled, false);
            };

            const runPresetApply = async (name, mode) => {
                await act("preset.apply", { name, mode }, (result) => {
                    if (result.tools?.deferred === true) flash(t("presetDeferred"));
                    else flash(fmt(t, "presetApplied", { n: result.applied, total: result.requested }));
                });
                setDialog(null);
                // Servers the preset switched on take a moment to register their tools; look again
                // once, the same way the create dialog waits for the host to reconcile.
                setTimeout(refresh, 1800);
            };

            const header = h("div", {
                style: { display: "flex", alignItems: "flex-start", gap: 12, rowGap: 10, padding: "14px 16px 10px", flexWrap: "wrap" },
            },
            h("div", { style: { flex: "1 1 260px", minWidth: 240 } },
                h("div", { style: { fontSize: embedded === true ? 15 : 17, fontWeight: 650, letterSpacing: 0.1 } }, t("heading")),
                h("div", { style: { marginTop: 5, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                    data === null
                        ? h("span", { style: { fontSize: 12, color: T.text3 } }, t("loading"))
                        : [
                            h(Badge, { key: "on", tone: "success" }, fmt(t, "pillOn", { n: counts.plugin[1] + counts.skill[1] + counts.mcp[1] })),
                            h(Badge, { key: "skills", tone: "warn" }, fmt(t, "pillSkills", { n: counts.skill[0] })),
                            h(Badge, { key: "mcp", tone: "plain" }, fmt(t, "pillMcp", { n: counts.mcp[0] })),
                            h(Badge, { key: "all", tone: "plain" }, fmt(t, "pillAll", { n: counts.plugin[0] + counts.skill[0] + counts.mcp[0] })),
                            data.compat?.active === true
                                ? h(Badge, { key: "compat", tone: "brand", title: t("compatHint") }, t("compatBadge"))
                                : null,
                        ])),
            h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0, maxWidth: "100%" } },
                view === "mcp"
                    ? h(Button, { onClick: () => setDialog({ kind: "mcpEdit", row: null }), disabled: busy }, t("mcpCreate"))
                    : null,
                view === "mcp" && (data?.panelDeny ?? []).length > 0
                    ? h(Button, {
                        onClick: () => { void act("tool.import", {}, result => flash(fmt(t, "toolsImported", { n: result.added }))); },
                        disabled: busy,
                        title: t("toolsPanelNote"),
                    }, fmt(t, "toolsImport", { n: data.panelDeny.length }))
                    : null,
                h(Button, { onClick: openAuto, disabled: busy, title: t("autoHint") }, t("auto")),
                view === "skill"
                    ? h(Button, { onClick: () => setDialog({ kind: "skillImport" }), disabled: busy || roots.length === 0 }, t("skillImport"))
                    : null,
                h(Button, {
                    tone: bundleMode === true ? "primary" : undefined,
                    onClick: () => {
                        setBundleMode(bundleMode !== true);
                        setBundleSel(null);
                    },
                    disabled: bundles.length === 0,
                    title: t("bundleView"),
                }, t("bundleView")),
                h(Button, { onClick: () => setDialog({ kind: "history" }), disabled: data === null }, t("historyView")),
                h(Button, {
                    onClick: () => setShowDesc(showDesc !== true),
                    title: showDesc === true ? t("hideDesc") : t("showDesc"),
                }, showDesc === true ? t("hideDesc") : t("showDesc")),
                data?.market?.available === true
                    ? h(Button, {
                        onClick: () => setDialog({ kind: "marketImport", groups: data.market.groups }),
                        disabled: busy,
                        title: t("marketImportHint"),
                    }, fmt(t, "marketImport", { n: data.market.groups.length }))
                    : null,
                h(Button, { onClick: openPresets, disabled: busy }, t("preset")),
                h(Button, { tone: "danger", onClick: () => { void openThird(); }, disabled: busy }, busy ? t("thirdWorking") : t("thirdOff")),
                thirdSnapshot === null
                    ? null
                    : h(Button, { onClick: openRestore, disabled: busy, title: fmt(t, "thirdRollback", { file: thirdSnapshot.file }) }, busy ? t("thirdWorking") : t("thirdRestore")),
                h(Button, { onClick: refresh, disabled: busy }, t("reload")),
                h(Button, { onClick: () => setHelpOpen(true), title: t("helpOpen") }, "?")));

            const tabs = h("div", {
                style: { display: "flex", gap: 4, padding: "0 16px 10px", alignItems: "center" },
            },
            [["all", t("viewAll")], ["plugin", t("viewPlugins")], ["skill", t("viewSkills")], ["mcp", fmt(t, "viewMcp", { n: counts.mcp[0] })]].map(([key, label]) => h("button", {
                key,
                type: "button",
                onClick: () => {
                    setView(key);
                    setPicked(new Set());
                    lastPickRef.current = null;
                },
                style: {
                    height: 26,
                    padding: "0 11px",
                    borderRadius: 7,
                    border: `1px solid ${view === key ? tint(T.brand, 34) : "transparent"}`,
                    background: view === key ? tint(T.brand, 12) : "transparent",
                    color: view === key ? T.brand : T.text3,
                    fontWeight: view === key ? 600 : 500,
                    fontSize: 12.5,
                    cursor: "pointer",
                    fontFamily: "inherit",
                },
            }, label)),
            h("div", { style: { flex: 1 } }),
            h(Input, { value: query, onChange: setQuery, placeholder: t("search") }));

            const facetChip = (key, label, active, count, onPick) => h("button", {
                key,
                type: "button",
                "aria-pressed": active,
                onClick: onPick,
                style: {
                    height: 23,
                    padding: "0 9px",
                    borderRadius: 999,
                    border: `1px solid ${active ? T.brand : T.borderSoft}`,
                    background: active ? T.brand : "transparent",
                    color: active ? T.onBrand : T.text2,
                    fontWeight: active ? 700 : 500,
                    fontSize: 11.5,
                    lineHeight: 1,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    whiteSpace: "nowrap",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                },
            }, label, h("span", {
                style: {
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: active ? T.onBrand : T.text3,
                    opacity: active ? 0.9 : 1,
                },
            }, `${count}`));

            const chipRow = (label, items, active, onPick, counts) => h("div", {
                style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", padding: "0 2px 6px" },
            },
                h("span", { style: { minWidth: 24, width: "auto", flex: "0 0 auto", fontSize: 10, color: T.text3, whiteSpace: "nowrap", marginRight: 2 } }, label),
                facetChip("all", t("lensAll"), active === "all", counts.all, () => onPick("all")),
                ...items.map(item => facetChip(item.id, item.label, active === item.id, counts[item.id] ?? 0, () => onPick(active === item.id ? "all" : item.id))));
            const shapeRelevant = view !== "skill" && view !== "mcp";
            const chips = h("div", { style: { padding: "0 2px 2px" } },
                chipRow(t("facetOrigin"), ORIGINS, origin, setOrigin, facetCounts.origin),
                shapeRelevant ? chipRow(t("facetShape"), SHAPES, shape, setShape, facetCounts.shape) : null);

            // Head and foot stay put; only the drawers scroll, so the two "new" buttons can
            // never be pushed off the bottom by a long list.
            const railHead = h("div", { style: { flex: "0 0 auto" } },
            h("div", {
                style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0 6px 8px",
                },
            },
            h("div", { style: { fontSize: 11, letterSpacing: 0.4, color: T.text3, textTransform: "uppercase" } }, t("groups"))),
            chips,

            h("button", {
                type: "button",
                onClick: () => {
                    setGroupId(null);
                    setPicked(new Set());
                },
                style: navRowStyle(groupId === null),
            }, h("span", { style: { flex: 1, textAlign: "left" } }, t("viewAll")),
            h("span", {
                style: {
                    minWidth: 22,
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: groupTint.countBg,
                    color: T.text2,
                    fontSize: 11,
                    fontWeight: 600,
                    textAlign: "center",
                },
            }, `${counts.plugin[0] + counts.skill[0]}`)),
            );
            const railBody = h("div", {
                onDragOver: (event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    if (event.clientY < box.top + 36) event.currentTarget.scrollTop -= 14;
                    else if (event.clientY > box.bottom - 36) event.currentTarget.scrollTop += 14;
                },
                style: { flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 2 },
            },
            ...drawers.flatMap((drawer) => {
                // Drawers start closed: the rail reads as a table of contents first.
                const open = expanded.has(drawer.collection.id);
                return [
                    h("div", {
                        key: `drawer-${drawer.collection.id}`,
                        draggable: false,
                        onDragOver: (event) => {
                            event.preventDefault();
                            event.currentTarget.style.outline = `2px dashed ${T.brand}`;
                        },
                        onDragLeave: (event) => {
                            event.currentTarget.style.outline = "none";
                        },
                        onDrop: (event) => {
                            event.preventDefault();
                            event.currentTarget.style.outline = "none";
                            const fromId = dragId ?? event.dataTransfer.getData("text/plain") ?? "";
                            if (fromId !== "") void moveInto(fromId, drawer.collection.id);
                            setDragId(null);
                        },
                        style: {
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            margin: "12px 2px 3px",
                            padding: "2px 4px",
                            borderRadius: 7,
                        },
                    },
                    h("button", {
                        type: "button",
                        title: open ? t("collectionCollapse") : t("collectionExpand"),
                        onClick: () => toggleCollapsed(drawer.collection.id),
                        style: {
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            border: "none",
                            background: "transparent",
                            padding: 0,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            color: T.text2,
                        },
                    },
                    h("span", { style: { fontSize: 10, color: T.text3, width: 8 } }, open ? "▾" : "▸"),
                    h("span", {
                        style: { minWidth: 0, fontSize: 11.5, letterSpacing: "0.04em", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                        title: drawer.collection.name,
                    }, drawer.collection.name),
                    ),
                    drawer.collection.id === "default"
                        ? null
                        : h(MiniIcon, {
                            label: "✎",
                            title: t("collectionRename"),
                            onClick: () => setDialog({ kind: "renameCollection", collection: drawer.collection }),
                        }),
                    drawer.collection.id === "default"
                        ? null
                        : h(MiniIcon, {
                            label: "✕",
                            title: t("collectionDelete"),
                            danger: true,
                            onClick: () => setDialog({ kind: "deleteCollection", collection: drawer.collection }),
                        })),
                    ...(open ? drawer.list.map(group => groupRow(group)) : []),
                ];
            }),
            h("div", {
                key: "drawer-loose",
                onDragOver: (event) => {
                    event.preventDefault();
                    event.currentTarget.style.outline = `2px dashed ${T.warn}`;
                },
                onDragLeave: (event) => {
                    event.currentTarget.style.outline = "none";
                },
                onDrop: (event) => {
                    event.preventDefault();
                    event.currentTarget.style.outline = "none";
                    const fromId = dragId ?? event.dataTransfer.getData("text/plain") ?? "";
                    if (fromId !== "") void moveInto(fromId, null);
                    setDragId(null);
                },
                style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    margin: "12px 2px 3px",
                    padding: "2px 4px",
                    borderRadius: 7,
                },
            },
            h("span", { style: { fontSize: 10, color: T.text3, width: 8 } }, looseGroups.length === 0 ? "·" : "▾"),
            h("span", {
                style: { flex: 1, minWidth: 0, fontSize: 11.5, letterSpacing: "0.04em", color: T.text3, fontWeight: 700 },
                title: t("looseHint"),
            }, t("looseTitle")),
            h("span", { style: { fontSize: 10.5, color: T.text3 } }, `${looseGroups.length}`)),
            ...looseGroups.map(group => groupRow(group)),
            );
            const railFoot = h("div", {
                style: { flex: "0 0 auto", borderTop: `1px solid ${T.borderSoft}`, paddingTop: 8 },
            },
            h("div", { key: "rail-actions", style: { display: "flex", gap: 6 } },
                h("button", {
                    type: "button",
                    onClick: () => setDialog({ kind: "newGroup", collection: null }),
                    style: {
                        flex: 1,
                        padding: "6px 8px",
                        borderRadius: 8,
                        border: `1px dashed ${T.border}`,
                        background: "transparent",
                        color: T.text3,
                        fontSize: 11.5,
                        cursor: "pointer",
                        fontFamily: "inherit",
                    },
                }, `+ ${t("newGroup")}`),
                h("button", {
                    type: "button",
                    onClick: () => setDialog({ kind: "newCollection" }),
                    style: {
                        flex: 1,
                        padding: "6px 8px",
                        borderRadius: 8,
                        border: `1px dashed ${T.border}`,
                        background: "transparent",
                        color: T.text3,
                        fontSize: 11.5,
                        cursor: "pointer",
                        fontFamily: "inherit",
                    },
                }, `+ ${t("collectionNew")}`)),
            groups.length === 0
                ? h("div", {
                    style: {
                        marginTop: 10,
                        padding: "10px 10px 11px",
                        borderRadius: 9,
                        border: `1px dashed ${T.border}`,
                        background: T.cardHover,
                        display: "flex",
                        flexDirection: "column",
                        gap: 7,
                    },
                },
                    h("div", { style: { fontSize: 12, fontWeight: 600, color: T.text } }, t("railEmptyTitle")),
                    h("div", { style: { fontSize: 11.5, lineHeight: 1.55, color: T.text3 } }, t("railEmptyBody")),
                    h(Button, { small: true, onClick: () => { void openAuto(); }, disabled: busy || data === null }, t("railEmptyAction")))
                : null);
            // Bundle rail: same slot as the group drawers, listing what the host reports as an
            // installed bundle. Picking one filters the list to its rows; "全部" drops the filter.
            const bundleRail = h("div", {
                style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "0 6px 8px" },
            },
            h("div", {
                style: { padding: "0 6px 8px", fontSize: 11, letterSpacing: 0.4, color: T.text3, textTransform: "uppercase" },
            }, t("bundleView")),
            h("button", {
                type: "button",
                onClick: () => setBundleSel(null),
                style: navRowStyle(bundleSel === null),
            },
            h("span", { style: { flex: 1, textAlign: "left" } }, t("bundleAll")),
            h("span", { style: { fontSize: 10.5, color: T.text3, fontWeight: 600 } }, `${bundles.length}`)),
            ...bundles.map(bundle => h("button", {
                key: `bundle-${bundle.name}`,
                type: "button",
                title: bundle.name,
                onClick: () => setBundleSel(bundleSel === bundle.name ? null : bundle.name),
                style: navRowStyle(bundleSel === bundle.name),
            },
            h("span", {
                style: { flex: 1, minWidth: 0, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            }, bundle.name),
            h("span", { style: { flex: "0 0 auto", fontSize: 10.5, color: T.text3 } },
                fmt(t, "bundleRows", { n: Array.isArray(bundle.rows) ? bundle.rows.length : 0 })))));
            const rail = h("div", {
                style: {
                    width: railWidth,
                    flex: `0 0 ${railWidth}px`,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    overflow: "hidden",
                    borderRight: `1px solid ${T.borderSoft}`,
                    padding: "10px 8px",
                    background: T.base,
                },
            }, bundleMode === true ? bundleRail : [railHead, railBody, railFoot]);

            const rowNode = (row, nested) => h(RowMemo, {
                key: memberKey(row.kind, row.id),
                row,
                t,
                nested: nested === true,
                picked: picked.has(memberKey(row.kind, row.id)),
                failed: failKeys.has(memberKey(row.kind, row.id)),
                onPick: (value, shift) => selectRange(row, value, shift),
                dragEnabled: true,
                onRowDragStart: (event) => {
                    const key = memberKey(row.kind, row.id);
                    const items = picked.has(key) && picked.size > 1
                        ? selectedMembers()
                        : [{ kind: row.kind, id: row.id }];
                    try {
                        event.dataTransfer.setData("application/x-tool-hub-rows", JSON.stringify(items));
                        event.dataTransfer.setData("text/plain", "");
                        event.dataTransfer.effectAllowed = "copy";
                    }
                    catch { /* some engines refuse to write during a drag */ }
                    setDragRows(items);
                },
                onRowDragEnd: () => setDragRows(null),
                onRemove: groupId === null ? undefined : () => { void removeRowsFromGroup([{ kind: row.kind, id: row.id }]); },
                onToggle: enabled => toggleRow(row.kind, row.id, enabled),
                onEdit: (target) => setDialog({ kind: "mcpEdit", row: target }),
                onDelete: (target) => setDialog({ kind: "mcpDelete", row: target }),
                onTools: (target) => setDialog({ kind: "toolEdit", row: target }),
                onLazy: async (target) => {
                    const server = target.config?.serverName ?? target.name;
                    const on = target.lazy !== true;
                    await act("lazy.set", { server, on }, () => flash(on ? t("lazyDone") : t("lazyOff")));
                },
                onPreview: (target) => setDialog({ kind: "skillPreview", row: target }),
                onSkillDelete: (target) => setDialog({ kind: "skillDelete", row: target }),
                onSkillMove: (target) => setDialog({ kind: "skillMove", row: target }),
                onDiag: (target) => setDialog({ kind: "diag", row: target }),
                showDesc,
                busy,
            });

            const searching = `${query}`.trim() !== "";
        // Skills leave the module tree here: they are listed under their own scope headings so a
        // workspace skill never looks like it belongs to the install as a whole.
        const treeNodes = tree.filter(node => node.kind !== "skill").map(node => {
                if (node.entries.length === 1) return rowNode(node.entries[0], false);
                const open = searching === true || openModules.has(node.key);
                const enabled = node.entries.filter(entry => entry.enabled === true).length;
                const allOn = enabled === node.entries.length;
                const allPicked = node.entries.every(entry => picked.has(memberKey(entry.kind, entry.id)));
                return h("div", { key: `tree-${node.key}`, className: "hub-card" },
                    h("div", {
                        style: {
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "7px 8px 7px 6px",
                            borderBottom: `1px solid ${T.borderSoft}`,
                        },
                    },
                    h("input", {
                        type: "checkbox",
                        checked: allPicked,
                        onChange: () => {
                            const next = new Set(picked);
                            for (const entry of node.entries) {
                                const key = memberKey(entry.kind, entry.id);
                                if (allPicked) next.delete(key);
                                else next.add(key);
                            }
                            setPicked(next);
                        },
                        style: { width: 14, height: 14, margin: 0, accentColor: T.brand, flex: "0 0 auto", cursor: "pointer" },
                    }),
                    h("button", {
                        type: "button",
                        onClick: () => {
                            setOpenModules((current) => {
                                const next = new Set(current);
                                if (next.has(node.key)) next.delete(node.key);
                                else next.add(node.key);
                                return next;
                            });
                        },
                        title: open ? t("collapseModule") : t("expandModule"),
                        style: {
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            border: "none",
                            background: "transparent",
                            padding: 0,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            color: T.text,
                        },
                    },
                    h("span", { style: { fontSize: 10, color: T.text3, width: 9, flex: "0 0 auto" } }, open ? "▾" : "▸"),
                    h("span", {
                        style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 600 },
                        title: node.module,
                    }, node.module),
                    h(Badge, { tone: node.kind === "plugin" ? "brand" : "warn" }, node.kind === "plugin" ? t("kindPlugin") : t("kindSkill")),
                    h(Badge, null, `×${node.entries.length}`)),
            h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8 } },
                        h("span", { style: { fontSize: 11, color: T.text3 } }, `${enabled}/${node.entries.length}`),
                        h(Switch, {
                            checked: allOn,
                            disabled: busy || node.entries.every(entry => entry.manageable !== true),
                            onChange: (value) => {
                                for (const entry of node.entries) {
                                    if (entry.manageable === true) void toggleRow(entry.kind, entry.id, value);
                                }
                            },
                        }))),
                    open ? node.entries.map(entry => rowNode(entry, true)) : null);
            });

            // Bucket the skill rows by root, keeping the order the rows already have. Two global
            // roots share one heading; each workspace gets its own.
            const skillSections = [];
            for (const row of rows) {
                if (row.kind !== "skill") continue;
                const bucket = skillSectionOf(t, row);
                let section = null;
                for (const item of skillSections) if (item.key === bucket.key) section = item;
                if (section === null) {
                    section = { key: bucket.key, label: bucket.label, rows: [] };
                    skillSections.push(section);
                }
                section.rows.push(row);
            }
            const skillNodes = skillSections.map(section => h("div", { key: `scope-${section.key}` },
                h("div", { style: scopeHeadStyle },
                    h("span", null, section.label),
                    h("span", { style: { fontWeight: 600 } }, `${section.rows.length}`)),
                section.rows.map(row => rowNode(row, false))));

            const activeFilters = [];
            if (view !== "all") activeFilters.push(fmt(t, "filterView", { label: view === "plugin" ? t("viewPlugins") : view === "skill" ? t("viewSkills") : t("viewMcpShort") }));
            if (origin !== "all") activeFilters.push(fmt(t, "filterOrigin", { label: (ORIGINS.find(item => item.id === origin) ?? {}).label ?? origin }));
            if (shape !== "all" && shapeRelevant) activeFilters.push(fmt(t, "filterShape", { label: (SHAPES.find(item => item.id === shape) ?? {}).label ?? shape }));
            const clearAllFilters = () => {
                setOrigin("all");
                setShape("all");
                setQuery("");
            };
            const filterBar = activeFilters.length === 0 ? null : h("div", {
                style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 12px",
                    borderBottom: `1px solid ${tint(T.brand, 26)}`,
                    background: tint(T.brand, 7),
                    flex: "0 0 auto",
                },
            },
            h("span", { style: { fontSize: 11.5, color: T.text2 } }, t("filterLead")),
            h("span", { style: { fontSize: 12, fontWeight: 600, color: T.brand } }, activeFilters.join(" · ")),
            h("div", { style: { flex: 1 } }),
            h(Button, { tone: "ghost", onClick: clearAllFilters }, t("filterClear")));

            const list = h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" } },
                filterBar,
                h("div", { style: { flex: 1, overflow: "auto", padding: "10px 12px 12px" } },
                    data === null
                        ? h("div", { style: emptyStyle }, error === null ? t("loading") : error)
                        : rows.length === 0
                            ? h("div", { style: emptyStyle }, groupId === null ? t("empty") : t("emptyGroup"))
                            : h("div", { key: "row-view" }, treeNodes, skillNodes)));

            const selectionBar = picked.size === 0 ? null : h("div", {
                style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 14px",
                    borderTop: `1px solid ${tint(T.brand, 34)}`,
                    background: tint(T.brand, 9),
                },
            },
            h("span", {
                style: {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 9px",
                    borderRadius: 999,
                    background: tint(T.brand, 18),
                    color: T.brand,
                    fontSize: 12,
                    fontWeight: 600,
                    flex: "0 0 auto",
                },
            }, fmt(t, "selected", { n: picked.size })),
            h("div", { style: { flex: 1 } }),
            h(ActionChip, { label: t("enable"), tone: "success", onClick: () => togglePicked(true), disabled: busy }),
            h(ActionChip, { label: t("disable"), tone: "danger", onClick: () => togglePicked(false), disabled: busy }),
            groupId === null ? null : h(ActionChip, {
                label: t("removeFromGroup"),
                tone: "danger",
                onClick: () => { void removeRowsFromGroup(selectedMembers()); },
                disabled: busy,
            }),
            h(ActionChip, {
                label: t("addToGroup"),
                tone: "brand",
                onClick: () => setDialog({ kind: "addToGroup", members: selectedMembers() }),
                disabled: busy || groups.length === 0,
            }),
            h(ActionChip, { label: t("clearSelection"), tone: "neutral", onClick: () => setPicked(new Set()) }));

            const undoBar = undoInfo === null ? null : h("div", {
                style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 14px",
                    borderTop: `1px solid ${T.borderSoft}`,
                    background: tint(T.warn, 10),
                    fontSize: 12,
                    color: T.text2,
                },
            },
            h("span", { style: { flex: 1, minWidth: 0 } }, fmt(t, "undoSaved", { name: undoInfo.group.name, n: undoInfo.rows.length })),
            h(ActionChip, {
                label: t("undoLabel"),
                tone: "brand",
                onClick: async () => {
                    const rows = undoInfo.rows;
                    setUndoInfo(null);
                    await act("bulk", { items: rows.map(row => ({ kind: row.kind, id: row.id, enabled: row.enabled })) }, () => flash(t("undoDone")));
                },
            }));

            const skillUndoBar = skillUndo === null ? null : h("div", {
                style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 14px",
                    borderTop: `1px solid ${T.borderSoft}`,
                    background: tint(T.warn, 10),
                    fontSize: 12,
                    color: T.text2,
                },
            },
            h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: skillUndo.name },
                `${t("skillDeleted")} · ${skillUndo.name}`),
            h(ActionChip, { label: t("undoDelete"), tone: "brand", onClick: () => { void undoSkillDelete(); } }));

            const footer = data === null ? null : h("div", {
                style: {
                    display: "flex",
                    gap: 12,
                    padding: "7px 14px",
                    borderTop: `1px solid ${T.borderSoft}`,
                    fontSize: 11,
                    color: T.text3,
                    flexWrap: "wrap",
                },
            },
            h("span", null, `${t("statePath")}: ${data.paths.state}`),
            h("span", { style: { overflowWrap: "anywhere" }, title: `${t("skillRoots")}: ${data.paths.skillRoots.join(" · ")}` }, `${t("skillRoots")}: ${data.paths.skillRoots.join(" · ")}`));

            return h("div", {
                style: {
                    display: "flex",
                    flexDirection: "column",
                    // The host does not always give the slot a bounded height. A percentage height
                    // then resolves to `auto` and every `flex: 1` below it collapses to content
                    // height — which is how the rail grew past its cap and hid its own footer.
                    // A viewport-derived height is definite, so the list and the rail scroll
                    // instead of pushing the footer off the bottom.
                    height: "calc(100vh - 120px)",
                    maxHeight: "calc(100vh - 120px)",
                    overflow: "hidden",
                    minHeight: 0,
                    background: T.base,
                    color: T.text,
                    fontSize: 13,
                    fontFamily: "inherit",
                },
            },
            header,
            tabs,
            h("div", { style: { display: "flex", flex: 1, minHeight: 0, borderTop: `1px solid ${T.borderSoft}` } },
            rail,
            h("div", {
                role: "separator",
                "aria-orientation": "vertical",
                title: t("resizeRail"),
                onPointerDown: startResize,
                onDoubleClick: () => { setRailWidth(220); try { window.localStorage.setItem("toolHubRailWidth", "220"); } catch { /* ignore */ } },
                style: {
                    flex: "0 0 7px",
                    cursor: "col-resize",
                    background: resizing === true ? tint(T.brand, 30) : tint(T.borderSoft, 60),
                    transition: "background .12s ease",
                },
            }), list),
            selectionBar,
            undoBar,
            skillUndoBar,
            // Screen readers only announce live-region text that changes after the region exists,
            // so the container is always mounted and only its text appears/disappears.
            h("div", {
                role: "status",
                "aria-live": "polite",
                style: {
                    padding: note === null ? 0 : "7px 14px",
                    borderTop: note === null ? "none" : `1px solid ${T.borderSoft}`,
                    fontSize: 12,
                    color: T.text2,
                },
            }, note === null ? "" : note),
            footer,
            helpOpen === true ? h(HelpDrawer, { t, onClose: closeHelp, blocked: dialog !== null }) : null,
            dialog === null ? null : h(DialogHost, {
                dialog,
                t,
                busy,
                groups,
                data,
                onClose: () => setDialog(null),
                onSaveMcp: async (id, config) => {
                    beginBusy();
                    try {
                        if (id === null) await runOp("mcp.create", { config });
                        else await runOp("mcp.save", { id, config });
                    }
                    catch (failure) {
                        // A refused write (bad-secret, bad name…) has to leave the dialog open:
                        // closing it would throw away everything typed so far with the toast.
                        flash(failure.message);
                        endBusy();
                        return { ok: false, message: failure.message };
                    }
                    endBusy();
                    flash(t("mcpSaved"));
                    setDialog(null);
                    await refresh();
                    // A brand-new entry only becomes a loader row after the host reconciles the
                    // patch, so look again shortly instead of leaving it as an orphan row.
                    if (id === null) setTimeout(refresh, 1500);
                    return { ok: true };
                },
                onOpenRaw: (target) => setDialog({ kind: "mcpRaw", row: target }),
                onDeleteSkill: async (target) => {
                    const result = await act("skill.delete", { id: target.id });
                    if (result !== null && result !== undefined && typeof result.trashPath === "string") {
                        setSkillUndo({
                            trashPath: result.trashPath,
                            name: typeof result.name === "string" ? result.name : target.name,
                        });
                    }
                },
                onSaveRaw: async (target, text) => {
                    try {
                        await runOp("mcp.rawSave", { id: target.mcpPatchId, text });
                    }
                    catch (failure) {
                        flash(failure.message);
                        return { ok: false, message: failure.message };
                    }
                    flash(t("rawSaved"));
                    setTimeout(refresh, 900);
                    return { ok: true };
                },
                // Shared closing move for the dialogs that run their own op: show the headline,
                // drop the dialog, then reload so the list reflects what the host did.
                onDone: async (message) => {
                    if (typeof message === "string" && message !== "") flash(message);
                    setDialog(null);
                    await refresh();
                },
                onExportConfig: async () => {
                    try {
                        const out = await runOp("config.export", {});
                        const json = out !== null && out !== undefined ? out.json : undefined;
                        const text = typeof json === "string" ? json : JSON.stringify(json === undefined ? {} : json, null, 2);
                        downloadText("tool-hub-config.json", text);
                    }
                    catch (failure) {
                        flash(failure.message);
                    }
                },
                onOpenConfigImport: () => setDialog({ kind: "configImport" }),
                onDeleteMcp: async (id) => {
                    const done = await act("mcp.delete", { id }, () => flash(t("mcpDeleteDone")));
                    if (done !== null) setDialog(null);
                    setTimeout(refresh, 1500);
                },
                onSaveTool: async (server, denied) => {
                    // Keep every other server's state exactly as it is: the op replaces the
                    // whole list, so the rest of it has to be carried over explicitly.
                    const others = (data?.tools ?? []).filter(tool => tool.server !== server && tool.enabled === false).map(tool => tool.name);
                    const deny = [...new Set([...others, ...denied])];
                    const saved = await act("tool.save", { deny }, () => flash(t("toolsSaved")));
                    if (saved !== null) setDialog(null);
                },
                act,
                flash,
                onImportMarket: async () => {
                    return await act("market.import", {}, (result) => flash(fmt(t, "marketImportDone", { n: result.imported })));
                },
                onApplyAuto: async () => {
                    const applied = await act("auto.apply", {}, (result) => flash(fmt(t, "autoDone", { n: result.groups })));
                    if (applied !== null) setDialog(null);
                },
                onSaveGroup: async (name, members, id, collection) => {
                    const stored = await act("group.save", { name, members, id, collection });
                    if (stored !== null) setDialog(null);
                },
                onSaveCollection: async (name, id) => {
                    const kept = await act("collection.save", { name, id });
                    if (kept !== null) setDialog(null);
                },
                onDeleteCollection: async (id) => {
                    const dropped = await act("collection.delete", { id }, () => flash(t("collectionDeleted")));
                    if (dropped !== null) setDialog(null);
                },
                onSavePreset: async (name) => {
                    const recorded = await act("preset.save", { name }, () => flash(`${t("presetSave")}: ${name}`));
                    if (recorded !== null) setDialog(null);
                },
                onUpdatePreset: async (name) => {
                    await act("preset.update", { name }, () => flash(fmt(t, "presetUpdated", { name })));
                },
                onApplyPreset: (name, mode) => {
                    const preset = (data?.presets ?? []).find(entry => entry.name === name);
                    const want = new Set([
                        ...(preset?.enabled?.plugin ?? []).map(id => `plugin:${id}`),
                        ...(preset?.enabled?.skill ?? []).map(id => `skill:${id}`),
                    ]);
                    let on = 0;
                    let off = 0;
                    let mcpOn = 0;
                    let mcpOff = 0;
                    for (const row of data === null ? [] : [...data.plugins, ...data.skills]) {
                        const wanted = want.has(`${row.kind}:${row.id}`);
                        if (wanted && row.enabled !== true) {
                            on += 1;
                            if (row.mcp === true) mcpOn += 1;
                        }
                        if (!wanted && row.enabled === true && row.manageable !== false) {
                            off += 1;
                            if (row.mcp === true) mcpOff += 1;
                        }
                    }
                    if (on + off > 10) {
                        setDialog({ kind: "confirmPreset", name, mode, on, off, mcpOn, mcpOff });
                        return;
                    }
                    void runPresetApply(name, mode);
                },
                onApplyPresetNow: (name, mode) => runPresetApply(name, mode),
                onAskPresetUpdate: (name) => setDialog({ kind: "presetUpdate", name }),
                onAskPresetDelete: (name) => setDialog({ kind: "presetDelete", name }),
                onRunBulk: async (items, enabled) => { await runBulk(items, enabled); },
                onDeletePreset: async (name) => {
                    const result = await act("preset.delete", { name });
                    if (result !== null) flash(t("presetDeleted"));
                },
                onThirdOff: async () => {
                    const result = await act("thirdparty.off");
                    if (result !== null && result !== undefined) {
                        flash(fmt(t, "thirdOffDone", { n: result.disabled, file: result.snapshot ?? "—" }));
                    }
                    await loadThird();
                },
                onOpenThird: async () => { await openThird(); },
                onThirdRestore: async (snapshot) => {
                    const result = await act("thirdparty.restore", { file: snapshot?.file });
                    if (result !== null && result !== undefined) {
                        flash(fmt(t, "thirdRestoreDone", { n: result.restored }));
                    }
                    await loadThird();
                },
                onRunGroupToggle: (group, enabled, skipShared) => runGroupToggle(group, enabled, skipShared),
                onProbe: async (payload) => {
                    try { return await runOp("mcp.probe", payload); }
                    catch (failure) { return { error: failure.message }; }
                },
            }));
        }

        function navRowStyle(active) {
            return {
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                height: 32,
                padding: "0 12px",
                marginBottom: 3,
                borderRadius: 9,
                border: `1px solid ${active ? tint(T.brand, 38) : "transparent"}`,
                background: active ? groupTint.activeBg : "transparent",
                color: T.text,
                fontSize: 14,
                fontWeight: 650,
                cursor: "pointer",
                fontFamily: "inherit",
            };
        }

        const emptyStyle = {
            padding: "30px 16px",
            textAlign: "center",
            fontSize: 12.5,
            color: T.text3,
            lineHeight: 1.7,
        };

        // Skills are grouped by where they live, not by what they do: a workspace skill only
        // exists for that workspace, so the heading has to name it before the rows read right.
        const scopeHeadStyle = {
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            padding: "12px 6px 5px",
            fontSize: 11,
            letterSpacing: "0.04em",
            fontWeight: 700,
            color: T.text3,
        };

        function skillSectionOf(t, row) {
            if (row.scope === "workspace") {
                const label = typeof row.rootLabel === "string" && row.rootLabel !== "" ? row.rootLabel : String(row.rootId ?? "");
                return { key: `ws:${row.rootId ?? label}`, label: fmt(t, "skillScopeWorkspace", { name: label }) };
            }
            return { key: "global", label: t("skillScopeGlobal") };
        }

        // The snapshot carries the skill roots two ways: `paths.skills` with ids and labels, and
        // plain directory strings from the older host. Import and move need ids, so both shapes
        // are normalised here instead of in each dialog.
        function skillRootList(data) {
            const paths = data !== null && data !== undefined && typeof data.paths === "object" && data.paths !== null ? data.paths : {};
            if (Array.isArray(paths.skills)) {
                return paths.skills
                    .filter(root => root !== null && typeof root === "object")
                    .map(root => ({ id: `${root.id ?? ""}`, label: `${root.label ?? root.id ?? ""}` }));
            }
            const dirs = Array.isArray(paths.skillRoots) ? paths.skillRoots : [];
            return dirs.map(dir => ({ id: `${dir}`, label: `${dir}` }));
        }

        // The export stays inside the browser: a Blob download needs no host file dialog and the
        // JSON never leaves the machine.
        function downloadText(name, text) {
            if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") return false;
            if (typeof URL.createObjectURL !== "function") return false;
            const blob = new Blob([text], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = name;
            anchor.style.display = "none";
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            return true;
        }

        // One option in a row of mutually exclusive choices (target root, import mode). Mirrors
        // the chips inside McpEditDialog so the new dialogs look like the rest of the panel.
        function choiceChip(key, label, active, onClick) {
            return h("button", {
                key,
                type: "button",
                onClick,
                style: {
                    height: 26,
                    padding: "0 11px",
                    borderRadius: 7,
                    border: `1px solid ${active === true ? tint(T.brand, 34) : T.border}`,
                    background: active === true ? tint(T.brand, 12) : "transparent",
                    color: active === true ? T.brand : T.text2,
                    fontSize: 12,
                    fontWeight: active === true ? 600 : 500,
                    cursor: "pointer",
                    fontFamily: "inherit",
                },
            }, label);
        }

        const chipTone = {
            success: { fg: T.success, bg: tint(T.success, 14), border: tint(T.success, 34), hover: tint(T.success, 26) },
            danger: { fg: T.danger, bg: tint(T.danger, 12), border: tint(T.danger, 32), hover: tint(T.danger, 24) },
            brand: { fg: T.brand, bg: tint(T.brand, 12), border: tint(T.brand, 32), hover: tint(T.brand, 24) },
            neutral: { fg: T.text, bg: tint(T.text3, 14), border: T.border, hover: tint(T.text3, 22) },
        };

        function ActionChip({ label, title, tone, onClick, disabled }) {
            const [hover, setHover] = useState(false);
            const palette = chipTone[tone] ?? chipTone.neutral;
            const off = disabled === true;
            return h("button", {
                type: "button",
                className: "hub-swatch",
                title,
                "aria-label": title,
                onClick,
                disabled: off,
                onMouseEnter: () => setHover(true),
                onMouseLeave: () => setHover(false),
                style: {
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    // A narrow rail used to squeeze these two chips until the label wrapped inside a
                    // 24px box and spilled over the border. The label stays on one line; the row wraps.
                    whiteSpace: "nowrap",
                    lineHeight: 1,
                    height: 22,
                    minWidth: 0,
                    overflow: "hidden",
                    flex: "0 0 auto",
                    padding: "0 7px",
                    borderRadius: 6,
                    border: `1px solid ${off === true ? T.borderSoft : palette.border}`,
                    background: off === true ? "transparent" : (hover === true ? palette.hover : palette.bg),
                    color: off === true ? T.text3 : palette.fg,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: off === true ? "default" : "pointer",
                    opacity: 1,
                    fontFamily: "inherit",
                    transition: "background .12s ease",
                },
            }, label);
        }

        function MiniIcon({ label, title, onClick, danger }) {
            const [hover, setHover] = useState(false);
            const accent = danger === true ? T.danger : T.text;
            return h("button", {
                type: "button",
                title,
                "aria-label": title,
                onClick,
                onMouseEnter: () => setHover(true),
                onMouseLeave: () => setHover(false),
                style: {
                    width: 24,
                    height: 24,
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 5,
                    border: `1px solid ${hover === true ? (danger === true ? tint(T.danger, 45) : T.border) : T.borderSoft}`,
                    background: hover === true ? (danger === true ? tint(T.danger, 14) : T.card) : "transparent",
                    color: hover === true ? accent : T.text2,
                    fontSize: 12,
                    lineHeight: "16px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "background .12s ease, color .12s ease",
                },
            }, label);
        }

        // Member count picks the colour band, not the row order: a handful reads brand,
        // a screenful green, a big group amber, and the largest red. Deeper tint as it grows.
        function groupAccent(size) {
            if (size < 5) return { accent: T.text3, accentDepth: 90 };
            if (size < 20) return { accent: T.brand, accentDepth: 90 };
            if (size < 60) return { accent: T.warn, accentDepth: 92 };
            return { accent: T.danger, accentDepth: 95 };
        }

        function GroupRow({ group, stats, t, accent, accentDepth, active, onSelect, onEnable, onRename, onDelete, onMoveUp, onMoveDown, stale, onClean, onDropRows }) {
            const [hover, setHover] = useState(false);
            const [rowsOver, setRowsOver] = useState(false);
            const count = group.members.length;
            const live = stats ?? { on: 0, total: count };
            const allOn = live.total > 0 && live.on === live.total;
            const noneOn = live.on === 0;
            return h("div", {
                onMouseEnter: () => setHover(true),
                onMouseLeave: () => { setHover(false); setRowsOver(false); },
                onDragOver: (event) => {
                    if (!event.dataTransfer.types.includes("application/x-tool-hub-rows")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setRowsOver(true);
                },
                onDragLeave: () => setRowsOver(false),
                onDrop: (event) => {
                    if (!event.dataTransfer.types.includes("application/x-tool-hub-rows")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setRowsOver(false);
                    let items = [];
                    try { items = JSON.parse(event.dataTransfer.getData("application/x-tool-hub-rows")); }
                    catch { items = []; }
                    if (Array.isArray(items) && items.length > 0) onDropRows?.(items);
                },
                style: {
                    position: "relative",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    marginBottom: 3,
                    padding: "8px 9px 8px 12px",
                    borderRadius: 9,
                    border: `1px solid ${rowsOver === true ? T.brand : active === true ? tint(T.brand, 38) : (hover === true ? T.borderSoft : "transparent")}`,
                    background: active === true ? groupTint.activeBg : (hover === true ? T.cardHover : "transparent"),
                    transition: "background .12s ease",
                },
            },
            active === true ? h("span", {
                "aria-hidden": "true",
                style: {
                    position: "absolute",
                    left: 0,
                    top: 8,
                    bottom: 8,
                    width: 3,
                    borderRadius: "0 3px 3px 0",
                    background: groupTint.activeBar,
                },
            }) : null,
            h("button", {
                type: "button",
                onClick: onSelect,
                title: group.name,
                style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: T.text,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textAlign: "left",
                },
            },
            h("span", {
                style: {
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 14,
                    fontWeight: active === true ? 700 : 650,
                    color: T.text,
                },
            }, group.name),
            h("span", {
                title: group.auto === true ? t("autoTag") : group.name,
                style: {
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    background: tint(accent ?? T.brand, accentDepth ?? 100),
                    flex: "0 0 auto",
                },
            }),
            (group.stale ?? stale ?? 0) > 0
                ? h("button", {
                    type: "button",
                    title: t("staleHint"),
                    onClick: (event) => { event.stopPropagation(); onClean(); },
                    style: {
                        border: `1px solid ${tint(T.warn, 34)}`,
                        background: tint(T.warn, 12),
                        color: T.warn,
                        borderRadius: 999,
                        padding: "0 5px",
                        fontSize: 10,
                        fontWeight: 700,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        flex: "0 0 auto",
                    },
                }, fmt(t, "staleChip", { n: group.stale ?? stale }))
                : null,
            h("span", {
                title: fmt(t, "statHint", { on: live.on, off: live.total - live.on }),
                style: {
                    minWidth: 26,
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: allOn
                        ? tint(T.success, 16)
                        : noneOn
                            ? tint(T.text3, 12)
                            : tint(accent ?? T.brand, Math.round((accentDepth ?? 40) * 0.16)),
                    color: allOn ? T.success : noneOn ? T.text3 : T.text2,
                    fontSize: 11,
                    fontWeight: 600,
                    textAlign: "center",
                    flex: "0 0 auto",
                    fontVariantNumeric: "tabular-nums",
                },
            }, live.total === 0 ? "0" : `${live.on}/${live.total}`)),
            h("div", { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap", minWidth: 0 } },
                h(ActionChip, {
                    label: t("enable"),
                    title: t("toggleGroupOn"),
                    tone: "success",
                    disabled: count === 0,
                    onClick: () => onEnable(true),
                }),
                h(ActionChip, {
                    label: t("disable"),
                    title: group.role === "base" ? t("toggleBaseOff") : t("toggleGroupOff"),
                    tone: group.role === "base" ? "danger" : "neutral",
                    disabled: count === 0,
                    onClick: () => onEnable(false),
                }),
                h("div", { style: { flex: 1 } }),
                h(MiniIcon, { label: "↑", title: t("moveUp"), onClick: onMoveUp }),
                h(MiniIcon, { label: "↓", title: t("moveDown"), onClick: onMoveDown }),
                h(MiniIcon, { label: "✎", title: t("rename"), onClick: onRename }),
                h(MiniIcon, { label: "✕", title: t("remove"), onClick: onDelete, danger: true })));
        }


        function Row({ row, t, picked, onPick, onToggle, busy, onEdit, onDelete, onTools, onLazy, onPreview, onSkillDelete, onSkillMove, onDiag, nested, failed, dragEnabled, showDesc, onRowDragStart, onRowDragEnd, onRemove }) {
            const [hover, setHover] = useState(false);
            const readOnly = row.manageable === false;
            const selfEntry = row.self === true;
            // One line of secondary text per row, and only where it adds something: an MCP row
            // says how it connects, a skill row says which root it came from, a plugin row shows
            // its description — and a nested child shows none, so a module's blurb is not repeated
            // once per child.
            const subtitle = showDesc !== true || nested === true
                ? ""
                : row.mcp === true
                    ? [row.transport, row.command || row.url].filter(Boolean).join(" · ")
                    : row.kind === "skill"
                        ? [row.rootLabel, row.description].filter(Boolean).join(" · ")
                        : (row.description ?? "");
            return h("div", {
                className: "hub-row",
                draggable: dragEnabled === true,
                onDragStart: (event) => { if (dragEnabled === true) onRowDragStart?.(event); },
                onDragEnd: () => { if (dragEnabled === true) onRowDragEnd?.(); },
                onMouseEnter: () => setHover(true),
                onMouseLeave: () => setHover(false),
                style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    // Children of a module row sit under it, so their switch lines up with the parent's name.
                    padding: nested === true ? "7px 9px 7px 26px" : "7px 9px",
                    borderRadius: 9,
                    border: `1px solid ${picked ? T.border : "transparent"}`,
                    // A failed load gets a red bar down the left edge. Inset shadow instead of a
                    // left border keeps every row's content on the same vertical line.
                    boxShadow: row.phase === "failed" ? `inset 3px 0 0 ${T.danger}` : undefined,
                    background: picked ? T.card : hover ? T.card : "transparent",
                    opacity: row.enabled ? 1 : 0.72,
                },
            },
            h("button", {
                type: "button",
                role: "checkbox",
                "aria-checked": picked,
                "aria-label": row.name,
                onClick: (event) => onPick(!picked, event.shiftKey === true),
                style: {
                    flex: "0 0 auto",
                    width: 15,
                    height: 15,
                    padding: 0,
                    borderRadius: 4,
                    border: `1px solid ${picked ? T.brand : T.border}`,
                    background: picked ? T.brand : "transparent",
                    color: T.onBrand,
                    fontSize: 10,
                    lineHeight: "13px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                },
            }, picked ? "✓" : ""),
            h("div", { style: { minWidth: 0, flex: 1 } },
                h("div", {
                    style: {
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        minWidth: 0,
                    },
                },
                h("span", {
                    style: {
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontWeight: 550,
                    },
                    title: row.kind === "plugin" ? row.moduleName : row.name,
                }, row.name),
                row.mcp === true
                    ? h(Badge, { tone: "brand", title: `${t("mcpBadgeHint")}${row.mcpPatchId ? ` · ${row.mcpPatchId}` : ""}` }, t("mcpBadge"))
                    : h(Badge, { tone: row.kind === "plugin" ? "brand" : "warn" }, row.kind === "plugin" ? t("kindPlugin") : t("kindSkill")),
                row.official === true ? h(Badge, { tone: "success", title: t("officialHint") }, t("officialBadge")) : null,
                row.builtinUi === true ? h(Badge, { tone: "warn", title: t("builtinUiHint") }, t("builtinUiBadge")) : null,
                row.dupeLabel === "" ? null : h("span", {
                    title: row.kind === "plugin" ? row.moduleName : row.name,
                    style: { fontSize: 10.5, color: T.text3, flex: "0 0 auto" },
                }, row.dupeLabel),
                readOnly ? h(Badge, {
                    tone: "warn",
                    title: typeof row.readOnlyReason === "string" && row.readOnlyReason !== "" ? row.readOnlyReason : t("readonlyHint"),
                }, t("readonly")) : null,
                selfEntry ? h(Badge, { tone: "brand", title: t("selfHint") }, t("selfBadge")) : null,
                row.phase === "failed" ? h(Badge, { tone: "danger" }, t("rowFailed")) : null),
                subtitle === "" || subtitle === null || subtitle === undefined ? null : h("div", {
                    style: {
                        marginTop: 1,
                        fontSize: 11.5,
                        color: T.text3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    },
                    title: subtitle,
                }, subtitle)),
            row.mcp === true && row.mcpEditable === true && row.toolStats !== null && row.toolStats !== undefined
                ? h(Button, { small: true, onClick: () => onTools(row), disabled: busy, title: t("toolsHint") }, fmt(t, "toolsButton", { on: row.toolStats.on, total: row.toolStats.total }))
                : null,
            row.mcp === true && row.mcpEditable === true && typeof onLazy === "function"
                ? h(Button, {
                    small: true,
                    onClick: () => onLazy(row),
                    disabled: busy,
                    title: t("lazyHint"),
                }, row.lazy === true ? t("lazyActive") : t("lazyOn"))
                : null,
            row.mcp === true && row.mcpEditable === true
                ? h(Button, { small: true, onClick: () => onEdit(row), disabled: busy, title: t("mcpEditHint") }, t("mcpEdit"))
                : null,
            row.mcp === true && row.mcpEditable === true
                ? h(Button, { small: true, tone: "danger", onClick: () => onDelete(row), disabled: busy, title: t("mcpDeleteHint") }, t("mcpDelete"))
                : null,
            row.kind === "skill" && typeof onPreview === "function"
                ? h(Button, { small: true, onClick: () => onPreview(row), disabled: busy, title: t("skillPreviewHint") }, t("skillPreview"))
                : null,
            row.kind === "skill" && typeof onSkillMove === "function"
                ? h(Button, { small: true, onClick: () => onSkillMove(row), disabled: busy, title: t("skillMoveHint") }, t("skillMove"))
                : null,
            row.kind === "skill" && typeof onSkillDelete === "function"
                ? h(Button, { small: true, tone: "danger", onClick: () => onSkillDelete(row), disabled: busy, title: t("skillDeleteHint") }, t("skillDelete"))
                : null,
            row.phase === "failed" && typeof onDiag === "function"
                ? h(Button, { small: true, tone: "danger", onClick: () => onDiag(row), disabled: busy, title: t("diagTitle") }, t("diagView"))
                : null,
            onRemove === undefined ? null : h("button", {
                type: "button",
                onClick: onRemove,
                title: t("removeFromGroup"),
                "aria-label": t("removeFromGroup"),
                style: {
                    flex: "0 0 auto",
                    padding: "2px 7px",
                    borderRadius: 6,
                    border: `1px solid ${T.border}`,
                    background: "transparent",
                    color: T.text3,
                    fontSize: 11,
                    cursor: "pointer",
                    fontFamily: "inherit",
                },
            }, t("groupRemove")),
            h("span", {
                style: {
                    flex: "0 0 auto",
                    fontSize: 11,
                    color: row.enabled ? T.success : T.text3,
                    minWidth: 30,
                    textAlign: "right",
                },
            }, row.enabled ? t("enabled") : t("disabled")),
            failed === true
                ? h("span", { title: t("failHint"), style: { color: T.danger, fontWeight: 700, fontSize: 11, flex: "0 0 auto" } }, "!")
                : null,
            h(Switch, {
                checked: row.enabled,
                disabled: busy || readOnly || selfEntry || row.builtinUi === true || String(row.id).startsWith("patch:"),
                label: `${row.enabled ? t("disable") : t("enable")}：${row.name}`,
                onChange: enabled => onToggle(enabled),
            }));
        }

        // ── dialogs ────────────────────────────────────────────────────────

        const fieldRowStyle = { display: "flex", alignItems: "center", gap: 10, marginBottom: 9 };
        const fieldLabelStyle = { width: 116, flex: "0 0 auto", fontSize: 12, color: T.text3 };
        const areaStyle = {
            width: "100%",
            minHeight: 92,
            padding: "7px 9px",
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: T.base,
            color: T.text,
            fontSize: 12,
            lineHeight: 1.5,
            resize: "vertical",
            outline: "none",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            boxSizing: "border-box",
        };

        function linesOf(text) {
            return `${text}`.split("\n").map(line => line.trim()).filter(line => line !== "");
        }

        const NAME_RULE = /^[A-Za-z0-9_-]{1,32}$/;

        function kvToText(map, keepKeys, keepMark) {
            if (map === null || typeof map !== "object" || Array.isArray(map)) return "";
            const keep = keepKeys instanceof Set ? keepKeys : null;
            return Object.entries(map).map(([key, value]) => {
                const blank = value === "" || value === null || value === undefined;
                if (keep !== null && keep.has(key) && blank && typeof keepMark === "string") return key + "=" + keepMark;
                return key + "=" + value;
            }).join("\n");
        }

        function textToKv(text, onBad, keepKeys, keepMark) {
            const out = {};
            const keep = keepKeys instanceof Set ? keepKeys : null;
            for (const line of linesOf(text)) {
                const cut = line.indexOf("=");
                if (cut <= 0) {
                    onBad(line);
                    return null;
                }
                const key = line.slice(0, cut).trim();
                let value = line.slice(cut + 1).trim();
                // A masked value left as its own placeholder posts as empty, which is the host's
                // "keep the stored secret" signal. Any other text is written as typed.
                if (keep !== null && keep.has(key) && typeof keepMark === "string" && value === keepMark) value = "";
                out[key] = value;
            }
            return out;
        }

        /**
 * What goes into a preset.
 *
 * A preset declares its own entries, so this is a list of modules, not a list of switches:
 * picking `@deepseek-ai/dsh-tool-fs` writes `- id: tool-fs / name: '@deepseek-ai/dsh-tool-fs'`
 * into that preset's `plugins:` block. Rows the runtime owns stay visible but disabled —
 * hiding them would make the list look incomplete rather than bounded.
 */

function McpEditDialog({ row, t, busy, onClose, onSave, onProbe, onOpenRaw, onDone }) {
            const creating = row === null || row === undefined;
            const config = !creating && row.config !== null && typeof row.config === "object" ? row.config : {};
            const reconnect = config.reconnect !== null && typeof config.reconnect === "object" ? config.reconnect : {};
            // The host strips env/header values and names the keys that still hold one. Those rows
            // show a placeholder instead of a value, and an untouched placeholder posts as empty,
            // which is the host's "keep what is stored" signal.
            const secrets = row !== null && row !== undefined && row.secretKeys !== null && typeof row.secretKeys === "object" ? row.secretKeys : {};
            const envSecrets = Array.isArray(secrets.env) ? secrets.env : [];
            const headerSecrets = Array.isArray(secrets.headers) ? secrets.headers : [];
            const envKeep = new Set(envSecrets);
            const headerKeep = new Set(headerSecrets);
            const keepMark = "••••••";
            const [serverName, setServerName] = useState(typeof config.serverName === "string" ? config.serverName : (creating ? "" : row.name));
            const [transport, setTransport] = useState(typeof config.transport === "string" ? config.transport : "stdio");
            const [command, setCommand] = useState(typeof config.command === "string" ? config.command : "");
            const [args, setArgs] = useState(Array.isArray(config.args) ? config.args.join("\n") : "");
            const [cwd, setCwd] = useState(typeof config.cwd === "string" ? config.cwd : "");
            const [env, setEnv] = useState(kvToText(config.env, envKeep, keepMark));
            const [url, setUrl] = useState(typeof config.url === "string" ? config.url : "");
            const [headers, setHeaders] = useState(kvToText(config.headers, headerKeep, keepMark));
            const [timeout, setTimeoutValue] = useState(typeof config.toolCallTimeoutMs === "number" ? String(config.toolCallTimeoutMs) : "");
            const [failFast, setFailFast] = useState(config.failOnStartupError === true);
            const [reconnectOn, setReconnectOn] = useState(reconnect.enabled === true);
            const [reconnectInit, setReconnectInit] = useState(typeof reconnect.initialDelayMs === "number" ? String(reconnect.initialDelayMs) : "500");
            const [reconnectMax, setReconnectMax] = useState(typeof reconnect.maxDelayMs === "number" ? String(reconnect.maxDelayMs) : "30000");
            const [reconnectTries, setReconnectTries] = useState(typeof reconnect.maxAttempts === "number" ? String(reconnect.maxAttempts) : "10");
            const [advanced, setAdvanced] = useState(false);
            const [error, setError] = useState(null);
            const [testing, setTesting] = useState(false);
            const [testResult, setTestResult] = useState(null);
            const [saving, setSaving] = useState(false);
            // OAuth lives inside this dialog so values already typed are not thrown away by a
            // second window. The host keeps the PKCE verifier; the panel only holds the state it
            // handed back and the code the user pastes from the redirect.
            const [oauth, setOauth] = useState(null);
            const [oauthCode, setOauthCode] = useState("");
            const [oauthError, setOauthError] = useState(null);
            const [oauthBusy, setOauthBusy] = useState(false);
            const [oauthCopied, setOauthCopied] = useState(false);
            // Closing by Escape or by clicking the overlay is one keystroke away from losing six
            // env lines. The first attempt warns, the second within the same dialog closes.
            const initialForm = useRef(null);
            if (initialForm.current === null) {
                initialForm.current = JSON.stringify([serverName, transport, command, args, cwd, env, url, headers, timeout, failFast, reconnectOn, reconnectInit, reconnectMax, reconnectTries]);
            }
            const formNow = () => JSON.stringify([serverName, transport, command, args, cwd, env, url, headers, timeout, failFast, reconnectOn, reconnectInit, reconnectMax, reconnectTries]);
            const [discardArmed, setDiscardArmed] = useState(false);
            const requestClose = () => {
                if (!discardArmed && formNow() !== initialForm.current) {
                    setDiscardArmed(true);
                    setError(t("mcpDiscardHint"));
                    return;
                }
                onClose();
            };

            const nameOk = NAME_RULE.test(serverName.trim());
            const nameTouched = serverName.trim().length > 0;
            const nameBad = nameTouched && !nameOk;
            const stdio = transport === "stdio";
            // OAuth only exists for a saved HTTP/SSE server that already has a URL to talk to.
            const canOauth = creating === false && url.trim() !== "";

            const numberOrNull = (text, onBad) => {
                const trimmed = text.trim();
                if (trimmed === "") return null;
                if (!/^\d+$/.test(trimmed)) {
                    onBad();
                    return undefined;
                }
                return Number(trimmed);
            };

            const collect = () => {
                if (!nameOk) {
                    setError(t("mcpBadName"));
                    return null;
                }
                const next = { serverName: serverName.trim(), transport };
                if (stdio) {
                    next.command = command.trim() === "" ? null : command.trim();
                    const argLines = linesOf(args);
                    next.args = argLines.length === 0 ? null : argLines;
                    next.cwd = cwd.trim();
                    const envObject = textToKv(env, line => setError(fmt(t, "mcpBadEnv", { line })), envKeep, keepMark);
                    if (envObject === null) return null;
                    next.env = envObject;
                    next.url = null;
                    next.headers = null;
                }
                else {
                    next.url = url.trim() === "" ? null : url.trim();
                    const headerObject = textToKv(headers, line => setError(fmt(t, "mcpBadEnv", { line })), headerKeep, keepMark);
                    if (headerObject === null) return null;
                    next.headers = headerObject;
                    next.command = null;
                    next.args = null;
                    next.cwd = "";
                    next.env = null;
                }
                const timeoutValue = numberOrNull(timeout, () => setError(t("mcpInvalidNumber")));
                if (timeoutValue === undefined) return null;
                next.toolCallTimeoutMs = timeoutValue;
                next.failOnStartupError = failFast;
                if (reconnectOn) {
                    const initial = numberOrNull(reconnectInit, () => setError(t("mcpInvalidNumber")));
                    if (initial === undefined) return null;
                    const max = numberOrNull(reconnectMax, () => setError(t("mcpInvalidNumber")));
                    if (max === undefined) return null;
                    const tries = numberOrNull(reconnectTries, () => setError(t("mcpInvalidNumber")));
                    if (tries === undefined) return null;
                    next.reconnect = { enabled: true, initialDelayMs: initial, maxDelayMs: max, maxAttempts: tries };
                }
                else next.reconnect = null;
                return next;
            };

            const submit = async () => {
                const next = collect();
                if (next === null) return;
                setError(null);
                setSaving(true);
                try {
                    const out = await onSave(creating ? null : row.mcpPatchId, next);
                    if (out !== null && out !== undefined && out.ok === false) setError(out.message ?? "");
                }
                finally {
                    setSaving(false);
                }
            };

            // Test the values as they sit in the form, saved or not.
            const probe = async () => {
                setError(null);
                setTestResult(null);
                const next = collect();
                if (next === null) return;
                setTesting(true);
                try {
                    const payload = { config: next, timeoutMs: 12000 };
                    if (!creating) payload.id = row.mcpPatchId;
                    const out = await onProbe(payload);
                    if (out === null) setTestResult({ ok: false, text: t("mcpTestAborted") });
                    else if (out.error !== undefined && out.error !== null) {
                        setTestResult({ ok: false, text: fmt(t, "mcpTestFail", { message: out.error }) });
                    }
                    else setTestResult({ ok: true, text: fmt(t, "mcpTestOk", { n: out.count, ms: out.ms }) });
                }
                finally {
                    setTesting(false);
                }
            };

            // Start the browser leg of the OAuth dance. The panel never sees the verifier; it shows
            // the URL the host built and takes the code back through mcp.oauthFinish.
            const startOauth = async () => {
                if (creating === true || oauthBusy === true) return;
                setOauthBusy(true);
                setOauthError(null);
                setOauthCopied(false);
                try {
                    const out = await runOp("mcp.oauthStart", { id: row.mcpPatchId });
                    const authorizeUrl = out !== null && out !== undefined && typeof out.authorizeUrl === "string" ? out.authorizeUrl : "";
                    const state = out !== null && out !== undefined && typeof out.state === "string" ? out.state : "";
                    if (authorizeUrl === "" || state === "") setOauthError(fmt(t, "oauthFailed", { why: t("oauthNoUrl") }));
                    else setOauth({ authorizeUrl, state });
                } catch (failure) {
                    setOauthError(fmt(t, "oauthFailed", { why: failure.message }));
                } finally {
                    setOauthBusy(false);
                }
            };

            const copyAuthorize = () => {
                if (oauth === null) return;
                const mark = () => setOauthCopied(true);
                if (typeof navigator !== "undefined" && navigator.clipboard !== null && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
                    navigator.clipboard.writeText(oauth.authorizeUrl).then(mark, () => {
                        setOauthError(fmt(t, "oauthFailed", { why: t("oauthClipboardBlocked") }));
                    });
                    return;
                }
                setOauthError(fmt(t, "oauthFailed", { why: t("oauthClipboardUnavailable") }));
            };

            const finishOauth = async () => {
                const code = oauthCode.trim();
                if (oauth === null || code === "" || oauthBusy === true) return;
                setOauthBusy(true);
                setOauthError(null);
                try {
                    await runOp("mcp.oauthFinish", { state: oauth.state, code });
                    await onDone(t("oauthDone"));
                } catch (failure) {
                    setOauthError(fmt(t, "oauthFailed", { why: failure.message }));
                    setOauthBusy(false);
                }
            };

            const chip = (value, label) => h("button", {
                key: value,
                type: "button",
                onClick: () => setTransport(value),
                style: {
                    height: 26,
                    padding: "0 11px",
                    borderRadius: 7,
                    border: "1px solid " + (transport === value ? tint(T.brand, 34) : T.border),
                    background: transport === value ? tint(T.brand, 12) : "transparent",
                    color: transport === value ? T.brand : T.text2,
                    fontSize: 12,
                    cursor: "pointer",
                    fontFamily: "inherit",
                },
            }, label);

            const area = (label, value, onChange, hint) => h("div", { style: { marginBottom: 9 } },
                h("div", { style: { fontSize: 12, color: T.text3, marginBottom: 4 } }, label),
                h("textarea", { value, onChange: event => onChange(event.target.value), spellCheck: false, style: areaStyle }),
                hint === undefined ? null : h("div", { style: { marginTop: 4, fontSize: 11, color: T.text3, lineHeight: 1.5 } }, hint));

            const numberRow = (label, value, onChange) => h("div", { style: fieldRowStyle },
                h("span", { style: fieldLabelStyle }, label),
                h(Input, { value, onChange, grow: true }));

            // One line under each KEY=VALUE box: the ${NAME} form, plus the keys the host kept
            // masked so an empty box is understood as "leave it alone" rather than "clear it".
            const hintFor = list => (list.length === 0
                ? t("secretHint")
                : `${t("secretHint")} · ${t("secretKeep")}: ${list.join(", ")}`);

            return h(Dialog, {
                title: creating ? t("mcpCreateTitle") : t("mcpEditTitle"),
                hint: t("mcpEditHint"),
                width: 560,
                onClose: requestClose,
                footer: [
                    creating || typeof onOpenRaw !== "function"
                        ? null
                        : h(Button, { key: "r", onClick: () => onOpenRaw(row), title: t("rawViewHint") }, t("rawView")),
                    h(Button, { key: "t", onClick: probe, disabled: testing || busy }, testing ? t("mcpTesting") : t("mcpTest")),
                    h(Button, { key: "c", onClick: requestClose }, t("cancel")),
                    h(Button, { key: "s", tone: "primary", disabled: busy || saving || !nameOk, onClick: submit }, t("mcpSave")),
                ],
            },
            h("div", null,
                h("div", { style: fieldRowStyle },
                    h("span", { style: fieldLabelStyle }, t("mcpName")),
                    h(Input, { value: serverName, onChange: setServerName, grow: true })),
                h("div", { style: { marginTop: -4, marginBottom: 8, fontSize: 11, color: nameBad ? T.danger : T.text3 } },
                    nameBad ? t("mcpBadName") : t("mcpNameRule")),
                h("div", { style: fieldRowStyle },
                    h("span", { style: fieldLabelStyle }, t("mcpTransport")),
                    h("div", { style: { display: "flex", gap: 6 } },
                        chip("stdio", "stdio"),
                        chip("sse", "SSE"),
                        chip("streamable-http", "HTTP"))),
                stdio
                    ? h("div", null,
                        h("div", { style: fieldRowStyle },
                            h("span", { style: fieldLabelStyle }, t("mcpCommand")),
                            h(Input, { value: command, onChange: setCommand, grow: true })),
                        area(t("mcpArgs"), args, setArgs),
                        area(t("mcpEnv"), env, setEnv, hintFor(envSecrets)),
                        h("div", { style: fieldRowStyle },
                            h("span", { style: fieldLabelStyle }, t("mcpCwd")),
                            h(Input, { value: cwd, onChange: setCwd, grow: true })))
                    : h("div", null,
                        h("div", { style: fieldRowStyle },
                            h("span", { style: fieldLabelStyle }, t("mcpUrl")),
                            h(Input, { value: url, onChange: setUrl, grow: true })),
                        area(t("mcpHeaders"), headers, setHeaders, hintFor(headerSecrets))),
                h("button", {
                    type: "button",
                    onClick: () => setAdvanced(!advanced),
                    style: {
                        marginTop: 2,
                        marginBottom: advanced ? 8 : 2,
                        padding: 0,
                        border: "none",
                        background: "transparent",
                        color: T.text3,
                        fontSize: 12,
                        cursor: "pointer",
                        fontFamily: "inherit",
                    },
                }, (advanced ? "▾ " : "▸ ") + t("mcpAdvanced")),
                advanced
                    ? h("div", null,
                        numberRow(t("mcpTimeout"), timeout, setTimeoutValue),
                        h("div", { style: fieldRowStyle },
                            h("span", { style: fieldLabelStyle }, t("mcpFailFast")),
                            h(Switch, { checked: failFast, label: t("mcpFailFast"), onChange: setFailFast })),
                        h("div", { style: fieldRowStyle },
                            h("span", { style: fieldLabelStyle }, t("mcpReconnect")),
                            h(Switch, { checked: reconnectOn, label: t("mcpReconnect"), onChange: setReconnectOn })),
                        reconnectOn
                            ? h("div", null,
                                numberRow(t("mcpReconnectInit"), reconnectInit, setReconnectInit),
                                numberRow(t("mcpReconnectMax"), reconnectMax, setReconnectMax),
                                numberRow(t("mcpReconnectTries"), reconnectTries, setReconnectTries))
                            : null)
                    : null,
                error === null ? null : h("div", { style: { marginTop: 4, fontSize: 12, color: T.danger } }, error),
                testResult === null ? null : h("div", {
                    style: {
                        marginTop: 6,
                        padding: "6px 9px",
                        borderRadius: 7,
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: testResult.ok ? T.success : T.danger,
                        background: tint(testResult.ok ? T.success : T.danger, 10),
                        border: "1px solid " + tint(testResult.ok ? T.success : T.danger, 30),
                    },
                }, testResult.text),
                canOauth
                    ? h("div", {
                        style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.borderSoft}` },
                    },
                    h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                        h("span", { style: { flex: 1, fontSize: 12, color: T.text3 } }, t("oauthTitle")),
                        h(Button, {
                            small: true,
                            onClick: startOauth,
                            disabled: oauthBusy === true || busy === true,
                        }, oauthBusy === true ? t("loading") : t("oauthLogin"))),
                    oauth === null
                        ? null
                        : h("div", { style: { marginTop: 8 } },
                            h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                                h("input", {
                                    readOnly: true,
                                    value: oauth.authorizeUrl,
                                    spellCheck: false,
                                    onFocus: (event) => event.target.select(),
                                    style: {
                                        flex: 1,
                                        minWidth: 0,
                                        height: 28,
                                        padding: "0 8px",
                                        borderRadius: 7,
                                        border: `1px solid ${T.border}`,
                                        background: T.base,
                                        color: T.text2,
                                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                                        fontSize: 11,
                                        outline: "none",
                                    },
                                }),
                                h(Button, { small: true, onClick: copyAuthorize }, oauthCopied === true ? t("copied") : t("copy")),
                                h("a", {
                                    href: oauth.authorizeUrl,
                                    target: "_blank",
                                    rel: "noreferrer",
                                    style: { flex: "0 0 auto", fontSize: 12, color: T.brand, textDecoration: "none" },
                                }, t("oauthOpen"))),
                            h("div", { style: { marginTop: 10, fontSize: 12, color: T.text3, marginBottom: 4 } }, t("oauthCode")),
                            h(Input, { value: oauthCode, onChange: setOauthCode, grow: true, onEnter: finishOauth, placeholder: t("oauthCodeHint") }),
                            h("div", { style: { marginTop: 4, fontSize: 11, color: T.text3, lineHeight: 1.5 } }, t("oauthCodeHint")),
                            h("div", { style: { marginTop: 8 } },
                                h(Button, {
                                    small: true,
                                    tone: "primary",
                                    onClick: finishOauth,
                                    disabled: oauthBusy === true || oauthCode.trim() === "",
                                }, oauthBusy === true ? t("loading") : t("save")))),
                    oauthError === null
                        ? null
                        : h("div", { style: { marginTop: 6, fontSize: 12, color: T.danger, lineHeight: 1.5 } }, oauthError))
                    : null));
        }

        function ToolEditDialog({ row, tools, t, busy, onClose, onSave }) {
            const server = row?.config?.serverName ?? row?.name ?? "";
            const list = (tools ?? []).filter(tool => tool.server === server);
            const [deny, setDeny] = useState(() => new Set(list.filter(tool => tool.enabled === false).map(tool => tool.name)));
            const [query, setQuery] = useState("");
            const wanted = `${query}`.trim().toLowerCase();
            const shown = wanted === "" ? list : list.filter(tool => tool.tool.toLowerCase().includes(wanted));
            const pick = (name, on) => {
                const next = new Set(deny);
                if (on) next.delete(name);
                else next.add(name);
                setDeny(next);
            };
            const bulk = (on) => {
                const next = new Set(deny);
                for (const tool of shown) {
                    if (on) next.delete(tool.name);
                    else next.add(tool.name);
                }
                setDeny(next);
            };
            const rowStyle = {
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 8px",
                borderRadius: 7,
                fontSize: 12.5,
            };
            return h(Dialog, {
                title: t("toolsTitle"),
                hint: t("toolsHint"),
                width: 520,
                onClose,
                footer: [
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, {
                        key: "s",
                        tone: "primary",
                        disabled: busy,
                        onClick: () => onSave(server, [...deny]),
                    }, t("save")),
                ],
                children: h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                    h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                        h("div", { style: { flex: 1, minWidth: 0 } }, h(Input, { value: query, onChange: setQuery, placeholder: t("toolsSearch"), grow: true })),
                        h(Button, { small: true, onClick: () => bulk(true), disabled: shown.length === 0 }, t("toolsAll")),
                        h(Button, { small: true, onClick: () => bulk(false), disabled: shown.length === 0 }, t("toolsNone"))),
                    list.length === 0
                        ? h("div", { style: { padding: "10px 2px", fontSize: 12, color: T.text3, lineHeight: 1.6 } }, t("toolsEmpty"))
                        : h("div", {
                            style: {
                                maxHeight: 300,
                                overflow: "auto",
                                border: `1px solid ${T.borderSoft}`,
                                borderRadius: 9,
                                padding: 4,
                            },
                        }, shown.length === 0
                            ? h("div", { style: { padding: "8px 6px", fontSize: 12, color: T.text3 } }, t("empty"))
                            : shown.map(tool => h("label", { key: tool.name, style: { ...rowStyle, cursor: "pointer" } },
                                h("input", {
                                    type: "checkbox",
                                    checked: !deny.has(tool.name),
                                    onChange: event => pick(tool.name, event.target.checked),
                                    style: { accentColor: T.brand, cursor: "pointer" },
                                }),
                                h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.text } }, tool.tool),
                                tool.panelDenied === true ? h(Badge, { tone: "warn", title: t("toolsPanelNote") }, t("badgePanel")) : null))),
                    h("div", { style: { fontSize: 11, color: T.text3 } }, fmt(t, "toolsCount", { n: list.length }))),
            });
        }

        /**
         * A skill's own SKILL.md, read through the host so the panel never touches the file
         * system itself. The host caps the text; when it is cut, say so rather than letting
         * the reader believe the file ends there.
         */
        function SkillPreviewDialog({ row, t, onClose }) {
            const [text, setText] = useState(null);
            const [truncated, setTruncated] = useState(false);
            const [error, setError] = useState(null);
            const [copied, setCopied] = useState(false);

            useEffect(() => {
                let alive = true;
                setText(null);
                setError(null);
                setTruncated(false);
                setCopied(false);
                runOp("skill.read", { id: row.id })
                    .then((result) => {
                        if (!alive) return;
                        setText(typeof result?.text === "string" ? result.text : "");
                        setTruncated(result?.truncated === true);
                    })
                    .catch((failure) => {
                        if (alive) setError(failure.message);
                    });
                return () => { alive = false; };
            }, [row.id]);

            const copy = async () => {
                const value = text === null ? "" : text;
                try {
                    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
                        await navigator.clipboard.writeText(value);
                    }
                    else if (typeof document !== "undefined") {
                        const node = document.createElement("textarea");
                        node.value = value;
                        node.style.position = "fixed";
                        node.style.opacity = "0";
                        document.body.appendChild(node);
                        node.select();
                        document.execCommand("copy");
                        document.body.removeChild(node);
                    }
                    setCopied(true);
                }
                catch {
                    setCopied(false);
                }
            };

            const body = error !== null
                ? h("div", { style: { fontSize: 12, color: T.danger, lineHeight: 1.6 } }, error)
                : text === null
                    ? h("div", { style: { fontSize: 12, color: T.text3 } }, t("loading"))
                    : h("div", null,
                        h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
                            truncated === true ? h("div", {
                                style: {
                                    flex: 1,
                                    padding: "6px 9px",
                                    borderRadius: 7,
                                    border: `1px solid ${tint(T.warn, 34)}`,
                                    background: tint(T.warn, 10),
                                    color: T.warn,
                                    fontSize: 11.5,
                                },
                            }, t("skillPreviewTruncated")) : h("span", { style: { flex: 1 } }),
                            h(Button, { onClick: copy }, copied === true ? t("copied") : t("copy"))),
                        h("pre", {
                            style: {
                                margin: 0,
                                padding: "10px 12px",
                                borderRadius: 9,
                                border: `1px solid ${T.borderSoft}`,
                                background: T.base,
                                color: T.text,
                                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                                fontSize: 11.5,
                                lineHeight: 1.55,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                maxHeight: "54vh",
                                overflow: "auto",
                            },
                        }, text));

            return h(Dialog, {
                title: t("skillPreviewTitle"),
                hint: row.name,
                width: 720,
                onClose,
                footer: [
                    h(Button, { key: "close", onClick: onClose }, t("close")),
                ],
            }, body);
        }

        /**
         * One MCP entry exactly as it sits in the profile patch. Read-only until the advanced
         * switch is on: a whole-entry replace is the one write here that can break the file,
         * so the warning stays on screen the whole time editing is allowed.
         */
        function McpRawDialog({ row, t, onClose, onSave }) {
            const [text, setText] = useState(null);
            const [error, setError] = useState(null);
            const [advanced, setAdvanced] = useState(false);
            const [saving, setSaving] = useState(false);

            useEffect(() => {
                let alive = true;
                setText(null);
                setError(null);
                runOp("mcp.raw", { id: row.mcpPatchId })
                    .then((result) => {
                        if (!alive) return;
                        setText(typeof result?.text === "string" ? result.text : "");
                    })
                    .catch((failure) => {
                        // Nothing to edit yet: the entry itself could not be read, so quote the
                        // host's reason instead of calling the text invalid.
                        if (alive) setError(failure.message);
                    });
                return () => { alive = false; };
            }, [row.mcpPatchId]);

            const submit = async () => {
                if (text === null || advanced !== true || saving === true) return;
                setSaving(true);
                setError(null);
                try {
                    const out = await onSave(row, text);
                    if (out !== null && out !== undefined && out.ok === false) setError(fmt(t, "rawInvalid", { why: out.message ?? "" }));
                    else onClose();
                }
                catch (failure) {
                    setError(fmt(t, "rawInvalid", { why: failure.message }));
                }
                finally {
                    setSaving(false);
                }
            };

            return h(Dialog, {
                title: fmt(t, "rawTitle", { name: row.name }),
                width: 680,
                onClose,
                footer: [
                    h(Button, { key: "close", onClick: onClose }, t("close")),
                    h(Button, {
                        key: "save",
                        tone: "primary",
                        disabled: text === null || advanced !== true || saving,
                        onClick: submit,
                    }, t("save")),
                ],
            },
            h("div", null,
                h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
                    h(Switch, { checked: advanced, label: t("rawEdit"), onChange: setAdvanced }),
                    h("span", {
                        onClick: () => setAdvanced(!advanced),
                        style: { fontSize: 12, color: T.text2, cursor: "pointer" },
                    }, t("rawEdit"))),
                advanced === true
                    ? h("div", {
                        style: {
                            marginBottom: 8,
                            padding: "6px 9px",
                            borderRadius: 7,
                            border: `1px solid ${tint(T.warn, 34)}`,
                            background: tint(T.warn, 10),
                            color: T.warn,
                            fontSize: 11.5,
                            lineHeight: 1.5,
                        },
                    }, t("rawWarn"))
                    : null,
                h("textarea", {
                    value: text === null ? "" : text,
                    readOnly: advanced !== true,
                    spellCheck: false,
                    placeholder: text === null ? t("loading") : undefined,
                    onChange: (event) => {
                        if (advanced === true) setText(event.target.value);
                    },
                    style: { ...areaStyle, minHeight: 280, opacity: advanced === true ? 1 : 0.9 },
                }),
                error === null ? null : h("div", {
                    style: { marginTop: 8, fontSize: 12, color: T.danger, lineHeight: 1.5, whiteSpace: "pre-wrap" },
                }, error)));
        }

        const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

        /**
         * Import a skill pack from the machine. The host owns what a path may point at (a single
         * .md, a folder, a zip); the dialog only collects the path, the destination root and
         * whether an existing skill of the same name may be replaced.
         */
        function SkillImportDialog({ t, roots, onClose, onDone }) {
            const [path, setPath] = useState("");
            const [targetId, setTargetId] = useState(roots.length === 0 ? "" : roots[0].id);
            const [overwrite, setOverwrite] = useState(false);
            const [error, setError] = useState(null);
            const [working, setWorking] = useState(false);

            const submit = async () => {
                const trimmed = path.trim();
                if (trimmed === "" || targetId === "" || working === true) return;
                setWorking(true);
                setError(null);
                try {
                    const out = await runOp("skill.import", { path: trimmed, targetId, overwrite: overwrite === true });
                    const added = out !== null && out !== undefined && Array.isArray(out.added) ? out.added.length : 0;
                    const skipped = out !== null && out !== undefined && Array.isArray(out.skipped) ? out.skipped.length : 0;
                    await onDone(fmt(t, "skillImportDone", { added, skipped }));
                } catch (failure) {
                    setError(failure.message);
                } finally {
                    setWorking(false);
                }
            };

            return h(Dialog, {
                title: t("skillImportTitle"),
                hint: t("skillImportPath"),
                width: 520,
                onClose,
                footer: [
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, {
                        key: "i",
                        tone: "primary",
                        disabled: working === true || path.trim() === "" || targetId === "",
                        onClick: submit,
                    }, working === true ? t("loading") : t("skillImport")),
                ],
            },
            h("div", null,
                h("div", { style: { marginBottom: 10 } },
                    h("div", { style: fieldLabelStyle }, t("skillImportPath")),
                    h(Input, { value: path, onChange: setPath, grow: true, onEnter: submit })),
                h("div", { style: { marginBottom: 10 } },
                    h("div", { style: fieldLabelStyle }, t("skillImportTarget")),
                    h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                        roots.map(root => choiceChip(root.id, root.label, targetId === root.id, () => setTargetId(root.id))))),
                h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    h(Switch, { checked: overwrite, label: t("skillImportOverwrite"), onChange: setOverwrite }),
                    h("span", {
                        onClick: () => setOverwrite(!overwrite),
                        style: { fontSize: 12, color: T.text2, cursor: "pointer" },
                    }, t("skillImportOverwrite"))),
                error === null ? null : h("div", {
                    style: { marginTop: 8, fontSize: 12, color: T.danger, lineHeight: 1.5, whiteSpace: "pre-wrap" },
                }, error)));
        }

        /** Move one skill to another root; the host does the copy-and-remove. */
        function SkillMoveDialog({ t, row, roots, onClose, onDone }) {
            const options = roots.filter(root => root.id !== row.rootId);
            const [targetId, setTargetId] = useState(options.length === 0 ? "" : options[0].id);
            const [error, setError] = useState(null);
            const [working, setWorking] = useState(false);

            const submit = async () => {
                if (targetId === "" || working === true) return;
                setWorking(true);
                setError(null);
                try {
                    await runOp("skill.move", { id: row.id, targetId });
                    const target = options.find(root => root.id === targetId);
                    await onDone(fmt(t, "skillMoved", { name: target === undefined ? targetId : target.label }));
                } catch (failure) {
                    setError(failure.message);
                } finally {
                    setWorking(false);
                }
            };

            return h(Dialog, {
                title: t("skillMoveTitle"),
                hint: row.name,
                width: 480,
                onClose,
                footer: [
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, {
                        key: "m",
                        tone: "primary",
                        disabled: working === true || targetId === "",
                        onClick: submit,
                    }, working === true ? t("loading") : t("skillMove")),
                ],
            },
            h("div", null,
                h("div", { style: fieldLabelStyle }, t("skillMoveTarget")),
                options.length === 0
                    ? h("div", { style: { fontSize: 12, color: T.text3, lineHeight: 1.6 } }, t("skillMoveNone"))
                    : h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                        options.map(root => choiceChip(root.id, root.label, targetId === root.id, () => setTargetId(root.id)))),
                error === null ? null : h("div", {
                    style: { marginTop: 8, fontSize: 12, color: T.danger, lineHeight: 1.5, whiteSpace: "pre-wrap" },
                }, error)));
        }

        /** Why one plugin row failed to load. The host attaches the text; without it we say so
         * instead of inventing a reason. */
        function DiagDialog({ t, row, onClose }) {
            const diagnostic = typeof row.diagnostic === "string" && row.diagnostic.trim() !== ""
                ? row.diagnostic
                : row.diagnostic !== null && row.diagnostic !== undefined
                    ? JSON.stringify(row.diagnostic, null, 2)
                    : null;
            return h(Dialog, {
                title: t("diagTitle"),
                hint: row.name,
                width: 640,
                onClose,
                footer: [h(Button, { key: "c", onClick: onClose }, t("close"))],
            },
            diagnostic === null
                ? h("div", { style: { fontSize: 12, color: T.text2, lineHeight: 1.7 } },
                    h("div", { style: { fontFamily: MONO_FONT, fontSize: 11.5, color: T.text3, marginBottom: 8 } },
                        `${row.moduleName ?? row.id ?? ""}`),
                    h("div", null, t("diagEmpty")))
                : h("pre", {
                    style: {
                        margin: 0,
                        fontFamily: MONO_FONT,
                        fontSize: 11.5,
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        color: T.text,
                        maxHeight: "54vh",
                        overflow: "auto",
                    },
                }, diagnostic));
        }

        /** The host's own operation log, newest first; capped so a long session stays scannable. */
        function HistoryDialog({ t, data, onClose }) {
            const all = data !== null && data !== undefined && Array.isArray(data.history) ? data.history : [];
            const items = all.slice(0, 50);
            const capped = all.length > items.length;
            const when = (value) => {
                const date = new Date(value);
                return Number.isNaN(date.getTime()) ? `${value ?? ""}` : date.toLocaleString();
            };
            return h(Dialog, {
                title: capped ? `${t("historyTitle")} · ${fmt(t, "historyCapped", { shown: items.length, total: all.length })}` : t("historyTitle"),
                width: 660,
                onClose,
                footer: [h(Button, { key: "c", onClick: onClose }, t("close"))],
            },
            items.length === 0
                ? h("div", { style: emptyStyle }, t("historyEmpty"))
                : h("div", { style: { maxHeight: "54vh", overflow: "auto" } },
                    items.map((item, index) => h("div", {
                        key: `history-${index}`,
                        style: {
                            display: "flex",
                            alignItems: "baseline",
                            gap: 8,
                            padding: "6px 4px",
                            borderBottom: `1px solid ${T.borderSoft}`,
                            fontSize: 12,
                        },
                    },
                    h("span", { style: { flex: "0 0 auto", color: T.text3, fontSize: 11 } }, when(item.at)),
                    h("span", { style: { flex: "0 0 auto", fontFamily: MONO_FONT, fontSize: 11.5 } }, `${item.op ?? ""}`),
                    h(Badge, { tone: item.ok === true ? "success" : "danger" }, item.ok === true ? "✓" : "✕"),
                    h("span", {
                        title: `${item.detail ?? ""}`,
                        style: { flex: 1, minWidth: 0, color: T.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                    }, `${item.detail ?? ""}`)))));
        }

        /** Read a config JSON from disk, then let the user choose whether it merges into the
         * current state or replaces it. The raw file text is forwarded so the host sees exactly
         * what was exported (comments and key order included). */
        function ConfigImportDialog({ t, onClose, onDone }) {
            const [text, setText] = useState(null);
            const [fileName, setFileName] = useState("");
            const [mode, setMode] = useState("merge");
            const [error, setError] = useState(null);
            const [working, setWorking] = useState(false);
            const [ack, setAck] = useState(false);

            const pick = async (event) => {
                const file = event.target.files !== null && event.target.files !== undefined ? event.target.files[0] : undefined;
                if (file === undefined || file === null) return;
                setFileName(file.name);
                setError(null);
                try {
                    if (typeof file.text === "function") {
                        setText(await file.text());
                    } else {
                        setText(await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(`${reader.result ?? ""}`);
                            reader.onerror = () => reject(reader.error === null ? new Error("read failed") : reader.error);
                            reader.readAsText(file);
                        }));
                    }
                } catch (failure) {
                    setText(null);
                    setError(failure.message);
                }
            };

            const submit = async () => {
                if (text === null || working === true) return;
                if (mode === "replace" && ack !== true) return;
                try {
                    JSON.parse(text);
                } catch (failure) {
                    setError(failure.message);
                    return;
                }
                setWorking(true);
                setError(null);
                try {
                    await runOp("config.import", mode === "replace" ? { json: text, mode, confirm: true } : { json: text, mode });
                    await onDone(t("configImported"));
                } catch (failure) {
                    setError(failure.message);
                } finally {
                    setWorking(false);
                }
            };

            return h(Dialog, {
                title: t("configImport"),
                hint: t("configMode"),
                width: 520,
                onClose,
                footer: [
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, {
                        key: "i",
                        tone: "primary",
                        disabled: text === null || working === true || (mode === "replace" && ack !== true),
                        onClick: submit,
                    }, working === true ? t("loading") : t("configImport")),
                ],
            },
            h("div", null,
                h("input", {
                    type: "file",
                    accept: ".json,application/json",
                    onChange: pick,
                    style: { fontSize: 12, color: T.text2, fontFamily: "inherit" },
                }),
                fileName === "" ? null : h("div", { style: { marginTop: 6, fontSize: 11.5, color: T.text3 } }, fileName),
                h("div", { style: { ...fieldLabelStyle, marginTop: 12 } }, t("configMode")),
                h("div", { style: { display: "flex", gap: 6 } },
                    choiceChip("merge", t("modeMerge"), mode === "merge", () => setMode("merge")),
                    choiceChip("replace", t("modeReplace"), mode === "replace", () => setMode("replace"))),
                mode === "replace" ? h("div", null,
                    h("div", { style: { marginTop: 8, fontSize: 12, color: T.danger, lineHeight: 1.5 } }, t("configReplaceWarn")),
                    h("label", { style: { marginTop: 8, display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: T.text2, cursor: "pointer" } },
                        h("input", { type: "checkbox", checked: ack, onChange: (event) => setAck(event.target.checked === true), style: { marginTop: 2, accentColor: T.danger } }),
                        h("span", null, t("configReplaceAck")))) : null,
                error === null ? null : h("div", {
                    style: { marginTop: 8, fontSize: 12, color: T.danger, lineHeight: 1.5, whiteSpace: "pre-wrap" },
                }, error)));
        }

        // Eight short sections: what it solves, how to use it, one caution. Long-form docs stay on
        // the plugin detail page — this drawer is the in-place reminder, not the manual.
        const HELP_SECTIONS = [
            ["helpFilterT", "helpFilterB"],
            ["helpGroupT", "helpGroupB"],
            ["helpAutoT", "helpAutoB"],
            ["helpPresetT", "helpPresetB"],
            ["helpThirdT", "helpThirdB"],
            ["helpMcpT", "helpMcpB"],
            ["helpToolsT", "helpToolsB"],
            ["helpBuiltinT", "helpBuiltinB"],
        ];

        function HelpDrawer({ t, onClose, blocked }) {
            const boxRef = useRef(null);
            useEffect(() => {
                if (typeof document === "undefined") return undefined;
                const onKey = (event) => {
                    if (event.key === "Escape") if (blocked !== true) onClose();
                };
                document.addEventListener("keydown", onKey);
                return () => document.removeEventListener("keydown", onKey);
            }, [onClose, blocked]);
            // The drawer is a modal too: keep Tab inside it and start on its own content,
            // otherwise the first Tab lands on the page behind the scrim.
            useEffect(() => {
                if (typeof document === "undefined") return undefined;
                if (blocked === true) return undefined;
                const box = boxRef.current;
                const previous = document.activeElement;
                const focusables = () => Array.prototype.slice
                    .call(box === null ? [] : box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
                    .filter(node => node.disabled !== true && node.offsetParent !== null);
                const first = focusables()[0];
                if (first !== undefined) first.focus();
                const trap = (event) => {
                    if (event.key !== "Tab") return;
                    const list = focusables();
                    if (list.length === 0) return;
                    const firstNode = list[0];
                    const lastNode = list[list.length - 1];
                    if (event.shiftKey === true && document.activeElement === firstNode) {
                        event.preventDefault();
                        lastNode.focus();
                    } else if (event.shiftKey === false && document.activeElement === lastNode) {
                        event.preventDefault();
                        firstNode.focus();
                    }
                };
                document.addEventListener("keydown", trap, true);
                return () => {
                    document.removeEventListener("keydown", trap, true);
                    if (previous !== null && previous.isConnected === true && typeof previous.focus === "function") previous.focus();
                };
            }, [blocked]);

            return h("div", {
                className: "hub-scrim",
                onClick: (event) => {
                    if (event.target === event.currentTarget) onClose();
                },
                style: {
                    position: "fixed",
                    inset: 0,
                    zIndex: 60,
                    display: "flex",
                    justifyContent: "flex-end",
                    background: T.overlay,
                },
            }, h("div", {
                role: "dialog",
                "aria-modal": "true",
                ref: boxRef,
                "aria-label": t("helpTitle"),
                style: {
                    width: 400,
                    maxWidth: "92vw",
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    borderLeft: `1px solid ${T.border}`,
                    background: "var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-layer-2, #1c1c1e))",
                    boxShadow: "-18px 0 48px rgba(0,0,0,.28)",
                    color: T.text,
                    overflow: "hidden",
                },
            },
            h("div", {
                style: { display: "flex", alignItems: "flex-start", gap: 8, padding: "14px 16px 10px", borderBottom: `1px solid ${T.borderSoft}` },
            },
            h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontSize: 14, fontWeight: 600 } }, t("helpTitle")),
                h("div", { style: { marginTop: 3, fontSize: 11.5, color: T.text3, lineHeight: 1.5 } }, t("helpHint"))),
            h(Button, { small: true, onClick: onClose, title: t("close") }, t("close"))),
            h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "2px 16px 10px" } },
                HELP_SECTIONS.map(([titleKey, bodyKey]) => h("div", {
                    key: titleKey,
                    style: { padding: "9px 0", borderBottom: `1px solid ${T.borderSoft}` },
                },
                h("div", { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 3 } }, t(titleKey)),
                h("div", { style: { fontSize: 12, color: T.text2, lineHeight: 1.6 } }, t(bodyKey))))),
            h("div", {
                style: { padding: "10px 16px 14px", borderTop: `1px solid ${T.borderSoft}`, fontSize: 11.5, color: T.text3 },
            }, t("helpDetailHint"))));
        }

        const RowMemo = React.memo(Row);

        function DialogHost({ dialog, t, busy, groups, data, onClose, onSaveMcp, onDeleteMcp, onSaveTool, onProbe, act, flash, onImportMarket, onApplyAuto, onSaveGroup, onSaveCollection, onDeleteCollection, onSavePreset, onApplyPreset, onApplyPresetNow, onUpdatePreset, onAskPresetUpdate, onAskPresetDelete, onDeletePreset, onRunBulk, onThirdOff, onThirdRestore, onRunGroupToggle, onOpenRaw, onDeleteSkill, onSaveRaw, onDone, onExportConfig, onOpenConfigImport, onOpenThird }) {
            const [thirdAck, setThirdAck] = useState(false);
            const [name, setName] = useState(dialog.kind === "rename" ? dialog.group.name : "");
            const foot = (children) => children;
            const mcpIds = new Set((data === null ? [] : data.plugins).filter(row => row.mcp === true).map(row => row.id));
            const mcpInPreset = (preset) => (preset?.enabled?.plugin ?? []).filter(id => mcpIds.has(id)).length;

            // ── skill dialogs ────────────────────────────────────────────
            if (dialog.kind === "skillPreview") {
                return h(SkillPreviewDialog, { row: dialog.row, t, onClose });
            }

            if (dialog.kind === "skillDelete") {
                return h(Dialog, {
                    title: t("skillDeleteTitle"),
                    hint: fmt(t, "skillDeleteBody", { name: dialog.row.name }),
                    width: 460,
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "d",
                            tone: "danger",
                            disabled: busy,
                            onClick: () => {
                                onClose();
                                void onDeleteSkill(dialog.row);
                            },
                        }, t("skillDelete")),
                    ]),
                });
            }

            if (dialog.kind === "mcpRaw") {
                return h(McpRawDialog, { row: dialog.row, t, onClose, onSave: onSaveRaw });
            }

            if (dialog.kind === "skillMove") {
                return h(SkillMoveDialog, { row: dialog.row, roots: skillRootList(data), t, onClose, onDone });
            }

            if (dialog.kind === "diag") {
                return h(DiagDialog, { row: dialog.row, t, onClose });
            }

            if (dialog.kind === "skillImport") {
                return h(SkillImportDialog, { roots: skillRootList(data), t, onClose, onDone });
            }

            if (dialog.kind === "history") {
                return h(HistoryDialog, { data, t, onClose });
            }

            if (dialog.kind === "configImport") {
                return h(ConfigImportDialog, { t, onClose, onDone });
            }

            if (dialog.kind === "mcpEdit") {
                return h(McpEditDialog, { row: dialog.row, t, busy, onClose, onSave: onSaveMcp, onProbe, onOpenRaw, onDone });
            }

            if (dialog.kind === "toolEdit") {
                return h(ToolEditDialog, {
                    row: dialog.row,
                    tools: data === null ? [] : data.tools,
                    t,
                    busy,
                    onClose,
                    onSave: onSaveTool,
                });
            }

            if (dialog.kind === "mcpDelete") {
                return h(Dialog, {
                    title: t("mcpDeleteTitle"),
                    hint: fmt(t, "mcpDeleteBody", { name: dialog.row.name }),
                    width: 460,
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "d",
                            tone: "danger",
                            disabled: busy,
                            onClick: () => onDeleteMcp(dialog.row.mcpPatchId),
                        }, t("mcpDelete")),
                    ]),
                });
            }

            if (dialog.kind === "confirmGroup") {
                const shared = dialog.shared ?? [];
                const riskyNames = dialog.riskyNames ?? [];
                const riskyCount = dialog.riskyCount ?? 0;
                const total = dialog.group.members.length;
                const body = h("div", { style: { display: "flex", flexDirection: "column", gap: 9 } },
                    h("div", null, shared.length > 0
                        ? fmt(t, "confirmSharedBody", {
                            name: dialog.group.name,
                            shared: shared.length,
                            all: total,
                            own: total - shared.length,
                            names: shared.slice(0, 4).map(item => item.name).join(", ") + (shared.length > 4 ? "…" : ""),
                        })
                        : fmt(t, "confirmGroupBody", {
                            name: dialog.group.name,
                            n: total,
                            action: dialog.enabled ? t("toggleGroupOn") : t("toggleGroupOff"),
                        })),
                    riskyCount > 0 && dialog.enabled === false
                        ? h("div", {
                            style: {
                                padding: "7px 10px",
                                borderRadius: 8,
                                background: tint(T.danger, 12),
                                border: `1px solid ${tint(T.danger, 32)}`,
                                color: T.danger,
                                fontSize: 12,
                                fontWeight: 600,
                                lineHeight: 1.5,
                            },
                        }, `${t("baseWarning")} ${riskyNames.join(", ")}${riskyCount > riskyNames.length ? "…" : ""}`)
                        : null);
                const actions = shared.length > 0
                    ? [
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "own",
                            tone: "primary",
                            disabled: busy,
                            onClick: () => { onClose(); void onRunGroupToggle(dialog.group, dialog.enabled, true); },
                        }, fmt(t, "confirmOnlyOwn", { own: total - shared.length })),
                        h(Button, {
                            key: "all",
                            tone: "danger",
                            disabled: busy,
                            onClick: () => { onClose(); void onRunGroupToggle(dialog.group, dialog.enabled, false); },
                        }, fmt(t, "confirmAll", { all: total })),
                    ]
                    : [
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "s",
                            tone: "primary",
                            disabled: busy,
                            onClick: () => { onClose(); void onRunGroupToggle(dialog.group, dialog.enabled, false); },
                        }, t("applyNow")),
                    ];
                return h(Dialog, {
                    title: shared.length > 0 ? t("confirmSharedTitle") : t("confirmGroupTitle"),
                    onClose,
                    footer: foot(actions),
                }, body);
            }

            if (dialog.kind === "confirmPreset") {
                const mcpLines = (dialog.mcpOn ?? 0) + (dialog.mcpOff ?? 0) === 0
                    ? ""
                    : " " + fmt(t, "confirmPresetMcp", { on: dialog.mcpOn ?? 0, off: dialog.mcpOff ?? 0 });
                return h(Dialog, {
                    title: t("confirmPresetTitle"),
                    hint: fmt(t, "confirmPresetBody", { on: dialog.on, off: dialog.off }) + mcpLines,
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "s",
                            tone: "primary",
                            disabled: busy,
                            onClick: () => onApplyPresetNow(dialog.name, dialog.mode),
                        }, t("applyNow")),
                    ]),
                });
            }

            if (dialog.kind === "newGroup") {
                return h(Dialog, {
                    title: t("newGroup"),
                    hint: t("groupName"),
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "s",
                            tone: "primary",
                            disabled: name.trim() === "" || busy,
                            onClick: () => onSaveGroup(name.trim(), [], undefined, dialog.collection ?? "default"),
                        }, t("save")),
                    ]),
                }, h(Input, { value: name, onChange: setName, placeholder: t("groupName"), autoFocus: true, onEnter: () => {
                    if (name.trim() !== "") onSaveGroup(name.trim(), [], undefined, dialog.collection ?? "default");
                } }));
            }

            if (dialog.kind === "newCollection" || dialog.kind === "renameCollection") {
                const renaming = dialog.kind === "renameCollection";
                const submit = () => onSaveCollection(name.trim(), renaming ? dialog.collection.id : undefined);
                return h(Dialog, {
                    title: renaming ? t("collectionRename") : t("collectionNew"),
                    hint: t("collectionHint"),
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "s",
                            tone: "primary",
                            disabled: name.trim() === "" || busy,
                            onClick: submit,
                        }, t("save")),
                    ]),
                }, h(Input, {
                    value: name,
                    onChange: setName,
                    placeholder: t("collectionName"),
                    autoFocus: true,
                    onEnter: () => {
                        if (name.trim() !== "") submit();
                    },
                }));
            }

            if (dialog.kind === "deleteCollection") {
                return h(Dialog, {
                    title: t("collectionDeleteTitle"),
                    hint: fmt(t, "collectionDeleteBody", { name: dialog.collection.name }),
                    width: 460,
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "d",
                            tone: "danger",
                            disabled: busy,
                            onClick: () => onDeleteCollection(dialog.collection.id),
                        }, t("collectionDelete")),
                    ]),
                });
            }

            if (dialog.kind === "rename") {
                return h(Dialog, {
                    title: t("rename"),
                    hint: dialog.group.name,
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "s",
                            tone: "primary",
                            disabled: name.trim() === "" || busy,
                            onClick: () => onSaveGroup(name.trim(), dialog.group.members, dialog.group.id, dialog.group.collection ?? "default"),
                        }, t("save")),
                    ]),
                }, h(Input, { value: name, onChange: setName, autoFocus: true }));
            }

            if (dialog.kind === "deleteGroup") {
                return h(Dialog, {
                    title: t("remove"),
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "d",
                            tone: "danger",
                            disabled: busy,
                            onClick: async () => {
                                const gone = await act("group.delete", { id: dialog.group.id });
                                if (gone !== null) onClose();
                            },
                        }, t("deleteVerb")),
                    ]),
                }, fmt(t, "removeConfirm", { name: dialog.group.name }));
            }

            if (dialog.kind === "addToGroup") {
                return h(Dialog, {
                    title: t("addToGroup"),
                    hint: fmt(t, "selected", { n: dialog.members.length }),
                    onClose,
                    footer: foot([
                        h(Button, { key: "n", onClick: () => { onClose(); } }, t("newGroup")),
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    ]),
                }, groups.length === 0
                    ? h("div", { style: emptyStyle }, t("groupPickEmpty"))
                    : groups.map(group => {
                        const existing = new Set(group.members.map(member => `${member.kind}:${member.id}`));
                        const additions = dialog.members.filter(member => !existing.has(`${member.kind}:${member.id}`));
                        return h("div", {
                            key: group.id,
                            style: {
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                padding: "8px 4px",
                                borderBottom: `1px solid ${T.borderSoft}`,
                            },
                        },
                        h("span", { style: { flex: 1 } }, group.name),
                        h("span", { style: { fontSize: 11.5, color: T.text3 } }, fmt(t, "membersCount", { n: group.members.length })),
                        h(Button, {
                            small: true,
                            disabled: busy || additions.length === 0,
                            onClick: async () => {
                                const filed = await act("group.save", {
                                    id: group.id,
                                    name: group.name,
                                    members: group.members.concat(dialog.members),
                                });
                                if (filed !== null) onClose();
                            },
                        }, `+${additions.length}`));
                    }));
            }

            if (dialog.kind === "auto") {
                const total = dialog.plan.reduce((sum, entry) => sum + entry.members.length, 0);
                return h(Dialog, {
                    title: t("autoTitle"),
                    hint: t("autoHint"),
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, { key: "a", tone: "primary", disabled: busy, onClick: onApplyAuto }, t("autoApply")),
                    ]),
                }, h("div", { style: { fontSize: 12, color: T.text3, marginBottom: 8 } }, fmt(t, "membersCount", { n: total })),
                dialog.plan.map(entry => {
                    const label = roleLabel(t, entry.role);
                    // The generated name is usually the role's own label. Printing "官方 官方" reads
                    // like a bug, so the badge only shows up when the name says something extra.
                    const showBadge = entry.name !== label;
                    return h("div", {
                    key: `${entry.role}-${entry.name}`,
                    style: {
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "6px 4px",
                        borderBottom: `1px solid ${T.borderSoft}`,
                    },
                },
                showBadge
                    ? h("span", { style: { flex: "0 0 auto" } }, h(Badge, {
                        tone: entry.role === "official" ? "warn" : (entry.role === "base" ? "danger" : "brand"),
                        title: label,
                    }, label))
                    : null,
                h("span", { style: { flex: 1 } }, entry.name),
                h("span", { style: { fontSize: 11.5, color: T.text3 } }, fmt(t, "membersCount", { n: entry.members.length })));
                }));
            }

            if (dialog.kind === "marketImport") {
                const groups = Array.isArray(dialog.groups) ? dialog.groups : [];
                return h(Dialog, {
                    title: t("marketImportTitle"),
                    hint: t("marketImportHint"),
                    width: 520,
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "i",
                            tone: "primary",
                            disabled: busy || groups.length === 0,
                            onClick: async () => {
                                const imported = await onImportMarket();
                                if (imported !== null) onClose();
                            },
                        }, t("marketImportConfirm")),
                    ]),
                }, groups.length === 0
                    ? h("div", { style: { padding: "8px 2px", fontSize: 12, color: T.text3 } }, t("marketNoGroups"))
                    : h("div", null, groups.map(entry => h("div", {
                        key: entry.name,
                        style: {
                            display: "flex",
                            alignItems: "baseline",
                            gap: 10,
                            padding: "7px 4px",
                            borderBottom: `1px solid ${T.borderSoft}`,
                        },
                    },
                    h("div", { style: { flex: 1, minWidth: 0 } },
                        h("div", { style: { fontSize: 13, fontWeight: 600 } }, entry.name),
                        entry.missing.length === 0
                            ? null
                            : h("div", { style: { marginTop: 2, fontSize: 11, color: T.warn } },
                                fmt(t, "marketImportMissing", { n: entry.missing.length }) + " · " + entry.missing.join(", "))),
                    h("div", { style: { fontSize: 11.5, color: T.text3, whiteSpace: "nowrap" } },
                        fmt(t, "marketImportRow", { members: entry.members, packages: entry.packages }))))));
            }

            if (dialog.kind === "presetUpdate") {
            return h(Dialog, {
                title: t("presetUpdateTitle"),
                hint: fmt(t, "presetUpdateBody", { name: dialog.name }),
                onClose,
                footer: [
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, { key: "u", tone: "primary", disabled: busy, onClick: async () => { const changed = await onUpdatePreset(dialog.name); if (changed !== null) onClose(); } }, t("presetUpdate")),
                ],
            });
        }
        if (dialog.kind === "bulkConfirm") {
            const count = Array.isArray(dialog.items) ? dialog.items.length : 0;
            return h(Dialog, {
                title: dialog.enabled ? t("bulkOnTitle") : t("bulkOffTitle"),
                hint: fmt(t, dialog.enabled === true ? "bulkOnBody" : "bulkOffBody", { n: count }),
                onClose,
                footer: [
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, {
                        key: "g",
                        tone: dialog.enabled ? "primary" : "danger",
                        disabled: busy,
                        onClick: () => { const items = dialog.items; const enabled = dialog.enabled; onClose(); void onRunBulk(items, enabled); },
                    }, fmt(t, "bulkGo", { n: count })),
                ],
            });
        }
        if (dialog.kind === "presetDelete") {
            return h(Dialog, {
                title: t("presetDeleteTitle"),
                hint: fmt(t, "presetDeleteBody", { name: dialog.name }),
                onClose,
                footer: [
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, { key: "d", tone: "danger", disabled: busy, onClick: () => { onClose(); void onDeletePreset(dialog.name); } }, t("presetDelete")),
                ],
            });
        }
        if (dialog.kind === "thirdOffer") {
            const rows = Array.isArray(dialog.rows) ? dialog.rows : [];
            if (typeof dialog.error === "string" && dialog.error !== "") {
                return h(Dialog, {
                    title: t("thirdOffTitle"),
                    hint: t("thirdOffHint"),
                    onClose,
                    footer: [
                        h(Button, { key: "c", onClick: onClose }, t("close")),
                        h(Button, { key: "r", tone: "primary", disabled: busy, onClick: () => { onClose(); void onOpenThird(); } }, t("retry")),
                    ],
                }, h("div", { style: { color: T.danger, fontSize: 12 } }, fmt(t, "thirdOffFailed", { why: dialog.error })));
            }
            const plugins = rows.filter(row => row.mcp !== true && row.kind !== "skill");
            const mcp = rows.filter(row => row.mcp === true);
            const skills = rows.filter(row => row.kind === "skill");
            const risky = rows.filter(row => row.role === "base").length;
            const section = (label, list) => list.length === 0 ? null : h("div", { style: { marginTop: 8 } },
                h("div", { style: { fontSize: 11.5, color: T.text3, marginBottom: 4 } }, label + " · " + list.length),
                h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                    list.map(row => h("span", {
                        key: row.kind + ":" + row.id,
                        title: row.moduleName ?? row.id,
                        style: {
                            fontSize: 11,
                            padding: "2px 7px",
                            borderRadius: 6,
                            border: "1px solid " + (row.role === "base" ? tint(T.danger, 45) : T.borderSoft),
                            color: row.role === "base" ? T.danger : T.text2,
                            background: row.role === "base" ? tint(T.danger, 10) : "transparent",
                        },
                    }, row.name))));
            return h(Dialog, {
                title: t("thirdOffTitle"),
                hint: t("thirdOffHint"),
                onClose,
                width: 560,
                footer: foot([
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, {
                        key: "o",
                        tone: "danger",
                        disabled: busy || thirdAck !== true || rows.length === 0,
                        onClick: () => {
                            onClose();
                            flash(fmt(t, "thirdOffBusy", { n: rows.length }));
                            void onThirdOff();
                        },
                    }, fmt(t, "thirdOffApply", { n: rows.length })),
                ]),
            },
            rows.length === 0
                ? h("div", { style: emptyStyle }, t("thirdOffEmpty"))
                : h("div", { style: { maxHeight: 280, overflowY: "auto", paddingRight: 4 } },
                    section(t("thirdKindPlugin"), plugins),
                    section(t("thirdKindMcp"), mcp),
                    section(t("thirdKindSkill"), skills)),
            risky === 0 ? null : h("div", {
                style: {
                    marginTop: 10,
                    padding: "7px 9px",
                    borderRadius: 7,
                    border: "1px solid " + tint(T.danger, 42),
                    background: tint(T.danger, 10),
                    color: T.danger,
                    fontSize: 11.5,
                },
            }, fmt(t, "thirdOffWarn", { n: risky })),
            h("label", {
                style: { display: "flex", alignItems: "center", gap: 7, marginTop: 10, fontSize: 12, color: T.text2, cursor: "pointer" },
            },
                h("input", {
                    type: "checkbox",
                    checked: thirdAck === true,
                    onChange: (event) => setThirdAck(event.target.checked === true),
                }),
                t("thirdOffAck")));
        }

        if (dialog.kind === "thirdRestore") {
            const snapshot = dialog.snapshot ?? {};
            const count = (Array.isArray(snapshot.plugins) ? snapshot.plugins.length : 0)
                + (Array.isArray(snapshot.skills) ? snapshot.skills.length : 0);
            return h(Dialog, {
                title: t("thirdRestoreTitle"),
                hint: fmt(t, "thirdRestoreBody", { file: snapshot.file ?? "—", n: count }),
                onClose,
                footer: foot([
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, {
                        key: "r",
                        tone: "primary",
                        disabled: busy || count === 0,
                        onClick: () => {
                            onClose();
                            flash(fmt(t, "thirdRestoreBusy", { n: count }));
                            void onThirdRestore(snapshot);
                        },
                    }, t("thirdRestore")),
                ]),
            });
        }

        if (dialog.kind === "presets") {
                const presets = data === null ? [] : data.presets;
                const enabledCount = data === null ? 0 : data.plugins.filter(row => row.enabled).length + data.skills.filter(row => row.enabled).length;
                return h(Dialog, {
                    title: t("presetTitle"),
                    hint: t("presetHint"),
                    onClose,
                    footer: foot([
                        h(Button, { key: "e", disabled: busy, onClick: () => void onExportConfig() }, t("configExport")),
                        h(Button, { key: "i", disabled: busy, onClick: onOpenConfigImport }, t("configImport")),
                        h(Button, { key: "c", onClick: onClose }, t("close")),
                        h(Button, {
                            key: "s",
                            tone: "primary",
                            disabled: name.trim() === "" || busy,
                            onClick: () => onSavePreset(name.trim()),
                        }, t("presetSave")),
                    ]),
                },
                h("div", { style: { display: "flex", gap: 8, marginBottom: 10 } },
                    h(Input, { value: name, onChange: setName, placeholder: t("presetName") })),
                h("div", { style: { fontSize: 11.5, color: T.text3, marginBottom: 6 } }, fmt(t, "membersCount", { n: enabledCount })),
                presets.length === 0
                    ? h("div", { style: emptyStyle }, t("presetEmpty"))
                    : presets.map(preset => h("div", {
                        key: preset.name,
                        style: {
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "8px 4px",
                            borderBottom: `1px solid ${T.borderSoft}`,
                        },
                    },
                    h("div", { style: { flex: 1, minWidth: 0 } },
                        h("div", { style: { fontWeight: 550 } }, preset.name),
                        h("div", { style: { fontSize: 11, color: T.text3 } },
                            fmt(t, "membersCount", { n: preset.enabled.plugin.length + preset.enabled.skill.length })
                            + (mcpInPreset(preset) === 0 ? "" : " · " + fmt(t, "presetMcpCount", { n: mcpInPreset(preset) })))),
                    h(Button, { small: true, disabled: busy, onClick: () => onAskPresetUpdate(preset.name) }, t("presetUpdate")),
                    h(Button, { small: true, disabled: busy, onClick: () => onApplyPreset(preset.name, "exact") }, t("presetApply")),
                    h(Button, { small: true, disabled: busy, onClick: () => onApplyPreset(preset.name, "only-enable") }, t("presetOnlyOn")),
                    h(Button, {
                        small: true,
                        tone: "danger",
                        disabled: busy,
                        onClick: () => onAskPresetDelete(preset.name),
                    }, t("presetDelete")))));
            }

            return null;
        }

        // ── entry ──────────────────────────────────────────────────────────
        const inject = ["slots", "locale"];

        function PanelIcon() {
            return h("svg", {
                width: 18,
                height: 18,
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                strokeWidth: 1.7,
                strokeLinecap: "round",
                strokeLinejoin: "round",
                "aria-hidden": "true",
            },
            h("circle", { cx: 12, cy: 11, r: 3.1, fill: "currentColor", stroke: "none" }),
            h("circle", { cx: 4.6, cy: 6.4, r: 1.9, fill: "currentColor", stroke: "none" }),
            h("circle", { cx: 19.4, cy: 6.4, r: 1.9, fill: "currentColor", stroke: "none" }),
            h("circle", { cx: 12, cy: 20, r: 1.9, fill: "currentColor", stroke: "none" }),
            h("path", { d: "M12 11 5.6 7.4M12 11l6.4-3.6M12 11v6.2" }));
        }

        function apply(ctx) {
            const t = typeof ctx.locale?.bind === "function" ? ctx.locale.bind(NS) : key => key;
            if (typeof ctx.locale?.register === "function") {
                ctx.effect(() => ctx.locale.register(NS, { zh, en }), "tool-hub: dictionaries");
            }

            const Tab = () => h(ToolHub, { t, embedded: true });
            const Panel = () => h(ToolHub, { t, embedded: false });

            ctx.slots.inject("plugins.tab", () => ctx.slots.register({
                name: "plugins.tab",
                id: "tool-hub",
                order: 100,
                label: () => t("tabLabel"),
                locale: NS,
            }, Tab));

            ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
                name: "sidebar.panellist",
                id: "tool-hub",
                order: 2,
                label: () => t("navTitle"),
                locale: NS,
            }, PanelIcon));

            ctx.slots.inject("main", () => ctx.slots.register({
                name: "main",
                key: "tool-hub",
                locale: NS,
            }, Panel));
        }

        bundleModule.exports.NS = NS;
        bundleModule.exports.inject = inject;
        bundleModule.exports.apply = apply;
        return bundleModule.exports;
    },
});
