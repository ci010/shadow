<template>
  <article class="yield-decision" :class="decision.status" :aria-label="t('Decision')">
    <header>
      <span class="i-lucide-signpost" aria-hidden="true" />
      <strong>{{ t('Decision') }}</strong>
      <span class="decision-status">{{ decisionStatusLabel(decision.status) }}</span>
    </header>
    <p class="decision-question selectable-text">{{ decision.question }}</p>
    <p v-if="decision.reportingSessionId" class="decision-note">{{ t('Reporting responsibility:') }} {{ decision.reportingSessionId }} {{ t('· not answer authority') }}</p>
    <WorkContextPath v-if="decision.workContext" :context="decision.workContext" />
    <DecisionBrief v-if="decision.brief" :brief="decision.brief" @inspect="emit('inspect', $event)" />
    <p v-if="decision.invalidated" class="decision-warning" role="alert">{{ t('Basis changed:') }} {{ decision.invalidated.reason }}{{ t('. Any saved answer is historical, not approval for a changed scope.') }}</p>
    <ol v-if="decision.options.length" class="decision-options selectable-text">
      <li v-for="option in decision.options" :key="option" :class="{ chosen: decision.answer?.option === option && !decision.answer.custom }">
        {{ option }}
        <span v-if="decision.answer?.option === option && !decision.answer.custom" class="decision-option-note">{{ t('Selected') }}</span>
        <span v-else-if="option === decision.defaultOption" class="decision-option-note">{{ t('Timeout default') }}</span>
      </li>
    </ol>
    <div v-if="decision.answer" class="decision-answer selectable-text">
      <strong>{{ decision.answer.custom ? t('Custom response') : t('Recorded response') }}</strong>
      <p>{{ decision.answer.option }}</p>
      <MessageAttachments v-if="decision.answer.media?.length && apiBase !== undefined && (sessionId || decision.reference?.sessionId)"
        :paths="decision.answer.media" :api-base="apiBase" :session-id="sessionId || decision.reference?.sessionId || ''" :workdir="workdir"
        @preview="emit('preview', $event)" @open="emit('open', $event)" />
      <MessageTimestamp :timestamp="decision.answer.answeredAt" />
    </div>
    <p v-if="decision.status === 'waiting-user'" class="decision-note">{{ t('Reply using the decision controls below the conversation.') }}</p>
    <p v-else-if="decision.status === 'waiting-parent'" class="decision-note">{{ t('Only the parent session can answer this request.') }}</p>
    <p v-else-if="decision.status === 'unknown'" class="decision-note">{{ t('This trace does not confirm an answer or an active wait.') }}</p>
    <p v-else-if="decision.status === 'failed'" class="decision-note">{{ decision.result }}</p>
    <p v-else-if="decision.status === 'cancelled'" class="decision-note">{{ decision.result }} {{ t('A new request is needed to make a decision.') }}</p>
    <p v-else-if="decision.status === 'superseded'" class="decision-note">{{ t('This version was replaced without selecting an answer.') }} {{ decision.result }}</p>
    <p v-else-if="!decision.answer && ['investigation', 'deferred', 'invalidated'].includes(decision.status)" class="decision-note">{{ decision.result }} {{ t('No option was selected. Only investigation or already-authorized unaffected work may continue.') }}</p>
    <template v-if="apiBase !== undefined">
      <YieldSource v-for="source in decision.sources" :key="JSON.stringify(source)" :source="source" :api-base="apiBase"
        :answered="decision.action === 'answer'"
        @inspect="emit('inspect', $event)" @click="emit('interact')" />
    </template>
    <details v-if="decision.requestId || decision.arguments || decision.result !== undefined" class="decision-details" @click="emit('interact')">
      <summary>{{ t('Decision record') }}</summary>
      <p v-if="decision.requestId">{{ t('Request:') }} {{ decision.requestId }}</p>
      <p v-if="decision.origin">{{ t('Segment:') }} {{ decision.origin.physicalId }}</p>
      <ToolPayload v-if="decision.arguments" :source="decision.arguments" />
      <ToolPayload v-if="decision.result !== undefined" :source="decision.result || '(Empty result)'" />
    </details>
    <MessageTimestamp :timestamp="decision.timestamp" />
  </article>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { decisionStatusLabel, type YieldDecision } from '../yield-history.ts'
import MessageTimestamp from './MessageTimestamp.vue'
import ToolPayload from './ToolPayload.vue'
import YieldSource from './YieldSource.vue'
import DecisionBrief from './DecisionBrief.vue'
import WorkContextPath from './WorkContextPath.vue'
import MessageAttachments from './MessageAttachments.vue'
import type { SessionDetails } from '../session-details.ts'
import type { ImagePreview } from '../image-viewer.ts'
import type { OpenFile } from '../file-workbench.ts'
defineProps<{ decision: YieldDecision; apiBase?: string; canManage?: boolean; sessionId?: string; workdir?: SessionDetails['workdir'] }>()
const emit = defineEmits<{ interact: []; inspect: [sessionId: string]; updated: []; preview: [image: ImagePreview]; open: [file: OpenFile] }>()
</script>

<style scoped>
.yield-decision { width: min(100%, 760px); min-width: 0; padding: 12px 16px; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.yield-decision.waiting-user { border-color: var(--c-warn); background: var(--c-warn-bg); }
.yield-decision.waiting-parent { border-left-color: var(--c-warn); }
header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--c-purple); }
header > span:first-child { flex: 0 0 16px; width: 16px; height: 16px; }
.decision-status { margin-left: auto; font-size: 12px; color: var(--c-text-secondary); }
.waiting-user .decision-status, .waiting-parent .decision-status { color: var(--c-warn); font-weight: 600; }
.failed .decision-status { color: var(--c-error); }
.decision-warning { color: var(--c-warn); border-left: 2px solid var(--c-warn); padding-left: 8px; }
.decision-question { margin: 8px 0; white-space: pre-wrap; font-weight: 500; }
.decision-options { margin: 8px 0; padding-left: 24px; list-style: upper-alpha; }
.decision-options li { padding: 4px; white-space: pre-wrap; }
.decision-options .chosen { background: var(--c-selection-bg); }
.decision-option-note { margin-left: 8px; color: var(--c-text-secondary); font-size: 12px; }
.decision-answer { margin: 12px 0; padding: 8px 12px; border-left: 2px solid var(--c-blue); background: var(--c-bg-soft); }
.decision-answer p { margin: 4px 0; white-space: pre-wrap; }
.decision-note { margin: 8px 0; color: var(--c-text-secondary); }
.decision-dashboard { display: inline-flex; align-items: center; gap: 4px; margin: 8px 0; color: var(--c-blue); }
.decision-dashboard:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.decision-details { margin: 8px 0; }
.decision-details summary { cursor: pointer; color: var(--c-text-secondary); }
.decision-details summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.decision-details :deep(pre) { max-height: 260px; overflow: auto; white-space: pre-wrap; }
</style>
