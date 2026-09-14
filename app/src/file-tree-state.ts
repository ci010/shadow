import type { DirListing, FileEntry } from './composables/useSessionFiles.ts'
import { isSelfReflectionId } from '../../src/sessions/session-purpose.ts'

export interface FileTreeSource {
  apiBase: string
  sessionId: string
  projectId?: string
}

export function fileWorkspaceKey(source: FileTreeSource, workdir?: DirListing['workdir']): string {
  if (workdir?.kind === 'local' && workdir.scope === 'home' && workdir.displayPath && !source.projectId) {
    return JSON.stringify([source.apiBase, 'home', workdir.displayPath])
  }
  return JSON.stringify([source.apiBase, source.sessionId, source.projectId, workdir?.kind, workdir?.displayPath, workdir?.scope])
}

/** Keep the last verified Home inert until the new session's listing confirms its root. */
export function canRetainHomeTree(previous: FileTreeSource, next: FileTreeSource, workdir?: DirListing['workdir']): boolean {
  return previous.apiBase === next.apiBase && !previous.projectId && !next.projectId
    && !!previous.sessionId && isSelfReflectionId(next.sessionId)
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
