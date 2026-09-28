<template>
  <article class="execution-card" :data-execution-id="execution.sessionId" :data-execution-mode="execution.mode">
    <button class="execution-inspect trace-header" :disabled="!execution.sessionId" :aria-pressed="execution.sessionId ? !!selected : undefined"
      :aria-label="`Inspect ${execution.mode}: ${execution.label}`" @click="inspect">
      <span class="execution-icon i-lucide-git-branch" aria-hidden="true" />
      <span class="execution-copy"><strong>{{ execution.label }}</strong><span>{{ execution.mode === 'call' ? 'Call · inherited context · blocking' : 'Task · fresh context · async' }}<template v-if="execution.agentType"> · {{ execution.agentType }}</template></span></span>
      <span v-if="execution.blocked" class="execution-blocked">Blocked</span>
      <SessionActivity v-else :stage="execution.stage" />
      <span v-if="execution.sessionId" class="i-lucide-chevron-right execution-icon" aria-hidden="true" />
    </button>
    <div class="execution-trace">
      <div v-if="execution.output || execution.partialWork" class="execution-output trace-guide"><slot /><p v-if="execution.partialWork" class="execution-partial">{{ execution.partialWork }}</p></div>
      <details class="execution-details">
        <summary class="trace-header" @click="$emit('interact')"><span class="trace-chevron i-lucide-chevron-right" aria-hidden="true" />Tool details</summary>
        <div class="trace-guide">
          <pre>{{ execution.arguments }}</pre>
          <pre v-if="execution.receipt !== undefined">{{ execution.receipt || '(Empty result)' }}</pre>
        </div>
      </details>
    </div>
  </article>
</template>

<script setup lang="ts">
import type { InlineExecution } from '../execution-messages.ts'
import SessionActivity from './SessionActivity.vue'
const props = defineProps<{ execution: InlineExecution; selected?: boolean }>()
const emit = defineEmits<{ inspect: [id: string]; interact: [] }>()
function inspect() {
  if (props.execution.sessionId) emit('inspect', props.execution.sessionId)
}
</script>

<style scoped>
.execution-card { min-width: 0; }
.execution-inspect { width: 100%; border: 0; background: transparent; color: var(--c-text); font: inherit; text-align: left; cursor: pointer; }
.execution-inspect:hover:not(:disabled) { background: var(--c-bg-muted); }
.execution-inspect[aria-pressed="true"] { background: var(--c-bg-muted); }
.execution-inspect:disabled { cursor: default; }
.execution-inspect:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.execution-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.execution-copy strong { overflow-wrap: anywhere; font-size: 13px; font-weight: 500; }
.execution-copy > span { color: var(--c-text-secondary); font-size: 12px; overflow-wrap: anywhere; }
.execution-icon { flex: 0 0 16px; width: 16px; height: 16px; color: var(--c-text-secondary); }
.execution-output { min-width: 0; overflow-wrap: anywhere; }
.execution-partial { white-space: pre-wrap; font-size: 12px; color: var(--c-text-secondary); }
.execution-blocked { color: var(--c-error); font-size: 12px; }
.execution-details { font-size: 12px; color: var(--c-text-secondary); }
.execution-details summary { cursor: pointer; }
.execution-details summary:hover { color: var(--c-text); }
.execution-details pre { max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
@media (max-width: 700px) { .execution-inspect { flex-wrap: wrap; } .execution-copy { flex-basis: calc(100% - 40px); } }
</style>
