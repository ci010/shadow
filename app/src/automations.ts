import { t } from './i18n.ts'
import { apiUrl } from './api-url.ts'
import { projectChatLocation } from './projects.ts'

export function automationChatLocation(projectId: string, id: string, sessionId = '') {
  return { ...projectChatLocation({ projectId, sessionId }), query: { automation: id } }
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
  notice?: string
}
export interface LearningOutcome {
  status: 'applied' | 'no_change' | 'partial' | 'blocked' | 'draft_only'
  summary: string
  artifacts: number
  events: number
  evaluated: number
}

export interface AutomationRunSummary {
  id: string
  sessionId: string
  startedAt: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  title?: string
  learning?: LearningOutcome
}

export interface AutomationRunsPage {
  runs: AutomationRunSummary[]
  total: number
  offset: number
}

export const AUTOMATION_PAGE_SIZE = 30

export class AutomationRequestError extends Error {
  constructor(message: string, readonly kind: 'unavailable' | 'denied' | 'invalid' = 'unavailable') {
    super(message)
    this.name = 'AutomationRequestError'
  }
}

const invalid = () => new AutomationRequestError(t('Main returned invalid automation data. Retry to refresh.'), 'invalid')
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && value !== '.' && value !== '..' && !/[\u0000-\u001f\u007f]/.test(value)
const optionalText = (value: unknown) => value === undefined || typeof value === 'string'
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function learningOutcomeLabel(outcome: LearningOutcome): string {
  return { applied: t('Applied'), no_change: t('No change'), partial: t('Partial'), blocked: t('Blocked'), draft_only: t('Draft only') }[outcome.status]
}

function learningOutcome(value: unknown): LearningOutcome | undefined {
  if (value === undefined) return undefined
  if (!record(value) || !['applied', 'no_change', 'partial', 'blocked', 'draft_only'].includes(String(value.status))
    || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 8000
    || !count(value.artifacts) || !count(value.events) || !count(value.evaluated)) throw invalid()
  return { status: value.status as LearningOutcome['status'], summary: value.summary,
    artifacts: value.artifacts, events: value.events, evaluated: value.evaluated }
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]! && Number.isFinite(Date.parse(value))
}

async function read<T>(
  url: URL, signal: AbortSignal, parse: (value: unknown) => T, request: typeof fetch,
): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  try {
    deadline.throwIfAborted()
    const response = await request(url, { signal: deadline, cache: 'no-store', redirect: 'error' })
    deadline.throwIfAborted()
    if (response.status === 401 || response.status === 403) throw new AutomationRequestError(t('Access to automations was denied.'), 'denied')
    if (response.status === 404) throw new AutomationRequestError(t('Automations are unavailable. Update and restart Main, then retry.'))
    if (!response.ok) throw new AutomationRequestError(t('Automations could not be loaded. Check Main and retry.'))
    const value: unknown = await response.json()
    deadline.throwIfAborted()
    return parse(value)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof AutomationRequestError) throw error
    if (error instanceof SyntaxError) throw invalid()
    throw new AutomationRequestError(deadline.aborted
      ? t('Loading automations timed out. Check Main and retry.')
      : t('Automations could not be loaded. Check Main and retry.'))
  }
}

export async function fetchAutomations(
  base: string, signal: AbortSignal, request: typeof fetch = fetch,
): Promise<AutomationSummary[]> {
  return read(apiUrl(base, '/api/automations'), signal, value => {
    if (!record(value) || !Array.isArray(value.automations)) throw invalid()
    const ids = new Set<string>()
    return value.automations.map((item: unknown): AutomationSummary => {
      if (!record(item) || !identifier(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim()
        || (item.source !== 'cron' && item.source !== 'learning') || item.session !== 'fresh'
        || typeof item.schedule !== 'string' || !item.schedule.trim() || typeof item.enabled !== 'boolean'
        || !optionalText(item.task) || !optionalText(item.agentType) || !optionalText(item.notice)) throw invalid()
      ids.add(item.id)
      return {
        id: item.id, name: item.name, source: item.source, session: 'fresh', schedule: item.schedule,
        enabled: item.enabled, ...(item.task !== undefined ? { task: item.task as string } : {}),
        ...(item.agentType !== undefined ? { agentType: item.agentType as string } : {}),
        ...(item.notice !== undefined ? { notice: item.notice as string } : {}),
      }
    })
  }, request)
}

export async function fetchAutomationRuns(
  base: string, id: string, offset: number, signal: AbortSignal, request: typeof fetch = fetch,
): Promise<AutomationRunsPage> {
  if (!identifier(id) || !count(offset)) throw invalid()
  return read(apiUrl(base, `/api/automations/${encodeURIComponent(id)}/runs`, {
    offset: String(offset), limit: String(AUTOMATION_PAGE_SIZE),
  }), signal, value => {
    if (!record(value) || !count(value.total) || value.offset !== offset || !Array.isArray(value.runs)
      || value.runs.length !== Math.min(AUTOMATION_PAGE_SIZE, Math.max(0, value.total - offset))) throw invalid()
    const ids = new Set<string>()
    const sessions = new Set<string>()
    const runs = value.runs.map((item: unknown): AutomationRunSummary => {
      if (!record(item) || !identifier(item.id) || ids.has(item.id) || !identifier(item.sessionId) || sessions.has(item.sessionId)
        || !timestamp(item.startedAt) || !['running', 'completed', 'failed', 'cancelled', 'unknown'].includes(item.status as string)
        || !optionalText(item.title)) throw invalid()
      ids.add(item.id)
      sessions.add(item.sessionId)
      return {
        id: item.id, sessionId: item.sessionId, startedAt: item.startedAt,
        status: item.status as AutomationRunSummary['status'],
        ...(item.title !== undefined ? { title: item.title as string } : {}),
        ...(item.learning !== undefined ? { learning: learningOutcome(item.learning) } : {}),
      }
    })
    runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    return { runs, total: value.total, offset }
  }, request)
}
