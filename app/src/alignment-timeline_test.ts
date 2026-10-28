import assert from 'node:assert/strict'
import test from 'node:test'
import { timelineDemoWav, timelineRange, TIMELINE_MAX_DURATION } from './alignment-timeline.ts'
import { alignmentRevision, parseAlignmentTarget } from './alignment-lab-model.ts'

test('timeline range preserves stable target ID and source-second geometry', () => {
  const target = timelineRange(1.25, 4.5, 12, 'subtitle', 'same-id', 'Caption timing')
  assert.deepEqual(parseAlignmentTarget(target), target)
  assert.equal(target.id, 'same-id')
  assert.deepEqual(target.selector, { type: 'time-range', start: 1.25, end: 4.5, duration: 12, trackId: 'subtitle' })
})
test('timeline rejects reversed, empty, unbounded and nonfinite coordinates', () => {
  for (const [a, b, d] of [[-1, 2, 12], [2, 1, 12], [1, 1, 12], [0, 13, 12], [NaN, 2, 12], [0, Infinity, 12], [0, 1, Infinity], [0, 1, TIMELINE_MAX_DURATION + 1]]) {
    assert.throws(() => timelineRange(a, b, d, 'audio', 'id', 'label'))
  }
  assert.doesNotThrow(() => timelineRange(0, TIMELINE_MAX_DURATION, TIMELINE_MAX_DURATION, 'shot', 'id', 'label'))
})
test('synthetic sample is deterministic valid PCM WAV with twelve seconds of local audio', async () => {
  const bytes = timelineDemoWav(), view = new DataView(bytes.buffer)
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF')
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE')
  assert.equal(view.getUint32(4, true), bytes.length - 8)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(40, true) / view.getUint32(28, true), 12)
  assert.deepEqual(bytes, timelineDemoWav())
  assert.equal(view.getInt16(44 + 16000 * 2 * 3.5, true), 0)
  assert.notEqual(view.getInt16(44 + 2 * 1234, true), 0)
  assert.match(await alignmentRevision(new Blob([bytes])), /^[a-f0-9]{64}$/)
})
