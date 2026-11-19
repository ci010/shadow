import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_OTIO_BYTES, otioPictureAt, otioSourceTime, parseOtio } from './otio-model.ts'

const t = (value: number, rate = 24) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate })
const r = (start: number, duration: number, rate = 24) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: t(start, rate), duration: t(duration, rate) })
const item = (kind: string, fields = {}) => ({ OTIO_SCHEMA: `${kind}.1`, ...fields })
const clip = (start = 0, duration = 48, fields = {}) => item('Clip', { name: 'repeated', source_range: r(start, duration), ...fields })
const track = (children: unknown[], kind = 'Video', fields = {}) => item('Track', { kind, children, source_range: null, ...fields })
const stack = (children: unknown[], fields = {}) => item('Stack', { children, source_range: null, ...fields })
const timeline = (children: unknown[], fields = {}) => item('Timeline', { tracks: stack(children), ...fields })
const parse = (value: unknown) => parseOtio(JSON.stringify(value))
const gap = (frames: number) => item('Gap', { source_range: r(0, frames) })
const transition = (head: number, tail: number) => item('Transition', { in_offset: t(head), out_offset: t(tail), transition_type: 'SMPTE_Dissolve' })

test('projects stable pointers, parallel layers, gap transparency, audio and disabled inheritance', () => {
  const model = parse(timeline([
    track([clip(0, 96)]), track([gap(24), clip()]), track([clip()], 'Audio'),
    track([clip()], 'Video', { enabled: false }),
  ]))
  assert.equal(model.duration, 4)
  assert.equal(model.root.id, '')
  assert.equal(model.nodes[1]?.parentId, '')
  assert.equal(otioPictureAt(model, 0)?.id, '/tracks/children/0/children/0')
  assert.equal(otioPictureAt(model, 1)?.id, '/tracks/children/1/children/1')
  assert.equal(otioPictureAt(model, 1)?.targetUrl, undefined) // Missing upper image still wins.
  assert.equal(otioPictureAt(model, 3)?.id, '/tracks/children/0/children/0')
  assert.equal(otioPictureAt(model, 4), null)
  assert.equal(otioPictureAt(model, NaN), null)
  assert.equal(model.nodes.find(n => n.id === '/tracks/children/2/children/0')?.trackKind, 'Audio')
  assert.equal(model.nodes.find(n => n.id === '/tracks/children/3/children/0')?.enabled, false)
})

test('ancestor trims shift nested composition contents and preserve original source range', () => {
  const model = parse(timeline([track([
    gap(24), stack([track([clip(120, 48), clip(240, 24), clip()], 'Video', { source_range: r(24, 72) })], { source_range: r(12, 30) }),
  ])]))
  const [first, second, hidden] = model.nodes.filter(node => node.kind === 'Clip')
  assert.deepEqual([first?.start, first?.end, second?.start, second?.end, hidden?.start, hidden?.end], [1, 1.5, 1.5, 2.25, 2.25, 2.25])
  assert.deepEqual(first?.sourceStart, { value: 156, rate: 24 })
  assert.deepEqual(first?.authoredRange?.start, { value: 120, rate: 24 })
  assert.deepEqual(otioSourceTime(first!, 1.25), { value: 162, rate: 24 })
  assert.equal(otioSourceTime(first!, 1.5), null)
  assert.equal(hidden?.sourceStart, null)
})

test('chooses only the active reference, preserving reference origin and mixed fractional rates', () => {
  const reference = item('ExternalReference', { target_url: 'relative.mov', available_range: r(119.88, 59.94, 29.97) })
  const model = parse(timeline([track([
    { OTIO_SCHEMA: 'Clip.2', source_range: { ...r(120, 48), duration: t(60, 30) }, media_references: { first: item('MissingReference'), active: reference }, active_media_reference_key: 'active' },
    clip(0, 0, { source_range: null, media_reference: reference }),
  ])], { global_start_time: t(599.4, 29.97) }))
  assert.deepEqual(model.globalStart, { value: 599.4, rate: 29.97 })
  assert.equal(model.rate, 29.97)
  assert.equal(model.duration, 4)
  const first = otioPictureAt(model, 0)!
  assert.equal(first.targetUrl, 'relative.mov')
  assert.equal(first.activeMediaKey, 'active')
  assert.deepEqual(first.mediaStart, { value: 119.88, rate: 29.97 })
  assert.deepEqual(otioSourceTime(first, 1), { value: 144, rate: 24 })
  const legacy = otioPictureAt(model, 2)!
  assert.equal(legacy.authoredRange, undefined)
  assert.deepEqual(legacy.sourceStart, legacy.mediaStart)
})

test('transition overlaps but does not advance cursor; compilation reports hard cut approximation', () => {
  const model = parse(timeline([track([clip(), transition(12, 6), clip()])]))
  const blend = model.nodes.find(node => node.kind === 'Transition')!
  assert.deepEqual([blend.start, blend.end, model.duration], [1.5, 2.25, 4])
  assert.deepEqual(blend.transition, { inOffset: { value: 12, rate: 24 }, outOffset: { value: 6, rate: 24 }, type: 'SMPTE_Dissolve' })
  assert.equal(otioPictureAt(model, 1.99)?.id, '/tracks/children/0/children/0')
  assert.equal(otioPictureAt(model, 2)?.id, '/tracks/children/0/children/2')
  assert.deepEqual(model.warnings, ['transition-cut'])
  const edges = parse(timeline([track([transition(12, 6), clip(), transition(6, 12)])]))
  assert.equal(edges.duration, 3)
  assert.deepEqual(edges.nodes.filter(node => node.kind === 'Transition').map(node => [node.start, node.end]), [[0, 0.25], [1.75, 2.5]])
})

test('unsupported leaves block lower images and clip effects do not fabricate a source mapping', () => {
  const model = parse(timeline([track([clip()]), track([
    item('CustomItem', { source_range: r(0, 24) }),
    clip(0, 24, { effects: [item('LinearTimeWarp', { time_scalar: 2 })] }),
  ])]))
  assert.equal(otioPictureAt(model, 0.5), null)
  const effected = otioPictureAt(model, 1.5)!
  assert.equal(effected.kind, 'Clip')
  assert.equal(otioSourceTime(effected, 1.5), null)
  assert.deepEqual(model.warnings, ['unsupported-item', 'clip-effects'])
})

test('rejects malformed or ambiguous timing and bounds structure and bytes', () => {
  assert.throws(() => parse(timeline([track([clip(0, -1)])])), /duration.*RationalTime/)
  assert.throws(() => parse(timeline([track([clip()])], { global_start_time: t(0, 1e308) })), /frame count/)
  assert.throws(() => parse(timeline([track([clip(0, 24, { source_range: r(0, 24, 0) })])])), /RationalTime/)
  assert.throws(() => parse(timeline([track([clip(0, 24, { source_range: null })])])), /no source or available range/)
  assert.throws(() => parse(timeline([track([clip(0, 24, { media_references: {}, active_media_reference_key: 'missing' })])])), /active media reference key/)
  assert.throws(() => parse(timeline([track([transition(6, 6)], 'Video', { effects: [item('FreezeFrame')] })])), /composition effects/)
  let nested: unknown = clip()
  for (let i = 0; i < 65; i++) nested = stack([nested])
  assert.throws(() => parse(timeline([nested])), /structure limit/)
  assert.throws(() => parse(timeline([track(Array.from({ length: 20_000 }, () => gap(0)))])), /structure limit/)
  assert.throws(() => parseOtio('中'.repeat(Math.ceil(MAX_OTIO_BYTES / 3))), /input exceeds/)
})


test('same-rate integer frame cuts and exclusive end use the frame-domain cursor', () => {
  const model = parse(timeline([track([
    clip(0, 0, { source_range: r(100, 1, 10) }),
    clip(0, 0, { source_range: r(200, 2, 10) }),
    clip(0, 0, { source_range: r(300, 4, 10) }),
  ])]))
  const [first, middle, last] = model.nodes.filter(node => node.kind === 'Clip')
  assert.equal(first?.end, 1 / 10)
  assert.equal(middle?.end, 3 / 10)
  assert.equal(last?.start, 3 / 10)
  assert.equal(otioPictureAt(model, 3 / 10), last)
  assert.deepEqual(otioSourceTime(last!, 3 / 10), { value: 300, rate: 10 })
  assert.equal(otioSourceTime(middle!, 3 / 10), null)
  assert.equal(otioPictureAt(model, 7 / 10), null)
  assert.equal(otioSourceTime(last!, 7 / 10), null)
})

test('mixed fractional rates tolerate boundary round-off without rounding a real subframe clip away', () => {
  const rate = 29.97
  const model = parse(timeline([track([
    clip(0, 0, { source_range: r(100, 1, rate) }),
    clip(0, 0, { source_range: r(200, 4, 2 * rate) }),
    clip(0, 0, { source_range: r(300, 1e-8, rate) }),
    clip(0, 0, { source_range: r(400, 4, rate) }),
  ])], { global_start_time: t(0, rate) }))
  const [, middle, tiny, last] = model.nodes.filter(node => node.kind === 'Clip')
  assert.equal(otioPictureAt(model, 3 / rate), tiny)
  assert.deepEqual(otioSourceTime(tiny!, 3 / rate), { value: 300, rate })
  assert.equal(otioSourceTime(middle!, 3 / rate), null)
  assert.equal(otioPictureAt(model, (3 + 0.5e-8) / rate), tiny)
  assert.equal(otioPictureAt(model, (3 + 1e-8) / rate), last)
  assert.equal(otioPictureAt(model, (7 + 1e-8) / rate), null)
})

test('long one-frame sequence does not drift off the display frame grid', () => {
  const rate = 29.97
  const count = 10_000
  const model = parse(timeline([track(Array.from({ length: count }, (_, i) =>
    clip(0, 0, { source_range: r(100 + i, 1, rate) }))) ]))
  const last = model.nodes[model.nodes.length - 1]!
  const n = last.start * rate
  assert.ok(Math.abs(n - (count - 1)) <= 4 * Number.EPSILON * Math.max(1, Math.abs(n)))
  assert.equal(last.start, (count - 1) / rate)
  assert.equal(otioPictureAt(model, (count - 1) / rate), last)
  assert.deepEqual(otioSourceTime(last, (count - 1) / rate), { value: count + 99, rate })
  assert.equal(otioPictureAt(model, count / rate), null)
})


test('null global start uses a visual clip rate rather than earlier audio samples or gap units', () => {
  const audio = track([clip(0, 0, { source_range: r(48000, 96000, 48000) })], 'Audio')
  const coarseGap = item('Gap', { source_range: r(0, 1, 1) })
  const video = track([coarseGap, clip(0, 0, { source_range: r(48, 48, 23.976) })])
  const model = parse(timeline([audio, video], { global_start_time: null }))
  assert.equal(model.globalStart, null)
  assert.equal(model.rate, 23.976)
  assert.deepEqual(model.nodes.filter(node => node.kind === 'Clip' || node.kind === 'Gap')
    .map(node => node.authoredRange?.duration.rate), [48000, 1, 23.976])
  assert.equal(parse(timeline([audio], { global_start_time: null })).rate, 24)
  assert.equal(parse(timeline([video], { global_start_time: t(0, 30) })).rate, 30)
  assert.equal(parse(item('Timeline', { tracks: stack([audio, video], { source_range: r(0, 50, 25) }) })).rate, 25)
})
