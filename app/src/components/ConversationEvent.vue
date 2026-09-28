<template>
  <article v-if="source && presentation.completion" class="system-event" :class="{ 'event-failed': presentation.failed }" :data-event-id="meta.attrs['event-id']">
    <button type="button" class="event-inspect-header trace-header" :aria-pressed="!!selected"
      :aria-label="`Inspect execution: ${source.label || source.sessionId}`" @click="$emit('inspect', source.sessionId)">
      <span class="event-icon i-lucide-git-branch" aria-hidden="true" />
      <strong>{{ presentation.title }}</strong>
      <span class="event-source">{{ source.label || meta.source }}</span>
      <MessageTimestamp :timestamp="timestamp" />
      <span class="event-icon i-lucide-chevron-right" aria-hidden="true" />
    </button>
    <details class="event-details">
      <summary class="trace-header" @click="$emit('interact')"><span class="trace-chevron i-lucide-chevron-right" aria-hidden="true" />Event details</summary>
      <div class="event-body trace-guide">
        <slot />
        <dl><template v-for="(value, key) in meta.attrs" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl>
      </div>
    </details>
  </article>
  <details v-else class="system-event" :class="{ 'event-failed': presentation.failed }" :open="presentation.completion" :data-event-id="meta.attrs['event-id']">
    <summary class="event-header trace-header" @click="$emit('interact')">
      <span class="trace-chevron i-lucide-chevron-right" aria-hidden="true" />
      <span class="event-icon" :class="presentation.completion ? 'i-lucide-git-pull-request' : 'i-lucide-radio'" aria-hidden="true" />
      <strong>{{ presentation.title }}</strong>
      <span class="event-source">{{ source?.label || meta.source }}</span>
      <MessageTimestamp :timestamp="timestamp" />
    </summary>
    <div class="event-body trace-guide">
      <slot />
      <button v-if="source" type="button" class="event-inspect" @click="$emit('inspect', source.sessionId)">View {{ source.mode === 'session' ? 'conversation' : 'execution' }} <span class="i-lucide-arrow-up-right event-icon" aria-hidden="true" /></button>
      <details class="event-metadata">
        <summary @click="$emit('interact')">Event details</summary>
        <dl><template v-for="(value, key) in meta.attrs" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl>
      </details>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { eventPresentation, type ChatEventMeta } from '../chat-events.ts'
import type { SidebarSession } from '../folders-sidebar.ts'
import MessageTimestamp from './MessageTimestamp.vue'
const props = defineProps<{ meta: ChatEventMeta; timestamp?: string; source?: SidebarSession; selected?: boolean }>()
defineEmits<{ inspect: [id: string]; interact: [] }>()
const presentation = computed(() => eventPresentation(props.meta))
</script>

<style scoped>
.system-event { min-width: 0; color: var(--c-text-secondary); font-size: 13px; }
.event-header strong, .event-inspect-header strong { min-width: 0; font-size: 13px; font-weight: 500; }
.event-inspect-header { width: 100%; border: 0; background: transparent; color: var(--c-text-secondary); font: inherit; text-align: left; cursor: pointer; }
.event-inspect-header[aria-pressed="true"] { background: var(--c-bg-muted); }
.event-icon { display: inline-block; flex: 0 0 16px; width: 16px; height: 16px; }
.event-source { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.event-body { min-width: 0; padding-bottom: 8px; color: var(--c-text); overflow-wrap: anywhere; }
.event-body :deep(.prose) { font-size: 13px; line-height: 1.5; }
.event-body :deep(.prose > :first-child) { margin-top: 0; }
.event-body :deep(.prose > :last-child) { margin-bottom: 0; }
.event-body :deep(.prose :is(h1, h2, h3, h4)) { margin: 4px 0; font-size: 13px; font-weight: 500; }
.event-inspect { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--c-text-secondary); padding: 6px 0; font: inherit; font-size: 12px; cursor: pointer; }
.event-inspect:hover, summary:hover { color: var(--c-text); }
summary:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.event-metadata { margin-top: 6px; color: var(--c-text-secondary); font-size: 12px; }
.event-metadata summary, .event-details summary { cursor: pointer; }
.event-body dl { display: grid; grid-template-columns: minmax(80px, auto) minmax(0, 1fr); gap: 4px 12px; font-size: 12px; color: var(--c-text-secondary); }
.event-body dd { margin: 0; overflow-wrap: anywhere; }
.event-failed :is(.event-header, .event-inspect-header) strong { color: var(--c-error); }
@media (max-width: 700px) { .event-source { flex-basis: 45%; } }
</style>
