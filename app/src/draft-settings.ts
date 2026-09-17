import { isRecord } from './folders-sidebar.ts'
import { isReasoningEffort } from '../../src/agent/llm-config.ts'
import type { ConversationSettings } from './session-settings.ts'

export function draftSettingsKey(apiBase: string, projectId: string, folderId?: string, remote = false): string {
  return `shadow:draft-settings:v1:${JSON.stringify([apiBase, projectId, folderId ?? null, remote])}`
}

function parseSettings(value: unknown): ConversationSettings {
  if (!isRecord(value) || Object.keys(value).some(key => !['model', 'thinking', 'reasoningEffort'].includes(key))
    || (value.model != null && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256))
    || (value.thinking != null && (!isRecord(value.thinking) || !['enabled', 'disabled'].includes(String(value.thinking.type))))
    || (value.reasoningEffort != null && !isReasoningEffort(value.reasoningEffort))) {
    throw new Error('Saved draft model settings are invalid. Choose the model and effort again to replace them.')
  }
  return {
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(isRecord(value.thinking) ? { thinking: { type: value.thinking.type === 'disabled' ? 'disabled' as const : 'enabled' as const } } : {}),
    ...(isReasoningEffort(value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}),
  }
}

export function loadDraftSettings(storage: Pick<Storage, 'getItem'>, key: string): ConversationSettings | undefined {
  const text = storage.getItem(key)
  if (text === null) return undefined
  return parseSettings(JSON.parse(text))
}

export function saveDraftSettings(storage: Pick<Storage, 'setItem'>, key: string, settings: ConversationSettings): void {
  storage.setItem(key, JSON.stringify(parseSettings(settings)))
}
