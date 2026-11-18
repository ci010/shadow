<template>
  <section class="activity-section" :aria-label="title">
    <div class="activity-heading"><h3>{{ title }}</h3>
      <UsageViewControls v-model:metric="metric" v-model:unit="unit" v-model:view="view" :show-metric="initialMetric !== undefined" :views="allowRing ? ['bar', 'ring', 'table'] : ['bar', 'table']" />
    </div>
    <p>{{ description }}</p>
    <slot name="coverage" />
    <p v-if="!ranked.length">{{ t('No recorded entries in this scope.') }}</p>
    <template v-else>
      <div v-if="view === 'ring' && ring" class="usage-ring" :style="{ background: ring }" aria-hidden="true"></div>
      <p v-else-if="view === 'ring'">{{ t('No positive values to plot.') }}</p>
      <p v-if="view === 'ring' && ring">{{ t('Ring shows shares of displayed known values only.') }}</p>
      <div v-if="view === 'table'" class="table-scroll" tabindex="0" :aria-label="title">
        <table><thead><tr><th scope="col">{{ category }}</th><th scope="col">{{ metricLabel }}</th></tr></thead>
          <tbody><tr v-for="row in visible" :key="row.id"><th scope="row"><slot name="entry" :row="row">{{ row.name }}</slot></th><td>{{ valueLabel(row) }}</td></tr></tbody>
        </table>
      </div>
      <ol v-else class="ranking-chart" :aria-label="title">
        <li v-for="(row, index) in visible" :key="row.id" class="ranking-row" :class="{ 'ring-row': view === 'ring' }">
          <span class="ranking-name"><i v-if="view === 'ring' && row.value" class="swatch" :style="{ backgroundColor: color(index) }" aria-hidden="true" /><slot name="entry" :row="row">{{ row.name }}</slot></span>
          <span v-if="view === 'bar'" class="ranking-track" aria-hidden="true"><span v-if="row.value !== null" class="ranking-bar" :style="{ width: `${maximum ? row.value / maximum * 100 : 0}%` }" /></span>
          <span class="ranking-count">{{ valueLabel(row) }}</span>
        </li>
      </ol>
      <button v-if="ranked.length > 10" class="btn btn-sm ranking-toggle" type="button" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? t('Show top 10') : t('Show all {count} categories', { count: ranked.length }) }}</button>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { formatNumber, t } from '../i18n.ts'
import { displayCosts, type CostUnit } from '../project-usage-charts.ts'
import { rankBreakdown, usageMetrics, type BreakdownRow, type UsageMetric } from '../usage-breakdown.ts'
import UsageViewControls from './UsageViewControls.vue'
const props = withDefaults(defineProps<{ title: string; category: string; description: string; countLabel?: string; rows: BreakdownRow[]; initialMetric?: UsageMetric; allowRing?: boolean; scope: string }>(), { allowRing: true })
const metric = ref<UsageMetric>(props.initialMetric ?? 'calls')
const currency = ref<CostUnit>('USD')
const currencyChosen = ref(false)
const unit = computed({ get: () => currency.value, set: value => { currencyChosen.value = true; currency.value = value } })
const view = ref<'bar' | 'ring' | 'line' | 'column' | 'table'>('bar')
const expanded = ref(false)
watch(() => props.scope, () => { expanded.value = false })
watch(() => props.rows, rows => {
  if (currencyChosen.value) return
  const units = rows.flatMap(row => displayCosts(row.usage?.costs ?? []))
  if (units.length && !units.some(cost => cost.currency === currency.value)) currency.value = units[0]!.currency
}, { immediate: true })
const metricLabel = computed(() => props.initialMetric ? t(usageMetrics.find(entry => entry.key === metric.value)!.label) : (props.countLabel ?? t('Calls')))
const ranked = computed(() => rankBreakdown(props.rows, metric.value, unit.value))
const visible = computed(() => expanded.value ? ranked.value : ranked.value.slice(0, 10))
const maximum = computed(() => ranked.value[0]?.value ?? 0)
function valueLabel(row: typeof ranked.value[number]) {
  if (row.value === null) return t('Unavailable')
  const value = formatNumber(row.value, { maximumSignificantDigits: 15 })
  const label = metric.value === 'cost' ? `${value} ${unit.value}` : metric.value === 'time' ? t('{seconds} s', { seconds: value }) : value
  return row.partial ? `${label} · ${t('Partial telemetry')}` : label
}
function color(index: number) { return index === 0 ? 'var(--c-primary)' : `hsl(${Math.round((220 + 137.5 * index) % 360)} 50% 49%)` }
const ring = computed(() => {
  const total = visible.value.reduce((sum, row) => sum + (row.value ?? 0), 0)
  if (!total) return ''
  let start = 0
  const slices = visible.value.flatMap((row, i) => {
    if (!row.value) return []
    const end = start + row.value / total * 100
    const slice = `${color(i)} ${start}% ${end}%`
    start = end
    return [slice]
  })
  return `conic-gradient(${slices.join(',')})`
})
</script>
<style scoped>
.activity-section { min-width: 0; }
.activity-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; }
h3 { margin: 0; font-size: 13px; font-weight: 600; }
p { margin: 8px 0; font-size: 12px; line-height: 1.5; color: var(--c-text-secondary); }
.ranking-chart { list-style: none; margin: 0; padding: 0; }
.ranking-row { display: grid; grid-template-columns: minmax(0, 32%) minmax(0, 1fr) minmax(104px, auto); align-items: center; gap: 8px 16px; min-height: 35px; padding: 6px 0; font-size: 12px; }
.ranking-row.ring-row { grid-template-columns: minmax(0, 1fr) minmax(104px, auto); }
.ranking-name, th { overflow-wrap: anywhere; min-width: 0; }
.ranking-track { height: 10px; background: var(--c-bg-muted); }
.ranking-bar { display: block; height: 100%; background: var(--c-primary); }
.ranking-count { text-align: right; font-variant-numeric: tabular-nums; }
.ranking-toggle { margin-top: 10px; }
.usage-ring { position: relative; width: min(150px, 100%); aspect-ratio: 1; margin: 16px auto; border-radius: 50%; }
.usage-ring::after { content: ''; position: absolute; inset: 24%; background: var(--c-bg-soft); border-radius: 50%; }
.swatch { display: inline-block; width: 9px; height: 9px; margin-inline-end: 8px; }
.table-scroll { overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { padding: 8px; border-bottom: 1px solid var(--c-border-soft); font-weight: 400; }
th { text-align: start; }
td, thead th:last-child { text-align: end; }
@container usage (max-width: 550px) {
  .ranking-row:not(.ring-row) { grid-template-columns: minmax(0, 1fr) minmax(104px, auto); }
  .ranking-row:not(.ring-row) .ranking-name { grid-column: 1 / -1; }
}
</style>
