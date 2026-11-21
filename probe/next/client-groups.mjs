#!/usr/bin/env node
/**
 * Static gate for the groups view.
 *
 * It reads src/client/views/groups.tsx and pins what the view must keep: the exported name the
 * shell imports, the five op ids the groups domain registers, the exact payload each op is built
 * from, a confirmation dialog in front of every destructive op, accessible names on the controls,
 * no colour outside a token fallback, the size budget, and one check per interactive action.
 *
 * The payloads are not taste: they are src/domains/groups.ts's handlers. A shortcut that sends
 * { groupId } instead of { id } would pass the browser and fail the host, so it fails here first.
 *
 * No dependencies: PASS/FAIL lines, exit 1 when anything fails.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = join(ROOT, 'src', 'client', 'views', 'groups.tsx')
const I18N = join(ROOT, 'src', 'client', 'i18n.ts')

const results = []

function check(name, run) {
  try {
    const detail = run()
    results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : '' })
  }
  catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const source = readFileSync(VIEW, 'utf8')
const i18n = readFileSync(I18N, 'utf8')

/** Source with comments removed: a doc comment may name an op or a payload key in prose. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '')
const body = code(source)
const lineCount = source.split('\n').length

/** Body of one top-level declaration, from its marker to the next one. */
function slice(from, to) {
  const start = body.indexOf(from)
  assert(start !== -1, 'groups.tsx has no ' + from)
  const end = body.indexOf(to, start + from.length)
  assert(end !== -1, 'groups.tsx has no ' + to + ' after ' + from)
  return body.slice(start, end)
}

const saveFn = slice('function savePayload', 'export function GroupsView')
const confirmFn = slice('const confirmAction', 'const newDrawerLabel')
const dialogIndex = body.search(/<Dialog\s+open=\{/)
const dialogRegion = dialogIndex === -1 ? '' : body.slice(dialogIndex)
/** The title/body/label block the Dialog renders, computed before the JSX. */
const dialogCopy = slice("let title = ''", 'return (')
const rowsRegion = body.indexOf('rows.map(group =>') === -1 ? '' : body.slice(body.indexOf('rows.map(group =>'))

// ── gates ────────────────────────────────────────────────────────────────────

check('source-and-export', () => {
  assert(/export function GroupsView\(props: ViewProps\): React\.ReactElement \{/.test(body),
    'GroupsView must keep its exported name and (props: ViewProps) signature')
  assert(/import \* as React from 'react'/.test(body), 'the view must import React')
  return 'exported as GroupsView(props: ViewProps)'
})

check('view-props', () => {
  assert(/const \{ snapshot, lang, t, busy, run \} = props/.test(body),
    'the view must read snapshot, lang, t, busy and run off ViewProps')
  assert(/snapshot\.groups/.test(body), 'groups must come from the snapshot, not a local fetch')
  return 'snapshot, lang, t, busy, run'
})

check('required-ops', () => {
  const ops = ['group.save', 'group.delete', 'group.toggle', 'group.clean', 'collection.save']
  const missing = ops.filter(op => !body.includes("'" + op + "'"))
  assert(missing.length === 0, 'the view never names ' + missing.join(', '))
  return ops.join(', ')
})

check('group-save-payload', () => {
  assert(/id === null \? \{\} : \{ id \}/.test(saveFn), 'group.save must send id only when it edits an existing group')
  assert(/\bname,/.test(saveFn), 'group.save must send name')
  assert(/members: members \?\? \[\]/.test(saveFn), 'group.save must send members')
  assert(/collection: drawer === NONE \? null : drawer/.test(saveFn), 'group.save must send collection, null for ungrouped')
  return '{ id?, name, members, collection }'
})

check('group-batch-payload', () => {
  assert(/run\(OPS\.batch, \{ id: group\.id, enabled: next, skipShared: false \}\)/.test(body),
    'group.batch must send { id, enabled, skipShared }')
  return '{ id, enabled, skipShared: false }'
})

check('group-delete-payload', () => {
  assert(/run\(OPS\.del, \{ id: targetId \}\)/.test(confirmFn), 'group.delete must send { id } from the dialog')
  return '{ id }'
})

check('group-clean-payload', () => {
  assert(/run\(OPS\.clean, \{ id: targetId \}\)/.test(confirmFn), 'group.clean must send { id } from the dialog')
  return '{ id }'
})

check('collection-save-payload', () => {
  assert(/run\(OPS\.collection, \{ id: slug, name \}\)/.test(confirmFn),
    'collection.save must send { id, name }; the host keys the drawer by that id')
  assert(/const slug = slugify\(name\)/.test(confirmFn), 'the drawer id must be derived from the typed name, not invented per click')
  return '{ id, name }'
})

check('confirm-before-delete', () => {
  const confirmAt = body.indexOf('const confirmAction')
  const delAt = body.indexOf('run(OPS.del')
  assert(delAt !== -1, 'group.delete is never sent')
  assert(delAt > confirmAt, 'group.delete must be sent from the dialog, not straight off a row button')
  const openAt = body.indexOf("openConfirm('delete', group)")
  assert(openAt !== -1, 'the row delete button must open a dialog first')
  assert(openAt < dialogIndex, 'the row button must only open the dialog')
  assert(/t\('groups\.deleteBody'/.test(dialogCopy), 'the confirm dialog must name the group it deletes')
  assert(/onClick=\{confirmAction\}/.test(dialogRegion), 'the dialog confirm button must run the handler')
  return 'row opens the dialog, only the dialog sends group.delete'
})

check('confirm-before-clean', () => {
  const confirmAt = body.indexOf('const confirmAction')
  const cleanAt = body.indexOf('run(OPS.clean')
  assert(cleanAt > confirmAt, 'group.clean must be sent from the dialog, not straight off a row button')
  const openAt = body.indexOf("openConfirm('clean', group)")
  assert(openAt !== -1 && openAt < dialogIndex, 'the clean button must only open the dialog')
  assert(/t\('groups\.clean'/.test(dialogCopy), 'the clean dialog must label what it does')
  return 'stale members are dropped only after confirmation'
})

check('empty-state', () => {
  assert(/title=\{t\('groups\.empty'\)\}/.test(body), "the empty list must render t('groups.empty')")
  assert(/<Empty/.test(body), 'the empty list must use the Empty component')
  assert(/hint=\{t\('groups\.membersHint'\)\}/.test(body), 'the empty list must say how members get in')
  return 'Empty + groups.empty when there is no group'
})

check('filtered-empty-state', () => {
  assert(/t\('groups\.emptyFiltered', \{ query: emptyQuery \}\)/.test(body),
    'a filter that matches nothing must render groups.emptyFiltered with the term')
  return 'groups.emptyFiltered with the active term'
})

check('accessible-labels', () => {
  assert(/label=\{t\('a11y\.switch', \{ name: group\.name \}\)\}/.test(body), 'the group switch needs an accessible name')
  assert(/label=\{t\('groups\.search'\)\}/.test(body), 'the search box needs an accessible name')
  assert(/<Field id="th-group-name" label=\{t\('groups\.name'\)\}/.test(body), 'the name field needs a label')
  const labelled = (body.match(/label=\{/g) ?? []).length
  assert(labelled >= 8, 'only ' + labelled + ' labelled controls; every action needs a name')
  return labelled + ' labelled controls'
})

check('no-literal-colours', () => {
  // Drop every var(--dsw-alias-...) with its balanced fallback, then nothing coloured may remain.
  const strip = text => {
    let out = ''
    let index = 0
    while (index < text.length) {
      const start = text.indexOf('var(--dsw-alias-', index)
      if (start === -1) {
        out += text.slice(index)
        break
      }
      out += text.slice(index, start)
      let depth = 0
      let cursor = start
      for (; cursor < text.length; cursor += 1) {
        const char = text[cursor]
        if (char === '(') depth += 1
        else if (char === ')') {
          depth -= 1
          if (depth === 0) {
            cursor += 1
            break
          }
        }
      }
      index = cursor
    }
    return out
  }
  const rest = strip(body)
  const match = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(rest)
  assert(match === null, 'a literal colour at char ' + (match === null ? 0 : match.index) + '; use a th-* class or a token')
  const inline = (body.match(/style=\{\{/g) ?? []).length
  return 'tokens only, ' + inline + ' inline style blocks'
})

check('file-length', () => {
  const bytes = statSync(VIEW).size
  assert(lineCount <= 480, 'groups.tsx is ' + lineCount + ' lines (limit 480)')
  assert(bytes < 64 * 1024, 'groups.tsx is ' + bytes + ' bytes')
  return lineCount + ' lines, ' + bytes + ' bytes'
})

check('import-contract', () => {
  for (const match of body.matchAll(/from '(\.[^']+)'/g)) {
    assert(/\.js$/.test(match[1]), 'import ' + match[1] + ' needs a .js suffix')
  }
  assert(/from '\.\.\/components\.js'/.test(body), 'the view must reuse components.tsx')
  assert(/from '\.\.\/types\.js'/.test(body), 'the view must import its props from types.ts')
  // auto.preview returns a plan the view must render, so one read-only import is allowed.
  assert(/import \{ runOp \} from '\.\.\/api\.js'/.test(body), 'the view imports runOp for the auto.preview read')
  assert(!/getSnapshot|fetch\(/.test(body), 'the view must not fetch or read the snapshot itself')
  return 'components.js + types.js + runOp (read-only preview)'
})

check('no-direct-io', () => {
  for (const pattern of ['fetch(', 'getSnapshot', 'innerHTML', 'dangerouslySetInnerHTML']) {
    assert(body.indexOf(pattern) === -1, 'groups.tsx calls ' + pattern + '; only run() talks to the host')
  }
  const direct = [...body.matchAll(/runOp\(\s*([A-Za-z0-9_.]+)/g)].map(match => match[1])
  assert(direct.length > 0, 'the auto-groups preview reads through runOp')
  assert(direct.every(target => target === 'OPS.autoPreview' || target === 'OPS.marketStatus'), 'runOp may only call the read-only auto.preview / market.status')
  return 'one read-only runOp, every write goes through run()'
})

check('i18n-keys', () => {
  const marker = /const zh: Catalog = \{/.exec(i18n)
  assert(marker !== null, 'i18n.ts has no zh catalog')
  const start = marker.index + marker[0].length - 1
  let depth = 0
  let end = -1
  for (let cursor = start; cursor < i18n.length; cursor += 1) {
    if (i18n[cursor] === '{') depth += 1
    else if (i18n[cursor] === '}') {
      depth -= 1
      if (depth === 0) {
        end = cursor
        break
      }
    }
  }
  assert(end !== -1, 'the zh catalog is not closed')
  const keys = new Set([...i18n.slice(start + 1, end).matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1]))
  const used = [...body.matchAll(/\bt\('([^']+)'/g)].map(match => match[1])
  const missing = [...new Set(used)].filter(key => !keys.has(key))
  assert(missing.length === 0, 'no catalog defines ' + missing.join(', '))
  return used.length + ' calls, ' + new Set(used).size + ' distinct keys, all defined'
})

check('single-write-path', () => {
  const calls = body.match(/\brun\(/g) ?? []
  assert(calls.length >= 5, 'expected every op to go through run(), found ' + calls.length)
  assert(calls.length === (body.match(/\brun\(OPS\./g) ?? []).length, 'an op escapes the OPS table')
  return calls.length + ' run() calls, all keyed by the OPS table'
})

check('busy-keys', () => {
  // The shell sets busy to op:id, with the id taken from the payload: a row keyed by the group
  // name would never light up, so each of these has to name the id the payload sends.
  const pairs = [
    ['batch', 'group.id'],
    ['save', 'targetId'],
    ['del', 'group.id'],
    ['del', 'targetId'],
    ['clean', 'group.id'],
    ['clean', 'targetId'],
    ['collection', 'slugify(drawerName)'],
  ]
  for (const [op, id] of pairs) {
    const pattern = new RegExp('\\$\\{OPS\\.' + op + '\\}:\\$\\{' + id.replace(/[.()]/g, '\\$&') + '\\}')
    assert(pattern.test(body), 'the ' + op + ' busy key must be ' + op + ':' + id)
  }
  assert(/busy=\{busy ===/.test(body), 'controls must read the busy key the shell sets')
  return pairs.length + ' busy keys, all op:id'
})

// ── one check per interactive action ─────────────────────────────────────────

check('action-create', () => {
  assert(/onClick=\{openCreate\}/.test(body), 'the toolbar needs a New group button')
  assert(/setDialog\('create'\)/.test(body), 'New group must open the create dialog')
  assert(/run\(OPS\.save, savePayload\(editing === undefined \? null : editing\.id/.test(confirmFn),
    'the create path must send group.save without an id')
  assert(/disabled=\{confirmDisabled\}/.test(dialogRegion), 'an empty name must not be submittable')
  return 'toolbar -> create dialog -> group.save'
})

check('action-edit', () => {
  assert(/openEdit\(group\)/.test(rowsRegion), 'each row needs an edit action')
  assert(/setFormName\(group\.name\)/.test(body), 'edit must start from the current name')
  assert(/editing\?\.members \?\? null/.test(confirmFn), 'edit must resend the members or the handler drops them')
  assert(/\\?\$\{OPS\.save\}:\$\{targetId\}/.test(body), 'edit must report its own busy key')
  return 'row -> edit dialog -> group.save { id, name, members, collection }'
})

check('action-toggle', () => {
  assert(/const on = isOn\(group\)/.test(body) && /groupOnReader\(snapshot\)/.test(body), 'the switch must derive state from the live member rows')
  assert(/checked=\{on\}/.test(body), 'the switch must be bound to that state')
  assert(/<Switch/.test(body), 'the bulk switch must use the Switch component')
  return 'Switch -> group.batch, busy group.batch:id'
})

check('action-delete', () => {
  assert(/t\('groups\.delete'\)\}: \$\{group\.name\}/.test(body), 'the delete button needs a name and an accessible label')
  assert(/variant="danger"/.test(body), 'delete must be the danger variant')
  assert(/busy=\{busy === .*OPS\.del.*\}/.test(body), 'the row must show the delete op as busy')
  return 'row -> confirm dialog -> group.delete'
})

check('action-clean', () => {
  assert(/stale > 0 \? \(/.test(body), 'clean may only appear when the group has stale members')
  assert(/t\('groups\.stale', \{ n: stale \}\)/.test(body), 'the row must say how many members are stale')
  assert(/openConfirm\('clean', group\)/.test(rowsRegion), 'clean must open the confirm dialog')
  return 'row (stale > 0) -> confirm dialog -> group.clean'
})

check('action-drawer', () => {
  assert(/setDialog\('drawer'\)/.test(body), 'the toolbar needs a New drawer action')
  assert(/const slug = slugify\(name\)/.test(confirmFn), 'the drawer name must become a stable id before the write')
  assert(/run\(OPS\.collection/.test(confirmFn), 'the drawer dialog must send collection.save')
  assert(/busy === .*OPS\.collection.*slugify\(drawerName\)/.test(body), 'the drawer dialog needs a busy key')
  return 'toolbar -> drawer dialog -> collection.save { id, name }'
})

check('action-auto', () => {
  assert(/自动分组/.test(body), 'the toolbar exposes the auto-groups action')
  assert(/runOp\(OPS\.autoPreview/.test(body), 'the action previews through auto.preview')
  assert(/run\(OPS\.autoApply/.test(body), 'the confirm sends auto.apply through run()')
  return 'toolbar -> preview dialog -> confirm -> auto.apply'
})

check('action-filter', () => {
  assert(/<SearchBox/.test(body), 'the toolbar needs the SearchBox component')
  assert(/onChange=\{setQuery\}/.test(body), 'search must filter on change')
  assert(/group\.name\.toLowerCase\(\)\.includes\(term\)/.test(body), 'the term must match the group name')
  assert(/onChange=\{setFilter\}/.test(body), 'the drawer filter must be selectable')
  assert(/filter === NONE \? drawer !== ''/.test(body), 'the ungrouped filter must select groups without a drawer')
  return 'SearchBox + drawer Select narrow the rows'
})

// ── report ───────────────────────────────────────────────────────────────────

let failed = 0
for (const result of results) {
  const state = result.ok ? 'PASS' : 'FAIL'
  if (!result.ok) failed += 1
  const suffix = result.detail === '' ? '' : ' (' + result.detail + ')'
  console.log(state + ' ' + result.name + suffix)
}
console.log((results.length - failed) + '/' + results.length + ' checks passed')
if (failed > 0) process.exit(1)