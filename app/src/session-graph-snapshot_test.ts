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
  assert.equal(urls.at(-1)!.searchParams.has('sessionIds'), false, 'legacy broad event stays full')
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
