import { shallowRef } from 'vue'
import type { EditorGroups, EditorSide } from './editor-groups.ts'

export const EDITOR_TAB_DRAG_TYPE = 'application/x-shadow-editor-tab'
/** Renderer-local lease, not a serialized descriptor or navigation instruction. */
export function createEditorTabDrag(groups: EditorGroups, project: () => string) {
  const active = shallowRef<{ token: string; id: string; projectId: string; source: EditorSide; descriptor: object }>()
  const over = shallowRef<EditorSide>()
  function clear() { active.value = undefined; over.value = undefined }
  function valid(side: EditorSide) {
    const lease = active.value
    return !!lease && lease.projectId === project() && lease.source !== side &&
      groups.descriptors.get(lease.id) === lease.descriptor && groups.side(lease.id) === lease.source &&
      groups.descriptors.get(lease.id)?.projectId === project()
  }
  function start(event: DragEvent, id: string) {
    clear()
    const descriptor = groups.descriptors.get(id), source = groups.side(id)
    if (!event.dataTransfer || !descriptor || !source || descriptor.projectId !== project()) { event.preventDefault(); return }
    const token = crypto.randomUUID()
    active.value = { token, id, projectId: project(), source, descriptor }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(EDITOR_TAB_DRAG_TYPE, token)
  }
  function enter(event: DragEvent, side: EditorSide) {
    if (!event.dataTransfer?.types.includes(EDITOR_TAB_DRAG_TYPE) || !valid(side)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    over.value = side
  }
  function drop(event: DragEvent, side: EditorSide) {
    const lease = active.value
    const accepted = valid(side) && !!lease && event.dataTransfer?.getData(EDITOR_TAB_DRAG_TYPE) === lease.token
    clear()
    if (!accepted || !lease) return false
    event.preventDefault()
    groups.move(lease.id, side)
    return true
  }
  return { active, over, clear, start, enter, drop }
}
