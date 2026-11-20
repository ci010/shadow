import { promptSections, type PromptSection } from './prompt-sections.ts'
import { t } from './i18n.ts'
import type { ToolDef } from './components/ToolsCard.vue'

export interface AgentTypeMeta {
  name: string
  description: string
  prompt?: string
  definitionMarkdown?: string
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
    && (value.definitionMarkdown === undefined || typeof value.definitionMarkdown === 'string')
    && (value.prompt === undefined || typeof value.prompt === 'string')
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
export interface PromptIdentity {
  role: string
  definition: string
  version: 'v1' | 'v2'
  mode: 'session' | 'task' | 'call'
  behaviorSource: 'builtin' | 'workspace' | 'sub-draft' | 'agent-draft'
  promptRevision?: string
  subRevision?: string
}

export function parsePromptIdentity(value: unknown): PromptIdentity | undefined {
  if (!record(value) || typeof value.role !== 'string' || typeof value.definition !== 'string'
    || (value.version !== 'v1' && value.version !== 'v2')
    || (value.mode !== 'session' && value.mode !== 'task' && value.mode !== 'call')
    || (value.behaviorSource !== 'builtin' && value.behaviorSource !== 'workspace' && value.behaviorSource !== 'sub-draft' && value.behaviorSource !== 'agent-draft')) return
  const promptRevision = value.promptRevision
  if (value.behaviorSource === 'agent-draft' && (typeof promptRevision !== 'string' || !/^[a-f0-9]{64}$/.test(promptRevision))) return
  const revision = value.subRevision
  if (value.behaviorSource === 'sub-draft' && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) return
  return { role: value.role, definition: value.definition, version: value.version, mode: value.mode,
    behaviorSource: value.behaviorSource, ...(value.behaviorSource === 'agent-draft' && typeof promptRevision === 'string' ? { promptRevision } : {}), ...(typeof revision === 'string' && value.behaviorSource === 'sub-draft' ? { subRevision: revision } : {}) }
}

export function formatPromptIdentity(prompt: PromptIdentity) {
  const subject = prompt.role === prompt.definition ? prompt.role : `${prompt.role} (${prompt.definition})`
  const source = prompt.behaviorSource === 'agent-draft' || prompt.behaviorSource === 'sub-draft' ? `${t('Project draft')} @${prompt.promptRevision ?? prompt.subRevision}`
    : prompt.behaviorSource === 'workspace' ? t('Workspace') : t('Built-in default')
  return `${subject} · ${prompt.version.toUpperCase()} · ${prompt.mode} · ${source}`
}

export function parseAgentContext(value: unknown): { systemPrompt: string; sections: PromptSection[]; tools: ToolDef[]; rolePreview?: 'owner-web'; promptIdentity?: PromptIdentity } {
  if (!record(value) || typeof value.systemPrompt !== 'string' || !Array.isArray(value.tools)
    || !value.tools.every(isTool) || new Set(value.tools.map(tool => tool.name)).size !== value.tools.length) {
    throw new Error(t('Cannot read the assembled agent preview. Retry the preview.'))
  }
  const promptIdentity = parsePromptIdentity(value.promptIdentity)
  return { ...(promptIdentity ? { promptIdentity } : {}), systemPrompt: value.systemPrompt, sections: promptSections(value.systemPrompt, value.sections), tools: value.tools,
    ...(value.rolePreview === 'owner-web' ? { rolePreview: 'owner-web' as const } : {}) }
}
