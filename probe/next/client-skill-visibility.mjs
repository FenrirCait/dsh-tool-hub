import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const skills = await readFile(new URL('../../src/client/views/skills.tsx', import.meta.url), 'utf8')
const types = await readFile(new URL('../../src/client/types.ts', import.meta.url), 'utf8')
const api = await readFile(new URL('../../src/client/api.ts', import.meta.url), 'utf8')

assert.match(types, /SkillVisibilitySnapshot/)
assert.match(types, /skillVisibility\?/)
assert.match(skills, /snapshot\.skillVisibility/)
assert.match(skills, /visibilityBySkill/)
assert.match(skills, /Deep PTC 隐藏/)
assert.match(skills, /Deep PTC 模型可见性已接入/)
assert.match(api, /skillVisibility: skillVisibilityOf\(record\.skillVisibility\)/)
assert.match(api, /function skillVisibilityOf/)
console.log('PASS  7 client visibility checks passed')