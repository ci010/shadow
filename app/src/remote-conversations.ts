import { createChatDraft, deferChatSession } from './chat-draft.ts'
import { capabilityAvailability, type NodeInventoryEntry } from './node-inventory.ts'
import { isRecord } from './folders-sidebar.ts'
import { apiUrl } from './api-url.ts'
import type { FolderRecord, FoldersClient } from './folders-client.ts'

export interface RemoteConversationTarget {
  nodeId: string
  capabilityId: string
  nodeName: string
  displayName: string
  displayPath?: string
  available: boolean
}

export interface RemoteNodeTarget {
  nodeId: string
  capabilityId?: never
  nodeName: string
  displayName: string
  displayPath?: never
  available: boolean
  unavailableReason?: string
}

export type RemoteChatTarget = RemoteConversationTarget | RemoteNodeTarget

export function remoteNodeTargets(nodes: readonly NodeInventoryEntry[]): RemoteNodeTarget[] {
  return nodes.filter(node => node.role === 'child').map(node => ({
    nodeId: node.nodeId, nodeName: node.displayName, displayName: 'From scratch',
    available: node.connection === 'connected' && node.supportsManagedSessions === true,
    ...(node.connection !== 'connected'
      ? { unavailableReason: node.connection === 'revoked' ? 'Revoked' : 'Offline' }
      : !node.supportsManagedSessions ? { unavailableReason: 'Update this device to start from scratch' } : {}),
  }))
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

export function createFolderChatDraft(client: Pick<FoldersClient, 'createSession'>, folder?: FolderRecord) {
  if (folder?.kind !== 'remote') return createChatDraft(client, folder)
  const remote: RemoteConversationTarget = {
    nodeId: folder.workdir.nodeId, capabilityId: folder.workdir.capabilityId,
    nodeName: folder.workdir.nodeId, displayName: folder.workdir.displayName ?? folder.name,
    displayPath: folder.workdir.displayPathSnapshot ?? folder.path, available: false,
  }
  const requestId = crypto.randomUUID()
  return {
    folder, remote,
    ...deferChatSession(async signal => (await client.createSession(folder.id, signal, requestId)).sessionId),
  }
}

export function createRemoteChatDraft(apiBase: string, target: RemoteChatTarget, request: typeof fetch = fetch,
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
          if (isRecord(detail) && detail.error === 'managed_sessions_unsupported') {
            throw new Error('This device does not support remote Start from scratch. Update the device and retry. No local folder was used.')
          }
          if (isRecord(detail) && ['remote_folder_identity_required', 'remote_workdir_identity_unsupported'].includes(String(detail.error))) {
            throw new Error('This device cannot verify remote folder ownership for a project. Update Main and the device to a version supporting ownership verification, then retry. No local folder was used.')
          }
          if (isRecord(detail) && detail.error === 'folder_owned_by_another_project') {
            throw new Error('This remote folder overlaps a folder in another project. Choose a different folder. No local folder was used.')
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
        || typeof result.workdir.capabilityId !== 'string' || !result.workdir.capabilityId
        || (selection.capabilityId ? result.workdir.capabilityId !== selection.capabilityId : result.folderId !== undefined)) {
        throw new Error('Main returned an invalid remote conversation. Refresh before retrying.')
      }
      return `web:${result.chatId}`
    }),
    folder: undefined,
    remote: selection,
  }
}
