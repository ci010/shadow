import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionGraphLoader } from './session-graph-snapshot.ts'

const graph = () => ({ sessions: [
  { sessionId: 'web:root', title: 'Root', parentSessionId: null },
  { sessionId: 'web:child', title: 'Child', parentSessionId: null },
], nodes: [
  { physicalId: 'root-physical', logicalId: 'web:root', parentPhysicalId: null },
  { physicalId: 'child-physical', logicalId: 'web:child', parentPhysicalId: 'root-physical' },
] })
const signal = () => new AbortController().signal

test('known session summaries patch the complete graph without dropping other rows or physical parents', async () => {
  const urls: URL[] = []
  let title = 'Root'
  const request: typeof fetch = async input => {
    const url = new URL(String(input)); urls.push(url)
    const value = graph(); value.sessions[0].title = title
    const query = url.searchParams.get('sessionIds')
    if (!query) return Response.json(value)
    const ids = JSON.parse(query) as string[]
    return Response.json({ partial: true, sessionIds: ids,
      sessions: value.sessions.filter(row => ids.includes(row.sessionId)),
      nodes: value.nodes.filter(node => ids.includes(node.logicalId)) })
  }
  const loader = createSessionGraphLoader('http://main/projects/a', 'a', request)
  const initial = await loader.load(signal())
  assert.equal(initial.find(row => row.sessionId === 'web:child')?.contextParentSessionId, 'web:root')
  title = 'Updated'
  loader.invalidate({ event: 'invalidate', sessionId: 'web:root', changes: ['history'] })
  const updated = await loader.load(signal())
  assert.deepEqual(JSON.parse(urls[1].searchParams.get('sessionIds')!), ['web:root'])
  assert.equal(updated.find(row => row.sessionId === 'web:root')?.title, title)
  assert.equal(updated.find(row => row.sessionId === 'web:child')?.contextParentSessionId, 'web:root')
  assert.equal(updated.length, 2)
  loader.invalidate({ event: 'invalidate', sessionId: 'web:root', changes: ['metadata', 'activity', 'work', 'background-tasks', 'scheduled-tasks'] })
  await loader.load(signal())
  assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), true, 'known metadata updates stay scoped even when several resources change')
  loader.invalidate({ event: 'invalidate', sessionId: 'web:new', changes: ['history'] })
  await loader.load(signal())
  assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), false, 'unknown/created rows recover full topology')
  loader.invalidate({ event: 'invalidate', sessionId: 'web:root' })
  await loader.load(signal())
  assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), true, 'legacy scoped events revalidate known topology')
  loader.invalidate({ event: 'invalidate' })
  await loader.load(signal())
  assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), false, 'global broad events stay full')
  loader.reset()
  await loader.load(signal())
  assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), false, 'recovery does not use a partial base')
})

test('missing or mis-scoped summary responses recover full graph instead of corrupting the cache', async () => {
  let partial: unknown = { partial: true, sessionIds: ['web:root'], sessions: [], nodes: [] }
  const urls: URL[] = []
  const request: typeof fetch = async input => {
    const url = new URL(String(input)); urls.push(url)
    return Response.json(url.searchParams.has('sessionIds') ? partial : graph())
  }
  const loader = createSessionGraphLoader('http://main/projects/a', 'a', request)
  await loader.load(signal())
  for (const bad of [partial, { partial: true, sessionIds: ['web:other'], sessions: [graph().sessions[0]], nodes: [] }]) {
    partial = bad
    loader.invalidate({ sessionId: 'web:root', changes: ['history'] })
    assert.equal((await loader.load(signal())).length, 2)
    assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), false)
  }
})

test('legacy full responses remain compatible; aborted reads cannot mutate the graph base', async () => {
  const urls: URL[] = []
  let finish!: (response: Response) => void
  let delayed = false
  const request: typeof fetch = async input => {
    urls.push(new URL(String(input)))
    if (delayed) return new Promise(resolve => { finish = resolve })
    return Response.json(graph())
  }
  const loader = createSessionGraphLoader('http://main/projects/a', 'a', request)
  await loader.load(signal())
  loader.invalidate({ sessionId: 'web:root', changes: ['history'] })
  assert.equal((await loader.load(signal())).length, 2)
  delayed = true
  const controller = new AbortController()
  loader.invalidate({ sessionId: 'web:root', changes: ['history'] })
  const pending = loader.load(controller.signal)
  await Promise.resolve()
  controller.abort()
  finish(Response.json({ sessions: [], nodes: [] }))
  await assert.rejects(pending)
  delayed = false
  await loader.load(signal())
  assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), false)
})


test('full revalidation can reuse 304 after a partial patch without confusing the two graph bases', async () => {
  const seen: Array<{ url: URL; etag: string | null }> = []
  let mode = 'full'
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    seen.push({ url, etag: new Headers(init?.headers).get('If-None-Match') })
    if (url.searchParams.has('sessionIds')) {
      const value = graph()
      value.sessions[0].title = 'Partial newer title'
      return Response.json({ partial: true, sessionIds: ['web:root'], sessions: [value.sessions[0]], nodes: [value.nodes[0]] }, { headers: { ETag: '"partial"' } })
    }
    if (mode === 'unchanged') return new Response(null, { status: 304 })
    return Response.json(graph(), { headers: { ETag: '"full"' } })
  }
  const loader = createSessionGraphLoader('http://main/projects/a', 'a', request)
  const first = await loader.load(signal())
  loader.invalidate({ sessionId: 'web:root', changes: ['metadata'] })
  assert.equal((await loader.load(signal()))[0].title, 'Partial newer title')
  assert.equal(seen[1].etag, null, 'partial request does not use a full-graph validator')
  loader.reset()
  mode = 'unchanged'
  const restored = await loader.load(signal())
  assert.equal(seen[2].etag, '"full"')
  assert.equal(restored, first, '304 authoritatively validates the original full body, not the patched base')
  assert.equal(restored[0].title, 'Root')
})


test('scoped ended/task metadata events use bounded reads; topology changes and deletion recover full', async () => {
  const urls: URL[] = []
  let value: ReturnType<typeof graph> = graph()
  const request: typeof fetch = async input => {
    const url = new URL(String(input)); urls.push(url)
    if (!url.searchParams.has('sessionIds')) return Response.json(value)
    return Response.json({ partial: true, sessionIds: ['web:root'],
      sessions: value.sessions.filter(row => row.sessionId === 'web:root'),
      nodes: value.nodes.filter(row => row.logicalId === 'web:root') })
  }
  const loader = createSessionGraphLoader('http://main/projects/a', 'a', request)
  await loader.load(signal())
  // Actual wire shape emitted by session.ended and TopicService.changed.
  loader.invalidate({ event: 'invalidate', sessionId: 'web:root' })
  Object.assign(value.sessions[0], { executionStatus: 'completed', completed: true, lastActivityAt: '2026-11-02' })
  await loader.load(signal())
  assert.equal(urls.length, 2)
  assert.ok(urls[1].searchParams.has('sessionIds'))
  // Task review/worker metadata uses session.changed's current resource hints.
  loader.invalidate({ event: 'invalidate', sessionId: 'web:root', changes: ['metadata', 'activity', 'work', 'background-tasks', 'scheduled-tasks'] })
  value.sessions[0].title = 'Reviewed'
  assert.equal((await loader.load(signal()))[0].title, 'Reviewed')
  assert.equal(urls.length, 3)
  for (const mutate of [
    (g: ReturnType<typeof graph>) => { g.nodes[0].parentPhysicalId = 'child-physical' },
    (g: ReturnType<typeof graph>) => { Object.assign(g.sessions[0], { parentSessionId: 'web:child' }) },
    (g: ReturnType<typeof graph>) => { Object.assign(g.sessions[0], { createdBySessionId: 'web:child' }) },
    (g: ReturnType<typeof graph>) => { Object.assign(g.nodes[0], { parentIndex: 9 }) },
    (g: ReturnType<typeof graph>) => { g.nodes.push({ ...g.nodes[0], physicalId: 'next-segment' }) },
    (g: ReturnType<typeof graph>) => { g.nodes[0].physicalId = 'replaced-segment' },
    (g: ReturnType<typeof graph>) => { g.sessions.shift(); g.nodes.shift() },
  ]) {
    value = graph()
    loader.reset(); await loader.load(signal())
    mutate(value)
    const before = urls.length
    loader.invalidate({ event: 'invalidate', sessionId: 'web:root' })
    await loader.load(signal())
    assert.equal(urls.length - before, 2, 'one scoped probe followed by authoritative topology recovery')
    assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), false)
  }
})

test('malformed hints, wrong project and new sessions retain full recovery', async () => {
  const urls: URL[] = []
  const request: typeof fetch = async input => { urls.push(new URL(String(input))); return Response.json(graph()) }
  const loader = createSessionGraphLoader('http://main/projects/a', 'a', request)
  await loader.load(signal())
  for (const payload of [
    { sessionId: 'web:root', changes: [] }, { sessionId: 'web:root', changes: ['unknown'] },
    { sessionId: 'web:root', projectId: 'other' }, { sessionId: 'web:root', event: 'unexpected' },
    { sessionId: 'web:new' }, {},
  ]) {
    loader.invalidate(payload); await loader.load(signal())
    assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), false)
  }
})

test('inflight scoped and global invalidations survive earlier responses', async () => {
  const urls: URL[] = []
  let finish: ((response: Response) => void) | undefined
  const request: typeof fetch = async input => {
    const url = new URL(String(input)); urls.push(url)
    if (url.searchParams.has('sessionIds')) return new Promise(resolve => { finish = resolve })
    return Response.json(graph())
  }
  const loader = createSessionGraphLoader('http://main/projects/a', 'a', request)
  await loader.load(signal())
  loader.invalidate({ event: 'invalidate', sessionId: 'web:root' })
  const first = loader.load(signal())
  loader.invalidate({ event: 'invalidate', sessionId: 'web:child' })
  finish!(Response.json({ partial: true, sessionIds: ['web:root'], sessions: [graph().sessions[0]], nodes: [graph().nodes[0]] }))
  await first
  const second = loader.load(signal())
  assert.deepEqual(JSON.parse(urls.at(-1)!.searchParams.get('sessionIds')!), ['web:child'])
  loader.invalidate({ event: 'invalidate' })
  finish!(Response.json({ partial: true, sessionIds: ['web:child'], sessions: [graph().sessions[1]], nodes: [graph().nodes[1]] }))
  await second
  await loader.load(signal())
  assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), false)
})


test('bursts deduplicate scoped IDs and fall back at the 32-session bound', async () => {
  const value = { sessions: Array.from({ length: 33 }, (_, i) => ({ sessionId: `web:s${i}`, title: `Session ${i}` })),
    nodes: Array.from({ length: 33 }, (_, i) => ({ physicalId: `physical-${i}`, logicalId: `web:s${i}`, parentPhysicalId: null })) }
  const urls: URL[] = []
  const request: typeof fetch = async input => {
    const url = new URL(String(input)); urls.push(url)
    const query = url.searchParams.get('sessionIds')
    if (!query) return Response.json(value)
    const ids = JSON.parse(query) as string[]
    return Response.json({ partial: true, sessionIds: ids, sessions: value.sessions.filter(row => ids.includes(row.sessionId)),
      nodes: value.nodes.filter(row => ids.includes(row.logicalId)) })
  }
  const loader = createSessionGraphLoader('http://main/projects/a', 'a', request)
  await loader.load(signal())
  for (let i = 0; i < 32; i++) {
    loader.invalidate({ event: 'invalidate', sessionId: `web:s${i}` })
    loader.invalidate({ event: 'invalidate', sessionId: `web:s${i}` })
  }
  await loader.load(signal())
  assert.equal(JSON.parse(urls.at(-1)!.searchParams.get('sessionIds')!).length, 32)
  for (let i = 0; i < 33; i++) loader.invalidate({ event: 'invalidate', sessionId: `web:s${i}` })
  await loader.load(signal())
  assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), false)
})


test('665-session stable-topology replay replaces eleven full rereads with eleven scoped reads', async t => {
  const value = { sessions: Array.from({ length: 665 }, (_, i) => ({ sessionId: `web:s${i}`, title: `Session ${i}`, executionStatus: 'pending', lastActivityAt: '' })),
    nodes: Array.from({ length: 665 }, (_, i) => ({ physicalId: `physical-${i}`, logicalId: `web:s${i}`, parentPhysicalId: null, timestamp: '' })) }
  let fullReads = 0; let partialReads = 0; let bytes = 0; let baselineBytes = 0
  const request: typeof fetch = async input => {
    const query = new URL(String(input)).searchParams.get('sessionIds')
    baselineBytes += Buffer.byteLength(JSON.stringify(value))
    let body: unknown = value
    if (query) {
      partialReads++
      const ids = JSON.parse(query) as string[]
      body = { partial: true, sessionIds: ids, sessions: value.sessions.filter(row => ids.includes(row.sessionId)),
        nodes: value.nodes.filter(row => ids.includes(row.logicalId)) }
    } else fullReads++
    bytes += Buffer.byteLength(JSON.stringify(body))
    return Response.json(body)
  }
  const loader = createSessionGraphLoader('http://main/projects/a', 'a', request)
  await loader.load(signal())
  for (let i = 0; i < 11; i++) {
    value.sessions[i].executionStatus = 'completed'
    value.sessions[i].lastActivityAt = `2026-11-02T00:00:${i.toString().padStart(2, '0')}Z`
    loader.invalidate({ event: 'invalidate', sessionId: `web:s${i}` })
    assert.equal((await loader.load(signal())).length, 665)
  }
  assert.equal(fullReads, 1)
  assert.equal(partialReads, 11)
  assert.ok(bytes < baselineBytes * 0.1)
  t.diagnostic(`Synthetic replay: 12 full -> ${fullReads} full + ${partialReads} partial; JSON bytes ${baselineBytes} -> ${bytes} (${(100 * (1 - bytes / baselineBytes)).toFixed(1)}% less). Not HAR event attribution or a backend CPU benchmark.`)
})
