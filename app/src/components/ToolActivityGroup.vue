<template>
  <details v-disclosure-motion class="tool-group tool-activity" :open="groupOpen" @toggle.self="groupOpen = isOpen($event)">
    <summary class="tool-activity-summary trace-header" :title="summaryTitle" @click="emit('interact')">
      <span class="activity-chevron i-lucide-chevron-right" aria-hidden="true" />
      <span v-if="batch.files" class="activity-icon i-lucide-file-diff" aria-hidden="true" />
      <span class="activity-title">{{ summaryTitle }}</span>
      <LineChangeCounts v-if="batch.changes" :changes="batch.changes" :partial="batch.incomplete" />
      <span v-else-if="batch.files" class="activity-status">{{ t('Line counts unavailable') }}</span>
      <span v-if="running" class="activity-status">{{ t('Running') }}</span>
    </summary>
    <div class="activity-list trace-guide">
      <details v-for="entry in batch.entries" :key="entry.index" v-disclosure-motion class="tool-entry" @toggle.self="setExpanded(entry.index, $event)">
        <summary class="tool-call-header" :title="entry.summary || entry.title" @click="emit('interact')">
          <span class="tool-disclosure-icon" aria-hidden="true">
            <span class="tool-icon activity-icon" :class="entry.path ? (matchedFileIcon(entry.path) ?? icons[entry.icon]) : icons[entry.icon]" />
            <span class="activity-chevron i-lucide-chevron-right" />
          </span>
          <span class="tool-name">{{ entry.title }}</span>
          <LineChangeCounts v-if="entry.changes" :changes="entry.changes" />
          <span v-else-if="entry.failed" class="activity-failed">{{ t('Failed') }}</span>
          <span v-else-if="entry.file" class="activity-status">{{ t('Counts unavailable') }}</span>
          <span v-if="entry.summary && !entry.file" class="tool-args-summary">{{ entry.summary }}</span>
        </summary>
        <div v-if="groupOpen && expanded.has(entry.index)" class="tool-entry-content">
          <ToolFileDiffPreview v-if="entry.file && entry.toolCallId && apiBase !== undefined && sessionId"
            :api-base="apiBase" :session-id="sessionId" :tool-call-id="entry.toolCallId" :path="entry.path" />
          <p v-else-if="entry.file" class="activity-status">{{ t('No historical file diff is available for this tool call.') }}</p>
          <component :is="entry.file ? 'details' : 'div'" v-disclosure-motion class="tool-entry-details">
            <summary v-if="entry.file" class="tool-details-header"><span class="activity-chevron i-lucide-chevron-right" aria-hidden="true" />{{ t('Details') }}</summary>
            <div v-if="entry.arguments" class="tool-arguments">
              <span class="activity-detail-label">{{ t('Arguments') }}</span>
              <ToolPayload boxed class="tool-call-detail" :source="entry.arguments" />
            </div>
            <details v-if="entry.result !== undefined" v-disclosure-motion class="tool-result" :open="!closedResults.has(entry.index)" @toggle.self="setResultExpanded(entry.index, $event)">
              <summary class="tool-result-header"><span class="activity-chevron i-lucide-chevron-right" aria-hidden="true" />{{ t('Result') }}</summary>
              <ToolPayload v-if="!closedResults.has(entry.index)" boxed class="tool-result-content" :source="entry.result || t('(Empty result)')" :images="entry.images" :file-path="entry.readPath" :line-numbers="entry.lineNumbers" :search-result="entry.grep" />
            </details>
            <p v-if="entry.usage" class="activity-usage">{{ t('{prompt} prompt · {completion} completion · {total} total tokens', { prompt: formatNumber(entry.usage.promptTokens), completion: formatNumber(entry.usage.completionTokens), total: formatNumber(entry.usage.totalTokens) }) }}</p>
            <p v-if="entry.result === undefined" class="activity-status">{{ running ? t('Waiting for result…') : t('No result recorded') }}</p>
          </component>
        </div>
      </details>
    </div>
  </details>
</template>

<script setup lang="ts">
import { t, formatNumber } from '../i18n.ts'
import { computed, reactive, ref, watch } from 'vue'
import type { ToolActivity, ToolActivityBatch } from '../tool-activity.ts'
import { matchedFileIcon } from '../file-icons.ts'
import { vDisclosureMotion } from '../disclosure-motion.ts'
import LineChangeCounts from './LineChangeCounts.vue'
import ToolPayload from './ToolPayload.vue'
import ToolFileDiffPreview from './ToolFileDiffPreview.vue'
const props = defineProps<{ batch: ToolActivityBatch; defaultOpen?: boolean; running?: boolean; apiBase?: string; sessionId?: string }>()
const emit = defineEmits<{ interact: [] }>()
const summaryTitle = computed(() => {
  const { entries, files } = props.batch
  const title = files ? t('{count} files edited', { count: files }, files) : entries[0].title
  const others = files ? entries.filter(entry => !entry.file).length : entries.length - 1
  return others ? t('{title} and {count} other tool calls', { title, count: others }, others) : title
})
const groupOpen = ref(!!props.defaultOpen)
// Preserve manual toggles while the group remains at the same conversation position.
watch(() => props.defaultOpen, open => { groupOpen.value = !!open })
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
.tool-activity-summary, .tool-call-header { display: flex; align-items: center; gap: 8px; line-height: 20px; }
.tool-call-header { min-height: 32px; }
.tool-activity-summary { padding: 4px 8px; }
.activity-title, .tool-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-title { flex: 0 1 auto; }
.activity-chevron { display: block; flex: 0 0 16px; width: 16px; height: 16px; transition: transform 200ms cubic-bezier(.22, 1, .36, 1); }
details[data-expanded="true"] > summary > .activity-chevron { transform: rotate(90deg); }
.tool-disclosure-icon { position: relative; flex: 0 0 16px; width: 16px; height: 16px; }
.tool-disclosure-icon > span { position: absolute; inset: 0; pointer-events: none; }
.tool-disclosure-icon > .tool-icon { transition: opacity 140ms ease-out; }
.tool-disclosure-icon > .activity-chevron { opacity: 0; transition: opacity 140ms ease-out, transform 200ms cubic-bezier(.22, 1, .36, 1); }
.tool-call-header:is(:hover, :focus-visible) > .tool-disclosure-icon > .tool-icon,
.tool-entry[data-expanded="true"] > summary > .tool-disclosure-icon > .tool-icon { opacity: 0; }
.tool-call-header:is(:hover, :focus-visible) > .tool-disclosure-icon > .activity-chevron,
.tool-entry[data-expanded="true"] > summary > .tool-disclosure-icon > .activity-chevron { opacity: 1; }
.tool-entry[data-expanded="true"] > summary > .tool-disclosure-icon > .activity-chevron { transform: rotate(90deg); }
.activity-list { margin-bottom: 8px; }
.tool-call-header { padding: 4px; border-radius: var(--radius-control); }
.tool-call-header:hover, summary:focus-visible { background: var(--c-bg-muted); color: var(--c-text); }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.tool-activity-summary:hover { color: var(--c-text); }
.activity-icon { display: block; flex: 0 0 16px; width: 16px; height: 16px; }
.tool-args-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 12px; color: var(--c-text-muted); }
.tool-name { flex: 0 1 auto; }
.activity-status, .activity-usage { color: var(--c-text-muted); font-size: 12px; }
.activity-status { flex-shrink: 0; }
.activity-failed { flex-shrink: 0; color: var(--c-error); font-size: 12px; }
.tool-entry-content { padding: 4px 8px 12px 28px; }
.tool-details-header { width: fit-content; padding: 4px 0; font-size: 12px; color: var(--c-text-muted); }
.tool-details-header, .tool-result-header { display: flex; align-items: center; gap: 4px; }
.activity-detail-label, .tool-result-header { color: var(--c-text-secondary); font-size: 12px; line-height: 24px; }
@container (max-width: 480px) {
  .tool-activity-summary { flex-wrap: wrap; column-gap: 6px; row-gap: 0; }
  .activity-title { flex: 1; }
  .tool-entry-content { padding-left: 8px; }
  .tool-args-summary { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .activity-chevron, .tool-disclosure-icon > .tool-icon, .tool-disclosure-icon > .activity-chevron { transition: none; }
}
</style>
