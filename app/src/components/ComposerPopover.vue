<template>
  <button ref="trigger" class="composer-control" :class="{ active: open }" :disabled="disabled" :aria-label="label" :title="title ?? label" aria-haspopup="dialog" :aria-expanded="open" @click="toggle" @keydown.down.prevent="show">
    <slot name="trigger" />
  </button>
  <Teleport to="body">
    <div v-if="open" class="composer-popover-backdrop" @pointerdown.self="close(false)">
      <div ref="panel" class="composer-popover" role="dialog" :aria-label="label" :style="position" @keydown="keydown">
        <slot :close="() => close(true)" />
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onDeactivated, onUnmounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ label: string; title?: string; disabled?: boolean; width?: number }>(), { width: 340 })
const open = ref(false)
const trigger = ref<HTMLButtonElement>()
const panel = ref<HTMLElement>()
const position = ref<Record<string, string>>({})

async function show() {
  if (props.disabled || !trigger.value) return
  const rect = trigger.value.getBoundingClientRect()
  const width = Math.min(props.width, window.innerWidth - 24)
  const below = window.innerHeight - rect.bottom - 16
  const above = rect.top - 16
  const down = below >= Math.min(340, above)
  position.value = {
    width: `${width}px`,
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    ...(down ? { top: `${rect.bottom + 8}px` } : { bottom: `${window.innerHeight - rect.top + 8}px` }),
    maxHeight: `${Math.max(100, down ? below : above)}px`,
  }
  open.value = true
  window.addEventListener('resize', dismiss)
  await nextTick()
  panel.value?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus()
}
function close(restoreFocus = true) {
  if (!open.value) return
  open.value = false
  window.removeEventListener('resize', dismiss)
  if (restoreFocus) trigger.value?.focus({ preventScroll: true })
}
function dismiss() { close(false) }
function toggle() { if (open.value) close(); else void show() }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key === 'Tab') { close(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  if (event.target instanceof HTMLInputElement && ['Home', 'End'].includes(event.key)) return
  const buttons = Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (!buttons.length) return
  event.preventDefault()
  const index = buttons.findIndex(button => button === document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
watch(() => props.disabled, disabled => { if (disabled) close() })
onDeactivated(dismiss)
onUnmounted(dismiss)
</script>

<style scoped>
.composer-control { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; min-height: 32px; padding: 5px 9px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.composer-control:hover, .composer-control.active { background: var(--c-bg-muted); color: var(--c-text); }
.composer-control:disabled { opacity: .5; cursor: not-allowed; }
.composer-control:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.composer-popover-backdrop { position: fixed; inset: 0; z-index: 950; }
.composer-popover { position: fixed; display: flex; flex-direction: column; overflow: auto; padding: 7px; box-sizing: border-box; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 12px 36px var(--c-shadow); }
</style>
