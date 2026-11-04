import { formatDateTime, i18n, t } from './i18n.ts'
import { formatSidebarActivity } from './sidebar-chat-time.ts'
import { sidebarFolderLabels, sidebarFolderTones } from './sidebar-folder-labels.ts'
import type { SidebarSession } from './folders-sidebar.ts'
import type { FolderRecord } from './folders-client.ts'
import type { NodeInventoryEntry } from './node-inventory.ts'

export function sessionListMetadata(session: SidebarSession, folders: readonly FolderRecord[], nodes: readonly NodeInventoryEntry[], now: number) {
  const folder = folders.find(folder => folder.id === session.folderId)
  const nodeId = folder?.kind === 'remote' ? folder.workdir.nodeId : undefined
  const node = nodeId ? nodes.find(node => node.nodeId === nodeId) : nodes.find(node => node.role === 'main')
  return {
    node: folder ? node?.displayName || nodeId || t('This computer') : undefined,
    folder: session.folderId ? folders.find(folder => folder.id === session.folderId)?.name ?? session.folderId : t('from scratch'),
    folderTitle: session.folderId ? sidebarFolderLabels(folders, nodes, t('This computer')).get(session.folderId) ?? session.folderId : t('from scratch'),
    folderTone: session.folderId ? sidebarFolderTones(folders).get(session.folderId) : undefined,
    time: formatSidebarActivity(session.lastActivityAt, now, i18n.global.locale.value),
    absoluteTime: session.lastActivityAt ? formatDateTime(session.lastActivityAt) : '',
  }
}
