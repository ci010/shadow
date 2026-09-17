import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Hono } from 'hono'
import { WebSocketServer, type WebSocket } from 'ws'
import { IoBroker } from './broker.ts'
import { registerIoRoutes } from './routes.ts'
import type { IoRelayUpdate, IoRun } from './contracts.ts'

test('an adhoc backend drives controls and completes processing after browser input finishes', async () => {
  const root = await mkdtemp(join(process.cwd(), '.io-ux-test-'))
  const home = join(root, 'home')
  const output = join(root, '后端选择的结果.txt')
  await mkdir(home)
  await writeFile(output, 'Result saved by an arbitrary backend, outside the I/O store.')
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  let connection: WebSocket | undefined
  let ended = false
  const received: unknown[] = []
  server.on('connection', socket => {
    connection = socket
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString())
      received.push(message)
      if (message.type === 'open') {
        assert.equal(message.protocol, 'shadow.io.v1')
        socket.send(JSON.stringify({ type: 'ready' }))
        socket.send(JSON.stringify({ type: 'ui', nodes: [
          { id: 'threshold', type: 'input', inputType: 'number', value: 10, text: 'Threshold' },
          { id: 'caption', type: 'text', text: 'Ready for input' },
        ] }))
      } else if (message.type === 'event') {
        socket.send(JSON.stringify({ type: 'ack', sequence: message.sequence }))
        if (message.event.type === 'ui') {
          socket.send(JSON.stringify({ type: 'status', text: `Threshold changed to ${message.event.value}` }))
        }
        if (message.event.type === 'end') {
          ended = true
          socket.send(JSON.stringify({ type: 'status', text: 'Input finished; processing remains active' }))
        }
      }
    })
  })
  const broker = new IoBroker({
    projectId: 'fixture', workspace: home,
    assertSession: id => { assert.equal(id, 'web:fixture') },
    sessionDirectory: () => join(home, 'web_fixture'),
  })
  const app = new Hono()
  registerIoRoutes(app, broker, request => request.headers.get('Authorization') === 'Bearer fixture')
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await app.request(`/api/io${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
    return response.json() as Promise<T>
  }
  await broker.start()
  try {
    const run = await request<IoRun>('/runs', {
      sessionId: 'web:fixture',
      definition: {
        version: 1, title: 'Adhoc capture', purpose: 'Interact with a temporary backend',
        endpoint: `ws://127.0.0.1:${address.port}`,
        sources: [{ id: 'form', kind: 'form' }],
        limits: { durationMs: 60_000, maxBytes: 4096 }, ui: [],
      },
    })
    const clientId = randomUUID()
    const { clientToken } = await request<{ clientToken: string }>('/clients', {
      id: clientId, name: 'Fixture UI',
      capabilities: [{ id: 'form', kind: 'source', available: true, requiresGesture: false }],
    })
    const { leaseToken } = await request<{ leaseToken: string; run: IoRun }>(`/runs/${run.id}/prepare`, {
      clientId, clientToken, revision: run.revision,
    })
    const credentials = { clientId, clientToken, leaseToken }
    assert.equal((await request<IoRun>(`/runs/${run.id}`)).status, 'awaiting_consent')
    await request(`/runs/${run.id}/start`, { ...credentials, revision: run.revision })
    await request(`/runs/${run.id}/events`, { ...credentials, event: { type: 'start' } })
    await request(`/runs/${run.id}/events`, {
      ...credentials, event: { type: 'ui', sourceId: 'form', id: 'threshold', value: 22 },
    })
    await request(`/runs/${run.id}/events`, { ...credentials, event: { type: 'end' } })
    assert.equal(ended, true)
    await request(`/runs/${run.id}/stop`, { status: 'completed' })
    assert.equal((await request<IoRun>(`/runs/${run.id}`)).status, 'stopping', 'Finish input must not kill ongoing backend processing')
    assert.ok(connection)
    connection.send(JSON.stringify({ type: 'artifact', path: output, name: '结果.txt', mime: 'text/plain' }))
    connection.send(JSON.stringify({ type: 'done' }))
    let completed: IoRun | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      completed = await request<IoRun>(`/runs/${run.id}`)
      if (completed.status === 'completed') break
      await delay(20)
    }
    assert.equal(completed?.status, 'completed')
    assert.equal(completed.artifacts.length, 1)
    assert.equal(completed.artifacts[0].path, output, 'The backend chooses its own output path')
    const updates = await request<{ updates: IoRelayUpdate[]; cursor: number }>(`/runs/${run.id}/updates?after=0`)
    assert.ok(updates.updates.some(update => update.effect.method === 'ui.render'))
    assert.ok(updates.updates.some(update => update.effect.method === 'status' &&
      update.effect.args[0] === 'Threshold changed to 22'))
    const download = await app.request(`/api/io/runs/${run.id}/artifacts/${completed.artifacts[0].id}`, {
      headers: { Authorization: 'Bearer fixture' },
    })
    assert.equal(download.status, 200)
    assert.ok(download.headers.get('Content-Disposition')?.includes(encodeURIComponent('结果.txt')))
    assert.equal(await download.text(), 'Result saved by an arbitrary backend, outside the I/O store.')
    assert.equal(received.filter(message => (message as { type?: string }).type === 'event').length, 3)
  } finally {
    await broker.shutdown()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
