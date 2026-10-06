<template>
  <article v-if="source && !isCurrentSource && presentation.completion" class="system-event" :class="eventClasses" :data-event-id="meta.attrs['event-id']">
    <button type="button" class="event-inspect-header event-header" :aria-pressed="!!selected"
      :aria-label="`Inspect execution: ${source.label || source.sessionId}`" @click="$emit('inspect', source.sessionId)">
      <span class="event-symbol event-icon i-lucide-git-branch" aria-hidden="true" />
      <span class="event-copy">
        <strong>{{ presentation.title }}</strong>
        <span class="event-source" :title="source.label || meta.source">{{ source.label || meta.source }}</span>
      </span>
      <MessageTimestamp :timestamp="timestamp" />
      <span class="event-icon i-lucide-chevron-right" aria-hidden="true" />
    </button>
    <details class="event-details">
      <summary class="event-disclosure" @click="$emit('interact')"><span class="trace-chevron i-lucide-chevron-right" aria-hidden="true" />Event details</summary>
      <div class="event-body">
        <div class="event-content"><slot /></div>
        <dl class="event-fields"><template v-for="(value, key) in meta.attrs" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl>
      </div>
    </details>
  </article>
  <details v-else class="system-event" :class="eventClasses" :open="presentation.completion" :data-event-id="meta.attrs['event-id']" @toggle.self="toggle">
    <summary class="event-header" @click="$emit('interact')">
      <span class="event-symbol event-icon" :class="presentation.completion ? 'i-lucide-git-pull-request' : 'i-lucide-radio'" aria-hidden="true" />
      <span class="event-copy">
        <strong>{{ presentation.title }}</strong>
        <span class="event-source" :title="source?.label || meta.source">{{ source?.label || meta.source }}</span>
      </span>
      <MessageTimestamp :timestamp="timestamp" />
      <span class="trace-chevron i-lucide-chevron-right" aria-hidden="true" />
    </summary>
    <div class="event-body">
      <div class="event-content">
        <ToolPayload v-if="rawContent && expanded" class="event-payload" :source="rawContent" />
        <slot v-else-if="!rawContent" />
      </div>
      <button v-if="source && !isCurrentSource" type="button" class="event-inspect" @click="$emit('inspect', source.sessionId)">View {{ source.mode === 'session' ? 'conversation' : 'execution' }} <span class="i-lucide-arrow-up-right event-icon" aria-hidden="true" /></button>
    </div>
    <details class="event-metadata">
      <summary class="event-disclosure" @click="$emit('interact')"><span class="trace-chevron i-lucide-chevron-right" aria-hidden="true" />Event details</summary>
      <dl class="event-fields"><template v-for="(value, key) in meta.attrs" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl>
    </details>
  </details>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { eventPresentation, type ChatEventMeta } from '../chat-events.ts'
import type { SidebarSession } from '../folders-sidebar.ts'
import MessageTimestamp from './MessageTimestamp.vue'
import ToolPayload from './ToolPayload.vue'
const props = defineProps<{ meta: ChatEventMeta; content?: string; timestamp?: string; source?: SidebarSession; selected?: boolean; currentSessionId?: string }>()
defineEmits<{ inspect: [id: string]; interact: [] }>()
const presentation = computed(() => eventPresentation(props.meta))
const isCurrentSource = computed(() => !!props.source && props.source.sessionId === props.currentSessionId)
const eventClasses = computed(() => ({
  'event-failed': presentation.value.failed,
  'event-completed': presentation.value.completion && props.meta.type === 'subagent-complete',
  'event-selected': !!props.source && !isCurrentSource.value && presentation.value.completion && !!props.selected,
}))
const rawContent = computed(() => props.meta.type === 'work-realignment' ? props.content : undefined)
const expanded = ref(false)
function toggle(event: Event) {
  if (event.currentTarget instanceof HTMLDetailsElement) expanded.value = event.currentTarget.open
}
</script>

<style scoped>
.system-event { container: conversation-event / inline-size; width: 100%; min-width: 0; border: 1px solid var(--c-chat-border); border-radius: var(--radius-surface); background: var(--c-chat-action-bg); color: var(--c-text-secondary); font-size: 13px; line-height: 1.5; }
.event-header { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; min-height: var(--trace-row-height); padding: 12px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; list-style: none; cursor: pointer; }
.event-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.event-copy strong { color: var(--c-text); font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.event-source { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.event-icon { display: inline-block; flex: 0 0 16px; width: 16px; height: 16px; }
.event-header :deep(.message-time) { flex: 0 0 auto; margin: 0; font-size: 12px; }
.system-event[open] > .event-header { border-bottom: 1px solid var(--c-chat-border); }
.event-body { min-width: 0; padding: 12px; color: var(--c-text-body); overflow-wrap: anywhere; }
.event-content { min-width: 0; }
.event-content:empty { display: none; }
.event-payload { margin: 0; padding: 10px 12px; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 'IBM Plex Mono', ui-monospace, monospace; background: var(--c-bg-muted); border-radius: var(--radius-control); color: var(--c-text-secondary); }
.event-body :deep(.prose) { max-width: 72ch; color: inherit; font-size: 13px; line-height: 1.6; }
.event-body :deep(.prose > :first-child) { margin-top: 0; }
.event-body :deep(.prose > :last-child) { margin-bottom: 0; }
.event-body :deep(.prose :is(h1, h2, h3, h4)) { margin: 4px 0; font-size: 13px; font-weight: 500; }
.event-inspect { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; margin-top: 8px; padding: 4px 8px; border: 1px solid var(--c-border); background: transparent; color: var(--c-text); font: inherit; font-size: 12px; cursor: pointer; }
.event-content:empty + .event-inspect { margin-top: 0; }
.event-disclosure { display: flex; align-items: center; gap: 8px; min-height: var(--trace-row-height); padding: 8px 12px; list-style: none; cursor: pointer; font-size: 12px; }
.event-details, .event-metadata { border-top: 1px solid var(--c-chat-border); }
.event-details[open] > .event-disclosure { border-bottom: 1px solid var(--c-chat-border); }
[open] > :is(.event-header, .event-disclosure) > .trace-chevron { transform: rotate(90deg); }
summary::-webkit-details-marker { display: none; }
.event-header:hover, .event-disclosure:hover, .event-inspect:hover { background: var(--c-bg-muted); color: var(--c-text); }
.event-header:active, .event-disclosure:active, .event-inspect:active { background: var(--c-selection-bg); }
summary:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.event-inspect:focus-visible { outline-offset: 2px; }
.event-selected { border-color: var(--c-selection-border); }
.event-inspect-header[aria-pressed="true"] { background: var(--c-selection-bg); }
.event-inspect-header[aria-pressed="true"] .event-copy strong { color: var(--c-primary); }
.event-completed .event-symbol { color: var(--c-success); }
.event-failed .event-symbol, .event-failed .event-copy strong { color: var(--c-error); }
.event-fields { display: grid; grid-template-columns: minmax(0, 160px) minmax(0, 1fr); gap: 8px 16px; margin: 0; padding: 12px; color: var(--c-text-secondary); font-size: 12px; overflow-wrap: anywhere; }
.event-fields dt, .event-fields dd { min-width: 0; margin: 0; }
.event-fields dd { color: var(--c-text-body); white-space: pre-wrap; font: 12px/1.6 'IBM Plex Mono', ui-monospace, monospace; }
.event-body > .event-fields { margin-top: 12px; padding: 12px 0 0; border-top: 1px solid var(--c-chat-border); }
.event-fields:empty { display: none; }
@container conversation-event (max-width: 440px) {
  .event-header { gap: 8px; }
  .event-fields { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .event-fields dt:not(:first-child) { margin-top: 10px; }
}
@media (max-width: 700px), (pointer: coarse) {
  .event-header, .event-disclosure, .event-inspect { min-height: 44px; }
}
</style>
