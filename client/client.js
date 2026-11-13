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
                mcpEditHint: '改的是 profile 的 cordis.patch.yml，只重写这一条的 config，保存后由 HMR 热加载。',
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
                mcpDeleteTitle: '删除 MCP 服务器',
                mcpDeleteBody: '将从 profile 的 cordis.patch.yml 里删掉「{name}」这一条，文件其余部分不动。',
                mcpDeleteDone: '已删除，等待热加载…',
                mcpInvalidNumber: '超时要是数字',
                mcpBadEnv: '这一行不是 KEY=VALUE：{line}',
                toolsButton: '工具 · {on}/{total}',
                toolsTitle: 'MCP 工具',
                toolsHint: '取消勾选后，这个工具对该安装的所有会话都不再出现在模型可见的工具表里；状态存在本插件自己的 state.json。',
                toolsEmpty: '这个服务器还没有注册工具。先启用它，等宿主连上，再回来刷新。',
                toolsSearch: '筛选工具名',
                toolsAll: '全选',
                toolsNone: '全不选',
                toolsSaved: '工具设置已保存',
                toolsPanelNote: '另有 {n} 项被 Skill / MCP 面板禁用（只读）',
                toolsImport: '导入他们的 {n} 项',
                toolsImported: '已导入 {n} 项',
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
                toggleGroupOn: '整组启用',
                toggleGroupOff: '整组禁用',
                rename: '改名',
            moveUp: '上移',
            moveDown: '下移',
                remove: '删除',
                removeConfirm: '删除分组「{name}」？成员本身不会被开关。',
                readonly: '宿主托管',
                autoTag: '自动分组生成',
                officialBadge: '官方',
                officialHint: '随 DSH 客户端一起安装，不是第三方插件。',
                selfBadge: '本插件',
                selfHint: '这个面板不能关掉自己，否则你就没有地方再把它打开。',
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
            compatHint: '检测到 dsh-skill-mcp-panel：写入 patch 前会先拿它的 .panel.lock；它的工具屏蔽只读并入，不写它的文件。',
            marketImport: '导入 dshmarket 分组（{n}）',
            marketImportTitle: '导入 dshmarket 分组',
            marketImportHint: '只读 dshmarket 的 state.json，把它的分组复制进来；同名分组会跳过。',
            marketImportConfirm: '导入',
            marketImportDone: '已导入 {n} 个分组',
            marketImportRow: '{members} 个插件 / {packages} 个包',
            marketImportMissing: '有 {n} 个包未安装，已跳过',
            marketNoGroups: '没有可导入的分组',
                presetOnlyOn: '只开启，不关闭',
                auto: '自动分组',
                autoTitle: '自动分组预览',
                autoHint: '按规则表分组，还没生效。确认后再写。',
                autoApply: '应用到分组',
                autoEmpty: '没有可自动分组的条目',
                resizeRail: '拖动调整左栏宽度，双击复位',
            roleOfficial: '官方',
            roleBase: '通用',
            roleRest: '用户下载',
            toggleBaseOff: '这是常开底座，关掉可能连累整条链（会先确认）',
            roleMcp: 'MCP 服务器',
            roleSkill: '技能',
            roleLoose: '手动分组',
            railEmptyTitle: '还没有分组',
                railEmptyBody: '一键自动分组会按规则把插件和技能分成几组，先看预览，确认后才写盘。',
                railEmptyAction: '自动分组',
                autoDone: '已建 {n} 个自动分组',
                cancel: '取消',
                close: '关闭',
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
                mcpEditHint: 'Edits this row in the profile cordis.patch.yml — only its config block is rewritten, and HMR applies it.',
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
                mcpDeleteTitle: 'Delete an MCP server',
                mcpDeleteBody: 'Removes the “{name}” entry from the profile cordis.patch.yml and leaves the rest of the file untouched.',
                mcpDeleteDone: 'Deleted, waiting for the reload…',
                mcpInvalidNumber: 'The timeout has to be a number.',
                mcpBadEnv: 'This line is not KEY=VALUE: {line}',
                toolsButton: 'Tools · {on}/{total}',
                toolsTitle: 'MCP tools',
                toolsHint: 'An unchecked tool disappears from the model-visible tool list in every session of this install. The list lives in this panel’s own state.json.',
                toolsEmpty: 'This server has not registered any tool yet. Enable it, wait for the host to connect, then reload.',
                toolsSearch: 'Filter tools',
                toolsAll: 'All',
                toolsNone: 'None',
                toolsSaved: 'Tool settings saved',
                toolsPanelNote: '{n} more are disabled by the Skill / MCP panel (read-only)',
                toolsImport: 'Import their {n}',
                toolsImported: 'Imported {n}',
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
                toggleGroupOn: 'Enable all',
                toggleGroupOff: 'Disable all',
                rename: 'Rename',
            moveUp: 'Move up',
            moveDown: 'Move down',
                remove: 'Delete',
                removeConfirm: 'Delete the group “{name}”? Its members keep their own state.',
                readonly: 'Host-managed',
                autoTag: 'Generated by auto grouping',
                officialBadge: 'Official',
                officialHint: 'Ships with the DSH client rather than a third-party install.',
                selfBadge: 'This plugin',
                selfHint: 'This panel cannot switch itself off — there would be no way back in.',
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
            compatHint: 'dsh-skill-mcp-panel detected: patch writes take its .panel.lock first, and its tool deny list is merged read-only.',
            marketImport: 'Import dshmarket groups ({n})',
            marketImportTitle: 'Import dshmarket groups',
            marketImportHint: 'Reads dshmarket state.json and copies its groups here; groups with a name you already use are skipped.',
            marketImportConfirm: 'Import',
            marketImportDone: 'Imported {n} groups',
            marketImportRow: '{members} plugins / {packages} packages',
            marketImportMissing: '{n} packages are not installed and were skipped',
            marketNoGroups: 'Nothing to import',
                presetOnlyOn: 'Only switch on',
                auto: 'Auto group',
                autoTitle: 'Auto group preview',
                autoHint: 'Grouped by the rule table. Nothing is written until you confirm.',
                autoApply: 'Apply to groups',
                autoEmpty: 'Nothing to auto group',
                resizeRail: 'Drag to resize the rail, double-click to reset',
            roleOfficial: 'OFFICIAL',
            roleBase: 'GENERAL',
            roleRest: 'DOWNLOADED',
            toggleBaseOff: 'This is the always-on layer; switching it off can break the chain (asks first)',
            roleMcp: 'MCP SERVERS',
            roleSkill: 'SKILLS',
            roleLoose: 'MANUAL',
            railEmptyTitle: 'No groups yet',
                railEmptyBody: 'Auto grouping sorts plugins and skills into a few groups by rule. You see a preview first; nothing is written until you apply it.',
                railEmptyAction: 'Auto group',
                autoDone: 'Created {n} automatic groups',
                cancel: 'Cancel',
                close: 'Close',
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
        function roleLabel(t, role) {
            const key = role === "official" ? "roleOfficial"
                : role === "mcp" ? "roleMcp"
                    : role === "base" ? "roleBase"
                        : "roleRest";
            return t(key);
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
            useEffect(() => {
                if (typeof document === "undefined") return undefined;
                const onKey = (event) => {
                    if (event.key === "Escape") onClose();
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
                    zIndex: 60,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: T.overlay,
                    padding: 24,
                },
            }, h("div", {
                className: "hub-pop",
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
            const [note, setNote] = useState(null);
            const [view, setView] = useState("all");
            const [groupId, setGroupId] = useState(null);
            const [query, setQuery] = useState("");
            const [picked, setPicked] = useState(() => new Set());
            const [dialog, setDialog] = useState(null);
            const dirty = useRef(false);

            const refresh = useCallback(async () => {
                try {
                    const next = await readSnapshot();
                    setData(next);
                    setError(null);
                }
                catch (failure) {
                    setError(failure.message);
                }
            }, []);

            useEffect(() => {
                refresh();
            }, []);

            const flash = useCallback((message) => {
                setNote(message);
                setTimeout(() => setNote(current => (current === message ? null : current)), 3200);
            }, []);

            const act = useCallback(async (op, payload, after) => {
                setBusy(true);
                try {
                    const result = await runOp(op, payload);
                    if (typeof after === "function") after(result);
                    await refresh();
                    return result;
                }
                catch (failure) {
                    flash(failure.message);
                    return null;
                }
                finally {
                    setBusy(false);
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
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                markDropLine(event.currentTarget, event.clientY > rect.top + rect.height / 2);
            },
            onDragLeave: event => {
                if (event.currentTarget.contains(event.relatedTarget)) return;
                if (dropLine === event.currentTarget) clearDropLine();
            },
            onDrop: event => {
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
                setPicked(new Set());
            },
            onEnable: value => enableAllInGroup(group, value),
            onRename: () => setDialog({ kind: "rename", group }),
            onDelete: () => setDialog({ kind: "deleteGroup", group }),
            onMoveUp: () => moveGroup(group.id, -1),
            onMoveDown: () => moveGroup(group.id, 1),
        }));
            const plugins = data === null ? [] : data.plugins;
            const skills = data === null ? [] : data.skills;
        // How much of each group is actually running. The rail answers "what will I break if I
        // flip this?" — a group whose members are all on is a different thing from a half-on one.
        const liveByMember = useMemo(() => {
            const map = new Map();
            for (const row of plugins) map.set(`plugin:${row.id}`, row.enabled === true);
            for (const row of skills) map.set(`skill:${row.id}`, row.enabled === true);
            return map;
        }, [plugins, skills]);
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
                if (groupId !== null) {
                    const set = groupMembers.get(groupId);
                    if (set !== undefined) combined = combined.filter(row => set.has(memberKey(row.kind, row.id)));
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
                    };
                });
            }, [plugins, skills, query, view, groupId, groupMembers, data]);
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
                if (result && result.ok === false) flash(result.message || "failed");
                else if (result && result.application === "restart-required") flash(t("restart"));
            });

            const selectedMembers = () => rows
                .filter(row => picked.has(memberKey(row.kind, row.id)))
                .map(row => ({ kind: row.kind, id: row.id }));

            const togglePicked = async (enabled) => {
                const items = selectedMembers();
                if (items.length === 0) return;
                await act("bulk", { items, enabled }, (result) => {
                    const failed = result.results.filter(row => row.ok !== true).length;
                    flash(failed === 0 ? fmt(t, "moved", { n: items.length }) : `${fmt(t, "moved", { n: items.length - failed })} · ${fmt(t, "failed", { n: failed })}`);
                    setPicked(new Set());
                });
            };

            const openAuto = async () => {
                setBusy(true);
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
                    setBusy(false);
                }
            };

            const openPresets = () => setDialog({ kind: "presets" });

            const runGroupToggle = async (group, enabled) => {
                await act("group.toggle", { id: group.id, enabled }, (result) => {
                    const failed = result.results.filter(row => row.ok !== true).length;
                    flash(failed === 0 ? fmt(t, "moved", { n: result.changed }) : `${fmt(t, "moved", { n: result.changed })} · ${fmt(t, "failed", { n: failed })}`);
                });
            };

            // A big group is a hundred switches at once; ask before writing that,
            // and show how many rows it actually touches. Switching off part of the
            // always-on layer is confirmed whatever its size: it can take the rest down.
            const enableAllInGroup = async (group, enabled) => {
                if (group.members.length > 20 || (enabled === false && group.role === "base")) {
                    setDialog({ kind: "confirmGroup", group, enabled });
                    return;
                }
                await runGroupToggle(group, enabled);
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
                style: { display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px 10px" },
            },
            h("div", { style: { minWidth: 0, flex: 1 } },
                h("div", { style: { fontSize: embedded === true ? 15 : 17, fontWeight: 650, letterSpacing: 0.1 } }, t("heading")),
                h("div", { style: { marginTop: 5, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                    data === null
                        ? h("span", { style: { fontSize: 12, color: T.text3 } }, t("loading"))
                        : [
                            h(Badge, { key: "on", tone: "success" }, fmt(t, "pillOn", { n: counts.plugin[1] + counts.skill[1] })),
                            h(Badge, { key: "skills", tone: "warn" }, fmt(t, "pillSkills", { n: counts.skill[0] })),
                            h(Badge, { key: "mcp", tone: "plain" }, fmt(t, "pillMcp", { n: counts.mcp[0] })),
                            h(Badge, { key: "all", tone: "plain" }, fmt(t, "pillAll", { n: counts.plugin[0] + counts.skill[0] + counts.mcp[0] })),
                            data.compat?.active === true
                                ? h(Badge, { key: "compat", tone: "brand", title: t("compatHint") }, t("compatBadge"))
                                : null,
                        ])),
            h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" } },
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
                data?.market?.available === true
                    ? h(Button, {
                        onClick: () => setDialog({ kind: "marketImport", groups: data.market.groups }),
                        disabled: busy,
                        title: t("marketImportHint"),
                    }, fmt(t, "marketImport", { n: data.market.groups.length }))
                    : null,
                h(Button, { onClick: openPresets, disabled: busy }, t("preset")),
                h(Button, { onClick: refresh, disabled: busy }, t("reload"))));

            const tabs = h("div", {
                style: { display: "flex", gap: 4, padding: "0 16px 10px", alignItems: "center" },
            },
            [["all", t("viewAll")], ["plugin", t("viewPlugins")], ["skill", t("viewSkills")], ["mcp", fmt(t, "viewMcp", { n: counts.mcp[0] })]].map(([key, label]) => h("button", {
                key,
                type: "button",
                onClick: () => {
                    setView(key);
                    setPicked(new Set());
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

            const rail = h("div", {
                style: {
                    width: railWidth,
                    flex: `0 0 ${railWidth}px`,
                    borderRight: `1px solid ${T.borderSoft}`,
                    padding: "10px 8px",
                    overflow: "auto",
                },
            },
            h("div", {
                style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0 6px 8px",
                },
            },
            h("div", { style: { fontSize: 11, letterSpacing: 0.4, color: T.text3, textTransform: "uppercase" } }, t("groups"))),

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
                    h("span", {
                        title: fmt(t, "statHint", { on: sumStats(drawer.list).on, off: sumStats(drawer.list).total - sumStats(drawer.list).on }),
                        style: { fontSize: 10.5, color: T.text3, fontVariantNumeric: "tabular-nums" },
                    }, statText(sumStats(drawer.list)))),
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
            h("div", { key: "rail-actions", style: { display: "flex", gap: 6, marginTop: 8 } },
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

            const rowNode = (row, nested) => h(Row, {
                key: memberKey(row.kind, row.id),
                row,
                t,
                nested: nested === true,
                picked: picked.has(memberKey(row.kind, row.id)),
                onPick: (value) => {
                    const next = new Set(picked);
                    const key = memberKey(row.kind, row.id);
                    if (value) next.add(key);
                    else next.delete(key);
                    setPicked(next);
                },
                onToggle: enabled => toggleRow(row.kind, row.id, enabled),
                onEdit: (target) => setDialog({ kind: "mcpEdit", row: target }),
                onDelete: (target) => setDialog({ kind: "mcpDelete", row: target }),
                onTools: (target) => setDialog({ kind: "toolEdit", row: target }),
                busy,
            });

            const treeNodes = tree.map(node => {
                if (node.entries.length === 1) return rowNode(node.entries[0], false);
                const open = openModules.has(node.key);
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

            const list = h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" } },
                h("div", { style: { flex: 1, overflow: "auto", padding: "10px 12px 12px" } },
                    data === null
                        ? h("div", { style: emptyStyle }, error === null ? t("loading") : error)
                        : rows.length === 0
                            ? h("div", { style: emptyStyle }, groupId === null ? t("empty") : t("emptyGroup"))
                            : h("div", { key: "row-view" }, treeNodes)));

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
            h(ActionChip, {
                label: t("addToGroup"),
                tone: "brand",
                onClick: () => setDialog({ kind: "addToGroup", members: selectedMembers() }),
                disabled: busy || groups.length === 0,
            }),
            h(ActionChip, { label: t("clearSelection"), tone: "neutral", onClick: () => setPicked(new Set()) }));

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
            h("span", null, `${t("skillRoots")}: ${data.paths.skillRoots.join(" · ")}`));

            return h("div", {
                style: {
                    display: "flex",
                    flexDirection: "column",
                    height: "100%",
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
            view === "all" ? rail : null,
            view === "all" ? h("div", {
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
            }) : null, list),
            selectionBar,
            note === null ? null : h("div", {
                style: {
                    padding: "7px 14px",
                    borderTop: `1px solid ${T.borderSoft}`,
                    fontSize: 12,
                    color: T.text2,
                },
            }, note),
            footer,
            dialog === null ? null : h(DialogHost, {
                dialog,
                t,
                busy,
                groups,
                data,
                onClose: () => setDialog(null),
                onSaveMcp: async (id, config) => {
                    if (id === null) await act("mcp.create", { config }, () => flash(t("mcpSaved")));
                    else await act("mcp.save", { id, config }, () => flash(t("mcpSaved")));
                    setDialog(null);
                    // A brand-new entry only becomes a loader row after the host reconciles the
                    // patch, so look again shortly instead of leaving it as an orphan row.
                    if (id === null) setTimeout(refresh, 1500);
                },
                onDeleteMcp: async (id) => {
                    await act("mcp.delete", { id }, () => flash(t("mcpDeleteDone")));
                    setDialog(null);
                    setTimeout(refresh, 1500);
                },
                onSaveTool: async (server, denied) => {
                    // Keep every other server's state exactly as it is: the op replaces the
                    // whole list, so the rest of it has to be carried over explicitly.
                    const others = (data?.tools ?? []).filter(tool => tool.server !== server && tool.enabled === false).map(tool => tool.name);
                    const deny = [...new Set([...others, ...denied])];
                    await act("tool.save", { deny }, () => flash(t("toolsSaved")));
                    setDialog(null);
                },
                act,
                flash,
                onImportMarket: async () => {
                    await act("market.import", {}, (result) => flash(fmt(t, "marketImportDone", { n: result.imported })));
                },
                onApplyAuto: async () => {
                    await act("auto.apply", {}, (result) => flash(fmt(t, "autoDone", { n: result.groups })));
                    setDialog(null);
                },
                onSaveGroup: async (name, members, id, collection) => {
                    await act("group.save", { name, members, id, collection });
                    setDialog(null);
                },
                onSaveCollection: async (name, id) => {
                    await act("collection.save", { name, id });
                    setDialog(null);
                },
                onDeleteCollection: async (id) => {
                    await act("collection.delete", { id }, () => flash(t("collectionDeleted")));
                    setDialog(null);
                },
                onSavePreset: async (name) => {
                    await act("preset.save", { name }, () => flash(`${t("presetSave")}: ${name}`));
                    setDialog(null);
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
                onRunGroupToggle: (group, enabled) => runGroupToggle(group, enabled),
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
                    width: 20,
                    height: 20,
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

        function GroupRow({ group, stats, t, accent, accentDepth, active, onSelect, onEnable, onRename, onDelete, onMoveUp, onMoveDown }) {
            const [hover, setHover] = useState(false);
            const count = group.members.length;
            const live = stats ?? { on: 0, total: count };
            const allOn = live.total > 0 && live.on === live.total;
            const noneOn = live.on === 0;
            return h("div", {
                onMouseEnter: () => setHover(true),
                onMouseLeave: () => setHover(false),
                style: {
                    position: "relative",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    marginBottom: 3,
                    padding: "8px 9px 8px 12px",
                    borderRadius: 9,
                    border: `1px solid ${active === true ? tint(T.brand, 38) : (hover === true ? T.borderSoft : "transparent")}`,
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
            group.stale > 0 ? h("span", { title: fmt(t, "stale", { n: group.stale }), style: { color: T.warn, fontSize: 11, fontWeight: 700 } }, "!") : null,
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
            Array.isArray(group.tags) && group.tags.filter(tag => tag !== "base" && tag !== "task" && tag !== "skill").length > 0
                ? h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", marginTop: -2 } },
                    group.tags.filter(tag => tag !== "base" && tag !== "task" && tag !== "skill").slice(0, 4).map(tag => h("span", {
                        key: tag,
                        style: {
                            padding: "0 5px",
                            borderRadius: 4,
                            border: `1px solid ${T.borderSoft}`,
                            color: T.text3,
                            fontSize: 10,
                            lineHeight: "16px",
                        },
                    }, tag)))
                : null,
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


        function Row({ row, t, picked, onPick, onToggle, busy, onEdit, onDelete, onTools, nested }) {
            const [hover, setHover] = useState(false);
            const readOnly = row.manageable === false;
            const selfEntry = row.self === true;
            return h("div", {
                className: "hub-row",
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
                    background: picked ? T.card : hover ? T.card : "transparent",
                    opacity: row.enabled ? 1 : 0.72,
                },
            },
            h("button", {
                type: "button",
                role: "checkbox",
                "aria-checked": picked,
                "aria-label": row.name,
                onClick: () => onPick(!picked),
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
                    ? h(Badge, { tone: "brand", title: row.mcpPatchId || "" }, t("mcpBadge"))
                    : h(Badge, { tone: row.kind === "plugin" ? "brand" : "warn" }, row.kind === "plugin" ? t("kindPlugin") : t("kindSkill")),
                row.official === true ? h(Badge, { tone: "success", title: t("officialHint") }, t("officialBadge")) : null,
                row.dupeLabel === "" ? null : h("span", {
                    title: row.kind === "plugin" ? row.moduleName : row.name,
                    style: { fontSize: 10.5, color: T.text3, flex: "0 0 auto" },
                }, row.dupeLabel),
                readOnly ? h(Badge, { tone: "warn", title: row.readOnlyReason }, t("readonly")) : null,
                selfEntry ? h(Badge, { tone: "brand", title: t("selfHint") }, t("selfBadge")) : null,
                row.phase === "failed" ? h(Badge, { tone: "danger" }, "failed") : null),
                row.mcp === true
                    ? h("div", { style: { marginTop: 1, fontSize: 11.5, color: T.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: [row.transport, row.command || row.url].filter(Boolean).join(" · ") }, [row.transport, row.command || row.url].filter(Boolean).join(" · "))
                    : row.description === "" ? null : h("div", {
                    style: {
                        marginTop: 1,
                        fontSize: 11.5,
                        color: T.text3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    },
                    title: row.description,
                }, row.description)),
            row.mcp === true && row.mcpEditable === true && row.toolStats !== null && row.toolStats !== undefined
                ? h(Button, { small: true, onClick: () => onTools(row), disabled: busy, title: t("toolsHint") }, fmt(t, "toolsButton", { on: row.toolStats.on, total: row.toolStats.total }))
                : null,
            row.mcp === true && row.mcpEditable === true
                ? h(Button, { small: true, onClick: () => onEdit(row), disabled: busy, title: t("mcpEditHint") }, t("mcpEdit"))
                : null,
            row.mcp === true && row.mcpEditable === true
                ? h(Button, { small: true, tone: "danger", onClick: () => onDelete(row), disabled: busy }, t("mcpDelete"))
                : null,
            h("span", {
                style: {
                    flex: "0 0 auto",
                    fontSize: 11,
                    color: row.enabled ? T.success : T.text3,
                    minWidth: 30,
                    textAlign: "right",
                },
            }, row.enabled ? t("enabled") : t("disabled")),
            h(Switch, {
                checked: row.enabled,
                disabled: busy || readOnly || selfEntry || String(row.id).startsWith("patch:"),
                label: row.name,
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

        function kvToText(map) {
            if (map === null || typeof map !== "object" || Array.isArray(map)) return "";
            return Object.entries(map).map(([key, value]) => key + "=" + value).join("\n");
        }

        function textToKv(text, onBad) {
            const out = {};
            for (const line of linesOf(text)) {
                const cut = line.indexOf("=");
                if (cut <= 0) {
                    onBad(line);
                    return null;
                }
                out[line.slice(0, cut).trim()] = line.slice(cut + 1).trim();
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

function McpEditDialog({ row, t, busy, onClose, onSave, onProbe }) {
            const creating = row === null || row === undefined;
            const config = !creating && row.config !== null && typeof row.config === "object" ? row.config : {};
            const reconnect = config.reconnect !== null && typeof config.reconnect === "object" ? config.reconnect : {};
            const [serverName, setServerName] = useState(typeof config.serverName === "string" ? config.serverName : (creating ? "" : row.name));
            const [transport, setTransport] = useState(typeof config.transport === "string" ? config.transport : "stdio");
            const [command, setCommand] = useState(typeof config.command === "string" ? config.command : "");
            const [args, setArgs] = useState(Array.isArray(config.args) ? config.args.join("\n") : "");
            const [cwd, setCwd] = useState(typeof config.cwd === "string" ? config.cwd : "");
            const [env, setEnv] = useState(kvToText(config.env));
            const [url, setUrl] = useState(typeof config.url === "string" ? config.url : "");
            const [headers, setHeaders] = useState(kvToText(config.headers));
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

            const nameOk = NAME_RULE.test(serverName.trim());
            const nameTouched = serverName.trim().length > 0;
            const nameBad = nameTouched && !nameOk;
            const stdio = transport === "stdio";

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
                    const envObject = textToKv(env, line => setError(fmt(t, "mcpBadEnv", { line })));
                    if (envObject === null) return null;
                    next.env = envObject;
                    next.url = null;
                    next.headers = null;
                }
                else {
                    next.url = url.trim() === "" ? null : url.trim();
                    const headerObject = textToKv(headers, line => setError(fmt(t, "mcpBadEnv", { line })));
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

            const submit = () => {
                const next = collect();
                if (next !== null) onSave(creating ? null : row.mcpPatchId, next);
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

            const area = (label, value, onChange) => h("div", { style: { marginBottom: 9 } },
                h("div", { style: { fontSize: 12, color: T.text3, marginBottom: 4 } }, label),
                h("textarea", { value, onChange: event => onChange(event.target.value), spellCheck: false, style: areaStyle }));

            const numberRow = (label, value, onChange) => h("div", { style: fieldRowStyle },
                h("span", { style: fieldLabelStyle }, label),
                h(Input, { value, onChange, grow: true }));

            return h(Dialog, {
                title: creating ? t("mcpCreateTitle") : t("mcpEditTitle"),
                hint: t("mcpEditHint"),
                width: 560,
                onClose,
                footer: [
                    h(Button, { key: "t", onClick: probe, disabled: testing || busy }, testing ? t("mcpTesting") : t("mcpTest")),
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, { key: "s", tone: "primary", disabled: busy || !nameOk, onClick: submit }, t("mcpSave")),
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
                        area(t("mcpEnv"), env, setEnv),
                        h("div", { style: fieldRowStyle },
                            h("span", { style: fieldLabelStyle }, t("mcpCwd")),
                            h(Input, { value: cwd, onChange: setCwd, grow: true })))
                    : h("div", null,
                        h("div", { style: fieldRowStyle },
                            h("span", { style: fieldLabelStyle }, t("mcpUrl")),
                            h(Input, { value: url, onChange: setUrl, grow: true })),
                        area(t("mcpHeaders"), headers, setHeaders)),
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
                }, testResult.text)));
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
                                tool.panelDenied === true ? h(Badge, { tone: "warn", title: t("toolsPanelNote") }, "panel") : null))),
                    h("div", { style: { fontSize: 11, color: T.text3 } }, fmt(t, "toolsCount", { n: list.length }))),
            });
        }

        function DialogHost({ dialog, t, busy, groups, data, onClose, onSaveMcp, onDeleteMcp, onSaveTool, onProbe, act, flash, onImportMarket, onApplyAuto, onSaveGroup, onSaveCollection, onDeleteCollection, onSavePreset, onApplyPreset, onApplyPresetNow, onRunGroupToggle }) {
            const [name, setName] = useState(dialog.kind === "rename" ? dialog.group.name : "");
            const foot = (children) => children;
            const mcpIds = new Set((data === null ? [] : data.plugins).filter(row => row.mcp === true).map(row => row.id));
            const mcpInPreset = (preset) => (preset?.enabled?.plugin ?? []).filter(id => mcpIds.has(id)).length;

            if (dialog.kind === "mcpEdit") {
                return h(McpEditDialog, { row: dialog.row, t, busy, onClose, onSave: onSaveMcp, onProbe });
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
                return h(Dialog, {
                    title: t("confirmGroupTitle"),
                    hint: fmt(t, "confirmGroupBody", {
                        name: dialog.group.name,
                        n: dialog.group.members.length,
                        action: dialog.enabled ? t("toggleGroupOn") : t("toggleGroupOff"),
                    }),
                    onClose,
                    footer: foot([
                        h(Button, { key: "c", onClick: onClose }, t("cancel")),
                        h(Button, {
                            key: "s",
                            tone: "primary",
                            disabled: busy,
                            onClick: () => onRunGroupToggle(dialog.group, dialog.enabled),
                        }, t("applyNow")),
                    ]),
                });
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
                        }, t("delete")),
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
                                await act("group.delete", { id: dialog.group.id });
                                onClose();
                            },
                        }, t("remove")),
                    ]),
                }, dialog.group.name, " — ", fmt(t, "removeConfirm", { name: dialog.group.name }));
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
                    ? h("div", { style: emptyStyle }, t("presetEmpty"))
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
                                await act("group.save", {
                                    id: group.id,
                                    name: group.name,
                                    members: group.members.concat(dialog.members),
                                });
                                onClose();
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
                            onClick: () => {
                                onImportMarket();
                                onClose();
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

            if (dialog.kind === "presets") {
                const presets = data === null ? [] : data.presets;
                const enabledCount = data === null ? 0 : data.plugins.filter(row => row.enabled).length + data.skills.filter(row => row.enabled).length;
                return h(Dialog, {
                    title: t("presetTitle"),
                    hint: t("presetHint"),
                    onClose,
                    footer: foot([
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
                    h(Button, { small: true, disabled: busy, onClick: () => onApplyPreset(preset.name, "exact") }, t("presetApply")),
                    h(Button, { small: true, disabled: busy, onClick: () => onApplyPreset(preset.name, "only-enable") }, t("presetOnlyOn")),
                    h(Button, {
                        small: true,
                        tone: "danger",
                        disabled: busy,
                        onClick: async () => {
                            await act("preset.delete", { name: preset.name });
                        },
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
