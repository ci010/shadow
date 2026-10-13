import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { recordMicrophone, prepareMicrophone, NoAudioSignalError } from './audio-input.ts'
import { createMediaCaptureApi } from '../../desktop/src/media-capture-preload.ts'
import { MEDIA_CAPTURE_CHANNELS } from '../../desktop/src/media-capture-contract.ts'

test('worklet batches mono PCM, downmixes, flushes tail and never writes playback', () => {
  const messages: { samples?: Float32Array; stopped?: boolean }[] = []
  let Processor: any
  vm.runInNewContext(readFileSync(new URL('./audio-capture-worklet.js', import.meta.url), 'utf8'), {
    Float32Array, AudioWorkletProcessor: class { port = { postMessage: (data: any) => messages.push(data), onmessage: undefined } },
    registerProcessor: (_name: string, ctor: any) => { Processor = ctor },
  })
  const processor = new Processor()
  const a = new Float32Array(128).fill(.2), b = new Float32Array(128).fill(.4)
  for (let i = 0; i < 17; i++) assert.equal(processor.process([[a, b]]), true)
  assert.equal(messages.length, 1); assert.equal(messages[0]!.samples!.length, 2048)
  assert.ok(Math.abs(messages[0]!.samples![0]! - .3) < 1e-6)
  processor.port.onmessage({ data: 'stop' })
  assert.equal(messages[1]!.samples!.length, 128); assert.equal(messages[2]!.stopped, true)
  assert.equal(processor.process([[a]]), false)
})

function mockCapture(t: import('node:test').TestContext, worklet: 'supported' | 'failed' | undefined = undefined) {
  const originals = { window: globalThis.window, navigator: globalThis.navigator, AudioContext: globalThis.AudioContext, AudioWorkletNode: globalThis.AudioWorkletNode }
  let acquisitions = 0, resumes = 0, stops = 0, closes = 0, legacy = 0, moduleUrl = '', processor: any
  let resolve: ((stream: any) => void) | undefined
  const stream = { getTracks: () => [{ stop: () => stops++ }] }
  const context = class {
    audioWorklet = worklet ? { addModule: async (url: string) => { moduleUrl = url; if (worklet === 'failed') throw new Error('unsupported') } } : undefined
    sampleRate = 48000
    destination = {}
    resume = async () => { resumes++ }
    close = async () => { closes++ }
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} })
    createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} })
    createScriptProcessor = () => { legacy++; processor = { connect() {}, disconnect() {}, onaudioprocess: undefined }; return processor }
  }
  const node = class {
    port = { onmessage: undefined as ((event: any) => void) | undefined, close() {}, postMessage: (_message: string) => { this.port.onmessage?.({ data: { stopped: true } }) } }
    constructor() { processor = this }
    connect() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => { acquisitions++; return new Promise(r => { resolve = r }) } } } })
  Object.assign(globalThis, { window: { AudioContext: context }, AudioContext: context, AudioWorkletNode: worklet ? node : undefined })
  t.after(() => { Object.assign(globalThis, { window: originals.window, AudioContext: originals.AudioContext, AudioWorkletNode: originals.AudioWorkletNode }); Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originals.navigator }) })
  return { permit: () => resolve!(stream), stats: () => ({ acquisitions, resumes, stops, closes, legacy, moduleUrl }), feed: (samples: Float32Array) => processor.port ? processor.port.onmessage({ data: { samples } }) : processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } }) }
}
const settle = () => new Promise(r => setImmediate(r))

test('pending permission cancellation stops late tracks and releases context', async t => {
  const env = mockCapture(t), abort = new AbortController()
  const pending = recordMicrophone(abort.signal)
  await settle(); abort.abort(); env.permit()
  await assert.rejects(pending, /abort/i)
  assert.ok(env.stats().stops >= 1); assert.equal(env.stats().closes, 1)
})

test('fallback measures actual-rate PCM and gate stops digital silence before upload', async t => {
  const env = mockCapture(t), levels: number[] = []
  const pending = recordMicrophone(undefined, { onLevel: level => levels.push(level) }); await settle(); env.permit()
  const capture = await pending
  env.feed(new Float32Array(9600))
  await assert.rejects(capture.stop(), NoAudioSignalError)
  assert.equal(env.stats().stops, 1); assert.equal(levels.at(-1), 0)
})

test('quiet PCM fallback produces 16k WAV without throwing away valid low levels', async t => {
  const env = mockCapture(t), levels: number[] = []
  const pending = recordMicrophone(undefined, { onLevel: level => levels.push(level) }); await settle(); env.permit()
  const capture = await pending
  env.feed(Float32Array.from({ length: 9600 }, (_, i) => .0004 * Math.sin(i / 10)))
  const wav = await capture.stop(), bytes = new DataView(await wav.arrayBuffer())
  assert.equal(bytes.getUint32(24, true), 16000); assert.equal(wav.size, 6444)
  assert.ok(levels.some(level => level > 0)); assert.equal(env.stats().stops, 1)
})

test('preferred worklet flushes supported host; failed module uses existing PCM fallback', async t => {
  for (const mode of ['supported', 'failed'] as const) await t.test(mode, async t => {
    const env = mockCapture(t, mode)
    const pending = recordMicrophone(); await settle(); env.permit()
    const capture = await pending
    env.feed(Float32Array.from({ length: 9600 }, (_, i) => .01 * Math.sin(i / 10)))
    const wav = await capture.stop()
    assert.equal(wav.size, 6444)
    assert.equal(env.stats().legacy, mode === 'supported' ? 0 : 1)
    assert.match(env.stats().moduleUrl, /audio-capture-worklet\.js\?no-inline$/)
    assert.equal(env.stats().stops, 1); assert.equal(env.stats().closes, 1)
  })
})

test('capture retains at most sixty seconds even if a browser delivers oversized blocks', async t => {
  const env = mockCapture(t), sizes: number[] = []
  const pending = recordMicrophone(undefined, { onSamples: samples => sizes.push(samples.length) }); await settle(); env.permit()
  const capture = await pending
  env.feed(new Float32Array(48000 * 61)); env.feed(new Float32Array(48000))
  assert.deepEqual(sizes, [48000 * 60]); capture.cancel(); assert.equal(env.stats().stops, 1)
})


test('gesture-time reservation uses real preload arm route before hold delay; no tracks until threshold', async t => {
  for (const kind of ['click', 'pointer', 'keyboard']) await t.test(kind, async t => {
    const env = mockCapture(t), calls: unknown[][] = []
    let trustedGesture = true
    window.shadowDesktop = { mediaCapture: createMediaCaptureApi({ invoke: async (...args) => { calls.push(args); return { expiresAt: Date.now() + 65_000 } } }, () => false, () => { const value = trustedGesture; trustedGesture = false; return value }) } as any
    const prepared = prepareMicrophone()
    assert.equal(calls[0]?.[0], MEDIA_CAPTURE_CHANNELS.arm)
    assert.equal(env.stats().resumes, 1, 'resume during gesture, not after threshold')
    await settle()
    assert.equal(env.stats().acquisitions, 0, 'reservation never opens microphone')
    const pending = recordMicrophone(undefined, {}, prepared)
    await settle(); assert.equal(env.stats().acquisitions, 1); env.permit()
    const capture = await pending; capture.cancel(); await settle()
    assert.equal(env.stats().stops, 1)
    assert.ok(calls.some(call => call[0] === MEDIA_CAPTURE_CHANNELS.revoke))
  })
})
test('short/cancelled or expired gesture reservation cannot acquire, replay or leave a late grant', async t => {
  const env = mockCapture(t), calls: unknown[][] = []
  let grantAck: ((value: { expiresAt: number }) => void) | undefined
  window.shadowDesktop = { mediaCapture: createMediaCaptureApi({ invoke: (...args) => {
    calls.push(args)
    return args[0] === MEDIA_CAPTURE_CHANNELS.arm ? new Promise(resolve => { grantAck = resolve as any }) : Promise.resolve(undefined)
  } }, () => true) } as any
  const short = prepareMicrophone(); short.cancel(); grantAck!({ expiresAt: Date.now() + 65_000 }); await settle()
  await assert.rejects(recordMicrophone(undefined, {}, short), /cancelled/)
  assert.equal(env.stats().acquisitions, 0)
  assert.ok(calls.filter(call => call[0] === MEDIA_CAPTURE_CHANNELS.revoke).length >= 2, 'revoke both pending and acknowledged grant')
  const expired = prepareMicrophone(); grantAck!({ expiresAt: Date.now() - 1 })
  await assert.rejects(recordMicrophone(undefined, {}, expired), /expired/)
  assert.equal(env.stats().acquisitions, 0)
  const stale = prepareMicrophone(); grantAck!({ expiresAt: Date.now() + 65_000 }); await stale.claim()
  await assert.rejects(recordMicrophone(undefined, {}, stale), /cancelled/)
  assert.equal(env.stats().acquisitions, 0)
})
test('aborted signal disposes a prepared gesture without microphone acquisition', async t => {
  const env = mockCapture(t), controller = new AbortController(), prepared = prepareMicrophone()
  controller.abort()
  await assert.rejects(recordMicrophone(controller.signal, {}, prepared), /abort/i)
  assert.equal(env.stats().acquisitions, 0); assert.equal(env.stats().closes, 1)
})
