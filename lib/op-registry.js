/**
 * Single source of truth for what each dispatch op does to the world.
 *
 * The dispatch switch in `lib/index.js` decides whether an op writes state, how it is confirmed
 * and what it changes, but that knowledge is scattered across the handler functions. This table
 * is the minimal registration of three facts per op, kept honest by
 * `probe/op-registry-smoke.mjs`, which diffs these keys against the `case 'x.y':` labels in the
 * dispatch switch in both directions.
 *
 * Field semantics:
 *   - `write`:   does the op change host or external state (writes the state file, the profile
 *                patch, a skill file, flips a switch, starts a process, or makes an external
 *                request). A read that only warms its own cache stays `false`, and says so.
 *   - `confirm`: only set for irreversible or wide-blast-radius ops. `'reset'` means the caller
 *                must pass the literal token `"reset"`; `true` means a boolean confirmation.
 *   - `audit`:   `true` for actions a human would want to trace after the fact — enable/disable,
 *                group/preset/collection CRUD, MCP row CRUD, skill delete/move, third-party
 *                off/restore, config import, state reset. Pure reads and queries are `false`.
 *   - `note`:    one English sentence describing the boundary or side effect.
 */
export const OP_REGISTRY = {
  'auto.apply':       { write: true,  confirm: null,     audit: true,  note: 'Rewrites the automatic groups in state.json and stamps appliedAt.' },
  'auto.preview':     { write: false, confirm: null,     audit: false, note: 'Computes the auto-grouping plan without touching state.' },
  'bulk':             { write: true,  confirm: null,     audit: true,  note: 'Switches up to MAX_BULK plugins or skills at once; the panel confirms past 20.' },
  'collection.delete':{ write: true,  confirm: null,     audit: true,  note: 'Deletes a drawer and reassigns its groups to the default drawer.' },
  'collection.save':  { write: true,  confirm: null,     audit: true,  note: 'Creates or renames a drawer in state.json.' },
  'config.export':    { write: false, confirm: null,     audit: false, note: 'Serializes groups, collections, presets and the tool deny list to JSON.' },
  'config.import':    { write: true,  confirm: null,     audit: true,  note: 'Conditional gate: replace mode needs confirm:true and is enforced in handleConfig; merge mode adds without one.' },
  'doctor':           { write: false, confirm: null,     audit: false, note: 'Probes the patch, state, skill roots, trash and heartbeat; writes one scratch probe file it deletes again.' },
  'group.add':        { write: true,  confirm: null,     audit: true,  note: 'Appends members to a group.' },
  'group.clean':      { write: true,  confirm: null,     audit: true,  note: 'Drops group members that no longer resolve to a known plugin or skill.' },
  'group.delete':     { write: true,  confirm: null,     audit: true,  note: 'Removes a group from state.json.' },
  'group.move':       { write: true,  confirm: null,     audit: true,  note: 'Moves a group into another drawer.' },
  'group.remove':     { write: true,  confirm: null,     audit: true,  note: 'Removes members from a group.' },
  'group.reorder':    { write: true,  confirm: null,     audit: true,  note: 'Reorders groups in state.json.' },
  'group.save':       { write: true,  confirm: null,     audit: true,  note: 'Creates or updates a group.' },
  'group.toggle':     { write: true,  confirm: null,     audit: true,  note: 'Switches the plugins and skills of a group on or off through the host.' },
  'lazy.load':        { write: true,  confirm: null,     audit: false, note: 'Loads tool names back into the model view and re-applies the mask.' },
  'lazy.set':         { write: true,  confirm: null,     audit: false, note: 'Turns lazy mode on or off for one MCP server.' },
  'lazy.unload':      { write: true,  confirm: null,     audit: false, note: 'Unloads tool names from the model view.' },
  'market.import':    { write: true,  confirm: null,     audit: true,  note: 'Copies dshmarket groups into state.json, skipping names already taken.' },
  'mcp.create':       { write: true,  confirm: null,     audit: true,  note: 'Appends a new MCP row to the profile patch.' },
  'mcp.delete':       { write: true,  confirm: null,     audit: true,  note: 'Removes an MCP row from the profile patch.' },
  'mcp.oauthCancel':  { write: false, confirm: null,     audit: false, note: 'Drops the in-memory pending OAuth state; no persistent write.' },
  'mcp.oauthFinish':  { write: true,  confirm: null,     audit: true,  note: 'Exchanges the code and writes the bearer token into the MCP row headers.' },
  'mcp.oauthStart':   { write: true,  confirm: null,     audit: false, note: 'Discovers and registers a client with the server; keeps the pending pair in memory only.' },
  'mcp.probe':        { write: true,  confirm: null,     audit: false, note: 'Connects to an MCP server to list its tools; persists nothing.' },
  'mcp.raw':          { write: false, confirm: null,     audit: false, note: 'Returns one MCP row raw text from the patch.' },
  'mcp.rawSave':      { write: true,  confirm: null,     audit: true,  note: 'Writes an edited MCP row back verbatim, backed up and verified against the host.' },
  'mcp.save':         { write: true,  confirm: null,     audit: true,  note: 'Updates one MCP row config in the profile patch.' },
  'preset.apply':     { write: true,  confirm: null,     audit: true,  note: 'Switches plugins, skills and tool masking to match a preset.' },
  'preset.delete':    { write: true,  confirm: null,     audit: true,  note: 'Removes a preset from state.json.' },
  'preset.save':      { write: true,  confirm: null,     audit: true,  note: 'Creates or overwrites a preset from the current live view.' },
  'preset.update':    { write: true,  confirm: null,     audit: true,  note: 'Overwrites an existing preset snapshot.' },
  'scene.apply':      { write: true,  confirm: null,     audit: true,  note: 'Applies a saved tools + MCP scene; records a full snapshot first so scene.exit can restore it.' },
  'scene.exit':       { write: true,  confirm: null,     audit: true,  note: 'Restores the snapshot taken when the scene was applied, then clears the mode record.' },
  'scene.save':       { write: true,  confirm: null,     audit: true,  note: 'Stores a named scene; a missing section means "leave that domain alone".' },
  'session.clear':    { write: true,  confirm: null,     audit: true,  note: 'Drops one session overlay; the installation deny list is untouched.' },
  'session.set':      { write: true,  confirm: null,     audit: true,  note: 'Replaces one session overlay; only mcp__* names survive and an empty list removes the entry.' },
  'skill.delete':     { write: true,  confirm: null,     audit: true,  note: 'Moves a skill into the trash folder.' },
  'skill.import':     { write: true,  confirm: null,     audit: false, note: 'Installs skill files from a local bundle into a skill root.' },
  'skill.move':       { write: true,  confirm: null,     audit: true,  note: 'Moves a skill between skill roots.' },
  'skill.read':       { write: false, confirm: null,     audit: false, note: 'Returns a skill file text; read-only.' },
  'skill.restore':    { write: true,  confirm: null,     audit: true,  note: 'Moves a trashed skill back to its recorded root.' },
  'skill.trash':      { write: false, confirm: null,     audit: false, note: 'Lists the trash folder contents; read-only.' },
  'snapshot':         { write: false, confirm: null,     audit: false, note: 'Builds the panel snapshot; only touches its own 1.2s cache and the profile log when TOOL_HUB_PROFILE=1.' },
  'state.reset':      { write: true,  confirm: 'reset',  audit: true,  note: 'Drops every group and preset and writes an empty state; needs confirm:"reset".' },
  'thirdparty.off':   { write: true,  confirm: null,     audit: true,  note: 'Disables every third-party plugin and skill and records a rollback point; the panel asks first, the op itself does not (restore undoes it).' },
  'thirdparty.restore':{ write: true, confirm: null,     audit: true,  note: 'Re-enables the plugins and skills a rollback point captured.' },
  'thirdparty.status': { write: false, confirm: null,    audit: false, note: 'Reports the third-party targets and the latest rollback point.' },
  'toggle':           { write: true,  confirm: null,     audit: true,  note: 'Switches one plugin or skill on or off through the host.' },
  'tool.import':      { write: true,  confirm: null,     audit: false, note: 'Merges another panel tool deny list into state.json.' },
  'tool.save':        { write: true,  confirm: null,     audit: false, note: 'Replaces the tool deny list and re-applies the mask.' },
}

/**
 * The entry for one op, or `undefined` when the name is not a registered op.
 * @param {string} name
 */
export function describeOp(name) {
  return OP_REGISTRY[name]
}

/** Every registered op name, sorted. */
export function allOps() {
  return Object.keys(OP_REGISTRY).sort()
}

/**
 * Ops whose entry satisfies `predicate`, sorted. Convenience for `opsWith(e => e.confirm)`.
 * @param {(entry: {write: boolean, confirm: null|'reset'|true, audit: boolean, note: string}) => boolean} predicate
 */
export function opsWith(predicate) {
  return allOps().filter(name => predicate(OP_REGISTRY[name]))
}
