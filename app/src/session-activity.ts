import { t } from './i18n.ts'
import type { SessionRecovery } from '../../src/sessions/session-store.ts'
import { parseSessionActivitySnapshot } from '../../src/sessions/activity-snapshot.ts'

export type SessionStage = 'idle' | 'llm' | 'tool' | 'waiting' | 'rate-limit' | 'waiting-for-call' | 'inactive' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkingStage = 'llm' | 'tool' | 'waiting' | 'waiting-for-call' | 'running'

/** Active computation, unlike a request paused for user input or a child call. */
export function isAnimatingStage(stage: unknown): boolean {
  return stage === 'llm' || stage === 'tool' || stage === 'running'
}

export function isWaitingStage(stage: unknown): boolean {
  return stage === 'waiting' || stage === 'rate-limit' || stage === 'waiting-for-call'
}

export function isWorkingStage(stage: unknown): stage is WorkingStage {
  return stage === 'llm' || stage === 'tool' || stage === 'waiting' || stage === 'rate-limit' || stage === 'waiting-for-call' || stage === 'running'
}

export function prominentWorkingStage(stages: readonly (string | undefined)[]): WorkingStage | undefined {
  return stages.includes('waiting') ? 'waiting' : stages.find(isWorkingStage)
}

export function sessionActivity(stage: unknown) {
  switch (stage) {
    case 'llm': return { kind: stage, label: t('Thinking'), working: true }
    case 'tool': return { kind: stage, label: t('Using tools'), working: true }
    case 'rate-limit': return { kind: stage, label: t('Waiting for model rate limit (automatic retry)'), working: true }
    case 'waiting': return { kind: stage, label: t('Waiting for a response'), working: true }
    case 'waiting-for-call': return { kind: stage, label: t('Waiting for call'), working: true }
    case 'idle': return { kind: stage, label: t('Ready'), working: false }
    case 'inactive': return { kind: stage, label: t('Inactive'), working: false }
    case 'pending': return { kind: stage, label: t('Pending'), working: false }
    case 'running': return { kind: stage, label: t('Running'), working: true }
    case 'completed': return { kind: stage, label: t('Completed'), working: false }
    case 'failed': return { kind: stage, label: t('Failed'), working: false }
    case 'cancelled': return { kind: stage, label: t('Cancelled'), working: false }
    default: return { kind: 'unknown', label: t('Status unavailable'), working: false }
  }
}

export function displayedSessionStages(
  stages: Record<string, SessionStage>, activeSessionId: string, streaming: boolean, streamPhase?: WorkingStage,
): Record<string, SessionStage> {
  if (!activeSessionId || !streaming || isWaitingStage(stages[activeSessionId])) return stages
  return { ...stages, [activeSessionId]: streamPhase ?? 'llm' }
}

export function shouldRefreshReadonlyHistory(
  stage: SessionStage | undefined, previous: SessionStage | undefined, elapsedMs: number,
): boolean {
  return stage === 'llm' || stage === 'tool' || stage !== previous || elapsedMs >= 5000
}

/** Recovery is persisted separately from runtime activity. Keep a stopped failure
 * visible after eviction/reload, without overriding a new turn or a pending reply. */
export function recoveredSessionStage(stage: SessionStage, recovery?: SessionRecovery | null): SessionStage {
  return (stage === 'idle' || stage === 'inactive') && recovery?.reason === 'failed' ? 'failed' : stage
}

export function parseSessionActivity(value: unknown) {
  let models: ReturnType<typeof parseSessionActivitySnapshot>
  try { models = parseSessionActivitySnapshot(value) }
  catch { throw new Error(t('Session activity is unavailable.')) }
  const stages: Record<string, SessionStage> = {}
  const activeRequestIds: Record<string, string> = {}
  const recoveries: Record<string, SessionRecovery> = {}
  for (const [id, model] of Object.entries(models)) {
    Object.defineProperty(stages, id, { value: model.waitingForCall ? 'waiting-for-call' : recoveredSessionStage(model.stage, model.recovery), enumerable: true, configurable: true, writable: true })
    if (model.activeRequestId !== null) Object.defineProperty(activeRequestIds, id, { value: model.activeRequestId, enumerable: true, configurable: true, writable: true })
    if (model.recovery !== null) Object.defineProperty(recoveries, id, { value: model.recovery, enumerable: true, configurable: true, writable: true })
  }
  return { stages, activeRequestIds, recoveries }
}

export function parseSessionStages(value: unknown) { return parseSessionActivity(value).stages }
export function parseActiveRequestIds(value: unknown) { return parseSessionActivity(value).activeRequestIds }
export function parseSessionRecoveries(value: unknown) { return parseSessionActivity(value).recoveries }
