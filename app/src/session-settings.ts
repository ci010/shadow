import { t } from './i18n.ts'
import { isRecord, type SidebarSession } from './folders-sidebar.ts'
import { apiUrl } from './api-url.ts'
import { isGptModel, isReasoningEffort, isContextWindow, type ReasoningEffort } from '../../src/agent/llm-config.ts'

export interface ReasoningSettings {
  contextWindow?: number | null
  thinking?: { type: 'enabled' | 'disabled' } | null
  reasoningEffort?: ReasoningEffort | null
}

export interface ConversationSettings extends ReasoningSettings {
  model?: string | null
}

export function contextWindowLabel(value: number | null | undefined): string {
  if (value == null) return t('Default')
  return value >= 1000000 ? `${value / 1000000}M` : `${value / 1000}K`
}

export function isChannelConversation(session: SidebarSession | undefined): boolean {
  return !!session && (!session.mode || session.mode === 'session') &&
    ['qq', 'discord', 'feishu', 'wechat'].includes(session.channelAddress?.platform ?? session.sessionId.split(':', 1)[0])
}

export const effortOptions = [
  { value: 'default', get label() { return t('Default') }, get description() { return t('Use project thinking and effort settings') } },
  { value: 'none', get label() { return t('None') }, get description() { return t('No thinking') } },
  { value: 'low', get label() { return t('Low') }, description: '' },
  { value: 'medium', get label() { return t('Medium') }, description: '' },
  { value: 'high', get label() { return t('High') }, description: '' },
  { value: 'xhigh', get label() { return t('XHigh') }, description: '' },
  { value: 'max', get label() { return t('Max') }, description: '' },
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
  patch: ConversationSettings,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<ConversationSettings> {
  const response = await request(apiUrl(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/config`).toString(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  if (!response.ok) throw new Error(t('Could not save conversation settings ({status}). Please try again.', { status: response.status }))
  const data: unknown = await response.json()
  if (!isRecord(data) || data.key !== sessionId
    || (data.config !== undefined && data.config !== null && !isRecord(data.config))) {
    throw new Error(t('Main returned invalid conversation settings. Please try again.'))
  }
  const config = isRecord(data.config) ? data.config : {}
  if ((config.contextWindow !== undefined && !isContextWindow(config.contextWindow))
    || (config.model !== undefined && (typeof config.model !== 'string' || !config.model.trim()))
    || (config.thinking !== undefined && (!isRecord(config.thinking) || !['enabled', 'disabled'].includes(String(config.thinking.type))))
    || (config.reasoningEffort !== undefined && !isReasoningEffort(config.reasoningEffort))) {
    throw new Error(t('Main returned invalid conversation settings. Please try again.'))
  }
  return {
    ...(isContextWindow(config.contextWindow) ? { contextWindow: config.contextWindow } : {}),
    ...(typeof config.model === 'string' ? { model: config.model } : {}),
    thinking: isRecord(config.thinking) ? { type: config.thinking.type === 'enabled' ? 'enabled' : 'disabled' } : null,
    reasoningEffort: isReasoningEffort(config.reasoningEffort) ? config.reasoningEffort : null,
  }
}
