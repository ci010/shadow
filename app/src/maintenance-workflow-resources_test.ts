import test from 'node:test'
import assert from 'node:assert/strict'
import { createMaintenanceResources } from './stores/maintenance.ts'
import { createWorkflowResources } from './stores/workflow.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 5))
const report = { id: 'report-a', scannedAt: '2026-01-01T00:00:00Z', entriesScanned: 1, findings: [] }
const summary = { intervalMs: 1000, scanning: false, report: { ...report, findings: undefined, findingCount: 0, counts: { missing: 0, unavailable: 0, 'outside-catalog': 0 } } }

test('Maintenance shares summary and lazy immutable reports; last release aborts and scoped late replies cannot publish', async () => {
  const calls: { url: string; signal: AbortSignal; finish: (value: unknown) => void }[] = []
  const owner = createMaintenanceResources(((url: string, init: RequestInit) => new Promise(resolve => calls.push({ url: String(url),
    signal: init.signal as AbortSignal, finish: value => resolve(Response.json(value)) }))) as typeof fetch)
  const a = owner.acquire('http://fixture', 'a'), b = owner.acquire('http://fixture', 'a')
  try {
    await tick()
    assert.equal(calls.length, 1)
    assert(!calls[0]!.url.includes('/report'))
    calls[0]!.finish(summary)
    await a.read()
    assert.equal(a.state, b.state)
    assert.equal(a.state.value.value?.report?.id, 'report-a')
    const detail = owner.report('http://fixture', 'a', 'report-a')
    const sameDetail = owner.report('http://fixture', 'a', 'report-a')
    await tick()
    assert.equal(calls.length, 2)
    assert(calls[1]!.url.includes('/maintenance/report'))
    calls[1]!.finish(report)
    await detail.read()
    assert.equal(detail.state.value.value, sameDetail.state.value.value)
    detail.release(); sameDetail.release()
    a.release()
    const refreshing = b.refresh()
    await tick()
    assert.equal(calls[2]!.signal.aborted, false)
    b.release()
    assert.equal(calls[2]!.signal.aborted, true)
    calls[2]!.finish({ ...summary, scanning: true })
    await refreshing
    const other = owner.acquire('http://fixture', 'b')
    assert.equal(other.state.value.value, undefined)
    other.release()
  } finally { a.release(); b.release(); owner.dispose() }
})

test('Workflow shares one engine and active-only reconciliation timer; noop keeps snapshot identity', async () => {
  const urls: string[] = []
  let first = true
  const owner = createWorkflowResources((async (url: string) => {
    urls.push(String(url))
    if (first) { first = false; return Response.json({ version: 1, kind: 'full', cursor: 'v1', snapshot: { projectId: 'p', definitions: [], runs: [] } }) }
    return Response.json({ version: 1, kind: 'noop', cursor: 'v1', projectId: 'p' })
  }) as typeof fetch, 1000)
  const a = owner.acquire('http://fixture', 'p'), b = owner.acquire('http://fixture', 'p')
  try {
    await a.read()
    assert.equal(urls.length, 1)
    assert.equal(a.state, b.state)
    const value = a.state.value.value
    a.release()
    await b.refresh()
    assert.equal(urls.length, 2)
    assert.match(urls[1]!, /since=v1/)
    assert.equal(b.state.value.value, value)
    b.release()
    await tick()
    assert.equal(urls.length, 2)
  } finally { a.release(); b.release(); owner.dispose() }
})

test('Maintenance report identity validation rejects mismatched server replies and errors remain scoped', async () => {
  const owner = createMaintenanceResources((async () => Response.json(report)) as typeof fetch)
  try {
    const lease = owner.report('http://fixture', 'p', 'report-b')
    await lease.read()
    assert.equal(lease.state.value.value, undefined)
    assert.match(lease.state.value.error, /invalid maintenance/)
    lease.release()
  } finally { owner.dispose() }
})
