export const EXECUTION_MODES = ['session', 'task', 'call'] as const

export type ExecutionMode = typeof EXECUTION_MODES[number]

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === 'session' || value === 'task' || value === 'call'
}

export function parseExecutionMode(value: unknown): ExecutionMode {
  if (!isExecutionMode(value)) {
    throw new TypeError('Execution mode must be "session", "task", or "call".')
  }
  return value
}

export function allowedSubagentModes(
  mode: ExecutionMode,
  hasDelegationParent: boolean,
): readonly ExecutionMode[] {
  if (mode === 'call') return []
  if (mode === 'task') return ['call']
  return hasDelegationParent ? ['task', 'call'] : ['session', 'task']
}
