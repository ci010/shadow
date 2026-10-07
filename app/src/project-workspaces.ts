import { t } from './i18n.ts'
import { projectResourceKey } from './projects.ts'
import { createUuid } from './uuid.ts'
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
    removeProject(projectId: string): void {
      for (let index = resources.length - 1; index >= 0; index--) {
        if (resources[index].projectId === projectId) resources.splice(index, 1)
      }
    },
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
      const item = { key: resources.some(item => item.key === key) ? `${key}:${createUuid()}` : key,
        projectId, sessionId: '', folder, openRemote }
      resources.push(item)
      return item
    },
    prepared(key: string, sessionId: string): ConversationResource {
      const item = resources.find(item => item.key === key)
      if (!item) throw new Error(t('The owning conversation draft is unavailable.'))
      if (item.sessionId && item.sessionId !== sessionId) throw new Error(t('A draft cannot change session identity.'))
      item.sessionId = sessionId
      return item
    },
  }
}
