import { readFileSync, writeFileSync } from "node:fs";

const zh = "README.zh.md";
let s = readFileSync(zh, "utf8");
const zhOld = s.includes("- **筛选芯片**：左栏顶部是第二根轴——`官方` / `第三方` / `常开` / `按需`。它只过滤列表，不持有任何开关，\n  所以一个包既能按「第三方」找到、也能按「常开」找到，而不会被两组同时一键关掉。\n");
if (!zhOld) throw new Error("zh filter block missing");
const zhNew = `- **三层筛选**：左栏顶部三行芯片，全部读自安装本身——**来源**（官方 / 第三方 / 技能 / MCP，按模块名）、
  **形态**（有界面 / 纯后端，按包自己 \`package.json\` 里的 \`dsh.client\` 与 \`dsh.bundle\`）、**词**（只列至少两个包都
  声明的 \`keywords\`）。它们只过滤、不持有开关；也不从描述里猜功能，所以不会因为猜错主题而让某个包消失。
  组名下面不再挂关键词，词只出现在筛选行里，可以叠加使用。
- **底栏固定**：「＋新建分组」「＋新建分组群」钉在左栏底部，分组再多也顶不下去；只有中间那段滚动。
- **Shift 连选**：勾一行再按住 Shift 点另一行，中间整段按那一行的新状态选中/取消，跟文件管理器一样；
  折叠的模块会把它的全部条目一起算进来。
- **行可以拖进分组**：勾选若干行后直接拖到某个分组上，松手即入组；同样按包展开，子包不会单独进去（\`group.add\`）。
`;
s = s.replace(zhOld, zhNew);
writeFileSync(zh, s, "utf8");

const en = "README.md";
let t = readFileSync(en, "utf8");
const enOld = `- **Lenses**: a second axis above the rail — \`Official\`, \`Third-party\`, \`Always on\`, \`Per task\`. A
  lens only filters; it owns no switch, so a package can be found as third-party and as always-on
  without being flippable from two groups at once.
`;
if (!t.includes(enOld)) throw new Error("en lens block missing");
const enNew = `- **Three facet rows**, all read from the install itself: **Origin** (Official / Third-party /
  Skill / MCP, from the module name), **Shape** (Has UI / Headless, from \`dsh.client\` and
  \`dsh.bundle\` in the package's own \`package.json\`), and **Word** (only keywords that at least two
  packages declare). They filter and own no switch, and nothing is inferred from a description, so a
  package never vanishes because we guessed its topic wrong. Groups no longer carry chips.
- **A pinned foot**: 新建分组 and 新建分组群 stay at the bottom of the rail; only the middle scrolls.
- **Shift-click selects a range**, like a file manager, with a collapsed module contributing all of
  its entries.
- **Rows drag into groups**: select rows, drop them on a group, and the package tree expansion
  applies (\`group.add\`).
`;
t = t.replace(enOld, enNew);
writeFileSync(en, t, "utf8");
console.log("readmes ok");
