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
