import type { ComputedRef, InjectionKey } from 'vue'
import type { EditorDescriptor } from './editor-groups.ts'

export const modelOutlineTarget = (projectId: string) => JSON.stringify(['model-outline', projectId])
export const OutlineEditorKey: InjectionKey<ComputedRef<EditorDescriptor>> = Symbol('outline-editor')
