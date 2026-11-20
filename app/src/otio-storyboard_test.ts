import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { otioPictureAt, parseOtio } from './otio-model.ts'
import { readStoryboardDescriptions, storyboardKey, storyboardOrder } from './otio-storyboard.ts'

const schema = (kind: string, fields = {}) => ({ OTIO_SCHEMA: `${kind}.1`, ...fields })
const time = (value: number) => schema('RationalTime', { value, rate: 1 })
const item = (kind: string, name: string, duration: number, enabled = true) => schema(kind, {
  name, enabled, source_range: schema('TimeRange', { start_time: time(0), duration: time(duration) }),
})
const track = (kind: string, ...children: unknown[]) => schema('Track', { kind, children })
const model = parseOtio(JSON.stringify(schema('Timeline', { tracks: schema('Stack', { children: [
  track('Video', item('Clip', 'base', 5), item('Gap', '', 3)),
  track('Video', item('Gap', '', 1), item('Clip', 'overlay', 2), item('Clip', 'disabled', 5, false)),
  track('Audio', item('Clip', 'audio', 8)),
] }) })))
const summarize = (order: ReturnType<typeof storyboardOrder>, page = 0) => order.page(page).map(row => [row.seconds, row.node?.name])

test('storyboards split visible runs, skip per-shot gaps, and sample an exact end-exclusive grid', () => {
  assert.deepEqual(summarize(storyboardOrder(model, undefined, false)), [[0, 'base'], [1, 'overlay'], [3, 'base']])
  const interval = storyboardOrder(model, undefined, true)
  assert.deepEqual(summarize(interval), [[0, 'base'], [2, 'overlay'], [4, 'base'], [6, undefined]])
  for (const { seconds, node } of interval.page(0)) assert.equal(node, otioPictureAt(model, seconds))
  const lower = model.nodes.find(node => node.kind === 'Track')!
  assert.deepEqual(summarize(storyboardOrder(model, lower, true)), [[0, 'base'], [2, 'base'], [4, 'base'], [6, undefined]])
  assert.deepEqual(summarize(storyboardOrder(model, undefined, true, node => node.name !== 'base')), [[2, 'overlay']])
  const long = storyboardOrder({ ...model, duration: 1e9 }, undefined, true)
  assert.equal(long.count, 5e8)
  assert.equal(long.page(50000).length, 48)
  assert.deepEqual(summarize(long, long.count - 1), [[999999998, undefined]])
})

test('caption storage isolates exact document snapshots and rejects malformed data', () => {
  const base = 'https://shadow.invalid/projects/test/'
  const doc = { path: 'edit.otio', owner: { folder: 'root' }, sha256: 'a'.repeat(64) }
  const key = storyboardKey(base, doc)
  assert.ok(key)
  assert.equal(storyboardKey(base + '?secret=token', doc), key)
  assert.notEqual(storyboardKey(base, { ...doc, owner: { folder: 'other' } }), key)
  assert.notEqual(storyboardKey(base, { ...doc, sha256: 'b'.repeat(64) }), key)
  assert.equal(storyboardKey(base, { ...doc, sha256: undefined }), null)
  assert.equal(storyboardKey(base, { ...doc, owner: { session: 's', space: 'attachment' } }), null)
  assert.deepEqual([...readStoryboardDescriptions({ getItem: () => '{"/shot":"<script> is plain text"}' } as unknown as Storage, key)], [['/shot', '<script> is plain text']])
  assert.throws(() => readStoryboardDescriptions({ getItem: () => '{"/shot":42}' } as unknown as Storage, key))
})

test('local track visibility changes monitor and storyboard together without modifying tracks', () => {
  const overlay = model.nodes.filter(node => node.kind === 'Track')[1]!
  const hidden = new Set([overlay.id])
  assert.equal(otioPictureAt(model, 2, undefined, hidden)?.name, 'base')
  assert.equal(otioPictureAt(model, 2, overlay, hidden), null)
  assert.deepEqual(summarize(storyboardOrder(model, undefined, false, undefined, hidden)), [[0, 'base']])
  assert.equal(otioPictureAt(model, 2)?.name, 'overlay')
})
