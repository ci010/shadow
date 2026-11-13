<template>
  <aside class="automation-projection" :aria-label="t('Automation history')">
    <p>{{ t('Automation is a time signal → fresh Agent preset. Configure workflows in chat; this page shows conversation history only.') }}</p>
    <a v-if="workflowPath" :href="workflowPath">{{ t('Open Workflow') }}</a>
  </aside>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import type { AutomationSummary } from '../automations.ts'
import { automationWorkflowId } from '../workflow-automation.ts'
const props = defineProps<{ apiBase: string; job: AutomationSummary; active: boolean }>()
const projectId = computed(() => /\/projects\/([^/?#]+)/.exec(props.apiBase)?.[1])
const workflowPath = computed(() => projectId.value ? `/projects/${projectId.value}/workflows${workflowId.value ? `?workflow=${encodeURIComponent(workflowId.value)}` : ''}` : undefined)
const workflowId = computed(() => automationWorkflowId(props.job))
</script>
<style scoped>
.automation-projection { flex: 0 0 auto; min-width: 0; margin: 12px auto 16px; padding: 12px; width: calc(100% - 40px); max-width: var(--conversation-max-width); box-sizing: border-box; border-top: 1px solid var(--c-border-soft); font-size: 12px; color: var(--c-text-secondary); overflow-wrap: anywhere; }
p { margin: 0 0 8px; max-width: 70ch; }
a { color: var(--c-blue); text-underline-offset: 3px; }
a:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 3px; }
@media (max-width: 700px) { .automation-projection { width: calc(100% - 24px); } }
</style>
