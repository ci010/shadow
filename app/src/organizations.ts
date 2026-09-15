import { apiUrl, organizationBase, sessionKey, type SessionRef } from './api-url.ts'
import { isRecord, parseSessionGraph, type SidebarSession } from './projects-sidebar.ts'
import { parseSessionStages } from './session-activity.ts'

export interface OrganizationRecord {
  id: string
  name: string
  createdAt: string
}

export interface OrganizationRuntimeStatus {
  state: 'ready' | 'starting' | 'failed'
  error?: string
}

export function parseOrganizationRuntimeStatus(value: unknown): OrganizationRuntimeStatus {
  if (!isRecord(value) || !['ready', 'starting', 'failed'].includes(String(value.state))
    || (value.error !== undefined && typeof value.error !== 'string')) {
    throw new Error('Main returned invalid organization runtime status. Refresh to retry.')
  }
  return { state: value.state as OrganizationRuntimeStatus['state'], ...(typeof value.error === 'string' ? { error: value.error } : {}) }
}

export function parseOrganization(value: unknown): OrganizationRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.name !== 'string' || !value.name.trim() || typeof value.createdAt !== 'string') {
    throw new Error('Main returned an invalid organization. Refresh to retry.')
  }
  return { id: value.id, name: value.name, createdAt: value.createdAt }
}

export function parseOrganizations(value: unknown): OrganizationRecord[] {
  if (!isRecord(value) || !Array.isArray(value.organizations)) throw new Error('Main did not return the organization catalog. Update Main and retry.')
  const result = value.organizations.map(parseOrganization)
  if (new Set(result.map(org => org.id)).size !== result.length) throw new Error('Main returned duplicate organization IDs. Refresh to retry.')
  return result
}

export async function organizationJson(base: string, path: string, init?: RequestInit, request: typeof fetch = fetch): Promise<unknown> {
  const response = await request(apiUrl(base, path), {
    ...init, headers: { 'Content-Type': 'application/json', ...init?.headers },
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const detail = response.status === 409 ? 'The resource conflicts with an existing organization or folder.'
      : response.status === 401 || response.status === 403 ? 'Main did not authorize this request.'
      : `Main could not complete this request (HTTP ${response.status}).`
    throw new Error(`${detail} Check Main and retry.`)
  }
  return response.json()
}

export function createOrganizationsClient(base: string, request: typeof fetch = fetch) {
  return {
    async status(id: string, signal?: AbortSignal) {
      return parseOrganizationRuntimeStatus(await organizationJson(base, `/api/organizations/${encodeURIComponent(id)}/status`, { signal }, request))
    },
    async retry(id: string, signal?: AbortSignal) {
      return parseOrganizationRuntimeStatus(await organizationJson(base, `/api/organizations/${encodeURIComponent(id)}/retry`, { method: 'POST', signal }, request))
    },
    async list(signal?: AbortSignal) {
      return parseOrganizations(await organizationJson(base, '/api/organizations', { signal }, request))
    },
    async save(name: string, id?: string, signal?: AbortSignal) {
      if (!name.trim()) throw new Error('Enter an organization name.')
      const value = await organizationJson(base, `/api/organizations${id ? `/${encodeURIComponent(id)}` : ''}`,
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ name: name.trim() }), signal }, request)
      if (!isRecord(value)) throw new Error('Main returned an invalid organization update.')
      const organization = parseOrganization(value.organization)
      if (id && organization.id !== id) throw new Error('Main returned a different organization. Refresh before retrying.')
      return organization
    },
  }
}

export function organizationChatLocation(ref: SessionRef) {
  return { name: 'chat', params: { organizationId: ref.organizationId, sessionId: ref.sessionId || undefined } }
}

export function organizationResourceKey(organizationId: string, kind: string, id: string): string {
  return JSON.stringify([organizationId, kind, id])
}

export interface OrganizationConversationState {
  sessions: SidebarSession[]
  stages: Record<string, string>
  sessionsError: string
  stagesError: string
}

/** Each catalog row owns its requests; one failed runtime does not erase another. */
export async function fetchOrganizationConversations(base: string, organizationId: string, signal: AbortSignal,
  request: typeof fetch = fetch): Promise<OrganizationConversationState> {
  const scope = organizationBase(base, organizationId)
  const results = await Promise.allSettled([
    organizationJson(scope, '/api/sessions/graph', { signal }, request).then(value => parseSessionGraph(value, organizationId)),
    organizationJson(scope, '/api/sessions/stages', { signal }, request).then(parseSessionStages),
  ])
  const error = (reason: unknown) => reason instanceof Error ? reason.message : 'Could not load organization activity. Retry.'
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
