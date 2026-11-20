/**
 * The settings page and the pure model behind it.
 *
 * The view is the only React export; everything else is plain functions, so the probe can test
 * grouping, typing and dirty tracking without a DOM.
 */
export { SAVE_OP } from './ops.js'
export { SettingsView } from './view.js'
export { FieldRow } from './fields.js'
export type { FieldRowProps } from './fields.js'
export {
  coerce,
  dirtyOf,
  displayValueOf,
  draftOf,
  fallbackOf,
  fieldKind,
  groupFields,
  groupIdOf,
  groupTitleOf,
  modulePrefixOf,
  pick,
  restoreDefaultsOf,
  sameValue,
  savePayloadOf,
  titleCaseOf,
  valueOf,
} from './model.js'
export type { FieldKind, SettingsGroup } from './model.js'
