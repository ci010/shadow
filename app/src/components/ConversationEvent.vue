<template>
  <details class="system-event" :class="{ 'event-failed': presentation.failed }" :open="presentation.completion" :data-event-id="meta.attrs['event-id']">
    <summary class="event-header" @click="$emit('interact')">
      <span class="event-icon" :class="presentation.completion ? 'i-lucide-git-pull-request' : 'i-lucide-radio'" aria-hidden="true" />
      <strong>{{ presentation.title }}</strong>
      <span class="event-source">{{ source?.label || meta.source }}</span>
      <MessageTimestamp :timestamp="timestamp" />
    </summary>
    <div class="event-body">
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
const props = defineProps<{ meta: ChatEventMeta; timestamp?: string; source?: SidebarSession }>()
defineEmits<{ inspect: [id: string]; interact: [] }>()
const presentation = computed(() => eventPresentation(props.meta))
</script>

<style scoped>
.system-event { margin: 16px 0; min-width: 0; border-top: 1px solid var(--c-border); color: var(--c-text-secondary); }
.event-header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 38px; padding: 6px 0; cursor: pointer; list-style: none; }
.event-header::-webkit-details-marker { display: none; }
.event-header strong { font-size: 12px; font-weight: 500; }
.event-icon { display: inline-block; flex: 0 0 14px; width: 14px; height: 14px; }
.event-source { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.event-body { min-width: 0; padding: 0 0 8px 22px; color: var(--c-text); overflow-wrap: anywhere; }
.event-inspect { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--c-text-secondary); padding: 6px 0; font: inherit; font-size: 12px; cursor: pointer; }
.event-inspect:hover, summary:hover { color: var(--c-text); }
summary:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.event-metadata { margin-top: 6px; color: var(--c-text-secondary); font-size: 12px; }
.event-metadata summary { cursor: pointer; }
.event-metadata dl { display: grid; grid-template-columns: minmax(80px, auto) minmax(0, 1fr); gap: 4px 12px; }
.event-metadata dd { margin: 0; overflow-wrap: anywhere; }
.event-failed .event-header { color: var(--c-error); }
@media (max-width: 700px) { .event-body { padding-left: 0; } .event-source { flex-basis: 45%; } }
</style>
