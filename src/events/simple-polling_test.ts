import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { CapabilityBroker } from '../execution/grants.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { EventService } from './service.ts'
import { PollingSources } from './polling-sources.ts'
import { SimplePollingSchema, simplePollingResult } from './simple-polling.ts'

const base = { request: { method: 'GET', path: '/changes' }, select: [], eventType: 'remote.changed', completeResponse: true }
const items = SimplePollingSchema.parse({ ...base, mode: 'items', idPath: ['id'], maxItems: 10, contentPath: ['text'], filter: { path: ['active'], equals: true } })
const snapshot = SimplePollingSchema.parse({ ...base, mode: 'snapshot' })

test('simple modes are strict; complete bounded responses and stable IDs are required', () => {
  for (const bad of [
    { ...base, mode: 'items' }, { ...base, mode: 'items', idPath: ['id'], maxItems: 10, pagination: {} },
    { ...base, mode: 'snapshot', completeResponse: false }, { ...base, mode: 'snapshot', request: { method: 'POST', path: '/changes' } },
  ]) assert.equal(SimplePollingSchema.safeParse(bad).success, false)
  assert.throws(() => simplePollingResult(items, Array.from({ length: 10 }, (_, id) => ({ id })), null), /Incomplete/)
  assert.throws(() => simplePollingResult(items, [{ id: 1 }, { id: 1 }], null), /Duplicate/)
  assert.throws(() => simplePollingResult(items, [{}], null), /Missing/)
  const first = simplePollingResult(items, [{ id: 1, active: true }], null)
  assert.deepEqual(first.events, [])
  const next = simplePollingResult(items, [{ id: 1, active: true }, { id: 2, active: false }, { id: 3, active: true, text: 'External text is data' }], first.checkpoint)
  assert.equal(next.events.length, 1)
  assert.equal(simplePollingResult(items, [{ id: 2, active: true }], next.checkpoint).events.length, 0)
  assert.throws(() => simplePollingResult(items, [{ id: 'new', active: true, text: 'x' }], { ids: Array.from({ length: 1000 }, (_, i) => String(i)) }), /capacity/)
})

test('snapshot canonical comparison detects A→B→A without treating key order as change', () => {
  const a = simplePollingResult(snapshot, { a: 1, b: 2 }, null)
  assert.deepEqual(a.events, [])
  assert.deepEqual(simplePollingResult(snapshot, { b: 2, a: 1 }, a.checkpoint).events, [])
  const b = simplePollingResult(snapshot, { a: 2 }, a.checkpoint)
  const again = simplePollingResult(snapshot, { a: 1, b: 2 }, b.checkpoint)
  assert.equal(b.events.length, 1)
  assert.equal(again.events.length, 1)
  assert.notEqual(b.events[0].id, again.events[0].id)
})

for (const mode of ['items', 'snapshot'] as const) test(`simple ${mode}: baseline, failure, deduplication, restart and broker permission`, async () => {
  await withTempWorkspace(async workspace => {
    let body: unknown = mode === 'items' ? [{ id: 'a', active: true, text: 'a' }] : { state: 'a' }
    let status = 200
    let requests = 0
    const delivered: string[] = []
    const broker = new CapabilityBroker({ projectId: 'test', directory: join(workspace, 'receipts'),
      resolveSecret: async () => undefined, deliver: async () => undefined, canDeliver: () => false,
      request: async () => { requests++; return new Response(JSON.stringify(body), { status }) },
    })
    const events = new EventService(workspace, new Bus(), async (id, input) => {
      if (input.kind === 'message') delivered.push(input.content)
      return { status: 'accepted', sessionId: id, inputId: input.id }
    })
    await events.start()
    events.subscribe({ sessionId: 'owner', source: 'custom:watch', event: 'remote.changed' })
    const make = () => new PollingSources(workspace, events, broker, id => id === 'owner', () => false)
    let sources = make()
    sources.start()
    try {
      const config = mode === 'items' ? items : snapshot
      const grant = { id: 'fetch', kind: 'http' as const, origin: 'https://api.example.com', routes: [{ method: 'GET' as const, path: '/changes' }] }
      sources.create({ id: 'watch', ownerSessionId: 'owner', simple: config, intervalMs: 60_000, grant })
      await assert.rejects(sources.run('watch', 'other'), /not found/)
      assert.equal(await sources.run('watch', 'owner'), 0)
      const baseline = sources.inspect('watch', 'owner').checkpoint
      body = mode === 'items' ? [{ id: 'b', active: true, text: 'b' }] : { state: 'b' }
      status = 503
      await assert.rejects(sources.run('watch', 'owner'))
      assert.deepEqual(sources.inspect('watch', 'owner').checkpoint, baseline)
      status = 200
      assert.equal(await sources.run('watch', 'owner'), 1)
      assert.equal(await sources.run('watch', 'owner'), 0)
      await sources.stop()
      sources = make(); sources.start()
      assert.equal(await sources.run('watch', 'owner'), 0)
      assert.equal(delivered.length, 1)
      sources.create({ id: 'denied', ownerSessionId: 'owner', simple: { ...config, request: { method: 'GET', path: '/denied' } }, intervalMs: 60_000, grant })
      events.subscribe({ sessionId: 'owner', source: 'custom:denied', event: 'remote.changed' })
      const before = requests
      await assert.rejects(sources.run('denied', 'owner'))
      assert.equal(requests, before)
      assert.equal(sources.inspect('denied', 'owner').checkpoint, null)
    } finally { await sources.stop(); await events.stop() }
  })
})
