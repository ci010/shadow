import { shallowReactive, type InjectionKey } from 'vue'
import type { ProjectTab } from './file-workbench.ts'

/** Project document lifetime is independent of conversation resources (including drafts). */
export function createProjectDocuments() {
  const projects = shallowReactive(new Map<string, ProjectDocuments>())
  return {
    projects,
    get(projectId: string) {
      let state = projects.get(projectId)
      if (!state) {
        state = shallowReactive({ tabs: [] as ProjectTab[], target: undefined, active: false, selected: '' })
        projects.set(projectId, state)
      }
      return state
    },
  }
}
export interface ProjectDocuments {
  tabs: ProjectTab[]
  target?: HTMLElement
  active: boolean
  selected: string
}
export const ProjectDocumentsKey: InjectionKey<ReturnType<typeof createProjectDocuments>> = Symbol('ProjectDocuments')
