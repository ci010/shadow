import { apiUrl } from './api-url.ts'
import { parseAgentTypes } from './agent-types.ts'
import { t } from './i18n.ts'

export const AGENT_DEFINITION_PREFIX = 'agent-definition:'
const BOT_DOCUMENT_PREFIX = 'bot-document:'
export const agentDefinitionId = (name: string) => `${AGENT_DEFINITION_PREFIX}${name}`
export const agentDefinitionName = (id: string) => id.startsWith(AGENT_DEFINITION_PREFIX) ? id.slice(AGENT_DEFINITION_PREFIX.length) || undefined : undefined
export const botDocumentId = (bot: string, path: string) => `${BOT_DOCUMENT_PREFIX}${bot}/${path}`
export function botDocumentTarget(id: string) {
  const match = /^bot-document:([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/(.+\.md|\.md)$/i.exec(id)
  return match && { bot: match[1]!, path: match[2]! }
}

const unavailable = () => new Error(t('Could not load definition documents. Refresh and retry.'))
async function read(base: string, route: string, params: Record<string, string>, signal: AbortSignal, request: typeof fetch) {
  const response = await request(apiUrl(base, route, params), { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
  if (!response.ok) throw unavailable()
  return response.json()
}
export function listAgentDefinitions(base: string, signal: AbortSignal, request: typeof fetch) {
  return read(base, '/api/agent-types', { view: 'index' }, signal, request).then(parseAgentTypes)
}
export async function listBotDocuments(base: string, projectId: string, signal: AbortSignal, request: typeof fetch) {
  const data = await read(base, '/api/bot-package', { documents: 'markdown' }, signal, request)
  if (data?.projectId !== projectId || !Array.isArray(data.documents) || typeof data.partial !== 'boolean') throw unavailable()
  const documents: { id: string; revision: string; paths: string[] }[] = data.documents
  if (!documents.every(bot => typeof bot?.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(bot.id)
    && typeof bot.revision === 'string' && /^[a-f0-9]{64}$/.test(bot.revision)
    && Array.isArray(bot.paths) && bot.paths.every(path => typeof path === 'string' && /\.md$/i.test(path)))) throw unavailable()
  return { documents, partial: data.partial as boolean }
}
export async function readBotDocument(base: string, bot: string, path: string, revision: string, signal: AbortSignal, request: typeof fetch) {
  const data = await read(base, `/api/bot-package/${encodeURIComponent(bot)}/prompt`, { path, revision }, signal, request)
  if (data?.id !== bot || data.revision !== revision || data.path !== path || typeof data.prompt !== 'string') throw unavailable()
  return data.prompt as string
}
