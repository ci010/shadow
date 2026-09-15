import { organizationResourceKey } from './organizations.ts'
import type { ProjectRecord } from './projects-client.ts'
import type { SessionRef } from './api-url.ts'

export interface ConversationResource extends SessionRef {
  key: string
  project?: ProjectRecord
  openRemote?: boolean
  childSessionId?: string
}

/** A resource keeps its key while the first send gives its draft a session ID. */
export function createConversationResources() {
  const resources: ConversationResource[] = []
  return {
    resources,
    session(ref: SessionRef): ConversationResource {
      const existing = resources.find(item => item.organizationId === ref.organizationId && item.sessionId === ref.sessionId)
      if (existing) return existing
      const item = { ...ref, key: organizationResourceKey(ref.organizationId, 'session', ref.sessionId) }
      resources.push(item)
      return item
    },
    draft(organizationId: string, project?: ProjectRecord, openRemote = false): ConversationResource {
      const id = openRemote ? 'remote' : project?.id ?? 'scratch'
      const key = organizationResourceKey(organizationId, 'draft', id)
      const existing = resources.find(item => item.key === key && !item.sessionId)
      if (existing) return existing
      // Previously sent drafts stay mounted; the next draft receives another stable key.
      const item = { key: resources.some(item => item.key === key) ? `${key}:${crypto.randomUUID()}` : key,
        organizationId, sessionId: '', project, openRemote }
      resources.push(item)
      return item
    },
    prepared(key: string, sessionId: string): ConversationResource {
      const item = resources.find(item => item.key === key)
      if (!item) throw new Error('The owning conversation draft is unavailable.')
      if (item.sessionId && item.sessionId !== sessionId) throw new Error('A draft cannot change session identity.')
      item.sessionId = sessionId
      return item
    },
  }
}
