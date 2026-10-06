<template>
  <div class="automation-context">
    <div v-if="conversation.error.value" class="automation-note" role="alert">
      <p>{{ conversation.error.value }}</p><button class="btn btn-sm" :disabled="conversation.loading.value" @click="conversation.refresh()">Retry automation</button>
    </div>
    <div v-if="conversation.historyError.value" class="automation-note" role="alert">
      <p>{{ conversation.historyError.value }}</p><button class="btn btn-sm" :disabled="conversation.loading.value" @click="conversation.retry()">Retry history</button>
    </div>
    <p v-if="automation?.notice" class="automation-note" role="status">{{ automation.notice }}</p>
    <details class="automation-info">
      <summary>Automation details<span v-if="run" class="run-time">{{ started(run.startedAt) }}</span></summary>
      <div class="automation-info-body">
        <template v-if="automation">
          <dl>
            <dt>{{ automation.source === 'learning' ? 'Check frequency' : 'Schedule' }}</dt><dd><code>{{ automation.schedule }}</code></dd>
            <dt>Agent</dt><dd>{{ automation.agentType || 'Default agent' }}</dd>
            <dt>Dispatch</dt><dd>{{ automation.enabled ? 'Enabled' : 'Disabled' }}</dd>
            <dt>Session mode</dt><dd>Fresh — each dispatch starts a separate conversation.</dd>
            <dt>Prompt</dt><dd>{{ automation.task || 'No prompt is available for this automation.' }}</dd>
          </dl>
          <p v-if="automation.source === 'learning'">Checks are activity-gated. A check does not necessarily start a run.</p>
          <p v-if="!automation.enabled">Dispatch is disabled. Saved conversations remain available.</p>
        </template>
        <p v-else role="status">Automation information is unavailable.</p>
        <p v-if="run">Execution: {{ statusLabel(run.status) }}</p>
        <button class="btn btn-sm" :disabled="conversation.loading.value" @click="conversation.refresh()">Refresh history</button>
      </div>
    </details>
    <div v-if="run && automation?.source === 'learning'" class="learning-outcome" role="status">
      <template v-if="run.learning">
        <strong>{{ learningOutcomeLabel(run.learning) }}</strong>
        <p>{{ run.learning.summary }}</p>
        <small>Execution: {{ statusLabel(run.status) }} · {{ run.learning.artifacts }} {{ run.learning.status === 'applied' ? 'verified' : 'recorded' }} {{ run.learning.artifacts === 1 ? 'artifact' : 'artifacts' }} · {{ run.learning.events }} {{ run.learning.events === 1 ? 'event' : 'events' }} · {{ run.learning.evaluated }} {{ run.learning.evaluated === 1 ? 'decision' : 'decisions' }} evaluated</small>
      </template>
      <p v-else>{{ run.status === 'running' ? 'Learning is in progress. Its outcome has not been verified.' : 'No verified learning receipt is available for this run. Execution status alone does not confirm learning.' }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AutomationConversation } from '../composables/useAutomationConversation.ts'
import { learningOutcomeLabel, type AutomationRunSummary } from '../automations.ts'

const props = defineProps<{ conversation: AutomationConversation }>()
const automation = computed(() => props.conversation.automation.value)
const run = computed(() => props.conversation.run.value)
const statusLabel = (status: AutomationRunSummary['status']) => ({
  running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', unknown: 'Status unknown',
})[status]
const started = (value: string) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
</script>

<style scoped>
.automation-context { flex: 0 0 auto; max-height: 30%; overflow: auto; padding: 0 16px; font-size: 13px; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.automation-note { margin: 8px 0; }
.automation-note p { margin: 0 0 8px; }
.automation-info summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 36px; cursor: pointer; }
.automation-info summary::before { content: '›'; }
.automation-info[open] summary::before { transform: rotate(90deg); }
.automation-info summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.run-time { margin-inline-start: auto; font-size: 12px; font-variant-numeric: tabular-nums; }
.automation-info-body { padding: 4px 0 12px; }
.automation-info-body dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 16px; margin: 0; }
.automation-info-body dd { margin: 0; color: var(--c-text); white-space: pre-wrap; }
.learning-outcome { padding: 8px 0 12px; color: var(--c-text); }
.learning-outcome p { margin: 4px 0; white-space: pre-wrap; }
.learning-outcome small { color: var(--c-text-secondary); }
@media (max-width: 700px), (pointer: coarse) { .automation-info summary { min-height: 44px; } }
</style>
