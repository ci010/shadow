/** Renderer-safe scheduling and persisted run contracts. */
export type CronContextMode = 'existing' | 'fresh'
export interface AutomationConfigSnapshot {
  source: 'cron' | 'learning'
  schedule: string
  task?: string
  agentType?: string
  originSessionId?: string
}
export interface AutomationSessionRef {
  jobId: string
  name: string
  runId: string
  startedAt: string
  contextMode: 'fresh'
  config?: AutomationConfigSnapshot
  legacy?: boolean
}
export interface AutomationSummary {
  id: string
  name: string
  source: 'cron' | 'learning'
  session: 'fresh'
  schedule: string
  task?: string
  agentType?: string
  enabled: boolean
}
export interface AutomationRunSummary {
  id: string
  sessionId: string
  startedAt: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  title?: string
}
export const LEARNING_AUTOMATIONS = {
  reflector: { id: 'learning:reflector', name: 'Self reflection', agentType: 'reflector' },
  encapsulator: { id: 'learning:encapsulator', name: 'Encapsulation', agentType: 'encapsulator' },
  soulReflector: { id: 'learning:soul-reflector', name: 'Soul reflection', agentType: 'soul-reflector' },
} as const

export function isLearningAutomationRef(automation: AutomationSessionRef | undefined): boolean {
  return automation?.config?.source === 'learning'
    && Object.values(LEARNING_AUTOMATIONS).some(job => job.id === automation.jobId)
}

export function parseAutomationSessionRef(value: unknown): AutomationSessionRef | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new TypeError('Invalid automation metadata')
  const v = value as Record<string, unknown>
  if (v.contextMode !== 'fresh' || ['jobId', 'name', 'runId', 'startedAt'].some(k => typeof v[k] !== 'string' || !v[k])
    || !Number.isFinite(Date.parse(v.startedAt as string))) throw new TypeError('Invalid automation metadata')
  if (v.legacy !== undefined && typeof v.legacy !== 'boolean') throw new TypeError('Invalid automation legacy marker')
  if (v.config !== undefined) {
    if (!v.config || typeof v.config !== 'object') throw new TypeError('Invalid automation snapshot')
    const c = v.config as Record<string, unknown>
    if ((c.source !== 'cron' && c.source !== 'learning') || typeof c.schedule !== 'string'
      || ['task', 'agentType', 'originSessionId'].some(k => c[k] !== undefined && typeof c[k] !== 'string')) {
      throw new TypeError('Invalid automation snapshot')
    }
  }
  return structuredClone(value) as AutomationSessionRef
}

/** Only the old built-in source addresses qualify; titles and prompts never classify runs. */
export function resolveAutomationSession(state: {
  sessionId: string; automation?: AutomationSessionRef; agentType?: string; automationVersion?: 1
}): AutomationSessionRef | undefined {
  if (state.automation) return state.automation
  if (state.automationVersion !== undefined) return undefined
  const match = /^heartbeat:(reflector|encapsulator|soul-reflector)-(\d{13})$/.exec(state.sessionId)
  if (!match || state.agentType !== match[1]) return undefined
  const job = Object.values(LEARNING_AUTOMATIONS).find(job => job.agentType === match[1])!
  return {
    jobId: job.id, name: job.name, runId: state.sessionId,
    startedAt: new Date(Number(match[2])).toISOString(), contextMode: 'fresh', legacy: true,
    config: { source: 'learning', schedule: 'Historical schedule unavailable', agentType: job.agentType },
  }
}
