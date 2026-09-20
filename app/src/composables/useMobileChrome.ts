import { computed, inject, onActivated, onDeactivated, onMounted, onUnmounted, provide, ref, shallowRef, watch, type InjectionKey } from 'vue'

export function provideMobileChrome() {
  const query = window.matchMedia('(max-width: 700px)')
  const enabled = ref(query.matches && !window.shadowDesktop?.windowControls)
  const menuOpen = ref(false)
  const headerTarget = shallowRef<HTMLElement>()
  const navigationTarget = shallowRef<HTMLElement>()
  const projectsTarget = shallowRef<HTMLElement>()
  const actionsTarget = shallowRef<HTMLElement>()
  const trigger = shallowRef<HTMLButtonElement>()
  const headerOwner = shallowRef<symbol>()
  const viewportHeight = ref(window.visualViewport?.height ?? window.innerHeight)
  const measureViewport = () => { viewportHeight.value = window.visualViewport?.height ?? window.innerHeight }
  const update = () => {
    enabled.value = query.matches && !window.shadowDesktop?.windowControls
    menuOpen.value = false
  }
  onMounted(() => {
    query.addEventListener('change', update)
    window.addEventListener('resize', measureViewport)
    window.visualViewport?.addEventListener('resize', measureViewport)
  })
  onUnmounted(() => {
    query.removeEventListener('change', update)
    window.removeEventListener('resize', measureViewport)
    window.visualViewport?.removeEventListener('resize', measureViewport)
  })
  const chrome = { enabled, menuOpen, headerTarget, navigationTarget, projectsTarget, actionsTarget, trigger, headerOwner, viewportHeight }
  provide(MobileChromeKey, chrome)
  return chrome
}

type MobileChrome = ReturnType<typeof provideMobileChrome>
const MobileChromeKey: InjectionKey<MobileChrome> = Symbol('mobile-chrome')

export function useMobileChrome() { return inject(MobileChromeKey, undefined) }

export function useMobileHeader(active: () => boolean) {
  const chrome = useMobileChrome()
  const owner = Symbol('mobile-header')
  const mounted = ref(true)
  const enabled = computed(() => !!chrome?.enabled.value && mounted.value && active())
  function release() { if (chrome?.headerOwner.value === owner) chrome.headerOwner.value = undefined }
  watch(enabled, value => {
    if (value && chrome) chrome.headerOwner.value = owner
    else release()
  }, { immediate: true, flush: 'post' })
  onActivated(() => { mounted.value = true })
  onDeactivated(() => { mounted.value = false; release() })
  onUnmounted(release)
  return { chrome, visible: computed(() => enabled.value && chrome?.headerOwner.value === owner) }
}
