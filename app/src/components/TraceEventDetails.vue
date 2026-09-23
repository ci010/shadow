<template>
  <div class="trace-event-content">
    <dl v-if="event.sessionSource" class="message-source">
      <dt>Source</dt><dd>Another session</dd>
      <dt>Session</dt><dd>{{ event.sessionSource.id || 'Not recorded' }}</dd>
      <template v-if="event.sessionSource.name"><dt>Name</dt><dd>{{ event.sessionSource.name }}</dd></template>
      <template v-if="event.sessionSource.intent"><dt>Intent</dt><dd>{{ event.sessionSource.intent }}</dd></template>
      <dt>Model role</dt><dd>user (protocol role, not a human author)</dd>
    </dl>
    <template v-if="event.toolCall"><h4>Tool call JSON</h4><pre>{{ event.toolCall }}</pre></template>
    <template v-if="event.arguments !== undefined">
      <h4>Arguments</h4><ToolPayload class="trace-payload" :source="prettyArguments(event.arguments)" />
      <h4>Result</h4><ToolPayload v-if="event.result !== undefined" class="trace-payload" :source="event.result" :images="event.images" />
      <p v-else class="missing-detail">No result recorded yet.</p>
    </template>
    <template v-else><h4>Content</h4><ToolPayload class="trace-payload" :source="event.content || 'No text content recorded.'" :images="event.images" /></template>
    <details v-if="event.rawContent !== undefined"><summary>Raw content with source metadata</summary><pre>{{ event.rawContent }}</pre></details>
    <template v-if="event.toolCalls"><h4>Returned tool calls</h4><pre>{{ event.toolCalls }}</pre></template>
    <details v-if="event.reasoning"><summary>Reasoning</summary><pre>{{ event.reasoning }}</pre></details>
    <details v-if="event.usage"><summary>Token usage</summary><pre>{{ event.usage }}</pre></details>
  </div>
</template>

<script setup lang="ts">
import { detailText, type DiagnosisEvent } from '../session-diagnosis.ts'
import ToolPayload from './ToolPayload.vue'

defineProps<{ event: DiagnosisEvent }>()

function prettyArguments(value: string): string {
  try { return detailText(JSON.parse(value)) } catch { return value }
}
</script>

<style scoped>
h4, summary { margin: 0; font-size: 11px; font-weight: 500; color: var(--c-text-secondary); }
summary { cursor: pointer; padding: 8px 0; }
pre, .trace-payload { margin: 8px 0 12px; padding: 12px; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--c-bg-card); border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text-secondary); font: 11px/1.65 ui-monospace, monospace; }
.missing-detail { margin: 8px 0; color: var(--c-text-secondary); font-size: 12px; }
.message-source { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; font-size: 12px; color: var(--c-text-secondary); }
.message-source dd { margin: 0; overflow-wrap: anywhere; color: var(--c-text); }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
