import { t } from './i18n.ts'
import type { ToolDef } from './components/ToolsCard.vue'

export interface AgentTypeMeta {
  name: string
  description: string
  source: 'builtin' | 'workspace'
  allowedTools?: string[]
  blockedTools?: string[]
  defaultMode?: 'session' | 'task' | 'call'
  model?: string
  temperature?: number
  maxTokens?: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
function optionalNumber(value: unknown) {
  return value === undefined || typeof value === 'number' && Number.isFinite(value)
}
function isAgent(value: unknown): value is AgentTypeMeta {
  return record(value) && typeof value.name === 'string' && !!value.name.trim()
    && typeof value.description === 'string' && (value.source === 'builtin' || value.source === 'workspace')
    && (value.defaultMode === undefined || value.defaultMode === 'session' || value.defaultMode === 'task' || value.defaultMode === 'call')
    && (value.allowedTools === undefined || strings(value.allowedTools))
    && (value.blockedTools === undefined || strings(value.blockedTools))
    && (value.model === undefined || typeof value.model === 'string')
    && optionalNumber(value.temperature) && optionalNumber(value.maxTokens)
}
function isTool(value: unknown): value is ToolDef {
  if (!record(value) || typeof value.name !== 'string' || !value.name.trim() || typeof value.description !== 'string') return false
  const schema = value.parameters
  return schema === undefined || record(schema)
    && (schema.required === undefined || strings(schema.required))
    && (schema.properties === undefined || record(schema.properties) && Object.values(schema.properties).every(property =>
      record(property) && (property.type === undefined || typeof property.type === 'string' || strings(property.type))
      && (property.description === undefined || typeof property.description === 'string')))
}
export function parseAgentTypes(value: unknown): AgentTypeMeta[] {
  if (!Array.isArray(value) || !value.every(isAgent) || new Set(value.map(agent => agent.name)).size !== value.length) {
    throw new Error(t('Cannot read agent type definitions. Retry the catalog.'))
  }
  return value
}
export function parseAgentContext(value: unknown): { systemPrompt: string; tools: ToolDef[] } {
  if (!record(value) || typeof value.systemPrompt !== 'string' || !Array.isArray(value.tools)
    || !value.tools.every(isTool) || new Set(value.tools.map(tool => tool.name)).size !== value.tools.length) {
    throw new Error(t('Cannot read the assembled agent preview. Retry the preview.'))
  }
  return { systemPrompt: value.systemPrompt, tools: value.tools }
}
