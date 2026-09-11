export type SessionStage = 'idle' | 'llm' | 'tool' | 'inactive'
export type WorkingStage = 'llm' | 'tool'

export function isWorkingStage(stage: unknown): stage is WorkingStage {
  return stage === 'llm' || stage === 'tool'
}

export function sessionActivity(stage: unknown) {
  switch (stage) {
    case 'llm': return { kind: stage, label: 'Thinking', working: true }
    case 'tool': return { kind: stage, label: 'Using tools', working: true }
    case 'idle': return { kind: stage, label: 'Ready', working: false }
    case 'inactive': return { kind: stage, label: 'Inactive', working: false }
    default: return { kind: 'unknown', label: 'Status unavailable', working: false }
  }
}

export function parseSessionStages(value: unknown): Record<string, SessionStage> {
  if (typeof value !== 'object' || value === null || !('stages' in value)
    || typeof value.stages !== 'object' || value.stages === null || Array.isArray(value.stages)) {
    throw new Error('Session activity is unavailable.')
  }
  const result: Record<string, SessionStage> = {}
  for (const [id, stage] of Object.entries(value.stages)) {
    if (!isWorkingStage(stage) && stage !== 'idle' && stage !== 'inactive') throw new Error('Session activity is unavailable.')
    result[id] = stage
  }
  return result
}
