<template>
  <section class="automation-presentation">
    <h3 v-if="fields.length">{{ t(input ? 'Execution input' : 'Execution output') }}</h3>
    <dl v-if="fields.length">
      <template v-for="(field, index) in fields" :key="index"><dt>{{ t(field.label) }}</dt><dd>{{ field.textKey ? t(field.textKey) : field.text }}</dd></template>
    </dl>
    <p v-else-if="isReadableSystemAutomation(automationId)" class="automation-empty">{{ t(input ? 'Bounded evidence supplied for this run' : 'No readable outcome available yet') }}</p>
    <details class="automation-payload" @toggle="open = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t(input ? 'Execution input' : 'Execution output') }} <span>{{ t('Technical details') }}</span></summary>
      <ToolPayload v-if="open" :source="source" boxed />
    </details>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n.ts'
import { automationPresentation, isReadableSystemAutomation } from '../automation-presentation.ts'
import ToolPayload from './ToolPayload.vue'
const props = defineProps<{ source: string; input: boolean; automationId?: string }>()
const fields = computed(() => automationPresentation(props.source, props.input, props.automationId))
const open = ref(false)
</script>
<style scoped>
.automation-presentation { min-width: 0; max-width: var(--conversation-item-max-width, 100%); }
h3 { font-size: 13px; font-weight: 500; margin: 8px 0; }
dl { margin: 0; font-size: 13px; line-height: 1.6; }
dt { color: var(--c-text-secondary); font-size: 12px; margin-top: 8px; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--c-text-body); }
.automation-empty { font-size: 13px; color: var(--c-text-secondary); }
.automation-payload { width: 100%; min-width: 0; font-size: 12px; color: var(--c-text-secondary); }
summary { display: flex; align-items: center; gap: 8px; min-height: 40px; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; } summary::before { content: '›'; } details[open] summary::before { transform: rotate(90deg); }
summary span { margin-inline-start: auto; } summary:hover { color: var(--c-text); } summary:focus-visible { outline: 2px solid var(--c-blue); }
@media (max-width: 700px), (pointer: coarse) { summary { min-height: 44px; } }
</style>
