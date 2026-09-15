import { createChatDraft, deferChatSession } from './chat-draft.ts'
import { capabilityAvailability, type NodeInventoryEntry } from './node-inventory.ts'
import { isRecord } from './projects-sidebar.ts'
import { apiUrl } from './api-url.ts'
import type { ProjectRecord, ProjectsClient } from './projects-client.ts'

export interface RemoteConversationTarget {
  nodeId: string
  capabilityId: string
  nodeName: string
  displayName: string
  displayPath?: string
  available: boolean
}

export function remoteConversationTargets(nodes: readonly NodeInventoryEntry[]): RemoteConversationTarget[] {
  return nodes.filter(node => node.role === 'child').flatMap(node =>
    node.capabilities.filter(capability => capability.kind === 'workdir').map(capability => ({
      nodeId: node.nodeId, capabilityId: capability.capabilityId,
      nodeName: node.displayName, displayName: capability.displayName,
      ...(capability.displayPath ? { displayPath: capability.displayPath } : {}),
      available: capabilityAvailability(node, capability) === 'online',
    })))
}

export function createProjectChatDraft(client: Pick<ProjectsClient, 'createSession'>, project?: ProjectRecord) {
  if (project?.kind !== 'remote') return createChatDraft(client, project)
  const remote: RemoteConversationTarget = {
    nodeId: project.workdir.nodeId, capabilityId: project.workdir.capabilityId,
    nodeName: project.workdir.nodeId, displayName: project.workdir.displayName ?? project.name,
    displayPath: project.workdir.displayPathSnapshot ?? project.path, available: false,
  }
  const requestId = crypto.randomUUID()
  return {
    project, remote,
    ...deferChatSession(async signal => (await client.createSession(project.id, signal, requestId)).sessionId),
  }
}

export function createRemoteChatDraft(apiBase: string, target: RemoteConversationTarget, request: typeof fetch = fetch,
  createRequestId: () => string = () => crypto.randomUUID()) {
  const selection = { ...target }
  const requestId = createRequestId()
  return {
    ...deferChatSession(async signal => {
      const response = await request(apiUrl(apiBase, '/api/sessions/remote'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: selection.nodeId, capabilityId: selection.capabilityId, requestId }),
        signal,
      })
      if (!response.ok) {
        if (response.status === 409 && response.headers.get('content-type')?.includes('application/json')) {
          const detail: unknown = await response.json()
          if (isRecord(detail) && ['remote_project_identity_required', 'remote_workdir_identity_unsupported'].includes(String(detail.error))) {
            throw new Error('This device cannot verify remote folder ownership for an organization. Update Main and the device to a version supporting ownership verification, then retry. No local folder was used.')
          }
          if (isRecord(detail) && detail.error === 'folder_owned_by_another_organization') {
            throw new Error('This remote folder overlaps a project in another organization. Choose a different folder. No local folder was used.')
          }
          if (isRecord(detail) && ['remote_workdir_changed', 'legacy_remote_identity_unavailable'].includes(String(detail.error))) {
            throw new Error('An existing remote folder could not be verified. Restore and reconnect its original folder capability before retrying. No local folder was used.')
          }
        }
        if (response.status === 409 || response.status === 503) {
          throw new Error('The selected remote workspace is unavailable. Reconnect its device or choose another location. No local folder was used.')
        }
        if (response.status === 401 || response.status === 403) throw new Error('Remote conversation access was denied. Reconnect the authorized Main app.')
        throw new Error(`Could not start the remote conversation (${response.status}). Retry when Main is available.`)
      }
      const result: unknown = await response.json()
      if (!isRecord(result) || typeof result.chatId !== 'string' || !result.chatId.startsWith('chat-')
        || result.sessionId !== `web:${result.chatId}` || !isRecord(result.workdir)
        || result.workdir.version !== 1 || result.workdir.nodeId !== selection.nodeId
        || result.workdir.capabilityId !== selection.capabilityId) {
        throw new Error('Main returned an invalid remote conversation. Refresh before retrying.')
      }
      return `web:${result.chatId}`
    }),
    project: undefined,
    remote: selection,
  }
}
