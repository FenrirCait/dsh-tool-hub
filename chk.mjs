import { readFileSync, writeFileSync } from "node:fs";
const p = "package.json";
let s = readFileSync(p, "utf8");
if (s.includes('"version": "1.16.0"') === false) throw new Error("version not 1.16.0");
writeFileSync(p, s, "utf8");
console.log("ok");
