<template>
  <article class="input-question" :class="entry.status" :aria-label="t('Question and answer')" :data-request-id="entry.requestId">
    <header><span class="i-lucide-message-circle-question" aria-hidden="true" /><strong>{{ t('Question') }}</strong><span class="input-status" role="status">{{ inputStatusLabel(entry.status) }}</span></header>
    <h2 class="input-prompt selectable-text">{{ entry.question }}</h2>
    <WorkContextPath v-if="entry.workContext" :context="entry.workContext" />
    <section v-if="entry.answer" class="input-answer selectable-text" :aria-label="t('Recorded response')">
      <strong>{{ t('Recorded response') }}</strong>
      <p>{{ entry.answer.text }}</p>
      <MessageAttachments v-if="entry.answer.media?.length" :paths="entry.answer.media" :api-base="apiBase" :session-id="sessionId" :workdir="workdir" @preview="emit('preview', $event)" @open="emit('open', $event)" />
      <MessageTimestamp :timestamp="entry.answer.answeredAt" />
    </section>
    <p v-if="entry.status === 'waiting-user'" class="input-note">{{ t('Reply in the message box below. Your answer will appear with this question.') }}</p>
    <p v-else-if="entry.status === 'waiting-parent'" class="input-note">{{ t('Only the parent session can answer this request.') }}</p>
    <p v-else-if="entry.status === 'waiting-caller'" class="input-note">{{ t('Waiting for the authenticated A2A caller.') }}</p>
    <p v-else-if="entry.status === 'unknown'" class="input-note">{{ t('This trace does not confirm an answer or an active wait.') }}</p>
    <p v-else-if="entry.status === 'cancelled' || entry.status === 'failed'" class="input-note">{{ t('No answer was confirmed for this question.') }}</p>
    <details v-if="entry.requestId || entry.arguments || entry.result !== undefined" @click="emit('interact')" @toggle="detailsOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('Question record') }}</summary>
      <p v-if="entry.requestId">{{ t('Request:') }} {{ entry.requestId }}</p>
      <ToolPayload v-if="detailsOpen && entry.arguments" :source="entry.arguments" />
      <ToolPayload v-if="detailsOpen && entry.result !== undefined" :source="entry.result" />
    </details>
    <MessageTimestamp :timestamp="entry.timestamp" />
  </article>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { ref } from 'vue'
const detailsOpen = ref(false)
import { inputStatusLabel, type InputQuestion } from '../input-history.ts'
import MessageAttachments from './MessageAttachments.vue'
import MessageTimestamp from './MessageTimestamp.vue'
import ToolPayload from './ToolPayload.vue'
import WorkContextPath from './WorkContextPath.vue'
import type { SessionDetails } from '../session-details.ts'
import type { ImagePreview } from '../image-viewer.ts'
import type { OpenFile } from '../file-workbench.ts'
defineProps<{ entry: InputQuestion; apiBase: string; sessionId: string; workdir?: SessionDetails['workdir'] }>()
const emit = defineEmits<{ interact: []; preview: [image: ImagePreview]; open: [file: OpenFile] }>()
</script>

<style scoped>
.input-question { box-sizing: border-box; width: 100%; max-width: var(--conversation-item-max-width, 80%); min-width: 0; padding: 12px 16px; border: 1px solid var(--c-chat-border); border-radius: var(--radius-surface); background: var(--c-bg-card); color: var(--c-text); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; align-self: flex-start; }
header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
header > span:first-child { width: 16px; height: 16px; flex: 0 0 16px; }
.input-status { margin-left: auto; font-size: 12px; color: var(--c-text-secondary); }
.waiting-user .input-status, .waiting-parent .input-status, .waiting-caller .input-status { color: var(--c-warn); }
.failed .input-status { color: var(--c-error); }
.input-prompt { margin: 12px 0; font-size: 18px; font-weight: 600; line-height: 1.5; white-space: pre-wrap; }
.input-answer { margin: 12px 0; padding: 8px 12px; border-left: 2px solid var(--c-blue); background: var(--c-bg-soft); }
.input-answer p { margin: 4px 0; white-space: pre-wrap; }
.input-note, details { color: var(--c-text-secondary); font-size: 12px; }
summary { cursor: pointer; min-height: 32px; display: list-item; align-content: center; }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px), (pointer: coarse) { summary { min-height: 44px; } }
</style>
