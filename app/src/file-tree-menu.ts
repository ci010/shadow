import type { DirListing, FileEntry } from './composables/useSessionFiles.ts'

export interface FileTreeMenuRequest {
  event: MouseEvent | KeyboardEvent
  path: string
  entry?: FileEntry
}

export function fileTreePaths(workdir: DirListing['workdir'], path: string) {
  const root = workdir?.displayPath
  const separator = root && /^(?:[a-z]:[\\/]|\\\\)/i.test(root) ? '\\' : '/'
  return {
    relative: path || '.',
    full: root ? path ? `${root.replace(/[\\/]+$/, '')}${separator}${path.replaceAll('/', separator)}` : root : '',
  }
}

export function canShowInExplorer(workdir: DirListing['workdir'], desktop: boolean, archive = false): boolean {
  return desktop && workdir?.kind === 'local' && !!workdir.displayPath && !archive
}
