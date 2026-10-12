<template>
  <MessagePreviewCard class="execution-card" :class="{ 'execution-selected': !!execution.sessionId && selected }" :label="execution.label" :collapsible="!!(execution.output || execution.partialWork)"
    :data-execution-id="execution.sessionId" :data-execution-mode="execution.mode" @interact="emit('interact')">
    <template #heading>
      <button class="execution-inspect trace-header" :disabled="!execution.sessionId" :aria-pressed="execution.sessionId ? !!selected : undefined"
        :aria-label="t('Inspect {mode}: {label}', { mode: execution.mode, label: execution.label })" @click.stop="emit('interact'); inspect()">
        <span class="execution-icon i-lucide-git-branch" aria-hidden="true" />
        <span class="execution-copy"><strong>{{ execution.label }}</strong><span>{{ execution.mode === 'call' ? t('Call · inherited context · blocking') : t('Task · fresh context · async') }}<template v-if="execution.agentType"> · {{ execution.agentType }}</template></span></span>
        <span v-if="execution.blocked" class="execution-blocked">{{ t('Blocked') }}</span>
        <SessionActivity v-else :stage="execution.stage" />
        <span v-if="execution.sessionId" class="i-lucide-chevron-right execution-icon" aria-hidden="true" />
      </button>
    </template>
    <div v-if="execution.output || execution.partialWork" class="execution-output"><slot /><p v-if="execution.partialWork" class="execution-partial">{{ execution.partialWork }}</p></div>
    <template #details>
      <details v-disclosure-motion class="execution-details" @toggle.self="detailsOpen = ($event.currentTarget as HTMLDetailsElement).open">
        <summary class="trace-header" @click="$emit('interact')"><span class="trace-chevron i-lucide-chevron-right" aria-hidden="true" />{{ t('Tool details') }}</summary>
        <div v-if="detailsOpen" class="trace-guide">
          <span class="execution-detail-label">{{ t('Arguments') }}</span>
          <ToolPayload boxed class="execution-arguments" :source="execution.arguments" />
          <template v-if="execution.receipt !== undefined">
            <span class="execution-detail-label">{{ t('Result') }}</span>
            <ToolPayload boxed class="execution-result" :source="execution.receipt || '(Empty result)'" />
          </template>
        </div>
      </details>
    </template>
  </MessagePreviewCard>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { ref } from 'vue'
import type { InlineExecution } from '../execution-messages.ts'
import { vDisclosureMotion } from '../disclosure-motion.ts'
import SessionActivity from './SessionActivity.vue'
import ToolPayload from './ToolPayload.vue'
import MessagePreviewCard from './MessagePreviewCard.vue'
const props = defineProps<{ execution: InlineExecution; selected?: boolean }>()
const emit = defineEmits<{ inspect: [id: string]; interact: [] }>()
const detailsOpen = ref(false)
function inspect() {
  if (props.execution.sessionId) emit('inspect', props.execution.sessionId)
}
</script>

<style scoped>
.execution-card { min-width: 0; }
.execution-inspect { flex: 1; min-width: 0; padding: 0; border: 0; background: transparent; color: var(--c-text); font: inherit; text-align: left; cursor: pointer; }
.execution-selected { border-color: var(--c-selection-border); }
.execution-inspect:hover:not(:disabled) { background: transparent; }
.execution-inspect:hover:not(:disabled) .execution-copy strong,
.execution-inspect[aria-pressed="true"] .execution-copy strong { color: var(--c-primary); }
.execution-inspect:disabled { cursor: default; }
.execution-inspect:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.execution-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.execution-copy strong { overflow-wrap: anywhere; font-size: 13px; font-weight: 500; }
.execution-copy > span { color: var(--c-text-secondary); font-size: 12px; overflow-wrap: anywhere; }
.execution-icon { flex: 0 0 16px; width: 16px; height: 16px; color: var(--c-text-secondary); }
.execution-output { min-width: 0; padding-block: 4px 8px; overflow-wrap: anywhere; }
.execution-output :deep(.prose) { color: var(--c-text-body); font-size: 13px; line-height: 1.6; }
.execution-output :deep(.prose > :first-child) { margin-top: 0; }
.execution-output :deep(.prose > :last-child) { margin-bottom: 0; }
.execution-partial { white-space: pre-wrap; font-size: 12px; color: var(--c-text-secondary); }
.execution-blocked { color: var(--c-error); font-size: 12px; }
.execution-details { font-size: 12px; color: var(--c-text-secondary); }
.execution-details summary { padding: 8px 0; cursor: pointer; }
.execution-details summary:hover { color: var(--c-text); }
.execution-detail-label { font-size: 12px; line-height: 24px; }
.execution-details .trace-chevron { transition: transform 200ms cubic-bezier(.22, 1, .36, 1); }
.execution-details[data-expanded="false"] > summary > .trace-chevron { transform: rotate(0deg); }
@media (max-width: 700px) { .execution-inspect { flex-wrap: wrap; } .execution-copy { flex-basis: calc(100% - 40px); } }
@media (prefers-reduced-motion: reduce) { .execution-details .trace-chevron { transition: none; } }
</style>
