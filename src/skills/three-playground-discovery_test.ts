import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
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

test('diorama guidance links a JSON scene whose editable data actually drives the exported model', async () => {
  const body = (await getBuiltinSkills()).get('three-playground')!.body
  const ref = /v:skills\/three-playground\/(reference\/scene\.md)/.exec(body)![1]!
  const guide = await readFile(new URL(`./builtin/three-playground/${ref}`, import.meta.url), 'utf8')
  const [marker, scene] = [...guide.matchAll(/```json\s+([^`]+)```/g)].map(m => JSON.parse(m[1]!))
  assert.deepEqual(marker.assets, ['scene.json'])
  const source = /```js\s+([^`]+)```/.exec(guide)![1]!
  scene.parts[1].name = '验证：另一盏灯'
  const { glb } = await buildPlayground({ files: { [marker.files[0]]: source }, assets: {
    'scene.json': new TextEncoder().encode(JSON.stringify(scene)).buffer,
  } })
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true))))
  assert.ok(json.nodes.some((n: { name?: string; extras?: { objectId?: string } }) => n.name === scene.parts[1].name && n.extras?.objectId === 'shop.counter'))
})
