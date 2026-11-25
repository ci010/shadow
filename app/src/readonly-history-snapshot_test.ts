import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReadonlyHistorySnapshots } from './readonly-history-snapshot.ts'
import { readonlyHistorySnapshot } from '../../src/sessions/history-snapshot.ts'
import { recentHistoryWindow } from '../../src/shared/history-wire.ts'

const url = new URL('http://localhost/api/sessions/logical?shallow=true')
const signal = () => new AbortController().signal
const initial = () => ({ key: 'logical', total: 1, messages: [{ role: 'user', content: 'first' }],
  commandResults: [] as unknown[], decisionRecords: [] as unknown[], segmentIndex: 0,
  currentPhysicalId: 'physical-0', previousPhysicalId: null as string | null })

test('readonly snapshot validates unchanged, append, receipts/decisions, rewrites and rollover', async () => {
  let data = initial()
  const envelopes: Record<string, any>[] = []
  const cache = createReadonlyHistorySnapshots((async target => {
    const envelope = readonlyHistorySnapshot(data, new URL(String(target)).searchParams)
    envelopes.push(envelope)
    return Response.json(envelope)
  }) as typeof fetch)
  const read = async () => (await cache.read(url, signal())).json()
  assert.deepEqual(await read(), data)
  assert.deepEqual(await read(), data)
  assert.equal(envelopes.at(-1)!.unchanged, true)
  assert.ok(JSON.stringify(envelopes.at(-1)).length < 110)
  data.messages.push({ role: 'assistant', content: 'next' }); data.total++
  assert.deepEqual(await read(), data)
  assert.equal(envelopes.at(-1)!.delta.messages.length, 1)
  data.commandResults.push({ id: 'command' }); data.decisionRecords.push({ id: 'decision' })
  assert.deepEqual(await read(), data)
  assert.equal(envelopes.at(-1)!.delta.messages.length, 0)
  assert.deepEqual(await read(), data)
  data.messages[0] = { role: 'user', content: 'rewritten' }
  assert.deepEqual(await read(), data)
  assert.ok(envelopes.at(-1)!.data)
  data = { ...initial(), currentPhysicalId: 'physical-1', segmentIndex: 1, previousPhysicalId: 'physical-0' }
  assert.deepEqual(await read(), data)
  assert.ok(envelopes.at(-1)!.data)
})

test('recent readonly snapshots merge one earlier page plus concurrently appended rows', async () => {
  const history = Array.from({ length: 82 }, (_, i) => ({ role: 'user', content: `row-${i}` }))
  const envelopes: Record<string, any>[] = []
  const cache = createReadonlyHistorySnapshots((async target => {
    const query = new URL(String(target)).searchParams
    const window = recentHistoryWindow(history, query, 'physical-0')
    const envelope = readonlyHistorySnapshot({ ...initial(), total: history.length, messages: window.messages, historyStart: window.start }, query)
    envelopes.push(envelope)
    return Response.json(envelope)
  }) as typeof fetch)
  const recent = `${url}&historyWindow=recent`
  const read = async (target: string) => (await cache.read(target, signal())).json()
  assert.deepEqual((await read(recent)).messages, history.slice(42))
  history.push({ role: 'assistant', content: 'new' })
  const expanded = `${recent}&historyFrom=2&historyPhysicalId=physical-0`
  const data = await read(expanded)
  assert.equal(data.historyStart, 2)
  assert.deepEqual(data.messages, history.slice(2))
  assert.deepEqual(envelopes.at(-1)?.delta.leadingMessages, history.slice(2, 42))
  assert.deepEqual(envelopes.at(-1)?.delta.messages, history.slice(82))
  assert.deepEqual(await read(expanded), data)
  assert.equal(envelopes.at(-1)?.unchanged, true)
})

test('failed access/network, eviction, disposal and abort never serve stale history', async () => {
  let mode = 'ok'
  let query: URLSearchParams
  const cache = createReadonlyHistorySnapshots((async target => {
    query = new URL(String(target)).searchParams
    if (mode === 'network') throw new Error('network')
    if (mode === 'denied') return Response.json({}, { status: 403 })
    return Response.json(readonlyHistorySnapshot(initial(), query))
  }) as typeof fetch)
  await cache.read(url, signal())
  mode = 'denied'; assert.equal((await cache.read(url, signal())).status, 403)
  mode = 'ok'; await cache.read(url, signal()); assert.equal(query!.get('snapshot'), '')
  mode = 'network'; await assert.rejects(cache.read(url, signal()), /network/)
  mode = 'ok'; await cache.read(url, signal()); assert.equal(query!.get('snapshot'), '')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(cache.read(url, controller.signal), /cancelled/)
  await cache.read(url, signal()); assert.equal(query!.get('snapshot'), '')
  cache.dispose(); await assert.rejects(cache.read(url, signal()), /cancelled/)
  const tiny = createReadonlyHistorySnapshots((async target => Response.json(readonlyHistorySnapshot(initial(), new URL(String(target)).searchParams))) as typeof fetch, 1)
  await tiny.read(url, signal()); await tiny.read(url, signal())
})

test('invalid metadata reference and base delta evict cache and next read is complete', async () => {
  let calls = 0
  const rev = 'a'.repeat(64)
  const cache = createReadonlyHistorySnapshots((async target => {
    calls++
    if (calls === 2) return Response.json({ revision: rev, historyRevision: rev, metadataRevision: rev,
      delta: { baseRevision: rev, baseHistoryRevision: rev, baseCount: 1, count: 1, messages: [], baseMetadataRevision: rev } })
    if (calls === 3) assert.equal(new URL(String(target)).searchParams.get('snapshot'), '')
    return Response.json(readonlyHistorySnapshot(initial(), new URL(String(target)).searchParams))
  }) as typeof fetch)
  await cache.read(url, signal())
  await assert.rejects(cache.read(url, signal()), /delta/)
  assert.deepEqual(await (await cache.read(url, signal())).json(), initial())
})
