import { computed, onActivated, onDeactivated, onMounted, onScopeDispose, ref } from 'vue'

/** A mounted KeepAlive panel is not necessarily an active reader. */
export function useCatalogVisibility(active: () => boolean) {
  const activated = ref(true)
  const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const update = () => { visible.value = document.visibilityState !== 'hidden' }
  onMounted(() => { if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update) })
  onActivated(() => { activated.value = true })
  onDeactivated(() => { activated.value = false })
  onScopeDispose(() => { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update) })
  return computed(() => active() && visible.value && activated.value)
}
