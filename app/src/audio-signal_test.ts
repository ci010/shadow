import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioSignalMeter, Pcm16StreamConverter, resampleMono } from './audio-signal.ts'
const sine = (rate: number, hz: number, seconds: number, amplitude = 0.1) => Float32Array.from({ length: Math.floor(rate * seconds) }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate))
const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length)

test('conservative gate rejects zero/DC/too-short samples but keeps quiet speech-like energy', () => {
  for (const samples of [new Float32Array(3200), new Float32Array(3200).fill(.2), sine(16000, 200, .1), sine(16000, 200, .2, .0001)]) {
    const meter = new AudioSignalMeter(16000); meter.push(samples); assert.equal(meter.hasSignal, false)
  }
  for (const amplitude of [.0003, .001, .03]) {
    const meter = new AudioSignalMeter(16000); assert.ok(meter.push(sine(16000, 200, .2, amplitude)) > 0); assert.equal(meter.hasSignal, true)
  }
  const meter = new AudioSignalMeter(16000)
  const loud = meter.push(sine(16000, 200, .2, .1)), quiet = meter.push(new Float32Array(2048))
  assert.ok(quiet < loud && quiet > 0, 'meter release is smoothed')
})

test('actual-rate conversion keeps duration, speech-band tone, suppresses aliases', () => {
  for (const rate of [44100, 48000, 96000]) {
    const tone = resampleMono(sine(rate, 1000, .2), rate)
    assert.equal(tone.length, 3200)
    assert.ok(rms(tone.slice(100, -100)) > .065)
    const alias = resampleMono(sine(rate, 12000, .2), rate)
    assert.ok(rms(alias.slice(100, -100)) < .001, `alias suppressed at ${rate}`)
  }
  assert.throws(() => resampleMono(new Float32Array(1), 0))
})

test('stream conversion preserves phase/history independent of block boundaries', () => {
  for (const rate of [16000, 44100, 48000]) {
    const samples = sine(rate, 1311, .4)
    const complete = new Pcm16StreamConverter(rate).push(samples, true)
    const converter = new Pcm16StreamConverter(rate), chunks: Uint8Array[] = []
    for (let i = 0; i < samples.length; i += 137) chunks.push(converter.push(samples.slice(i, i + 137)))
    chunks.push(converter.push(new Float32Array(0), true))
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(complete))
    assert.equal(complete.length, 12800)
  }
})
