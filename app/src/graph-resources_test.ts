import test from 'node:test'
import assert from 'node:assert/strict'
import { createGraphResources } from './stores/graph.ts'
import type { LiveObserver } from './live-client.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))
test('full graph ownership shares readiness and partial adapter; release disposes once and forbids late resurrection', async () => {
  const observers = new Set<LiveObserver>(), calls: URL[] = []
  let ready!: () => void
  const readiness = new Promise<void>(resolve => { ready = resolve })
  const pool = { client: () => ({ subscribe: (_: unknown, observer: LiveObserver) => {
    observers.add(observer); return { ready: () => readiness, close: () => { observers.delete(observer) } }
  } }) }
  const owner = createGraphResources(pool, async input => {
    const url = new URL(String(input)); calls.push(url)
    const sessions = [{ sessionId: 'web:a', title: 'A', parentSessionId: null }]
    const nodes = [{ physicalId: 'a', logicalId: 'web:a', parentPhysicalId: null }]
    return Response.json(url.searchParams.has('sessionIds') ? { sessions, nodes, partial: true, sessionIds: ['web:a'] } : { sessions, nodes })
  })
  const a = owner.acquire('http://fixture/projects/a', 'a'), b = owner.acquire('http://fixture/projects/a/', 'a')
  try {
    const waiting = a.read(); await tick(); assert.equal(calls.length, 0); assert.equal(observers.size, 1)
    ready(); await waiting; assert.equal(calls.length, 1); assert.equal(a.state, b.state)
    const event = { payload: { event: 'invalidate', projectId: 'a', sessionId: 'web:a', changes: ['metadata'] } } as any
    for (const observer of observers) observer.event(event)
    await new Promise(resolve => setTimeout(resolve, 100)); await b.read()
    assert(calls.at(-1)?.searchParams.has('sessionIds'))
    a.release(); assert.equal(observers.size, 1)
    b.release(); assert.equal(observers.size, 0); assert.equal(b.state.value.status, 'disposed')
    const before = calls.length; await tick(); assert.equal(calls.length, before)
  } finally { a.release(); b.release(); owner.dispose() }
})
