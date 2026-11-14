import test from 'node:test'
import assert from 'node:assert/strict'
import { createBotResources } from './stores/bots.ts'
import { createKnowledgeResources } from './stores/knowledge.ts'
import type { LiveObserver } from './live-client.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))
function livePool() {
  const observers = new Set<LiveObserver>()
  return { observers, client: () => ({ subscribe: (_: unknown, observer: LiveObserver) => {
    observers.add(observer)
    return { close: () => { observers.delete(observer) }, ready: async () => {} }
  } }), observeHost: (_: string, observer: (status: any) => void) => { observer({ phase: 'live' }); return () => {} } }
}

test('observed BOT groups share a reader and subscription; release, auth and scope remain isolated', async () => {
  const pool = livePool()
  let reads = 0, denied = false
  const owner = createBotResources(async () => { reads++; return denied ? new Response('', { status: 403 }) : Response.json({ revision: 'r1', groups: [], agents: [] }) })
  const options = { apiBase: 'http://fixture/projects/a', projectId: 'a', active: true }
  const a = owner.groups(options, pool), b = owner.groups(options, pool)
  try {
    await tick(); await a.read()
    assert.equal(reads, 1); assert.equal(pool.observers.size, 1); assert.equal(a.state, b.state)
    a.release(); assert.equal(pool.observers.size, 1)
    denied = true; await b.refresh()
    assert.equal(b.state.value.status, 'forbidden'); assert.equal(b.state.value.value, undefined)
    const c = owner.groups({ ...options, projectId: 'b', apiBase: 'http://fixture/projects/b' }, pool)
    await tick(); await c.read(); assert.notEqual(c.state, b.state); c.release()
    b.release(); assert.equal(pool.observers.size, 0)
    const before = reads; await tick(); assert.equal(reads, before)
  } finally { a.release(); b.release(); owner.dispose() }
})

const entry = { id: 'wiki:a', kind: 'wiki', title: 'A', path: 'wiki/a.md', source: 'project', deletable: true, revision: 'r1' }
test('Knowledge catalog and immutable revision details share reads but never prefetch or cross projections', async () => {
  const calls: string[] = []
  let denied = false
  const owner = createKnowledgeResources(async url => {
    calls.push(String(url))
    if (denied) return new Response('', { status: 401 })
    return Response.json(String(url).includes('/entry') ? { entry, content: 'Synthetic body' } : { entries: [entry], links: [] })
  })
  const a = owner.catalog('http://fixture/projects/a', 'a'), b = owner.catalog('http://fixture/projects/a', 'a')
  try {
    await a.read(); assert.equal(calls.length, 1); assert.equal(a.state, b.state)
    const detail = owner.detail('http://fixture/projects/a', 'a', entry.id, entry.revision)
    const second = owner.detail('http://fixture/projects/a', 'a', entry.id, entry.revision)
    await detail.read(); assert.equal(calls.length, 2); assert.equal(detail.state, second.state)
    assert.equal(detail.state.value.value?.content, 'Synthetic body')
    denied = true; await detail.refresh(); assert.equal(detail.state.value.value, undefined)
    assert.equal(detail.state.value.status, 'forbidden')
    detail.release(); second.release()
    const other = owner.catalog('http://fixture/projects/b', 'b'); await other.read()
    assert.notEqual(a.state, other.state); other.release()
  } finally { a.release(); b.release(); owner.dispose() }
})
