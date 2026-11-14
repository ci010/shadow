import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { apiUrl } from '../api-url.ts'
import { workCompletionsSchema, type WorkCompletion } from '../../../src/initiatives/work-contract.ts'
import { useCatalogResourceStore } from '../stores/catalog.ts'
import { useCatalogVisibility } from '../resources/catalog-visibility.ts'
import { requireResourcePinia } from '../stores/app.ts'

/** Read ownership is shared; acknowledgement remains an explicit, never-replayed command. */
export function useWorkCompletions(context: () => { base: string; projectId: string; active: boolean }, revision: Ref<unknown>) {
  const owner = useCatalogResourceStore(requireResourcePinia()).owner
  const enabled = useCatalogVisibility(() => context().active)
  const current = shallowRef<ReturnType<typeof owner.completions>>()
  const busy = ref(false), commandError = ref(false)
  let command: AbortController | undefined
  watch(() => [context().base, context().projectId, enabled.value] as const, ([base, projectId, active], _, cleanup) => {
    command?.abort(); busy.value = false; commandError.value = false; current.value = undefined
    if (!active) return
    const lease = owner.completions(base, projectId); current.value = lease
    cleanup(lease.release)
  }, { immediate: true })
  watch(revision, () => { current.value?.invalidate() })
  onScopeDispose(() => command?.abort())
  const items = computed(() => current.value?.state.value.value ?? [])
  const error = computed(() => commandError.value || !!current.value?.state.value.error)
  async function markRead(entries: WorkCompletion[]) {
    if (!enabled.value || busy.value || !current.value) return
    const lease = current.value, controller = new AbortController(); command = controller; busy.value = true
    try {
      const response = await fetch(apiUrl(context().base, '/api/work/completions'), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: entries.map(({ key, completionId }) => ({ key, completionId })) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      if (!response.ok) throw new Error('Completion state unavailable')
      workCompletionsSchema.parse(await response.json())
      if (!controller.signal.aborted && current.value === lease) { commandError.value = false; await lease.refresh() }
    } catch { if (!controller.signal.aborted && current.value === lease) commandError.value = true }
    finally { if (command === controller) busy.value = false }
  }
  return { items, unread: computed(() => items.value.filter(item => item.unread)), error, busy,
    refresh: () => current.value?.refresh(), markRead }
}
