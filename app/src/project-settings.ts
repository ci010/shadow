import type { ProviderInstanceLabel } from './model-selection.ts'
import { t } from './i18n.ts'
import { isRecord } from './folders-sidebar.ts'
import { projectJson } from './projects.ts'
import { isReasoningEffort } from '../../src/agent/llm-config.ts'
import type { ReasoningSettings } from './session-settings.ts'

export interface ProjectConfig {
  agent: Record<string, unknown> & { model: string; workspace: string; temperature: number }
  learning?: Record<string, unknown>
  [key: string]: unknown
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  if (!isRecord(value) || !isRecord(value.agent) || typeof value.agent.model !== 'string'
    || typeof value.agent.workspace !== 'string' || typeof value.agent.temperature !== 'number'
    || !Number.isFinite(value.agent.temperature)
    || (value.agent.thinking !== undefined && (!isRecord(value.agent.thinking) || !['enabled', 'disabled'].includes(String(value.agent.thinking.type))))
    || (value.agent.reasoningEffort !== undefined && !isReasoningEffort(value.agent.reasoningEffort))
    || (value.learning !== undefined && (!isRecord(value.learning)
      || (value.learning.enabled !== undefined && typeof value.learning.enabled !== 'boolean')))) {
    throw new Error(t('Main returned invalid project settings. Refresh to retry.'))
  }
  return value as ProjectConfig
}

export function configReasoning(config: ProjectConfig): ReasoningSettings {
  return {
    contextWindow: typeof config.agent.contextWindow === "number" ? config.agent.contextWindow : undefined,
    thinking: isRecord(config.agent.thinking) ? { type: config.agent.thinking.type === 'enabled' ? 'enabled' : 'disabled' } : null,
    reasoningEffort: isReasoningEffort(config.agent.reasoningEffort) ? config.agent.reasoningEffort : null,
  }
}

export function mergeProjectSettings(config: ProjectConfig, section: 'agent' | 'learning', patch: Record<string, unknown>): ProjectConfig {
  const next = structuredClone(config)
  const allowed = section === 'agent' ? ['model', 'temperature', 'thinking', 'reasoningEffort']
    : ['enabled', 'reflectIntervalMs', 'encapsulateIntervalMs', 'soulIntervalMs']
  if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error(t('This setting is not project-owned.'))
  const target: Record<string, unknown> = { ...next[section] }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key]
    else target[key] = value
  }
  return parseProjectConfig({ ...next, [section]: target })
}

export function createProjectSettingsClient(base: string, request: typeof fetch = fetch) {
  const load = async (signal?: AbortSignal) => parseProjectConfig(await projectJson(base, '/api/config', { signal }, request))
  return {
    load,
    async save(section: 'agent' | 'learning', patch: Record<string, unknown>, signal?: AbortSignal) {
      // The config endpoint replaces the document. Read immediately before merging
      // so a Models edit does not overwrite an earlier Bots/Learning edit.
      const current = await load(signal)
      const next = mergeProjectSettings(current, section, patch)
      return parseProjectConfig(await projectJson(base, '/api/config', { method: 'PATCH', body: JSON.stringify(next), signal }, request))
    },
    async catalog(signal?: AbortSignal): Promise<{ models: string[]; providers: ProviderInstanceLabel[] }> {
      const result = await projectJson(base, '/api/models', { signal }, request)
      if (!isRecord(result) || !Array.isArray(result.models) || !result.models.every(model => typeof model === 'string')
        || (result.providers !== undefined && (!Array.isArray(result.providers) || !result.providers.every(item =>
          isRecord(item) && typeof item.id === 'string' && typeof item.type === 'string' && (item.name === undefined || typeof item.name === 'string'))))) {
        throw new Error(t('Main returned invalid models. Check App provider connections and retry.'))
      }
      return { models: result.models, providers: (result.providers ?? []) as ProviderInstanceLabel[] }
    },
    async models(signal?: AbortSignal): Promise<string[]> {
      return (await this.catalog(signal)).models
    },
  }
}
