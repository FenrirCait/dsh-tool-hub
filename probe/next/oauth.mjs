#!/usr/bin/env node
/**
 * MCP OAuth end to end against a local authorization server.
 *
 * Covers the 1.x flow the panel re-exposes: protected-resource discovery, dynamic client
 * registration, PKCE authorize URL, code exchange, and the token landing in that row's
 * Authorization header (verified in the patch bytes, not in memory).
 */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const distRoot = process.env.TOOL_HUB_DIST ?? join(process.cwd(), 'dist')
const mcp = await import(pathToFileURL(join(distRoot, 'domains', 'mcp.js')).href)

let pass = 0
let fail = 0
function check(name, run) {
  return Promise.resolve()
    .then(run)
    .then(detail => { pass += 1; console.log('PASS ' + name + (detail === undefined ? '' : '  ' + detail)) })
    .catch(error => { fail += 1; console.log('FAIL ' + name + '  ' + (error && error.message ? error.message : String(error))) })
}
function assert(condition, message) { if (!condition) throw new Error(message) }
function equal(actual, expected, label) {
  const left = JSON.stringify(actual); const right = JSON.stringify(expected)
  if (left !== right) throw new Error((label ?? 'expected') + ' ' + right + ', got ' + left)
}

const root = await mkdtemp(join(tmpdir(), 'hub-oauth-'))
const patch = join(root, 'cordis.patch.yml')
let origin = ''
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', origin)
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname.endsWith('/.well-known/oauth-protected-resource') || url.pathname.includes('oauth-protected-resource')) {
    return json(200, { resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['read', 'write'] })
  }
  if (url.pathname.endsWith('/.well-known/oauth-authorization-server') || url.pathname.includes('oauth-authorization-server')) {
    return json(200, {
      issuer: origin,
      authorization_endpoint: origin + '/authorize',
      token_endpoint: origin + '/token',
      registration_endpoint: origin + '/register',
      scopes_supported: ['read', 'write'],
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    })
  }
  if (url.pathname === '/register' && req.method === 'POST') {
    return json(201, { client_id: 'probe-client', client_secret: 'probe-secret' })
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    return json(200, { access_token: 'probe-token-123', token_type: 'Bearer', expires_in: 3600 })
  }
  return json(404, { error: 'not_found', path: url.pathname })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
origin = 'http://127.0.0.1:' + String(server.address().port)
await writeFile(patch, [
  '- id: probe-mcp',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config:',
  '    serverName: probe',
  '    transport: streamable-http',
  '    url: ' + origin + '/mcp',
].join('\n') + '\n')

const env = {
  state: { modules: {} },
  services: {
    get(name) {
      if (name === 'profileContext') return { dir: root }
      if (name === 'pluginManager') return { listPlugins: async () => [{ patchId: 'probe-mcp', moduleName: '@deepseek-ai/dsh-mcp-client', name: 'probe', enabled: true }] }
      return undefined
    },
  },
  save: async () => 'backup-probe',
  now: () => Date.now(),
}
const domain = mcp.createMcpDomain()

try {
  await check('ops: oauth start/finish/cancel are declared with the right write flags', () => {
    const ops = Object.fromEntries(domain.module.ops.map(op => [op.id, op]))
    assert(ops['mcp.oauthStart'] && ops['mcp.oauthStart'].write === false, 'start')
    assert(ops['mcp.oauthFinish'] && ops['mcp.oauthFinish'].write === true && ops['mcp.oauthFinish'].audit === true, 'finish')
    assert(ops['mcp.oauthCancel'] && ops['mcp.oauthCancel'].write === false, 'cancel')
    return Object.keys(ops).filter(id => id.includes('oauth')).join(', ')
  })
  await check('code: a bare code, a callback URL and empty input', () => {
    equal(mcp.oauthCodeOf('abc123'), 'abc123')
    equal(mcp.oauthCodeOf('http://localhost/oauth/callback?code=xyz&state=s1'), 'xyz')
    equal(mcp.oauthCodeOf('   '), '')
  })

  let authorizeUrl = ''
  let state = ''
  await check('start: discovery, registration and PKCE produce an authorize URL', async () => {
    const result = await domain.handlers['mcp.oauthStart']({ id: 'probe-mcp' }, env)
    assert(result.ok === true, 'start failed: ' + JSON.stringify(result))
    authorizeUrl = result.authorizeUrl
    state = result.state
    assert(authorizeUrl.startsWith(origin + '/authorize?'), 'authorize url: ' + authorizeUrl)
    assert(authorizeUrl.includes('code_challenge='), 'PKCE challenge missing')
    assert(authorizeUrl.includes('client_id=probe-client'), 'client id missing')
    equal(result.redirectUri, mcp.OAUTH_REDIRECT_URI)
    return 'state ' + state.slice(0, 8) + '…'
  })
  await check('finish: unknown state is refused', async () => {
    const result = await domain.handlers['mcp.oauthFinish']({ state: 'nope', code: 'x' }, env)
    assert(result.ok === false && result.code === 'bad-state', JSON.stringify(result))
  })
  await check('finish: the token is written into the row Authorization header', async () => {
    const result = await domain.handlers['mcp.oauthFinish']({ state, code: 'http://localhost/oauth/callback?code=auth-code-1' }, env)
    assert(result.ok === true, 'finish failed: ' + JSON.stringify(result))
    const text = await readFile(patch, 'utf8')
    assert(/Authorization: '?Bearer probe-token-123'?/.test(text), 'header absent:\n' + text)
    assert(text.includes('serverName: probe'), 'row lost its config')
    return 'bearer stored'
  })
  await check('finish: a code cannot be replayed after success', async () => {
    const result = await domain.handlers['mcp.oauthFinish']({ state, code: 'auth-code-1' }, env)
    assert(result.ok === false && result.code === 'bad-state', JSON.stringify(result))
  })
  await check('cancel: dropping a login makes its state unusable', async () => {
    const start = await domain.handlers['mcp.oauthStart']({ id: 'probe-mcp' }, env)
    const cancelled = await domain.handlers['mcp.oauthCancel']({ state: start.state }, env)
    assert(cancelled.ok === true, 'cancel')
    const finish = await domain.handlers['mcp.oauthFinish']({ state: start.state, code: 'x' }, env)
    assert(finish.ok === false && finish.code === 'bad-state', JSON.stringify(finish))
  })
  await check('start: a stdio row has no URL to authorize', async () => {
    await writeFile(patch, ['- id: local-mcp', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: local', '    transport: stdio', '    command: node'].join('\n') + '\n')
    const result = await domain.handlers['mcp.oauthStart']({ id: 'local-mcp' }, env)
    assert(result.ok === false && result.code === 'not-http', JSON.stringify(result))
  })
} finally {
  await new Promise(done => server.close(done))
  await rm(root, { recursive: true, force: true })
}
console.log('\noauth probe: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)