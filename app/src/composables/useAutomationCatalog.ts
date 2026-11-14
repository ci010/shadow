import { computed, onActivated, onDeactivated, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useCatalogResourceStore } from '../stores/catalog.ts'
import { requireResourcePinia } from '../stores/app.ts'
import { useLiveClientPool } from './useLiveClient.ts'

export function useAutomationCatalog(base: () => string, active: () => boolean) {
  const owner = useCatalogResourceStore(requireResourcePinia()).owner
  const pool = useLiveClientPool()
  const activated = ref(true)
  const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const enabled = computed(() => active() && activated.value && visible.value)
  const state = shallowRef<ReturnType<typeof owner.automations>['state']['value']>()
  const displayed = state
  let refresh = () => {}
  let identity = ''
  watch(() => [base(), enabled.value] as const, ([scope, enabled], _previous, onCleanup) => {
    if (identity !== scope) { identity = scope; state.value = undefined }
    refresh = () => {}
    if (!enabled) return
    const lease = owner.automations(scope, pool)
    state.value = lease.state.value
    const stop = watch(lease.state, next => { state.value = next })
    refresh = lease.refresh
    onCleanup(() => { stop(); lease.release() })
  }, { immediate: true })
  const updateVisibility = () => { visible.value = document.visibilityState !== 'hidden' }
  onMounted(() => { if (typeof document !== 'undefined') document.addEventListener('visibilitychange', updateVisibility) })
  onActivated(() => { activated.value = true })
  onDeactivated(() => { activated.value = false })
  onScopeDispose(() => {
    refresh = () => {}
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', updateVisibility)
  })
  return {
    enabled,
    jobs: computed(() => displayed.value?.value ?? []),
    loading: computed(() => state.value?.loading ?? enabled.value),
    loaded: computed(() => displayed.value?.value !== undefined),
    error: computed(() => state.value?.error ?? ''),
    // Existing consumers use this as a reconciliation hint, not a data commit version.
    // Initial catalog arrival must not cause a second initial run-history read.
    revision: computed(() => Math.max(0, (state.value?.readRevision ?? 0) - 1)),
    refresh: () => refresh(),
  }
}
