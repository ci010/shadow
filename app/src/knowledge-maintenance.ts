import { maintenanceSummary, type KnowledgeMaintenanceSummary } from '../../src/knowledge/maintenance-contracts.ts'
import { unkeyedMaintenance } from '../../src/shared/snapshot-wire.ts'
import { createSnapshotReader } from './snapshot-reader.ts'
import { t } from './i18n.ts'
import type { KnowledgeMaintenanceFinding, KnowledgeMaintenanceReport, KnowledgeMaintenanceStatus, KnowledgeRepairPreview } from '../../src/knowledge/maintenance-contracts.ts'
import { isRecord } from './folders-sidebar.ts'
import { createKnowledgeTransport } from './knowledge.ts'

export type { KnowledgeMaintenanceFinding, KnowledgeMaintenanceReport, KnowledgeMaintenanceStatus, KnowledgeRepairPreview }
const invalid = () => new Error(t('Main returned invalid maintenance data. Refresh and retry.'))
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export function parseMaintenanceReport(value: unknown): KnowledgeMaintenanceReport {
  if (!isRecord(value) || !text(value.id) || !text(value.scannedAt) || !Number.isFinite(Date.parse(value.scannedAt))
    || typeof value.entriesScanned !== 'number' || !Number.isSafeInteger(value.entriesScanned) || value.entriesScanned < 0
    || !Array.isArray(value.findings)) throw invalid()
  const findings = value.findings.map((item): KnowledgeMaintenanceFinding => {
    if (!isRecord(item) || !text(item.id) || !text(item.sourceId) || !text(item.sourceTitle)
      || !text(item.target) || typeof item.label !== 'string' || typeof item.message !== 'string'
      || (item.reason !== 'missing' && item.reason !== 'unavailable' && item.reason !== 'outside-catalog')
      || typeof item.repairable !== 'boolean' || (item.repairable && item.reason !== 'missing')) throw invalid()
    return {
      id: item.id, sourceId: item.sourceId, sourceTitle: item.sourceTitle, target: item.target,
      label: item.label, message: item.message, reason: item.reason, repairable: item.repairable,
    }
  })
  if (new Set(findings.map(item => item.id)).size !== findings.length) throw invalid()
  return { id: value.id, scannedAt: value.scannedAt, entriesScanned: value.entriesScanned, findings }
}

export function parseMaintenanceStatus(value: unknown): KnowledgeMaintenanceStatus {
  if (!isRecord(value) || typeof value.intervalMs !== 'number' || !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 1
    || typeof value.scanning !== 'boolean' || (value.lastError !== undefined && typeof value.lastError !== 'string')) throw invalid()
  return {
    intervalMs: value.intervalMs, scanning: value.scanning,
    report: value.report === null ? null : parseMaintenanceReport(value.report),
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
  }
}

export function parseMaintenanceSummary(value: unknown): KnowledgeMaintenanceSummary {
  // Rolling-upgrade fallback, without retaining unsolicited legacy findings.
  if (isRecord(value) && isRecord(value.report) && Array.isArray(value.report.findings)) return maintenanceSummary(parseMaintenanceStatus(value))
  if (!isRecord(value)) throw invalid()
  const report = value.report
  const status = parseMaintenanceStatus({ ...value, report: null })
  if (report === null) return { ...status, report: null }
  if (!isRecord(report) || !isRecord(report.counts)) throw invalid()
  const metadata = parseMaintenanceReport({ ...report, findings: [] })
  const count = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
  const counts = report.counts
  if (!count(report.findingCount) || !count(counts.missing) || !count(counts.unavailable) || !count(counts['outside-catalog'])
    || counts.missing + counts.unavailable + counts['outside-catalog'] !== report.findingCount) throw invalid()
  return { ...status, report: { id: metadata.id, scannedAt: metadata.scannedAt, entriesScanned: metadata.entriesScanned,
    findingCount: report.findingCount, counts: { missing: counts.missing, unavailable: counts.unavailable, 'outside-catalog': counts['outside-catalog'] } } }
}

export function parseRepairPreview(value: unknown, reportId: string, sourceId: string): KnowledgeRepairPreview {
  if (!isRecord(value) || value.reportId !== reportId || value.sourceId !== sourceId || !text(value.revision)
    || typeof value.before !== 'string' || typeof value.after !== 'string' || value.before === value.after
    || !Array.isArray(value.findingIds) || !value.findingIds.length || !value.findingIds.every(text)) throw invalid()
  return { reportId, sourceId, revision: value.revision, before: value.before, after: value.after, findingIds: value.findingIds }
}

export function createKnowledgeMaintenanceClient(base: string, request: typeof fetch = fetch) {
  const json = createKnowledgeTransport(base, request)
  const post = (path: string, body: object, signal?: AbortSignal) =>
    json(`/maintenance/${path}`, { method: 'POST', body: JSON.stringify(body), signal })
  let legacyReport: KnowledgeMaintenanceReport | undefined
  const summaryParser = (value: unknown) => {
    legacyReport = isRecord(value) && isRecord(value.report) && Array.isArray(value.report.findings) ? parseMaintenanceReport(value.report) : undefined
    return parseMaintenanceSummary(value)
  }
  const reader = createSnapshotReader((version, signal) => json('/maintenance', { signal }, { transport: 'snapshot-v1', ...(version ? { since: version } : {}) }), parseMaintenanceStatus, unkeyedMaintenance)
  return {
    status: reader.load,
    summary: createSnapshotReader((version, signal) => json('/maintenance', { signal }, { view: 'summary', transport: 'snapshot-v1', ...(version ? { since: version } : {}) }), summaryParser).load,
    async scanSummary(signal?: AbortSignal) { return summaryParser(await post('scan?view=summary', {}, signal)) },
    async report(reportId: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (legacyReport?.id === reportId) return structuredClone(legacyReport)
      const report = parseMaintenanceReport(await json('/maintenance/report', { signal }, { reportId }))
      if (report.id !== reportId) throw invalid()
      return report
    },
    async scan(signal?: AbortSignal) { return parseMaintenanceReport(await post('scan', {}, signal)) },
    async preview(reportId: string, sourceId: string, signal?: AbortSignal) {
      return parseRepairPreview(await post('preview', { reportId, sourceId }, signal), reportId, sourceId)
    },
    async apply(preview: KnowledgeRepairPreview, signal?: AbortSignal): Promise<void> {
      const data = await post('apply', { reportId: preview.reportId, sourceId: preview.sourceId, revision: preview.revision }, signal)
      if (!isRecord(data) || data.updated !== preview.sourceId) throw invalid()
    },
  }
}
