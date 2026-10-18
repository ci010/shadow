import type { FileEntry } from './composables/useSessionFiles.ts'

export interface OpenFile {
  source?: { sessionWorkspace?: boolean; folderId?: string }
  path: string
  entry: FileEntry
  view?: 'diff'
}

export function fileTabKey(file: OpenFile): string {
  if (file.source) { const { source, ...rest } = file; return `\0source:${JSON.stringify(source)}:${fileTabKey(rest)}` }
  if (file.entry.archive) return `\0archive:${JSON.stringify([file.entry.archive.path, ...file.entry.archive.members])}`
  return file.view === 'diff' ? `\0diff:${file.path}` : file.path
}

export interface FileTabs {
  files: OpenFile[]
  knowledge?: KnowledgeTabRequest
  knowledgeEntries?: string[]
  projectTabs?: ProjectTab[]
  diagnosis?: boolean
  /** Empty key identifies the permanent conversation tab. */
  selected: string
}

export interface KnowledgeTabRequest {
  entryId?: string
}

export const KNOWLEDGE_TAB_KEY = '\0knowledge'
export const knowledgeEntryTabKey = (id: string) => `\0knowledge-entry:${id}`
export const knowledgeEntryId = (key: string) => key.startsWith('\0knowledge-entry:') ? key.slice('\0knowledge-entry:'.length) : undefined
export const DIAGNOSIS_TAB_KEY = '\0diagnosis'
export const isPermanentDocumentTab = (key: string) => !key || key === DIAGNOSIS_TAB_KEY
export type ProjectTab = 'settings' | 'agents'
export const projectTabKey = (tab: ProjectTab) => `\0project:${tab}`
export const projectTabFromKey = (key: string): ProjectTab | undefined =>
  key === projectTabKey('settings') ? 'settings' : key === projectTabKey('agents') ? 'agents' : undefined

export function withDiagnosisTab(state: FileTabs, enabled: boolean): FileTabs {
  if (enabled) return state.diagnosis ? state : { ...state, diagnosis: true }
  const { diagnosis, ...rest } = state
  return { ...rest, selected: state.selected === DIAGNOSIS_TAB_KEY ? '' : state.selected }
}

export function documentTabKeys(state: FileTabs): string[] {
  return ['', ...(state.diagnosis ? [DIAGNOSIS_TAB_KEY] : []), ...(state.knowledge ? [KNOWLEDGE_TAB_KEY] : []),
    ...(state.knowledgeEntries ?? []).map(knowledgeEntryTabKey),
    ...(state.projectTabs ?? []).map(projectTabKey), ...state.files.map(fileTabKey)]
}

export function openProjectTab(state: FileTabs, tab: ProjectTab): FileTabs {
  if (state.selected === projectTabKey(tab) && state.projectTabs?.includes(tab)) return state
  return { ...state, projectTabs: state.projectTabs?.includes(tab)
    ? state.projectTabs : [...(state.projectTabs ?? []), tab], selected: projectTabKey(tab) }
}

export function openKnowledgeTab(state: FileTabs, entryId?: string): FileTabs {
  if (!entryId) return { ...state, knowledge: {}, selected: KNOWLEDGE_TAB_KEY }
  return { ...state, knowledge: {}, knowledgeEntries: state.knowledgeEntries?.includes(entryId)
    ? state.knowledgeEntries : [...(state.knowledgeEntries ?? []), entryId], selected: knowledgeEntryTabKey(entryId) }
}

export function openFileTab(state: FileTabs, file: OpenFile): FileTabs {
  if (file.entry.type !== 'file') return state
  return {
    ...state,
    files: state.files.some(existing => fileTabKey(existing) === fileTabKey(file))
      ? state.files : [...state.files, file],
    selected: fileTabKey(file),
  }
}

export function closeFileTab(state: FileTabs, path: string): FileTabs {
  const projectTab = projectTabFromKey(path)
  if (projectTab && state.projectTabs?.includes(projectTab)) {
    const projectTabs = state.projectTabs.filter(tab => tab !== projectTab)
    return { ...state, projectTabs, selected: state.selected === path ? '' : state.selected }
  }
  if (path === KNOWLEDGE_TAB_KEY && state.knowledge) {
    const { knowledge, knowledgeEntries, ...remaining } = state
    return { ...remaining, selected: state.selected === path || !!knowledgeEntryId(state.selected) ? '' : state.selected }
  }
  const knowledgeId = knowledgeEntryId(path)
  if (knowledgeId && state.knowledgeEntries?.includes(knowledgeId)) {
    const knowledgeEntries = state.knowledgeEntries.filter(id => id !== knowledgeId)
    return { ...state, knowledgeEntries, selected: state.selected === path ? KNOWLEDGE_TAB_KEY : state.selected }
  }
  const index = state.files.findIndex(file => fileTabKey(file) === path)
  if (index < 0) return state
  const files = state.files.filter(file => fileTabKey(file) !== path)
  const neighbour = files[Math.min(index, files.length - 1)]
  return { ...state, files, selected: state.selected === path
    ? (neighbour ? fileTabKey(neighbour) : state.knowledge ? KNOWLEDGE_TAB_KEY : '') : state.selected }
}

export function closeAllFileTabs(state: FileTabs): FileTabs {
  if (!state.files.length && !state.knowledge && !state.knowledgeEntries?.length && !state.projectTabs?.length) return state
  const { knowledge, knowledgeEntries, projectTabs, ...rest } = state
  return { ...rest, files: [], selected: state.diagnosis && state.selected === DIAGNOSIS_TAB_KEY ? DIAGNOSIS_TAB_KEY : '' }
}

export function closeOtherFileTabs(state: FileTabs, keep: string): FileTabs {
  const projectTab = projectTabFromKey(keep)
  if (projectTab && state.projectTabs?.includes(projectTab)) {
    const { knowledge, knowledgeEntries, ...rest } = state
    return { ...rest, files: [], projectTabs: [projectTab], selected: keep }
  }
  if (keep === KNOWLEDGE_TAB_KEY && state.knowledge) {
    const { projectTabs, ...rest } = state
    return { ...rest, files: [], knowledgeEntries: [], selected: keep }
  }
  const knowledgeId = knowledgeEntryId(keep)
  if (knowledgeId && state.knowledgeEntries?.includes(knowledgeId)) {
    const { projectTabs, ...rest } = state
    return { ...rest, files: [], knowledgeEntries: [knowledgeId], selected: keep }
  }
  const file = state.files.find(file => fileTabKey(file) === keep)
  if (!file) return state
  const { knowledge, knowledgeEntries, projectTabs, ...rest } = state
  return { ...rest, files: [file], selected: keep }
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

function isDocumentCloseKey(event: DocumentTabKey & { repeat?: boolean }): boolean {
  return event.key.toLowerCase() === 'w' && event.ctrlKey && !event.altKey && !event.metaKey
    && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented && !event.repeat
}

export function isCloseDocumentKey(event: DocumentTabKey & { repeat?: boolean }): boolean {
  return !event.shiftKey && isDocumentCloseKey(event)
}

export function isCloseAllDocumentsKey(event: DocumentTabKey & { repeat?: boolean }): boolean {
  return event.shiftKey && isDocumentCloseKey(event)
}

export function isToggleExplorerKey(event: DocumentTabKey & { repeat?: boolean }): boolean {
  return event.key.toLowerCase() === 'e' && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
    && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented && !event.repeat
}

export function knowledgeHistoryDirection(event: DocumentTabKey & { repeat?: boolean }): DocumentTabDirection | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented
    || event.isComposing || event.keyCode === 229 || event.repeat) return
  if (event.key === 'ArrowLeft') return -1
  if (event.key === 'ArrowRight') return 1
}

export interface DocumentShortcutContext {
  active: boolean
  keyboardActive: boolean
  visible: boolean
  explorerEnabled: boolean
  overlayOpen: boolean
  composing: boolean
}

export function canHandleDocumentShortcut(context: DocumentShortcutContext): boolean {
  return context.active && context.keyboardActive && context.visible && context.explorerEnabled
    && !context.overlayOpen && !context.composing
}

export function canCloseAllDocuments(state: FileTabs, context: DocumentShortcutContext): boolean {
  return !!(state.files.length || state.knowledge || state.projectTabs?.length) && canHandleDocumentShortcut(context)
}

export function selectedFileToClose(state: FileTabs, context: DocumentShortcutContext): string | undefined {
  if (canHandleDocumentShortcut(context) && !isPermanentDocumentTab(state.selected) && documentTabKeys(state).includes(state.selected)) {
    return state.selected
  }
}

export function cycleDocumentTab(state: FileTabs, direction: DocumentTabDirection, context: DocumentShortcutContext): string | undefined {
  if (!canHandleDocumentShortcut(context) || documentTabKeys(state).length === 1) return
  return nextDocumentTab(documentTabKeys(state), state.selected,
    direction === 1 ? 'ArrowRight' : 'ArrowLeft')
}
