<template>
  <div class="trace-event-content">
    <template v-if="event.toolCall"><h4>Tool call JSON</h4><pre>{{ event.toolCall }}</pre></template>
    <template v-if="event.arguments !== undefined">
      <h4>Arguments</h4><pre>{{ prettyArguments(event.arguments) }}</pre>
      <h4>Result</h4><pre v-if="event.result !== undefined">{{ event.result }}</pre>
      <p v-else class="missing-detail">No result recorded yet.</p>
    </template>
    <template v-else><h4>Content</h4><pre>{{ event.content || 'No text content recorded.' }}</pre></template>
    <template v-if="event.toolCalls"><h4>Returned tool calls</h4><pre>{{ event.toolCalls }}</pre></template>
    <details v-if="event.reasoning"><summary>Reasoning</summary><pre>{{ event.reasoning }}</pre></details>
    <details v-if="event.usage"><summary>Token usage</summary><pre>{{ event.usage }}</pre></details>
  </div>
</template>

<script setup lang="ts">
import { detailText, type DiagnosisEvent } from '../session-diagnosis.ts'

defineProps<{ event: DiagnosisEvent }>()

function prettyArguments(value: string): string {
  try { return detailText(JSON.parse(value)) } catch { return value }
}
</script>

<style scoped>
h4, summary { margin: 0; font-size: 11px; font-weight: 500; color: var(--c-text-secondary); }
summary { cursor: pointer; padding: 8px 0; }
pre { margin: 8px 0 12px; padding: 12px; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--c-bg-card); border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text-secondary); font: 11px/1.65 ui-monospace, monospace; }
.missing-detail { margin: 8px 0; color: var(--c-text-secondary); font-size: 12px; }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
