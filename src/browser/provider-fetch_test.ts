import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { WebSocketServer } from 'ws'
import { browserProviderFetch, providerBrowserTargets } from './provider-fetch.ts'

const origin = 'https://93.184.216.34'
async function fixture(fetcher: typeof fetch, run: (endpoint: string, calls: any[], world: any, disconnect: () => void) => Promise<void>) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const calls: any[] = []
  const world = createContext({ location: { origin }, fetch: fetcher, URL, AbortController, setTimeout, clearTimeout, TextDecoder, Uint8Array })
  server.on('connection', socket => socket.on('message', async raw => {
    const message = JSON.parse(String(raw)); calls.push(message)
    let result: any
    try {
      switch (message.method) {
        case 'Target.getTargets': result = { targetInfos: [{ type: 'page', targetId: 'target-a', url: origin + '/private?not-returned' }, { type: 'worker', targetId: 'worker', url: origin }] }; break
        case 'Target.getTargetInfo': result = { targetInfo: { type: 'page', url: message.params.targetId === 'target-a' ? origin : 'https://other.example' } }; break
        case 'Target.attachToTarget': result = { sessionId: 'session-a' }; break
        case 'Page.getFrameTree': result = { frameTree: { frame: { id: 'frame-a', url: origin } } }; break
        case 'Page.createIsolatedWorld': result = { executionContextId: 7 }; break
        case 'Runtime.evaluate': result = { result: { value: await runInContext(message.params.expression, world) } }; break
        case 'Target.detachFromTarget': result = {}; break
        default: throw new Error('Forbidden command')
      }
      if (socket.readyState === 1) socket.send(JSON.stringify({ id: message.id, result }))
    } catch { if (socket.readyState === 1) socket.send(JSON.stringify({ id: message.id, error: { message: 'synthetic-only' } })) }
  }))
  try { await run(`ws://127.0.0.1:${(server.address() as any).port}`, calls, world, () => { for (const socket of server.clients) socket.terminate() }) }
  finally { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('fixed isolated browser fetch uses exact target, include credentials, bounded JSON/text and detaches only own session', async () => {
  let requests = 0
  await fixture(async (url, init) => {
    requests++; assert.equal(String(url), origin + '/feed?q=value'); assert.equal(init?.credentials, 'include')
    assert.equal(init?.redirect, 'error'); assert.equal(init?.mode, 'cors'); assert.equal(init?.method, 'GET')
    return { ...new Response(), status: 200, url: String(url), type: 'basic', redirected: false,
      body: new Response(requests === 1 ? '{"items":[]}' : 'plain text').body } as Response
  }, async (endpoint, calls, world) => {
    assert.deepEqual(await providerBrowserTargets(endpoint), [{ targetId: 'target-a', origin }])
    for (const expected of ['{"items":[]}', 'plain text']) {
      const response = await browserProviderFetch(endpoint, 'target-a', origin + '/feed?q=value', { credentials: 'include', redirect: 'error', method: 'GET' }, () => {})
      assert.equal(await response.text(), expected)
    }
    assert.equal(calls.filter(c => c.method === 'Target.detachFromTarget').length, 2)
    assert.ok(calls.filter(c => c.method === 'Page.createIsolatedWorld').every(c => c.params.grantUniveralAccess === false))
    assert.equal(Object.keys(world).filter(key => key.startsWith('__shadow_fetch_')).length, 0)
    assert.ok(!calls.some(c => /closeTarget|Browser.close|navigate|Cookie/.test(c.method)))
    await assert.rejects(browserProviderFetch(endpoint, 'target-b', origin, { credentials: 'include', redirect: 'error' }, () => {}), /no native fallback/)
    assert.equal(requests, 2)
  })
})

test('cancellation aborts browser controller, drains fetch and deletes handle before detach', async () => {
  const started = Promise.withResolvers<void>(); let drained = false
  await fixture(async (_url, init) => {
    started.resolve()
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => { drained = true; reject(new Error('private-detail')) }, { once: true }))
  }, async (endpoint, calls, world) => {
    const controller = new AbortController()
    const pending = browserProviderFetch(endpoint, 'target-a', origin, { credentials: 'include', redirect: 'error', signal: controller.signal }, () => {})
    await started.promise; controller.abort()
    await assert.rejects(pending, /cancelled/)
    assert.equal(drained, true)
    assert.equal(Object.keys(world).filter(key => key.startsWith('__shadow_fetch_')).length, 0)
    assert.equal(calls.at(-1).method, 'Target.detachFromTarget')
  })
})

for (const mode of ['cors', 'redirect', 'large']) test(`browser ${mode} failure is sanitized and cleaned`, async () => {
  await fixture(async url => {
    if (mode === 'cors') throw new Error('private cookie secret')
    return { status: 200, url: String(url), type: 'basic', redirected: mode === 'redirect', body: new Response('x'.repeat(262145)).body } as Response
  }, async (endpoint, calls, world) => {
    await assert.rejects(browserProviderFetch(endpoint, 'target-a', origin, { credentials: 'include', redirect: 'error' }, () => {}), error => {
      assert.doesNotMatch(String(error), /private cookie secret/); return true
    })
    assert.equal(Object.keys(world).filter(key => key.startsWith('__shadow_fetch_')).length, 0)
    assert.equal(calls.at(-1).method, 'Target.detachFromTarget')
  })
})


test('lost CDP during pending browser fetch reports cleanup unconfirmed, never confirmed drain', async () => {
  const started = Promise.withResolvers<void>()
  await fixture(async (_url, init) => {
    started.resolve()
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted fixture')), { once: true }))
  }, async (endpoint, _calls, world, disconnect) => {
    const pending = browserProviderFetch(endpoint, 'target-a', origin, { credentials: 'include', redirect: 'error' }, () => {})
    await started.promise; disconnect()
    await assert.rejects(pending, (error: any) => error.code === 'browser_cleanup_unconfirmed')
    // Test-only cleanup of fixture VM, not production access to an unreachable browser.
    for (const key of Object.keys(world).filter(key => key.startsWith('__shadow_fetch_'))) { world[key].abort(); await world[key].done }
  })
})
