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
