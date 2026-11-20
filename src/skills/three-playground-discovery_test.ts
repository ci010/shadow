import assert from 'node:assert/strict'
import test from 'node:test'
import { getBuiltinSkills } from './builtins.ts'
import { SkillDisclosure } from './disclosure.ts'
import { buildPlayground } from '../../packages/three-playground/index.ts'

test('general modeling is discoverable in a cold prompt only when the skill is visible', async () => {
  const skills = await getBuiltinSkills()
  const disclosure = new SkillDisclosure()
  const hint = 'read("v:skills/three-playground")'
  assert.ok(disclosure.summary([...skills.values()]).includes(hint))
  skills.delete('three-playground')
  assert.ok(!disclosure.summary([...skills.values()]).includes(hint))
})

test('the bundled getting-started files build a GLB with individually editable lamp parts', async () => {
  const body = (await getBuiltinSkills()).get('three-playground')!.body
  const marker = JSON.parse(/```json\s+([^`]+)```/.exec(body)![1]!)
  assert.deepEqual(marker.files, ['main.mjs'])
  const source = /```js\s+([^`]+)```/.exec(body)![1]!
  const { glb } = await buildPlayground({ files: { 'main.mjs': source } })
  const json = new TextDecoder().decode(new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true)))
  const ids = JSON.parse(json).nodes.map((node: {extras?: {objectId?: string}}) => node.extras?.objectId).filter(Boolean)
  assert.deepEqual(ids.sort(), ['lamp.base', 'lamp.shade', 'lamp.stem'])
})
