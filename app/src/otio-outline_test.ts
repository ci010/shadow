import assert from 'node:assert/strict'
import test from 'node:test'
import { otioOutlineRows } from './otio-outline.ts'
import type { OtioMarker, OtioModel, OtioNode } from './otio-model.ts'

const root: OtioNode = { id: '', name: 'Root', kind: 'Timeline', schema: 'Timeline.1', parentId: null, depth: 0, start: 0, end: 100, sourceStart: null, enabled: true }
const clip: OtioNode = { ...root, id: '/clip', name: 'Clip', kind: 'Clip', parentId: '', depth: 1 }
const markers: OtioMarker[] = Array.from({ length: 543 }, (_, i) => ({ id: `/clip/markers/${i}`, ownerId: clip.id, name: `Shot ${i}`, color: 'GREEN', comment: '', markedRange: { start: { value: i, rate: 24 }, duration: { value: 1, rate: 24 } }, start: i / 24, end: (i + 1) / 24, point: false }))
const model: OtioModel = { root, nodes: [root, clip], markers, duration: 100, rate: 24, globalStart: null, warnings: [] }

test('543 markers are outline-only children of their owner, with stable IDs for pagination', () => {
  const rows = otioOutlineRows(model, new Set())
  assert.equal(rows.length, 545)
  assert.equal(rows[2]!.marker, markers[0])
  assert.equal(rows[2]!.depth, 2)
  assert.equal(rows[2]!.node, undefined)
  assert.equal(rows.slice(500, 600).at(-1)!.id, '/clip/markers/542')
  assert.equal(model.nodes.length, 2)
})
test('collapsing an owner or ancestor hides its markers and leaves other owners independent', () => {
  assert.deepEqual(otioOutlineRows(model, new Set(['/clip'])).map(row => row.id), ['', '/clip'])
  assert.deepEqual(otioOutlineRows(model, new Set([''])).map(row => row.id), [''])
  const rootMarker = { ...markers[0]!, id: '/markers/0', ownerId: '' }
  const rows = otioOutlineRows({ ...model, markers: [rootMarker, ...markers] }, new Set(['/clip']))
  assert.deepEqual(rows.map(row => row.id), ['', '/markers/0', '/clip'])
  assert.equal(rows[1]!.depth, 1)
})
