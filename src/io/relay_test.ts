import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { WebSocketServer, type WebSocket } from 'ws'
import { IO_EVENT_MAX_BYTES, IoRelay, type IoRelayOptions } from './relay.ts'

async function fixture(
  run: (relay: IoRelay, socket: WebSocket, errors: Error[]) => Promise<void>,
  options: Partial<IoRelayOptions> = {},
): Promise<void> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  let socket: WebSocket | undefined
  server.on('connection', connected => {
    socket = connected
    connected.on('message', data => {
      if (JSON.parse(data.toString()).type === 'open') connected.send('{"type":"ready"}')
    })
  })
  const errors: Error[] = []
  const relay = new IoRelay({
    endpoint: `ws://127.0.0.1:${address.port}`, runId: 'fixture',
    sources: [{ id: 'audio', kind: 'microphone' }],
    onEffect: async () => {}, onDone: async () => {}, onError: error => { errors.push(error) },
    ...options,
  })
  try {
    await relay.connect()
    assert.ok(socket)
    await run(relay, socket, errors)
  } finally {
    relay.close()
    for (const connection of server.clients) connection.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5) }
  assert.ok(check())
}

test('oversized backend frames are rejected by the WebSocket receive bound', async () => {
  await fixture(async (_relay, socket, errors) => {
    socket.send(' '.repeat(IO_EVENT_MAX_BYTES + 1))
    await until(() => errors.length === 1)
    assert.match(errors[0].message, /Max payload size exceeded/)
  })
})

test('backend effect work is bounded even when an artifact handler is still pending', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await fixture(async (_relay, socket, errors) => {
      for (let i = 0; i < 257; i++) socket.send(JSON.stringify({ type: 'status', text: String(i) }))
      await until(() => errors.length === 1)
      assert.match(errors[0].message, /effect buffer exceeded/)
      release()
    }, { onEffect: () => gate })
  } finally { release() }
})

test('ACK does not wait behind asynchronous output registration', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await fixture(async (relay, socket) => {
      socket.on('message', data => {
        const message = JSON.parse(data.toString())
        if (message.type !== 'event') return
        socket.send('{"type":"status","text":"Output still pending"}')
        socket.send(JSON.stringify({ type: 'ack', sequence: message.sequence }))
      })
      await relay.send({ type: 'start' })
      release()
    }, { onEffect: () => gate, ackTimeoutMs: 100 })
  } finally { release() }
})

test('unknown ACK sequences and unexpected disconnect reject a pending event', async () => {
  await fixture(async (relay, socket, errors) => {
    const rejection = assert.rejects(relay.send({ type: 'start' }), /unknown sequence/)
    socket.send('{"type":"ack","sequence":999}')
    await rejection
    assert.equal(errors.length, 1)
  })
  await fixture(async (relay, socket, errors) => {
    const rejection = assert.rejects(relay.send({ type: 'start' }), /disconnected/)
    socket.close()
    await rejection
    assert.equal(errors.length, 1)
  })
})
