import test from 'node:test'
import assert from 'node:assert/strict'
import { coalescedRead } from './settings-resource.ts'
import { createProjectSettingsClient } from './project-settings.ts'
import type { ResourceLivePool } from './live-resource-refresh.ts'
import type { LiveObserver } from './live-client.ts'
const config = (model: string) => ({ agent: { model, workspace: '/synthetic', temperature: 0.7 } })
test('pending reads coalesce but caller abort and completed reads never poison other callers', async () => {
  let finish!: (value: number) => void
  let reads = 0
  const request = (() => {}) as unknown as typeof fetch
  const load = () => { reads++; return new Promise<number>(resolve => { finish = resolve }) }
  const controller = new AbortController()
  const first = coalescedRead(request, 'a', load, controller.signal)
  const second = coalescedRead(request, 'a', load)
  controller.abort(); await assert.rejects(first)
  finish(1); assert.equal(await second, 1); assert.equal(reads, 1)
  const third = coalescedRead(request, 'a', load); await Promise.resolve(); finish(2)
  assert.equal(await third, 2); assert.equal(reads, 2)
})
test('config survives client recreation, isolates hosts/projects, invalidates on save and reconnect', async t => {
  let model = 'one', reads = 0
  const observers: LiveObserver[] = [], dispose: (() => void)[] = []
  const pool: ResourceLivePool = {
    client: () => ({ subscribe(_topic, observer) { observers.push(observer); return { ready: async () => {}, close() {} } } }),
    observeHost: (_base, observer) => { observer({ phase: 'live' }); return () => {} },
    onDispose: callback => { dispose.push(callback); return () => {} },
  }
  t.after(() => dispose.forEach(callback => callback()))
  const request: typeof fetch = async (_url, init) => {
    if (init?.method !== 'PATCH') reads++
    return Response.json(config(model))
  }
  const client = (base = 'http://fixture/projects/a') => createProjectSettingsClient(base, request, pool)
  assert.equal((await client().load()).agent.model, 'one')
  await Promise.all([client().load(), client().load()]); assert.equal(reads, 1)
  await client('http://other/projects/a').load(); await client('http://fixture/projects/b').load(); assert.equal(reads, 3)
  model = 'two'; await client().save('agent', { model })
  assert.equal((await client().load()).agent.model, 'two'); assert.equal(reads, 5)
  model = 'three'; observers[0]!.reconnected()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal((await client().load()).agent.model, 'three')
  model = 'four'
  observers[0]!.event({ type: 'event', cursor: 'fixture:1', topic: { kind: 'resources', projectId: 'a' }, payload: { event: 'invalidate', resource: 'config' } })
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal((await client().load()).agent.model, 'four')
})

test('shared transports time out, abort network and permit a fresh retry without caller cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const request = (() => {}) as unknown as typeof fetch
  let transport!: AbortSignal
  const first = coalescedRead(request, 'timeout', signal => {
    transport = signal
    return new Promise<number>(() => {})
  })
  const rejected = assert.rejects(first, { name: 'TimeoutError' })
  await Promise.resolve()
  t.mock.timers.tick(12_000)
  await rejected
  assert.equal(transport.aborted, true)
  assert.equal(await coalescedRead(request, 'timeout', async () => 42), 42)
})

test('failed shared reads are removed for retry', async () => {
  const request = (() => {}) as unknown as typeof fetch
  await assert.rejects(coalescedRead(request, 'failure', async () => { throw new Error('offline') }), /offline/)
  assert.equal(await coalescedRead(request, 'failure', async () => 'recovered'), 'recovered')
})
