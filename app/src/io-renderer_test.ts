import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { IO_MAX_CHUNK_BYTES, parseIoDefinition, type IoRelayEffect, type IoRelayUpdate, type IoRun } from '../../src/io/contracts.ts'
import { acquireIoSources, type CaptureSet } from './io/adapters.ts'
import { IoExecution, playableMime, validateIoNodes, type IoExecutionOptions } from './io/execution.ts'
import { desktopCapabilities, desktopSourceIssue } from './io/desktop.ts'
import { decodeOutput, encodeBytes, IoBudget, ResourceScope } from './io/transport.ts'

const definition = () => parseIoDefinition({
  version: 1, title: 'Fixture', purpose: 'Synthetic I/O lifecycle test',
  endpoint: 'ws://127.0.0.1:8765/io', sources: [{ id: 'input', kind: 'form' }],
  limits: { durationMs: 60_000, maxBytes: 1024 * 1024 }, ui: [],
})
const run = (): IoRun => ({
  version: 1, id: 'fixture-run', projectId: 'default', sessionId: 'fixture-session',
  revision: 'fixture-revision', definition: definition(), status: 'awaiting_consent', backendStatus: 'ready',
  createdAt: new Date().toISOString(), bytes: 0, artifacts: [],
})
const grant = { clientId: 'client', clientToken: 'client-token', leaseToken: 'lease-token' }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

function fixture(extra: Partial<IoExecutionOptions> = {}) {
  const events: string[] = []
  const snapshot = structuredClone(extra.run ?? run())
  const updates: IoRelayUpdate[] = []
  let ack!: () => void
  let deny!: (error: Error) => void
  let reset = false
  const startAck = new Promise<void>((resolve, reject) => { ack = resolve; deny = reject })
  const capture: CaptureSet = {
    ready: Promise.resolve(), streams: new Map(),
    start: async () => { events.push('capture-start') },
    finish: async () => { events.push('capture-finish') },
    close: () => { events.push('capture-close') },
  }
  const execution = new IoExecution({
    base: 'http://localhost:3000/projects/default/', run: snapshot, grant, change() {},
    acquire: () => { events.push('acquire-gesture'); return capture },
    eventRequest: async (_url, init) => {
      const { event } = JSON.parse(String(init?.body))
      events.push(`event:${event.type}`)
      if (event.type === 'end') snapshot.status = 'stopping'
      return Response.json({ accepted: true })
    },
    request: async <T>(_base: string, path: string, body?: unknown) => {
      events.push(path)
      if (path.endsWith('/start')) { await startAck; snapshot.status = 'running'; return { run: structuredClone(snapshot) } as T }
      if (path.endsWith('/stop')) {
        const status = (body as { status: IoRun['status'] }).status
        snapshot.status = status === 'completed' ? 'stopping' : status
        snapshot.error = (body as { error?: string }).error
        return { run: structuredClone(snapshot) } as T
      }
      if (path.includes('/updates?')) {
        const cursor = Number(path.split('after=')[1])
        return { updates: structuredClone(reset ? updates : updates.filter(update => update.sequence > cursor)), cursor: updates.at(-1)?.sequence ?? 0, reset } as T
      }
      if (path.endsWith('/heartbeat')) return { ok: true } as T
      return structuredClone(snapshot) as T
    },
    ...extra,
  })
  function effect(method: IoRelayEffect['method'], args: unknown[]) {
    updates.push({ sequence: updates.length + 1, effect: { method, args } })
    if (method === 'ui.render') snapshot.ui = args[0] as IoRun['ui']
    if (method === 'status') snapshot.message = args[0] as string
    if (method === 'artifact') snapshot.artifacts.push(args[0] as IoRun['artifacts'][number])
  }
  return { execution, events, snapshot, ack, deny, effect, reset: () => { reset = true } }
}

test('input budget rejects overflow and invalid counts; binary preview decoding remains bounded', () => {
  const budget = new IoBudget(1024)
  budget.consume(1024)
  for (const bytes of [1, NaN, -1]) assert.throws(() => budget.consume(bytes), /budget/)
  const bytes = new Uint8Array(IO_MAX_CHUNK_BYTES).fill(231)
  assert.deepEqual(decodeOutput({ mime: 'application/octet-stream', base64: encodeBytes(bytes) }).bytes, bytes)
  assert.throws(() => decodeOutput({ mime: 'text/plain', text: 'a', base64: 'YQ==' }))
  assert.throws(() => decodeOutput({ mime: 'text/plain', base64: 'not base64!' }))
  assert.throws(() => decodeOutput({ mime: 'text/plain', base64: 'YR==' }), /canonical/)
  assert.equal(decodeOutput({ mime: 'text/plain', text: '' }).bytes.byteLength, 0)
  assert.throws(() => decodeOutput({ mime: 'text/plain', text: 'あ'.repeat(IO_MAX_CHUNK_BYTES / 2) }), /chunk/)
})

test('resource cleanup is idempotent and immediately releases late permissions', () => {
  const scope = new ResourceScope()
  const order: number[] = []
  scope.add(() => { order.push(1) }); scope.add(() => { order.push(2); throw new Error('cleanup failed') })
  scope.close(); scope.close(); scope.add(() => { order.push(3) })
  assert.deepEqual(order, [2, 1, 3])
})

test('late browser grant is stopped after owning capture was cancelled', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let release!: (stream: MediaStream) => void
  const media = new Promise<MediaStream>(resolve => { release = resolve })
  let stopped = 0
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => media } } })
  try {
    const capture = acquireIoSources([{ id: 'mic', kind: 'microphone', mode: 'recording' }])
    capture.close()
    release({ getTracks: () => [{ stop: () => { stopped++ } }] } as unknown as MediaStream)
    await assert.rejects(capture.ready, /cancelled/)
    assert.equal(stopped, 1)
  } finally { if (original) Object.defineProperty(globalThis, 'navigator', original); else Reflect.deleteProperty(globalThis, 'navigator') }
})

test('recorder final data preserves ordering while Finish stops tracks synchronously', async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const recording = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder')
  let stopped = 0
  class FakeRecorder {
    static isTypeSupported() { return true }
    state = 'inactive'
    ondataavailable?: (event: { data: Blob }) => void
    onstop?: () => void
    start() { this.state = 'recording'; this.ondataavailable?.({ data: new Blob(['header'], { type: 'audio/webm' }) }) }
    stop() {
      this.state = 'inactive'
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['footer'], { type: 'audio/webm' }) }); this.onstop?.() })
    }
  }
  const track = { stop: () => { stopped++ }, getSettings: () => ({}), addEventListener() {}, removeEventListener() {} }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } } })
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeRecorder })
  try {
    const capture = acquireIoSources([{ id: 'mic', kind: 'microphone', mode: 'recording' }])
    const chunks: string[] = []
    await capture.start(async packet => { chunks.push(atob(packet.base64!)) }, error => { throw error })
    const finished = capture.finish()
    assert.ok(stopped > 0)
    await finished
    assert.deepEqual(chunks, ['header', 'footer'])
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav); else Reflect.deleteProperty(globalThis, 'navigator')
    if (recording) Object.defineProperty(globalThis, 'MediaRecorder', recording); else Reflect.deleteProperty(globalThis, 'MediaRecorder')
  }
})

test('backend UI rejects raw URLs, DOM attributes, invalid sources and oversized trees', () => {
  assert.deepEqual(validateIoNodes([{ id: 'button', type: 'button', text: '<script>plain text</script>' }], new Set()), [{ id: 'button', type: 'button', text: '<script>plain text</script>' }])
  assert.throws(() => validateIoNodes([{ id: 'image', type: 'media', src: 'https://example.test/' }], new Set()))
  assert.throws(() => validateIoNodes([{ id: 'button', type: 'button', onclick: 'alert(1)' }], new Set()))
  assert.throws(() => validateIoNodes([{ id: 'camera', type: 'media', sourceId: 'missing' }], new Set()), /undeclared/)
  assert.throws(() => validateIoNodes(Array.from({ length: 257 }, (_, i) => ({ id: `node${i}`, type: 'text' })), new Set()))
  assert.equal(playableMime('image/svg+xml'), undefined)
  assert.equal(playableMime('text/html'), undefined)
  assert.equal(playableMime('video/webm;codecs=vp8,opus'), 'video')
})

test('prepared connection receives asynchronous views without acquiring devices', async () => {
  const f = fixture()
  try {
    assert.deepEqual([...f.events], [])
    f.effect('ui.render', [[{ id: 'ready', type: 'text', text: 'Connected service' }]])
    f.execution.connect(); await turn()
    assert.equal(f.execution.phase, 'ready')
    assert.equal(f.execution.nodes[0]?.text, 'Connected service')
    assert.ok(!f.events.includes('acquire-gesture'))
    assert.ok(!f.events.includes('event:start'))
  } finally { f.execution.dispose() }
})

test('Start acquires in human gesture before backend RPC; capture starts only after ACK', async () => {
  const f = fixture()
  try {
    const starting = f.execution.start()
    assert.deepEqual(f.events, ['acquire-gesture', '/runs/fixture-run/start'])
    await turn(); assert.equal(f.execution.phase, 'starting')
    f.ack(); await starting
    assert.deepEqual(f.events.slice(2), ['event:start', 'capture-start'])
    assert.equal(f.execution.phase, 'recording')
  } finally { f.execution.dispose() }
})

test('backend denial releases devices without consuming source data', async () => {
  const f = fixture()
  const starting = f.execution.start()
  f.deny(new Error('Revision or lease denied')); await starting
  assert.ok(f.events.includes('capture-close'))
  assert.ok(!f.events.includes('capture-start'))
  assert.equal(f.execution.phase, 'closed')
})

test('capture failures preserve their named diagnostic in the persisted run', async () => {
  for (const [name, status] of [['NotAllowedError', 'denied'], ['NotReadableError', 'failed']] as const) {
    const f = fixture({ acquire: () => { throw new DOMException('Synthetic device acquisition failure', name) } })
    try {
      await f.execution.start()
      assert.equal(f.execution.run.status, status)
      assert.equal(f.snapshot.error, `${name}: Synthetic device acquisition failure`)
      assert.equal(f.execution.run.error, f.snapshot.error)
      assert.equal(f.execution.error, f.snapshot.error)
      assert.ok(!f.events.includes('event:start'))
    } finally { f.execution.dispose() }
  }
})

test('long capture errors are bounded before transport and stop failures remain visible', async () => {
  const f = fixture()
  await f.execution.fail(new Error('x'.repeat(3000)))
  assert.equal(f.snapshot.error?.length, 2000)
  assert.equal(f.execution.error, f.snapshot.error)
  f.execution.dispose()

  const offline = fixture({ request: async () => { throw new Error('Synthetic offline') } })
  try {
    await offline.execution.fail(new Error('Original capture error'))
    assert.equal(offline.execution.run.error, 'Original capture error')
    assert.match(offline.execution.notice, /server could not confirm the stop: Synthetic offline/)
    assert.equal(offline.execution.phase, 'closed')
  } finally { offline.execution.dispose() }
})

test('device rejection is reported without waiting for a pending backend Start', async () => {
  let reject!: (error: Error) => void
  let closed = false
  const ready = new Promise<void>((_resolve, fail) => { reject = fail })
  const f = fixture({ acquire: () => ({
    ready, streams: new Map(), start: async () => {}, finish: async () => {},
    close: () => { closed = true },
  }) })
  const starting = f.execution.start()
  try {
    reject(new DOMException('Synthetic device denied before backend ACK', 'NotAllowedError'))
    await turn()
    assert.equal(f.execution.phase, 'closed')
    assert.equal(closed, true)
    assert.equal(f.snapshot.status, 'denied')
    assert.equal(f.snapshot.error, 'NotAllowedError: Synthetic device denied before backend ACK')
    f.ack()
    await starting
    assert.equal(f.execution.run.status, 'denied')
    assert.ok(!f.events.includes('event:start'))
  } finally { f.ack(); await starting; f.execution.dispose() }
})

test('cancellation during Start cannot be revived by a late ACK', async () => {
  const f = fixture()
  const starting = f.execution.start()
  await f.execution.cancel(); f.ack(); await starting
  assert.ok(!f.events.includes('capture-start'))
  assert.equal(f.execution.phase, 'closed')
  await assert.rejects(f.execution.start())
})

test('device selection reaches capture without resetting the run, deadline or input budget', async () => {
  const snapshot = run()
  snapshot.definition.sources = [{ id: 'mic', kind: 'microphone', mode: 'pcm' }]
  let initial: Readonly<Record<string, string>> | undefined
  const changes: string[] = []
  const f = fixture({
    run: snapshot,
    acquire: (_sources, options) => {
      initial = options?.audioInputDevices
      return { ready: Promise.resolve(), streams: new Map(), start: async () => {}, finish: async () => {}, close() {},
        switchAudioInput: async (id, device) => { changes.push(`${id}:${device}`) } }
    },
  })
  try {
    await assert.rejects(f.execution.switchAudioInput('mic', 'usb'), /active capture/)
    f.ack(); await f.execution.start({ mic: 'initial-usb' })
    assert.deepEqual(initial, { mic: 'initial-usb' })
    const startedAt = f.execution.run.startedAt
    f.execution.budget.consume(100)
    await f.execution.switchAudioInput('mic', 'other-usb')
    assert.deepEqual(changes, ['mic:other-usb'])
    assert.equal(f.execution.run.startedAt, startedAt)
    assert.equal(f.execution.budget.bytes, 100)
    assert.equal(f.events.filter(event => event === 'event:start').length, 1)
    await assert.rejects(f.execution.switchAudioInput('unknown', 'usb'), /Unknown input source/)
    await f.execution.finish()
    await assert.rejects(f.execution.switchAudioInput('mic', 'usb'), /active capture/)
  } finally { f.execution.dispose() }
})

test('asynchronous results arrive after ACK; Finish remains Processing until backend Done', async () => {
  const f = fixture()
  try {
    f.ack(); await f.execution.start()
    await f.execution.event({ type: 'ui', id: 'submit', value: 'hello' })
    assert.equal(Boolean(f.execution.preview), false)
    f.effect('preview', [{ mime: 'text/plain', text: 'Later response' }])
    f.effect('ui.render', [[{ id: 'table', type: 'table', rows: [['Result', '42']] }]])
    await f.execution.refresh(true)
    assert.equal(f.execution.preview?.text, 'Later response')
    assert.equal(f.execution.nodes[0]?.type, 'table')
    await f.execution.finish()
    assert.ok(f.events.indexOf('capture-finish') < f.events.indexOf('event:end'))
    assert.ok(f.events.indexOf('event:end') < f.events.indexOf('/runs/fixture-run/stop'))
    assert.equal(f.execution.phase, 'processing')
    assert.equal(f.execution.run.status, 'stopping')
    f.effect('status', ['Final report is ready'])
    f.effect('artifact', [{ id: 'report', name: 'report.txt', mime: 'text/plain', size: 42, complete: true }])
    f.effect('preview', [{ mime: 'text/plain', text: 'Final preview' }])
    f.snapshot.status = 'completed'
    await f.execution.refresh(true)
    assert.equal(f.execution.phase, 'closed')
    assert.equal(f.execution.run.status, 'completed')
    assert.equal(f.execution.run.artifacts[0]?.name, 'report.txt')
    assert.equal(f.execution.preview?.text, 'Final preview')
    assert.equal(f.execution.run.message, 'Final report is ready')
  } finally { f.execution.dispose() }
})

test('backend early Done releases active capture without sending another stop', async () => {
  const f = fixture()
  f.ack(); await f.execution.start()
  f.snapshot.status = 'completed'
  await f.execution.refresh(true)
  assert.equal(f.execution.phase, 'closed')
  assert.ok(f.events.includes('capture-close'))
  assert.ok(!f.events.includes('/runs/fixture-run/stop'))
})

test('capture duration stops devices and enters Processing, rather than ending backend work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const snapshot = run(); snapshot.definition.limits.durationMs = 1000
  const f = fixture({ run: snapshot })
  try {
    f.ack(); await f.execution.start()
    t.mock.timers.tick(1000)
    assert.ok(f.events.includes('capture-finish'))
    await f.execution.finish()
    assert.equal(f.execution.phase, 'processing')
    assert.deepEqual(f.events.filter(event => event.startsWith('event:')), ['event:start', 'event:end'])
  } finally { f.execution.dispose() }
})

test('Finish while backend Start ACK is pending never restarts closed capture', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = fixture({ eventRequest: async (_url, init) => {
    if (JSON.parse(String(init?.body)).event.type === 'start') await gate
    return Response.json({ accepted: true })
  } })
  try {
    f.ack(); const starting = f.execution.start()
    await turn()
    const finishing = f.execution.finish()
    release(); await Promise.all([starting, finishing])
    assert.ok(!f.events.includes('capture-start'))
    assert.equal(f.execution.phase, 'processing')
  } finally { f.execution.dispose() }
})

test('failed update transport releases devices and never silently reconnects', async () => {
  let calls = 0
  const f = fixture({ request: async <T>(_base: string, path: string) => {
    calls++
    if (path.endsWith('/start')) return { run: { ...run(), status: 'running' } } as T
    if (path.endsWith('/stop')) return { run: { ...run(), status: 'failed' } } as T
    throw new Error('Local service disconnected')
  } })
  await f.execution.start()
  await f.execution.refresh(true)
  assert.equal(f.execution.phase, 'closed')
  assert.ok(f.events.includes('capture-close'))
  assert.match(f.execution.error, /disconnected/)
  const stoppedAt = calls
  await f.execution.refresh(true)
  assert.equal(calls, stoppedAt)
})

test('lease heartbeat continues while processing', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  try {
    f.execution.connect(); await turn()
    f.ack(); await f.execution.start(); await f.execution.finish()
    assert.equal(f.execution.phase, 'processing')
    t.mock.timers.tick(5000); await turn()
    assert.ok(f.events.includes('/runs/fixture-run/heartbeat'))
  } finally { f.execution.dispose() }
})

test('file sources send bounded metadata, including an empty chosen file', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const file = new File([], 'empty.txt', { type: 'text/plain' })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    body: { append() {} },
    createElement: () => {
      const input = { files: [file], onchange: undefined as (() => void) | undefined, click() { queueMicrotask(() => input.onchange?.()) }, remove() {} }
      return input
    },
  } })
  try {
    const capture = acquireIoSources([{ id: 'file', kind: 'file' }])
    const packets: unknown[] = []
    await capture.start(async packet => { packets.push(packet) }, error => { throw error })
    await capture.finish()
    assert.equal(packets.length, 1)
    assert.deepEqual((packets[0] as { value: unknown }).value, { name: 'empty.txt', size: 0, offset: 0 })
  } finally { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document') }
})

test('update journal reset restores persisted view and artifacts and signals preview loss', async () => {
  const f = fixture()
  try {
    f.effect('preview', [{ mime: 'text/plain', text: 'transient' }])
    await f.execution.refresh(true)
    f.snapshot.ui = [{ id: 'latest', type: 'text', text: 'Latest snapshot' }]
    f.snapshot.artifacts = [{ id: 'saved', name: 'saved.txt', mime: 'text/plain', size: 1, complete: true }]
    f.reset()
    await f.execution.refresh(true)
    assert.equal(f.execution.nodes[0]?.text, 'Latest snapshot')
    assert.equal(f.execution.run.artifacts[0]?.id, 'saved')
    assert.match(f.execution.notice, /transient previews/)
  } finally { f.execution.dispose() }
})

test('desktop arm awaits only IPC before acquisition, and cancellation revokes', async () => {
  const snapshot = run(); snapshot.definition.sources = [{ id: 'mic', kind: 'microphone' }]
  const calls: string[] = []
  let allow!: (value: { expiresAt: number }) => void
  const f = fixture({ run: snapshot, desktop: {
    arm: () => { calls.push('arm'); return new Promise(resolve => { allow = resolve }) },
    revoke: async () => { calls.push('revoke') },
  }, hasUserActivation: () => true })
  const starting = f.execution.start()
  assert.deepEqual(calls, ['arm']); assert.deepEqual(f.events, [])
  allow({ expiresAt: Date.now() + 60_000 }); await turn()
  assert.deepEqual(f.events, ['acquire-gesture', '/runs/fixture-run/start'])
  f.ack(); await starting; await f.execution.cancel()
  assert.ok(calls.includes('revoke'))
})

test('expired desktop activation fails without acquiring; late grants cannot revive cancellation', async () => {
  const snapshot = run(); snapshot.definition.sources = [{ id: 'screen', kind: 'screen' }]
  let revoked = 0
  const f = fixture({ run: snapshot, desktop: { arm: async () => ({ expiresAt: Date.now() + 60_000 }), revoke: async () => { revoked++ } }, hasUserActivation: () => false })
  await f.execution.start()
  assert.ok(!f.events.includes('acquire-gesture')); assert.ok(revoked > 0)
  let allow!: (value: { expiresAt: number }) => void
  const late = fixture({ run: snapshot, desktop: { arm: () => new Promise(resolve => { allow = resolve }), revoke: async () => { revoked++ } }, hasUserActivation: () => true })
  const starting = late.execution.start()
  await late.execution.cancel(); allow({ expiresAt: Date.now() + 60_000 }); await starting
  assert.ok(!late.events.includes('acquire-gesture'))
  assert.equal(late.execution.phase, 'closed')
})

test('camera audio explicitly adds microphone grant; unsupported desktop screen audio is not substituted', () => {
  const snapshot = definition(); snapshot.sources = [{ id: 'camera', kind: 'camera', audio: true }]
  assert.deepEqual(desktopCapabilities(snapshot), ['camera', 'microphone'])
  snapshot.sources = [{ id: 'screen', kind: 'screen', audio: true }]
  assert.match(desktopSourceIssue(snapshot)!, /screen audio is unavailable/)
})

test('native denial and picker cancellation have distinct terminal statuses', async () => {
  for (const [name, status] of [['NotAllowedError', 'denied'], ['AbortError', 'cancelled']] as const) {
    const f = fixture()
    await f.execution.fail(new DOMException('Picker did not grant capture', name))
    assert.equal(f.execution.run.status, status)
  }
})

test('global host survives internal navigation and uses the shared live connection', async () => {
  const app = await readFile(new URL('./App.vue', import.meta.url), 'utf8')
  const chat = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  const nodes = await readFile(new URL('./components/io/IoNodes.vue', import.meta.url), 'utf8')
  const host = await readFile(new URL('./components/io/IoHost.vue', import.meta.url), 'utf8')
  assert.ok(app.indexOf('<IoHost') < app.indexOf('<router-view'))
  assert.match(chat, /<IoRequestCard/)
  assert.match(chat, /useIoConversation/)
  assert.doesNotMatch(chat, /<IoLauncher|Create conversation for I\/O/)
  assert.doesNotMatch(nodes, /v-html|eval\(|new Function|\.start\(|fetch\(/)
  assert.match(host, /livePool\.client\(base\)\.subscribe\(\{ kind: 'io'/)
  assert.doesNotMatch(host, /new EventSource|quickIoDefinition|definition\.program|definition\.sinks/)
  assert.doesNotMatch(host, /io-panel|position:\s*fixed/)
  const card = await readFile(new URL('./components/io/IoRequestCard.vue', import.meta.url), 'utf8')
  assert.match(card, /does not stop that service/)
})
