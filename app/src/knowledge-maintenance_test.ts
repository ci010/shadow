import assert from 'node:assert/strict'
import test from 'node:test'
import { createKnowledgeMaintenanceClient, parseMaintenanceReport, parseMaintenanceStatus, parseRepairPreview, type KnowledgeMaintenanceReport, type KnowledgeRepairPreview } from './knowledge-maintenance.ts'

const report: KnowledgeMaintenanceReport = {
  id: 'report-a', scannedAt: '2026-09-20T00:00:00Z', entriesScanned: 3,
  findings: [{
    id: 'missing-a', sourceId: 'memory/topics/a.md', sourceTitle: 'A', target: 'memory/topics/b.md',
    label: 'B', reason: 'missing', repairable: true, message: 'Local target does not exist.',
  }],
}
const preview: KnowledgeRepairPreview = {
  reportId: report.id, sourceId: report.findings[0]!.sourceId, revision: 'revision-a',
  before: '[B](b.md)', after: 'B', findingIds: ['missing-a'],
}

test('maintenance client validates persisted reports, classification and preview identity', () => {
  assert.deepEqual(parseMaintenanceReport(report), report)
  assert.deepEqual(parseMaintenanceStatus({ intervalMs: 86_400_000, scanning: false, report }), { intervalMs: 86_400_000, scanning: false, report })
  assert.deepEqual(parseRepairPreview(preview, report.id, preview.sourceId), preview)
  for (const value of [
    { ...report, scannedAt: 'invalid' },
    { ...report, entriesScanned: -1 },
    { ...report, findings: [...report.findings, ...report.findings] },
    { ...report, findings: [{ ...report.findings[0], reason: 'unavailable', repairable: true }] },
    { ...report, findings: [{ ...report.findings[0], reason: 'guess' }] },
  ]) assert.throws(() => parseMaintenanceReport(value), /invalid maintenance/)
  assert.throws(() => parseMaintenanceStatus({ intervalMs: 0, scanning: false, report }), /invalid maintenance/)
  assert.throws(() => parseRepairPreview({ ...preview, sourceId: 'other' }, report.id, preview.sourceId), /invalid maintenance/)
  assert.throws(() => parseRepairPreview({ ...preview, after: preview.before }, report.id, preview.sourceId), /invalid maintenance/)
})

test('maintenance client keeps all operations in one Project and never submits client-generated patches', async () => {
  const calls: Array<{ url: URL; body: unknown }> = []
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.pathname.endsWith('/scan')) return Response.json(report)
    if (url.pathname.endsWith('/preview')) return Response.json(preview)
    if (url.pathname.endsWith('/apply')) return Response.json({ updated: preview.sourceId })
    return Response.json({ intervalMs: 86_400_000, scanning: false, report })
  }
  const client = createKnowledgeMaintenanceClient('http://fixture/projects/a/', request)
  assert.deepEqual((await client.status()).report, report)
  assert.deepEqual(await client.scan(), report)
  assert.deepEqual(await client.preview(report.id, preview.sourceId), preview)
  await client.apply(preview)
  assert(calls.every(call => call.url.pathname.startsWith('/projects/a/api/knowledge/maintenance')))
  assert.deepEqual(calls[1]!.body, {})
  assert.deepEqual(calls[2]!.body, { reportId: report.id, sourceId: preview.sourceId })
  assert.deepEqual(calls[3]!.body, { reportId: report.id, sourceId: preview.sourceId, revision: preview.revision })
})

test('maintenance client surfaces conflicts, auth failures and unconfirmed repairs', async () => {
  await assert.rejects(createKnowledgeMaintenanceClient('http://fixture', async () => new Response('', { status: 409 })).apply(preview), /scan again/)
  await assert.rejects(createKnowledgeMaintenanceClient('http://fixture', async () => new Response('', { status: 401 })).scan(), /administrator/)
  await assert.rejects(createKnowledgeMaintenanceClient('http://fixture', async () => Response.json({ updated: 'other' })).apply(preview), /invalid maintenance/)
  await assert.rejects(createKnowledgeMaintenanceClient('http://fixture', async () => { throw new Error('network') }).apply(preview), /may already have completed/)
})


test('summary status omits findings with full counts; details are report-scoped and mutation refresh stays lightweight', async () => {
  const { Hono } = await import('hono')
  const { registerKnowledgeRoutes } = await import('../../src/knowledge/routes.ts')
  const { parseMaintenanceSummary } = await import('./knowledge-maintenance.ts')
  let current = { ...report, findings: Array.from({ length: 205 }, (_, i) => ({ ...report.findings[0]!, id: `finding-${i}`, reason: i < 105 ? 'missing' as const : 'unavailable' as const, repairable: i < 105 })) }
  const app = new Hono()
  registerKnowledgeRoutes(app, { workspace: process.cwd(), skills: {} as any, authorize: () => true,
    maintenance: { status: () => ({ intervalMs: 86400000, scanning: false, report: current }), scan: async () => { current = { ...current, id: 'report-b' }; return current } } as any })
  const urls: URL[] = []
  const responseBodies: string[] = []
  const client = createKnowledgeMaintenanceClient('http://fixture', (async (input, init) => {
    const url = new URL(String(input)); urls.push(url)
    const response = await app.request(url.pathname + url.search, init)
    responseBodies.push(await response.clone().text())
    return response
  }) as typeof fetch)
  const summary = await client.summary()
  assert.equal(summary.report!.findingCount, 205)
  assert.deepEqual(summary.report!.counts, { missing: 105, unavailable: 100, 'outside-catalog': 0 })
  assert(!Object.hasOwn(summary.report!, 'findings'))
  assert.equal(urls.length, 1, 'initial status does not request details')
  assert(Buffer.byteLength(responseBodies[0]!) < 1000)
  assert(!responseBodies[0]!.includes('finding-0'), 'initial wire response contains no finding records')
  assert.equal((await client.report(report.id)).findings.length, 205)
  assert.equal(urls[1]!.searchParams.get('reportId'), report.id)
  const scanned = await client.scanSummary()
  assert.equal(scanned.report!.id, 'report-b')
  assert(!Object.hasOwn(scanned.report!, 'findings'))
  assert.equal(urls.at(-1)!.searchParams.get('view'), 'summary')
  await assert.rejects(client.report(report.id), /scan again/)
  const refreshed = await client.summary()
  assert.equal(refreshed.report!.id, 'report-b')
  assert.equal(refreshed.report!.findingCount, 205)
  assert(urls.at(-1)!.searchParams.has('since'), 'summary keeps its own versioned delta cursor')
  const legacy = await (await app.request('/api/knowledge/maintenance')).json()
  assert.equal(legacy.report.findings.length, 205, 'legacy endpoint remains complete')
  assert.throws(() => parseMaintenanceSummary({ ...summary, report: { ...summary.report, findingCount: 1 } }))
})

test('lazy details only load on disclosure, reject stale replacements, retry and clear after mutations/project changes', async () => {
  const { createMaintenanceDetails } = await import('./knowledge-maintenance-details.ts')
  const calls: { id: string; signal: AbortSignal; finish: (value: KnowledgeMaintenanceReport) => void; fail: (error: Error) => void }[] = []
  const details = createMaintenanceDetails((id, signal) => new Promise((finish, fail) => calls.push({ id, signal, finish, fail })))
  await details.select('report-a', false)
  assert.equal(calls.length, 0)
  const first = details.select('report-a', true)
  await new Promise(resolve => setTimeout(resolve, 5)) // engine scheduling boundary
  const replacement = details.select('report-b', true)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert(calls[0]!.signal.aborted)
  calls[1]!.finish({ ...report, id: 'report-b' }); await replacement
  calls[0]!.finish(report); await first
  assert.equal(details.state.report!.id, 'report-b', 'late old report cannot overwrite replacement')
  await details.select('report-b', false); await details.select('report-b', true)
  assert.equal(calls.length, 2, 'immutable report details are reused on redisclosure')
  await details.select(undefined, true)
  assert.equal(details.state.report, undefined, 'mutation invalidation drops old findings')
  const retry = details.select('report-c', true)
  await new Promise(resolve => setTimeout(resolve, 5))
  calls[2]!.fail(new Error('Report changed')); await retry
  assert.equal(details.state.report, undefined)
  assert.match(details.state.error, /Report changed/)
  const retried = details.select('report-c', true)
  await new Promise(resolve => setTimeout(resolve, 5))
  calls[3]!.finish({ ...report, id: 'report-c' }); await retried
  assert.equal(details.state.report!.id, 'report-c')
  details.dispose()
  assert.equal(details.state.report, undefined, 'Project change/unmount cannot retain another Project report')
  await details.select('report-c', true, false)
  assert.equal(calls.length, 4, 'inactive UI never reads findings')
})

test('legacy summary fallback preserves full details without a second unsupported request', async () => {
  let calls = 0
  const client = createKnowledgeMaintenanceClient('http://fixture', async () => { calls++; return Response.json({ intervalMs: 86400000, scanning: false, report }) })
  assert.equal((await client.summary()).report!.findingCount, 1)
  assert.deepEqual(await client.report(report.id), report)
  assert.equal(calls, 1)
})
