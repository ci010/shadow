<template>
  <Teleport to="body">
    <Transition name="mobile-drawer" :css="!!side">
    <div v-show="open || dragProgress !== undefined" class="mobile-sheet-backdrop" :class="{ 'is-drawer': side, 'is-dragging': dragProgress !== undefined }"
      :inert="!open" :aria-hidden="!open ? true : undefined"
      :style="{ '--mobile-available-height': mobile ? `${mobile.viewportHeight.value}px` : undefined, '--drawer-progress': dragProgress ?? (open ? 1 : 0) }" @pointerdown.self="close">
      <section ref="panel" class="mobile-sheet" role="dialog" aria-modal="true" :aria-label="label" tabindex="-1" @keydown="keydown">
        <header class="mobile-sheet-heading">
          <h2>{{ label }}</h2>
          <button type="button" :aria-label="`Close ${label}`" @click="close"><span class="i-lucide-x" aria-hidden="true" /></button>
        </header>
        <div class="mobile-sheet-content"><slot :close="close" /></div>
      </section>
    </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onDeactivated, onUnmounted, ref, watch } from 'vue'
import { useMobileChrome } from '../composables/useMobileChrome.ts'

const props = defineProps<{ open: boolean; label: string; side?: boolean; returnFocus?: HTMLElement; dragProgress?: number }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const panel = ref<HTMLElement>()
const mobile = useMobileChrome()
let returnTo: HTMLElement | undefined
function restore() {
  if (!returnTo) return
  const preferred = props.returnFocus ?? returnTo
  const target = preferred !== document.body && preferred.isConnected && preferred.getClientRects().length
    ? preferred
    : mobile?.headerTarget.value?.querySelector<HTMLElement>('.mobile-document-more') ?? mobile?.trigger.value
  target?.focus({ preventScroll: true })
  returnTo = undefined
}
function close() { emit('update:open', false) }
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab') return
  const targets = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])]
    .filter(element => element.getClientRects().length)
  const first = targets[0]
  const last = targets.at(-1)
  if (!first) { event.preventDefault(); panel.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault(); last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
watch(() => props.open, async open => {
  if (!open) { restore(); return }
  returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  await nextTick()
  if (props.open && !panel.value?.contains(document.activeElement)) {
    panel.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }
}, { immediate: true })
onDeactivated(close)
onUnmounted(restore)
defineExpose({ panel })
</script>

<style scoped>
.mobile-sheet-backdrop { position: fixed; inset: 0; bottom: auto; height: var(--mobile-available-height, 100dvh); z-index: 800; display: flex; align-items: flex-end; background: rgb(0 0 0 / 30%); }
.mobile-sheet { display: flex; flex-direction: column; width: 100%; max-height: calc(var(--mobile-available-height, 100dvh) - 64px); min-width: 0; box-sizing: border-box; padding-bottom: env(safe-area-inset-bottom, 0px); border-top: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 -8px 24px var(--c-shadow-soft); }
.mobile-sheet-heading { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; min-height: 56px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--c-border-soft); }
.mobile-sheet-heading h2 { margin: 0; font-size: 15px; font-weight: 600; }
.mobile-sheet-heading button { display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; background: transparent; color: var(--c-text-secondary); cursor: pointer; }
.mobile-sheet-heading button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.mobile-sheet-content { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px; }
.mobile-sheet-content :deep(button), .mobile-sheet-content :deep(input), .mobile-sheet-content :deep(select) { min-height: 44px; }
.mobile-sheet-content :deep(input), .mobile-sheet-content :deep(textarea), .mobile-sheet-content :deep(select) { font-size: 16px; }
.is-drawer { align-items: stretch; background: rgb(0 0 0 / calc(.3 * var(--drawer-progress))); transition: background-color .18s cubic-bezier(.22, 1, .36, 1); }
.is-drawer .mobile-sheet { width: min(340px, calc(100vw - 40px)); max-height: var(--mobile-available-height, 100dvh); padding-top: env(safe-area-inset-top, 0px); padding-left: env(safe-area-inset-left, 0px); border-top: 0; border-right: 1px solid var(--c-border); box-shadow: 8px 0 24px var(--c-shadow-soft); transform: translateX(calc((var(--drawer-progress) - 1) * 100%)); transition: transform .18s cubic-bezier(.22, 1, .36, 1); }
.is-drawer .mobile-sheet-content { flex: 1; padding: 0; }
.mobile-drawer-enter-from:not(.is-dragging), .mobile-drawer-leave-to { background: transparent; }
.mobile-drawer-enter-from:not(.is-dragging) .mobile-sheet, .mobile-drawer-leave-to .mobile-sheet { transform: translateX(-100%); }
.is-dragging, .is-dragging .mobile-sheet { transition: none; }
@media (prefers-reduced-motion: reduce) { .is-drawer, .is-drawer .mobile-sheet { transition: none; } }
</style>
