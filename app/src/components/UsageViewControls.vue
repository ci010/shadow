<template>
  <div class="usage-controls">
    <label v-if="showMetric">{{ t('Metric') }} <UiSelect v-model="metric" :aria-label="t('Metric')">
      <option v-for="entry in usageMetrics" :key="entry.key" :value="entry.key">{{ t(entry.label) }}</option>
    </UiSelect></label>
    <label v-if="metric === 'cost'">{{ t('Cost unit') }} <UiSelect v-model="unit" :aria-label="t('Cost unit')">
      <option v-for="currency in costUnits" :key="currency">{{ currency }}</option>
    </UiSelect></label>
    <label>{{ t('Chart view') }} <UiSelect v-model="view" :aria-label="t('Chart view')">
      <option v-for="entry in views" :key="entry" :value="entry">{{ t(labels[entry]) }}</option>
    </UiSelect></label>
  </div>
</template>
<script setup lang="ts">
import UiSelect from './UiSelect.vue'
import { t } from '../i18n.ts'
import { costUnits, type CostUnit } from '../project-usage-charts.ts'
import { usageMetrics, type UsageMetric } from '../usage-breakdown.ts'
const labels = { bar: 'Bar chart', ring: 'Donut chart', line: 'Line chart', column: 'Column chart', table: 'Table' } as const
const metric = defineModel<UsageMetric>('metric', { required: true })
const unit = defineModel<CostUnit>('unit', { required: true })
const view = defineModel<keyof typeof labels>('view', { required: true })
withDefaults(defineProps<{ showMetric?: boolean; views: readonly (keyof typeof labels)[] }>(), { showMetric: true })
</script>
<style scoped>
.usage-controls, label { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; min-width: 0; }
label { font-size: 12px; color: var(--c-text-secondary); }
</style>
