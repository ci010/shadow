<template>
  <details v-if="isBackgroundResponse(context)" class="response-disclosure" :open="open"
    :data-response-id="context?.responseId" :data-msg-idx="messageIndex" @toggle.self="onToggle">
    <summary @click="emit('interact')">
      <span class="response-chevron i-lucide-chevron-right" aria-hidden="true" />
      <strong>Background response</strong>
      <span class="response-source" :title="source">{{ source }}</span>
      <span v-if="status" class="response-status" :class="{ failed: status === 'failed' }">{{ status === 'failed' ? 'Trigger failed' : 'Trigger cancelled' }}</span>
      <MessageTimestamp :timestamp="timestamp" />
    </summary>
    <div class="response-body"><slot /></div>
  </details>
  <slot v-else />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { isBackgroundResponse, type ResponseContext } from '../../../src/sessions/response-context.ts'
import MessageTimestamp from './MessageTimestamp.vue'
const props = defineProps<{ context?: ResponseContext; open?: boolean; timestamp?: string; messageIndex?: number }>()
const emit = defineEmits<{ 'update:open': [open: boolean]; interact: [] }>()
const source = computed(() => {
  const origin = props.context?.source
  return origin?.kind === 'session' ? origin.sessionId
    : origin?.kind === 'event' ? `${origin.type} · ${origin.source}` : ''
})
const status = computed(() => props.context?.source.kind === 'event' ? props.context.source.status : undefined)
function onToggle(event: Event) {
  if (event.currentTarget instanceof HTMLDetailsElement) emit('update:open', event.currentTarget.open)
}
</script>

<style scoped>
.response-disclosure { width: 100%; min-width: 0; color: var(--c-text-secondary); font-size: 13px; }
summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 32px; padding: 4px 0; list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary strong { font-size: inherit; font-weight: 500; }
summary:hover { color: var(--c-text); }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.response-chevron { flex: 0 0 16px; width: 16px; height: 16px; }
[open] > summary .response-chevron { transform: rotate(90deg); }
.response-source { flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.response-status { font-size: 12px; }
.failed { color: var(--c-error); }
.response-body { min-width: 0; margin: 0 0 8px 7px; padding-left: 16px; border-left: 1px solid var(--c-border); color: var(--c-text); overflow-wrap: anywhere; }
@media (max-width: 700px) { .response-body { margin-left: 0; padding-left: 8px; } }
</style>
