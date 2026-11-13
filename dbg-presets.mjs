import { readFileSync, writeFileSync } from "node:fs";
const p = "client/client.js";
let s = readFileSync(p, "utf8");
const once = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`${label}: ${n}`);
  s = s.replace(a, b);
};
once(`        if (dialog.kind === "presets") {`, `        if (dialog.kind === "presets") { try {`, "open");
once(`                    }, t("presetDelete")))));
            }`, `                    }, t("presetDelete")))));
            } catch (err) {
                return h("div", { style: { padding: 20, color: T.danger, fontSize: 12, whiteSpace: "pre-wrap" } }, "presets error: " + String(err && err.message ? err.message : err));
            } }`, "close");
writeFileSync(p, s, "utf8");
console.log("debug wrapper in");
