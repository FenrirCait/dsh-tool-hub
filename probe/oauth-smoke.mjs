// Exercises lib/oauth.js end to end against local fake OAuth servers:
// the happy path (PRM -> AS -> register -> PKCE -> token), the PRM-404
// fallback to root AS metadata, issuer mismatch reporting, a hanging
// discovery candidate, and the client_secret_basic registration fallback.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { authorizeUrl, createPkce, discover, exchangeCode, register } from '../lib/oauth.js'

const results = []
const servers = []

function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === '' ? '' : `  — ${detail}`}`)
}

function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? '' : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)
}

function throwsMessage(run, needle) {
  try {
    run()
    return false
  }
  catch (error) {
    return String(error?.message).includes(needle)
  }
}

async function rejectsMessage(run, needle) {
  try {
    await run()
    return false
  }
  catch (error) {
    return String(error?.message).includes(needle)
  }
}

/** Route table key is `METHOD /path`; a route returns `{ status?, body? }` or 'hang'. */
async function startServer(routes) {
  const log = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const path = new URL(req.url, 'http://local').pathname
      log.push({ method: req.method, path, body, headers: req.headers })
      const route = routes[`${req.method} ${path}`]
      const origin = `http://127.0.0.1:${server.address().port}`
      if (route === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not_found"}')
        return
      }
      const reply = route(req, body, origin)
      if (reply === 'hang') return
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body ?? {}))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const handle = {
    origin: `http://127.0.0.1:${server.address().port}`,
    log,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
  servers.push(handle)
  return handle
}

async function main() {
  console.log('oauth smoke\n')

  // 1: path-form PRM -> inserted AS -> dynamic registration -> PKCE -> token.
  console.log('scenario 1: PRM -> AS -> register -> PKCE -> token')
  const s1 = await startServer({
    'GET /.well-known/oauth-protected-resource/mcp': (req, body, origin) => ({
      body: {
        resource: `${origin}/mcp`,
        issuer: `${origin}/mcp`,
        authorization_servers: [`${origin}/mcp`],
        scopes_supported: ['mcp.read', 'mcp.write'],
      },
    }),
    'GET /.well-known/oauth-authorization-server/mcp': (req, body, origin) => ({
      body: {
        issuer: `${origin}/mcp`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        scopes_supported: ['mcp.read', 'mcp.write'],
        code_challenge_methods_supported: ['S256'],
      },
    }),
    'POST /register': () => ({ status: 201, body: { client_id: 'client-abc' } }),
    'POST /token': () => ({
      body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' },
    }),
  })

  const d1 = await discover(`${s1.origin}/mcp`, { timeoutMs: 1000 })
  equal('1 authorizationEndpoint', d1.authorizationEndpoint, `${s1.origin}/authorize`)
  equal('1 tokenEndpoint', d1.tokenEndpoint, `${s1.origin}/token`)
  equal('1 registrationEndpoint', d1.registrationEndpoint, `${s1.origin}/register`)
  equal('1 issuer', d1.issuer, `${s1.origin}/mcp`)
  equal('1 resource', d1.resource, `${s1.origin}/mcp`)
  equal('1 scopes', d1.scopes, ['mcp.read', 'mcp.write'])
  equal('1 first probe is the path-form PRM', `${s1.log[0].method} ${s1.log[0].path}`,
    'GET /.well-known/oauth-protected-resource/mcp')
  equal('1 discovery made exactly two requests', s1.log.length, 2)

  const redirectUri = 'http://127.0.0.1:33418/callback'
  const reg1 = await register(d1, { clientName: 'Smoke Client', redirectUri, timeoutMs: 1000 })
  equal('1 register clientId', reg1.clientId, 'client-abc')
  check('1 public client has no clientSecret', reg1.clientSecret === undefined, String(reg1.clientSecret))
  const registerCall = s1.log.find((entry) => entry.method === 'POST' && entry.path === '/register')
  const registerBody = JSON.parse(registerCall.body)
  equal('1 register redirect_uris', registerBody.redirect_uris, [redirectUri])
  equal('1 register first auth method is none', registerBody.token_endpoint_auth_method, 'none')
  equal('1 register client_name', registerBody.client_name, 'Smoke Client')
  equal('1 register grant types', registerBody.grant_types, ['authorization_code'])
  check('1 register posts JSON', String(registerCall.headers['content-type']).startsWith('application/json'),
    registerCall.headers['content-type'])

  const pkce = createPkce()
  check('1 verifier is 43-128 unreserved chars', /^[A-Za-z0-9\-._~]{43,128}$/.test(pkce.verifier), pkce.verifier)
  equal('1 challenge is S256(verifier)', pkce.challenge,
    createHash('sha256').update(pkce.verifier).digest('base64url'))
  check('1 verifier is random per call', createPkce().verifier !== pkce.verifier)

  const authUrl = new URL(authorizeUrl({
    meta: d1,
    clientId: reg1.clientId,
    redirectUri,
    state: 'st-1',
    codeChallenge: pkce.challenge,
    scopes: d1.scopes,
  }))
  equal('1 authorize response_type', authUrl.searchParams.get('response_type'), 'code')
  equal('1 authorize client_id', authUrl.searchParams.get('client_id'), 'client-abc')
  equal('1 authorize redirect_uri', authUrl.searchParams.get('redirect_uri'), redirectUri)
  equal('1 authorize code_challenge', authUrl.searchParams.get('code_challenge'), pkce.challenge)
  equal('1 authorize code_challenge_method', authUrl.searchParams.get('code_challenge_method'), 'S256')
  equal('1 authorize state', authUrl.searchParams.get('state'), 'st-1')
  equal('1 authorize scope', authUrl.searchParams.get('scope'), 'mcp.read mcp.write')
  equal('1 authorize resource', authUrl.searchParams.get('resource'), `${s1.origin}/mcp`)
  const stringScope = new URL(authorizeUrl({
    meta: d1,
    clientId: reg1.clientId,
    redirectUri,
    state: 'st-2',
    codeChallenge: pkce.challenge,
    scopes: '  mcp.read   mcp.write  ',
  }))
  equal('1 a scope string is normalized to single spaces', stringScope.searchParams.get('scope'), 'mcp.read mcp.write')

  const tokens1 = await exchangeCode({
    meta: d1,
    clientId: reg1.clientId,
    code: 'code-1',
    codeVerifier: pkce.verifier,
    redirectUri,
    timeoutMs: 1000,
  })
  equal('1 token accessToken', tokens1.accessToken, 'at-1')
  equal('1 token refreshToken', tokens1.refreshToken, 'rt-1')
  equal('1 token expiresIn', tokens1.expiresIn, 3600)
  equal('1 token tokenType', tokens1.tokenType, 'Bearer')
  const tokenCall = s1.log.filter((entry) => entry.method === 'POST' && entry.path === '/token').at(-1)
  const tokenForm = new URLSearchParams(tokenCall.body)
  equal('1 token body code_verifier', tokenForm.get('code_verifier'), pkce.verifier)
  equal('1 token body resource', tokenForm.get('resource'), `${s1.origin}/mcp`)
  equal('1 token body grant_type', tokenForm.get('grant_type'), 'authorization_code')
  equal('1 token body code', tokenForm.get('code'), 'code-1')
  equal('1 token body redirect_uri', tokenForm.get('redirect_uri'), redirectUri)
  equal('1 token body client_id', tokenForm.get('client_id'), 'client-abc')
  check('1 token is form-encoded', String(tokenCall.headers['content-type'])
    .startsWith('application/x-www-form-urlencoded'), tokenCall.headers['content-type'])
  check('1 public token request has no Authorization header', tokenCall.headers.authorization === undefined,
    tokenCall.headers.authorization)

  // 2: both PRM documents 404, so the walk falls through to root AS metadata.
  console.log('\nscenario 2: PRM 404 -> root AS metadata')
  const s2 = await startServer({
    'GET /.well-known/oauth-authorization-server': (req, body, origin) => ({
      body: {
        issuer: origin,
        authorization_endpoint: `${origin}/a`,
        token_endpoint: `${origin}/t`,
      },
    }),
  })
  const d2 = await discover(`${s2.origin}/mcp`, { timeoutMs: 1000 })
  equal('2 root AS tokenEndpoint', d2.tokenEndpoint, `${s2.origin}/t`)
  equal('2 issuer from AS metadata', d2.issuer, s2.origin)
  equal('2 resource is the MCP endpoint', d2.resource, `${s2.origin}/mcp`)
  check('2 no registrationEndpoint when the document has none', d2.registrationEndpoint === undefined)
  equal('2 discovery order', s2.log.map((entry) => `${entry.method} ${entry.path}`), [
    'GET /.well-known/oauth-protected-resource/mcp',
    'GET /.well-known/oauth-protected-resource',
    'GET /.well-known/oauth-authorization-server/mcp',
    'GET /.well-known/oauth-authorization-server',
  ])

  // 3: PRM points at an AS whose metadata issuer differs -> hard failure that
  // names both URLs and the reason.
  console.log('\nscenario 3: issuer mismatch')
  const s3 = await startServer({
    'GET /.well-known/oauth-protected-resource/mcp': (req, body, origin) => ({
      body: {
        resource: `${origin}/mcp`,
        issuer: `${origin}/issuer-a`,
        authorization_servers: [`${origin}/issuer-a`],
      },
    }),
    'GET /.well-known/oauth-authorization-server/issuer-a': (req, body, origin) => ({
      body: {
        issuer: `${origin}/issuer-b`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
      },
    }),
  })
  let mismatch = null
  try {
    await discover(`${s3.origin}/mcp`, { timeoutMs: 1000 })
  }
  catch (error) {
    mismatch = error
  }
  const asUrl = `${s3.origin}/.well-known/oauth-authorization-server/issuer-a`
  const prmUrl = `${s3.origin}/.well-known/oauth-protected-resource/mcp`
  check('3 discovery rejects', mismatch !== null, 'resolved instead')
  check('3 error is an Error', mismatch instanceof Error)
  check('3 message says issuer mismatch', String(mismatch?.message).includes('issuer mismatch'), mismatch?.message)
  check('3 message names the AS metadata URL', String(mismatch?.message).includes(asUrl), mismatch?.message)
  check('3 message names the PRM URL', String(mismatch?.message).includes(prmUrl), mismatch?.message)
  check('3 message spells out both issuers',
    String(mismatch?.message).includes(`${s3.origin}/issuer-a`)
    && String(mismatch?.message).includes(`${s3.origin}/issuer-b`), mismatch?.message)
  check('3 message keeps the fallback reasons', String(mismatch?.message).includes('HTTP 404'), mismatch?.message)
  check('3 attempts carry the mismatching URL',
    Array.isArray(mismatch?.attempts) && mismatch.attempts.some((attempt) => attempt.url === asUrl),
    JSON.stringify(mismatch?.attempts))

  // 4: a candidate that never answers is abandoned at the budget and the walk
  // continues to the next document.
  console.log('\nscenario 4: hanging candidate times out')
  const s4 = await startServer({
    'GET /.well-known/oauth-protected-resource/mcp': () => 'hang',
    'GET /.well-known/oauth-protected-resource': (req, body, origin) => ({
      body: {
        resource: `${origin}/mcp`,
        issuer: origin,
        authorization_servers: [origin],
      },
    }),
    'GET /.well-known/oauth-authorization-server': (req, body, origin) => ({
      body: { issuer: origin, authorization_endpoint: `${origin}/a`, token_endpoint: `${origin}/t` },
    }),
  })
  const startedAt = Date.now()
  const d4 = await discover(`${s4.origin}/mcp`, { timeoutMs: 150 })
  const elapsed = Date.now() - startedAt
  equal('4 discovery still succeeds', d4.tokenEndpoint, `${s4.origin}/t`)
  equal('4 the hanging candidate was skipped', s4.log.map((entry) => `${entry.method} ${entry.path}`), [
    'GET /.well-known/oauth-protected-resource/mcp',
    'GET /.well-known/oauth-protected-resource',
    'GET /.well-known/oauth-authorization-server',
  ])
  check('4 it waited about the per-candidate budget', elapsed >= 120 && elapsed < 3000, `${elapsed}ms`)

  // 5: registration refuses a public client, falls back to client_secret_basic;
  // the token request then uses HTTP Basic, and a cross-origin PRM resource is
  // replaced by the MCP endpoint URL.
  console.log('\nscenario 5: registration fallback, basic auth, cross-origin resource')
  const redirect5 = 'http://127.0.0.1:33419/callback'
  const s5 = await startServer({
    'GET /.well-known/oauth-protected-resource/mcp': (req, body, origin) => ({
      body: {
        resource: 'https://elsewhere.example/mcp',
        issuer: origin,
        authorization_servers: [origin],
      },
    }),
    'GET /.well-known/oauth-authorization-server': (req, body, origin) => ({
      body: {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      },
    }),
    'POST /register': (req, body) => {
      const document = JSON.parse(body)
      if (document.token_endpoint_auth_method === 'none') {
        return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'public clients are not allowed' } }
      }
      return { status: 201, body: { client_id: 'conf-1', client_secret: 's3cret' } }
    },
    'POST /token': (req, body) => {
      const form = new URLSearchParams(body)
      if (form.get('code') === 'bad') {
        return {
          status: 400,
          body: {
            error: 'invalid_grant',
            error_description: `token=super-secret-123 secret=shh ${'x'.repeat(300)}`,
          },
        }
      }
      return { body: { access_token: 'at-2', token_type: 'Bearer', expires_in: '7200' } }
    },
  })
  const d5 = await discover(`${s5.origin}/mcp`, { timeoutMs: 1000 })
  equal('5 cross-origin PRM resource falls back to the MCP endpoint', d5.resource, `${s5.origin}/mcp`)
  check('5 no scopes when none are published', d5.scopes === undefined)
  const reg5 = await register(d5, { clientName: 'Confidential Client', redirectUri: redirect5, timeoutMs: 1000 })
  equal('5 register returns the client id', reg5.clientId, 'conf-1')
  equal('5 register returns the secret', reg5.clientSecret, 's3cret')
  const registerCalls = s5.log.filter((entry) => entry.method === 'POST' && entry.path === '/register')
  equal('5 two registration attempts', registerCalls.length, 2)
  equal('5 fallback auth method', JSON.parse(registerCalls[1].body).token_endpoint_auth_method, 'client_secret_basic')

  const pkce5 = createPkce()
  const tokens5 = await exchangeCode({
    meta: d5,
    clientId: reg5.clientId,
    clientSecret: reg5.clientSecret,
    code: 'code-5',
    codeVerifier: pkce5.verifier,
    redirectUri: redirect5,
    timeoutMs: 1000,
  })
  equal('5 token accessToken', tokens5.accessToken, 'at-2')
  equal('5 numeric-string expiresIn is parsed', tokens5.expiresIn, 7200)
  const token5 = s5.log.filter((entry) => entry.method === 'POST' && entry.path === '/token').at(-1)
  const form5 = new URLSearchParams(token5.body)
  equal('5 Basic authorization header', token5.headers.authorization,
    `Basic ${Buffer.from('conf-1:s3cret').toString('base64')}`)
  check('5 client_id is not duplicated in the body', form5.get('client_id') === null, form5.get('client_id'))
  equal('5 code_verifier still present', form5.get('code_verifier'), pkce5.verifier)
  equal('5 resource still present', form5.get('resource'), `${s5.origin}/mcp`)

  let tokenError = null
  try {
    await exchangeCode({
      meta: d5,
      clientId: reg5.clientId,
      clientSecret: reg5.clientSecret,
      code: 'bad',
      codeVerifier: pkce5.verifier,
      redirectUri: redirect5,
      timeoutMs: 1000,
    })
  }
  catch (error) {
    tokenError = error
  }
  check('5 token failures name the OAuth error',
    tokenError !== null && String(tokenError.message).includes('invalid_grant'), tokenError?.message)
  check('5 the message keeps status and code only',
    String(tokenError?.message).includes('400 invalid_grant'), tokenError?.message)
  check('5 the message carries no error_description or secret',
    tokenError !== null
    && !String(tokenError.message).includes('super-secret-123')
    && !String(tokenError.message).includes('token='),
    tokenError?.message)
  check('5 debug is a response copy truncated to 200 chars',
    typeof tokenError?.debug === 'string' && tokenError.debug.length === 200,
    String(tokenError?.debug?.length))
  check('5 debug redacts token and secret values',
    String(tokenError?.debug).includes('token=***')
    && String(tokenError?.debug).includes('secret=***')
    && !String(tokenError?.debug).includes('super-secret-123')
    && !String(tokenError?.debug).includes('shh'),
    tokenError?.debug)

  // 7: endpoint schemes are restricted to http(s) at discovery and at every
  // call site; upstream error text never reaches the message, only `debug`.
  console.log('\nscenario 7: endpoint schemes and error redaction')
  const s7 = await startServer({
    'GET /.well-known/oauth-protected-resource/mcp': (req, body, origin) => ({
      body: { resource: `${origin}/mcp`, issuer: origin, authorization_servers: [origin] },
    }),
    'GET /.well-known/oauth-authorization-server': (req, body, origin) => ({
      body: {
        issuer: origin,
        authorization_endpoint: 'file:///etc/passwd',
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      },
    }),
    'POST /register': () => ({
      status: 400,
      body: { error: 'invalid_client_metadata', error_description: 'nope token=reg-token-9 secret=reg-secret-9' },
    }),
  })
  let fileEndpoint = null
  try {
    await discover(`${s7.origin}/mcp`, { timeoutMs: 1000 })
  }
  catch (error) {
    fileEndpoint = error
  }
  check('7 discovery rejects a file: endpoint', fileEndpoint !== null, 'resolved instead')
  check('7 the reason is unsupported-scheme', String(fileEndpoint?.message).includes('unsupported-scheme'),
    fileEndpoint?.message)
  check('7 the attempt records the exact reason',
    Array.isArray(fileEndpoint?.attempts)
    && fileEndpoint.attempts.some((attempt) => attempt.reason === 'unsupported-scheme'),
    JSON.stringify(fileEndpoint?.attempts))
  check('7 the candidate URL is named',
    String(fileEndpoint?.message).includes(`${s7.origin}/.well-known/oauth-authorization-server`),
    fileEndpoint?.message)

  let fileServerUrl = null
  try {
    await discover('file:///tmp/mcp')
  }
  catch (error) {
    fileServerUrl = error
  }
  check('7 a file: serverUrl is refused', String(fileServerUrl?.message).includes('unsupported-scheme'),
    fileServerUrl?.message)

  let fetchCalls = 0
  const spyFetch = async () => {
    fetchCalls += 1
    throw new Error('fetch should not be called')
  }
  check('7 authorizeUrl refuses a file: endpoint', throwsMessage(() => authorizeUrl({
    meta: { authorizationEndpoint: 'file:///etc/passwd', resource: 'http://127.0.0.1:1/mcp' },
    clientId: 'c',
    redirectUri: 'http://127.0.0.1:1/cb',
    state: 's',
    codeChallenge: 'ch',
  }), 'unsupported-scheme'))
  check('7 exchangeCode refuses a file: token endpoint', await rejectsMessage(() => exchangeCode({
    meta: { tokenEndpoint: 'file:///etc/passwd', resource: 'http://127.0.0.1:1/mcp' },
    clientId: 'c',
    code: 'x',
    codeVerifier: 'v',
    redirectUri: 'http://127.0.0.1:1/cb',
    fetchImpl: spyFetch,
  }), 'unsupported-scheme'))
  check('7 register refuses a file: registration endpoint', await rejectsMessage(() => register(
    { registrationEndpoint: 'file:///etc/passwd' },
    { redirectUri: 'http://127.0.0.1:1/cb', fetchImpl: spyFetch },
  ), 'unsupported-scheme'))
  equal('7 refused calls never reach fetch', fetchCalls, 0)

  let registerError = null
  try {
    await register({ registrationEndpoint: `${s7.origin}/register` }, {
      redirectUri: 'http://127.0.0.1:33420/callback',
      timeoutMs: 1000,
    })
  }
  catch (error) {
    registerError = error
  }
  check('7 register failure keeps status and code',
    String(registerError?.message).includes('400 invalid_client_metadata'), registerError?.message)
  check('7 register failure hides the description and values',
    registerError !== null
    && !String(registerError.message).includes('reg-token-9')
    && !String(registerError.message).includes('reg-secret-9'),
    registerError?.message)
  check('7 register debug redacts secrets',
    String(registerError?.debug).includes('token=***')
    && String(registerError?.debug).includes('secret=***')
    && !String(registerError?.debug).includes('reg-token-9'),
    registerError?.debug)

  // 6: the OIDC document is the last resort; a PRM without `issuer` cannot be
  // validated and is rejected; an unreachable origin reports network errors.
  console.log('\nscenario 6: OIDC fallback, missing PRM issuer, network error')
  const s6 = await startServer({
    'GET /.well-known/openid-configuration': (req, body, origin) => ({
      body: { issuer: origin, authorization_endpoint: `${origin}/a`, token_endpoint: `${origin}/t` },
    }),
  })
  const d6 = await discover(`${s6.origin}/mcp`, { timeoutMs: 1000 })
  equal('6 OIDC root document is accepted', d6.tokenEndpoint, `${s6.origin}/t`)
  equal('6 the walk reaches OIDC only after AS metadata', s6.log.map((entry) => `${entry.method} ${entry.path}`), [
    'GET /.well-known/oauth-protected-resource/mcp',
    'GET /.well-known/oauth-protected-resource',
    'GET /.well-known/oauth-authorization-server/mcp',
    'GET /.well-known/oauth-authorization-server',
    'GET /mcp/.well-known/openid-configuration',
    'GET /.well-known/openid-configuration',
  ])

  const s6b = await startServer({
    'GET /.well-known/oauth-protected-resource/mcp': (req, body, origin) => ({
      body: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    }),
  })
  let missingIssuer = null
  try {
    await discover(`${s6b.origin}/mcp`, { timeoutMs: 1000 })
  }
  catch (error) {
    missingIssuer = error
  }
  check('6 PRM without issuer is rejected', missingIssuer !== null
    && String(missingIssuer.message).includes('missing issuer'), missingIssuer?.message)

  let unreachable = null
  try {
    await discover('http://127.0.0.1:1/mcp', { timeoutMs: 300 })
  }
  catch (error) {
    unreachable = error
  }
  check('6 an unreachable origin reports network errors', unreachable !== null
    && String(unreachable.message).includes('network error'), unreachable?.message)
  check('6 the failed origin is listed with its URI', unreachable !== null
    && String(unreachable.message).includes('http://127.0.0.1:1/.well-known/oauth-protected-resource/mcp'),
    unreachable?.message)

  // Unit guards: inputs that must be refused before any request is made.
  console.log('\nunit guards')
  check('authorizeUrl refuses a missing state', throwsMessage(() => authorizeUrl({
    meta: { authorizationEndpoint: 'http://127.0.0.1:1/a', resource: 'http://127.0.0.1:1' },
    clientId: 'c',
    redirectUri: 'http://127.0.0.1:1/cb',
    codeChallenge: 'ch',
  }), 'state'))
  check('register refuses metadata without registrationEndpoint', await rejectsMessage(
    () => register({ tokenEndpoint: 'http://127.0.0.1:1/t' }, { redirectUri: 'http://127.0.0.1:1/cb' }),
    'registrationEndpoint',
  ))
  check('exchangeCode refuses a missing resource', await rejectsMessage(() => exchangeCode({
    meta: { tokenEndpoint: 'http://127.0.0.1:1/t' },
    clientId: 'c',
    code: 'x',
    codeVerifier: 'v',
    redirectUri: 'http://127.0.0.1:1/cb',
  }), 'resource'))
}

try {
  await main()
}
catch (error) {
  check('smoke ran without throwing', false, error?.stack ?? String(error))
}
finally {
  await Promise.all(servers.map((handle) => handle.close()))
}

const passed = results.filter((result) => result.ok).length
console.log(`\n${passed}/${results.length} passed`)
if (passed !== results.length) process.exitCode = 1
