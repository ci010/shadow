<template>
  <MessagePreviewCard class="session-message" :label="title" @interact="emit('interact')">
    <template #heading>
      <span class="session-message-icon" :class="outgoing ? 'i-lucide-send' : 'i-lucide-messages-square'" aria-hidden="true" />
      <strong :title="title">{{ title }}</strong>
      <button v-if="sessionId" type="button" class="session-message-link" :title="sessionId"
        :aria-label="t('Open conversation {id}', { id: sessionId })"
        @click.stop.prevent="emit('interact'); emit('inspect', sessionId)">
        <span>{{ recipient }}</span>
        <span class="session-message-icon i-lucide-arrow-up-right" aria-hidden="true" />
      </button>
      <span v-else class="session-message-recipient">{{ recipient }}</span>
      <slot name="status" />
      <MessageTimestamp v-if="timestamp" :timestamp="timestamp" />
    </template>
    <slot />
    <template v-if="$slots.details" #details><slot name="details" /></template>
  </MessagePreviewCard>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import MessageTimestamp from './MessageTimestamp.vue'
import MessagePreviewCard from './MessagePreviewCard.vue'

defineProps<{ title: string; recipient: string; sessionId?: string; outgoing?: boolean; timestamp?: string }>()
const emit = defineEmits<{ inspect: [id: string]; interact: [] }>()
</script>

<style scoped>
.session-message :deep(.message-preview-header > strong) { flex: 0 1 auto; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: inherit; font-weight: 500; }
.session-message-icon { flex: 0 0 14px; width: 14px; height: 14px; }
.session-message-link { display: inline-flex; align-items: center; gap: 6px; flex: 1 1 0; min-width: 0; max-width: 100%; min-height: 28px; padding: 4px 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.session-message-link > span:first-child, .session-message-recipient { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-message-recipient { flex: 1 1 0; }
.session-message-link:hover { color: var(--c-text); text-decoration: underline; }
.session-message-link:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
