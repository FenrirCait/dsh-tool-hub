import { readFileSync, writeFileSync } from "node:fs";
const p = "CHANGELOG.md";
let s = readFileSync(p, "utf8");
const entry = `## 1.16.0

- **Filters that cannot lie.** The rail has three facet rows read straight from the install:
  *Origin* (Official / Third-party / Skill / MCP, from the module name), *Shape* (Has UI /
  Headless, from \`dsh.client\` and \`dsh.bundle\` in the package's own \`package.json\`), and
  *Word*, which only lists keywords at least two packages declare. Nothing is inferred from a
  description, so a package never disappears because we guessed its topic wrong.
- **Group chips are gone.** A group is a name and an on/total count; the words live in the filter
  row where they can be combined instead of decorating every group.
- **The two "new" buttons are pinned.** The rail is now head / scrolling middle / foot, so a long
  list of groups can no longer push 新建分组 and 新建分组群 off the bottom.
- **Shift-click selects a range**, like a file manager: the range takes the state the clicked row
  is about to have, and a collapsed module contributes all of its entries.
- **Rows drag into groups.** Select one or more rows and drop them on a group to file them; the
  same package tree expansion applies, so a sub-package never lands without its parent
  (\`group.add\`).

`;
s = s.replace("## 1.15.1", entry + "## 1.15.1");
writeFileSync(p, s, "utf8");
console.log("changelog ok");
