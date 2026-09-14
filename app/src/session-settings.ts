import { isRecord } from './projects-sidebar.ts'
import { isGptModel, isReasoningEffort, type ReasoningEffort } from '../../src/agent/llm-config.ts'

export interface ReasoningSettings {
  thinking?: { type: 'enabled' | 'disabled' } | null
  reasoningEffort?: ReasoningEffort | null
}

export const effortOptions = [
  { value: 'default', label: 'Default', description: 'Use global thinking and effort settings' },
  { value: 'none', label: 'None', description: 'No thinking' },
  { value: 'low', label: 'Low', description: '' },
  { value: 'medium', label: 'Medium', description: '' },
  { value: 'high', label: 'High', description: '' },
  { value: 'xhigh', label: 'XHigh', description: '' },
  { value: 'max', label: 'Max', description: '' },
] as const

export type EffortChoice = typeof effortOptions[number]['value']

export function effortOptionsForModel(model: string) {
  return isGptModel(model)
    ? effortOptions
    : effortOptions.filter(option => option.value !== 'medium' && option.value !== 'xhigh')
}

export function currentEffort(settings: ReasoningSettings): EffortChoice {
  return settings.thinking?.type === 'disabled' ? 'none' : settings.reasoningEffort ?? 'default'
}

export function reasoningSettingsForEffort(effort: EffortChoice): ReasoningSettings {
  if (effort === 'default') return { thinking: null, reasoningEffort: null }
  if (effort === 'none') return { thinking: { type: 'disabled' }, reasoningEffort: null }
  return { thinking: { type: 'enabled' }, reasoningEffort: effort }
}

export async function updateSessionSettings(
  apiBase: string,
  sessionId: string,
  patch: ReasoningSettings,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<ReasoningSettings> {
  const response = await request(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  if (!response.ok) throw new Error(`Could not save conversation settings (${response.status}). Please try again.`)
  const data: unknown = await response.json()
  if (!isRecord(data) || data.key !== sessionId
    || (data.config !== undefined && data.config !== null && !isRecord(data.config))) {
    throw new Error('Main returned invalid conversation settings. Please try again.')
  }
  const config = isRecord(data.config) ? data.config : {}
  if ((config.thinking !== undefined && (!isRecord(config.thinking) || !['enabled', 'disabled'].includes(String(config.thinking.type))))
    || (config.reasoningEffort !== undefined && !isReasoningEffort(config.reasoningEffort))) {
    throw new Error('Main returned invalid conversation settings. Please try again.')
  }
  return {
    thinking: isRecord(config.thinking) ? { type: config.thinking.type === 'enabled' ? 'enabled' : 'disabled' } : null,
    reasoningEffort: isReasoningEffort(config.reasoningEffort) ? config.reasoningEffort : null,
  }
}
