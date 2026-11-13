import { readFileSync, writeFileSync } from "node:fs";
const p = "client/client.js";
let s = readFileSync(p, "utf8");

// 1. undo the misplaced injection inside the module parent row
const badStart = s.indexOf("                    onRemove === undefined ? null : h(\"button\", {");
if (badStart < 0) throw new Error("misplaced block missing");
const badEndMarker = `}, t("groupRemove")),\n`;
const badEnd = s.indexOf(badEndMarker, badStart) + badEndMarker.length;
if (badEnd <= badStart) throw new Error("misplaced block end missing");
s = s.slice(0, badStart) + s.slice(badEnd);

// 2. put it where a row actually keeps its actions, just before the enabled label
const anchor = `            h("span", {
                style: {
                    flex: "0 0 auto",
                    fontSize: 11,
                    color: row.enabled ? T.success : T.text3,
                    minWidth: 30,
                    textAlign: "right",
                },
            }, row.enabled ? t("enabled") : t("disabled")),`;
if (s.split(anchor).length - 1 !== 1) throw new Error("row actions anchor");
const insert = `            onRemove === undefined ? null : h("button", {
                type: "button",
                onClick: onRemove,
                title: t("removeFromGroup"),
                style: {
                    flex: "0 0 auto",
                    padding: "2px 7px",
                    borderRadius: 6,
                    border: \`1px solid \${T.border}\`,
                    background: "transparent",
                    color: T.text3,
                    fontSize: 11,
                    cursor: "pointer",
                    fontFamily: "inherit",
                },
            }, t("groupRemove")),
`;
s = s.replace(anchor, insert + anchor);

writeFileSync(p, s, "utf8");
console.log("remove button moved into Row");
