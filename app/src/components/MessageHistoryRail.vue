<template>
  <nav v-if="entries.length" ref="rail" class="message-history-rail" aria-label="User message history" @mouseleave="hidePreview" @keydown="navigate">
    <button
      v-for="(entry, ordinal) in entries"
      :key="entry.index"
      class="history-marker"
      :class="{ current: currentIndex === entry.index, previewing: preview?.index === entry.index }"
      :aria-label="`Jump to message ${ordinal + 1}: ${entry.preview.slice(0, 160)}`"
      :aria-current="currentIndex === entry.index ? 'true' : undefined"
      :aria-describedby="preview?.index === entry.index ? tooltipId : undefined"
      @mouseenter="showPreview(entry, $event)"
      @focus="showPreview(entry, $event)"
      @blur="hidePreview"
      @click="jumpTo(entry.index)"
    ><span aria-hidden="true" /></button>
  </nav>
  <Teleport to="body">
    <div v-if="preview" :id="tooltipId" class="history-preview" role="tooltip" :style="previewPosition">
      <div class="history-preview-message">{{ preview.preview }}</div>
      <time :datetime="preview.timestamp" :title="preview.timestamp">{{ formatMessageTime(preview.timestamp) }}</time>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onActivated, onDeactivated, onUnmounted, ref, useId, watch } from 'vue'
import { formatMessageTime, type UserMessageMarker } from '../message-history.ts'

const props = defineProps<{ entries: readonly UserMessageMarker[]; container?: HTMLElement }>()
const rail = ref<HTMLElement>()
const currentIndex = ref(-1)
const preview = ref<UserMessageMarker>()
const previewPosition = ref<Record<string, string>>({})
const tooltipId = useId()
let frame: number | undefined
let active = true

function hidePreview() { preview.value = undefined }
function showPreview(entry: UserMessageMarker, event: Event) {
  if (!(event.currentTarget instanceof HTMLElement)) return
  const rect = event.currentTarget.getBoundingClientRect()
  const width = Math.min(360, Math.max(120, rect.left - 24))
  previewPosition.value = {
    width: `${width}px`,
    left: `${Math.max(8, rect.left - width - 10)}px`,
    top: `${Math.max(8, Math.min(rect.top - 24, window.innerHeight - 112))}px`,
  }
  preview.value = entry
}
function jumpTo(index: number) {
  const element = props.container?.querySelector<HTMLElement>(`[data-msg-idx="${index}"]`)
  if (!element) return
  element.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  })
  currentIndex.value = index
}
function updateCurrent() {
  frame = undefined
  const container = props.container
  if (!container || !props.entries.length) return
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 8) {
    currentIndex.value = props.entries.at(-1)!.index
    return
  }
  const top = container.getBoundingClientRect().top + 32
  let current = props.entries[0].index
  for (const entry of props.entries) {
    const element = container.querySelector<HTMLElement>(`[data-msg-idx="${entry.index}"]`)
    if (element && element.getBoundingClientRect().top > top) break
    current = entry.index
  }
  currentIndex.value = current
}
function scheduleUpdate() {
  if (active && frame === undefined) frame = requestAnimationFrame(updateCurrent)
}
function navigate(event: KeyboardEvent) {
  if (event.key === 'Escape') { hidePreview(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = Array.from(rail.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  if (!buttons.length) return
  event.preventDefault()
  const index = buttons.findIndex(button => button === document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  buttons[next]?.scrollIntoView({ block: 'nearest' })
  buttons[next]?.focus({ preventScroll: true })
}
function resize() { hidePreview(); scheduleUpdate() }
function deactivate() {
  active = false
  props.container?.removeEventListener('scroll', scheduleUpdate)
  window.removeEventListener('resize', resize)
  if (frame !== undefined) cancelAnimationFrame(frame)
  frame = undefined
  hidePreview()
}
function activate() {
  active = true
  props.container?.addEventListener('scroll', scheduleUpdate, { passive: true })
  window.addEventListener('resize', resize)
  scheduleUpdate()
}
watch(() => props.container, (container, previous) => {
  previous?.removeEventListener('scroll', scheduleUpdate)
  if (active) {
    container?.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', resize)
  }
  scheduleUpdate()
}, { immediate: true, flush: 'post' })
watch(() => props.entries, async () => {
  hidePreview()
  await nextTick()
  scheduleUpdate()
})
watch(currentIndex, async () => {
  await nextTick()
  const container = rail.value
  const marker = container?.querySelector<HTMLElement>('[aria-current="true"]')
  if (!container || !marker) return
  if (marker.offsetTop < container.scrollTop) container.scrollTop = marker.offsetTop
  else if (marker.offsetTop + marker.offsetHeight > container.scrollTop + container.clientHeight) {
    container.scrollTop = marker.offsetTop + marker.offsetHeight - container.clientHeight
  }
})
onActivated(activate)
onDeactivated(deactivate)
onUnmounted(deactivate)
</script>

<style scoped>
.message-history-rail { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); z-index: 2; display: flex; flex-direction: column; align-items: flex-end; width: 42px; max-height: min(65%, 340px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; padding: 5px 0; }
.message-history-rail::-webkit-scrollbar { display: none; }
.history-marker { display: flex; align-items: center; justify-content: flex-end; flex: 0 0 15px; width: 100%; height: 15px; padding: 0 5px; border: 0; background: transparent; cursor: pointer; }
.history-marker span { display: block; width: 10px; height: 3px; border-radius: var(--radius-sm); background: var(--c-text-secondary); opacity: .5; transition: width .15s ease, opacity .15s ease; }
.history-marker.current span { width: 20px; opacity: .85; }
.history-marker:hover span, .history-marker.previewing span, .history-marker:focus-visible span { width: 30px; opacity: 1; background: var(--c-text); }
.history-marker:focus-visible { outline: 1px solid var(--c-blue); outline-offset: -1px; border-radius: var(--radius-control); }
.history-preview { position: fixed; z-index: 980; box-sizing: border-box; padding: 12px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 8px 28px var(--c-shadow); pointer-events: none; }
.history-preview-message { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-size: 13px; font-weight: 600; line-height: 1.5; }
.history-preview time { display: block; margin-top: 4px; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; }
@media (prefers-reduced-motion: reduce) { .history-marker span { transition: none; } }
</style>
