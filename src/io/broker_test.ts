import { projectStoragePath } from '../utils/data-paths.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Hono } from 'hono'
import { WebSocketServer, type WebSocket } from 'ws'
import { IoBroker, type IoBrokerOptions, type IoCredentials } from './broker.ts'
import { IO_FINALIZE_MS, IO_LEASE_MS, IO_MAX_BUFFER_BYTES, IO_MAX_CHUNK_BYTES, IoError, type IoDefinition, type IoPacket } from './contracts.ts'
import { IO_EVENT_MAX_BYTES, IO_METADATA_MAX_BYTES } from './relay.ts'
import { registerIoRoutes } from './routes.ts'

interface Wire { type: string; sequence: number; event: IoPacket; protocol: string; runId: string }
interface Fixture {
  broker: IoBroker; app: Hono; root: string; home: string; endpoint: string
  server: WebSocketServer; received: Wire[]; advance(ms: number): void
}
async function fixture(
  run: (fixture: Fixture) => Promise<void>,
  handle?: (message: Wire, socket: WebSocket) => void,
  options: Partial<IoBrokerOptions> = {},
): Promise<void> {
  const root = join(process.cwd(), `.io-bridge-test-${randomUUID()}`)
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const received: Wire[] = []
  server.on('connection', socket => socket.on('message', data => {
    const input = JSON.parse(data.toString()) as Wire
    received.push(input)
    if (handle) handle(input, socket)
    else if (input.type === 'open') socket.send('{"type":"ready"}')
    else socket.send(JSON.stringify({ type: 'ack', sequence: input.sequence }))
  }))
  let now = Date.now()
  const broker = new IoBroker({
    projectId: 'one', workspace: home, now: () => now,
    assertSession: id => { if (!['web:one', 'web:two'].includes(id)) throw new IoError('session_not_found', 'No session', 404) },
    sessionDirectory: id => join(home, id.replace(':', '_')), ...options,
  })
  await broker.start()
  const app = new Hono()
  registerIoRoutes(app, broker, request => request.headers.get('Authorization') === 'fixture-auth')
  try {
    await run({ broker, app, root, home, endpoint: `ws://127.0.0.1:${address.port}`, server, received, advance: ms => { now += ms } })
  } finally {
    await broker.shutdown()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}
const definition = (endpoint: string, overrides: Partial<IoDefinition> = {}): IoDefinition => ({
  version: 1, title: 'Capture', purpose: 'Connect to an existing script', endpoint,
  sources: [{ id: 'input', kind: 'file' }], limits: { durationMs: 60_000, maxBytes: 16 * IO_MAX_CHUNK_BYTES }, ui: [], ...overrides,
})
function client(broker: IoBroker) {
  const clientId = randomUUID()
  return { clientId, ...broker.registerClient({
    id: clientId, name: 'Browser', capabilities: [{ id: 'file', kind: 'source', available: true, requiresGesture: true }],
  }) }
}
async function prepared(broker: IoBroker, endpoint: string, overrides: Partial<IoDefinition> = {}) {
  const run = await broker.create('web:one', definition(endpoint, overrides))
  const browser = client(broker)
  const { leaseToken } = await broker.prepare(run.id, browser.clientId, browser.clientToken, run.revision)
  return { run, credentials: { ...browser, leaseToken } }
}
async function approved(broker: IoBroker, endpoint: string, overrides: Partial<IoDefinition> = {}) {
  const result = await prepared(broker, endpoint, overrides)
  const c = result.credentials
  await broker.begin(result.run.id, c.clientId, c.clientToken, c.leaseToken, result.run.revision)
  return result
}
const packet = (value = 'abc'): IoPacket => ({ type: 'data', sourceId: 'input', value })
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5) }
  assert.ok(check(), 'Condition did not become true')
}
function emit(socket: WebSocket, message: unknown): void { socket.send(JSON.stringify(message)) }
function post(app: Hono, path: string, body: unknown) {
  return app.request(`/api/io${path}`, { method: 'POST', headers: {
    Authorization: 'fixture-auth', 'Content-Type': 'application/json',
  }, body: JSON.stringify(body) })
}

test('prepare handshakes but never starts capture, and lease/session/project ownership is retained', async () => {
  await fixture(async ({ broker, endpoint, received, home }) => {
    const { run, credentials: c } = await prepared(broker, endpoint)
    assert.equal(broker.get(run.id).status, 'awaiting_consent')
    assert.equal(broker.get(run.id).backendStatus, 'ready')
    assert.equal(received[0].protocol, 'shadow.io.v1')
    assert.equal(received[0].runId, run.id)
    assert.equal(received.length, 1)
    assert.throws(() => broker.get(run.id, 'web:two'), /not found/)
    await assert.rejects(broker.create('missing', definition(endpoint)), /No session/)
    const other = new IoBroker({ ...broker.options, projectId: 'two', workspace: join(home, 'other') })
    await other.start()
    try { assert.throws(() => other.get(run.id), /not found/) } finally { await other.shutdown() }
    const second = client(broker)
    await assert.rejects(broker.prepare(run.id, second.clientId, second.clientToken, run.revision), /another client/)
    await assert.rejects(broker.dispatch(run.id, c, packet()), /not collecting/)
    await assert.rejects(broker.begin(run.id, c.clientId, c.clientToken, c.leaseToken, 'wrong'), /Consent/)
    await assert.rejects(broker.begin(run.id, c.clientId, randomUUID(), c.leaseToken, run.revision), /expired/)
    await broker.begin(run.id, c.clientId, c.clientToken, c.leaseToken, run.revision)
    assert.deepEqual(await broker.dispatch(run.id, c, { type: 'start' }), { accepted: true })
  })
})

test('events are serialized by ACK while UI effects arrive independently before and after ACK', async () => {
  await fixture(async ({ broker, endpoint, received, server }) => {
    const { run, credentials } = await approved(broker, endpoint)
    const socket = [...server.clients][0]
    const first = broker.dispatch(run.id, credentials, packet('one'))
    const second = broker.dispatch(run.id, credentials, packet('two'))
    await until(() => received.filter(item => item.type === 'event').length === 1)
    emit(socket, { type: 'ui', nodes: [{ id: 'state', type: 'text', text: 'Before acknowledgement' }] })
    await until(() => broker.get(run.id).ui?.[0]?.text === 'Before acknowledgement')
    assert.equal(received.filter(item => item.type === 'event').length, 1)
    emit(socket, { type: 'ack', sequence: 1 })
    assert.deepEqual(await first, { accepted: true })
    await until(() => received.filter(item => item.type === 'event').length === 2)
    emit(socket, { type: 'ack', sequence: 2 })
    await second
    emit(socket, { type: 'status', text: 'After acknowledgement' })
    emit(socket, { type: 'preview', mime: 'audio/wav', base64: 'AP+A' })
    await until(() => broker.updates(run.id).cursor === 3)
    const updates = broker.updates(run.id)
    assert.deepEqual(updates.updates.map(item => item.effect.method), ['ui.render', 'status', 'preview'])
    assert.deepEqual(broker.updates(run.id), updates, 'Reading or acknowledging input must not consume effects')
    assert.equal(broker.get(run.id).bytes, 6)
    assert.doesNotMatch(JSON.stringify(broker.get(run.id)), /AP\+A/, 'Media must not enter run snapshots/SSE')
  }, (message, socket) => { if (message.type === 'open') emit(socket, { type: 'ready' }) })
})

test('Finish input keeps the backend alive until delayed done and registers files without copying', async () => {
  let finished = 0
  await fixture(async ({ broker, endpoint, server, root, app }) => {
    const { run, credentials } = await approved(broker, endpoint)
    await broker.dispatch(run.id, credentials, { type: 'end' })
    assert.equal((await broker.stop(run.id, 'completed')).status, 'stopping')
    broker.heartbeat(run.id, credentials.clientId, credentials.clientToken, credentials.leaseToken)
    await assert.rejects(broker.dispatch(run.id, credentials, packet()), /not collecting/)
    const socket = [...server.clients][0]
    assert.equal(socket.readyState, socket.OPEN)
    const path = join(root, 'backend-output.bin')
    await writeFile(path, Buffer.from([0, 128, 255]))
    emit(socket, { type: 'artifact', path, name: 'result.bin', mime: 'application/octet-stream' })
    emit(socket, { type: 'done' })
    await until(() => broker.get(run.id).status === 'completed')
    await until(() => finished === 1)
    const completed = broker.get(run.id)
    assert.equal(completed.artifacts[0].path, path)
    const url = `/api/io/runs/${run.id}/artifacts/${completed.artifacts[0].id}`
    assert.equal((await app.request(url)).status, 401)
    const response = await app.request(url, { headers: { Authorization: 'fixture-auth' } })
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.match(response.headers.get('Content-Disposition')!, /attachment/)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 128, 255]))
    await broker.stop(run.id, 'cancelled')
    assert.equal(finished, 1)
  }, undefined, { finished: async () => { finished++ } })
})

test('POST Finish synthesizes a single end event when needed, and backend error terminates processing', async () => {
  await fixture(async ({ broker, endpoint, received, server }) => {
    const { run } = await approved(broker, endpoint)
    assert.equal((await broker.stop(run.id, 'completed')).status, 'stopping')
    await broker.stop(run.id, 'completed')
    await until(() => received.some(item => item.event?.type === 'end'))
    assert.equal(received.filter(item => item.event?.type === 'end').length, 1)
    emit([...server.clients][0], { type: 'error', message: 'Decoder rejected the input' })
    await until(() => broker.get(run.id).status === 'failed')
    assert.equal(broker.get(run.id).error, 'Decoder rejected the input')
  })
})

test('input limits validate canonical base64, declared sources, raw chunk size, and cumulative bytes', async () => {
  await fixture(async ({ broker, endpoint }) => {
    const { run, credentials } = await approved(broker, endpoint, { limits: { durationMs: 60_000, maxBytes: IO_MAX_CHUNK_BYTES } })
    for (const event of [
      { type: 'data', value: 'missing source' },
      { type: 'data', sourceId: 'other', value: 'bad' },
      { type: 'data', sourceId: 'input', mime: 'audio/wav', base64: '%%%' },
      { type: 'data', sourceId: 'input', mime: 'audio/wav', base64: 'AB==' },
      { type: 'data', sourceId: 'input', base64: 'AA==' },
      { type: 'data', sourceId: 'input', value: 'duplicate', mime: 'audio/wav', base64: 'AA==' },
      { type: 'end', value: 'not lifecycle metadata' },
      { type: 'data', sourceId: 'input', mime: 'audio/wav', base64: Buffer.alloc(IO_MAX_CHUNK_BYTES + 1).toString('base64') },
    ]) await assert.rejects(broker.dispatch(run.id, credentials, event))
    await broker.dispatch(run.id, credentials, {
      type: 'data', sourceId: 'input', mime: 'audio/wav', base64: Buffer.alloc(IO_MAX_CHUNK_BYTES).toString('base64'),
    })
    assert.equal(broker.get(run.id).bytes, IO_MAX_CHUNK_BYTES)
    await assert.rejects(broker.dispatch(run.id, credentials, packet('x')), /byte budget/)
    assert.equal(broker.get(run.id).status, 'failed')
  })
})

test('PCM and frame packets retain bounded metadata beside base64 and charge both to the input budget', async () => {
  await fixture(async ({ broker, endpoint, received }) => {
    const { run, credentials } = await approved(broker, endpoint)
    const packets = [
      { type: 'data', sourceId: 'input', mime: 'audio/pcm', base64: 'AP+A', value: { sampleRate: 16000, channels: 1, format: 's16le' } },
      { type: 'data', sourceId: 'input', mime: 'image/jpeg', base64: 'AP+A', value: { width: 640, height: 480 } },
      { type: 'data', sourceId: 'input', mime: 'audio/pcm', base64: Buffer.alloc(IO_MAX_CHUNK_BYTES).toString('base64'),
        value: { sampleRate: 16000, channels: 1, format: 's16le' } },
    ]
    for (const packet of packets) await broker.dispatch(run.id, credentials, packet)
    assert.deepEqual(received.filter(item => item.type === 'event').map(item => item.event), packets)
    assert.equal(broker.get(run.id).bytes, packets.reduce((sum, packet) =>
      sum + Buffer.from(packet.base64, 'base64').length + Buffer.byteLength(JSON.stringify(packet.value)), 0))
    await assert.rejects(broker.dispatch(run.id, credentials, {
      ...packets[0], value: { padding: 'x'.repeat(IO_METADATA_MAX_BYTES) },
    }), /metadata exceeds/)
  })
})

test('lost leases interrupt capture; capture duration transitions to processing with its own deadline', async () => {
  await fixture(async ({ broker, endpoint, advance }) => {
    const first = await approved(broker, endpoint)
    advance(IO_LEASE_MS)
    await broker.expire()
    assert.equal(broker.get(first.run.id).status, 'interrupted')
    const { run, credentials } = await approved(broker, endpoint, { limits: { durationMs: 1000, maxBytes: 1024 } })
    advance(1000 + IO_FINALIZE_MS)
    await broker.expire()
    assert.equal(broker.get(run.id).status, 'stopping')
    broker.heartbeat(run.id, credentials.clientId, credentials.clientToken, credentials.leaseToken)
    advance(1001)
    await broker.expire()
    assert.equal(broker.get(run.id).status, 'failed')
    assert.match(broker.get(run.id).error!, /processing timed out/)
  }, undefined, { processingTimeoutMs: 1000 })
})

test('expired pending leases disconnect without auto reconnect; cancel closes only this bridge', async () => {
  await fixture(async ({ broker, endpoint, advance, server }) => {
    const first = await prepared(broker, endpoint)
    advance(IO_LEASE_MS)
    await broker.expire()
    assert.equal(broker.get(first.run.id).status, 'awaiting_consent')
    assert.equal(broker.get(first.run.id).backendStatus, 'disconnected')
    await until(() => server.clients.size === 0)
    const second = await approved(broker, endpoint)
    await broker.stop(second.run.id, 'cancelled')
    await until(() => server.clients.size === 0)
    const third = await prepared(broker, endpoint)
    assert.equal(broker.get(third.run.id).backendStatus, 'ready', 'The arbitrary backend server itself was not killed')
    await broker.stop(third.run.id, 'denied')
  })
})

test('ready and ACK timeouts are explicit; cancellation rejects a pending ACK promptly', async () => {
  await fixture(async ({ broker, endpoint }) => {
    const run = await broker.create('web:one', definition(endpoint))
    const c = client(broker)
    await assert.rejects(broker.prepare(run.id, c.clientId, c.clientToken, run.revision), /ready handshake timed out/)
    assert.equal(broker.get(run.id).status, 'failed')
  }, () => {}, { connectTimeoutMs: 30 })
  await fixture(async ({ broker, endpoint }) => {
    const { run, credentials } = await approved(broker, endpoint)
    await assert.rejects(broker.dispatch(run.id, credentials, packet()), /acknowledgement timed out/)
    assert.equal(broker.get(run.id).status, 'failed')
  }, (input, socket) => { if (input.type === 'open') emit(socket, { type: 'ready' }) }, { ackTimeoutMs: 30 })
  await fixture(async ({ broker, endpoint, received }) => {
    const { run, credentials } = await approved(broker, endpoint)
    const pending = broker.dispatch(run.id, credentials, packet())
    const rejection = assert.rejects(pending, /cancelled/)
    await until(() => received.length === 2)
    await broker.stop(run.id, 'cancelled')
    await rejection
  }, (input, socket) => { if (input.type === 'open') emit(socket, { type: 'ready' }) })
})

test('journal is bounded by count and bytes, and old cursors reset to current UI/artifact snapshot', async () => {
  await fixture(async ({ broker, endpoint, server }) => {
    const { run } = await approved(broker, endpoint)
    const socket = [...server.clients][0]
    for (let i = 1; i <= 260; i++) {
      emit(socket, { type: 'status', text: String(i) })
      await until(() => broker.updates(run.id).cursor === i)
    }
    const countBounded = broker.updates(run.id, 0)
    assert.equal(countBounded.reset, true)
    assert.equal(countBounded.updates.length, 256)
    assert.equal(broker.get(run.id).message, '260')
    const base64 = Buffer.alloc(IO_MAX_CHUNK_BYTES).toString('base64')
    for (let i = 1; i <= 7; i++) {
      emit(socket, { type: 'preview', mime: 'image/png', base64 })
      await until(() => broker.updates(run.id, 260 + i - 1).cursor === 260 + i)
    }
    const byteBounded = broker.updates(run.id)
    assert.equal(byteBounded.reset, true)
    assert.ok(Buffer.byteLength(JSON.stringify(byteBounded.updates)) < IO_MAX_BUFFER_BYTES)
    assert.deepEqual(broker.updates(run.id, byteBounded.cursor).updates, [])
    assert.equal(broker.updates(run.id, byteBounded.cursor + 1).reset, true)
  })
})

test('buffered source events are bounded while a backend is waiting to ACK', async () => {
  await fixture(async ({ broker, endpoint, received }) => {
    const { run, credentials } = await approved(broker, endpoint)
    const data = { type: 'data', sourceId: 'input', mime: 'audio/wav', base64: Buffer.alloc(IO_MAX_CHUNK_BYTES).toString('base64') }
    const pending = Array.from({ length: 5 }, () => broker.dispatch(run.id, credentials, data).catch(error => error))
    await until(() => received.length === 2)
    await assert.rejects(broker.dispatch(run.id, credentials, data), /previous input acknowledgement/)
    await broker.stop(run.id, 'cancelled')
    await Promise.all(pending)
  }, (input, socket) => { if (input.type === 'open') emit(socket, { type: 'ready' }) })
})

test('restart preserves pending definitions and artifact paths but never reconnects active captures; legacy records remain on disk', async t => {
  const warnings: string[] = []
  t.mock.method(console, 'warn', (value: unknown) => { warnings.push(String(value)) })
  await fixture(async ({ broker, endpoint, home, server, root }) => {
    const pending = await broker.create('web:one', definition(endpoint))
    const { run } = await approved(broker, endpoint)
    const path = join(root, 'saved-by-backend.txt')
    await writeFile(path, 'saved')
    emit([...server.clients][0], { type: 'artifact', path })
    await until(() => broker.get(run.id).artifacts.length === 1)
    await broker.shutdown()
    const legacyPath = projectStoragePath(home, '.io', 'runs', `${randomUUID()}.json`)
    const legacy = '{"definition":{"program":"never execute this legacy program"}}'
    await writeFile(legacyPath, legacy)
    const restarted = new IoBroker(broker.options)
    await restarted.start()
    try {
      assert.equal(restarted.get(run.id).status, 'interrupted')
      assert.equal(restarted.get(run.id).artifacts[0].path, path)
      assert.equal(restarted.get(pending.id).status, 'awaiting_consent')
      assert.equal(restarted.get(pending.id).backendStatus, 'disconnected')
      assert.deepEqual(restarted.capabilities().clients, [])
      assert.equal(await readFile(legacyPath, 'utf8'), legacy)
      assert.ok(warnings.some(warning => /Migration.*legacy program/.test(warning)))
    } finally { await restarted.shutdown() }
  })
})

test('malformed backend data and non-file artifacts fail explicitly without executing anything', async () => {
  for (const mode of ['invalid-json', 'binary', 'directory'] as const) {
    await fixture(async ({ broker, endpoint, server, root }) => {
      const { run } = await approved(broker, endpoint)
      const socket = [...server.clients][0]
      if (mode === 'invalid-json') socket.send('not JSON')
      else if (mode === 'binary') socket.send(Buffer.from([1, 2]))
      else emit(socket, { type: 'artifact', path: root })
      await until(() => broker.get(run.id).status === 'failed')
    })
  }
})

test('authenticated routes relay events, expose non-consuming updates, and bound malformed request bodies', async () => {
  await fixture(async ({ broker, app, endpoint }) => {
    assert.equal((await app.request('/api/io/runs')).status, 401)
    assert.equal((await post(app, '/runs', { sessionId: 'absent', definition: definition(endpoint) })).status, 404)
    const { run, credentials } = await approved(broker, endpoint)
    assert.equal((await post(app, `/runs/${run.id}/events`, { ...credentials, event: packet() })).status, 200)
    assert.deepEqual(await (await post(app, `/runs/${run.id}/events`, { ...credentials, event: { type: 'ui', id: 'threshold', value: 12 } })).json(), { accepted: true })
    assert.equal((await post(app, `/runs/${run.id}/events`, { ...credentials, event: packet(), extra: true })).status, 400)
    assert.equal((await post(app, `/runs/${run.id}/events`, { ...credentials, leaseToken: randomUUID(), event: packet() })).status, 403)
    const response = await app.request(`/api/io/runs/${run.id}/events`, {
      method: 'POST', headers: { Authorization: 'fixture-auth', 'Content-Type': 'application/json' },
      body: 'x'.repeat(IO_EVENT_MAX_BYTES + 1),
    })
    assert.equal(response.status, 413)
    const updates = await app.request(`/api/io/runs/${run.id}/updates?after=-1`, { headers: { Authorization: 'fixture-auth' } })
    assert.equal(updates.status, 400)
    const wrongSession = await app.request(`/api/io/runs/${run.id}?sessionId=web:two`, { headers: { Authorization: 'fixture-auth' } })
    assert.equal(wrongSession.status, 404)
  })
})


test('migrated artifacts resolve on access without rewriting recorded absolute paths', async () => {
  await fixture(async ({ broker, endpoint, home, server, root }) => {
    const nextHome = join(root, 'projects', 'one')
    const legacyHome = join(root, 'workspace.projects', 'projects', 'one', 'workspace')
    const oldPath = join(legacyHome, 'web_one', 'saved.txt')
    await mkdir(join(legacyHome, 'web_one'), { recursive: true })
    await writeFile(oldPath, 'retained artifact')
    const { run } = await approved(broker, endpoint)
    emit([...server.clients][0], { type: 'artifact', path: oldPath })
    await until(() => broker.get(run.id).artifacts.length === 1)
    await broker.shutdown()
    const filename = run.id + '.json'
    const record = await readFile(projectStoragePath(home, '.io', 'runs', filename), 'utf8')
    await mkdir(projectStoragePath(nextHome, '.io', 'runs'), { recursive: true })
    await writeFile(projectStoragePath(nextHome, '.io', 'runs', filename), record)
    await writeFile(join(nextHome, 'state', 'layout-migration.json'), JSON.stringify({ version: 1, legacyHome }))
    const nextDirectory = join(nextHome, 'workdirs', 'web_one')
    await mkdir(nextDirectory, { recursive: true })
    const nextPath = join(nextDirectory, 'saved.txt')
    await rename(oldPath, nextPath)
    const restarted = new IoBroker({ ...broker.options, workspace: nextHome })
    await restarted.start()
    try {
      const artifact = restarted.get(run.id).artifacts[0]
      assert.equal(artifact.path, oldPath)
      assert.equal((await restarted.artifactPath(run.id, artifact.id)).path, nextPath)
      const app = new Hono()
      registerIoRoutes(app, restarted, () => true)
      const response = await app.request('/api/io/runs/' + run.id + '/artifacts/' + artifact.id)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'retained artifact')
      assert.equal(JSON.parse(await readFile(projectStoragePath(nextHome, '.io', 'runs', filename), 'utf8')).artifacts[0].path, oldPath)
    } finally { await restarted.shutdown() }
  })
})
