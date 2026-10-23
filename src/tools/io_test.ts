import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { IoBroker } from '../io/broker.ts'
import { IoCapabilitiesTool, IoRunTool } from './io.ts'
import { IoSurfaceTool } from './io-surface.ts'

const definition = {
  version: 1, title: 'Test input', purpose: 'Send bounded input to a local service',
  endpoint: 'ws://127.0.0.1:8765',
  sources: [{ id: 'form', kind: 'form' }],
  limits: { durationMs: 10_000, maxBytes: 4096 }, ui: [],
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = join(process.cwd(), '.test-data')
  await mkdir(base, { recursive: true })
  const workspace = await mkdtemp(join(base, 'io-tools-'))
  const broker = new IoBroker({
    projectId: 'alpha', workspace,
    assertSession(session) { if (!['web:owner', 'web:other'].includes(session)) throw new Error('Unknown session') },
    sessionDirectory: session => join(workspace, session.replace(':', '-')),
  })
  await broker.start()
  t.after(async () => { await broker.shutdown(); await rm(workspace, { recursive: true, force: true }) })
  return {
    workspace, broker, run: new IoRunTool(broker, 'alpha'), surface: new IoSurfaceTool(broker, 'alpha'),
    capabilities: new IoCapabilitiesTool(broker, 'alpha'),
    context: { projectId: 'alpha', sessionId: 'web:owner', signal: new AbortController().signal },
  }
}

test('I/O create describes a connection without starting a service or granting capture', async t => {
  const { broker, run, context } = await fixture(t)
  const result = JSON.parse(await run.execute({ action: 'create', definition }, context))
  assert.equal(result.status, 'awaiting_consent')
  assert.equal(result.backendStatus, 'disconnected')
  assert.equal(result.endpoint, definition.endpoint)
  assert.equal(result.definition, undefined)
  assert.equal(result.program, undefined)
  assert.equal(result.sinks, undefined)
  const stored = broker.get(result.id, context.sessionId)
  assert.equal(stored.sessionId, context.sessionId)
  assert.deepEqual(stored.definition, definition)
  assert.equal(stored.clientId, undefined)
  assert.equal(JSON.parse(await run.execute({ action: 'status', id: result.id }, context)).definition, undefined)
  assert.deepEqual(JSON.parse(await run.execute({ action: 'get', id: result.id, includeDefinition: true }, context)).definition, definition)
})

test('I/O rejects invalid budgets, endpoints, obsolete engines and impersonation', async t => {
  const { run, broker, capabilities, context } = await fixture(t)
  for (const limits of [undefined, {}, { durationMs: Infinity, maxBytes: 1024 }, { durationMs: 1000, maxBytes: NaN }, { durationMs: 0, maxBytes: 4096 }]) {
    await assert.rejects(run.execute({ action: 'create', definition: { ...definition, limits } }, context))
  }
  for (const endpoint of [undefined, 'https://127.0.0.1:8765', 'ws://example.com', 'ws://user:pass@localhost:8765', 'ws://localhost:8765/#fragment']) {
    await assert.rejects(run.execute({ action: 'create', definition: { ...definition, endpoint } }, context))
  }
  for (const args of [
    { action: 'create', definition, sessionId: 'web:other' },
    { action: 'create', definition, authorization: true },
    { action: 'create', definition, clientId: 'fake' },
    { action: 'create', definition: { ...definition, program: 'function onEvent() {}' } },
    { action: 'create', definition: { ...definition, sinks: [{ id: 'report', kind: 'session' }] } },
    ...['approve', 'prepare', 'begin', 'start', 'update'].map(action => ({ action })),
  ]) await assert.rejects(run.execute(args, context))
  await assert.rejects(capabilities.execute({ projectId: 'alpha' }, context))
  assert.equal(broker.list(context.sessionId).length, 0)
})

test('every I/O entry requires the project, logical session, local workdir and live invocation', async t => {
  const { run, surface, capabilities, context } = await fixture(t)
  for (const [tool, args] of [[run, { action: 'list' }], [surface, { action: 'publish', definition }], [capabilities, {}]] as const) {
    assert.equal(tool.supportsRemoteWorkdir, false)
    for (const invalid of [
      { ...context, projectId: undefined }, { ...context, projectId: 'beta' },
      { ...context, sessionId: '' }, { ...context, sessionId: 'web:missing' },
      { ...context, signal: AbortSignal.abort(new Error('aborted')) },
      { ...context, remoteWorkdir: { nodeId: 'remote', capabilityId: 'opaque', executor: {} } },
    ]) await assert.rejects(tool.execute(args, invalid as typeof context))
  }
})

test('I/O get/list/stop/outputs are session-scoped and return bounded metadata', async t => {
  const { run, broker, context } = await fixture(t)
  const other = await broker.create('web:other', definition)
  assert.deepEqual(JSON.parse(await run.execute({ action: 'list' }, context)), { runs: [] })
  for (const action of ['get', 'status', 'outputs', 'stop']) {
    await assert.rejects(run.execute({ action, id: other.id }, context), /not found/)
  }
  assert.equal(broker.get(other.id, 'web:other').status, 'awaiting_consent')
  const own = await broker.create(context.sessionId, definition)
  assert.deepEqual(JSON.parse(await run.execute({ action: 'outputs', id: own.id }, context)), {
    id: own.id, status: 'awaiting_consent', total: 0, artifacts: [], nextOffset: null,
  })
  await assert.rejects(run.execute({ action: 'outputs', id: own.id, limit: 101 }, context))
  const list = JSON.parse(await run.execute({ action: 'list' }, context))
  assert.equal(list.runs[0].definition, undefined)
  assert.equal(JSON.parse(await run.execute({ action: 'stop', id: own.id }, context)).status, 'cancelled')
})

test('capabilities expose clients, first-party sources and controls, not processors or sink graphs', async t => {
  const { broker, capabilities, context } = await fixture(t)
  assert.equal(JSON.parse(await capabilities.execute({}, context)).status, 'needs_client')
  const secret = broker.registerClient({
    id: 'c171fdd3-2d97-457f-b96c-9453be707799', name: 'Test browser',
    capabilities: [
      { id: 'microphone', kind: 'source', available: true, requiresGesture: true },
      { id: 'stt', kind: 'processor', available: true, requiresGesture: false },
      { id: 'http', kind: 'sink', available: true, requiresGesture: false },
    ],
  })
  const result = await capabilities.execute({}, context)
  assert.ok(!result.includes(secret.clientToken))
  const parsed = JSON.parse(result)
  assert.equal(parsed.status, 'available')
  assert.equal(parsed.processors, undefined)
  assert.equal(parsed.schema.processors, undefined)
  assert.equal(parsed.schema.sinks, undefined)
  assert.equal(parsed.schema.guide, 'v:skills/io')
  assert.deepEqual(parsed.clients[0].capabilities.map((cap: { id: string }) => cap.id), ['microphone'])
  assert.ok(parsed.schema.uiNodes.includes('input'))
  assert.match(parsed.schema.protocol, /shadow.io.v1/)
})

test('surface publication is immutable; closing one run does not replace another connection', async t => {
  const { broker, surface, context } = await fixture(t)
  const first = JSON.parse(await surface.execute({ action: 'publish', definition }, context))
  const second = JSON.parse(await surface.execute({ action: 'publish', definition: { ...definition, endpoint: 'ws://127.0.0.1:8766' } }, context))
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.revision, second.revision)
  assert.equal(second.status, 'awaiting_consent')
  assert.deepEqual(JSON.parse(await surface.execute({ action: 'get', id: first.id, includeDefinition: true }, context)).definition, definition)
  for (const action of ['update', 'approve', 'prepare', 'start']) await assert.rejects(surface.execute({ action, id: first.id }, context))
  for (const action of ['get', 'close']) await assert.rejects(surface.execute({ action, id: first.id }, { ...context, sessionId: 'web:other' }), /not found/)
  assert.equal(JSON.parse(await surface.execute({ action: 'close', id: first.id }, context)).status, 'cancelled')
  assert.equal(broker.get(second.id, context.sessionId).status, 'awaiting_consent')
  assert.match(surface.description, /does not kill/)
})

test('aborting create cancels admission; later turn abort does not own the I/O lifetime', async t => {
  const { broker, run, context } = await fixture(t)
  const controller = new AbortController()
  const original = broker.create.bind(broker)
  broker.create = async (...args) => {
    const created = await original(...args)
    controller.abort(new Error('Cancelled during create'))
    return created
  }
  await assert.rejects(run.execute({ action: 'create', definition }, { ...context, signal: controller.signal }), /Cancelled during create/)
  assert.equal(broker.list(context.sessionId)[0].status, 'cancelled')
  broker.create = original
  const later = new AbortController()
  const created = JSON.parse(await run.execute({ action: 'create', definition }, { ...context, signal: later.signal }))
  later.abort()
  assert.equal(broker.get(created.id, context.sessionId).status, 'awaiting_consent')
})

test('a mock adhoc service drives status/artifacts and remains alive when the I/O link closes', async t => {
  const { broker, run, workspace, context } = await fixture(t)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const paths = [join(workspace, 'first.txt'), join(workspace, 'second.txt')]
  await Promise.all(paths.map(path => writeFile(path, 'synthetic backend output')))
  const packets: Array<{ type: string; event?: { type: string } }> = []
  server.on('connection', socket => socket.on('message', raw => {
    const packet = JSON.parse(raw.toString())
    packets.push(packet)
    if (packet.type === 'open') {
      assert.equal(packet.protocol, 'shadow.io.v1')
      socket.send(JSON.stringify({ type: 'ready' }))
    } else if (packet.type === 'event') {
      socket.send(JSON.stringify({ type: 'ack', sequence: packet.sequence }))
      if (packet.event.type === 'start') {
        socket.send(JSON.stringify({ type: 'status', text: 'Listening from the service' }))
        for (const path of paths) socket.send(JSON.stringify({ type: 'artifact', path, mime: 'text/plain' }))
      }
    }
  }))
  const created = JSON.parse(await run.execute({ action: 'create', definition: {
    ...definition, endpoint: `ws://127.0.0.1:${address.port}`,
    sources: [...definition.sources, { id: 'mic', kind: 'microphone', mode: 'pcm' }],
    limits: { durationMs: 10_000, maxBytes: 32768 },
  } }, context))
  const clientId = 'c171fdd3-2d97-457f-b96c-9453be707799'
  const { clientToken } = broker.registerClient({
    id: clientId, name: 'Synthetic browser', capabilities: [
      { id: 'form', kind: 'source', available: true, requiresGesture: false },
      { id: 'microphone', kind: 'source', available: true, requiresGesture: true },
    ],
  })
  const { leaseToken } = await broker.prepare(created.id, clientId, clientToken, created.revision)
  await broker.begin(created.id, clientId, clientToken, leaseToken, created.revision)
  await broker.dispatch(created.id, { clientId, clientToken, leaseToken }, { type: 'start' })
  await broker.dispatch(created.id, { clientId, clientToken, leaseToken }, {
    type: 'data', sourceId: 'mic', mime: 'audio/pcm', base64: Buffer.alloc(8192).toString('base64'),
    timestamp: Date.now(), value: { sampleRate: 48000, channels: 1, format: 's16le' },
  })
  const deadline = Date.now() + 2000
  while (broker.get(created.id).artifacts.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  const page = JSON.parse(await run.execute({ action: 'outputs', id: created.id, limit: 1 }, context))
  assert.equal(page.total, 2)
  assert.equal(page.nextOffset, 1)
  assert.equal(page.artifacts[0].path, paths[0])
  assert.ok(!JSON.stringify(page).includes('synthetic backend output'))
  const status = JSON.parse(await run.execute({ action: 'get', id: created.id }, context))
  assert.equal(status.backendStatus, 'ready')
  assert.equal(status.message, 'Listening from the service')
  await run.execute({ action: 'stop', id: created.id }, context)
  assert.ok(server.address(), 'Closing I/O must not stop the service listener')
  assert.deepEqual(packets.map(packet => packet.type), ['open', 'event', 'event'])
})
