import type { InjectionKey, ShallowRef } from 'vue'
import type { EditorDescriptor, EditorGroups } from './editor-groups.ts'

export interface ProjectTopTabs {
  groups(): ProjectTopTabGroup[]
  active(id: string): boolean
  activate(id: string): void
  close(id: string): void
}

export interface ProjectTopTabGroup {
  id: string
  name: string
  tabs: EditorDescriptor[]
}

export const ProjectTopTabsKey: InjectionKey<ShallowRef<ProjectTopTabs | undefined>> = Symbol('ProjectTopTabs')

export function projectTopTabGroups(
  editors: EditorGroups,
  projects: readonly { id: string; name: string }[],
  isTopTab: (editor: EditorDescriptor) => boolean,
): ProjectTopTabGroup[] {
  return [...editors.projects].flatMap(([id, state]) => {
    const project = projects.find(item => item.id === id)
    if (!project) return []
    const tabs = [...state.left, ...state.right].flatMap(tabId => {
      const editor = editors.descriptors.get(tabId)
      return editor?.projectId === id && isTopTab(editor) ? [editor] : []
    })
    return tabs.length ? [{ id, name: project.name, tabs }] : []
  })
}
