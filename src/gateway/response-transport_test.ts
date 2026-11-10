import assert from 'node:assert/strict'
import { test } from 'node:test'
import { get } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { registerGatewayRoutes, serveGateway } from './server.ts'

// Exercise the real Node adapter, not app.request(): only a socket can exert
// writable backpressure. No runtime sessions or user data are needed.
for (const streamed of [false, true]) test(`gateway completes ${streamed ? 'streamed' : 'buffered'} JSON and tiny errors while a socket reader pauses`, { timeout: 10_000 }, async () => {
  const app = new Hono()
  const json = JSON.stringify({ sessions: [{ title: 'synthetic 会话'.repeat(400_000) }] })
  registerGatewayRoutes(app, [gateway => {
    gateway.get('/api/sessions/graph', () => {
      const bytes = Buffer.from(json)
      let offset = 0
      const body = streamed ? new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) { controller.close(); return }
          const end = Math.min(offset + 16_384, bytes.length)
          controller.enqueue(bytes.subarray(offset, end))
          offset = end
        },
      }) : json
      return new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    })
    gateway.get('/api/sessions/missing/details', c => c.json({ error: 'session_not_found' }, 404))
  }], {}, {})
  const server = serveGateway(app, { port: 0, host: '127.0.0.1' })
  await server.ready
  try {
    const base = `http://127.0.0.1:${server.addr.port}`
    await new Promise<void>((resolve, reject) => {
      const request = get(base + '/api/sessions/graph', response => {
        response.on('error', reject)
        response.pause()
        void (async () => {
          // Leave the large response unread while another connection completes.
          const missing = await fetch(base + '/api/sessions/missing/details')
          assert.equal(missing.status, 404)
          assert.deepEqual(await missing.json(), { error: 'session_not_found' })
          await delay(100)
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(Buffer.from(chunk)))
          response.on('end', () => {
            try {
              assert.equal(response.complete, true)
              assert.equal(Buffer.concat(chunks).toString('utf8'), json)
              resolve()
            } catch (error) { reject(error) }
          })
          response.resume()
        })().catch(error => { response.destroy(); reject(error) })
      })
      request.on('error', reject)
    })
  } finally { await server.shutdown() }
})
