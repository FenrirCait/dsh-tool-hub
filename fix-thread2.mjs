import { readFileSync, writeFileSync } from "node:fs";
const p = "client/client.js";
let s = readFileSync(p, "utf8");
const anchor = "                onRunGroupToggle: (group, enabled, skipShared) => runGroupToggle(group, enabled, skipShared),";
if (s.split(anchor).length - 1 !== 1) throw new Error("anchor missing");
s = s.replace(anchor, "                onUpdatePreset,\n" + anchor);
writeFileSync(p, s, "utf8");
console.log("prop threaded");
