import { t } from './i18n.ts'
import { diagnosticEndpoint, diagnosticId, DIAGNOSTIC_ID_HEADER } from '../../src/runtime/api-request-diagnostic.ts'
import { apiUrl, projectBase, sessionKey, type SessionRef } from './api-url.ts'
import { isRecord, type SidebarSession } from './folders-sidebar.ts'
import { parseSessionSummary } from './session-summary-snapshot.ts'
import { parseSessionStages } from './session-activity.ts'

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

async function projectResponse<T>(base: string, path: string, init: RequestInit | undefined, request: typeof fetch,
  consume: (response: Response) => Promise<T>, conditional = false): Promise<T> {
  const start = performance.now()
  let headersMs: number | undefined
  let status: number | undefined
  let id: string | undefined
  let stage: 'fetch' | 'headers' | 'consume' = 'fetch'
  const timeout = AbortSignal.timeout(15_000)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  try {
    const headers = new Headers(init?.headers)
    if (init?.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const response = await request(apiUrl(base, path), {
      ...init, headers,
      signal,
    })
    stage = 'headers'
    headersMs = Math.max(0, Math.round(performance.now() - start))
    status = response.status
    id = diagnosticId(response.headers.get(DIAGNOSTIC_ID_HEADER))
    if (!response.ok && !(conditional && response.status === 304)) {
      const detail = response.status === 409 ? t('The resource conflicts with an existing project or folder.')
        : response.status === 401 || response.status === 403 ? t('Main did not authorize this request.')
        : t('Main could not complete this request (HTTP {status}).', { status: response.status })
      throw new Error(t('{detail} Check Main and retry.', { detail: detail }))
    }
    stage = 'consume'
    return await consume(response)
  } catch (error) {
    // Fixed labels/numbers only. Existing development console collector forwards
    // this best-effort; do not clone/intercept response streams or retain payloads.
    const endpoint = diagnosticEndpoint(path.split(/[?#]/, 1)[0]!)
    const deadlineFailure = timeout.aborted && signal.reason === timeout.reason
      && (error === timeout.reason || (error instanceof Error && error.name === 'AbortError'))
    const cause = init?.signal?.aborted ? 'caller-cancelled'
      : deadlineFailure ? 'deadline'
      : status !== undefined && status >= 400 ? 'http' : 'network-or-decode'
    if (endpoint && cause !== 'caller-cancelled') {
      try { console.warn(`API project failure ${JSON.stringify({ endpoint, id, status, stage, cause, headersMs, elapsedMs: Math.max(0, Math.round(performance.now() - start)) })}`) } catch { /* diagnostic only */ }
    }
    // Fetch and body readers can report AbortError instead of the timeout reason.
    // Only translate cancellation caused by our deadline, not caller cancellation
    // or an unrelated network/JSON/HTTP failure that happens near the deadline.
    if (timeout.aborted && signal.reason === timeout.reason
      && (error === timeout.reason || (error instanceof Error && error.name === 'AbortError'))) {
      throw new Error(t('The project request timed out after 15 seconds. Check Main and retry.'))
    }
    throw error
  }
}

export async function projectJson(base: string, path: string, init?: RequestInit, request: typeof fetch = fetch): Promise<unknown> {
  return projectResponse(base, path, init, request, response => response.json())
}

/** A single endpoint's validated snapshot, scoped to its owning live reader.
 * Always revalidate against Main; never use a disk/browser cache or reuse across
 * Projects/queries. Older servers without ETag continue to return full JSON. */
export function createConditionalProjectJson<T>(base: string, path: string, parse: (value: unknown) => T, request: typeof fetch = fetch,
  transport?: { headers: Record<string, string>; decode: (value: unknown, previous: T | undefined, etag: string | undefined) => unknown }) {
  let cached: { etag: string; value: T } | undefined
  let generation = 0
  return {
    clear() { cached = undefined; generation++ },
    async load(signal: AbortSignal): Promise<T> {
      const current = ++generation
      const previous = cached
      const headers = new Headers(transport?.headers)
      if (previous) headers.set('If-None-Match', previous.etag)
      return projectResponse(base, path, { signal, headers, cache: 'no-store' }, request, async response => {
        signal.throwIfAborted()
        if (response.status === 304) {
          if (!previous) throw new Error('Main returned 304 without a validated snapshot.')
          return previous.value
        }
        const json: unknown = await response.json()
        const value = parse(transport ? transport.decode(json, previous?.value, previous?.etag) : json)
        signal.throwIfAborted()
        const etag = response.headers.get('ETag')
        if (current === generation) cached = etag ? { etag, value } : undefined
        return value
      }, true)
    },
  }
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
    projectJson(scope, '/api/sessions/summary', { signal }, request).then(value => parseSessionSummary(value, projectId)),
    projectJson(scope, '/api/sessions/stages', { signal }, request).then(parseSessionStages),
  ])
  const error = (reason: unknown) => reason instanceof Error ? reason.message : t('Could not load project activity. Retry.')
  const stages = results[1].status === 'fulfilled' ? results[1].value : undefined
  return {
    sessions: results[0].status === 'fulfilled' ? results[0].value : [],
    stages: stages ? results[0].status === 'fulfilled'
      ? Object.fromEntries(results[0].value.map(session => [session.sessionId,
        Object.hasOwn(stages, session.sessionId) ? stages[session.sessionId] : 'inactive']))
      : stages : {},
    sessionsError: results[0].status === 'rejected' ? error(results[0].reason) : '',
    stagesError: results[1].status === 'rejected' ? error(results[1].reason) : '',
  }
}

export function sameSession(a: SessionRef, b: SessionRef): boolean {
  return sessionKey(a) === sessionKey(b)
}
