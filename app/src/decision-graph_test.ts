import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DECISION_GRAPH_LIMIT, DECISION_GRAPH_DEPTH, decisionReader, loadDecisionGraph, decisionKey, layoutDecisionGraph } from './decision-graph.ts'
import type { YieldDecisionRecord, YieldReference } from '../../src/sessions/yield-contract.ts'
const ref = (id: string, sessionId = 'web:owner'): YieldReference => ({ sessionId, physicalId: 'segment-0', requestId: id })
const record = (id: string, sources: YieldReference[] = []): YieldDecisionRecord => ({
  request: { id, sessionId: 'web:owner', origin: { physicalId: 'segment-0' }, question: `Question ${id}`,
    options: ['A', 'B'], defaultOption: 'B', recipient: { kind: 'user', sessionId: 'web:owner' },
    createdAt: '2026-09-21T10:00:00Z', deadline: null, ...(sources.length ? { sources } : {}) },
})
test('graph preserves shared sources and cycles as references, never as duplicated session hierarchy', async () => {
  const records = new Map([['a', record('a', [ref('b'), ref('c')])], ['b', record('b', [ref('c')])], ['c', record('c', [ref('a')])]])
  const graph = await loadDecisionGraph(ref('a'), async source => records.get(source.requestId)!, new AbortController().signal)
  assert.equal(graph.nodes.length, 3)
  assert.equal(graph.edges.length, 4)
  assert.equal(graph.limited, false)
  assert.ok(graph.edges.every(edge => edge.kind === 'cites'))
  assert.equal(graph.nodes.filter(node => node.id === decisionKey(ref('c'))).length, 1)
  assert.ok(layoutDecisionGraph(graph).nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)))
})
test('graph bounds breadth and depth and marks partial results explicitly', async () => {
  let reads = 0
  const wide = await loadDecisionGraph(ref('a'), async source => { reads++; return record(source.requestId, [0, 1, 2].map(i => ref(`${source.requestId}${i}`))) }, new AbortController().signal)
  assert.equal(reads, DECISION_GRAPH_LIMIT)
  assert.equal(wide.nodes.length, DECISION_GRAPH_LIMIT)
  assert.equal(wide.limited, true)
  const deep = await loadDecisionGraph(ref('a'), async source => record(source.requestId, [ref(`${source.requestId}x`)]), new AbortController().signal)
  assert.equal(deep.nodes.length, DECISION_GRAPH_DEPTH + 1)
  assert.equal(deep.limited, true)
})
test('missing records stay explicit and aborted reads cannot publish a partial stale graph', async () => {
  const graph = await loadDecisionGraph(ref('a'), async source => {
    if (source.requestId === 'bad') throw new Error('Unavailable source')
    return record('a', [ref('bad')])
  }, new AbortController().signal)
  assert.equal(graph.nodes[1]?.record, undefined)
  assert.equal(graph.nodes[1]?.error, 'Unavailable source')
  const controller = new AbortController()
  await assert.rejects(loadDecisionGraph(ref('a'), async () => { controller.abort(); return record('a') }, controller.signal), { name: 'AbortError' })
})
test('revision links preserve both immutable versions without treating them as a parent-child edge', async () => {
  const old = record('old')
  old.closed = { reason: 'superseded', at: old.request.createdAt, message: 'Remove assumption', replacement: ref('new') }
  const next = record('new')
  next.request = { ...next.request, decisionId: 'old', supersedes: ref('old'), revisionReason: 'Remove assumption', revisionSessionId: 'reviewer' }
  const graph = await loadDecisionGraph(ref('new'), async source => source.requestId === 'new' ? next : old, new AbortController().signal)
  assert.equal(graph.nodes.length, 2)
  assert.deepEqual(graph.edges.map(edge => edge.kind), ['supersedes', 'replacement'])
  assert.equal(graph.limited, false)
})
test('reader retains project base, caches only within a load and rejects mismatched identity', async () => {
  let calls = 0
  const fetcher: typeof fetch = async input => {
    calls++
    const url = new URL(String(input))
    assert.equal(url.pathname, '/projects/example/api/sessions/web%3Aowner/decisions')
    assert.equal(url.searchParams.get('physicalId'), 'segment-0')
    return Response.json({ records: [record('a'), record('b')] })
  }
  const reader = decisionReader('http://localhost/projects/example', new AbortController().signal, fetcher)
  await Promise.all([reader(ref('a')), reader(ref('b'))])
  assert.equal(calls, 1)
  await assert.rejects(reader(ref('missing')), /does not match/)
  const bad: typeof fetch = async () => Response.json({ records: [record('a')] })
  await assert.rejects(decisionReader('http://localhost', new AbortController().signal, bad)(ref('a', 'web:other')), /does not match/)
})

test('reconsideration shows historical invalidation without making it a current premise', async () => {
  const prior = record('prior')
  prior.invalidated = { reference: ref('prior'), reason: 'Fresh pipeline found', at: prior.request.createdAt }
  const current = record('current')
  current.request.reconsiders = ref('prior')
  const graph = await loadDecisionGraph(ref('current'), async source => source.requestId === 'current' ? current : prior, new AbortController().signal)
  assert.deepEqual(graph.edges.map(edge => edge.kind), ['reconsiders'])
  assert.equal(graph.nodes[0]?.record?.invalidated, undefined)
  assert.equal(graph.nodes[1]?.record?.invalidated?.reason, 'Fresh pipeline found')
})
