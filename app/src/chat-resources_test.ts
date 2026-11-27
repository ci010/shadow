import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, disposePinia } from 'pinia'
import { createChatResources, useChatResourceStore } from './stores/chat.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 5))
const signal = () => new AbortController().signal
const url = 'http://localhost/api/chat/session?chatId=x'
const scope = { projectId: 'p' }
const revision = 'a'.repeat(64)
const body = { chatId: 'x', currentPhysicalId: 'web:x', previousPhysicalId: null, segmentIndex: 0,
  history: [{ role: 'user', content: 'first' }], systemPrompt: '', tools: [], commandResults: [], decisionRecords: [] }
const envelope = () => ({ revision, historyRevision: revision, metadataVersions: {
  systemPrompt: revision, tools: revision, commandResults: revision, decisionRecords: revision }, data: body })

test('chat leases share active history flights, isolate caller mutation, and preserve adapter validators', async () => {
  const queries: URLSearchParams[] = []
  const owner = createChatResources(async target => {
    queries.push(new URL(String(target)).searchParams)
    return Response.json(queries.length === 1 ? envelope() : { revision, unchanged: true })
  })
  try {
    const [a, b] = await Promise.all([owner.readDirect(url, scope, signal()), owner.readDirect(url, scope, signal())])
    assert.equal(queries.length, 1)
    assert.ok(a.ok && b.ok)
    if (!a.ok || !b.ok) return
    ;(a.data.history as unknown[]).push({ role: 'assistant', content: 'local' })
    assert.equal((b.data.history as unknown[]).length, 1)
    const next = await owner.readDirect(url, scope, signal())
    assert.equal(queries.length, 2)
    assert.equal(queries[1]!.get('snapshot'), revision)
    assert.ok(next.ok)
    if (next.ok) assert.equal((next.data.history as unknown[]).length, 1)
  } finally { owner.dispose() }
})

test('cancelled consumer releases only its lease; last release aborts and rejects late results', async () => {
  const pending: { signal: AbortSignal; resolve: (value: Response) => void }[] = []
  const owner = createChatResources((_url, init) => new Promise(resolve => pending.push({ signal: init!.signal!, resolve })))
  const controller = new AbortController()
  try {
    const a = owner.readDirect(url, scope, controller.signal)
    const cancelled = assert.rejects(a, { name: 'AbortError' })
    const b = owner.readDirect(url, scope, signal())
    await tick(); controller.abort(); await cancelled
    assert.equal(pending.length, 1)
    assert.equal(pending[0]!.signal.aborted, false)
    pending[0]!.resolve(Response.json(envelope()))
    assert.equal((await b).ok, true)
    const last = new AbortController()
    const c = owner.readDirect(url, scope, last.signal)
    const cancelledLast = assert.rejects(c, { name: 'AbortError' })
    await tick(); last.abort(); await cancelledLast
    assert.equal(pending[1]!.signal.aborted, true)
    pending[1]!.resolve(Response.json(envelope()))
    await tick()
  } finally { owner.dispose() }
})

test('project/auth boundaries do not reuse protocol bases or in-flight ownership', async () => {
  const queries: URLSearchParams[] = []
  const owner = createChatResources(async target => {
    queries.push(new URL(String(target)).searchParams)
    return Response.json(envelope())
  })
  try {
    await owner.readDirect(url, scope, signal())
    await owner.readDirect(url, { projectId: 'other' }, signal())
    await owner.readDirect(url, { ...scope, authGeneration: 1 }, signal())
    assert.deepEqual(queries.map(query => query.get('snapshot')), ['', '', ''])
  } finally { owner.dispose() }
})

test('readonly consumers get independently consumable responses and failed access never falls back to history', async () => {
  let reads = 0
  const owner = createChatResources(async () => {
    reads++
    return reads === 1 ? Response.json({ messages: [{ role: 'user', content: 'legacy' }] }) : new Response('denied', { status: 403 })
  })
  try {
    const target = 'http://localhost/api/sessions/logical?shallow=true'
    const [a, b] = await Promise.all([owner.readReadonly(target, scope, signal()), owner.readReadonly(target, scope, signal())])
    assert.equal(reads, 1)
    assert.deepEqual(await a.json(), await b.json())
    const denied = await owner.readReadonly(target, scope, signal())
    assert.equal(denied.status, 403)
    assert.equal(await denied.text(), 'denied')
  } finally { owner.dispose() }
})

for (const kind of ['direct', 'readonly'] as const) {
  const target = new URL(kind === 'direct' ? url : 'http://localhost/api/sessions/logical?shallow=true')
  target.searchParams.set('historyWindow', 'recent')
  target.searchParams.set('historyPhysicalId', 'old-segment')
  target.searchParams.set('historyFrom', '40')
  const error = kind === 'direct' ? 'session_segment_changed' : 'history_conflict'
  const read = (owner: ReturnType<typeof createChatResources>) => kind === 'direct'
    ? owner.readDirect(target, scope, signal()) : owner.readReadonly(target, scope, signal())

  test(`${kind} history retries one segment-change conflict inside the shared read`, async () => {
    const requests: string[] = []
    const owner = createChatResources(async url => {
      requests.push(String(url))
      if (requests.length === 1) return Response.json({ error }, { status: 409 })
      return Response.json(kind === 'direct' ? envelope() : { messages: [] })
    })
    try {
      const [a, b] = await Promise.all([read(owner), read(owner)])
      assert.equal(a.ok && b.ok, true)
      assert.equal(requests.length, 2)
      assert.equal(requests[0], requests[1])
    } finally { owner.dispose() }
  })

  test(`${kind} history surfaces persistent or unrelated conflicts`, async () => {
    for (const [code, expectedReads] of [[error, 2], ['unrelated_conflict', 1]] as const) {
      let reads = 0
      const owner = createChatResources(async () => {
        reads++
        return Response.json({ error: code }, { status: 409 })
      })
      try {
        const result = await read(owner)
        assert.equal(result.status, 409)
        assert.equal(reads, expectedReads)
        const response = result instanceof Response ? result : !result.ok && result.response
        assert.ok(response)
        assert.deepEqual(await response.json(), { error: code })
      } finally { owner.dispose() }
    }
  })
}

test('chat Pinia owners isolate Vue roots, dispose protected memory and reject reads after unmount', async () => {
  const a = createPinia(), b = createPinia()
  const first = useChatResourceStore(a).owner
  assert.notEqual(first, useChatResourceStore(b).owner)
  assert.equal(first, useChatResourceStore(a).owner)
  disposePinia(a)
  await assert.rejects(first.readDirect(url, scope, signal()), /cancelled/)
  disposePinia(b)
})

test('context and physical projections share only on-demand flights, without prefetch or idle reads', async () => {
  let reads = 0
  const owner = createChatResources(async () => { reads++; return Response.json({ messages: [], systemPrompt: 'context' }) })
  try {
    await tick(); assert.equal(reads, 0)
    const [a, b] = await Promise.all([
      owner.readDocument(url, scope, signal(), 'context-v1'),
      owner.readDocument(url, scope, signal(), 'context-v1'),
    ])
    assert.equal(reads, 1)
    assert.deepEqual(await a.json(), await b.json())
    await owner.readDocument(url, scope, signal(), 'physical-history-v1')
    assert.equal(reads, 2)
    await tick(); assert.equal(reads, 2)
  } finally { owner.dispose() }
})
