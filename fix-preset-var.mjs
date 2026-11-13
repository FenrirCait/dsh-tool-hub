import { readFileSync, writeFileSync } from "node:fs";
const p = "client/client.js";
let s = readFileSync(p, "utf8");
const bad = "                onUpdatePreset,\n                onAskPresetUpdate: (name) => setDialog({ kind: \"presetUpdate\", name }),";
if (s.split(bad).length - 1 !== 1) throw new Error("anchor missing");
s = s.replace(bad, "                onAskPresetUpdate: (name) => setDialog({ kind: \"presetUpdate\", name }),");
// drop the debug wrapper now that we know where the fault was
s = s.replace(`        if (dialog.kind === "presets") { try {`, `        if (dialog.kind === "presets") {`);
s = s.replace(`            } catch (err) {
                return h("div", { style: { padding: 20, color: T.danger, fontSize: 12, whiteSpace: "pre-wrap" } }, "presets error: " + String(err && err.message ? err.message : err));
            } }`, `            }`);
writeFileSync(p, s, "utf8");
console.log("shorthand removed, debug wrapper gone");
