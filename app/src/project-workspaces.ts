import { projectResourceKey } from './projects.ts'
import type { FolderRecord } from './folders-client.ts'
import type { SessionRef } from './api-url.ts'
import type { KnowledgeTabRequest } from './file-workbench.ts'

export interface ConversationResource extends SessionRef {
  key: string
  folder?: FolderRecord
  openRemote?: boolean
  childSessionId?: string
  knowledgeRequest?: KnowledgeTabRequest
}

/** A resource keeps its key while the first send gives its draft a session ID. */
export function createConversationResources() {
  const resources: ConversationResource[] = []
  return {
    resources,
    session(ref: SessionRef): ConversationResource {
      const existing = resources.find(item => item.projectId === ref.projectId && item.sessionId === ref.sessionId)
      if (existing) return existing
      const item = { ...ref, key: projectResourceKey(ref.projectId, 'session', ref.sessionId) }
      resources.push(item)
      return item
    },
    draft(projectId: string, folder?: FolderRecord, openRemote = false): ConversationResource {
      const id = openRemote ? 'remote' : folder?.id ?? 'scratch'
      const key = projectResourceKey(projectId, 'draft', id)
      const existing = resources.find(item => item.key === key && !item.sessionId)
      if (existing) return existing
      // Previously sent drafts stay mounted; the next draft receives another stable key.
      const item = { key: resources.some(item => item.key === key) ? `${key}:${crypto.randomUUID()}` : key,
        projectId, sessionId: '', folder, openRemote }
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
