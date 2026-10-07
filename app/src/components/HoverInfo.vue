<template>
  <span ref="anchor" class="hover-info-anchor" v-bind="$attrs" @pointerenter="pointerEnter" @pointerleave="scheduleClose"
    @focusin="focusIn" @focusout="focusOut" @keydown="anchorKey" @click="anchorClick">
    <slot :trigger-props="triggerProps" :open="show" :close="close" />
  </span>
  <Teleport to="body">
    <div v-if="opened" :id="id" ref="popup" class="hover-info-popup" :class="{ interactive }"
      :role="interactive ? 'dialog' : 'tooltip'" :aria-label="interactive ? (label || text || t('More information')) : undefined"
      :style="position" :tabindex="interactive ? -1 : undefined"
      @pointerenter="cancelClose" @pointerleave="scheduleClose" @focusin="cancelClose" @focusout="focusOut" @keydown="popupKey">
      <slot name="content" :close="close"><p class="hover-info-text">{{ text }}</p></slot>
    </div>
  </Teleport>
</template>

<script lang="ts">
let dismissCurrent: (() => void) | undefined
</script>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, nextTick, onDeactivated, onUnmounted, ref, useId, watch } from 'vue'
import { hoverInfoPosition } from '../hover-info.ts'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ text?: string; label?: string; interactive?: boolean; disabled?: boolean }>(), {
  text: '', label: '', interactive: false, disabled: false,
})
const id = `hover-info-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const anchor = ref<HTMLElement>()
const popup = ref<HTMLElement>()
const opened = ref(false)
const position = ref<{ left: string; top: string; visibility: 'hidden' | 'visible' }>({ left: '0px', top: '0px', visibility: 'hidden' })
const triggerProps = computed(() => props.disabled ? {} : {
  'data-hover-info-trigger': id,
  'aria-describedby': opened.value && !props.interactive ? id : undefined,
  'aria-haspopup': props.interactive ? 'dialog' as const : undefined,
  'aria-expanded': props.interactive ? opened.value : undefined,
  'aria-controls': props.interactive && opened.value ? id : undefined,
})
let openTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined
let observer: ResizeObserver | undefined
let suppressFocus = false
const focusable = 'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'
const trigger = () => anchor.value?.querySelector<HTMLElement>(`[data-hover-info-trigger="${id}"]`)
  ?? anchor.value?.querySelector<HTMLElement>(focusable) ?? anchor.value?.firstElementChild as HTMLElement | undefined
function contains(target: EventTarget | null) {
  return target instanceof Node && (!!anchor.value?.contains(target) || !!popup.value?.contains(target))
}
function cancelClose() { clearTimeout(closeTimer); closeTimer = undefined }
function clearTimers() { clearTimeout(openTimer); openTimer = undefined; cancelClose() }
function measure() {
  const source = trigger()
  const card = popup.value
  if (!source?.getClientRects().length || !card) { close(); return }
  const point = hoverInfoPosition(source.getBoundingClientRect(), card.getBoundingClientRect(), {
    width: document.documentElement.clientWidth, height: window.innerHeight,
  })
  position.value = { left: `${point.left}px`, top: `${point.top}px`, visibility: 'visible' }
}
async function show() {
  if (props.disabled) return
  clearTimers()
  if (opened.value) return
  dismissCurrent?.()
  dismissCurrent = close
  opened.value = true
  position.value.visibility = 'hidden'
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', documentKey, true)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', dismiss)
  window.addEventListener('blur', dismiss)
  await nextTick()
  if (!opened.value) return
  measure()
  observer = new ResizeObserver(measure)
  if (popup.value) observer.observe(popup.value)
}
function close(restoreFocus = false) {
  clearTimers()
  opened.value = false
  observer?.disconnect()
  observer = undefined
  if (dismissCurrent === close) dismissCurrent = undefined
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('keydown', documentKey, true)
  document.removeEventListener('scroll', scroll, true)
  window.removeEventListener('resize', dismiss)
  window.removeEventListener('blur', dismiss)
  if (restoreFocus) {
    suppressFocus = true
    trigger()?.focus({ preventScroll: true })
    void nextTick(() => { suppressFocus = false })
  }
}
function dismiss() { close(!!popup.value?.contains(document.activeElement)) }
function outside(event: PointerEvent) { if (!contains(event.target)) close() }
function scroll(event: Event) { if (!(event.target instanceof Node && popup.value?.contains(event.target))) dismiss() }
function documentKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !opened.value) return
  const hasFocus = !!popup.value?.contains(document.activeElement)
  if (hasFocus) {
    event.preventDefault()
    event.stopPropagation()
  }
  close(hasFocus)
}
function pointerEnter(event: PointerEvent) {
  if (event.pointerType === 'touch' || props.disabled) return
  clearTimers()
  openTimer = setTimeout(() => { void show() }, 180)
}
function scheduleClose() {
  clearTimeout(openTimer)
  cancelClose()
  closeTimer = setTimeout(() => {
    if (!contains(document.activeElement)) close()
  }, 180)
}
function focusIn(event: FocusEvent) {
  if (!suppressFocus && event.target instanceof HTMLElement && event.target.matches(':focus-visible')) void show()
}
function focusOut(event: FocusEvent) { if (!contains(event.relatedTarget)) { clearTimers(); closeTimer = setTimeout(() => close(), 0) } }
function anchorClick() { if (props.interactive) void show() }
async function focusPopup() {
  await show()
  if (opened.value) (popup.value?.querySelector<HTMLElement>(focusable) ?? popup.value)?.focus({ preventScroll: true })
}
function anchorKey(event: KeyboardEvent) {
  if (!props.interactive || props.disabled || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey && opened.value)) {
    event.preventDefault()
    event.stopPropagation()
    void focusPopup()
  }
}
function popupKey(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !props.interactive) return
  const items = Array.from(popup.value?.querySelectorAll<HTMLElement>(focusable) ?? []).filter(item => item.getClientRects().length)
  const current = document.activeElement
  if (event.shiftKey && (current === items[0] || current === popup.value)) {
    event.preventDefault()
    close(true)
  } else if (!event.shiftKey && (current === items.at(-1) || !items.length)) {
    // Restore the source before native Tab continues in the page's original order.
    close(true)
  }
}
watch(() => props.disabled, value => { if (value) dismiss() })
onDeactivated(() => close())
onUnmounted(() => close())
</script>

<style scoped>
.hover-info-anchor { display: contents; }
.hover-info-popup { position: fixed; z-index: 850; box-sizing: border-box; width: max-content; max-width: min(340px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow: auto; overscroll-behavior: contain; padding: 10px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); box-shadow: 0 8px 24px var(--c-shadow); color: var(--c-text); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.hover-info-popup.interactive { width: 320px; padding: 14px; }
.hover-info-popup:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.hover-info-text { margin: 0; white-space: pre-line; }
</style>
