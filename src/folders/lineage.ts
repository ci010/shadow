import type { FolderRecord } from './contracts.ts'

/** Optional, versioned extension: old records remain roots with unknown ownership. */
export interface WorkspaceLineage {
  version: 1
  parentId: string
  backend: 'git-worktree' | 'layerfs'
  ownership: 'shadow-derived'
}
export function parseWorkspaceLineage(value: unknown): WorkspaceLineage {
  const item = value as WorkspaceLineage
  if (!item || item.version !== 1 || typeof item.parentId !== 'string' || !item.parentId ||
    !['git-worktree', 'layerfs'].includes(item.backend) || item.ownership !== 'shadow-derived' ||
    Object.keys(item).some(key => !['version', 'parentId', 'backend', 'ownership'].includes(key))) throw new Error('Invalid Workspace lineage')
  return { ...item }
}

/** Every record appears once. Missing parents and cycles are explicit roots, never dropped. */
export function workspaceTree(folders: FolderRecord[], render: (folder: FolderRecord) => string): string[] {
  const ids = new Set(folders.map(folder => folder.id))
  const emitted = new Set<string>()
  const lines: string[] = []
  const visit = (folder: FolderRecord, depth: number, warning = '') => {
    if (emitted.has(folder.id)) return
    emitted.add(folder.id)
    lines.push(`${'  '.repeat(depth)}- ${render(folder)}${warning}`)
    for (const child of folders) if (child.lineage?.parentId === folder.id) visit(child, depth + 1)
  }
  for (const folder of folders) if (!folder.lineage || !ids.has(folder.lineage.parentId)) visit(folder, 0, folder.lineage ? ' [parent unavailable]' : '')
  for (const folder of folders) if (!emitted.has(folder.id)) visit(folder, 0, ' [lineage cycle]')
  return lines
}
