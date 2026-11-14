import { shallowReactive, type ComputedRef, type InjectionKey } from 'vue'
import type { ConversationResource } from './project-workspaces.ts'

/** Presentation targets only: never session ancestry or a second input controller. */
export function createSecondaryEditors() {
  const targets = shallowReactive(new Map<string, string>())
  return {
    targets,
    get(projectId: string, resources: readonly ConversationResource[]) {
      return resources.find(resource => resource.projectId === projectId && resource.key === targets.get(projectId))
    },
    move(resource: ConversationResource) { targets.set(resource.projectId, resource.key) },
    close(projectId: string) { targets.delete(projectId) },
  }
}
export interface ConversationEditor {
  enabled: ComputedRef<boolean>
  secondary: ComputedRef<boolean>
  move(): void
  restore(): void
}
export const ConversationEditorKey: InjectionKey<ConversationEditor> = Symbol('ConversationEditor')

/** Extension point for explicit attachments; callers must not send or infer context on focus. */
export interface ProjectSecondaryEditor {
  active: ComputedRef<{ projectId: string; sessionId: string; resourceKey: string } | undefined>
  focus(): void
}
export const ProjectSecondaryEditorKey: InjectionKey<ProjectSecondaryEditor> = Symbol('ProjectSecondaryEditor')
