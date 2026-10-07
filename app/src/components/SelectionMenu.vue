<template>
  <Teleport to="body">
    <div v-if="selection" ref="menu" class="selection-menu" role="menu" :aria-label="t('Text selection')" :style="position" @pointerdown.prevent>
      <button role="menuitem" aria-keyshortcuts="Q" :disabled="!canQuote" :title="canQuote ? t('Insert quote into the message') : t('Quoting needs an editable conversation')" @click="quote">
        <span class="i-lucide-quote" aria-hidden="true" /><span>{{ t('Quote') }}</span><kbd>q</kbd>
      </button>
      <button role="menuitem" aria-keyshortcuts="C" :disabled="copying" @click="copy">
        <span class="i-lucide-copy" aria-hidden="true" /><span>{{ t('Copy') }}</span><kbd>c</kbd>
      </button>
      <p v-if="error" class="selection-menu-error" role="alert">{{ error }}</p>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { selectionAction } from '../selection-actions.ts'

const props = defineProps<{ container?: HTMLElement | null; active: boolean; canQuote: boolean }>()
const emit = defineEmits<{ quote: [text: string, range: Range] }>()
const menu = ref<HTMLElement>()
const selection = ref<{ text: string; range: Range; rect: DOMRect; origin: Element | null }>()
const position = ref({ left: '0px', top: '0px' })
const copying = ref(false)
const error = ref('')
let dragging = false
const editable = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

function positionMenu(): void {
  if (!menu.value || !selection.value) return
  const { rect } = selection.value
  const { width, height } = menu.value.getBoundingClientRect()
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    top: `${Math.max(8, Math.min(rect.top >= height + 16 ? rect.top - height - 8 : rect.bottom + 8, window.innerHeight - height - 8))}px`,
  }
}
function dismiss(): void {
  selection.value = undefined
  error.value = ''
}
function finish(): void {
  const origin = selection.value?.origin
  const focusedMenu = menu.value?.contains(document.activeElement)
  dismiss()
  window.getSelection()?.removeAllRanges()
  if (focusedMenu && origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true })
}
function quote(): void {
  if (!selection.value || !props.canQuote) return
  const { text, range } = selection.value
  finish()
  emit('quote', text, range)
}
async function copy(): Promise<void> {
  if (!selection.value || copying.value) return
  const current = selection.value
  copying.value = true
  error.value = ''
  try {
    await navigator.clipboard.writeText(current.text)
    if (selection.value === current) finish()
  } catch (cause) {
    if (selection.value === current) error.value = cause instanceof Error ? cause.message : t('Could not copy text. Try again.')
  } finally { copying.value = false }
}
function capture(): void {
  if (dragging || !props.active || menu.value?.contains(document.activeElement)) return
  if (document.activeElement?.closest(editable)) { dismiss(); return }
  const native = window.getSelection()
  const root = props.container
  if (!root || !native || native.isCollapsed || !native.rangeCount || !root.contains(native.anchorNode) || !root.contains(native.focusNode)) { dismiss(); return }
  const text = native.toString()
  if (!text.trim()) { dismiss(); return }
  const range = native.getRangeAt(0).cloneRange()
  const rect = range.getBoundingClientRect()
  if (rect.bottom <= 0 || rect.top >= window.innerHeight) { dismiss(); return }
  selection.value = { text, range, rect, origin: document.activeElement }
  error.value = ''
  void nextTick(positionMenu)
}
function pointerDown(event: PointerEvent): void {
  if (event.target instanceof Node && menu.value?.contains(event.target)) return
  dragging = true
  dismiss()
}
function pointerUp(): void { dragging = false; capture() }
function cancelPointer(): void { dragging = false; dismiss() }
function keydown(event: KeyboardEvent): void {
  if (!selection.value || !props.active || event.defaultPrevented || event.isComposing || document.activeElement?.closest(editable)) return
  const action = selectionAction(event)
  if (action) {
    event.preventDefault()
    event.stopPropagation()
    if (action === 'quote') quote()
    else void copy()
    return
  }
  if (event.key === 'Escape') { event.preventDefault(); finish(); return }
  if (event.key === 'Tab') { dismiss(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
  const buttons = Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (!buttons.length) return
  event.preventDefault()
  const index = buttons.findIndex(button => button === document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
  buttons[next]?.focus({ preventScroll: true })
}
watch(() => [props.active, props.container], dismiss)
watch(error, () => { void nextTick(positionMenu) })
defineExpose({ dismiss })
onMounted(() => {
  document.addEventListener('pointerdown', pointerDown, true)
  document.addEventListener('pointerup', pointerUp)
  document.addEventListener('pointercancel', cancelPointer)
  document.addEventListener('selectionchange', capture)
  document.addEventListener('keydown', keydown, true)
  window.addEventListener('scroll', dismiss, true)
  window.addEventListener('resize', dismiss)
  window.addEventListener('blur', cancelPointer)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', pointerDown, true)
  document.removeEventListener('pointerup', pointerUp)
  document.removeEventListener('pointercancel', cancelPointer)
  document.removeEventListener('selectionchange', capture)
  document.removeEventListener('keydown', keydown, true)
  window.removeEventListener('scroll', dismiss, true)
  window.removeEventListener('resize', dismiss)
  window.removeEventListener('blur', cancelPointer)
})
</script>

<style scoped>
.selection-menu { position: fixed; z-index: 1000; box-sizing: border-box; width: 208px; max-width: calc(100vw - 16px); padding: 4px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 8px 24px var(--c-shadow); }
.selection-menu button { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 6px 10px; border: 0; border-radius: var(--radius-control); background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.selection-menu button > span:first-child { display: block; flex: 0 0 16px; width: 16px; height: 16px; }
.selection-menu button:hover:not(:disabled) { background: var(--c-bg-muted); }
.selection-menu button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.selection-menu button:disabled { color: var(--c-text-muted); cursor: not-allowed; }
.selection-menu kbd { margin-left: auto; color: var(--c-text-secondary); font: inherit; }
.selection-menu-error { margin: 4px 8px; color: var(--c-error); font-size: 12px; overflow-wrap: anywhere; }
</style>
