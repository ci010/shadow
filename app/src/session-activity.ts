import { t } from './i18n.ts'
import { parseSessionRecovery, type SessionRecovery } from '../../src/sessions/session-store.ts'

export type SessionStage = 'idle' | 'llm' | 'tool' | 'waiting' | 'waiting-for-call' | 'inactive' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkingStage = 'llm' | 'tool' | 'waiting' | 'waiting-for-call' | 'running'

/** Active computation, unlike a request paused for user input or a child call. */
export function isAnimatingStage(stage: unknown): boolean {
  return stage === 'llm' || stage === 'tool' || stage === 'running'
}

export function isWaitingStage(stage: unknown): boolean {
  return stage === 'waiting' || stage === 'waiting-for-call'
}

export function isWorkingStage(stage: unknown): stage is WorkingStage {
  return stage === 'llm' || stage === 'tool' || stage === 'waiting' || stage === 'waiting-for-call' || stage === 'running'
}

export function prominentWorkingStage(stages: readonly (string | undefined)[]): WorkingStage | undefined {
  return stages.includes('waiting') ? 'waiting' : stages.find(isWorkingStage)
}

export function sessionActivity(stage: unknown) {
  switch (stage) {
    case 'llm': return { kind: stage, label: t('Thinking'), working: true }
    case 'tool': return { kind: stage, label: t('Using tools'), working: true }
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

export function parseSessionStages(value: unknown): Record<string, SessionStage> {
  if (typeof value !== 'object' || value === null || !('stages' in value)
    || typeof value.stages !== 'object' || value.stages === null || Array.isArray(value.stages)) {
    throw new Error(t('Session activity is unavailable.'))
  }
  const waitingForCalls = 'waitingForCalls' in value ? value.waitingForCalls : undefined
  if (waitingForCalls !== undefined && (typeof waitingForCalls !== 'object' || waitingForCalls === null
    || Array.isArray(waitingForCalls) || Object.values(waitingForCalls).some(waiting => typeof waiting !== 'boolean'))) {
    throw new Error(t('Session activity is unavailable.'))
  }
  const result: Record<string, SessionStage> = {}
  for (const [id, stage] of Object.entries(value.stages)) {
    if (!isWorkingStage(stage) && stage !== 'idle' && stage !== 'inactive' && stage !== 'pending'
      && stage !== 'completed' && stage !== 'failed' && stage !== 'cancelled') throw new Error(t('Session activity is unavailable.'))
    result[id] = stage === 'waiting' && waitingForCalls
      && Object.prototype.hasOwnProperty.call(waitingForCalls, id)
      && (waitingForCalls as Record<string, boolean>)[id] ? 'waiting-for-call' : stage
  }
  return result
}

/** Older servers can render activity, but cannot safely cancel restored turns. */
export function parseActiveRequestIds(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || !('activeRequestIds' in value)) return {}
  const identities = value.activeRequestIds
  if (!identities || typeof identities !== 'object' || Array.isArray(identities)) {
    throw new Error(t('Current request identity is unavailable.'))
  }
  const result: Record<string, string> = {}
  for (const [sessionId, requestId] of Object.entries(identities)) {
    if (typeof requestId !== 'string' || !requestId) throw new Error(t('Current request identity is unavailable.'))
    result[sessionId] = requestId
  }
  return result
}

export function parseSessionRecoveries(value: unknown): Record<string, SessionRecovery> {
  if (!value || typeof value !== 'object' || !('recoveries' in value)) return {}
  if (!value.recoveries || typeof value.recoveries !== 'object' || Array.isArray(value.recoveries)) {
    throw new Error(t('Conversation recovery status is unavailable.'))
  }
  const result: Record<string, SessionRecovery> = {}
  for (const [sessionId, raw] of Object.entries(value.recoveries)) {
    const recovery = parseSessionRecovery(raw)
    if (!recovery) throw new Error(t('Conversation recovery status is unavailable.'))
    result[sessionId] = recovery
  }
  return result
}
