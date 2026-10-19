<template>
  <button ref="trigger" class="mobile-menu-trigger" type="button" :aria-label="t('Open navigation')" aria-controls="mobile-navigation" :aria-expanded="menuOpen" @click="menuOpen = true">
    <span class="i-lucide-menu w-5 h-5" aria-hidden="true" />
  </button>
  <span v-if="!headerOwner" class="mobile-page-title">{{ title }}</span>
  <div ref="headerTarget" class="mobile-header-content" />
  <MobileSheet v-model:open="menuOpen" :label="t('Navigation')" side :return-focus="trigger" :drag-progress="dragProgress">
    <div id="mobile-navigation" class="mobile-navigation-content">
      <div ref="projectsTarget" class="mobile-project-navigation" />
      <div class="mobile-preferences">
        <button class="mobile-preferences-toggle" type="button" :aria-expanded="preferencesOpen" aria-controls="mobile-preferences-panel" @click="preferencesOpen = !preferencesOpen">
          <span class="i-lucide-sliders-horizontal" aria-hidden="true" />
          <span>{{ t('Settings') }}</span>
          <span :class="preferencesOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" class="mobile-preferences-chevron" aria-hidden="true" />
        </button>
        <div v-show="preferencesOpen" id="mobile-preferences-panel" class="mobile-preferences-panel">
          <div ref="navigationTarget" class="mobile-global-navigation" />
          <div ref="actionsTarget" class="mobile-global-actions" />
          <div class="mobile-language"><LanguageSelector /></div>
        </div>
      </div>
    </div>
  </MobileSheet>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import MobileSheet from './MobileSheet.vue'
import LanguageSelector from './LanguageSelector.vue'
import { useMobileChrome } from '../composables/useMobileChrome.ts'
import { canStartDrawerSwipe, completesSwipe, drawerSwipeProgress, swipeIntent, type EdgeSwipe } from '../mobile-swipe.ts'

defineProps<{ title: string }>()
const chrome = useMobileChrome()!
const { menuOpen, trigger, headerTarget, navigationTarget, projectsTarget, actionsTarget, headerOwner } = chrome
let swipe: EdgeSwipe | undefined
const dragProgress = ref<number>()
const preferencesOpen = ref(false)
function start(event: TouchEvent) {
  cancel()
  if (event.touches.length !== 1 || !(event.target instanceof Element)) return
  if (event.target.closest('.mobile-global-navigation, input, textarea, select, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"]')) return
  const point = event.touches[0]!
  const drawer = event.target.closest('.mobile-navigation-content, .is-drawer .mobile-sheet')
  if (menuOpen.value ? !drawer : !canStartDrawerSwipe(point.clientX, window.innerWidth) || !!event.target.closest('[role="dialog"], [role="menu"]')) return
  swipe = { x: point.clientX, y: point.clientY, open: menuOpen.value }
}
function move(event: TouchEvent) {
  if (!swipe) return
  if (event.touches.length !== 1) { cancel(); return }
  const point = event.touches[0]!
  const intent = dragProgress.value === undefined ? swipeIntent(swipe, point.clientX, point.clientY) : 'horizontal'
  if (intent === 'cancel') cancel()
  else if (intent === 'horizontal') {
    if (!event.cancelable) { cancel(); return }
    event.preventDefault()
    dragProgress.value = drawerSwipeProgress(swipe, point.clientX, Math.min(340, window.innerWidth - 40))
  }
}
function end(event: TouchEvent) {
  const point = event.changedTouches[0]
  if (swipe && point && completesSwipe(swipe, point.clientX, point.clientY)) menuOpen.value = !swipe.open
  cancel()
}
function cancel() { swipe = undefined; dragProgress.value = undefined }
watch(menuOpen, open => {
  cancel()
  if (!open) preferencesOpen.value = false
})
onMounted(() => {
  document.addEventListener('touchstart', start, { passive: true })
  document.addEventListener('touchmove', move, { passive: false })
  document.addEventListener('touchend', end, { passive: true })
  document.addEventListener('touchcancel', cancel, { passive: true })
  window.addEventListener('resize', cancel)
})
onUnmounted(() => {
  menuOpen.value = false
  document.removeEventListener('touchstart', start)
  document.removeEventListener('touchmove', move)
  document.removeEventListener('touchend', end)
  document.removeEventListener('touchcancel', cancel)
  window.removeEventListener('resize', cancel)
})
</script>

<style scoped>
.mobile-menu-trigger { display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; padding: 0; border: 0; background: transparent; color: var(--c-text); }
.mobile-menu-trigger:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.mobile-page-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600; }
.mobile-header-content { display: flex; flex: 1; min-width: 0; align-items: center; }
.mobile-header-content:empty { display: none; }
.mobile-navigation-content { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.mobile-global-navigation { flex-shrink: 0; min-width: 0; padding: 8px; border-bottom: 1px solid var(--c-border); }
/* Global destinations are secondary to the project list on phones. */
.mobile-global-navigation :deep(.tab-nav.mobile-app-nav) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
.mobile-global-navigation :deep(.mobile-app-nav .tab) { min-height: 44px; padding: 8px 12px; white-space: normal; text-align: left; }
.mobile-project-navigation { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; }
.mobile-preferences { flex-shrink: 0; border-top: 1px solid var(--c-border); }
.mobile-preferences-toggle { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 48px; padding: 10px 16px; border: 0; background: transparent; color: var(--c-text-secondary); font: inherit; cursor: pointer; }
.mobile-preferences-toggle:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.mobile-preferences-chevron { margin-left: auto; }
.mobile-preferences-panel { max-height: min(40dvh, 280px); overflow-y: auto; overscroll-behavior-y: contain; padding: 0 12px 12px; }
.mobile-global-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.mobile-global-actions :deep(button) { justify-content: flex-start; min-width: 0; white-space: normal; text-align: left; }
.mobile-language { padding-top: 12px; }
.mobile-language :deep(select) { max-width: 100%; }

</style>
