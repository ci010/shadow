import { t } from './i18n.ts'
import type { FolderRecord, FoldersClient } from './folders-client.ts'
import { workdirAvailability, workdirSupportsOperations, type NodeInventoryEntry } from './node-inventory.ts'
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
    const resource = node?.workdirs.find(resource => resource.workdirId === folder.workdir.workdirId)
    const available = !!node && !!resource && workdirAvailability(node, resource) === 'online'
      && workdirSupportsOperations(node, resource.workdirId)
    return {
      folder, available,
      detail: `${node?.displayName ?? folder.workdir.nodeId} · ${folder.path}`,
      ...(!available ? { unavailableReason: node?.connection === 'revoked' ? t('Revoked')
        : node?.executionProtocol === 'upgrade-required' ? t('Update Main and this device') : t('Unavailable') } : {}),
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

/** Rank registered folders by direct-chat usage; ties use latest activity, then inventory order. */
export interface FolderUsageSession {
  folderId?: string
  isDirectChat: boolean
  parentSessionId: string | null
  lastActivityAt?: string
}

export function commonFolderTargets(targets: readonly ProjectFolderTarget[], sessions: readonly FolderUsageSession[]): ProjectFolderTarget[] {
  const usage = new Map<string, { count: number; latest: number }>()
  for (const session of sessions) {
    if (!session.folderId || !session.isDirectChat || session.parentSessionId) continue
    const entry = usage.get(session.folderId) ?? { count: 0, latest: 0 }
    entry.count++
    entry.latest = Math.max(entry.latest, Date.parse(session.lastActivityAt ?? '') || 0)
    usage.set(session.folderId, entry)
  }
  return [...targets].sort((a, b) => {
    const left = usage.get(a.folder.id)
    const right = usage.get(b.folder.id)
    return (right?.count ?? 0) - (left?.count ?? 0) || (right?.latest ?? 0) - (left?.latest ?? 0)
  }).slice(0, 3)
}
