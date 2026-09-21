<template>
  <article class="yield-decision" :class="decision.status" aria-label="Decision">
    <header>
      <span class="i-lucide-signpost" aria-hidden="true" />
      <strong>Decision</strong>
      <span class="decision-status">{{ decisionStatusLabel(decision.status) }}</span>
    </header>
    <p class="decision-question">{{ decision.question }}</p>
    <p v-if="decision.reportingSessionId" class="decision-note">Reporting responsibility: {{ decision.reportingSessionId }} · not answer authority</p>
    <DecisionBrief v-if="decision.brief" :brief="decision.brief" @inspect="emit('inspect', $event)" />
    <p v-else class="decision-note">This older record has no structured brief. Do not infer missing evidence or user constraints.</p>
    <p v-if="decision.invalidated" class="decision-warning" role="alert">Basis changed: {{ decision.invalidated.reason }}. Any saved answer is historical, not approval for a changed scope.</p>
    <ol v-if="decision.options.length" class="decision-options">
      <li v-for="option in decision.options" :key="option" :class="{ chosen: decision.answer?.option === option && !decision.answer.custom }">
        {{ option }}
        <span v-if="decision.answer?.option === option && !decision.answer.custom" class="decision-option-note">Selected</span>
        <span v-else-if="option === decision.defaultOption" class="decision-option-note">Timeout default</span>
      </li>
    </ol>
    <div v-if="decision.answer" class="decision-answer">
      <strong>{{ decision.answer.custom ? 'Custom response' : 'Recorded response' }}</strong>
      <p>{{ decision.answer.option }}</p>
      <MessageTimestamp :timestamp="decision.answer.answeredAt" />
    </div>
    <p v-if="decision.status === 'waiting-user'" class="decision-note">Reply using the decision controls below the conversation.</p>
    <p v-else-if="decision.status === 'waiting-parent'" class="decision-note">Only the parent session can answer this request.</p>
    <p v-else-if="decision.status === 'unknown'" class="decision-note">This trace does not confirm an answer or an active wait.</p>
    <p v-else-if="decision.status === 'failed'" class="decision-note">{{ decision.result }}</p>
    <p v-else-if="decision.status === 'cancelled'" class="decision-note">{{ decision.result }} A new request is needed to make a decision.</p>
    <p v-else-if="decision.status === 'superseded'" class="decision-note">This version was replaced without selecting an answer. {{ decision.result }}</p>
    <p v-else-if="!decision.answer && ['investigation', 'deferred', 'invalidated'].includes(decision.status)" class="decision-note">{{ decision.result }} No option was selected. Only investigation or already-authorized unaffected work may continue.</p>
    <template v-if="apiBase !== undefined">
      <DecisionGraph v-if="decision.reference" :reference="decision.reference" :api-base="apiBase" @inspect="emit('inspect', $event)" @click="emit('interact')" />
      <DecisionDiscussion v-if="decision.reference" :reference="decision.reference" :api-base="apiBase" :can-invalidate="canManage && !decision.invalidated" @updated="emit('updated')" @click="emit('interact')" />
      <YieldSource v-for="source in decision.sources" :key="JSON.stringify(source)" :source="source" :api-base="apiBase"
        :answered="decision.action === 'answer'"
        @inspect="emit('inspect', $event)" @click="emit('interact')" />
    </template>
    <details v-if="decision.requestId || decision.arguments || decision.result !== undefined" class="decision-details" @click="emit('interact')">
      <summary>Decision record</summary>
      <p v-if="decision.requestId">Request: {{ decision.requestId }}</p>
      <p v-if="decision.origin">Segment: {{ decision.origin.physicalId }}</p>
      <ToolPayload v-if="decision.arguments" :source="decision.arguments" />
      <ToolPayload v-if="decision.result !== undefined" :source="decision.result || '(Empty result)'" />
    </details>
    <MessageTimestamp :timestamp="decision.timestamp" />
  </article>
</template>

<script setup lang="ts">
import { decisionStatusLabel, type YieldDecision } from '../yield-history.ts'
import MessageTimestamp from './MessageTimestamp.vue'
import ToolPayload from './ToolPayload.vue'
import YieldSource from './YieldSource.vue'
import DecisionGraph from './DecisionGraph.vue'
import DecisionDiscussion from './DecisionDiscussion.vue'
import DecisionBrief from './DecisionBrief.vue'
defineProps<{ decision: YieldDecision; apiBase?: string; canManage?: boolean }>()
const emit = defineEmits<{ interact: []; inspect: [sessionId: string]; updated: [] }>()
</script>

<style scoped>
.yield-decision { width: min(100%, 760px); min-width: 0; padding: 12px 16px; border: 1px solid var(--c-border); border-left: 3px solid var(--c-purple); background: var(--c-bg-card); color: var(--c-text); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
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
.decision-details { margin: 8px 0; }
.decision-details summary { cursor: pointer; color: var(--c-text-secondary); }
.decision-details summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.decision-details :deep(pre) { max-height: 260px; overflow: auto; white-space: pre-wrap; }
</style>
