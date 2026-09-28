<template>
  <details v-if="isBackgroundResponse(context)" class="response-disclosure" :open="open"
    :data-response-id="context?.responseId" :data-msg-idx="messageIndex" @toggle.self="onToggle">
    <summary class="trace-header" @click="emit('interact')">
      <span class="response-chevron i-lucide-chevron-right" aria-hidden="true" />
      <strong>Background response</strong>
      <span class="response-source" :title="source">{{ source }}</span>
      <span v-if="status" class="response-status" :class="{ failed: status === 'failed' }">{{ status === 'failed' ? 'Trigger failed' : 'Trigger cancelled' }}</span>
      <MessageTimestamp :timestamp="timestamp" />
    </summary>
    <div class="response-body trace-guide"><slot /></div>
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
summary strong { font-size: inherit; font-weight: 500; }
.response-chevron { flex: 0 0 16px; width: 16px; height: 16px; }
[open] > summary .response-chevron { transform: rotate(90deg); }
.response-source { flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.response-status { flex: 0 0 auto; font-size: 12px; }
.failed { color: var(--c-error); }
.response-body { min-width: 0; margin-bottom: 8px; color: var(--c-text); overflow-wrap: anywhere; }
</style>
