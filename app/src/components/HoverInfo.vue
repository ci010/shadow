<template>
  <span ref="anchor" class="hover-info-anchor" v-bind="$attrs" @pointerenter="pointerEnter" @pointerleave="scheduleClose"
    @focusin="focusIn" @focusout="focusOut" @keydown="anchorKey" @click="anchorClick">
    <slot :trigger-props="triggerProps" :open="show" :close="close" />
  </span>
  <Teleport v-if="sharedTooltip.host.value === token" to="body">
    <OverlayTransition>
      <div v-if="sharedTooltip.visible.value" :id="sharedTooltip.current.value?.id"
        :ref="setSharedPopup" class="hover-info-popup shared-hover-info" :class="{ interactive: sharedTooltip.current.value?.interactive }"
        :role="sharedTooltip.current.value?.interactive ? 'dialog' : 'tooltip'"
        :aria-label="sharedTooltip.current.value?.interactive ? sharedTooltip.current.value.label() : undefined"
        :tabindex="sharedTooltip.current.value?.interactive ? -1 : undefined" :style="sharedPosition"
        @pointerenter="sharedTooltip.current.value?.cancelClose()" @pointerleave="sharedTooltip.current.value?.scheduleClose()"
        @focusin="sharedTooltip.current.value?.cancelClose()" @focusout="sharedTooltip.current.value?.focusOut($event)"
        @keydown="sharedTooltip.current.value?.popupKey($event)">
        <SharedTooltipContent :key="sharedTooltip.current.value?.token" />
      </div>
    </OverlayTransition>
  </Teleport>
</template>

<script lang="ts">
let dismissCurrent: (() => void) | undefined
</script>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, h, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, useId, useSlots, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { hoverInfoPosition } from '../hover-info.ts'
import { registerTooltipHost, sharedTooltip, unregisterTooltipHost } from '../shared-tooltip.ts'
import OverlayTransition from './OverlayTransition.vue'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ text?: string; label?: string; interactive?: boolean; disabled?: boolean }>(), {
  text: '', label: '', interactive: false, disabled: false,
})
const id = `hover-info-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const token = Symbol(id)
const slots = useSlots()
const anchor = ref<HTMLElement>()
const opened = computed(() => sharedTooltip.visible.value && sharedTooltip.current.value?.token === token)
const sharedPosition = computed(() => {
  const point = sharedTooltip.position.value
  return {
    left: '0px', top: '0px', transform: `translate3d(${point.left}px, ${point.top}px, 0)`,
    visibility: point.visibility, '--tooltip-move-duration': point.moving ? '180ms' : '0ms',
  }
})
function SharedTooltipContent() { return sharedTooltip.current.value?.content() ?? [] }
function setSharedPopup(element: Element | ComponentPublicInstance | null) {
  sharedTooltip.element.value = element instanceof HTMLElement ? element : undefined
  if (!element && !sharedTooltip.visible.value) sharedTooltip.current.value = undefined
}
const popupElement = () => sharedTooltip.current.value?.token === token ? sharedTooltip.element.value : undefined
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
  return target instanceof Node && (!!anchor.value?.contains(target) || !!popupElement()?.contains(target))
}
function cancelClose() { clearTimeout(closeTimer); closeTimer = undefined }
function clearTimers() { clearTimeout(openTimer); openTimer = undefined; cancelClose() }
function measure() {
  const source = trigger()
  const card = popupElement()
  if (!source?.getClientRects().length || !card) { close(); return }
  const point = hoverInfoPosition(source.getBoundingClientRect(), card.getBoundingClientRect(), {
    width: document.documentElement.clientWidth, height: window.innerHeight,
  })
  sharedTooltip.position.value = { ...point, visibility: 'visible', moving: sharedTooltip.position.value.moving }
}
function observePopup() {
  observer?.disconnect()
  observer = new ResizeObserver(measure)
  const card = popupElement()
  if (card) observer.observe(card)
}
async function show() {
  if (props.disabled) return
  clearTimers()
  if (opened.value) return
  const moving = sharedTooltip.visible.value
  dismissCurrent?.()
  dismissCurrent = close
  sharedTooltip.current.value = {
    token, id, interactive: props.interactive, label: () => props.label || props.text || t('More information'),
    content: () => slots.content?.({ close }) ?? [h('p', { class: 'hover-info-text' }, props.text)],
    cancelClose, scheduleClose, focusOut, popupKey,
  }
  sharedTooltip.position.value = { ...sharedTooltip.position.value, moving, visibility: moving ? 'visible' : 'hidden' }
  sharedTooltip.visible.value = true
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', documentKey, true)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', dismiss)
  window.addEventListener('blur', dismiss)
  await nextTick()
  if (!opened.value) return
  measure()
  observePopup()
}
function close(restoreFocus = false) {
  clearTimers()
  if (sharedTooltip.current.value?.token === token) sharedTooltip.visible.value = false
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
function dismiss() { close(!!popupElement()?.contains(document.activeElement)) }
function outside(event: PointerEvent) { if (!contains(event.target)) close() }
function scroll(event: Event) { if (!(event.target instanceof Node && popupElement()?.contains(event.target))) dismiss() }
function documentKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !opened.value) return
  const hasFocus = !!popupElement()?.contains(document.activeElement)
  if (hasFocus) {
    event.preventDefault()
    event.stopPropagation()
  }
  close(hasFocus)
}
function pointerEnter(event: PointerEvent) {
  if (event.pointerType === 'touch' || props.disabled) return
  clearTimers()
  if (sharedTooltip.visible.value) { void show(); return }
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
  if (opened.value) {
    const card = popupElement()
    const target = card?.querySelector<HTMLElement>(focusable) ?? card
    target?.focus({ preventScroll: true })
  }
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
  const card = popupElement()
  const items = Array.from(card?.querySelectorAll<HTMLElement>(focusable) ?? []).filter(item => item.getClientRects().length)
  const current = document.activeElement
  if (event.shiftKey && (current === items[0] || current === card)) {
    event.preventDefault()
    close(true)
  } else if (!event.shiftKey && (current === items.at(-1) || !items.length)) {
    // Restore the source before native Tab continues in the page's original order.
    close(true)
  }
}
watch(() => props.disabled, value => { if (value) dismiss() })
watch(sharedTooltip.element, () => {
  if (!opened.value) return
  measure()
  observePopup()
}, { flush: 'post' })
onMounted(() => registerTooltipHost(token))
onActivated(() => registerTooltipHost(token))
onDeactivated(() => { close(); unregisterTooltipHost(token) })
onUnmounted(() => { close(); unregisterTooltipHost(token) })
</script>

<style scoped>
.hover-info-anchor { display: contents; }
.hover-info-popup { position: fixed; z-index: 850; box-sizing: border-box; width: max-content; max-width: min(340px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow: auto; overscroll-behavior: contain; padding: 10px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); box-shadow: 0 8px 24px var(--c-shadow); color: var(--c-text); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.hover-info-popup.interactive { width: 320px; padding: 14px; }
.shared-hover-info { transition: transform var(--tooltip-move-duration, 0ms) var(--overlay-easing); }
.shared-hover-info.overlay-enter-active { transition: opacity var(--overlay-enter-duration) var(--overlay-easing), transform var(--tooltip-move-duration, 0ms) var(--overlay-easing), translate var(--overlay-enter-duration) var(--overlay-easing); }
.shared-hover-info.overlay-leave-active { transition: opacity var(--overlay-leave-duration) ease-out, translate var(--overlay-leave-duration) ease-out; }
.shared-hover-info.overlay-enter-from, .shared-hover-info.overlay-leave-to { translate: 0 4px; }
.hover-info-popup:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.hover-info-popup :deep(.hover-info-text) { margin: 0; white-space: pre-line; }
@media (prefers-reduced-motion: reduce) {
  .shared-hover-info, .shared-hover-info.overlay-enter-active, .shared-hover-info.overlay-leave-active { transition: none; }
}
</style>
