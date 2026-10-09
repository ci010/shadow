<template>
  <SessionMessageDisclosure class="message-action" :data-recipient-session="message.sessionId" :aria-label="t('Outgoing session message')"
    :title="t('Send to session')" :recipient="message.recipient" :session-id="message.sessionId" outgoing
    @inspect="emit('inspect', $event)" @interact="emit('interact')">
    <template #status>
      <span class="message-action-status" :class="{ failed: message.status === 'failed' }" role="status">{{ status }}</span>
    </template>
    <div v-if="message.content" class="message-action-content"><slot>{{ message.content }}</slot></div>
    <template #details>
      <p v-if="message.status === 'queued'" class="message-action-note">{{ t('Queued for a response; receipt does not mean the work is complete.') }}</p>
      <p v-else-if="message.status === 'recorded'" class="message-action-note">{{ t('Recorded only; the recipient will not be woken.') }}</p>
      <p v-else-if="message.result !== undefined" class="message-action-note" :class="{ failed: message.status === 'failed' }">{{ message.result || t('Empty result; delivery is unconfirmed.') }}</p>
      <details class="message-action-details" @toggle.self="detailsOpen = ($event.currentTarget as HTMLDetailsElement).open">
        <summary @click="emit('interact')">{{ t('Tool details') }}</summary>
        <template v-if="detailsOpen">
          <ToolPayload boxed class="message-action-payload" :source="message.arguments" />
          <ToolPayload v-if="message.result !== undefined" boxed class="message-action-payload" :source="message.result || '(Empty result)'" />
          <p v-if="message.usage">{{ t('{prompt} prompt · {completion} completion · {total} total tokens', { prompt: formatNumber(message.usage.promptTokens), completion: formatNumber(message.usage.completionTokens), total: formatNumber(message.usage.totalTokens) }) }}</p>
        </template>
      </details>
    </template>
  </SessionMessageDisclosure>
</template>

<script setup lang="ts">
import { t, formatNumber } from '../i18n.ts'
import { computed, ref } from 'vue'
import type { MessageAction } from '../message-actions.ts'
import ToolPayload from './ToolPayload.vue'
import SessionMessageDisclosure from './SessionMessageDisclosure.vue'
const props = defineProps<{ message: MessageAction; running?: boolean }>()
const emit = defineEmits<{ inspect: [id: string]; interact: [] }>()
const detailsOpen = ref(false)
const status = computed(() => ({
  pending: props.running ? t('Sending...') : t('No result recorded'),
  queued: t('Queued'),
  recorded: t('Recorded silently'),
  failed: t('Failed'),
  unknown: t('Delivery unconfirmed'),
})[props.message.status])
</script>

<style scoped>
.message-action-status { color: var(--c-text-secondary); font-size: 12px; }
.message-action-status { margin-left: auto; }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.message-action-content { white-space: pre-wrap; overflow-wrap: anywhere; }
.message-action-content:has(.prose) { white-space: normal; }
.message-action-note, .message-action-details { margin: 8px 0 0; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.failed { color: var(--c-error); }
summary { width: fit-content; cursor: pointer; }
</style>
