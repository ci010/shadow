import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { acquireIoSources, listAudioInputs } from './io/adapters.ts'
import type { IoPacket } from '../../src/io/contracts.ts'

class Track extends EventTarget {
  kind = 'audio'
  readyState = 'live'
  stops = 0
  constructor(readonly deviceId: string, readonly sampleRate = 16_000) { super() }
  getSettings() { return { deviceId: this.deviceId, sampleRate: this.sampleRate, channelCount: 1 } }
  stop() { this.stops++; this.readyState = 'ended' }
}
class Stream {
  readonly track: Track
  failGraph = false
  constructor(id: string, sampleRate?: number, readonly level = 0.2) { this.track = new Track(id, sampleRate) }
  getTracks() { return [this.track] }
  getAudioTracks() { return [this.track] }
}
class AudioNode {
  outputs = new Set<AudioNode>()
  inputs = new Set<AudioNode>()
  channelCount = 2
  channelCountMode = 'max'
  gain = { value: 1 }
  fftSize = 256
  onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null = null
  constructor(readonly source?: Stream) {}
  connect(target: AudioNode) { this.outputs.add(target); target.inputs.add(this) }
  disconnect() { for (const target of this.outputs) target.inputs.delete(this); this.outputs.clear() }
  amplitude(): number { return this.source ? this.source.track.readyState === 'live' ? this.source.level : 0 : [...this.inputs].reduce((sum, source) => sum + source.amplitude(), 0) }
  getFloatTimeDomainData(array: Float32Array) { array.fill(this.amplitude()) }
  fire(samples: number[]) { this.onaudioprocess?.({ inputBuffer: { getChannelData: () => Float32Array.from(samples) } }) }
}
class Destination extends AudioNode {
  readonly stream = new Stream('stable-output', 48_000)
}
function environment(t: TestContext) {
  const calls: MediaStreamConstraints[] = []
  const contexts: Context[] = []
  const recorders: Recorder[] = []
  const pending: Array<{ resolve(stream: Stream): void; reject(error: Error): void }> = []
  let enumeration: MediaDeviceInfo[] = []
  let enumerationError: Error | undefined
  class Context {
    sampleRate = 48_000
    destination = new AudioNode()
    sources: AudioNode[] = []
    processors: AudioNode[] = []
    analysers: AudioNode[] = []
    destinations: Destination[] = []
    closed = false
    constructor() { contexts.push(this) }
    async resume() {}
    async close() { this.closed = true }
    createGain() { return new AudioNode() }
    createAnalyser() { const node = new AudioNode(); this.analysers.push(node); return node }
    createMediaStreamSource(stream: Stream) {
      if (stream.failGraph) throw new Error('Replacement graph failed')
      const node = new AudioNode(stream); this.sources.push(node); return node
    }
    createScriptProcessor(size: number, input: number, output: number) {
      assert.deepEqual([size, input, output], [4096, 1, 1])
      const node = new AudioNode(); this.processors.push(node); return node
    }
    createMediaStreamDestination() { const node = new Destination(); this.destinations.push(node); return node }
  }
  class Recorder {
    static isTypeSupported() { return true }
    state = 'inactive'
    starts = 0
    stops = 0
    ondataavailable?: (event: { data: Blob }) => void
    onstop?: () => void
    constructor(readonly stream: Stream) { recorders.push(this) }
    start() { this.starts++; this.state = 'recording'; this.emit('HEADER') }
    emit(text: string) { this.ondataavailable?.({ data: new Blob([text], { type: 'audio/webm' }) }) }
    stop() {
      this.stops++; this.state = 'inactive'
      queueMicrotask(() => { this.emit('FOOTER'); this.onstop?.() })
    }
  }
  const descriptors = ['navigator', 'AudioContext', 'MediaRecorder'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia(constraints: MediaStreamConstraints) {
      calls.push(constraints)
      return new Promise<Stream>((resolve, reject) => pending.push({ resolve, reject }))
    },
    async enumerateDevices() { if (enumerationError) throw enumerationError; return enumeration },
  } } })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context })
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder })
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  return { calls, contexts, recorders, pending,
    enumerate(devices: Array<{ kind: string; deviceId: string; label: string }>) { enumeration = devices as MediaDeviceInfo[] },
    enumerationFails(error: Error) { enumerationError = error },
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const source = [{ id: 'mic', kind: 'microphone' as const, mode: 'pcm' as const }]

test('listing audio inputs never requests permission and preserves browser errors', async t => {
  const env = environment(t)
  env.enumerate([
    { kind: 'audioinput', deviceId: '', label: '' },
    { kind: 'audioinput', deviceId: 'default', label: '' },
    { kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' },
    { kind: 'audiooutput', deviceId: 'speaker', label: 'Speaker' },
  ])
  assert.deepEqual(await listAudioInputs(), [{ deviceId: 'default', label: '' }, { deviceId: 'usb', label: 'USB microphone' }])
  assert.equal(env.calls.length, 0)
  const error = new DOMException('Enumeration blocked', 'NotAllowedError')
  env.enumerationFails(error)
  await assert.rejects(listAudioInputs(), failure => failure === error)
})

test('initial device selection is exact and still invokes native capture synchronously', async t => {
  const env = environment(t)
  const capture = acquireIoSources(source, { audioInputDevices: { mic: 'usb-input' } })
  try {
    assert.deepEqual(env.calls, [{ audio: { channelCount: 1, deviceId: { exact: 'usb-input' } }, video: false }])
    const stream = new Stream('actual-usb')
    env.pending[0]!.resolve(stream)
    await capture.ready
    assert.equal(capture.audioInputs?.get('mic'), 'actual-usb')
    assert.equal(env.contexts[0]!.sources.length, 0, 'No source graph processes audio before start acknowledgement')
  } finally { capture.close() }
})

test('PCM keeps one context, processor, sample rate and format while routing the selected microphone and meter', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const env = environment(t)
  const capture = acquireIoSources(source)
  const first = new Stream('built-in', 16_000, 0.2)
  env.pending[0]!.resolve(first)
  const packets: IoPacket[] = []
  const errors: Error[] = []
  try {
    await capture.start(async packet => { packets.push(packet) }, error => errors.push(error))
    const context = env.contexts[0]!
    const processor = context.processors[0]!
    processor.fire([-1, 0, 1])
    await turn()
    t.mock.timers.tick(100)
    assert.ok(Math.abs(capture.levels!.get('mic')! - 0.2) < 0.001)
    const switching = capture.switchAudioInput!('mic', 'usb')
    await turn()
    assert.equal(first.track.readyState, 'live', 'Keep current microphone while replacement permission is pending')
    const second = new Stream('usb', 44_100, 0.8)
    env.pending[1]!.resolve(second)
    await switching
    assert.deepEqual(env.calls[1], { audio: { channelCount: 1, deviceId: { exact: 'usb' } }, video: false })
    assert.equal(first.track.readyState, 'ended')
    assert.equal(second.track.readyState, 'live')
    assert.equal(context.sources[0]!.outputs.size, 0)
    assert.equal(context.sources[1]!.outputs.size, 1)
    assert.equal(env.contexts.length, 1)
    assert.equal(context.processors.length, 1)
    assert.equal(capture.audioInputs!.get('mic'), 'usb')
    processor.fire([-1, 0, 1])
    await turn()
    t.mock.timers.tick(100)
    assert.ok(Math.abs(capture.levels!.get('mic')! - 0.8) < 0.001)
    assert.equal(packets.length, 2)
    assert.deepEqual(packets[0]!.value, { sampleRate: 48_000, channels: 1, format: 's16le' })
    assert.deepEqual(packets[1]!.value, packets[0]!.value)
    assert.equal(packets[1]!.base64, packets[0]!.base64)
    assert.deepEqual([...Buffer.from(packets[0]!.base64!, 'base64')], [1, 128, 0, 0, 255, 127])
    first.track.dispatchEvent(new Event('ended'))
    assert.equal(errors.length, 0, 'Retired track events cannot terminate the replacement')
    second.track.dispatchEvent(new Event('ended'))
    assert.equal(errors.length, 1, 'Current microphone loss remains visible')
    await capture.finish()
    assert.equal(second.track.readyState, 'ended')
    assert.equal(context.closed, true)
    assert.equal(capture.levels!.get('mic'), 0)
  } finally { capture.close() }
})

test('recording switches through one stable output track without restarting or concatenating containers', async t => {
  const env = environment(t)
  const capture = acquireIoSources([{ id: 'mic', kind: 'microphone', mode: 'recording' }])
  const first = new Stream('first')
  env.pending[0]!.resolve(first)
  const chunks: string[] = []
  try {
    await capture.start(async packet => { chunks.push(atob(packet.base64!)) }, error => { throw error })
    const recorder = env.recorders[0]!
    const output = recorder.stream
    assert.notEqual(output, first)
    const switching = capture.switchAudioInput!('mic', 'second')
    await turn()
    const second = new Stream('second', 96_000)
    env.pending[1]!.resolve(second)
    await switching
    assert.equal(env.recorders.length, 1)
    assert.equal(recorder.starts, 1)
    assert.equal(recorder.stops, 0)
    assert.equal(recorder.stream, output)
    assert.equal(output.track.readyState, 'live')
    recorder.emit('AFTER_SWITCH')
    const finishing = capture.finish()
    assert.equal(second.track.readyState, 'ended')
    assert.equal(output.track.readyState, 'ended')
    await finishing
    assert.deepEqual(chunks, ['HEADER', 'AFTER_SWITCH', 'FOOTER'])
    assert.equal(recorder.stops, 1)
  } finally { capture.close() }
})

test('permission and graph failures reject without releasing or disconnecting the working microphone', async t => {
  const env = environment(t)
  const capture = acquireIoSources(source)
  const first = new Stream('first')
  env.pending[0]!.resolve(first)
  try {
    await capture.start(async () => {}, error => { throw error })
    const rejected = capture.switchAudioInput!('mic', 'denied')
    const denied = new DOMException('Permission denied', 'NotAllowedError')
    const expected = assert.rejects(rejected, error => error === denied)
    await turn(); env.pending[1]!.reject(denied); await expected
    assert.equal(first.track.readyState, 'live')
    assert.equal(capture.audioInputs!.get('mic'), 'first')
    const broken = new Stream('broken'); broken.failGraph = true
    const switching = capture.switchAudioInput!('mic', 'broken')
    const failure = assert.rejects(switching, /graph failed/)
    await turn(); env.pending[2]!.resolve(broken); await failure
    assert.equal(broken.track.readyState, 'ended')
    assert.equal(first.track.readyState, 'live')
    assert.equal(env.contexts[0]!.sources[0]!.outputs.size, 1)
  } finally { capture.close() }
})

test('latest rapid device request wins; stale granted tracks are stopped and rejected', async t => {
  const env = environment(t)
  const capture = acquireIoSources(source)
  env.pending[0]!.resolve(new Stream('original'))
  try {
    await capture.ready
    const old = capture.switchAudioInput!('mic', 'old-choice')
    const superseded = assert.rejects(old, error => error instanceof DOMException && error.name === 'AbortError')
    await turn()
    const latest = capture.switchAudioInput!('mic', 'new-choice')
    await turn()
    const next = new Stream('new-choice')
    env.pending[2]!.resolve(next); await latest
    const stale = new Stream('old-choice')
    env.pending[1]!.resolve(stale); await superseded
    assert.equal(stale.track.readyState, 'ended')
    assert.equal(next.track.readyState, 'live')
    assert.equal(capture.audioInputs!.get('mic'), 'new-choice')
  } finally { capture.close() }
})

test('cancel and Finish stop late replacements and cannot revive capture', async t => {
  const env = environment(t)
  for (const finish of [false, true]) {
    const initialIndex = env.pending.length
    const capture = acquireIoSources(source)
    const first = new Stream('original')
    env.pending[initialIndex]!.resolve(first)
    await capture.start(async () => {}, error => { throw error })
    const switching = capture.switchAudioInput!('mic', 'late')
    const failure = assert.rejects(switching, error => error instanceof DOMException && error.name === 'AbortError')
    await turn()
    if (finish) await capture.finish(); else capture.close()
    assert.equal(first.track.readyState, 'ended')
    const late = new Stream('late')
    env.pending[initialIndex + 1]!.resolve(late)
    await failure
    assert.equal(late.track.readyState, 'ended')
    const calls = env.calls.length
    await assert.rejects(capture.switchAudioInput!('mic', 'another'), /cancelled/)
    assert.equal(env.calls.length, calls)
    capture.close()
  }
})

test('empty/default selections use system default and camera/screen audio is never substituted', async t => {
  const env = environment(t)
  const capture = acquireIoSources(source, { audioInputDevices: { mic: 'default' } })
  env.pending[0]!.resolve(new Stream('system-physical'))
  try {
    await capture.ready
    assert.deepEqual(env.calls[0], { audio: { channelCount: 1 }, video: false })
    for (const id of ['', 'default']) {
      const switching = capture.switchAudioInput!('mic', id)
      await turn()
      assert.deepEqual(env.calls.at(-1), { audio: { channelCount: 1 }, video: false })
      env.pending.at(-1)!.resolve(new Stream('system-physical'))
      await switching
    }
    const calls = env.calls.length
    await assert.rejects(capture.switchAudioInput!('camera', 'usb'), /standalone microphone/)
    await assert.rejects(capture.switchAudioInput!('screen', 'usb'), /standalone microphone/)
    assert.equal(env.calls.length, calls)
    assert.throws(() => acquireIoSources([{ id: 'camera', kind: 'camera', audio: true }], { audioInputDevices: { camera: 'usb' } }), /standalone microphones/)
  } finally { capture.close() }
})

test('without Web Audio ordinary recording remains available but switching is not advertised', async t => {
  const env = environment(t)
  Reflect.deleteProperty(globalThis, 'AudioContext')
  const capture = acquireIoSources([{ id: 'mic', kind: 'microphone', mode: 'recording' }])
  const physical = new Stream('original')
  env.pending[0]!.resolve(physical)
  try {
    await capture.start(async () => {}, error => { throw error })
    assert.equal(capture.audioInputs!.size, 0)
    assert.equal(env.recorders[0]!.stream, physical)
    await assert.rejects(capture.switchAudioInput!('mic', 'another'), /Web Audio/)
    assert.equal(env.calls.length, 1)
    await capture.finish()
  } finally { capture.close() }
})

test('closing before the initial permission resolves rejects subsequent switches immediately', async t => {
  const env = environment(t)
  const capture = acquireIoSources(source)
  capture.close()
  await assert.rejects(capture.switchAudioInput!('mic', 'another'), /cancelled/)
  const late = new Stream('late-initial')
  env.pending[0]!.resolve(late)
  await assert.rejects(capture.ready, /cancelled/)
  assert.equal(late.track.readyState, 'ended')
  assert.equal(env.calls.length, 1)
})
