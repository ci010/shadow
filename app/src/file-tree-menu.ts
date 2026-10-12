import type { DirListing, FileEntry } from './composables/useSessionFiles.ts'

export interface FileTreeMenuRequest {
  event: MouseEvent | KeyboardEvent
  path: string
  entry?: FileEntry
  shortcut?: FileTreeShortcut
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

export type FileTreeShortcut = 'copy-full' | 'copy-relative' | 'reveal'

/** Only claim explicit file actions, never AltGr, IME input or an already handled key. */
export function fileTreeShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'isComposing' | 'defaultPrevented'>): FileTreeShortcut | undefined {
  if (event.defaultPrevented || event.isComposing || event.metaKey) return
  const key = event.key.toLowerCase()
  if (key === 'c' && event.ctrlKey && !event.altKey) return event.shiftKey ? 'copy-relative' : 'copy-full'
  if (key === 'r' && event.altKey && event.shiftKey && !event.ctrlKey) return 'reveal'
}
