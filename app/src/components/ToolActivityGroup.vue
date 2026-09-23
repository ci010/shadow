<template>
  <details class="tool-group tool-activity" @toggle.self="groupOpen = isOpen($event)">
    <summary class="tool-activity-summary" @click="emit('interact')">
      <span class="activity-chevron i-lucide-chevron-right" aria-hidden="true" />
      <span class="activity-title">{{ batch.entries[0].title }}<span v-if="batch.entries.length > 1"> and {{ batch.entries.length - 1 }} other tool {{ batch.entries.length === 2 ? 'call' : 'calls' }}</span></span>
      <LineChangeCounts v-if="batch.changes" :changes="batch.changes" :partial="batch.incomplete" />
      <span v-if="batch.entries.some(entry => entry.failed)" class="activity-failed">Failed</span>
      <span v-if="running" class="activity-status">Running</span>
    </summary>
    <div class="activity-list">
      <div v-if="batch.files" class="activity-files">
        <span class="activity-icon i-lucide-file-diff" aria-hidden="true" />
        <span>{{ batch.files }} {{ batch.files === 1 ? 'file' : 'files' }} edited</span>
        <LineChangeCounts v-if="batch.changes" :changes="batch.changes" :partial="batch.incomplete" />
        <span v-else class="activity-status">Line counts unavailable</span>
      </div>
      <details v-for="entry in batch.entries" :key="entry.index" class="tool-entry" @toggle.self="setExpanded(entry.index, $event)">
        <summary class="tool-call-header" :title="entry.summary || entry.title" @click="emit('interact')">
          <span class="tool-icon activity-icon" :class="icons[entry.icon]" aria-hidden="true" />
          <span class="tool-name">{{ entry.title }}</span>
          <LineChangeCounts v-if="entry.changes" :changes="entry.changes" />
          <span v-else-if="entry.failed" class="activity-failed">Failed</span>
          <span v-else-if="entry.file" class="activity-status">Counts unavailable</span>
          <span v-if="entry.summary && !entry.file" class="tool-args-summary">{{ entry.summary }}</span>
        </summary>
        <div v-if="groupOpen && expanded.has(entry.index)" class="tool-entry-content">
          <div v-if="entry.arguments" class="tool-arguments">
            <span class="activity-detail-label">Arguments</span>
            <ToolPayload class="tool-call-detail" :source="entry.arguments" />
          </div>
          <details v-if="entry.result !== undefined" class="tool-result" :open="!closedResults.has(entry.index)" @toggle.self="setResultExpanded(entry.index, $event)">
            <summary class="tool-result-header">Result</summary>
            <ToolPayload v-if="!closedResults.has(entry.index)" class="tool-result-content" :source="entry.result || '(Empty result)'" :images="entry.images" />
          </details>
          <p v-if="entry.usage" class="activity-usage">{{ entry.usage.promptTokens.toLocaleString() }} prompt · {{ entry.usage.completionTokens.toLocaleString() }} completion · {{ entry.usage.totalTokens.toLocaleString() }} total tokens</p>
          <p v-if="entry.result === undefined" class="activity-status">{{ running ? 'Waiting for result…' : 'No result recorded' }}</p>
        </div>
      </details>
    </div>
  </details>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { ToolActivity, ToolActivityBatch } from '../tool-activity.ts'
import LineChangeCounts from './LineChangeCounts.vue'
import ToolPayload from './ToolPayload.vue'
defineProps<{ batch: ToolActivityBatch; running?: boolean }>()
const emit = defineEmits<{ interact: [] }>()
const groupOpen = ref(false)
const expanded = reactive(new Set<number>())
const closedResults = reactive(new Set<number>())
function isOpen(event: Event): boolean {
  return event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open
}
function setExpanded(index: number, event: Event): void {
  if (isOpen(event)) expanded.add(index)
  else expanded.delete(index)
}
function setResultExpanded(index: number, event: Event): void {
  if (isOpen(event)) closedResults.delete(index)
  else closedResults.add(index)
}
const icons: Record<ToolActivity['icon'], string> = {
  write: 'i-lucide-file-pen-line',
  read: 'i-lucide-file',
  search: 'i-lucide-search',
  exec: 'i-lucide-terminal',
  tool: 'i-lucide-wrench',
}
</script>

<style scoped>
.tool-activity { container-type: inline-size; width: 100%; min-width: 0; border-radius: var(--radius-surface); color: var(--c-text-secondary); font-size: 13px; }
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
.tool-activity-summary, .tool-call-header, .activity-files { display: flex; align-items: center; min-height: 32px; gap: 8px; line-height: 20px; }
.tool-activity-summary { padding: 4px 0; }
.activity-title, .tool-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-title { flex: 0 1 auto; }
.activity-chevron { display: block; flex: 0 0 16px; width: 16px; height: 16px; }
.tool-activity[open] > summary .activity-chevron { transform: rotate(90deg); }
.activity-list { margin: 0 0 8px 7px; padding-left: 16px; border-left: 1px solid var(--c-border); }
.tool-call-header { padding: 4px; border-radius: var(--radius-control); }
.tool-call-header:hover, summary:focus-visible { background: var(--c-bg-muted); color: var(--c-text); }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.tool-activity-summary:hover { color: var(--c-text); }
.activity-icon { display: block; flex: 0 0 16px; width: 16px; height: 16px; }
.activity-files { padding: 4px; }
.tool-args-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 12px; color: var(--c-text-muted); }
.tool-name { flex: 0 1 auto; }
.activity-status, .activity-usage { color: var(--c-text-muted); font-size: 12px; }
.activity-status { flex-shrink: 0; }
.activity-failed { flex-shrink: 0; color: var(--c-error); font-size: 12px; }
.tool-entry-content { padding: 4px 8px 12px 28px; }
.activity-detail-label, .tool-result-header { color: var(--c-text-secondary); font-size: 12px; line-height: 24px; }
.tool-call-detail, .tool-result-content { margin: 4px 0 8px; padding: 10px 12px; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 'IBM Plex Mono', ui-monospace, monospace; background: var(--c-bg-muted); border-radius: var(--radius-control); color: var(--c-text-secondary); }
@container (max-width: 480px) {
  .tool-activity-summary { flex-wrap: wrap; column-gap: 6px; row-gap: 0; }
  .activity-title { flex: 1; }
  .tool-entry-content { padding-left: 8px; }
  .tool-args-summary { display: none; }
}
</style>
