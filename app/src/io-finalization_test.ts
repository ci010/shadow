import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IO_FINALIZE_MS } from '../../src/io/contracts.ts'
import { acquireIoSources, sourceCaptureLabel } from './io/adapters.ts'
import { withinIoFinalization } from './io/lifecycle.ts'

test('trusted source labels disclose camera microphone and OS-dependent screen audio', () => {
  assert.equal(sourceCaptureLabel({ id: 'camera', kind: 'camera' }), 'camera')
  assert.equal(sourceCaptureLabel({ id: 'camera', kind: 'camera', audio: true }), 'camera + microphone')
  assert.equal(sourceCaptureLabel({ id: 'screen', kind: 'screen', audio: true }), 'screen + system/screen audio (OS-dependent)')
})

test('draining has a bounded five-second allowance, not a new capture duration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let invoked = false
  const finish = withinIoFinalization(() => { invoked = true; return new Promise<void>(() => {}) })
  assert.equal(invoked, true)
  const failure = assert.rejects(finish, /5-second drain allowance/)
  t.mock.timers.tick(IO_FINALIZE_MS)
  await failure
})

test('successful draining clears its finalization timer', async () => {
  assert.equal(await withinIoFinalization(async () => 'saved'), 'saved')
})

test('finish stops every device immediately, before awaiting recorder final bytes', async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const recorderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder')
  let stopped = 0
  let releaseFinal!: () => void
  class Recorder {
    static isTypeSupported() { return true }
    state = 'inactive'
    ondataavailable?: (event: { data: Blob }) => void
    onstop?: () => void
    start() {
      this.state = 'recording'
      this.ondataavailable?.({ data: new Blob(['header'], { type: 'audio/webm' }) })
    }
    stop() {
      this.state = 'inactive'
      releaseFinal = () => {
        this.ondataavailable?.({ data: new Blob(['final'], { type: 'audio/webm' }) })
        this.onstop?.()
      }
    }
  }
  const track = { stop: () => { stopped++ }, getSettings: () => ({}), addEventListener() {}, removeEventListener() {} }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } } })
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder })
  try {
    const capture = acquireIoSources([{ id: 'microphone', kind: 'microphone', mode: 'recording' }])
    const chunks: string[] = []
    await capture.start(async packet => { chunks.push(atob(packet.base64!)) }, error => { throw error })
    const finishing = capture.finish()
    assert.equal(stopped, 1, 'The device must stop in the synchronous portion of finish()')
    releaseFinal()
    await finishing
    assert.deepEqual(chunks, ['header', 'final'])
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else Reflect.deleteProperty(globalThis, 'navigator')
    if (recorderDescriptor) Object.defineProperty(globalThis, 'MediaRecorder', recorderDescriptor)
    else Reflect.deleteProperty(globalThis, 'MediaRecorder')
  }
})
