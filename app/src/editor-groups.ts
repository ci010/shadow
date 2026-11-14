import { reactive, shallowReactive, type InjectionKey } from 'vue'

export type EditorSide = 'left' | 'right'
export interface EditorDescriptor {
  id: string
  projectId: string
  owner: string
  label: string
  icon: string
  closable: boolean
  select(): void
  close(): void
  commands?: { toggleExplorer?: () => void }
  conversation?: { sessionId: string; editable: boolean; folderId?: string }
}
/** Resource identity/lifetime is deliberately independent of group placement. */
export function createEditorGroups() {
  const explorers = reactive(new Set<string>())
  const toggleExplorer = (projectId: string) => { if (explorers.has(projectId)) explorers.delete(projectId); else explorers.add(projectId) }
  const descriptors = shallowReactive(new Map<string, EditorDescriptor>())
  const projects = reactive(new Map<string, { left: string[]; right: string[]; selected: Record<EditorSide, string>; active: EditorSide; conversation?: string }>())
  // Multiple source workbenches may reference the same Project resource. Only
  // the first live lease renders it; moving never constructs a second view.
  const views = shallowReactive(new Map<string, symbol[]>())
  const targets = shallowReactive(new Map<string, HTMLElement>())
  function state(projectId: string) {
    if (!projects.has(projectId)) projects.set(projectId, { left: [], right: [], selected: { left: '', right: '' }, active: 'left' })
    return projects.get(projectId)!
  }
  function side(id: string): EditorSide | undefined {
    const descriptor = descriptors.get(id)
    if (!descriptor) return
    const project = state(descriptor.projectId)
    return project.left.includes(id) ? 'left' : project.right.includes(id) ? 'right' : undefined
  }
  function focus(projectId: string, placement: EditorSide) {
    const project = state(projectId)
    project.active = placement
    const id = project.selected[placement], descriptor = descriptors.get(id)
    if (descriptor?.conversation?.editable) project.conversation = id
  }
  function activate(id: string) {
    const descriptor = descriptors.get(id), placement = side(id)
    if (!descriptor || !placement) return
    const project = state(descriptor.projectId)
    project.selected[placement] = id
    focus(descriptor.projectId, placement)
    descriptor.select()
  }
  function open(descriptor: EditorDescriptor, placement: EditorSide = 'left', focus = true) {
    descriptors.set(descriptor.id, descriptor)
    const project = state(descriptor.projectId)
    if (!side(descriptor.id)) project[placement].push(descriptor.id)
    if (focus) activate(descriptor.id)
    else if (!project.selected[placement]) project.selected[placement] = descriptor.id
  }
  function remove(id: string) {
    const descriptor = descriptors.get(id), placement = side(id)
    if (!descriptor || !placement) return
    const project = state(descriptor.projectId), list = project[placement], index = list.indexOf(id)
    list.splice(index, 1)
    if (project.selected[placement] === id) project.selected[placement] = list[Math.min(index, list.length - 1)] ?? ''
    if (!list.length && project.active === placement) project.active = placement === 'left' ? 'right' : 'left'
  }
  function move(id: string, placement: EditorSide) {
    const descriptor = descriptors.get(id)
    if (!descriptor) return
    remove(id)
    state(descriptor.projectId)[placement].push(id)
    activate(id)
  }
  function close(id: string) {
    const descriptor = descriptors.get(id)
    if (!descriptor?.closable) return
    remove(id)
    descriptor.close()
  }
  function visible(id: string) {
    const descriptor = descriptors.get(id), placement = side(id)
    return !!descriptor && !!placement && state(descriptor.projectId).selected[placement] === id
  }
  function focused(id: string) {
    const descriptor = descriptors.get(id), placement = side(id)
    return visible(id) && !!descriptor && state(descriptor.projectId).active === placement
  }
  return { descriptors, projects, targets, views, explorers, toggleExplorer,
    registerView(id: string, token: symbol) { views.set(id, [...(views.get(id) ?? []), token]) },
    unregisterView(id: string, token: symbol) {
      const remaining = (views.get(id) ?? []).filter(item => item !== token)
      if (remaining.length) views.set(id, remaining)
      else { views.delete(id); remove(id); descriptors.delete(id) }
    },
    state, side, open, focus, activate, move, close, visible, focused,
    unregister(id: string) { remove(id); descriptors.delete(id) },
    active(projectId: string) { const project = state(projectId); return descriptors.get(project.selected[project.active]) },
    referenceTarget(projectId: string) {
      const id = state(projectId).conversation
      const descriptor = id && side(id) ? descriptors.get(id) : undefined
      return descriptor?.conversation?.editable ? descriptor : undefined
    },
  }
}
export type EditorGroups = ReturnType<typeof createEditorGroups>
export const EditorGroupsKey: InjectionKey<EditorGroups> = Symbol('EditorGroups')
export const EditorOwnerKey: InjectionKey<string> = Symbol('EditorOwner')
