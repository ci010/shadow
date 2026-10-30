import { t } from './i18n.ts'
import { createChatDraft, deferChatSession } from './chat-draft.ts'
import { workdirAvailability, workdirSupportsOperations, type NodeInventoryEntry } from './node-inventory.ts'
import { isRecord } from './folders-sidebar.ts'
import { apiUrl } from './api-url.ts'
import { createUuid } from './uuid.ts'
import { isExecutionIdentifier } from '../../src/execution/workdir-contracts.ts'
import { workdirUnavailableMessage } from './workdir-request-error.ts'
import type { FolderRecord, FoldersClient } from './folders-client.ts'

export interface RemoteConversationTarget {
  nodeId: string
  workdirId: string
  nodeName: string
  displayName: string
  displayPath?: string
  available: boolean
}

export interface RemoteNodeTarget {
  nodeId: string
  workdirId?: never
  nodeName: string
  displayName: string
  displayPath?: never
  available: boolean
  unavailableReason?: string
}

export type RemoteChatTarget = RemoteConversationTarget | RemoteNodeTarget

export function remoteNodeTargets(nodes: readonly NodeInventoryEntry[]): RemoteNodeTarget[] {
  return nodes.filter(node => node.role === 'child').map(node => {
    const supported = node.supportsManagedSessions === true && node.support.operations.includes('workdir.session.allocate')
    return {
      nodeId: node.nodeId, nodeName: node.displayName, displayName: t('From scratch'),
      available: node.executionProtocol === 'compatible' && node.connection === 'connected' && supported,
      ...(node.connection !== 'connected'
        ? { unavailableReason: node.connection === 'revoked' ? t('Revoked') : t('Offline') }
        : node.executionProtocol !== 'compatible' ? { unavailableReason: t('Update Main and this device') }
        : !supported ? { unavailableReason: t('Update this device to start from scratch') } : {}),
    }
  })
}

/** Read-only discovery; callers cannot infer Project authorization from these resources. */
export function remoteConversationTargets(nodes: readonly NodeInventoryEntry[]): RemoteConversationTarget[] {
  return nodes.filter(node => node.role === 'child').flatMap(node =>
    node.workdirs.map(resource => ({
      nodeId: node.nodeId, workdirId: resource.workdirId,
      nodeName: node.displayName, displayName: resource.displayName,
      ...(resource.displayPath ? { displayPath: resource.displayPath } : {}),
      available: workdirAvailability(node, resource) === 'online' && workdirSupportsOperations(node, resource.workdirId),
    })))
}

export function createFolderChatDraft(client: Pick<FoldersClient, 'createSession'>, folder?: FolderRecord) {
  if (folder?.kind !== 'remote') return createChatDraft(client, folder)
  const remote: RemoteConversationTarget = {
    nodeId: folder.workdir.nodeId, workdirId: folder.workdir.workdirId,
    nodeName: folder.workdir.nodeId, displayName: folder.workdir.displayName ?? folder.name,
    displayPath: folder.workdir.displayPathSnapshot ?? folder.path, available: false,
  }
  const requestId = createUuid()
  const folderId = folder.id
  return {
    folder, remote,
    ...deferChatSession(async signal => (await client.createSession(folderId, signal, requestId)).sessionId),
  }
}

export function createRemoteChatDraft(apiBase: string, target: RemoteChatTarget, request: typeof fetch = fetch,
  createRequestId: () => string = createUuid) {
  const selection = Object.freeze({ ...target })
  if ('capabilityId' in selection || 'resourceId' in selection || !isExecutionIdentifier(selection.nodeId) || selection.workdirId !== undefined && !isExecutionIdentifier(selection.workdirId)) {
    throw new Error(t('The selected remote workspace is invalid. Select its original project folder again. No local folder was used.'))
  }
  const requestId = createRequestId()
  return {
    ...deferChatSession(async signal => {
      const response = await request(apiUrl(apiBase, '/api/sessions/remote'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: selection.nodeId, workdirId: selection.workdirId, requestId }),
        signal,
      })
      if (!response.ok) {
        if ((response.status === 409 || response.status === 503) && response.headers.get('content-type')?.includes('application/json')) {
          const detail: unknown = await response.json()
          const unavailable = workdirUnavailableMessage(detail)
          if (unavailable) throw new Error(unavailable)
          if (isRecord(detail) && detail.error === 'managed_sessions_unsupported') {
            throw new Error(t('This device does not support remote Start from scratch. Update the device and retry. No local folder was used.'))
          }
          if (isRecord(detail) && ['remote_folder_identity_required', 'remote_workdir_identity_unsupported'].includes(String(detail.error))) {
            throw new Error(t('This device cannot verify remote folder ownership for a project. Update Main and the device to a version supporting ownership verification, then retry. No local folder was used.'))
          }
          if (isRecord(detail) && detail.error === 'folder_owned_by_another_project') {
            throw new Error(t('This remote folder overlaps a folder in another project. Choose a different folder. No local folder was used.'))
          }
          if (isRecord(detail) && ['remote_workdir_changed', 'legacy_remote_identity_unavailable'].includes(String(detail.error))) {
            throw new Error(t('An existing remote folder could not be verified. Restore and reconnect its original folder resource before retrying. No local folder was used.'))
          }
        }
        if (response.status === 409 || response.status === 503) {
          throw new Error(t('The selected remote workspace is unavailable. Reconnect its device or choose another location. No local folder was used.'))
        }
        if (response.status === 401 || response.status === 403) throw new Error(t('Remote conversation access was denied. Reconnect the authorized Main app.'))
        throw new Error(t('Could not start the remote conversation ({status}). Retry when Main is available.', { status: response.status }))
      }
      const result: unknown = await response.json()
      if (isRecord(result) && isRecord(result.workdir) && result.workdir.version === 1) {
        throw new Error(t('This device uses an incompatible execution protocol. Update Main and the device, then retry. No local folder was used.'))
      }
      if (!isRecord(result) || typeof result.chatId !== 'string' || !result.chatId.startsWith('chat-')
        || result.sessionId !== `web:${result.chatId}` || !isRecord(result.workdir)
        || result.workdir.version !== 2 || result.workdir.capabilityId !== undefined || result.workdir.resourceId !== undefined || Object.keys(result.workdir).some(key => !['version','nodeId','workdirId','displayName','displayPathSnapshot'].includes(key)) || result.workdir.nodeId !== selection.nodeId
        || typeof result.workdir.workdirId !== 'string' || !result.workdir.workdirId.trim()
        || (result.workdir.displayName !== undefined && typeof result.workdir.displayName !== 'string')
        || (result.workdir.displayPathSnapshot !== undefined && typeof result.workdir.displayPathSnapshot !== 'string')
        || ('workdirId' in selection ? result.workdir.workdirId !== selection.workdirId : result.folderId !== undefined)) {
        throw new Error(t('Main returned an invalid remote conversation. Refresh before retrying.'))
      }
      return `web:${result.chatId}`
    }),
    folder: undefined,
    remote: selection,
  }
}
