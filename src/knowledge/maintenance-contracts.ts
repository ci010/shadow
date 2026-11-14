export interface KnowledgeMaintenanceFinding {
  id: string
  sourceId: string
  sourceTitle: string
  target: string
  label: string
  reason: 'missing' | 'unavailable' | 'outside-catalog'
  repairable: boolean
  message: string
}

export interface KnowledgeMaintenanceReport {
  id: string
  scannedAt: string
  entriesScanned: number
  findings: KnowledgeMaintenanceFinding[]
}

export interface KnowledgeMaintenanceStatus {
  intervalMs: number
  scanning: boolean
  report: KnowledgeMaintenanceReport | null
  lastError?: string
}

export interface KnowledgeRepairPreview {
  reportId: string
  sourceId: string
  revision: string
  before: string
  after: string
  findingIds: string[]
}

/** Lightweight browsing status; totals always cover the entire immutable report. */
export interface KnowledgeMaintenanceSummary extends Omit<KnowledgeMaintenanceStatus, 'report'> {
  report: (Omit<KnowledgeMaintenanceReport, 'findings'> & {
    findingCount: number
    counts: Record<KnowledgeMaintenanceFinding['reason'], number>
  }) | null
}
export function maintenanceSummary(status: KnowledgeMaintenanceStatus): KnowledgeMaintenanceSummary {
  const { report, ...rest } = status
  if (!report) return { ...rest, report: null }
  const { findings, ...metadata } = report
  const counts = { missing: 0, unavailable: 0, 'outside-catalog': 0 }
  for (const finding of findings) counts[finding.reason]++
  return { ...rest, report: { ...metadata, findingCount: findings.length, counts } }
}
