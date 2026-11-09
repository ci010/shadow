import { computed, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue'
import { apiUrl } from '../api-url.ts'
import { workCompletionsSchema, type WorkCompletion } from '../../../src/initiatives/work-contract.ts'

/** Human presentation state is deliberately not stored in the shared live Work resource. */
export function useWorkCompletions(context: () => { base: string; projectId: string; active: boolean }, revision: Ref<unknown>) {
  const items = shallowRef<WorkCompletion[]>([]), error = ref(false), busy = ref(false)
  let generation = 0, request = 0
  const controllers = new Set<AbortController>()
  async function load(read?: { key: string; completionId: string }[]) {
    const current = context()
    if (!current.active || busy.value) return
    const epoch = generation, serial = ++request, controller = new AbortController()
    controllers.add(controller)
    if (read) busy.value = true
    try {
      const response = await fetch(apiUrl(current.base, '/api/work/completions'), {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        ...(read ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: read }) } : {}),
      })
      if (!response.ok) throw new Error('Completion state unavailable')
      const result = workCompletionsSchema.parse(await response.json())
      if (epoch === generation && serial === request) { items.value = result.items; error.value = false }
    } catch { if (epoch === generation && serial === request && !controller.signal.aborted) error.value = true }
    finally { controllers.delete(controller); if (epoch === generation && read) busy.value = false }
  }
  function reset() { generation++; for (const controller of controllers) controller.abort(); controllers.clear(); busy.value = false }
  watch(() => [context().base, context().projectId, context().active] as const, (current, previous) => {
    reset()
    if (current[0] !== previous?.[0] || current[1] !== previous?.[1]) { items.value = []; error.value = false }
    if (current[2]) void load()
  }, { immediate: true })
  watch(revision, () => { void load() })
  onUnmounted(reset)
  const unread = computed(() => items.value.filter(item => item.unread))
  return { items, unread, error, busy, refresh: () => load(),
    markRead: (entries: WorkCompletion[]) => load(entries.map(({ key, completionId }) => ({ key, completionId }))) }
}
