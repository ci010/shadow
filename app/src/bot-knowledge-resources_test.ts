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

test('Knowledge revision-scoped details survive page changes without another reader or a cross-scope cache hit', async () => {
  let reads = 0
  const owner = createKnowledgeResources(async input => {
    reads++
    const id = new URL(String(input)).searchParams.get('id')!
    return Response.json({ entry: { id, path: id, title: id, kind: 'wiki', source: 'project', deletable: true, revision: 'r1' }, content: '# immutable' })
  })
  try {
    const a = owner.detail('http://fixture/projects/a', 'a', 'memory/a.md', 'r1')
    await a.read(); const value = a.state.value.value; a.release()
    const again = owner.detail('http://fixture/projects/a', 'a', 'memory/a.md', 'r1')
    await again.read(); assert.equal(reads, 1); assert.equal(again.state.value.value, value)
    const other = owner.detail('http://fixture/projects/b', 'b', 'memory/a.md', 'r1')
    await other.read(); assert.equal(reads, 2); assert.notEqual(other.state, again.state)
    again.release(); other.release()
  } finally { owner.dispose() }
})

test('confirmed Knowledge deletion updates every catalog consumer even when refresh fails', async () => {
  const entry = (id: string) => ({ id, path: id, title: id, kind: 'wiki', source: 'project', deletable: true, revision: 'r1' })
  let fail = false
  const owner = createKnowledgeResources(async () => fail ? new Response('', { status: 500 }) : Response.json({
    entries: [entry('memory/a.md'), entry('memory/b.md')],
    links: [{ source: 'memory/a.md', target: 'memory/b.md', label: 'outgoing' }, { source: 'memory/b.md', target: 'memory/a.md', label: 'incoming' }],
  }))
  const a = owner.catalog('http://fixture/projects/a', 'a'), b = owner.catalog('http://fixture/projects/a', 'a')
  try {
    await a.read()
    a.removeEntry('memory/a.md')
    assert.deepEqual(b.state.value.value?.entries.map(entry => entry.id), ['memory/b.md'])
    assert.deepEqual(b.state.value.value?.links.map(link => link.label), ['incoming'])
    fail = true; await b.refresh()
    assert.equal(b.state.value.status, 'error')
    assert.deepEqual(b.state.value.value?.entries.map(entry => entry.id), ['memory/b.md'])
    a.release(); a.removeEntry('memory/b.md')
    assert.equal(b.state.value.value?.entries.length, 1, 'A released command lease cannot mutate a remaining consumer')
  } finally { a.release(); b.release(); owner.dispose() }
})

test('returning to a failed Knowledge detail retries instead of retaining a failed page', async () => {
  let reads = 0
  const owner = createKnowledgeResources(async () => ++reads === 1 ? new Response('', { status: 503 }) : Response.json({
    entry: { id: 'memory/a.md', path: 'memory/a.md', title: 'A', kind: 'wiki', source: 'project', deletable: true, revision: 'r1' }, content: '# A',
  }))
  try {
    const failed = owner.detail('http://fixture/projects/a', 'a', 'memory/a.md', 'r1')
    await failed.read(); assert.equal(failed.state.value.status, 'error'); failed.release()
    const retry = owner.detail('http://fixture/projects/a', 'a', 'memory/a.md', 'r1')
    await retry.read(); assert.equal(reads, 2); assert.equal(retry.state.value.value?.content, '# A'); retry.release()
  } finally { owner.dispose() }
})

test('Knowledge detail retention never borrows a different revision and bounds inactive pages', async () => {
  let reads = 0, revision = 'r1'
  const owner = createKnowledgeResources(async input => {
    reads++
    const id = new URL(String(input)).searchParams.get('id')!
    return Response.json({ entry: { id, path: id, title: id, kind: 'wiki', source: 'project', deletable: true, revision }, content: `# ${revision}` })
  })
  try {
    const read = async (id: string) => {
      const lease = owner.detail('http://fixture/projects/a', 'a', id, revision)
      await lease.read(); const value = lease.state.value.value; lease.release(); return value
    }
    await read('memory/a.md')
    revision = 'r2'
    assert.equal((await read('memory/a.md'))?.content, '# r2')
    assert.equal(reads, 2, 'A revised page cannot reuse its previous body')
    for (let index = 0; index < 17; index++) await read(`memory/page-${index}.md`)
    const before = reads
    await read('memory/a.md')
    assert.equal(reads, before + 1, 'Inactive pages beyond the 16-entry bound must be reread')
  } finally { owner.dispose() }
})
