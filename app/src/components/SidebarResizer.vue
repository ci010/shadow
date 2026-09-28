<template>
  <div class="sidebar-resizer" :class="{ 'is-resizing': !!drag, 'left-edge': edge === 'left' }" role="separator" tabindex="0"
    :aria-label="label" aria-orientation="vertical" :aria-controls="controls"
    :aria-valuemin="bounds.min" :aria-valuemax="bounds.max" :aria-valuenow="modelValue"
    :aria-valuetext="`${modelValue} pixels`"
    @pointerdown="startResize" @pointermove="resize" @pointerup="endPointer" @pointercancel="endPointer"
    @lostpointercapture="endPointer" @keydown="resizeKey" />
</template>

<script setup lang="ts">
import { onDeactivated, onUnmounted, shallowRef } from 'vue'
import { sidebarDragWidth, sidebarKeyWidth, type SidebarResizeEdge, type SidebarWidthBounds } from '../sidebar-resize.ts'

const props = defineProps<{ modelValue: number; bounds: SidebarWidthBounds; label: string; controls: string; edge?: SidebarResizeEdge }>()
const emit = defineEmits<{ 'update:modelValue': [width: number] }>()
const drag = shallowRef<{ x: number; width: number; target: HTMLElement; pointerId: number; restore: () => void }>()

function stopResize() {
  const current = drag.value
  drag.value = undefined
  if (!current) return
  window.removeEventListener('blur', stopResize)
  current.restore()
  if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId)
}
function startResize(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary || drag.value || !(event.currentTarget instanceof HTMLElement)) return
  event.preventDefault()
  const target = event.currentTarget
  target.focus({ preventScroll: true })
  target.setPointerCapture(event.pointerId)
  const root = document.documentElement
  const alreadyResizing = root.classList.contains('sidebar-pointer-resizing')
  root.classList.add('sidebar-pointer-resizing')
  drag.value = {
    x: event.clientX, width: props.modelValue, target, pointerId: event.pointerId,
    restore: () => { if (!alreadyResizing) root.classList.remove('sidebar-pointer-resizing') },
  }
  window.addEventListener('blur', stopResize)
}
function resize(event: PointerEvent) {
  const current = drag.value
  if (!current || current.pointerId !== event.pointerId) return
  emit('update:modelValue', sidebarDragWidth(current.width, current.x, event.clientX, props.bounds, props.edge))
}
function endPointer(event: PointerEvent) {
  if (drag.value?.pointerId === event.pointerId) stopResize()
}
function resizeKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (drag.value) { event.preventDefault(); event.stopPropagation(); stopResize() }
    return
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const width = sidebarKeyWidth(event.key, props.modelValue, props.bounds, props.edge)
  if (width === undefined) return
  event.preventDefault()
  event.stopPropagation()
  stopResize()
  emit('update:modelValue', width)
}
onDeactivated(stopResize)
onUnmounted(stopResize)
</script>

<style scoped>
.sidebar-resizer { position: absolute; inset: 0 -4px 0 auto; width: 8px; z-index: 3; cursor: col-resize; touch-action: none; outline: none; }
.sidebar-resizer.left-edge { inset: 0 auto 0 -4px; }
.sidebar-resizer::after { content: ''; position: absolute; inset: 0 auto 0 3px; width: 1px; background: transparent; }
.sidebar-resizer:hover::after, .sidebar-resizer:focus-visible::after, .sidebar-resizer.is-resizing::after { width: 2px; background: var(--c-blue); }
</style>

<style>
html.sidebar-pointer-resizing, html.sidebar-pointer-resizing * { cursor: col-resize !important; user-select: none !important; }
</style>
