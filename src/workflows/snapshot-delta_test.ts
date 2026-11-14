import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkflowSnapshotDelta } from './snapshot-delta.ts'
import { createWorkflowClient } from '../../app/src/workflows.ts'

const definition = (id: string) => ({ id, revision: 1, enabled: true, source: { kind: 'external', id: 'source' }, nodes: [{ kind: 'record' }] })
const state = () => ({ projectId: 'p', definitions: [definition('a'), definition('b')], runs: [] as ({ id: string } & Record<string, unknown>)[] })

test('workflow reconciliation: full once, noop identity, add/update/delete and retained run removal', async () => {
  const reconcile = createWorkflowSnapshotDelta()
  const snapshot = state()
  const responses: Record<string, unknown>[] = [], urls: URL[] = []
  const client = createWorkflowClient('http://localhost', 'p', async input => {
    const url = new URL(String(input)); urls.push(url)
    const response = reconcile(snapshot, url.searchParams.get('since') ?? undefined)
    responses.push(response)
    return Response.json(response)
  })
  const signal = new AbortController().signal
  const first = await client.read(signal)
  const noop = await client.read(signal)
  assert.equal(first, noop)
  assert.equal(responses[0].kind, 'full'); assert.equal(responses[1].kind, 'noop')
  const noopBytes = JSON.stringify(responses[1]).length, fullBytes = JSON.stringify(responses[0]).length
  assert.ok(noopBytes < fullBytes)
  snapshot.definitions[0].enabled = false // Mutating runtime objects must not mutate retained versions.
  snapshot.definitions.push(definition('c'))
  snapshot.definitions.splice(1, 1)
  snapshot.runs.push({ id: 'run', workflow: 'a', definition: definition('a'), timestamp: '2026-01-01T00:00:00Z', status: 'queued', cursor: 0, attempts: 0, nextAt: 0, started: false })
  const changed = await client.read(signal)
  assert.deepEqual(changed.definitions.map(d => d.id), ['a', 'c'])
  assert.equal(changed.definitions[0].enabled, false)
  assert.equal(first.definitions[0].enabled, true)
  assert.equal(responses[2].kind, 'delta')
  const retained = changed.definitions[1]
  snapshot.runs[0].status = 'completed'
  const completed = await client.read(signal)
  assert.equal(completed.runs[0].status, 'completed')
  assert.equal(completed.definitions, changed.definitions)
  assert.equal(completed.definitions[1], retained)
  snapshot.runs.length = 0
  assert.equal((await client.read(signal)).runs.length, 0)
  assert.equal(urls.filter(url => !url.searchParams.has('since')).length, 1)
  assert.equal(responses.filter(value => value.kind === 'full').length, 1)
  console.log(`workflow fixture: ${urls.length} requests, 1 full, ${fullBytes} full bytes vs ${noopBytes} noop bytes`)
})

test('expired/restarted/incompatible cursors resync, cache bounded and Project versions isolated', async () => {
  let now = 0
  const reconcile = createWorkflowSnapshotDelta({ now: () => now, ttlMs: 100 })
  const snapshot = state(), initial = reconcile(snapshot)
  assert.equal(reconcile(snapshot, initial.cursor).kind, 'noop')
  now = 101
  assert.equal(reconcile(snapshot, initial.cursor).kind, 'full')
  assert.equal(createWorkflowSnapshotDelta()(snapshot, initial.cursor).kind, 'full')
  assert.equal(createWorkflowSnapshotDelta({ maxBytes: 1 })(snapshot, initial.cursor).kind, 'full')
  assert.equal(reconcile(snapshot, 'wf2-unknown').kind, 'full')
  const bounded = createWorkflowSnapshotDelta()
  const oldest = bounded(snapshot)
  for (let i = 0; i < 9; i++) bounded({ ...snapshot, runtimeError: `failure-${i}` })
  assert.equal(bounded(snapshot, oldest.cursor).kind, 'full')
  const isolated = createWorkflowSnapshotDelta()
  assert.equal(isolated({ ...snapshot, projectId: 'other' }, initial.cursor).kind, 'full')
  let calls = 0
  const client = createWorkflowClient('http://localhost', 'p', async () => {
    calls++
    if (calls === 2) return Response.json({ version: 2, kind: 'delta' })
    return Response.json({ version: 1, kind: 'full', cursor: String(calls), snapshot })
  })
  const signal = new AbortController().signal
  const first = await client.read(signal)
  assert.equal(await client.read(signal), first)
  assert.equal(calls, 3)
})

test('cancelled response cannot advance the cursor and invalid Project data is rejected', async () => {
  const controller = new AbortController()
  const client = createWorkflowClient('http://localhost', 'p', async () => {
    controller.abort()
    return Response.json({ version: 1, kind: 'full', cursor: 'x', snapshot: state() })
  })
  await assert.rejects(client.read(controller.signal), { name: 'AbortError' })
  const wrong = createWorkflowClient('http://localhost', 'p', async () => Response.json({ version: 1, kind: 'full', cursor: 'x', snapshot: { ...state(), projectId: 'other' } }))
  await assert.rejects(wrong.read(new AbortController().signal))
})

test('HTTP sync retains authorization and legacy contract; wire versions are Project-router local', async () => {
  const { Hono } = await import('hono')
  const { registerWorkflowRoutes } = await import('./management.ts')
  const snapshot = { ...state(), sources: [], records: { privateRecord: 'not-needed-by-graph' }, mappings: {} }
  const app = new Hono()
  registerWorkflowRoutes(app, { inspect: () => snapshot } as unknown as import('./runtime.ts').WorkflowRuntime, request => request.headers.get('x-owner') === 'yes')
  assert.equal((await app.request('/api/workflows?sync=1')).status, 403)
  const headers = { 'x-owner': 'yes' }
  const legacy = await (await app.request('/api/workflows', { headers })).json()
  assert.equal(legacy.records.privateRecord, 'not-needed-by-graph')
  const response = await app.request('/api/workflows?sync=1', { headers })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const full = await response.json()
  assert.equal(full.kind, 'full'); assert.equal(full.snapshot.records, undefined)
  const noop = await (await app.request(`/api/workflows?sync=1&since=${full.cursor}`, { headers })).json()
  assert.equal(noop.kind, 'noop')
  assert.equal((await app.request(`/api/workflows?sync=1&since=${full.cursor}`)).status, 403)
  snapshot.definitions.pop()
  const delta = await (await app.request(`/api/workflows?sync=1&since=${full.cursor}`, { headers })).json()
  assert.equal(delta.kind, 'delta'); assert.deepEqual(delta.definitions.remove, ['b']); assert.equal(delta.runs, undefined)
})

test('health/source metadata replacement clears removed keys without replacing definitions', async () => {
  const reconcile = createWorkflowSnapshotDelta()
  let snapshot: ReturnType<typeof state> & { runtimeError?: string; sources?: { kind: string; id: string; enabled: boolean }[] } = { ...state(), runtimeError: 'failed', sources: [{ kind: 'external', id: 's', enabled: false }] }
  const client = createWorkflowClient('http://localhost', 'p', async input => Response.json(reconcile(snapshot, new URL(String(input)).searchParams.get('since') ?? undefined)))
  const signal = new AbortController().signal
  const first = await client.read(signal)
  snapshot = { ...state(), sources: [] }
  const next = await client.read(signal)
  assert.equal(next.runtimeError, undefined); assert.deepEqual(next.sources, [])
  assert.equal(next.definitions, first.definitions)
})

test('unsupported/invalid envelopes retry full at most once then surface a failure', async () => {
  for (const raw of [{ version: 2, kind: 'full', cursor: 'x', snapshot: state() }, { version: 1, kind: 'noop', cursor: '', projectId: 'p' }]) {
    let requests = 0
    const client = createWorkflowClient('http://localhost', 'p', async () => { requests++; return Response.json(raw) })
    await assert.rejects(client.read(new AbortController().signal))
    assert.equal(requests, 2)
  }
})
