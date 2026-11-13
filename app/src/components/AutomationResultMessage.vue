<template>
  <MessagePreviewCard class="automation-result-message" :label="t('Execution result')" :collapsible="false"
    :data-result-key="result.key" :data-result-source="result.source" role="article" :aria-label="t('Execution result')">
    <template #heading>
      <strong :class="statusClass">{{ result.run.learning ? learningOutcomeLabel(result.run.learning) : statusLabel }}</strong>
      <span>{{ t('Execution result') }}</span>
      <MessageTimestamp :timestamp="result.timestamp" />
    </template>
    <p class="result-source">{{ result.source === 'metadata' ? t('Source: saved run metadata') : t('Source: final execution response') }}</p>
    <MarkdownContent v-if="result.summary" class="chat-content prose" :text="result.summary" :render-content="renderContent" />
    <p v-if="result.run.learning" class="result-source">{{ t('Execution:') }} {{ statusLabel }} · {{ t(result.run.learning.status === 'applied' ? '{count} verified artifacts' : '{count} recorded artifacts', { count: result.run.learning.artifacts }, result.run.learning.artifacts) }} · {{ t('{count} logs', { count: result.run.learning.events }, result.run.learning.events) }} · {{ t('{count} decisions evaluated', { count: result.run.learning.evaluated }, result.run.learning.evaluated) }}</p>
    <div v-if="result.summary" class="result-actions"><MessageCopyActions :text="result.summary" :render-content="renderContent" /></div>
  </MessagePreviewCard>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import { learningOutcomeLabel } from '../automations.ts'
import type { AutomationResult } from '../automation-result.ts'
import MessagePreviewCard from './MessagePreviewCard.vue'
import MessageTimestamp from './MessageTimestamp.vue'
import MessageCopyActions from './MessageCopyActions.vue'
import MarkdownContent from './MarkdownContent.vue'
const props = defineProps<{ result: AutomationResult; renderContent: (text: string) => string }>()
const statusLabel = computed(() => ({ running: t('Running'), completed: t('Completed'), failed: t('Failed'), cancelled: t('Cancelled'), unknown: t('Status unknown') })[props.result.run.status])
const statusClass = computed(() => props.result.run.learning?.status === 'partial' ? 'partial'
  : props.result.run.status === 'failed' || props.result.run.learning?.status === 'blocked' ? 'failed'
  : props.result.run.status === 'completed' ? 'completed' : '')
</script>
<style scoped>
.automation-result-message { max-width: var(--conversation-item-max-width); overflow-wrap: anywhere; }
.result-source { color: var(--c-text-secondary); font-size: 12px; margin: 4px 0 8px; }
.result-actions { display: flex; justify-content: flex-end; }
.partial { color: var(--c-warn); }
.failed { color: var(--c-error); }
.completed { color: var(--c-success); }
</style>
