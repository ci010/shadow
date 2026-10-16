/** Renderer-safe scheduling and persisted run contracts. */
export type CronContextMode = 'existing' | 'fresh'
export interface AutomationConfigSnapshot {
  source: 'cron' | 'learning' | 'system'
  schedule: string
  task?: string
  agentType?: string
  organizationMode?: 'full' | 'delta'
  originSessionId?: string
}
export interface AutomationSessionRef {
  jobId: string
  name: string
  runId: string
  startedAt: string
  contextMode: 'fresh'
  config?: AutomationConfigSnapshot
  organizationProblem?: 'execution_failed' | 'unfinished'
  organization?: OrganizationOutcome
  legacy?: boolean
}
export interface AutomationSummary {
  id: string
  name: string
  source: 'cron' | 'learning' | 'system'
  session: 'fresh'
  schedule: string
  task?: string
  agentType?: string
  enabled: boolean
  configuredEnabled?: boolean
  editable?: boolean
  model?: string
  defaultModel?: string
  canConfigureModel?: boolean
  canToggle?: boolean
  toggleId?: string
  toggleEnabled?: boolean
  disabledByGlobal?: boolean
  notice?: string
}
export interface AutomationRunSummary {
  id: string
  sessionId: string
  startedAt: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  title?: string
  scope?: 'full' | 'delta'
  organizationProblem?: 'execution_failed' | 'unfinished'
  organization?: OrganizationOutcome
  learning?: LearningOutcome
}
export interface OrganizationOutcome {
  mode: 'full' | 'delta'
  status: 'running' | 'completed' | 'partial'
  coveredCount: number
  manifestCount: number
  patches: number
}
export const SYSTEM_AUTOMATIONS = {
  organizer: { id: 'system:work-organizer', name: '话题整理', agentType: 'work-organizer' },
} as const
export function systemAutomationRef(agentType: 'work-organizer', sessionId: string, mode?: 'full' | 'delta'): AutomationSessionRef {
  if (agentType !== 'work-organizer') throw new Error('Unknown system automation')
  const job = SYSTEM_AUTOMATIONS.organizer
  return { jobId: job.id, name: mode === 'full' ? '话题全量重整' : mode === 'delta' ? '话题增量整理' : job.name,
    runId: sessionId, startedAt: new Date().toISOString(), contextMode: 'fresh',
    config: { source: 'system', schedule: 'Event-driven / manual', agentType, ...(mode ? { organizationMode: mode } : {}) } }
}
export function parseOrganizationOutcome(value: unknown): OrganizationOutcome | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new TypeError('Invalid organization outcome')
  const v = value as Record<string, unknown>
  if (!['full', 'delta'].includes(String(v.mode)) || !['running', 'completed', 'partial'].includes(String(v.status))
    || ['coveredCount', 'manifestCount', 'patches'].some(k => typeof v[k] !== 'number' || !Number.isSafeInteger(v[k]) || (v[k] as number) < 0)
    || (v.coveredCount as number) > (v.manifestCount as number)) throw new TypeError('Invalid organization outcome')
  return { mode: v.mode, status: v.status, coveredCount: v.coveredCount, manifestCount: v.manifestCount, patches: v.patches } as OrganizationOutcome
}
export interface LearningOutcome {
  status: 'applied' | 'no_change' | 'partial' | 'blocked' | 'draft_only'
  summary: string
  artifacts: number
  events: number
  evaluated: number
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
    if ((c.source !== 'cron' && c.source !== 'learning' && c.source !== 'system') || typeof c.schedule !== 'string'
      || (c.organizationMode !== undefined && c.organizationMode !== 'full' && c.organizationMode !== 'delta')
      || ['task', 'agentType', 'originSessionId'].some(k => c[k] !== undefined && typeof c[k] !== 'string')) {
      throw new TypeError('Invalid automation snapshot')
    }
  }
  if (v.organizationProblem !== undefined && v.organizationProblem !== 'execution_failed' && v.organizationProblem !== 'unfinished') throw new TypeError('Invalid organization problem')
  parseOrganizationOutcome(v.organization)
  return structuredClone(value) as AutomationSessionRef
}

/** Only the old built-in source addresses qualify; titles and prompts never classify runs. */
export function resolveAutomationSession(state: {
  sessionId: string; automation?: AutomationSessionRef; agentType?: string; automationVersion?: 1; lastActivityAt?: string; parentSessionId?: string | null
}): AutomationSessionRef | undefined {
  if (state.automation) return state.automation
  // Historical built-in internal addresses only; a same-named custom agent on web/heartbeat is not a system run.
  const internal = /^(work-organizer|work-observer):(.+)$/.exec(state.sessionId)
  if (internal && state.agentType === internal[1] && !state.parentSessionId
    && (internal[1] === 'work-organizer' ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(internal[2]!) : /^work-observer-\d{13}$/.test(internal[2]!))) {
    const ref: AutomationSessionRef = internal[1] === 'work-organizer' ? systemAutomationRef('work-organizer', state.sessionId) : {
      jobId: 'system:work-observer', name: 'Retired automatic observation', runId: state.sessionId,
      startedAt: '', contextMode: 'fresh', config: { source: 'system', schedule: 'Retired', agentType: 'work-observer' },
    }
    ref.startedAt = state.lastActivityAt && Number.isFinite(Date.parse(state.lastActivityAt)) ? state.lastActivityAt : new Date(Number(/(\d{13})$/.exec(internal[2]!)?.[1] ?? 0)).toISOString()
    ref.legacy = true
    return ref
  }
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
