import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { Hono } from 'hono'
import { WebSocketServer } from 'ws'
import { devProxyPlugin } from './dev-proxy.ts'
import { serveGateway } from './server.ts'

test('dev proxy bridges text, binary, and HMR protocol using a native client', { timeout: 10_000 }, async () => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  upstream.on('connection', (socket) => {
    socket.on('message', (data, binary) => socket.send(data, { binary }))
  })
  await once(upstream, 'listening')
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const app = new Hono()
  devProxyPlugin(`http://127.0.0.1:${address.port}`)(app)
  const gateway = serveGateway(app, { host: '127.0.0.1', port: 0 })
  let client: WebSocket | undefined
  try {
    await gateway.ready
    client = new WebSocket(`ws://127.0.0.1:${gateway.addr.port}/hmr`, 'vite-hmr')
    client.binaryType = 'arraybuffer'
    await once(client, 'open')
    assert.equal(client.protocol, 'vite-hmr')

    const text = once(client, 'message')
    client.send('hot-update')
    assert.equal((await text)[0].data, 'hot-update')

    const binary = once(client, 'message')
    client.send(Uint8Array.of(0, 127, 255))
    assert.deepEqual(new Uint8Array((await binary)[0].data), Uint8Array.of(0, 127, 255))
  } finally {
    client?.close()
    await gateway.shutdown()
    for (const socket of upstream.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => error ? reject(error) : resolve())
    })
  }
})
