import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireIoSources, browserIoCapabilities, listAudioInputs } from './io/adapters.ts'
import { installMobileCaptureRestriction, MOBILE_CAPTURE_UNAVAILABLE } from './io/mobile-policy.ts'
import { IoExecution } from './io/execution.ts'
import { parseIoDefinition, type IoRun } from '../../src/io/contracts.ts'

test('native capture capabilities fail closed despite browser media APIs being present', async t => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const oldSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext')
  let calls = 0
  const unsupported = () => { calls++; throw new Error('Native media API must not be touched') }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: unsupported, getDisplayMedia: unsupported, enumerateDevices: unsupported,
  } } })
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true })
  const restore = installMobileCaptureRestriction()
  t.after(() => {
    restore()
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
    if (oldSecure) Object.defineProperty(globalThis, 'isSecureContext', oldSecure)
    else Reflect.deleteProperty(globalThis, 'isSecureContext')
  })
  const capabilities = browserIoCapabilities()
  for (const id of ['microphone', 'camera', 'screen']) {
    const capability = capabilities.find(value => value.id === id)!
    assert.equal(capability.available, false)
    assert.equal(capability.reason, MOBILE_CAPTURE_UNAVAILABLE)
  }
  for (const id of ['file', 'form']) assert.equal(capabilities.find(value => value.id === id)?.available, true)
  for (const kind of ['microphone', 'camera', 'screen'] as const) {
    assert.throws(() => acquireIoSources([{ id: kind, kind, mode: 'recording' }]), /not supported by this mobile client/)
  }
  await assert.rejects(listAudioInputs(), /not supported by this mobile client/)
  assert.equal(calls, 0)
  restore()
  assert.equal(browserIoCapabilities().filter(capability => capability.available).length, 5, 'Browser behavior remains unchanged outside native mode')
})

test('native manual file selection and form input remain usable without device capture', async t => {
  const restore = installMobileCaptureRestriction()
  t.after(restore)
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const file = new File(['manual upload'], 'notes.txt', { type: 'text/plain' })
  let selected = 0
  let removed = 0
  const input = {
    type: '', accept: '', hidden: false, files: [file], onchange: undefined as (() => void) | undefined,
    click() { selected++; queueMicrotask(() => input.onchange?.()) },
    remove() { removed++ },
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag: string) { assert.equal(tag, 'input'); return input },
    body: { append() {} },
  } })
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const capture = acquireIoSources([{ id: 'upload', kind: 'file', accept: '.txt' }, { id: 'answer', kind: 'form' }])
  await capture.ready
  assert.equal(input.type, 'file')
  assert.equal(input.accept, '.txt')
  assert.equal(selected, 1)
  assert.equal(capture.streams.size, 0)
  capture.close()
  assert.equal(removed, 1)
})

test('native execution refuses capture even when a caller supplies its own acquisition adapter', async t => {
  t.after(installMobileCaptureRestriction())
  let acquired = false
  const run: IoRun = {
    version: 1, id: 'native-io', projectId: 'default', sessionId: 'web:chat', revision: 'revision',
    definition: parseIoDefinition({
      version: 1, title: 'Camera request', purpose: 'Synthetic native permission boundary',
      endpoint: 'ws://127.0.0.1:8765/io', sources: [{ id: 'camera', kind: 'camera', mode: 'recording' }],
      limits: { durationMs: 60_000, maxBytes: 1024 * 1024 }, ui: [],
    }),
    status: 'awaiting_consent', backendStatus: 'ready', createdAt: new Date().toISOString(), bytes: 0, artifacts: [],
  }
  const execution = new IoExecution({
    base: 'https://main.example', run, grant: { clientId: 'client', clientToken: 'client-token', leaseToken: 'lease-token' }, change() {},
    acquire() { acquired = true; throw new Error('Must not acquire') },
    request: async <T>() => ({ run: { ...run, status: 'failed' } }) as T,
  })
  t.after(() => execution.dispose())
  await execution.start()
  assert.equal(acquired, false)
  assert.match(execution.error, /not supported by this mobile client/)
})
