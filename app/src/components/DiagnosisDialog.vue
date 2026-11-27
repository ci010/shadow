<template>
  <dialog ref="dialog" class="diagnosis-dialog" :aria-labelledby="titleId" aria-modal="true"
    :style="mobile ? { '--diagnosis-viewport-height': `${mobile.viewportHeight.value}px` } : undefined"
    @cancel.prevent="emit('close')" @keydown.stop @pointerdown="trackBackdropPress"
    @click.self="closeFromBackdrop">
    <header class="diagnosis-dialog-heading">
      <h2 :id="titleId">{{ t('Session diagnosis') }}</h2>
      <HoverInfo :text="closeLabel" v-slot="{ triggerProps }">
        <button v-bind="triggerProps" type="button" class="diagnosis-close" :aria-label="closeLabel" autofocus @click="emit('close')">
          <span class="i-lucide-x" aria-hidden="true" />
        </button>
      </HoverInfo>
    </header>
    <slot />
  </dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useMobileChrome } from '../composables/useMobileChrome.ts'
import { t } from '../i18n.ts'
import HoverInfo from './HoverInfo.vue'

const props = defineProps<{ returnFocus?: HTMLElement }>()
const emit = defineEmits<{ close: [] }>()
const titleId = useId()
const dialog = ref<HTMLDialogElement>()
const mobile = useMobileChrome()
const closeLabel = computed(() => t('Close {label}', { label: t('Session diagnosis') }))
let backdropPressed = false
function trackBackdropPress(event: PointerEvent) { backdropPressed = event.target === dialog.value }
function closeFromBackdrop() {
  if (backdropPressed) emit('close')
}

onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => {
  const restore = dialog.value?.contains(document.activeElement)
  dialog.value?.close()
  const target = props.returnFocus
  if (restore && target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true })
})
</script>

<style scoped>
.diagnosis-dialog { box-sizing: border-box; width: min(1120px, calc(100% - 48px)); height: min(900px, calc(100dvh - 48px)); max-width: none; max-height: none; padding: 0; overflow: hidden; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 16px 48px var(--c-shadow); }
.diagnosis-dialog[open] { display: flex; flex-direction: column; }
.diagnosis-dialog::backdrop { background: rgb(0 0 0 / 36%); }
.diagnosis-dialog-heading { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--c-border); }
h2 { margin: 0; font-size: 15px; font-weight: 600; }
.diagnosis-close { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; background: transparent; color: var(--c-text-secondary); cursor: pointer; }
.diagnosis-close:hover { background: var(--c-bg-muted); color: var(--c-text); }
.diagnosis-close:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
@media (max-width: 700px), (pointer: coarse) { .diagnosis-close { width: 44px; height: 44px; } }
@media (max-width: 700px) {
  .diagnosis-dialog { inset: max(8px, var(--safe-area-inset-top, env(safe-area-inset-top, 0px))) max(8px, var(--safe-area-inset-right, env(safe-area-inset-right, 0px))) auto max(8px, var(--safe-area-inset-left, env(safe-area-inset-left, 0px))); margin: 0; width: auto; height: calc(var(--diagnosis-viewport-height, 100dvh) - max(8px, var(--safe-area-inset-top, env(safe-area-inset-top, 0px))) - max(8px, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))); }
}
</style>
