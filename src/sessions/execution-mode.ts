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
  _hasDelegationParent: boolean,
): readonly ExecutionMode[] {
  if (mode === 'call') return []
  if (mode === 'task') return ['call']
  return ['task', 'call']
}

// Mode limits are hard ceilings, including for dynamically imported tools.
const SESSION_ONLY_TOOLS = new Set([
  'session', 'work', 'initiative', 'continuation',
  'event_subscribe', 'event_source', 'cron', 'cron_add', 'cron_list', 'cron_remove',
])
const CALL_COORDINATION_TOOLS = new Set([
  'subagent', 'ask', 'reply', 'message', 'cancel', 'skill_read', 'skill_save',
])

export function executionModeAllowsTool(mode: ExecutionMode | undefined, name: string): boolean {
  if (!mode || mode === 'session') return true
  if (SESSION_ONLY_TOOLS.has(name)) return false
  return mode !== 'call' || !CALL_COORDINATION_TOOLS.has(name)
}
