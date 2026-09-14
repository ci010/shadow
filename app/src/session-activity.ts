export type SessionStage = 'idle' | 'llm' | 'tool' | 'waiting' | 'waiting-for-call' | 'inactive' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkingStage = 'llm' | 'tool' | 'waiting' | 'waiting-for-call' | 'running'

export function isWaitingStage(stage: unknown): boolean {
  return stage === 'waiting' || stage === 'waiting-for-call'
}

export function isWorkingStage(stage: unknown): stage is WorkingStage {
  return stage === 'llm' || stage === 'tool' || stage === 'waiting' || stage === 'waiting-for-call' || stage === 'running'
}

export function sessionActivity(stage: unknown) {
  switch (stage) {
    case 'llm': return { kind: stage, label: 'Thinking', working: true }
    case 'tool': return { kind: stage, label: 'Using tools', working: true }
    case 'waiting': return { kind: stage, label: 'Waiting for a response', working: true }
    case 'waiting-for-call': return { kind: stage, label: 'Waiting for call', working: true }
    case 'idle': return { kind: stage, label: 'Ready', working: false }
    case 'inactive': return { kind: stage, label: 'Inactive', working: false }
    case 'pending': return { kind: stage, label: 'Pending', working: false }
    case 'running': return { kind: stage, label: 'Running', working: true }
    case 'completed': return { kind: stage, label: 'Completed', working: false }
    case 'failed': return { kind: stage, label: 'Failed', working: false }
    case 'cancelled': return { kind: stage, label: 'Cancelled', working: false }
    default: return { kind: 'unknown', label: 'Status unavailable', working: false }
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
    throw new Error('Session activity is unavailable.')
  }
  const result: Record<string, SessionStage> = {}
  for (const [id, stage] of Object.entries(value.stages)) {
    if (!isWorkingStage(stage) && stage !== 'idle' && stage !== 'inactive' && stage !== 'pending'
      && stage !== 'completed' && stage !== 'failed' && stage !== 'cancelled') throw new Error('Session activity is unavailable.')
    result[id] = stage
  }
  return result
}
