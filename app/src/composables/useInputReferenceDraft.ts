import { ref, watch, type Ref } from 'vue'
import { addInputReference, captureInputReferences, removeSentInputReferences, type LabeledInputReference } from '../workflow-input-references.ts'
import type { InputReference } from '../../../src/shared/input-references.ts'

/** Each ordinary composer owns its queue; switching chats cannot retarget references. */
export function useInputReferenceDraft(key: Readonly<Ref<string>>) {
  const items = ref<LabeledInputReference[]>([])
  const drafts = new Map<string, LabeledInputReference[]>()
  let current = key.value
  watch(key, next => {
    if (next === current) return
    drafts.set(current, items.value)
    current = next
    items.value = drafts.get(next) ?? []
  }, { flush: 'sync' })
  function append(item: LabeledInputReference) {
    const added = addInputReference(items.value, item)
    items.value = added.items
    return added.result
  }
  function migrate(next: string) {
    drafts.delete(current)
    current = next
    drafts.set(next, items.value)
  }
  function admitted(target: string, sent: readonly InputReference[]) {
    if (target === current) items.value = removeSentInputReferences(items.value, sent)
    else drafts.set(target, removeSentInputReferences(drafts.get(target) ?? [], sent))
  }
  return { items, append, migrate, admitted, capture: () => captureInputReferences(items.value) }
}
