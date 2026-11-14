import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pack, unpack, keyedWork, unkeyedWork, keyedMaintenance, unkeyedMaintenance, type Json } from './snapshot-wire.ts'
import { createSnapshotResponder } from './snapshot-server.ts'
import { createSnapshotReader } from '../../app/src/snapshot-reader.ts'
import { projectWorkLiveOverviewSchema, projectWorkOverviewSchema } from '../projects/work-overview.ts'

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const work = () => ({ items: [], requests: [], effects: [], sessions: Array.from({ length: 2322 }, (_, index) => ({ sessionId: `web:session-${index}`, title: 'A representative conversation title repeated as topic', topic: 'A representative conversation title repeated as topic', assignable: true, lastActivityAt: '2026-11-14T00:00:00Z', topicSequence: 1 })) })

test('dictionary round trip is lossless, including adversarial strings and prototype keys', () => {
  const value = JSON.parse('{"__proto__":{"constructor":"hello"},"array":[0,1,[2,"hello"]],"null":null}') as Json
  const packed = pack(value)
  assert.equal(JSON.stringify(unpack(packed.data, packed.dictionary)), JSON.stringify(value))
  assert.throws(() => unpack([0, 99], []))
})

test('keyed work delta changes exactly one session; deletion, no-change, isolation and restart resync', async () => {
  const respond = createSnapshotResponder(), other = createSnapshotResponder()
  let value = work()
  const responses: any[] = []
  const reader = createSnapshotReader(async version => { const result = respond(keyedWork(value), version); responses.push(result); return result }, input => projectWorkLiveOverviewSchema.parse(input), unkeyedWork)
  assert.equal((await reader.load()).sessions.length, 2322)
  value.sessions[120]!.lastActivityAt = '2026-11-14T01:00:00Z'; value.sessions[120]!.topicSequence++
  assert.equal((await reader.load()).sessions[120]!.topicSequence, 2)
  const changed = unpack(responses[1].data, responses[1].dictionary) as any[]
  assert.equal(changed.length, 2)
  assert(changed.every(change => change[0][1] === 'entries' && change[0][2] === 'web:session-120'))
  await reader.load()
  assert.deepEqual(unpack(responses[2].data, responses[2].dictionary), [])
  assert(bytes(responses[2]) < 350)
  value.sessions.splice(120, 1)
  assert(!(await reader.load()).sessions.some(session => session.sessionId === 'web:session-120'))
  assert.equal(other(keyedWork(value), responses[0].version).base, undefined)
  assert.equal(createSnapshotResponder()(keyedWork(value), responses[0].version).base, undefined)
  const bounded = createSnapshotResponder(1)
  const oversized = bounded(keyedWork(value))
  assert.equal(bounded(keyedWork(value), oversized.version).base, undefined)
  const evicting = createSnapshotResponder()
  const oldest = evicting({ count: 0 })
  for (let count = 1; count <= 4; count++) evicting({ count })
  assert.equal(evicting({ count: 5 }, oldest.version).base, undefined)
  console.log('synthetic work bytes', { legacy: bytes(work()), initial: bytes(responses[0]), oneSessionDelta: bytes(responses[1]), unchanged: bytes(responses[2]) })
})

test('reader resyncs invalid bases and corrupt deltas, does not commit aborted reads, supports old servers', async () => {
  const respond = createSnapshotResponder()
  let calls = 0, malformed = false
  const reader = createSnapshotReader(async version => {
    calls++
    if (malformed && version) return { ...respond({ ok: true }, version), base: 'wrong-base' }
    return respond({ ok: true }, version)
  }, value => { assert.deepEqual(JSON.parse(JSON.stringify(value)), { ok: true }); return value })
  await reader.load(); malformed = true
  await reader.load(); assert.equal(calls, 3)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(reader.load(controller.signal)); assert.equal(calls, 3)
  assert.deepEqual(await createSnapshotReader(async () => ({ legacy: true }), value => value).load(), { legacy: true })
})

test('maintenance initial packing reduces repeated finding data and subsequent scanning changes are tiny', async () => {
  const finding = (index: number) => ({ id: `finding-${index}-source-reference`, sourceId: `wiki:source-${index % 80}`, sourceTitle: `Knowledge source ${index % 80}`, target: `wiki:missing-${index % 100}`, label: 'Missing knowledge link', reason: 'missing', repairable: true, message: 'The referenced knowledge entry does not exist in the current project catalog. Review the source before repairing this missing link.' })
  let value: any = { intervalMs: 86400000, scanning: false, report: { id: 'report-1', scannedAt: '2026-11-14T00:00:00Z', entriesScanned: 1000, findings: Array.from({ length: 5979 }, (_, index) => finding(index)) } }
  const responses: any[] = [], respond = createSnapshotResponder()
  const reader = createSnapshotReader(async version => { const result = respond(keyedMaintenance(value), version); responses.push(result); return result }, value => value, unkeyedMaintenance)
  assert.deepEqual(await reader.load(), value)
  assert(bytes(responses[0]) < bytes(value) * 0.6)
  value.scanning = true
  assert.deepEqual(await reader.load(), value); assert(bytes(responses[1]) < 400)
  value.report.findings[3].message = 'Updated finding'
  assert.deepEqual(await reader.load(), value); assert(bytes(responses[2]) < 500)
  value.report = null
  assert.deepEqual(await reader.load(), value)
  console.log('synthetic maintenance bytes', { legacy: bytes({ ...value, report: { id: 'report-1', scannedAt: '2026-11-14T00:00:00Z', entriesScanned: 1000, findings: Array.from({ length: 5979 }, (_, index) => finding(index)) } }), initial: bytes(responses[0]), scanningDelta: bytes(responses[1]), findingDelta: bytes(responses[2]) })
})

test('live overview strips excerpt text and retry internals but preserves evidence identity/kind and legacy validation', () => {
  const value: any = { ...work(), focus: { inferredAt: '2026-11-14T00:00:00Z', origin: 'model_interpretation', inputCount: 1, omittedCount: 0, sources: [{ key: 'session:x', sequence: 1 }], result: { groups: [{ category: 'Topic', purpose: 'Purpose', motivation: 'Motivation', topicKeys: ['session:x'], cards: [{ id: 'card', title: 'Outcome', state: 'planned', markdown: 'Plan', sources: [{ sessionId: 'x', physicalId: 'x.1', id: 'message' }], stateSources: [{ sessionId: 'x', physicalId: 'x.1', id: 'message' }] }] }] }, evidence: [{ sessionId: 'x', physicalId: 'x.1', id: 'message', kind: 'human', text: 'Private raw excerpt'.repeat(100) }] } }
  const full = projectWorkOverviewSchema.parse(value), live = projectWorkLiveOverviewSchema.parse(full)
  assert.equal(full.focus!.evidence![0]!.text, value.focus.evidence[0].text)
  assert(!Object.hasOwn(live.focus!.evidence![0]!, 'text'))
  assert.equal(live.focus!.evidence![0]!.kind, 'human')
  assert(bytes(live) < bytes(full) - 1000)
  const badProvenance = structuredClone(live)
  badProvenance.focus!.evidence![0]!.kind = 'assistant'
  assert.throws(() => projectWorkLiveOverviewSchema.parse(badProvenance))
  assert.throws(() => projectWorkOverviewSchema.parse(live))
  assert.throws(() => projectWorkLiveOverviewSchema.parse({ ...live, focus: { ...live.focus, inputCount: 2 } }))
})

test('real Work and maintenance HTTP routes preserve authorization, legacy JSON and resource-local cursors', async () => {
  const { Hono } = await import('hono')
  const { projectWorkPlugin } = await import('../projects/work-routes.ts')
  const { registerKnowledgeRoutes } = await import('../knowledge/routes.ts')
  const { createKnowledgeMaintenanceClient } = await import('../../app/src/knowledge-maintenance.ts')
  const app = new Hono()
  let scanning = false
  for (const project of ['a', 'b']) {
    const routes = new Hono()
    const authorize = (request: Request) => request.headers.get('authorization') === 'fixture'
    const sessions = { alignment: { store: { workRecords: () => [], projectFocus: () => undefined, workEffects: () => [] } }, listHistoryStates: async () => [] }
    projectWorkPlugin(sessions as any, authorize)(routes)
    registerKnowledgeRoutes(routes, { workspace: process.cwd(), skills: {} as any, authorize, maintenance: { status: () => ({ intervalMs: 86400000, scanning, report: null }) } as any })
    app.route(`/projects/${project}`, routes)
  }
  const headers = { authorization: 'fixture' }
  for (const path of ['/api/work', '/api/knowledge/maintenance']) {
    assert.equal((await app.request('/projects/a' + path + '?transport=snapshot-v1')).status, 401)
    const legacy = await app.request('/projects/a' + path, { headers })
    assert.equal(legacy.headers.get('cache-control'), 'no-store')
    assert.equal((await legacy.json()).protocol, undefined)
    const first = await (await app.request('/projects/a' + path + '?transport=snapshot-v1', { headers })).json()
    const again = await (await app.request('/projects/a' + path + '?transport=snapshot-v1&since=' + first.version, { headers })).json()
    assert.equal(again.base, first.version)
    assert.deepEqual(unpack(again.data, again.dictionary), [])
    const other = await (await app.request('/projects/b' + path + '?transport=snapshot-v1&since=' + first.version, { headers })).json()
    assert.equal(other.base, undefined)
  }
  const calls: URL[] = []
  const client = createKnowledgeMaintenanceClient('http://fixture/projects/a', (async (input, init) => {
    const url = new URL(String(input)); calls.push(url)
    return app.request(url.pathname + url.search, { ...init, headers })
  }) as typeof fetch)
  assert.equal((await client.status()).scanning, false)
  scanning = true
  assert.equal((await client.status()).scanning, true)
  assert(calls[1]!.searchParams.has('since'))
  assert(calls.every(url => url.pathname === '/projects/a/api/knowledge/maintenance'))
})
