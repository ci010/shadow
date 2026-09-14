import type { FileEntry } from './composables/useSessionFiles.ts'

export interface OpenFile {
  path: string
  entry: FileEntry
  view?: 'diff'
}

export function fileTabKey(file: OpenFile): string {
  return file.view === 'diff' ? `\0diff:${file.path}` : file.path
}

export interface FileTabs {
  files: OpenFile[]
  /** Empty key identifies the permanent conversation tab. */
  selected: string
}

export function openFileTab(state: FileTabs, file: OpenFile): FileTabs {
  if (file.entry.type !== 'file') return state
  return {
    files: state.files.some(existing => fileTabKey(existing) === fileTabKey(file))
      ? state.files : [...state.files, file],
    selected: fileTabKey(file),
  }
}

export function closeFileTab(state: FileTabs, path: string): FileTabs {
  const index = state.files.findIndex(file => fileTabKey(file) === path)
  if (index < 0) return state
  const files = state.files.filter(file => fileTabKey(file) !== path)
  const neighbour = files[Math.min(index, files.length - 1)]
  return { files, selected: state.selected === path
    ? (neighbour ? fileTabKey(neighbour) : '') : state.selected }
}

export function nextDocumentTab(paths: string[], current: string, key: string): string | undefined {
  const index = paths.indexOf(current)
  if (key === 'Home') return paths[0]
  if (key === 'End') return paths.at(-1)
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    return paths[(index + (key === 'ArrowRight' ? 1 : paths.length - 1)) % paths.length]
  }
}

export type DocumentTabDirection = -1 | 1
export type DocumentTabWheel = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'defaultPrevented'>

export function documentTabScrollLeft(event: DocumentTabWheel, viewport: {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}): number | undefined {
  if (event.ctrlKey || event.defaultPrevented) return
  const delta = event.deltaX || event.deltaY
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1
  const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
  const next = Math.min(max, Math.max(0, viewport.scrollLeft + delta * unit))
  if (Number.isFinite(next) && next !== viewport.scrollLeft) return next
}

export type DocumentTabKey = Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'isComposing' | 'keyCode' | 'defaultPrevented'>

export function documentTabDirection(event: DocumentTabKey): DocumentTabDirection | undefined {
  if (event.key !== 'Tab' || !event.ctrlKey || event.altKey || event.metaKey
    || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
  return event.shiftKey ? -1 : 1
}

export function isCloseDocumentKey(event: DocumentTabKey & { repeat?: boolean }): boolean {
  return event.key.toLowerCase() === 'w' && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
    && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented && !event.repeat
}

export interface DocumentShortcutContext {
  active: boolean
  keyboardActive: boolean
  visible: boolean
  explorerEnabled: boolean
  overlayOpen: boolean
  composing: boolean
}

function canHandleDocumentShortcut(context: DocumentShortcutContext): boolean {
  return context.active && context.keyboardActive && context.visible && context.explorerEnabled
    && !context.overlayOpen && !context.composing
}

export function selectedFileToClose(state: FileTabs, context: DocumentShortcutContext): string | undefined {
  if (canHandleDocumentShortcut(context) && state.selected && state.files.some(file => fileTabKey(file) === state.selected)) {
    return state.selected
  }
}

export function cycleDocumentTab(state: FileTabs, direction: DocumentTabDirection, context: DocumentShortcutContext): string | undefined {
  if (!canHandleDocumentShortcut(context) || state.files.length === 0) return
  return nextDocumentTab(['', ...state.files.map(fileTabKey)], state.selected,
    direction === 1 ? 'ArrowRight' : 'ArrowLeft')
}
