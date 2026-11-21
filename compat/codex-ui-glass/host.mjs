/**
 * codex-ui-glass — a no-op host module whose only job is to carry style.css.
 *
 * The loader still requires a host entry; the extension declares no ops and adds no settings.
 */
export default function activate(api) {
  api.log('info', '[codex-ui-glass] style pack active')
  return {
    module: {
      id: 'codex-ui-glass',
      title: { zh: 'Codex UI 玻璃兼容', en: 'Codex UI glass compat' },
      ops: [],
    },
    handlers: {},
  }
}
