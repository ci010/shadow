import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { Hono } from 'hono'
import { WebSocketServer } from 'ws'
import { devProxyPlugin } from './dev-proxy.ts'
import { serveGateway } from './server.ts'
import { createServer } from 'node:http'

test('dev proxy forwards org pages but never loops scoped backend requests through Vite', async () => {
  const paths: string[] = []
  const upstream = createServer((request, response) => {
    paths.push(request.url ?? '')
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<html>Vite page</html>')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  assert(address && typeof address !== 'string')
  const app = new Hono()
  devProxyPlugin(`http://127.0.0.1:${address.port}`)(app)
  try {
    const page = await app.request('/organizations/default/settings/bots')
    assert.equal(page.status, 200)
    assert.equal(await page.text(), '<html>Vite page</html>')
    for (const path of ['/organizations/default/api/missing', '/organizations/default/v1/query/logs', '/nodes/v1/missing']) {
      assert.equal((await app.request(path)).status, 404)
    }
    assert.deepEqual(paths, ['/organizations/default/settings/bots'])
  } finally {
    upstream.closeAllConnections()
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  }
})

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
