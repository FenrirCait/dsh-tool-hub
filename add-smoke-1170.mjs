import { readFileSync, writeFileSync } from "node:fs";
const p = "probe/host-smoke.mjs";
let s = readFileSync(p, "utf8");
const anchor = "server.close()";
if (s.split(anchor).length - 1 !== 1) throw new Error("anchor");
const add = `// A single member can leave a group without deleting the group.
r = await op('group.remove', { id: addTarget.id, members: [{ kind: 'plugin', id: 'e10' }] })
const afterRemove = r.ok === true ? (await get('/tool-hub/api/snapshot')).data.groups.find(group => group.id === addTarget.id) : null
check('group.remove drops one member and keeps the rest', r.ok === true && r.data.removed === 1 && afterRemove.members.some(member => member.id === 'e9') && !afterRemove.members.some(member => member.id === 'e10'), JSON.stringify({ removed: r.data?.removed }))

// Overwriting a preset is its own verb, so a typo cannot silently replace one.
await op('preset.save', { name: 'probe-update', note: 'first' })
await op('toggle', { kind: 'plugin', id: 'e2', enabled: false })
r = await op('preset.update', { name: 'probe-update' })
const updated = r.ok === true ? (await get('/tool-hub/api/snapshot')).data.presets.find(preset => preset.name === 'probe-update') : null
check('preset.update rewrites the snapshot in place', r.ok === true && r.data.updated === true && updated !== null && updated.enabled.plugin.includes('e2') === false, JSON.stringify({ updated: r.data?.updated }))
const missing = await op('preset.update', { name: 'probe-no-such' })
check('preset.update refuses a name that does not exist', missing.ok === false && missing.error.code === 'no-preset', JSON.stringify(missing.error))

server.close()`;
s = s.replace(anchor, add);
writeFileSync(p, s, "utf8");
console.log("smoke extended");
