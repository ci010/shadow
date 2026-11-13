<template>
  <section class="workflow-automation-profile" :aria-label="t('Automation statistics')">
    <AutomationProfile v-if="automation && !catalog.error.value" :key="automation.id" :api-base="apiBase" :feature-id="automation.id" :active="active" />
    <template v-else>
      <header><strong>{{ t('Rolling 24h') }}</strong><button class="btn btn-sm" :disabled="!active || catalog.loading.value" @click="catalog.refresh">{{ t('Retry') }}</button></header>
      <p v-if="catalog.error.value" role="alert">{{ catalog.error.value }}</p>
      <p v-else role="status">{{ t(catalog.loading.value ? 'Loading metrics…' : 'No uniquely linked automation statistics are available for this workflow.') }}</p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import { useAutomationCatalog } from '../composables/useAutomationCatalog.ts'
import { workflowAutomation } from '../workflow-automation.ts'
import AutomationProfile from './AutomationProfile.vue'
const props = defineProps<{ apiBase: string; workflowId: string; active: boolean }>()
const catalog = useAutomationCatalog(() => props.apiBase, () => props.active)
const automation = computed(() => workflowAutomation(catalog.jobs.value, props.workflowId))
</script>
<style scoped>
.workflow-automation-profile { margin-top: 20px; padding-block: 16px; border-block: 1px solid var(--c-border-soft); min-width: 0; font-size: 12px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; } strong { font-weight: 500; }
p { color: var(--c-text-secondary); line-height: 1.6; overflow-wrap: anywhere; }
.workflow-automation-profile :deep(.automation-profile) { padding: 0; max-height: none; overflow: visible; }
.workflow-automation-profile :deep(.profile-metrics) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
</style>
