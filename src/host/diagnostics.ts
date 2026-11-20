/**
 * Doctor: the ten things that make the panel look broken, each answered by trying it.
 *
 * Every check is independent — one failing probe never hides the others — and the ids are the
 * contract the client renders. The capability table `CAPABILITIES` is the same one the settings
 * page reads, so a member an upgrade dropped reads as "this feature stops working, here is its
 * fallback" instead of a stack trace in one drawer.
 *
 * Two facts outlive one process and are read back here: the mount heartbeat (`mount.json`, written
 * when the plugin applies and compared with the live pid) and the optional snapshot timing log.
 * Both are read safely — a missing or corrupt file is a diagnosis, never an exception.
 *
 * Nothing here calls a host member to "verify" it: a shape probe is all doctor does, because
 * calling one to prove it exists would itself send requests or mutate state.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { reportCapabilities, type CapabilityReport } from '../core/capabilities.js'
import { stateDir as defaultStateDir } from '../core/io.js'
import type { CapabilitySpec, HubContext } from '../shared/types.js'
import { isRecord } from './dispatch.js'

// ── capability table ────────────────────────────────────────────────────────

/**
 * Every host member this plugin touches, with the consequence of it being absent.
 *
 * `required: true` means the core path (listing, toggling, mounting the panel) breaks without it;
 * `false` means one feature degrades while the panel keeps working. `surface: 'client'` rows live
 * in the browser shell: the host cannot probe them, so doctor skips them instead of reporting them
 * missing. Keep this table and `HEARTBEAT_INJECTS` in step: the heartbeat proves the inject names
 * are what the host still publishes.
 */
export const CAPABILITIES: readonly CapabilitySpec[] = [
  // webServer — the two same-origin JSON routes the panel posts to.
  {
    id: 'webServer.register',
    service: 'webServer',
    member: 'register',
    required: true,
    fallback: 'the panel API does not mount; skills stay reachable through the CLI',
    usedFor: 'mount the snapshot and op routes',
  },
  // pluginManager — the host's own loader, so toggling here is toggling there.
  {
    id: 'pluginManager.listPlugins',
    service: 'pluginManager',
    member: 'listPlugins',
    required: true,
    fallback: 'plugins cannot be listed or toggled; the snapshot answers with an error payload',
    usedFor: 'list loader rows for the plugin view',
  },
  {
    id: 'pluginManager.setPluginEnabled',
    service: 'pluginManager',
    member: 'setPluginEnabled',
    required: true,
    fallback: 'every plugin switch fails with no-plugin-manager',
    usedFor: 'enable/disable loader rows (also the MCP enable switch)',
  },
  {
    id: 'pluginManager.listBundles',
    service: 'pluginManager',
    member: 'listBundles',
    required: false,
    fallback: 'the bundle view is empty and the snapshot carries a bundleError',
    usedFor: 'group plugins by install bundle',
  },
  // tools — the live mask and the catalog tool.
  {
    id: 'tools.restrict',
    service: 'tools',
    member: 'restrict',
    required: true,
    fallback: 'the tool mask cannot be applied; masked MCP tools stay visible to the model',
    usedFor: 'hide masked MCP tools per agent',
  },
  {
    id: 'tools.view',
    service: 'tools',
    member: 'view',
    required: false,
    fallback: 'skip the mask and record a problem instead of deriving names from definitions()',
    usedFor: 'read the live known/restrictable tool names',
  },
  {
    id: 'tools.definitions',
    service: 'tools',
    member: 'definitions',
    required: false,
    fallback: 'live tool-name discovery degrades to the saved deny list only',
    usedFor: 'display names in the snapshot; never as input to the mask',
  },
  {
    id: 'tools.register',
    service: 'tools',
    member: 'register',
    required: false,
    fallback: 'the hub_tools catalog tool is not registered; lazy load stays panel-only',
    usedFor: 'register the hub_tools catalog tool',
  },
  // systemPrompt — the one paragraph that makes the masked catalogue discoverable.
  {
    id: 'systemPrompt.section',
    service: 'systemPrompt',
    member: 'section',
    required: false,
    fallback: 'the lazy-tools prompt paragraph is skipped',
    usedFor: 'add the lazy tools paragraph to the prompt',
  },
  {
    id: 'systemPrompt.getSectionOrder',
    service: 'systemPrompt',
    member: 'getSectionOrder',
    required: false,
    fallback: 'the section falls back to default ordering',
    usedFor: 'place the section after the MCP servers block',
  },
  // connection — the host browser gate the routes resolve per request.
  {
    id: 'connection.requestRejection',
    service: 'connection',
    member: 'requestRejection',
    required: false,
    fallback: "fail open to the plugin's own sameOrigin() check (weaker, no session cookie)",
    usedFor: 'host browser authentication on the API routes',
  },
  // agents — where the mask has to be re-mounted on startup.
  {
    id: 'agents.list',
    service: 'agents',
    member: 'list',
    required: false,
    fallback: 'already-running agents keep no mask until the next agent/created event',
    usedFor: 'mount the tool mask on agents that predate this plugin',
  },
  // workspace discovery — the first source that answers wins, in this order.
  {
    id: 'workspaces.list',
    service: 'workspaces',
    member: 'list',
    required: false,
    fallback: 'try workspaceRegistry.list(), then sessions.listWorkspaces()',
    usedFor: 'discover workspace skill roots (first source)',
  },
  {
    id: 'workspaceRegistry.list',
    service: 'workspaceRegistry',
    member: 'list',
    required: false,
    fallback: 'try sessions.listWorkspaces()',
    usedFor: 'discover workspace skill roots (second source)',
  },
  {
    id: 'sessions.listWorkspaces',
    service: 'sessions',
    member: 'listWorkspaces',
    required: false,
    fallback: 'no workspace skill roots; only the global roots are scanned',
    usedFor: 'discover workspace skill roots (last source)',
  },
  // client services — the shell surface the browser half renders into.
  {
    id: 'slots.inject',
    service: 'slots',
    member: 'inject',
    required: true,
    surface: 'client',
    fallback: 'the panel cannot mount into the plugins tab or the sidebar',
    usedFor: 'mount the panel into the shell tabs and panels',
  },
  {
    id: 'slots.register',
    service: 'slots',
    member: 'register',
    required: true,
    surface: 'client',
    fallback: 'the panel has no rendering surface',
    usedFor: 'register each slot renderer',
  },
  {
    id: 'locale.bind',
    service: 'locale',
    member: 'bind',
    required: false,
    surface: 'client',
    fallback: 'labels fall back to raw keys (untranslated)',
    usedFor: 'bind the panel dictionary',
  },
  {
    id: 'locale.register',
    service: 'locale',
    member: 'register',
    required: false,
    surface: 'client',
    fallback: 'labels fall back to raw keys (untranslated)',
    usedFor: 'register the zh/en dictionaries',
  },
]

/** The inject names the heartbeat records: everything apply() waits for, in one place. */
export const HEARTBEAT_INJECTS: readonly string[] = ['tools', 'systemPrompt', 'webServer']

/** A lock older than this is treated as abandoned; same value the panel dialog uses. */
export const PANEL_LOCK_STALE_MS = 30_000

export function hostCapabilities(ctx: HubContext): CapabilityReport {
  return reportCapabilities(serviceBag(ctx), [...CAPABILITIES], 'host')
}

/** One read per service name the table names; a service whose getter throws reads as absent. */
export function serviceBag(ctx: HubContext): Record<string, unknown> {
  const bag: Record<string, unknown> = {}
  for (const row of CAPABILITIES) {
    if (Object.prototype.hasOwnProperty.call(bag, row.service)) continue
    bag[row.service] = readService(ctx, row.service)
  }
  return bag
}

function readService(ctx: HubContext, name: string): unknown {
  try {
    const read = ctx.get
    if (typeof read !== 'function') return undefined
    return read.call(ctx, name)
  }
  catch {
    return undefined
  }
}

function serviceOf<T>(context: DoctorRun, name: string): T | undefined {
  return context.bag[name] as T | undefined
}

// ── mount heartbeat ────────────────────────────────────────────────────────

/** Bumped only when the on-disk shape changes; a reader refuses anything else. */
export const HEARTBEAT_VERSION = 1
/** 24h: older than that and no boot in the last day wrote it, so it proves nothing. */
export const HEARTBEAT_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Clock tolerance between "when this process says it started" and the file's claim. */
const HEARTBEAT_TOLERANCE_MS = 5000

export interface MountHeartbeat {
  version: number
  pid: number
  hostStartedAt: number
  injects: string[]
  writtenAt: number
}

export interface MountFacts {
  pid: number | null
  hostStartedAt: number | null
  writtenAt: number | null
  ageMs: number | null
  injects: string[]
}

export interface MountDiagnosis {
  ok: boolean
  problems: string[]
  facts: MountFacts
}

export type HeartbeatRead =
  | { ok: true; data: MountHeartbeat }
  | { ok: false; reason: string }

/** Where the heartbeat lives for one state directory (next to `state.json`, not inside it). */
export function heartbeatPath(dir: string): string {
  return join(dir, 'mount.json')
}

/**
 * When this process booted, derived from uptime instead of a stored constant: it survives a hot
 * reload of this module, which a module-level `Date.now()` would not.
 */
export function hostStartFromUptime(now: number): number {
  return now - Math.round(process.uptime() * 1000)
}

/** Keep only real service names; a stray value would only produce a phantom problem later. */
function normalizeInjects(injects: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const name of injects) {
    if (typeof name === 'string' && name !== '') seen.add(name)
  }
  return [...seen]
}

/**
 * Write the heartbeat. Atomic on purpose: `rename` inside one directory is atomic, so a reader sees
 * either the previous complete file or the new complete file, never a truncated one. Throws on real
 * I/O failure — the caller (apply) decides whether that is worth logging.
 */
export function writeMountHeartbeat(options: {
  stateDir: string
  pid?: number
  hostStartedAt?: number
  injects?: readonly unknown[]
  now?: () => number
}): { file: string; data: MountHeartbeat } {
  const dir = options.stateDir
  if (typeof dir !== 'string' || dir === '') throw new TypeError('writeMountHeartbeat needs a stateDir')
  const now = options.now ?? Date.now
  const writtenAt = now()
  const file = heartbeatPath(dir)
  const data: MountHeartbeat = {
    version: HEARTBEAT_VERSION,
    pid: Number(options.pid ?? process.pid),
    hostStartedAt: Number(options.hostStartedAt ?? hostStartFromUptime(writtenAt)),
    injects: normalizeInjects(options.injects ?? []),
    writtenAt: Number(writtenAt),
  }
  mkdirSync(dir, { recursive: true })
  // The name carries pid and randomness so two writers cannot collide on the temporary file.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  }
  catch (error) {
    // Leave no debris behind: a `.tmp-*` file would look like a bug to the next doctor run.
    rmSync(tmp, { force: true })
    throw error
  }
  return { file, data }
}

/** Which required field is missing or has the wrong type; null when the shape is usable. */
function wrongField(parsed: Record<string, unknown>): string | null {
  if (!Number.isFinite(parsed.version)) return 'version'
  if (!Number.isFinite(parsed.pid)) return 'pid'
  if (!Number.isFinite(parsed.hostStartedAt)) return 'hostStartedAt'
  if (!Number.isFinite(parsed.writtenAt)) return 'writtenAt'
  if (!Array.isArray(parsed.injects)) return 'injects'
  if (parsed.injects.some(name => typeof name !== 'string')) return 'injects'
  return null
}

/** Read and shape-check one file, without deciding whether the version is supported. */
function parseHeartbeat(file: string): HeartbeatRead {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  }
  catch (error) {
    // A missing file is the normal "never mounted" state, not an error worth a stack trace.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'no heartbeat file' }
    return { ok: false, reason: `cannot read heartbeat: ${errorText(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch (error) {
    // A truncated file is what a non-atomic write would leave; keep the reason distinct so doctor
    // can tell "bug in the writer" from "plugin never applied".
    return { ok: false, reason: `bad heartbeat json: ${errorText(error)}` }
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'bad heartbeat json: not an object' }
  const field = wrongField(parsed)
  if (field !== null) return { ok: false, reason: `heartbeat field missing or invalid: ${field}` }
  return { ok: true, data: parsed as unknown as MountHeartbeat }
}

/**
 * Read the heartbeat for a state directory. Never throws: the caller is a diagnostic, and a
 * diagnostic that dies on a missing file is useless.
 */
export function readMountHeartbeat(dir: string): HeartbeatRead {
  if (typeof dir !== 'string' || dir === '') return { ok: false, reason: 'no heartbeat file' }
  const parsed = parseHeartbeat(heartbeatPath(dir))
  if (!parsed.ok) return parsed
  if (parsed.data.version !== HEARTBEAT_VERSION) return { ok: false, reason: 'unknown heartbeat version' }
  return parsed
}

/**
 * Compare a heartbeat file with the live process and list every way it fails to describe it.
 *
 * Each problem is independent — one drifted field must not hide a missing inject — because the
 * operator is debugging a silent mount failure and needs the whole picture in one pass.
 */
export function diagnoseMount(options: {
  file: string | null
  pid?: number
  hostStartedAt?: number
  expectedInjects?: readonly string[]
  toleranceMs?: number
  now?: number
}): MountDiagnosis {
  const now = options.now ?? Date.now()
  const pid = options.pid ?? process.pid
  const toleranceMs = options.toleranceMs ?? HEARTBEAT_TOLERANCE_MS
  const expectedInjects = options.expectedInjects ?? []
  const problems: string[] = []
  const facts: MountFacts = { pid: null, hostStartedAt: null, writtenAt: null, ageMs: null, injects: [] }
  const file = options.file
  if (typeof file !== 'string' || file === '') {
    problems.push('no heartbeat file')
    return { ok: false, problems, facts }
  }
  const parsed = parseHeartbeat(file)
  if (!parsed.ok) {
    // Without a readable file there is nothing to compare: every other check would be noise.
    problems.push(parsed.reason)
    return { ok: false, problems, facts }
  }
  const data = parsed.data
  facts.pid = data.pid
  facts.hostStartedAt = data.hostStartedAt
  facts.writtenAt = data.writtenAt
  facts.ageMs = now - data.writtenAt
  facts.injects = [...data.injects]

  // Kept even though the reader refuses an unknown version: diagnose can be handed a file from a
  // newer install, and the version is the first thing worth naming in that case.
  if (data.version !== HEARTBEAT_VERSION) problems.push('unknown heartbeat version')
  if (data.pid !== pid) problems.push(`heartbeat belongs to pid ${data.pid}, current pid ${pid}`)

  const hostStartedAt = options.hostStartedAt ?? hostStartFromUptime(now)
  // The decisive check: if the host started long ago but the file claims another start time, this
  // boot never wrote it — which means the plugin never applied in this process.
  if (Number.isFinite(hostStartedAt) && Math.abs(hostStartedAt - data.hostStartedAt) > toleranceMs) {
    problems.push('host start time drifted')
  }
  for (const name of expectedInjects) {
    // One problem per service, so the missing name itself is the fix instruction.
    if (typeof name === 'string' && name !== '' && !data.injects.includes(name)) {
      problems.push(`missing inject: ${name}`)
    }
  }
  const age = now - data.writtenAt
  if (age > HEARTBEAT_MAX_AGE_MS) problems.push(`heartbeat is stale: written ${Math.round(age / 1000)}s ago`)
  // A clock that runs backwards, or a file copied from another machine, lands here.
  if (data.writtenAt > now + toleranceMs) problems.push(`heartbeat is from the future: ${Math.round((data.writtenAt - now) / 1000)}s ahead`)

  return { ok: problems.length === 0, problems, facts }
}

// ── doctor ─────────────────────────────────────────────────────────────────

/** The ten ids, in render order: the client's contract and the probe's expectation. */
export const DOCTOR_CHECK_IDS = [
  'patch-parse',
  'state-writable',
  'failed-rows',
  'stale-lock',
  'skill-roots',
  'trash',
  'hub-tools',
  'mount-heartbeat',
  'host-contract',
  'snapshot-profile',
] as const

export interface DoctorRun {
  ctx: HubContext
  stateDir: string
  patchPath: string | null
  now: () => number
  pid: number
  hostStartedAt: number
  expectedInjects: readonly string[]
  bag: Record<string, unknown>
  /** Capability rows missing right now, by id; a check's `needs` is answered from here. */
  missing: Map<string, CapabilitySpec>
}

export interface DoctorVerdict {
  ok: boolean
  detail: string
}

export interface DoctorCheck {
  id: string
  /** Capability ids this check depends on; a missing one is answered with its table fallback. */
  needs: readonly string[]
  run(context: DoctorRun): Promise<DoctorVerdict>
}

export interface DoctorCheckResult {
  id: string
  ok: boolean
  detail: string
}

export interface DoctorReport {
  ok: boolean
  /** Always `DOCTOR_CHECK_IDS`, in order: one failing probe never hides another. */
  checks: DoctorCheckResult[]
  capabilities: CapabilityReport
}

export interface DoctorDeps {
  ctx: HubContext
  /** Defaults to core/io's state directory (`TOOL_HUB_STATE_FILE` aware). */
  stateDir?: string
  /** Defaults to `patchPathFor(ctx)`; pass `null` to say "this profile has no patch file". */
  patchPath?: string | null
  now?: () => number
  pid?: number
  hostStartedAt?: number
  expectedInjects?: readonly string[]
}

function failedNames(rows: unknown[]): string[] {
  const failed = rows.filter(row => isRecord(row) && (row.phase === 'failed' || row.state === 'failed'))
  return failed.map(row => {
    if (typeof row === 'object' && row !== null) {
      const record = row as Record<string, unknown>
      if (typeof record.name === 'string' && record.name !== '') return record.name
      if (typeof record.id === 'string' && record.id !== '') return record.id
    }
    return '?'
  })
}

/** Names the tools service currently exposes, or null when it cannot answer. */
function toolNames(tools: Record<string, unknown> | undefined): string[] | null {
  if (tools === undefined) return null
  const view = safeCall(tools, 'view', undefined)
  if (isRecord(view)) {
    const names = view.knownNames ?? view.restrictableNames
    if (Array.isArray(names)) return names.filter((name): name is string => typeof name === 'string')
  }
  const definitions = safeCall(tools, 'definitions')
  if (Array.isArray(definitions)) {
    const names = definitions
      .map(entry => (typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : null))
      .filter((name): name is string => name !== null)
    if (names.length > 0) return names
  }
  return null
}

function safeCall(bag: Record<string, unknown>, member: string, ...args: unknown[]): unknown {
  const fn = bag[member]
  if (typeof fn !== 'function') return null
  try {
    return (fn as (...values: unknown[]) => unknown).call(bag, ...args)
  }
  catch {
    return null
  }
}

function readList(context: DoctorRun, service: string, member: string): unknown[] | null {
  const bag = serviceOf<Record<string, unknown>>(context, service)
  if (bag === undefined || bag === null) return null
  const value = safeCall(bag, member)
  return Array.isArray(value) ? value : null
}

/** Workspace paths the host knows about: env override first, then the three services in order. */
function workspacePaths(context: DoctorRun): string[] {
  const found: string[] = []
  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      const clean = value.trim()
      if (clean === '') return
      const absolute = resolve(clean)
      if (!found.includes(absolute)) found.push(absolute)
      return
    }
    if (isRecord(value)) add(value.path ?? value.dir ?? value.root)
  }
  const fromEnv = process.env.TOOL_HUB_WORKSPACES?.trim() ?? ''
  // A bare "-" means "no workspace roots" (a sandbox uses it to stay isolated).
  if (fromEnv === '-') return found
  if (fromEnv !== '') {
    for (const entry of fromEnv.split(';')) add(entry)
    return found
  }
  const sources: Array<() => unknown[] | null> = [
    () => readList(context, 'workspaces', 'list'),
    () => readList(context, 'workspaceRegistry', 'list'),
    () => readList(context, 'sessions', 'listWorkspaces'),
  ]
  for (const read of sources) {
    const list = read()
    if (list === null) continue
    const before = found.length
    for (const entry of list) add(entry)
    if (found.length > before) return found
  }
  return found
}

interface SkillRoot {
  id: string
  dir: string
}

function skillRoots(context: DoctorRun): SkillRoot[] {
  const roots: SkillRoot[] = []
  // A sandbox can mount throwaway global roots so flipping a SKILL.md there never reaches the real
  // ~/.dsh/skills the user works with. Workspace roots still come from the host: those are the point.
  const override = process.env.TOOL_HUB_SKILL_ROOTS?.trim() ?? ''
  if (override !== '') {
    const entries = override.split(sep === '\\' ? ';' : ':').map(entry => entry.trim()).filter(entry => entry !== '')
    entries.forEach((dir, index) => {
      roots.push({ id: index === 0 ? 'user' : `root${index + 1}`, dir: resolve(dir) })
    })
  }
  else {
    roots.push({ id: 'user', dir: join(dshHome(), 'skills') })
    roots.push({ id: 'agents', dir: join(homedir(), '.agents', 'skills') })
  }
  for (const workspace of workspacePaths(context)) {
    // The id prefixes every skill id, so it has to be stable across runs: hash, not an index.
    roots.push({ id: `ws-${hashText(workspace)}`, dir: join(workspace, '.dsh', 'skills') })
  }
  return roots
}

function dshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim() ?? ''
  return fromEnv === '' ? join(homedir(), '.dsh') : fromEnv
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8)
}

/**
 * Structural read of the patch file: how many MCP rows it declares. The parser that understands the
 * document belongs to the mcp domain; doctor only needs "readable, and here is how much is in it",
 * so a row counts as a `serverName:` entry — the marker the 1.x parser keyed on too.
 */
function countMcpRows(text: string): number {
  return (text.match(/^\s*serverName\s*:/gm) ?? []).length
}

/** The patch file the running profile actually reads; same discovery order as 1.x. */
export function patchPathFor(ctx: HubContext): string | null {
  const profile = readService(ctx, 'profileContext')
  const profileDir = isRecord(profile) && typeof profile.dir === 'string' && profile.dir !== '' ? resolve(profile.dir) : null
  const editor = readService(ctx, 'configEditor')
  const candidate = isRecord(editor) && typeof editor.documentPath === 'string' && editor.documentPath !== ''
    ? resolve(editor.documentPath)
    : null
  // The editor path is host-supplied: accepted only inside the profile and only for a patch file.
  if (candidate !== null && basename(candidate) === 'cordis.patch.yml') {
    if (profileDir === null || insideDir(profileDir, candidate)) return candidate
  }
  if (profileDir !== null) return join(profileDir, 'cordis.patch.yml')
  return null
}

function insideDir(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The table. Ten rows, each independent; `needs` names the capability that has to be there for the
 * check to mean anything, so an upgrade that dropped a member answers with the table's fallback.
 */
export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  {
    id: 'patch-parse',
    needs: [],
    async run(context) {
      const patch = context.patchPath
      if (patch === null) throw new Error('this profile has no cordis.patch.yml')
      const rows = countMcpRows(await readFile(patch, 'utf8'))
      return { ok: true, detail: `${rows} MCP row(s) in ${patch}` }
    },
  },
  {
    id: 'state-writable',
    needs: [],
    async run(context) {
      await mkdir(context.stateDir, { recursive: true })
      const probe = join(context.stateDir, `.doctor-${context.pid}-${context.now()}.tmp`)
      await writeFile(probe, 'ok', 'utf8')
      await rm(probe, { force: true })
      return { ok: true, detail: context.stateDir }
    },
  },
  {
    id: 'failed-rows',
    needs: ['pluginManager.listPlugins'],
    async run(context) {
      const manager = serviceOf<Record<string, unknown>>(context, 'pluginManager')
      if (manager === undefined || typeof manager.listPlugins !== 'function') {
        throw new Error('pluginManager.listPlugins is not a function')
      }
      const rows = await (manager.listPlugins as () => Promise<unknown>).call(manager)
      const list = Array.isArray(rows) ? rows : []
      const failed = failedNames(list)
      return failed.length === 0
        ? { ok: true, detail: 'no failed rows' }
        : { ok: false, detail: failed.join(', ') }
    },
  },
  {
    id: 'stale-lock',
    needs: [],
    async run(context) {
      const patch = context.patchPath
      if (patch === null) return { ok: true, detail: 'no lock file' }
      const lock = `${patch}.panel.lock`
      const info = await stat(lock).catch(() => null)
      if (info === null) return { ok: true, detail: 'no lock file' }
      const age = context.now() - info.mtimeMs
      return age <= PANEL_LOCK_STALE_MS
        ? { ok: true, detail: `held for ${Math.round(age / 1000)}s` }
        : { ok: false, detail: `${lock} is ${Math.round(age / 1000)}s old (stale)` }
    },
  },
  {
    id: 'skill-roots',
    needs: [],
    async run(context) {
      const roots = skillRoots(context)
      const unreadable: string[] = []
      let readable = 0
      for (const root of roots) {
        try {
          await readdir(root.dir)
          readable += 1
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          unreadable.push(`${root.id}: ${(error as NodeJS.ErrnoException).code ?? errorText(error)}`)
        }
      }
      return unreadable.length === 0
        ? { ok: true, detail: `${readable}/${roots.length} root(s) readable` }
        : { ok: false, detail: unreadable.join('; ') }
    },
  },
  {
    id: 'trash',
    needs: [],
    async run(context) {
      const dir = join(context.stateDir, 'trash')
      await mkdir(dir, { recursive: true })
      const probe = join(dir, `.doctor-${context.pid}-${context.now()}.tmp`)
      await writeFile(probe, 'ok', 'utf8')
      await rm(probe, { force: true })
      return { ok: true, detail: dir }
    },
  },
  {
    id: 'hub-tools',
    needs: ['tools.definitions'],
    async run(context) {
      const names = toolNames(serviceOf<Record<string, unknown>>(context, 'tools'))
      if (names === null) return { ok: false, detail: 'the tools service cannot report known names' }
      const present = names.includes('hub_tools')
      return { ok: present, detail: present ? 'hub_tools is registered' : 'hub_tools is missing from the tool registry' }
    },
  },
  {
    id: 'mount-heartbeat',
    needs: [],
    async run(context) {
      const verdict = diagnoseMount({
        file: heartbeatPath(context.stateDir),
        pid: context.pid,
        hostStartedAt: context.hostStartedAt,
        expectedInjects: context.expectedInjects,
        now: context.now(),
      })
      if (!verdict.ok) return { ok: false, detail: verdict.problems.join('; ') }
      const age = verdict.facts.ageMs ?? 0
      return { ok: true, detail: `applied ${Math.round(age / 1000)}s ago, pid ${verdict.facts.pid ?? '?'}` }
    },
  },
  {
    id: 'host-contract',
    needs: [],
    async run(context) {
      const report = reportCapabilities(context.bag, [...CAPABILITIES], 'host')
      if (report.ok) return { ok: true, detail: `${report.present}/${report.total} host member(s)` }
      const hard = report.missing.filter(row => row.required === true)
      return { ok: false, detail: `missing required: ${hard.map(row => `${row.service}.${row.member}`).join(', ')}` }
    },
  },
  {
    id: 'snapshot-profile',
    needs: [],
    async run(context) {
      // Informational: a slow snapshot is worth seeing, but it is not a broken installation.
      const file = join(context.stateDir, 'snapshot-profile.log')
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null) return { ok: true, detail: 'no profile log yet — run with TOOL_HUB_PROFILE=1 to collect timings' }
      const lines = text.trim().split('\n').filter(line => line !== '')
      const last = lines[lines.length - 1] ?? ''
      const steps = [...last.matchAll(/([a-z]+)=([0-9.]+)/g)].map(match => `${match[1]} ${Math.round(Number(match[2]))}ms`)
      return {
        ok: true,
        detail: steps.length === 0 ? `no parsed timings in ${file}` : `${steps.join(' · ')} (${lines.length} sample(s))`,
      }
    },
  },
]

/**
 * Run every check. One throwing probe becomes a failed row with its message, never an exception:
 * doctor is what the operator opens when something is already wrong.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const now = deps.now ?? Date.now
  const bag = serviceBag(deps.ctx)
  const capabilities = reportCapabilities(bag, [...CAPABILITIES], 'host')
  const missing = new Map<string, CapabilitySpec>()
  for (const row of capabilities.missing) missing.set(row.id, row)

  const context: DoctorRun = {
    ctx: deps.ctx,
    stateDir: deps.stateDir ?? defaultStateDir(),
    patchPath: deps.patchPath !== undefined ? deps.patchPath : patchPathFor(deps.ctx),
    now,
    pid: deps.pid ?? process.pid,
    hostStartedAt: deps.hostStartedAt ?? hostStartFromUptime(now()),
    expectedInjects: deps.expectedInjects ?? HEARTBEAT_INJECTS,
    bag,
    missing,
  }

  const checks: DoctorCheckResult[] = []
  for (const check of DOCTOR_CHECKS) {
    const absent = check.needs.map(id => context.missing.get(id)).find(row => row !== undefined)
    if (absent !== undefined) {
      // The table owns the consequence text: one place to read "what breaks without this".
      checks.push({ id: check.id, ok: false, detail: `missing ${absent.service}.${absent.member}: ${absent.fallback}` })
      continue
    }
    try {
      const verdict = await check.run(context)
      checks.push({ id: check.id, ok: verdict.ok === true, detail: String(verdict.detail) })
    }
    catch (error) {
      checks.push({ id: check.id, ok: false, detail: errorText(error) })
    }
  }
  return { ok: checks.every(row => row.ok), checks, capabilities }
}

/** Every `needs` id has to name a row in the table; a probe asserts this, the host does not pay for it. */
export function validateDoctorTable(): string[] {
  const known = new Set(CAPABILITIES.map(row => row.id))
  const problems: string[] = []
  for (const check of DOCTOR_CHECKS) {
    for (const id of check.needs) {
      if (!known.has(id)) problems.push(`${check.id} needs ${id}, which is not in CAPABILITIES`)
    }
  }
  return problems
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
