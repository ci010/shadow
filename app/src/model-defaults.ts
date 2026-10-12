import { t } from './i18n.ts'
import { isRecord } from './folders-sidebar.ts'
import { projectJson } from './projects.ts'
import { isReasoningEffort, isContextWindow } from '../../src/agent/llm-config.ts'
import type { ReasoningSettings } from './session-settings.ts'

export interface ModelDefaults extends ReasoningSettings {
  model?: string
  quickModel?: string
  temperature?: number
}
export interface ModelDefaultsState extends ModelDefaults {
  model: string
  temperature: number
  overrides: ModelDefaults
  inherited: ModelDefaults & { model: string; temperature: number }
}

function validFields(value: unknown): value is ModelDefaults {
  return isRecord(value)
    && (value.contextWindow === undefined || (typeof value.contextWindow === "number" && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0))
    && (value.model === undefined || (typeof value.model === 'string' && !!value.model.trim()))
    && (value.quickModel === undefined || typeof value.quickModel === 'string')
    && (value.temperature === undefined || (typeof value.temperature === 'number' && Number.isFinite(value.temperature)))
    && (value.thinking === undefined || (isRecord(value.thinking) && ['enabled', 'disabled'].includes(String(value.thinking.type))))
    && (value.reasoningEffort === undefined || isReasoningEffort(value.reasoningEffort))
}

export function parseModelDefaults(value: unknown): ModelDefaultsState {
  if (!isRecord(value) || !validFields(value) || typeof value.model !== 'string' || typeof value.temperature !== 'number'
    || !validFields(value.overrides) || (value.overrides.contextWindow !== undefined && !isContextWindow(value.overrides.contextWindow)) || !validFields(value.inherited)
    || typeof value.inherited.model !== 'string' || typeof value.inherited.temperature !== 'number') {
    throw new Error(t('Main returned invalid model defaults. Reload settings and retry.'))
  }
  return {
    ...value, model: value.model, temperature: value.temperature, overrides: value.overrides,
    inherited: { ...value.inherited, model: value.inherited.model, temperature: value.inherited.temperature },
  }
}

export function createModelDefaultsClient(base: string, scope: 'app' | 'project', request: typeof fetch = fetch) {
  const path = scope === 'app' ? '/api/app/model-defaults' : '/api/config/model-defaults'
  return {
    async load(signal?: AbortSignal) {
      return parseModelDefaults(await projectJson(base, path, { signal }, request))
    },
    async save(patch: Record<string, unknown>, signal?: AbortSignal) {
      return parseModelDefaults(await projectJson(base, path, { method: 'PATCH', body: JSON.stringify(patch), signal }, request))
    },
  }
}
