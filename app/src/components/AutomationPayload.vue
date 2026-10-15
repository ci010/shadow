<template>
  <section class="automation-presentation">
    <MessagePreviewCard v-if="fields.length" :label="t(input ? 'Execution input' : 'Execution output')" :collapsible="input || fields.length > 4 || fields.some(field => field.text.length > 600)">
      <template #heading><span>{{ t(input ? 'Execution input' : 'Execution output') }}</span></template>
      <dl>
        <template v-for="(field, index) in fields" :key="index"><dt>{{ t(field.label) }}</dt><dd>{{ field.textKey ? t(field.textKey) : field.text }}</dd></template>
      </dl>
    </MessagePreviewCard>
    <p v-else-if="isReadableSystemAutomation(automationId)" class="automation-empty">{{ t(input ? 'Bounded evidence supplied for this run' : 'No readable outcome available yet') }}</p>
    <details class="automation-payload" @toggle="open = ($event.target as HTMLDetailsElement).open">
      <summary><span class="i-lucide-chevron-right" aria-hidden="true" />{{ t('Technical details') }}</summary>
      <ToolPayload v-if="open" :source="source" boxed />
    </details>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n.ts'
import { automationPresentation, isReadableSystemAutomation } from '../automation-presentation.ts'
import MessagePreviewCard from './MessagePreviewCard.vue'
import ToolPayload from './ToolPayload.vue'
const props = defineProps<{ source: string; input: boolean; automationId?: string }>()
const fields = computed(() => automationPresentation(props.source, props.input, props.automationId))
const open = ref(false)
</script>
<style scoped>
.automation-presentation { min-width: 0; overflow-wrap: anywhere; }
/* Reuse the conversation disclosure, with its surface supplied by the owning chat bubble. */
.automation-presentation :deep(.message-preview-card) { padding: 0; border: 0; border-radius: 0; background: transparent; color: inherit; }
.automation-presentation :deep(.message-preview-body::after) { background: linear-gradient(to bottom, transparent, var(--automation-bubble-bg, var(--c-chat-action-bg))); }
.automation-presentation :deep(.message-preview-body) { color: inherit; }
dl { margin: 0; font: inherit; }
dt { color: var(--c-text-secondary); font-size: 12px; margin-top: 8px; }
dt:first-child { margin-top: 0; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.automation-empty { margin: 0; color: var(--c-text-secondary); }
.automation-payload { min-width: 0; font-size: 12px; color: var(--c-text-secondary); }
summary { display: flex; align-items: center; gap: 8px; min-height: 40px; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary > span { width: 14px; height: 14px; flex: 0 0 14px; }
details[open] summary > span { transform: rotate(90deg); }
summary:hover { color: var(--c-text); }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
@media (max-width: 700px), (pointer: coarse) { summary { min-height: 44px; } }
</style>
