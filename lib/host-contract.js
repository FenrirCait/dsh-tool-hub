/**
 * Host capability contract.
 *
 * This plugin leans on a set of host services whose members the shell may drop
 * across an upgrade. Until now that only surfaced at runtime, when a call threw
 * or a feature silently stopped answering. This module turns "which capability
 * fell off, and where" into a decidable answer: a static table naming every host
 * member the plugin touches, a pure shape probe that never calls anything, and a
 * report that grades the result by the `required` flag on each row.
 *
 * The probe is deliberately only a shape check — `typeof member === 'function'`
 * — because calling a member to "verify" it would itself be the failure mode we
 * are trying to detect early, and would send requests or mutate state.
 *
 * Nothing here throws and nothing here touches the network or disk: it is a pure
 * function of the service bag it is handed.
 */

/**
 * One row per host member the plugin reads or calls. `required: true` means the
 * plugin's core path (listing, toggling, mounting the panel) breaks without it;
 * `required: false` means a feature degrades — the panel still works, one drawer
 * or one paragraph does not. `private: true` marks a member the host source
 * declares `private`, i.e. the upgrade hazard: its `fallback` must name the
 * public member that replaces it.
 *
 * @type {Array<{
 *   service: string,
 *   member: string,
 *   required: boolean,
 *   private?: boolean,
 *   fallback: string,
 *   usedFor: string,
 * }>}
 */
export const HOST_CONTRACT = [
  // ── webServer — the two same-origin JSON routes the panel posts to ─────────
  {
    service: 'webServer',
    member: 'register',
    required: true,
    fallback: 'panel API routes do not mount; skills stay reachable through the CLI (bin/dsh-tool-hub.mjs)',
    usedFor: 'mount /tool-hub/api/snapshot and /tool-hub/api/op',
  },

  // ── pluginManager — the host\'s own loader, so toggling here is toggling there ──
  {
    service: 'pluginManager',
    member: 'listPlugins',
    required: true,
    fallback: 'plugins cannot be listed or toggled; the snapshot answers 200 with an error payload',
    usedFor: 'list loader rows for the plugin view',
  },
  {
    service: 'pluginManager',
    member: 'setPluginEnabled',
    required: true,
    fallback: 'every plugin switch fails with no-plugin-manager',
    usedFor: 'enable/disable loader rows (also the MCP enable switch)',
  },
  {
    service: 'pluginManager',
    member: 'listBundles',
    required: false,
    fallback: 'the bundle view shows empty and the snapshot carries a bundleError',
    usedFor: 'group plugins by install bundle',
  },

  // ── tools — the live mask and the catalog tool ──────────────────────────────
  {
    service: 'tools',
    member: 'restrict',
    required: true,
    fallback: 'the tool mask cannot be applied; masked MCP tools stay visible to the model',
    usedFor: 'hide masked MCP tools per agent',
  },
  {
    service: 'tools',
    member: 'view',
    required: false,
    private: true,
    fallback: 'no safe replacement: tools.definitions() is post-restriction, so deriving names from it makes the mask lift itself; skip the mask and record it as a problem instead',
    usedFor: 'read the live known/restrictable tool names',
  },
  {
    service: 'tools',
    member: 'definitions',
    required: false,
    fallback: 'live tool-name discovery degrades to the saved deny list only (toolsKnown=false)',
    usedFor: 'display names in the snapshot; never as input to the mask, because the result is already restricted',
  },
  {
    service: 'tools',
    member: 'register',
    required: false,
    fallback: 'the hub_tools catalog tool is not registered; lazy load/unload stays panel-only',
    usedFor: 'register the hub_tools catalog tool',
  },

  // ── systemPrompt — the one paragraph that makes the masked catalog discoverable ──
  {
    service: 'systemPrompt',
    member: 'section',
    required: false,
    fallback: 'the lazy-tools prompt paragraph is skipped',
    usedFor: 'add the lazy tools paragraph to the prompt',
  },
  {
    service: 'systemPrompt',
    member: 'getSectionOrder',
    required: false,
    fallback: 'the section falls back to default ordering',
    usedFor: 'place the section after MCP_SERVERS',
  },

  // ── connection — the host browser-auth gate the routes resolve per request ──
  {
    service: 'connection',
    member: 'requestRejection',
    required: false,
    fallback: 'fail open to the plugin\'s own sameOrigin() check (weaker, no session cookie)',
    usedFor: 'host browser authentication on the API routes',
  },

  // ── agents — where the mask has to be re-mounted on startup ────────────────
  {
    service: 'agents',
    member: 'list',
    required: false,
    fallback: 'already-running agents keep no mask until the next agent/created event',
    usedFor: 'mount the tool mask on agents that predate this plugin',
  },

  // ── workspace discovery — first source that answers wins, in this order ────
  {
    service: 'workspaces',
    member: 'list',
    required: false,
    fallback: 'try workspaceRegistry.list(), then sessions.listWorkspaces()',
    usedFor: 'discover workspace skill roots (first source)',
  },
  {
    service: 'workspaceRegistry',
    member: 'list',
    required: false,
    fallback: 'try sessions.listWorkspaces()',
    usedFor: 'discover workspace skill roots (second source)',
  },
  {
    service: 'sessions',
    member: 'listWorkspaces',
    required: false,
    fallback: 'no workspace skill roots; only the global roots are scanned',
    usedFor: 'discover workspace skill roots (last source)',
  },

  // ── client services — the shell surface the browser half renders into ──────
  {
    service: 'slots',
    member: 'inject',
    required: true,
    fallback: 'the panel cannot mount into plugins.tab / sidebar.panellist / main',
    usedFor: 'mount the panel into the shell tabs and panels',
  },
  {
    service: 'slots',
    member: 'register',
    required: true,
    fallback: 'the panel has no rendering surface',
    usedFor: 'register each slot renderer',
  },
  {
    service: 'locale',
    member: 'bind',
    required: false,
    fallback: 'labels fall back to raw keys (untranslated)',
    usedFor: 'bind the panel dictionary',
  },
  {
    service: 'locale',
    member: 'register',
    required: false,
    fallback: 'labels fall back to raw keys (untranslated)',
    usedFor: 'register the zh/en dictionaries',
  },
]

/**
 * Shape-probe every row: which members are missing. Calls nothing, sends
 * nothing, writes nothing. `services` is the bag `{ pluginManager: {...},
 * tools: {...}, ... }`; a missing service or a missing member both read as
 * missing — a host that lost the whole service reports one missing row per
 * member instead of throwing.
 *
 * @param {Record<string, Record<string, unknown>> | undefined} services
 * @returns {Array<{ service: string, member: string, required: boolean, fallback: string }>}
 */
export function checkContract(services) {
  const missing = []
  for (const entry of HOST_CONTRACT) {
    const present = typeof services?.[entry.service]?.[entry.member] === 'function'
    if (present) continue
    missing.push({
      service: entry.service,
      member: entry.member,
      required: entry.required,
      fallback: entry.fallback,
    })
  }
  return missing
}

/**
 * Grade the probe: `ok` is true when no `required` member is missing, `degraded`
 * is true when any non-required member is missing (the panel still works, one
 * feature does not).
 *
 * @param {Record<string, Record<string, unknown>> | undefined} services
 * @returns {{ ok: boolean, missing: Array<{service: string, member: string, required: boolean, fallback: string}>, present: number, total: number, degraded: boolean }}
 */
export function contractReport(services) {
  const missing = checkContract(services)
  const hard = missing.reduce((sum, entry) => sum + (entry.required === true ? 1 : 0), 0)
  return {
    ok: hard === 0,
    missing,
    present: HOST_CONTRACT.length - missing.length,
    total: HOST_CONTRACT.length,
    degraded: missing.length > hard,
  }
}
