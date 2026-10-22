import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import WS from 'ws'
import { registerGatewayRoutes, serveGateway } from './server.ts'
import { upgradeGatewayWebSocket } from './websocket.ts'

test('real WebSocket upgrades preserve Host and port before origin and audience authorization', async () => {
  const app = new Hono()
  let expectedOrigin = ''
  const protocol = 'shadow-fixture'
  registerGatewayRoutes(app, [gateway => {
    gateway.get('/cluster/v1/node', async c => {
      if (new URL(c.req.url).origin !== expectedOrigin) return c.json({ error: 'wrong_audience' }, 401)
      return upgradeGatewayWebSocket(app, c, socket => socket.send(c.req.url), protocol)
    })
  }], { launchCredential: 'fixture-secret', launchCredentialExemptions: [{ method: 'GET', path: '/cluster/v1/node' }] })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 })
  await server.ready
  expectedOrigin = `http://127.0.0.1:${server.addr.port}`
  let socket: WS | undefined
  try {
    const result = await new Promise<string>((resolve, reject) => {
      socket = new WS(`${expectedOrigin.replace('http:', 'ws:')}/cluster/v1/node`, protocol, {
        headers: { Origin: expectedOrigin }, handshakeTimeout: 3000,
      })
      socket.once('error', reject)
      socket.once('message', message => resolve(message.toString()))
    })
    assert.equal(result, `${expectedOrigin}/cluster/v1/node`)
    assert.equal(socket!.protocol, protocol)
    socket!.terminate()
    socket = undefined
    await assert.rejects(new Promise<void>((resolve, reject) => {
      socket = new WS(`${expectedOrigin.replace('http:', 'ws:')}/cluster/v1/node`, protocol, {
        headers: { Origin: 'http://untrusted.invalid' }, handshakeTimeout: 3000,
      })
      socket.once('open', () => resolve())
      socket.once('error', reject)
    }), /403/)
  } finally {
    socket?.terminate()
    await server.shutdown()
  }
})
