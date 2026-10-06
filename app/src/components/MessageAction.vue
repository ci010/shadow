<template>
  <article class="message-action" :data-recipient-session="message.sessionId" aria-label="Outgoing session message">
    <div class="message-action-header">
      <span class="message-action-icon i-lucide-send" aria-hidden="true" />
      <span class="message-action-title">Message to</span>
      <button v-if="message.sessionId" type="button" class="message-recipient" :title="message.sessionId"
        :aria-label="`Open conversation ${message.recipient}${message.recipient !== message.sessionId ? ` (${message.sessionId})` : ''}`"
        @click="emit('interact'); emit('inspect', message.sessionId)">
        <span>{{ message.recipient }}</span>
        <span class="message-action-icon i-lucide-arrow-up-right" aria-hidden="true" />
      </button>
      <span v-else class="message-recipient-label">{{ message.recipient }}</span>
      <span class="message-action-status" :class="{ failed: message.status === 'failed' }" role="status">{{ status }}</span>
    </div>
    <div v-if="message.content" class="message-action-content"><slot>{{ message.content }}</slot></div>
    <p v-if="message.status === 'queued'" class="message-action-note">Queued for a response; receipt does not mean the work is complete.</p>
    <p v-else-if="message.status === 'recorded'" class="message-action-note">Recorded only; the recipient will not be woken.</p>
    <p v-else-if="message.result !== undefined" class="message-action-note" :class="{ failed: message.status === 'failed' }">{{ message.result || 'Empty result; delivery is unconfirmed.' }}</p>
    <details class="message-action-details" @toggle.self="detailsOpen = ($event.currentTarget as HTMLDetailsElement).open">
      <summary @click="emit('interact')">Tool details</summary>
      <template v-if="detailsOpen">
        <ToolPayload boxed class="message-action-payload" :source="message.arguments" />
        <ToolPayload v-if="message.result !== undefined" boxed class="message-action-payload" :source="message.result || '(Empty result)'" />
        <p v-if="message.usage">{{ message.usage.promptTokens.toLocaleString() }} prompt · {{ message.usage.completionTokens.toLocaleString() }} completion · {{ message.usage.totalTokens.toLocaleString() }} total tokens</p>
      </template>
    </details>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MessageAction } from '../message-actions.ts'
import ToolPayload from './ToolPayload.vue'
const props = defineProps<{ message: MessageAction; running?: boolean }>()
const emit = defineEmits<{ inspect: [id: string]; interact: [] }>()
const detailsOpen = ref(false)
const status = computed(() => ({
  pending: props.running ? 'Sending...' : 'No result recorded',
  queued: 'Queued',
  recorded: 'Recorded silently',
  failed: 'Failed',
  unknown: 'Delivery unconfirmed',
})[props.message.status])
</script>

<style scoped>
.message-action { width: fit-content; min-width: 0; margin-block: 8px; padding: 12px; border: 1px solid var(--c-chat-border); border-radius: var(--radius-surface); background: var(--c-chat-action-bg); color: var(--c-text); font-size: 13px; }
.message-action-header { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
.message-action-icon { display: block; flex: 0 0 14px; width: 14px; height: 14px; }
.message-action-title, .message-action-status { color: var(--c-text-secondary); font-size: 12px; }
.message-action-status { margin-left: auto; }
.message-recipient { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; min-height: 32px; padding: 4px 6px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; text-align: left; cursor: pointer; }
.message-recipient > span:first-child, .message-recipient-label { min-width: 0; overflow-wrap: anywhere; }
.message-recipient:hover { background: var(--c-bg-muted); text-decoration: underline; }
.message-recipient:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.message-action-content { margin-block: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.message-action-content:has(.prose) { white-space: normal; }
.message-action-note, .message-action-details { margin: 8px 0 0; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.failed { color: var(--c-error); }
summary { width: fit-content; cursor: pointer; }
</style>
