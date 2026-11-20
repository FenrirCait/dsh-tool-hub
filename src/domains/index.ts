import type { Registry } from '../core/registry.js'
import type { DomainRegistration } from '../shared/contract.js'
import { configDomain } from './config.js'
import { createMcpDomain } from './mcp.js'
import { createPluginsDomain } from './plugins.js'
import { createSkillsDomain } from './skills.js'
import { groupsDomain } from './groups.js'
import { presetsDomain } from './presets.js'
import { scenesDomain } from './scenes.js'
import { sessionsDomain } from './sessions.js'
import { settingsDomain } from './settings.js'
import { toolSurfaceDomain } from './tool-surface.js'

/**
 * Every built-in domain, in one list. `registry.register` rejects a duplicate module or op id, so
 * an accidental second owner fails at startup instead of shadowing the first at dispatch time.
 */
export function registerAll(registry: Registry): DomainRegistration[] {
  const registrations: DomainRegistration[] = [
    createPluginsDomain(),
    createSkillsDomain(),
    createMcpDomain(),
    groupsDomain(),
    presetsDomain(),
    scenesDomain(),
    toolSurfaceDomain(),
    sessionsDomain(),
    settingsDomain(),
    configDomain(),
  ]
  for (const registration of registrations) registry.register(registration.module)
  return registrations
}
