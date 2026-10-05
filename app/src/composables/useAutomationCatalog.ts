import { computed, getCurrentInstance, inject, onActivated, onDeactivated, onMounted, onScopeDispose, ref, shallowRef, watch, type InjectionKey } from 'vue'
import { createAutomationCatalog } from '../automation-catalog.ts'
import { useLiveClientPool } from './useLiveClient.ts'

const catalogKey: InjectionKey<ReturnType<typeof createAutomationCatalog>> = Symbol.for('shadow.automation-catalog')

export function useAutomationCatalog(base: () => string, active: () => boolean) {
  const instance = getCurrentInstance()
  if (!instance) throw new Error('Automations require a Vue application context.')
  let catalog = inject(catalogKey, undefined)
  if (!catalog) {
    catalog = createAutomationCatalog(useLiveClientPool())
    instance.appContext.provides[catalogKey] = catalog
    const owned = catalog
    instance.appContext.app.onUnmount(() => owned.dispose())
  }
  const activated = ref(true)
  const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const enabled = computed(() => active() && activated.value && visible.value)
  const state = shallowRef<ReturnType<typeof catalog.acquire>['state']>()
  const retained = shallowRef<ReturnType<typeof catalog.acquire>['state']>()
  const displayed = computed(() => state.value?.loaded ? state.value : retained.value ?? state.value)
  let refresh = () => {}
  let identity = ''
  watch(() => [base(), enabled.value] as const, ([scope, enabled], _previous, onCleanup) => {
    if (identity !== scope) { identity = scope; state.value = undefined; retained.value = undefined }
    refresh = () => {}
    if (!enabled) return
    const lease = catalog.acquire(scope)
    if (state.value?.loaded) retained.value = state.value
    state.value = lease.state
    refresh = lease.refresh
    onCleanup(lease.release)
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
    jobs: computed(() => displayed.value?.jobs ?? []),
    loading: computed(() => state.value?.loading ?? enabled.value),
    loaded: computed(() => displayed.value?.loaded ?? false),
    error: computed(() => state.value?.error ?? ''),
    revision: computed(() => state.value?.revision ?? 0),
    refresh: () => refresh(),
  }
}
