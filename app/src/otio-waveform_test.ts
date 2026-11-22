import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeOtioWave, MAX_WAVE_BYTES, otioWavePath, readOtioWave } from './otio-waveform.ts'

function stereoWave() {
  const frames = 800, rate = 800
  const bytes = Buffer.alloc(44 + frames * 4)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40)
  for (const [frame, left, right] of [[199, -32768, 0], [200, 4096, -16384], [399, 0, 8192], [400, 0, -8192], [799, 16384, 0]]) {
    bytes.writeInt16LE(left, 44 + frame * 4)
    bytes.writeInt16LE(right, 46 + frame * 4)
  }
  return bytes
}

test('trimmed peaks include both channels, exact boundaries, and real silence', () => {
  const wave = decodeOtioWave(stereoWave())!
  assert.deepEqual(wave.peaks(0.25, 0.25, 4), [0.5, 0, 0, 0.25])
  assert.deepEqual(wave.peaks(-0.25, 0.5, 4), [0, 0, 0, 1])
  assert.deepEqual(wave.peaks(0.75, 0.5, 2), [0.5, 0])
  assert.equal(otioWavePath(wave.peaks(0.25, 0.25, 4)), 'M0.5 6.00v12.00M3.5 9.00v6.00')
  assert.equal(otioWavePath([0, 0, 0]), '')
})

test('not a WAV, truncated WAV, and unsupported WAV are not graphed', () => {
  const bytes = stereoWave()
  assert.equal(decodeOtioWave(bytes.subarray(0, -1)), null)
  assert.equal(decodeOtioWave(new Uint8Array(32)), null)
  bytes.writeUInt16LE(6, 20)
  assert.equal(decodeOtioWave(bytes), null)
})

test('wave reader cancels oversized and inaccessible bodies, including streams without a length', async t => {
  const abort = new AbortController()
  for (const [status, declared, chunk] of [[200, MAX_WAVE_BYTES + 1, 0], [200, 0, MAX_WAVE_BYTES + 1], [403, 0, 0]]) {
    let cancelled = false
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(chunk)) }, cancel() { cancelled = true } })
    const request = t.mock.method(globalThis, 'fetch', async () => new Response(stream, {
      status, headers: declared ? { 'Content-Length': String(declared) } : {},
    }))
    try {
      assert.equal(await readOtioWave('https://fixture.invalid/admitted.wav', abort.signal), null)
      assert.equal(cancelled, true)
      assert.equal(request.mock.calls[0].arguments[1]?.redirect, 'error')
    } finally { request.mock.restore() }
  }
})
