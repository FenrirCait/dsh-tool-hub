/**
 * hello-extension — the smallest useful local extension for dsh-tool-hub 2.0.
 *
 * The loader imports this file, calls the default export with an `api` describing the host, and
 * expects `{ module, handlers }` back. `module` is the declarative half the registry and the panel
 * read; `handlers` maps every declared op id to the function that runs it. Nothing else crosses the
 * boundary: an extension cannot replace a built-in op, add a panel slot or reach another extension.
 *
 * Ops (namespace = the id in manifest.json):
 *   hello.status  read   — one table row per fact, consumed by the declared table view
 *   hello.echo    write  — returns its payload unchanged; the op console confirms before sending
 */

/**
 * Rows are plain records — one key per column — because that is what a table view renders.
 * `env.state` is the live state document (read-only for extensions); `env.now()` is the host clock,
 * so the example never reaches for Date.now() directly.
 */
function statusRows(api, env) {
  const enabled = Array.isArray(env.state?.extensions?.enabled) ? env.state.extensions.enabled : []
  const now = typeof env.now === 'function' ? env.now() : Date.now()
  return [
    { key: 'extension', value: api.id },
    { key: 'apiVersion', value: api.version },
    { key: 'folder', value: api.dir },
    { key: 'enabledExtensions', value: enabled.length === 0 ? '(none)' : enabled.join(', ') },
    { key: 'platform', value: `${process.platform} ${process.arch}` },
    { key: 'node', value: process.version },
    { key: 'pid', value: process.pid },
    { key: 'servedAt', value: new Date(now).toISOString() },
  ]
}

/** The activate hook: sync or async, called once per load (and again after a reload). */
export default function activate(api) {
  api.log('info', `[hello] activated against api v${api.version} from ${api.dir}`)

  return {
    module: {
      id: 'hello',
      title: { zh: '问候示例', en: 'Hello example' },
      ops: [
        {
          id: 'hello.status',
          write: false,
          audit: false,
          note: 'One row per fact: id, api version, folder, enabled extensions, platform, node, pid, serve time.',
        },
        {
          id: 'hello.echo',
          write: true,
          audit: true,
          note: 'Returns the payload unchanged; the panel asks before sending a write op.',
        },
      ],
    },
    handlers: {
      // Read op: the table view calls it with {} and renders the array.
      'hello.status': async (_payload, env) => statusRows(api, env),
      // Write op: echo the payload so the console round trip is visible in the result pane.
      'hello.echo': async payload => payload,
    },
  }
}
