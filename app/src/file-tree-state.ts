import type { DirListing, FileEntry } from './composables/useSessionFiles.ts'

export interface FileTreeSource {
  apiBase: string
  sessionId: string
  folderId?: string
  home?: boolean
  sessionWorkspace?: boolean
}

export function fileWorkspaceKey(source: FileTreeSource, workdir?: DirListing['workdir']): string {
  if (!source.sessionWorkspace && workdir?.kind === 'local' && workdir.scope === 'home' && workdir.displayPath && !source.folderId) {
    return JSON.stringify([source.apiBase, 'home', workdir.displayPath])
  }
  return JSON.stringify([source.apiBase, source.sessionId, source.folderId, source.sessionWorkspace, workdir?.kind, workdir?.displayPath, workdir?.scope])
}

/** Keep the last verified Home inert until the new session's listing confirms its root. */
export function canRetainHomeTree(previous: FileTreeSource, next: FileTreeSource, workdir?: DirListing['workdir']): boolean {
  return !previous.sessionWorkspace && !next.sessionWorkspace && previous.apiBase === next.apiBase && !previous.folderId && !next.folderId
    && !!previous.sessionId && next.home === true
    && workdir?.kind === 'local' && workdir.scope === 'home' && !!workdir.displayPath
}

export function fileEntryKey(entry: Pick<FileEntry, 'name' | 'type'>): string {
  return `${entry.type}:${entry.name}`
}

export function reconcileFileEntries(previous: FileEntry[], incoming: readonly FileEntry[]): FileEntry[] {
  const byKey = new Map(previous.map(entry => [fileEntryKey(entry), entry]))
  const next = incoming.map(entry => {
    const existing = byKey.get(fileEntryKey(entry))
    return existing && existing.ext === entry.ext && existing.size === entry.size && existing.mtime === entry.mtime
      ? existing : entry
  })
  return next.length === previous.length && next.every((entry, index) => entry === previous[index]) ? previous : next
}
