import { readFileSync, writeFileSync } from "node:fs";
const p = "client/client.js";
let s = readFileSync(p, "utf8");
const once = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`${label}: ${n}`);
  s = s.replace(a, b);
};

// DialogHost cannot reach the parent's setDialog; ask the parent to open the confirm dialog.
once(
  "onSavePreset, onApplyPreset, onApplyPresetNow, onUpdatePreset, onRunGroupToggle }) {",
  "onSavePreset, onApplyPreset, onApplyPresetNow, onUpdatePreset, onAskPresetUpdate, onRunGroupToggle }) {",
  "dialoghost signature",
);
once(
  'onClick: () => setDialog({ kind: "presetUpdate", name: preset.name })',
  'onClick: () => onAskPresetUpdate(preset.name)',
  "ask update",
);

// and the parent supplies it
once(
  "                onUpdatePreset,",
  "                onUpdatePreset,\n                onAskPresetUpdate: (name) => setDialog({ kind: \"presetUpdate\", name }),",
  "parent prop",
);
writeFileSync(p, s, "utf8");
console.log("preset update wiring fixed");
