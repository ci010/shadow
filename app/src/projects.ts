import { t } from './i18n.ts'
import { apiUrl, projectBase, sessionKey, type SessionRef } from './api-url.ts'
import { isRecord, parseSessionGraph, type SidebarSession } from './folders-sidebar.ts'
import { parseSessionStages } from './session-activity.ts'
import { ORCHESTRATOR_SESSION_ID } from './project-coordination.ts'

export interface ProjectRecord {
  id: string
  name: string
  createdAt: string
}

export interface ProjectRuntimeStatus {
  state: 'ready' | 'starting' | 'failed'
  error?: string
}

export function parseProjectRuntimeStatus(value: unknown): ProjectRuntimeStatus {
  if (!isRecord(value) || !['ready', 'starting', 'failed'].includes(String(value.state))
    || (value.error !== undefined && typeof value.error !== 'string')) {
    throw new Error(t('Main returned invalid project runtime status. Refresh to retry.'))
  }
  return { state: value.state as ProjectRuntimeStatus['state'], ...(typeof value.error === 'string' ? { error: value.error } : {}) }
}

export function parseProject(value: unknown): ProjectRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.name !== 'string' || !value.name.trim() || typeof value.createdAt !== 'string') {
    throw new Error(t('Main returned an invalid project. Refresh to retry.'))
  }
  return { id: value.id, name: value.name, createdAt: value.createdAt }
}

export function parseProjects(value: unknown): ProjectRecord[] {
  if (!isRecord(value) || !Array.isArray(value.projects)) throw new Error(t('Main did not return the project catalog. Update Main and retry.'))
  const result = value.projects.map(parseProject)
  if (new Set(result.map(org => org.id)).size !== result.length) throw new Error(t('Main returned duplicate project IDs. Refresh to retry.'))
  return result
}

export async function projectJson(base: string, path: string, init?: RequestInit, request: typeof fetch = fetch): Promise<unknown> {
  const response = await request(apiUrl(base, path), {
    ...init, headers: { 'Content-Type': 'application/json', ...init?.headers },
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const detail = response.status === 409 ? t('The resource conflicts with an existing project or folder.')
      : response.status === 401 || response.status === 403 ? t('Main did not authorize this request.')
      : t('Main could not complete this request (HTTP {status}).', { status: response.status })
    throw new Error(t('{detail} Check Main and retry.', { detail: detail }))
  }
  return response.json()
}

export function createProjectsClient(base: string, request: typeof fetch = fetch) {
  return {
    async remove(id: string, signal?: AbortSignal) {
      if (id === 'default') throw new Error(t('The Default project is required and cannot be deleted.'))
      const response = await request(apiUrl(base, `/api/projects/${encodeURIComponent(id)}`), {
        method: 'DELETE', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      })
      const value: unknown = await response.json()
      if (!response.ok) {
        const message = isRecord(value) && typeof value.message === 'string' ? value.message
          : t('Main did not confirm project deletion (HTTP {status}). Refresh the catalog before retrying.', { status: response.status })
        throw new Error(message)
      }
      if (!isRecord(value) || value.deletedProjectId !== id) {
        throw new Error(t('Main did not confirm deletion of this project. Refresh the catalog before retrying.'))
      }
    },
    async status(id: string, signal?: AbortSignal) {
      return parseProjectRuntimeStatus(await projectJson(base, `/api/projects/${encodeURIComponent(id)}/status`, { signal }, request))
    },
    async retry(id: string, signal?: AbortSignal) {
      return parseProjectRuntimeStatus(await projectJson(base, `/api/projects/${encodeURIComponent(id)}/retry`, { method: 'POST', signal }, request))
    },
    async list(signal?: AbortSignal) {
      return parseProjects(await projectJson(base, '/api/projects', { signal }, request))
    },
    async save(name: string, id?: string, signal?: AbortSignal) {
      if (!name.trim()) throw new Error(t('Enter a project name.'))
      const value = await projectJson(base, `/api/projects${id ? `/${encodeURIComponent(id)}` : ''}`,
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ name: name.trim() }), signal }, request)
      if (!isRecord(value)) throw new Error(t('Main returned an invalid project update.'))
      const project = parseProject(value.project)
      if (id && project.id !== id) throw new Error(t('Main returned a different project. Refresh before retrying.'))
      return project
    },
  }
}

export async function ensureProjectOrchestrator(base: string, projectId: string, signal: AbortSignal,
  request: typeof fetch = fetch): Promise<string> {
  const value = await projectJson(projectBase(base, projectId), '/api/orchestrator',
    { method: 'POST', body: '{}', signal }, request)
  if (!isRecord(value) || value.projectId !== projectId
    || value.sessionId !== ORCHESTRATOR_SESSION_ID || value.chatId !== 'orchestrator') {
    throw new Error(t('Main returned a different Project coordinator. Refresh and retry.'))
  }
  return value.sessionId
}

export function projectChatLocation(ref: SessionRef) {
  return { name: 'chat', params: { projectId: ref.projectId, sessionId: ref.sessionId || undefined } }
}

export function projectResourceKey(projectId: string, kind: string, id: string): string {
  return JSON.stringify([projectId, kind, id])
}

export interface ProjectConversationState {
  sessions: SidebarSession[]
  stages: Record<string, string>
  sessionsError: string
  stagesError: string
}

/** Each catalog row owns its requests; one failed runtime does not erase another. */
export async function fetchProjectConversations(base: string, projectId: string, signal: AbortSignal,
  request: typeof fetch = fetch): Promise<ProjectConversationState> {
  const scope = projectBase(base, projectId)
  const results = await Promise.allSettled([
    projectJson(scope, '/api/sessions/graph', { signal }, request).then(value => parseSessionGraph(value, projectId)),
    projectJson(scope, '/api/sessions/stages', { signal }, request).then(parseSessionStages),
  ])
  const error = (reason: unknown) => reason instanceof Error ? reason.message : t('Could not load project activity. Retry.')
  return {
    sessions: results[0].status === 'fulfilled' ? results[0].value : [],
    stages: results[1].status === 'fulfilled' ? results[1].value : {},
    sessionsError: results[0].status === 'rejected' ? error(results[0].reason) : '',
    stagesError: results[1].status === 'rejected' ? error(results[1].reason) : '',
  }
}

export function sameSession(a: SessionRef, b: SessionRef): boolean {
  return sessionKey(a) === sessionKey(b)
}
