import assert from 'node:assert/strict'
import test from 'node:test'
import { getBuiltinSkills } from './builtins.ts'
import { SkillDisclosure } from './disclosure.ts'
import { readFile } from 'node:fs/promises'
import { initialTimeline } from '../video/index.ts'
import { prepareOtioProfile } from '../shared/otio-effects.ts'

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


test('composition skill examples use accepted effects and preserve exact profile spelling', async () => {
  const body = (await getBuiltinSkills()).get('video-editing')!.body
  assert.match(body, /v:skills\/video-editing\/reference\/effects\.md/)
  assert.match(body, /--manifest edit\.otio\.preview\.json/)
  const guide = await readFile(new URL('./builtin/video-editing/reference/effects.md', import.meta.url), 'utf8')
  const effect = JSON.parse(/```json\s+([^`]+)```/.exec(guide)![1]!)
  const raw: any = initialTimeline(2)
  const duration = raw.tracks.children[0].children[0].source_range
  raw.tracks.children[0].children = [{ OTIO_SCHEMA: 'Clip.1', source_range: duration, media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: 'source.png' }, effects: [effect] }]
  const prepared = prepareOtioProfile(JSON.stringify(raw))
  assert.equal(prepared.effects['/tracks/children/0/children/0']![0]!.profile, 'opacity')
  assert.equal(prepared.requiresCompositePreview, true)
})


test('video workflow teaches revision-safe editing, repeated preview publication and output-frame timing', async () => {
  const body = (await getBuiltinSkills()).get('video-editing')!.body
  assert.match(body, /project-video edit SOURCE\.otio --patch/)
  assert.match(body, /hash is not a lock/)
  assert.match(body, /--frames N --rate RATE/)
  assert.match(body, /--manifest-revision PREVIOUS_MANIFEST_SHA256/)
  assert.match(body, /plan\.warnings/)
  assert.match(body, /may clip/)
  assert.match(body, /scripts\/video-title\.mjs --text-file/)
  assert.match(body, /font-coverage-not-verified/)
  assert.match(body, /not a packaged `project-video` command/)
})
