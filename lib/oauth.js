/**
 * OAuth discovery and PKCE for MCP servers (P1-7).
 *
 * Self-contained: no third-party dependencies, `fetch` is injected (or taken
 * from the global scope), PKCE uses `node:crypto` only.
 *
 * `discover()` walks the well-known documents a remote MCP server may publish,
 * in this order, giving every candidate its own timeout:
 *
 *   /.well-known/oauth-protected-resource<path>    RFC 9728, path form
 *   /.well-known/oauth-protected-resource          RFC 9728, root form
 *   /.well-known/oauth-authorization-server<path>  RFC 8414, path insertion
 *   /.well-known/oauth-authorization-server        RFC 8414, root
 *   <path>/.well-known/openid-configuration        OIDC discovery, appended
 *   /.well-known/openid-configuration              OIDC discovery, root
 *
 * A protected-resource document is trusted only when the authorization server
 * it points at publishes metadata whose `issuer` is exactly the `issuer` the
 * protected-resource document declares. A mismatch is recorded as
 * `issuer mismatch` and the walk continues with the next candidate. Because
 * that exact match is the only binding the contract provides, a protected
 * resource document without `issuer` is rejected as well.
 *
 * Every failed discovery throws one Error whose message lists the attempted
 * URLs and the reason for each (`HTTP 404` / `timeout after Nms` /
 * `issuer mismatch` / `unsupported-scheme` / ...); the same data is available
 * as `error.attempts`.
 *
 * Endpoints are restricted to `http:` / `https:` — discovery rejects any
 * candidate whose metadata carries another scheme, and `authorizeUrl`,
 * `register` and `exchangeCode` re-check before issuing a request. Upstream
 * error text never reaches a message: failures carry only the status and the
 * machine-readable `error` code, while the redacted, 200-character response
 * copy is attached as `error.debug` for diagnostics.
 */
import { createHash, randomBytes } from 'node:crypto'

const DEFAULT_DISCOVERY_TIMEOUT_MS = 4000
const DEFAULT_REQUEST_TIMEOUT_MS = 15000

const PRM_WELL_KNOWN = '/.well-known/oauth-protected-resource'
const AS_WELL_KNOWN = '/.well-known/oauth-authorization-server'
const OIDC_WELL_KNOWN = '/.well-known/openid-configuration'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

function pickFetch(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch
  if (typeof fn !== 'function') {
    throw new Error('oauth: no fetch implementation available')
  }
  return fn
}

function taggedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Origin plus path without a trailing slash; only http(s) is fetchable here. */
function splitServerUrl(raw) {
  let url
  try {
    url = new URL(raw)
  }
  catch {
    throw taggedError(`invalid URL ${redactUrl(raw)}`, 'invalid-url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw taggedError(`unsupported-scheme ${url.protocol}`, 'unsupported-scheme')
  }
  return { origin: url.origin, path: url.pathname.replace(/\/+$/, '') }
}

/** `unsupported-scheme` / `invalid endpoint URL` / null for one endpoint value. */
function endpointSchemeProblem(value) {
  let url
  try {
    url = new URL(value)
  }
  catch {
    return 'invalid endpoint URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'unsupported-scheme'
  return null
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin
  }
  catch {
    return false
  }
}

function prmCandidates(origin, path) {
  const urls = []
  if (path !== '') urls.push(`${origin}${PRM_WELL_KNOWN}${path}`)
  urls.push(`${origin}${PRM_WELL_KNOWN}`)
  return urls
}

/** Authorization-server metadata locations for one issuer identifier. */
function asCandidates(issuer) {
  const { origin, path } = splitServerUrl(issuer)
  const urls = []
  if (path !== '') urls.push(`${origin}${AS_WELL_KNOWN}${path}`)
  urls.push(`${origin}${AS_WELL_KNOWN}`)
  if (path !== '') urls.push(`${origin}${path}${OIDC_WELL_KNOWN}`)
  urls.push(`${origin}${OIDC_WELL_KNOWN}`)
  return [...new Set(urls)]
}

function metadataProblem(document) {
  if (!isRecord(document)) return 'not a JSON object'
  if (!isNonEmptyString(document.authorization_endpoint)) return 'missing authorization_endpoint'
  if (!isNonEmptyString(document.token_endpoint)) return 'missing token_endpoint'
  const authorizationProblem = endpointSchemeProblem(document.authorization_endpoint)
  if (authorizationProblem !== null) return authorizationProblem
  const tokenProblem = endpointSchemeProblem(document.token_endpoint)
  if (tokenProblem !== null) return tokenProblem
  if (isNonEmptyString(document.registration_endpoint)) {
    const registrationProblem = endpointSchemeProblem(document.registration_endpoint)
    if (registrationProblem !== null) return registrationProblem
  }
  return null
}

/** RFC 8707 resource: the PRM value when it is same-origin with the MCP endpoint. */
function pickResource(prmResource, serverUrl) {
  if (isNonEmptyString(prmResource) && sameOrigin(prmResource, serverUrl)) return prmResource
  return serverUrl
}

function buildResult(metadata, issuer, resource, scopesSupported) {
  const result = {
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
  }
  if (isNonEmptyString(metadata.registration_endpoint)
    && endpointSchemeProblem(metadata.registration_endpoint) === null) {
    result.registrationEndpoint = metadata.registration_endpoint
  }
  result.issuer = issuer
  result.resource = resource
  const scopes = Array.isArray(scopesSupported) ? scopesSupported.filter(isNonEmptyString) : []
  if (scopes.length > 0) result.scopes = scopes
  return result
}

function abortReason(error, signal, timeoutMs) {
  const name = error?.name ?? error?.cause?.name
  if (signal.aborted || name === 'AbortError') return `timeout after ${timeoutMs}ms`
  return `network error: ${error?.message ?? String(error)}`
}

async function fetchJson(fetchFn, url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
    const text = await response.text()
    try {
      return { ok: true, json: JSON.parse(text) }
    }
    catch {
      return { ok: false, reason: 'invalid JSON' }
    }
  }
  catch (error) {
    return { ok: false, reason: abortReason(error, controller.signal, timeoutMs) }
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Only OAuth's machine-readable `error` code travels in messages; free-text
 * `error_description` and response bodies never do. The code itself is kept to
 * a short token-like shape so a hostile server cannot smuggle prose through it.
 */
function safeErrorCode(parsed) {
  if (!isRecord(parsed)) return ''
  const code = parsed.error
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : ''
}

const DEBUG_LIMIT = 200

/** Redact token/secret assignments, then truncate; the result may be exposed. */
function redactForDebug(text) {
  if (typeof text !== 'string' || text === '') return ''
  const redacted = text
    .replace(/([?&\s"']|^)([A-Za-z0-9_.-]*(?:token|secret)[A-Za-z0-9_.-]*)=("[^"]*"|[^&\s"']*)/gi, '$1$2=***')
    .replace(/("[A-Za-z0-9_.-]*(?:token|secret)[A-Za-z0-9_.-]*"\s*:\s*)"[^"]*"/gi, '$1"***"')
  return redacted.length > DEBUG_LIMIT ? redacted.slice(0, DEBUG_LIMIT) : redacted
}

/**
 * Error messages travel to the panel and to the host log, so a URL must never
 * carry its userinfo, query or fragment out of this module: an endpoint such as
 * `https://user:secret@host/cb?token=...` is a credential, not a location.
 */
function redactUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return String(value ?? '')
  try {
    const url = new URL(value)
    const shown = `${url.protocol}//${url.host}${url.pathname}`
    return url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '' ? `${shown}…` : shown
  } catch {
    return '<invalid URL>'
  }
}

/** Status and the redacted response copy are the only extra fields an error carries. */
function attachDebug(error, response) {
  if (Number.isFinite(response.status) && response.status > 0) error.status = response.status
  if (typeof response.debug === 'string' && response.debug !== '') error.debug = response.debug
  return error
}

async function requestJson(fetchFn, url, { headers, body, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { accept: 'application/json', ...headers },
      body,
      redirect: 'follow',
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed = null
    if (text !== '') {
      try {
        parsed = JSON.parse(text)
      }
      catch {
        parsed = null
      }
    }
    if (!response.ok) {
      const code = safeErrorCode(parsed)
      return {
        ok: false,
        status: response.status,
        json: parsed,
        reason: `HTTP ${response.status}${code === '' ? '' : ` ${code}`}`,
        debug: redactForDebug(text),
      }
    }
    if (parsed === null) {
      return {
        ok: false,
        status: response.status,
        json: null,
        reason: 'response was not JSON',
        debug: redactForDebug(text),
      }
    }
    return { ok: true, status: response.status, json: parsed }
  }
  catch (error) {
    return { ok: false, status: 0, json: null, reason: abortReason(error, controller.signal, timeoutMs) }
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the OAuth endpoints for an MCP server.
 *
 * @param {string} serverUrl MCP endpoint (`https://host/mcp`).
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [options]
 * @returns {Promise<{ authorizationEndpoint: string, tokenEndpoint: string,
 *   registrationEndpoint?: string, issuer: string, resource: string, scopes?: string[] }>}
 */
export async function discover(serverUrl, { fetchImpl, timeoutMs } = {}) {
  if (!isNonEmptyString(serverUrl)) throw new Error('discover: serverUrl is required')
  const fetchFn = pickFetch(fetchImpl)
  const budget = timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  let parsed
  try {
    parsed = splitServerUrl(serverUrl)
  }
  catch (error) {
    const reason = error?.code === 'unsupported-scheme' ? 'unsupported-scheme' : 'invalid serverUrl'
    throw new Error(`discover: ${reason}: ${redactUrl(serverUrl)}`)
  }

  const attempts = []

  // 1 + 2: RFC 9728 protected resource metadata, then the authorization server
  // it names. Every failure inside one candidate is recorded before moving on.
  for (const prmUrl of prmCandidates(parsed.origin, parsed.path)) {
    const prm = await fetchJson(fetchFn, prmUrl, budget)
    if (!prm.ok) {
      attempts.push({ url: prmUrl, reason: prm.reason })
      continue
    }
    const document = prm.json
    if (!isRecord(document)) {
      attempts.push({ url: prmUrl, reason: 'not a JSON object' })
      continue
    }
    const servers = document.authorization_servers
    if (!Array.isArray(servers) || !isNonEmptyString(servers[0])) {
      attempts.push({ url: prmUrl, reason: 'no authorization_servers[0]' })
      continue
    }
    if (!isNonEmptyString(document.issuer)) {
      attempts.push({ url: prmUrl, reason: 'missing issuer in protected resource metadata' })
      continue
    }
    let candidates
    try {
      candidates = asCandidates(servers[0])
    }
    catch (error) {
      const reason = error?.code === 'unsupported-scheme' ? 'unsupported-scheme' : 'invalid authorization server URL'
      attempts.push({ url: servers[0], via: prmUrl, reason })
      continue
    }
    let resolved = null
    for (const asUrl of candidates) {
      const as = await fetchJson(fetchFn, asUrl, budget)
      if (!as.ok) {
        attempts.push({ url: asUrl, via: prmUrl, reason: as.reason })
        continue
      }
      const problem = metadataProblem(as.json)
      if (problem !== null) {
        attempts.push({ url: asUrl, via: prmUrl, reason: problem })
        continue
      }
      if (as.json.issuer !== document.issuer) {
        attempts.push({
          url: asUrl,
          via: prmUrl,
          reason: `issuer mismatch: protected resource issuer "${document.issuer}" != authorization server issuer "${String(as.json.issuer)}"`,
        })
        continue
      }
      resolved = buildResult(
        as.json,
        as.json.issuer,
        pickResource(document.resource, serverUrl),
        as.json.scopes_supported ?? document.scopes_supported,
      )
      break
    }
    if (resolved !== null) return resolved
  }

  // 3 + 4 + 5: authorization server metadata published by the MCP origin itself.
  const issuerHint = `${parsed.origin}${parsed.path}`
  for (const asUrl of asCandidates(issuerHint)) {
    const as = await fetchJson(fetchFn, asUrl, budget)
    if (!as.ok) {
      attempts.push({ url: asUrl, reason: as.reason })
      continue
    }
    const problem = metadataProblem(as.json)
    if (problem !== null) {
      attempts.push({ url: asUrl, reason: problem })
      continue
    }
    const issuer = isNonEmptyString(as.json.issuer) ? as.json.issuer : issuerHint
    return buildResult(as.json, issuer, serverUrl, as.json.scopes_supported)
  }

  const lines = attempts.map((attempt) => (
    `  ${attempt.url}${attempt.via === undefined ? '' : ` (via ${attempt.via})`} — ${attempt.reason}`
  ))
  const error = new Error([`OAuth discovery failed for ${redactUrl(serverUrl)}`, ...lines].join('\n'))
  error.code = 'oauth-discovery-failed'
  error.attempts = attempts
  throw error
}

/**
 * RFC 7591 dynamic client registration. Public client (`none`) first, then the
 * confidential fallback (`client_secret_basic`) when the server refuses it.
 *
 * @returns {Promise<{ clientId: string, clientSecret?: string }>}
 */
export async function register(meta, { clientName, redirectUri, fetchImpl, timeoutMs } = {}) {
  if (!isRecord(meta)) throw new Error('register: metadata is required')
  if (!isNonEmptyString(meta.registrationEndpoint)) {
    throw new Error('register: metadata has no registrationEndpoint (dynamic registration is not supported)')
  }
  const endpointProblem = endpointSchemeProblem(meta.registrationEndpoint)
  if (endpointProblem !== null) {
    throw new Error(`register: ${endpointProblem} for registrationEndpoint ${redactUrl(meta.registrationEndpoint)}`)
  }
  if (!isNonEmptyString(redirectUri)) throw new Error('register: redirectUri is required')
  const fetchFn = pickFetch(fetchImpl)
  const budget = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const base = {
    client_name: isNonEmptyString(clientName) ? clientName : 'dsh-tool-hub',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
  }
  const attempt = (authMethod) => requestJson(fetchFn, meta.registrationEndpoint, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...base, token_endpoint_auth_method: authMethod }),
    timeoutMs: budget,
  })

  let response = await attempt('none')
  if (!response.ok || !isNonEmptyString(response.json?.client_id)) {
    response = await attempt('client_secret_basic')
  }
  if (!response.ok) {
    throw attachDebug(new Error(`register failed at ${redactUrl(meta.registrationEndpoint)}: ${response.reason}`), response)
  }
  if (!isNonEmptyString(response.json?.client_id)) {
    throw attachDebug(new Error(`register failed at ${redactUrl(meta.registrationEndpoint)}: response has no client_id`), response)
  }
  const result = { clientId: response.json.client_id }
  if (isNonEmptyString(response.json.client_secret)) result.clientSecret = response.json.client_secret
  return result
}

/**
 * Build the authorization request URL: authorization code + PKCE (S256) +
 * state + RFC 8707 `resource`. `state` is mandatory so a caller cannot
 * silently lose CSRF protection.
 *
 * @returns {string}
 */
export function authorizeUrl({ meta, clientId, redirectUri, state, codeChallenge, scopes } = {}) {
  if (!isRecord(meta) || !isNonEmptyString(meta.authorizationEndpoint)) {
    throw new Error('authorizeUrl: meta.authorizationEndpoint is required')
  }
  const endpointProblem = endpointSchemeProblem(meta.authorizationEndpoint)
  if (endpointProblem !== null) {
    throw new Error(`authorizeUrl: ${endpointProblem} for authorizationEndpoint ${redactUrl(meta.authorizationEndpoint)}`)
  }
  if (!isNonEmptyString(clientId)) throw new Error('authorizeUrl: clientId is required')
  if (!isNonEmptyString(redirectUri)) throw new Error('authorizeUrl: redirectUri is required')
  if (!isNonEmptyString(state)) throw new Error('authorizeUrl: state is required')
  if (!isNonEmptyString(codeChallenge)) throw new Error('authorizeUrl: codeChallenge is required')
  if (!isNonEmptyString(meta.resource)) throw new Error('authorizeUrl: meta.resource is required (RFC 8707)')

  const url = new URL(meta.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  const scope = Array.isArray(scopes)
    ? scopes.filter(isNonEmptyString).join(' ')
    : isNonEmptyString(scopes) ? scopes.split(/\s+/).filter(isNonEmptyString).join(' ') : ''
  if (scope !== '') url.searchParams.set('scope', scope)
  url.searchParams.set('resource', meta.resource)
  return url.toString()
}

/**
 * Redeem an authorization code at the token endpoint
 * (`application/x-www-form-urlencoded`, PKCE verifier + RFC 8707 resource).
 * A client secret switches the request to HTTP Basic.
 *
 * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresIn?: number, tokenType?: string }>}
 */
export async function exchangeCode({ meta, clientId, clientSecret, code, codeVerifier, redirectUri, fetchImpl, timeoutMs } = {}) {
  if (!isRecord(meta) || !isNonEmptyString(meta.tokenEndpoint)) {
    throw new Error('exchangeCode: meta.tokenEndpoint is required')
  }
  const endpointProblem = endpointSchemeProblem(meta.tokenEndpoint)
  if (endpointProblem !== null) {
    throw new Error(`exchangeCode: ${endpointProblem} for tokenEndpoint ${redactUrl(meta.tokenEndpoint)}`)
  }
  if (!isNonEmptyString(clientId)) throw new Error('exchangeCode: clientId is required')
  if (!isNonEmptyString(code)) throw new Error('exchangeCode: code is required')
  if (!isNonEmptyString(codeVerifier)) throw new Error('exchangeCode: codeVerifier is required')
  if (!isNonEmptyString(redirectUri)) throw new Error('exchangeCode: redirectUri is required')
  if (!isNonEmptyString(meta.resource)) throw new Error('exchangeCode: meta.resource is required (RFC 8707)')
  const fetchFn = pickFetch(fetchImpl)

  const form = new URLSearchParams()
  form.set('grant_type', 'authorization_code')
  form.set('code', code)
  form.set('redirect_uri', redirectUri)
  form.set('code_verifier', codeVerifier)
  form.set('resource', meta.resource)
  const headers = { 'content-type': 'application/x-www-form-urlencoded' }
  if (isNonEmptyString(clientSecret)) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  }
  else {
    form.set('client_id', clientId)
  }

  const response = await requestJson(fetchFn, meta.tokenEndpoint, {
    headers,
    body: form.toString(),
    timeoutMs: timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  })
  if (!response.ok) {
    throw attachDebug(new Error(`token exchange failed at ${redactUrl(meta.tokenEndpoint)}: ${response.reason}`), response)
  }
  const body = response.json
  if (!isNonEmptyString(body?.access_token)) {
    throw attachDebug(new Error(`token exchange failed at ${redactUrl(meta.tokenEndpoint)}: response has no access_token`), response)
  }
  const result = { accessToken: body.access_token }
  if (isNonEmptyString(body.refresh_token)) result.refreshToken = body.refresh_token
  const expiresIn = typeof body.expires_in === 'number'
    ? body.expires_in
    : typeof body.expires_in === 'string' && body.expires_in.trim() !== '' ? Number(body.expires_in) : Number.NaN
  if (Number.isFinite(expiresIn)) result.expiresIn = expiresIn
  if (isNonEmptyString(body.token_type)) result.tokenType = body.token_type
  return result
}

/**
 * PKCE pair per RFC 7636: a 43-character base64url verifier and its S256
 * challenge. `crypto.randomBytes` keeps the verifier inside the unreserved
 * alphabet, so no extra encoding is needed.
 *
 * @returns {{ verifier: string, challenge: string }}
 */
export function createPkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}
