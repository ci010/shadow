import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createLiveClient } from './live-client.ts'

function harness(t: TestContext, onReconnecting?: () => void) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sockets: { emit: (type: string, value?: object) => void; acknowledge: () => void }[] = []
  const diagnostics: unknown[] = []
  let tickets = 0
  const client = createLiveClient('https://main.test', {
    ticket: async () => { tickets++; return ['shadow.live.v1', 'secret-ticket'] },
    diagnostic: failure => diagnostics.push(failure),
    status: status => { if (status.phase === 'reconnecting') onReconnecting?.() },
    socket: () => {
      const listeners = new Map<string, EventListener>()
      let id = 0
      const emit = (type: string, value = {}) => listeners.get(type)?.(value as Event)
      sockets.push({ emit, acknowledge: () => emit('message', { data: JSON.stringify({
        type: 'subscribed', id, cursor: 'epoch:0', added: [], removed: [], rejected: [],
      }) }) })
      return { addEventListener: (type, listener) => { listeners.set(type, listener) },
        send: data => { id = JSON.parse(data).id }, close: () => {} }
    },
  })
  client.subscribe({ kind: 'projects' }, { event() {}, reset() {} })
  t.after(() => client.dispose())
  return { client, sockets, diagnostics, tickets: () => tickets,
    async tick(ms: number) { t.mock.timers.tick(ms); await Promise.resolve(); await Promise.resolve() },
    open() { const socket = sockets.at(-1)!; socket.emit('open'); socket.acknowledge(); return socket },
  }
}

test('short acknowledged connections back off to the cap; only sustained readiness resets retries', async t => {
  const h = harness(t)
  await h.tick(0)
  for (const delay of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
    const socket = h.open()
    await h.tick(800)
    socket.emit('close', { code: 1006, reason: 'secret-reason' })
    const count = h.tickets()
    await h.tick(delay - 1)
    assert.equal(h.tickets(), count)
    await h.tick(1)
    assert.equal(h.tickets(), count + 1)
  }
  const stable = h.open()
  await h.tick(30_000)
  stable.emit('close', { code: 1006 })
  assert.deepEqual(h.diagnostics.at(-1), {
    transport: 'ws', stage: 'stream', code: 'closed', closeCode: 1006, retryAttempt: 1, retryDelayMs: 500,
  })
  assert.ok(!JSON.stringify(h.diagnostics).includes('secret'))
  await h.tick(500)
  h.open()
  h.client.dispose()
  const count = h.tickets()
  await h.tick(60_000)
  assert.equal(h.tickets(), count)
  assert.equal(h.client.isLive(), false)
})

test('subscribe timeout and stale socket events share backoff and disposal cancels scheduled retry', async t => {
  const h = harness(t)
  await h.tick(0)
  const first = h.sockets[0]!
  first.emit('open')
  await h.tick(10_000)
  assert.deepEqual(h.diagnostics.at(-1), {
    transport: 'ws', stage: 'subscribe', code: 'timeout', retryAttempt: 1, retryDelayMs: 500,
  })
  await h.tick(500)
  const second = h.open()
  first.emit('close', { code: 1006 })
  second.emit('error')
  second.emit('close', { code: 1006 })
  assert.deepEqual(h.diagnostics.at(-1), {
    transport: 'ws', stage: 'stream', code: 'closed', closeCode: 1006, retryAttempt: 2, retryDelayMs: 1000,
  })
  const count = h.tickets()
  h.client.dispose()
  await h.tick(60_000)
  assert.equal(h.tickets(), count)
  assert.equal(h.diagnostics.length, 2)
})

test('synchronous status subscribers cannot bypass or duplicate the reconnect deadline', async t => {
  let added = false
  const h = harness(t, () => {
    if (added) return
    added = true
    h.client.subscribe({ kind: 'resources', projectId: 'default' }, { event() {}, reset() {} })
  })
  await h.tick(0)
  h.open().emit('close', { code: 1006 })
  assert.equal(added, true)
  await h.tick(0)
  assert.equal(h.tickets(), 1)
  await h.tick(499)
  assert.equal(h.tickets(), 1)
  await h.tick(1)
  assert.equal(h.tickets(), 2)
  h.open()
  await h.tick(1000)
  assert.equal(h.tickets(), 2)
})
