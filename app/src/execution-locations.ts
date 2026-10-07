import { t } from './i18n.ts'
import type { FolderRecord, FoldersClient } from './folders-client.ts'
import { capabilityAvailability, type NodeInventoryEntry } from './node-inventory.ts'
import { createFolderChatDraft, createRemoteChatDraft, type RemoteNodeTarget } from './remote-conversations.ts'

export type ExecutionLocation =
  | { kind: 'folder'; folder: FolderRecord }
  | { kind: 'node'; node: RemoteNodeTarget }

export interface ProjectFolderTarget {
  folder: FolderRecord
  available: boolean
  detail: string
  unavailableReason?: string
}

export function projectFolderTargets(projectId: string, folders: readonly FolderRecord[], nodes: readonly NodeInventoryEntry[]): ProjectFolderTarget[] {
  return folders.filter(folder => folder.projectId === projectId).map(folder => {
    if (folder.kind !== 'remote') return { folder, available: true, detail: folder.path }
    const node = nodes.find(node => node.role === 'child' && node.nodeId === folder.workdir.nodeId)
    const capability = node?.capabilities.find(capability => capability.kind === 'workdir' && capability.capabilityId === folder.workdir.capabilityId)
    const available = !!node && !!capability && capabilityAvailability(node, capability) === 'online'
    return {
      folder, available,
      detail: `${node?.displayName ?? folder.workdir.nodeId} · ${folder.path}`,
      ...(!available ? { unavailableReason: node?.connection === 'revoked' ? t('Revoked') : t('Unavailable') } : {}),
    }
  })
}

export function createExecutionLocationDraft(
  apiBase: string, projectId: string, client: Pick<FoldersClient, 'createSession'>, location?: ExecutionLocation,
) {
  if (location?.kind === 'folder' && location.folder.projectId !== projectId) {
    throw new Error(t('This folder does not belong to the current project. Refresh the locations and retry.'))
  }
  return location?.kind === 'node'
    ? createRemoteChatDraft(apiBase, location.node)
    : createFolderChatDraft(client, location?.folder)
}
