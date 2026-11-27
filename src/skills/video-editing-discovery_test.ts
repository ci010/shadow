import assert from 'node:assert/strict'
import test from 'node:test'
import { getBuiltinSkills } from './builtins.ts'
import { SkillDisclosure } from './disclosure.ts'

test('video editing is discoverable and teaches stateless OTIO file views', async () => {
  const skills = await getBuiltinSkills()
  const skill = skills.get('video-editing')
  assert.ok(skill)
  assert.match(new SkillDisclosure().summary([skill]), /video-editing/)
  assert.match(skill.body, /edit\.otio\/overview/)
  assert.match(skill.body, /No mount/)
  assert.match(skill.body, /lossy view/)
  assert.match(skill.body, /Child path is never a Main path/)
})
