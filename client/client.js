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
                mcpNoConfig: '这一条不在 profile patch 里，配置不能在面板里改。',
                mcpInvalidNumber: '超时要是数字',
                mcpBadEnv: '这一行不是 KEY=VALUE：{line}',
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
                presetOnlyOn: '只开启，不关闭',
                auto: '自动分组',
                autoTitle: '自动分组预览',
                autoHint: '按规则表分组，还没生效。确认后再写。',
                autoApply: '应用到分组',
                autoEmpty: '没有可自动分组的条目',
                railEmptyTitle: '还没有分组',
                railEmptyBody: '一键自动分组会按规则把插件和技能分成几组，先看预览，确认后才写盘。',
                railEmptyAction: '自动分组',
                autoDone: '已建 {n} 个自动分组',
                cancel: '取消',
                close: '关闭',
                save: '保存',
                groupName: '分组名称',
                stale: '{n} 个成员已不在清单里',
                moved: '{n} 项已更新',
                failed: '{n} 项失败',
                statePath: '状态文件',
                noManager: '这个宿主没有暴露插件管理器，插件一栏暂不可用。',
                confirmExact: '应用将同时关闭 {off} 个当前启用的条目。继续？',
                applyAnyway: '继续应用',
                membersCount: '{n} 项',
                kindPlugin: '插件',
                kindSkill: '技能',
                skillRoots: '技能目录',
                confirmGroupTitle: '确认整组操作',
                confirmGroupBody: '将对「{name}」的 {n} 项执行「{action}」。已经写下的状态可以再改回来。',
                confirmPresetTitle: '确认应用预设',
                confirmPresetBody: '将开启 {on} 项、关闭 {off} 项。',
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
                mcpNoConfig: 'This row is not in the profile patch, so its config cannot be edited here.',
                mcpInvalidNumber: 'The timeout has to be a number.',
                mcpBadEnv: 'This line is not KEY=VALUE: {line}',
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
                presetOnlyOn: 'Only switch on',
                auto: 'Auto group',
                autoTitle: 'Auto group preview',
                autoHint: 'Grouped by the rule table. Nothing is written until you confirm.',
                autoApply: 'Apply to groups',
                autoEmpty: 'Nothing to auto group',
                railEmptyTitle: 'No groups yet',
                railEmptyBody: 'Auto grouping sorts plugins and skills into a few groups by rule. You see a preview first; nothing is written until you apply it.',
                railEmptyAction: 'Auto group',
                autoDone: 'Created {n} automatic groups',
                cancel: 'Cancel',
                close: 'Close',
                save: 'Save',
                groupName: 'Group name',
                stale: '{n} members are no longer listed',
                moved: '{n} updated',
                failed: '{n} failed',
                statePath: 'State file',
                noManager: 'This host exposes no plugin manager, so the plugin list is unavailable.',
                confirmExact: 'Applying also switches off {off} rows that are on now. Continue?',
                applyAnyway: 'Apply anyway',
                membersCount: '{n} items',
                kindPlugin: 'Plugin',
                kindSkill: 'Skill',
                skillRoots: 'Skill folders',
                confirmGroupTitle: 'Confirm group action',
                confirmGroupBody: 'This will {action} all {n} items in “{name}”. Anything written here can be switched back.',
                confirmPresetTitle: 'Confirm preset',
                confirmPresetBody: 'This turns on {on} and turns off {off}.',
                applyNow: 'Apply',
        };

        /** Fill {name} placeholders in a dictionary string. */
        function fmt(t, key, vars) {
            const raw = typeof t === 'function' ? t(key) : key;
            if (typeof raw !== 'string') return key;
            if (vars === undefined) return raw;
            return raw.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
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
                    color: primary ? T.onBrand : danger ? T.danger : T.text,
                    fontSize: 12.5,
                    fontWeight: primary ? 600 : 500,
                    cursor: disabled === true ? "not-allowed" : "pointer",
                    opacity: disabled === true ? 0.55 : 1,
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
            const plugins = data === null ? [] : data.plugins;
            const skills = data === null ? [] : data.skills;

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
                        const haystack = `${row.name} ${row.moduleName || ""} ${row.description || ""} ${row.serverName || ""}`.toLowerCase();
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
                combined.sort((a, b) => {
                    if (a.kind !== b.kind) return a.kind === "plugin" ? -1 : 1;
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
                return combined.map((row) => {
                    const label = row.kind === "plugin" ? row.moduleName : row.name;
                    const index = (seen.get(label) ?? 0) + 1;
                    seen.set(label, index);
                    return { ...row, dupeLabel: (totals.get(label) ?? 0) > 1 ? `#${index}` : "" };
                });
            }, [plugins, skills, query, view, groupId, groupMembers]);

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

            const maxGroupSize = useMemo(
                () => groups.reduce((top, group) => Math.max(top, group.members.length), 1),
                [groups],
            );

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
            // and show how many rows it actually touches.
            const enableAllInGroup = async (group, enabled) => {
                if (group.members.length > 20) {
                    setDialog({ kind: "confirmGroup", group, enabled });
                    return;
                }
                await runGroupToggle(group, enabled);
            };

            const runPresetApply = async (name, mode) => {
                await act("preset.apply", { name, mode }, (result) => flash(fmt(t, "presetApplied", { n: result.applied, total: result.requested })));
                setDialog(null);
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
                        ])),
            h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" } },
                h(Button, { onClick: openAuto, disabled: busy, title: t("autoHint") }, t("auto")),
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
                    width: 196,
                    flex: "0 0 196px",
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
            h("div", { style: { fontSize: 11, letterSpacing: 0.4, color: T.text3, textTransform: "uppercase" } }, t("groups")),
            h("button", {
                type: "button",
                title: t("newGroup"),
                onClick: () => setDialog({ kind: "newGroup" }),
                style: {
                    width: 20,
                    height: 20,
                    borderRadius: 6,
                    border: `1px solid ${T.border}`,
                    background: "transparent",
                    color: T.text2,
                    cursor: "pointer",
                    lineHeight: "16px",
                    fontSize: 13,
                    padding: 0,
                    fontFamily: "inherit",
                },
            }, "+")),
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
            groups.map((group, index) => h(GroupRow, {
                key: group.id,
                group,
                accent: accentPalette[index % accentPalette.length],
                accentDepth: Math.round((0.34 + 0.66 * Math.sqrt(group.members.length / maxGroupSize)) * 100),
                t,
                active: groupId === group.id,
                onSelect: () => {
                    setGroupId(group.id);
                    setPicked(new Set());
                },
                onEnable: value => enableAllInGroup(group, value),
                onRename: () => setDialog({ kind: "rename", group }),
                onDelete: () => setDialog({ kind: "deleteGroup", group }),
            })),
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

            const list = h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" } },
                h("div", { style: { flex: 1, overflow: "auto", padding: "10px 12px 12px" } },
                    data === null
                        ? h("div", { style: emptyStyle }, error === null ? t("loading") : error)
                        : rows.length === 0
                            ? h("div", { style: emptyStyle }, groupId === null ? t("empty") : t("emptyGroup"))
                            : rows.map(row => h(Row, {
                                key: memberKey(row.kind, row.id),
                                row,
                                t,
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
                                busy,
                            }))));

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
            h("div", { style: { display: "flex", flex: 1, minHeight: 0, borderTop: `1px solid ${T.borderSoft}` } }, rail, list),
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
                    await act("mcp.save", { id, config }, () => flash(t("mcpSaved")));
                    setDialog(null);
                },
                act,
                flash,
                onApplyAuto: async () => {
                    await act("auto.apply", {}, (result) => flash(fmt(t, "autoDone", { n: result.groups })));
                    setDialog(null);
                },
                onSaveGroup: async (name, members, id) => {
                    await act("group.save", { name, members, id });
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
                    for (const row of data === null ? [] : [...data.plugins, ...data.skills]) {
                        const wanted = want.has(`${row.kind}:${row.id}`);
                        if (wanted && row.enabled !== true) on += 1;
                        if (!wanted && row.enabled === true && row.manageable !== false) off += 1;
                    }
                    if (on + off > 10) {
                        setDialog({ kind: "confirmPreset", name, mode, on, off });
                        return;
                    }
                    void runPresetApply(name, mode);
                },
                onApplyPresetNow: (name, mode) => runPresetApply(name, mode),
                onRunGroupToggle: (group, enabled) => runGroupToggle(group, enabled),
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
                title,
                onClick,
                disabled: off,
                onMouseEnter: () => setHover(true),
                onMouseLeave: () => setHover(false),
                style: {
                    height: 24,
                    padding: "0 10px",
                    borderRadius: 6,
                    border: `1px solid ${palette.border}`,
                    background: hover === true && off !== true ? palette.hover : palette.bg,
                    color: palette.fg,
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: off === true ? "default" : "pointer",
                    opacity: off === true ? 0.5 : 1,
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
                    width: 22,
                    height: 22,
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

        const accentPalette = [T.brand, T.success, T.warn, T.danger];

        function GroupRow({ group, t, accent, accentDepth, active, onSelect, onEnable, onRename, onDelete }) {
            const [hover, setHover] = useState(false);
            const count = group.members.length;
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
                style: {
                    minWidth: 22,
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: tint(accent ?? T.brand, Math.round((accentDepth ?? 40) * 0.16)),
                    color: T.text2,
                    fontSize: 11,
                    fontWeight: 600,
                    textAlign: "center",
                    flex: "0 0 auto",
                },
            }, `${count}`)),
            count === 0 ? null : h("div", { style: { display: "flex", alignItems: "center", gap: 5 } },
                h(ActionChip, { label: t("enable"), title: t("toggleGroupOn"), tone: "success", onClick: () => onEnable(true) }),
                h(ActionChip, { label: t("disable"), title: t("toggleGroupOff"), tone: "neutral", onClick: () => onEnable(false) }),
                h("div", { style: { flex: 1 } }),
                h(MiniIcon, { label: "✎", title: t("rename"), onClick: onRename }),
                h(MiniIcon, { label: "✕", title: t("remove"), onClick: onDelete, danger: true })));
        }


        function Row({ row, t, picked, onPick, onToggle, busy, onEdit }) {
            const [hover, setHover] = useState(false);
            const readOnly = row.manageable === false;
            const selfEntry = row.self === true;
            return h("div", {
                onMouseEnter: () => setHover(true),
                onMouseLeave: () => setHover(false),
                style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 9px",
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
            row.mcp === true && row.mcpEditable === true
                ? h(Button, { small: true, onClick: () => onEdit(row), disabled: busy, title: t("mcpEditHint") }, t("mcpEdit"))
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

        function McpEditDialog({ row, t, busy, onClose, onSave }) {
            const config = row.config !== null && typeof row.config === "object" ? row.config : {};
            const [serverName, setServerName] = useState(typeof config.serverName === "string" ? config.serverName : row.name);
            const [transport, setTransport] = useState(typeof config.transport === "string" ? config.transport : "stdio");
            const [command, setCommand] = useState(typeof config.command === "string" ? config.command : "");
            const [args, setArgs] = useState(Array.isArray(config.args) ? config.args.join("\n") : "");
            const [cwd, setCwd] = useState(typeof config.cwd === "string" ? config.cwd : "");
            const [env, setEnv] = useState(
                config.env !== null && typeof config.env === "object" && !Array.isArray(config.env)
                    ? Object.entries(config.env).map(([key, value]) => `${key}=${value}`).join("\n")
                    : "",
            );
            const [url, setUrl] = useState(typeof config.url === "string" ? config.url : "");
            const [timeout, setTimeoutValue] = useState(typeof config.toolCallTimeoutMs === "number" ? String(config.toolCallTimeoutMs) : "");
            const [failFast, setFailFast] = useState(config.failOnStartupError === true);
            const [error, setError] = useState(null);

            const submit = () => {
                const next = {};
                if (serverName.trim() === "") next.serverName = null;
                else next.serverName = serverName.trim();
                next.transport = transport;
                if (command.trim() === "") next.command = null;
                else next.command = command.trim();
                const argLines = linesOf(args);
                next.args = argLines.length === 0 ? null : argLines;
                next.cwd = cwd.trim() === "" ? "" : cwd.trim();
                if (url.trim() === "") next.url = null;
                else next.url = url.trim();
                const envLines = linesOf(env);
                const envObject = {};
                for (const line of envLines) {
                    const cut = line.indexOf("=");
                    if (cut <= 0) {
                        setError(fmt(t, "mcpBadEnv", { line }));
                        return;
                    }
                    envObject[line.slice(0, cut).trim()] = line.slice(cut + 1).trim();
                }
                next.env = envLines.length === 0 ? {} : envObject;
                if (timeout.trim() === "") next.toolCallTimeoutMs = null;
                else if (!/^\d+$/.test(timeout.trim())) {
                    setError(t("mcpInvalidNumber"));
                    return;
                }
                else next.toolCallTimeoutMs = Number(timeout.trim());
                next.failOnStartupError = failFast;
                onSave(row.mcpPatchId, next);
            };

            return h(Dialog, {
                title: t("mcpEditTitle"),
                hint: t("mcpEditHint"),
                width: 560,
                onClose,
                footer: [
                    h(Button, { key: "c", onClick: onClose }, t("cancel")),
                    h(Button, { key: "s", tone: "primary", disabled: busy, onClick: submit }, t("mcpSave")),
                ],
            },
            h("div", null,
                h("div", { style: fieldRowStyle },
                    h("span", { style: fieldLabelStyle }, t("mcpName")),
                    h(Input, { value: serverName, onChange: setServerName, grow: true })),
                h("div", { style: fieldRowStyle },
                    h("span", { style: fieldLabelStyle }, t("mcpTransport")),
                    h("div", { style: { display: "flex", gap: 6 } },
                        ["stdio", "sse", "http"].map(kind => h("button", {
                            key: kind,
                            type: "button",
                            onClick: () => setTransport(kind),
                            style: {
                                height: 26,
                                padding: "0 11px",
                                borderRadius: 7,
                                border: `1px solid ${transport === kind ? tint(T.brand, 34) : T.border}`,
                                background: transport === kind ? tint(T.brand, 12) : "transparent",
                                color: transport === kind ? T.brand : T.text2,
                                fontSize: 12,
                                cursor: "pointer",
                                fontFamily: "inherit",
                            },
                        }, kind)))),
                h("div", { style: fieldRowStyle },
                    h("span", { style: fieldLabelStyle }, t("mcpCommand")),
                    h(Input, { value: command, onChange: setCommand, grow: true })),
                h("div", { style: { marginBottom: 9 } },
                    h("div", { style: { fontSize: 12, color: T.text3, marginBottom: 4 } }, t("mcpArgs")),
                    h("textarea", {
                        value: args,
                        onChange: event => setArgs(event.target.value),
                        spellCheck: false,
                        style: areaStyle,
                    })),
                h("div", { style: { marginBottom: 9 } },
                    h("div", { style: { fontSize: 12, color: T.text3, marginBottom: 4 } }, t("mcpEnv")),
                    h("textarea", {
                        value: env,
                        onChange: event => setEnv(event.target.value),
                        spellCheck: false,
                        style: areaStyle,
                    })),
                h("div", { style: fieldRowStyle },
                    h("span", { style: fieldLabelStyle }, t("mcpUrl")),
                    h(Input, { value: url, onChange: setUrl, grow: true })),
                h("div", { style: fieldRowStyle },
                    h("span", { style: fieldLabelStyle }, t("mcpCwd")),
                    h(Input, { value: cwd, onChange: setCwd, grow: true })),
                h("div", { style: fieldRowStyle },
                    h("span", { style: fieldLabelStyle }, t("mcpTimeout")),
                    h(Input, { value: timeout, onChange: setTimeoutValue, grow: true })),
                h("div", { style: fieldRowStyle },
                    h("span", { style: fieldLabelStyle }, t("mcpFailFast")),
                    h(Switch, { checked: failFast, label: t("mcpFailFast"), onChange: setFailFast })),
                error === null ? null : h("div", { style: { marginTop: 4, fontSize: 12, color: T.danger } }, error)));
        }

        function DialogHost({ dialog, t, busy, groups, data, onClose, onSaveMcp, act, flash, onApplyAuto, onSaveGroup, onSavePreset, onApplyPreset, onApplyPresetNow, onRunGroupToggle }) {
            const [name, setName] = useState(dialog.kind === "rename" ? dialog.group.name : "");
            const foot = (children) => children;

            if (dialog.kind === "mcpEdit") {
                return h(McpEditDialog, { row: dialog.row, t, busy, onClose, onSave: onSaveMcp });
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
                return h(Dialog, {
                    title: t("confirmPresetTitle"),
                    hint: fmt(t, "confirmPresetBody", { on: dialog.on, off: dialog.off }),
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
                            onClick: () => onSaveGroup(name.trim(), [], undefined),
                        }, t("save")),
                    ]),
                }, h(Input, { value: name, onChange: setName, placeholder: t("groupName"), autoFocus: true, onEnter: () => {
                    if (name.trim() !== "") onSaveGroup(name.trim(), [], undefined);
                } }));
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
                            onClick: () => onSaveGroup(name.trim(), dialog.group.members, dialog.group.id),
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
                dialog.plan.map(entry => h("div", {
                    key: entry.name,
                    style: {
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "6px 4px",
                        borderBottom: `1px solid ${T.borderSoft}`,
                    },
                },
                h("span", { style: { flex: 1 } }, entry.name),
                h("span", { style: { fontSize: 11.5, color: T.text3 } }, fmt(t, "membersCount", { n: entry.members.length })))));
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
                            fmt(t, "membersCount", { n: preset.enabled.plugin.length + preset.enabled.skill.length }))),
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
