<template>
  <section v-if="notices.length" ref="root" class="connection-status" :aria-label="t('Connection status')" @keydown.esc="close">
    <button ref="trigger" type="button" class="status-trigger" :aria-expanded="expanded" :aria-controls="id" @click="expanded = !expanded">
      <span class="status-mark" aria-hidden="true">!</span>
      <span role="status">{{ notices.length === 1 ? notices[0]!.title : t('{length} connection notices', { length: notices.length }) }}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true" :class="{ expanded }"><path d="m5 6 3 3 3-3" /></svg>
    </button>
    <OverlayTransition>
    <div v-show="expanded" :id="id" class="status-popover">
      <section v-for="notice in notices" :key="notice.id" class="status-notice">
        <h2>{{ notice.title }}</h2>
        <p>{{ notice.message }}</p>
        <button v-if="notice.id === 'child'" type="button" @click="$emit('manage-node')">{{ t('Manage this node') }}</button>
        <button v-if="notice.id === 'live'" type="button" @click="$emit('retry')">{{ t('Retry live updates') }}</button>
      </section>
    </div>
    </OverlayTransition>
  </section>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import OverlayTransition from './OverlayTransition.vue'

const props = defineProps<{ childTitle?: string; liveError?: string; notificationError?: string }>()
defineEmits<{ retry: []; 'manage-node': [] }>()
const id = useId()
const root = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const expanded = ref(false)
const notices = computed(() => [
  ...(props.childTitle ? [{ id: 'child', title: props.childTitle, message: t('Main-backed tools may be stale, but this Child\'s local controls remain available.') }] : []),
  ...(props.liveError ? [{ id: 'live', title: t('Live updates interrupted'), message: props.liveError }] : []),
  ...(props.notificationError ? [{ id: 'sound', title: t('Notification sounds'), message: props.notificationError }] : []),
])
watch(() => notices.value.map(notice => notice.id), (current, previous = []) => {
  if (!current.length) expanded.value = false
  else if (current.some(id => !previous.includes(id))) expanded.value = true
}, { immediate: true })
function close(event: KeyboardEvent) {
  if (!expanded.value || event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  expanded.value = false
  trigger.value?.focus({ preventScroll: true })
}
function outside(event: Event) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) expanded.value = false
}
onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('focusin', outside)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('focusin', outside)
})
</script>

<style scoped>
.connection-status {
  position: absolute; top: 12px; right: max(12px, env(safe-area-inset-right, 0px)); z-index: 60;
  width: min(380px, calc(100% - max(12px, env(safe-area-inset-left, 0px)) - max(12px, env(safe-area-inset-right, 0px))));
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px; pointer-events: none;
  color: var(--c-text); font-size: 13px; line-height: 1.5;
}
button { min-height: 36px; padding: 8px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; cursor: pointer; text-align: left; }
button:hover { background: var(--c-bg-muted); }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -3px; }
.status-trigger { display: flex; align-items: center; gap: 8px; max-width: 100%; pointer-events: auto; box-shadow: 0 4px 12px var(--c-shadow-soft); }
.status-trigger span[role="status"] { min-width: 0; overflow-wrap: anywhere; }
.status-mark { color: var(--c-warn); font-weight: 600; }
svg { width: 14px; height: 14px; flex: 0 0 14px; fill: none; stroke: currentColor; stroke-width: 1.5; }
svg.expanded { transform: rotate(180deg); }
.status-popover { box-sizing: border-box; width: 100%; max-height: min(440px, 60dvh); overflow-y: auto; overscroll-behavior: contain; pointer-events: auto; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); box-shadow: 0 12px 36px var(--c-shadow); }
.status-notice { padding: 16px; }
.status-notice + .status-notice { border-top: 1px solid var(--c-border-soft); }
h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
p { margin: 0; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.status-notice button { margin-top: 12px; color: var(--c-primary); }
@media (max-width: 700px), (pointer: coarse) { button { min-height: 44px; } }
</style>
