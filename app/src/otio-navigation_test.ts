import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OtioModel, OtioNode } from './otio-model.ts'
import { lastOtioFrame, otioLanes, otioPercent, scrubOtioFrame, visibleOtioNodes } from './otio-navigation.ts'

function node(id: string, parentId: string | null, kind: string, depth: number, start = 0, end = 5): OtioNode {
  return { id, parentId, kind, depth, start, end, schema: `${kind}.1`, name: 'Same name', sourceStart: null, enabled: true }
}
const root = node('', null, 'Timeline', 0)
const stack = node('/tracks', '', 'Stack', 1)
const video = node('/tracks/children/0', stack.id, 'Track', 2)
const first = node(`${video.id}/children/0`, video.id, 'Clip', 3, 0, 3)
const overlap = node(`${video.id}/children/1`, video.id, 'Transition', 3, 2.5, 3.5)
const second = node(`${video.id}/children/2`, video.id, 'Clip', 3, 3, 4)
const gap = node(`${video.id}/children/3`, video.id, 'Gap', 3, 4, 5)
const audio = node('/tracks/children/1', stack.id, 'Track', 2)
const nodes = [root, stack, video, first, overlap, second, gap, audio]
const model: OtioModel = { root, nodes, rate: 24_000 / 1001, duration: 5, globalStart: null, warnings: [] }

test('timeline scrub uses rational-rate frame spacing and excludes the exact end', () => {
  const duration = 240 / model.rate
  assert.equal(lastOtioFrame(duration, model.rate), 239)
  assert.equal(lastOtioFrame(240.5 / model.rate, model.rate), 240)
  for (const [pointer, frame] of [[-.5, 0], [0, 0], [.25, 60], [1, 239], [1.5, 239]] as const) {
    assert.equal(scrubOtioFrame(pointer, duration, model.rate), frame)
  }
  assert.equal(lastOtioFrame(0, model.rate), 0)
})

test('lane assignment preserves authored overlap, gaps, layout alignment and empty tracks', () => {
  const lanes = otioLanes(model)
  assert.deepEqual(lanes, [{ node: video, items: [first, overlap, second, gap] }, { node: audio, items: [] }])
  assert.equal(otioPercent(overlap.start, model.duration), 50)
  assert.equal(otioPercent(overlap.end, model.duration), 70)
  assert.equal(otioPercent(first.end, model.duration), otioPercent(second.start, model.duration))
  assert.equal(otioPercent(gap.end, model.duration), 100)
  const direct = node('/tracks/children/2', stack.id, 'Clip', 2)
  assert.deepEqual(otioLanes({ ...model, nodes: [...nodes, direct] }).at(-1), { node: direct, items: [direct] })
})

test('parallel items get independently selectable lanes in both root and nested stacks', () => {
  const nested = node(`${video.id}/children/4`, video.id, 'Stack', 3)
  const nestedA = node(`${nested.id}/children/0`, nested.id, 'Clip', 4, 1, 4)
  const nestedB = node(`${nested.id}/children/1`, nested.id, 'Clip', 4, 1, 4)
  const directA = node('/tracks/children/2', stack.id, 'Clip', 2, 0, 3)
  const directB = node('/tracks/children/3', stack.id, 'Clip', 2, 0, 3)
  const expanded = [root, stack, video, first, overlap, second, gap, nested, nestedA, nestedB, audio, directA, directB]
  const lanes = otioLanes({ ...model, nodes: expanded })
  assert.deepEqual(lanes.map(lane => lane.node.id), [video, nestedA, nestedB, audio, directA, directB].map(item => item.id))
  for (const clip of [nestedA, nestedB, directA, directB]) {
    assert.deepEqual(lanes.find(lane => lane.node.id === clip.id)?.items, [clip])
  }
  assert.deepEqual(lanes[0]?.items, [first, overlap, second, gap])
})

test('outline collapse is local to the branch and IDs keep duplicate names independent', () => {
  assert.deepEqual(visibleOtioNodes(nodes, new Set([video.id])), [root, stack, video, audio])
  assert.deepEqual(visibleOtioNodes(nodes, new Set([''])), [root])
  assert.deepEqual(visibleOtioNodes(nodes, new Set()), nodes)
})
