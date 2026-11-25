<template>
  <section class="activity-section" :class="{ 'tool-shares': toolShares }" :aria-label="title">
    <div class="activity-heading"><h3>{{ title }}</h3>
      <div class="activity-controls"><slot name="controls" /><UsageViewControls v-model:metric="metric" v-model:unit="unit" v-model:view="view" :show-metric="initialMetric !== undefined" :views="allowColumn ? (allowRing ? ['bar', 'column', 'ring', 'table'] : ['bar', 'column', 'table']) : (allowRing ? ['bar', 'ring', 'table'] : ['bar', 'table'])" /></div>
    </div>
    <p v-if="description">{{ description }}</p>
    <slot name="coverage" />
    <p v-if="!ranked.length">{{ t('No recorded entries in this scope.') }}</p>
    <template v-else>
      <div v-if="view === 'ring' && ring" :key="entranceKey" class="usage-ring" :style="{ background: ring }" aria-hidden="true"></div>
      <p v-else-if="view === 'ring'">{{ t('No positive values to plot.') }}</p>
      <p v-if="!toolShares && view === 'ring' && ring">{{ t('Ring shows shares of displayed known values only.') }}</p>
      <div v-if="view === 'table'" class="table-scroll" tabindex="0" :aria-label="title">
        <table><thead><tr><th scope="col">{{ category }}</th><th scope="col">{{ metricLabel }}</th><th v-if="toolShares" scope="col">{{ t('Share') }}</th></tr></thead>
          <tbody><tr v-for="row in tableRows" :key="row.id"><th scope="row"><slot name="entry" :row="row" :table="true">{{ row.name }}</slot></th><td>{{ valueLabel(row) }}</td><td v-if="toolShares">{{ shareLabel(row) }}</td></tr></tbody>
        </table>
      </div>
      <ol v-else :key="entranceKey" class="ranking-chart" :class="{ 'fills-bars': view === 'bar', 'column-chart': view === 'column' }" :aria-label="title">
        <li v-for="(row, index) in visible" :key="'aggregate' in row ? 'other' : `entry:${row.id}`" class="ranking-row" :class="{ 'ring-row': view === 'ring' }">
          <span class="ranking-name"><i v-if="view === 'ring' && row.value" class="swatch" :style="{ backgroundColor: color(index) }" aria-hidden="true" /><slot name="entry" :row="row" :table="false">{{ row.name }}</slot></span>
          <span v-if="view === 'bar' || view === 'column'" class="ranking-track" aria-hidden="true"><span v-if="row.value !== null" class="ranking-bar" :style="{ '--bar-size': `${ratio(row.value, toolShares ? total : maximum) * 100}%` }" /></span>
          <span class="ranking-count">{{ valueLabel(row) }}<span v-if="toolShares" class="ranking-share"> · {{ shareLabel(row) }}</span></span>
        </li>
      </ol>
      <button v-if="!toolShares && ranked.length > 10" class="btn btn-sm ranking-toggle" type="button" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? t('Show top 10') : t('Show all {count} categories', { count: ranked.length }) }}</button>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { formatNumber, t } from '../i18n.ts'
import { displayCosts, type CostUnit } from '../project-usage-charts.ts'
import { rankBreakdown, usageMetrics, type BreakdownRow, type UsageMetric } from '../usage-breakdown.ts'
import UsageViewControls from './UsageViewControls.vue'
const props = withDefaults(defineProps<{ title: string; category: string; description?: string; formatValue?: (value: number) => string; countLabel?: string; rows: BreakdownRow[]; initialMetric?: UsageMetric; allowRing?: boolean; allowColumn?: boolean; toolShares?: boolean; scope: string }>(), { allowRing: true })
const metric = ref<UsageMetric>(props.initialMetric ?? 'calls')
const currency = ref<CostUnit>('USD')
const currencyChosen = ref(false)
const unit = computed({ get: () => currency.value, set: value => { currencyChosen.value = true; currency.value = value } })
const view = ref<'bar' | 'ring' | 'line' | 'column' | 'table'>('bar')
const entranceKey = computed(() => JSON.stringify([props.scope, view.value, metric.value, metric.value === 'cost' && currencyChosen.value ? unit.value : null]))
const expanded = ref(false)
watch(() => props.scope, () => { expanded.value = false })
watch(() => props.rows, rows => {
  if (currencyChosen.value) return
  const units = rows.flatMap(row => displayCosts(row.usage?.costs ?? []))
  if (units.length && !units.some(cost => cost.currency === currency.value)) currency.value = units[0]!.currency
}, { immediate: true })
const metricLabel = computed(() => props.initialMetric ? t(usageMetrics.find(entry => entry.key === metric.value)!.label) : (props.countLabel ?? t('Calls')))
const ranked = computed(() => rankBreakdown(props.rows, metric.value, unit.value))
const total = computed(() => sumValues(ranked.value))
const regularRows = computed(() => expanded.value ? ranked.value : ranked.value.slice(0, 10))
const tableRows = computed(() => props.toolShares ? ranked.value : regularRows.value)
const visible = computed(() => {
  if (!props.toolShares) return regularRows.value
  const top = ranked.value.slice(0, 8)
  const rest = ranked.value.slice(8)
  return rest.length ? [...top, { id: '', aggregate: true, name: t('Other tools'), value: sumValues(rest), partial: false }] : top
})
function sumValues(rows: { value: number | null }[]) { return rows.reduce((sum, row) => sum + (row.value ?? 0), 0) }
function ratio(value: number, denominator: number) { return denominator ? value / denominator : 0 }
function shareLabel(row: { value: number | null }) {
  if (row.value === null || !total.value) return t('Unavailable')
  const share = ratio(row.value, total.value)
  const options = { style: 'percent', maximumFractionDigits: 2 } as const
  return share > 0 && share < 0.0001 ? `<${formatNumber(0.0001, options)}` : formatNumber(share, options)
}
const maximum = computed(() => ranked.value[0]?.value ?? 0)
function valueLabel(row: { value: number | null; partial: boolean }) {
  if (row.value === null) return t('Unavailable')
  if (props.formatValue) return props.formatValue(row.value)
  const value = formatNumber(row.value, { maximumSignificantDigits: 15 })
  const label = metric.value === 'cost' ? `${value} ${unit.value}` : metric.value === 'time' ? t('{seconds} s', { seconds: value }) : value
  return row.partial ? `${label} · ${t('Partial telemetry')}` : label
}
function color(index: number) { return index === 0 ? 'var(--c-primary)' : `hsl(${Math.round((220 + 137.5 * index) % 360)} 50% 49%)` }
const ring = computed(() => {
  const denominator = props.toolShares ? total.value : sumValues(visible.value)
  if (!denominator) return ''
  let start = 0
  const slices = visible.value.flatMap((row, i) => {
    if (!row.value) return []
    const end = start + row.value / denominator * 100
    const slice = `${color(i)} ${start}% ${end}%`
    start = end
    return [slice]
  })
  return `conic-gradient(${slices.join(',')})`
})
</script>
<style scoped>
@property --usage-bar-fill {
  syntax: '<number>';
  inherits: true;
  initial-value: 1;
}
@property --usage-ring-fill {
  syntax: '<angle>';
  inherits: false;
  initial-value: 360deg;
}
@keyframes usage-bar-enter { from { --usage-bar-fill: 0.12; } }
@keyframes usage-ring-enter { from { --usage-ring-fill: 35deg; } }
@media (prefers-reduced-motion: no-preference) {
  .fills-bars { animation: usage-bar-enter 300ms cubic-bezier(.2, .75, .3, 1); }
  .ranking-bar { transform: scaleX(var(--usage-bar-fill, 1)); transform-origin: left center; }
  .usage-ring {
    animation: usage-ring-enter 360ms cubic-bezier(.2, .75, .3, 1);
    mask-image: conic-gradient(#000 0deg var(--usage-ring-fill, 360deg), transparent var(--usage-ring-fill, 360deg) 360deg);
  }
}
.activity-section { min-width: 0; }
.activity-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; }
.activity-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
h3 { margin: 0; font-size: 13px; font-weight: 600; }
p { margin: 8px 0; font-size: 12px; line-height: 1.5; color: var(--c-text-secondary); }
.ranking-chart { list-style: none; margin: 0; padding: 0; }
.ranking-row { display: grid; grid-template-columns: minmax(0, 42%) minmax(0, 1fr) minmax(0, auto); align-items: center; gap: 3px 12px; min-height: 27px; padding: 3px 0; font-size: 12px; }
.ranking-row.ring-row { grid-template-columns: minmax(0, 1fr) minmax(0, auto); }
.ranking-name, th { overflow-wrap: anywhere; min-width: 0; }
.ranking-track { height: 6px; background: var(--c-bg-muted); }
.ranking-bar { display: block; height: 100%; background: var(--c-primary); }
.ranking-count { overflow-wrap: anywhere; max-width: 20ch; text-align: right; font-variant-numeric: tabular-nums; }
.ranking-share { color: var(--c-text-secondary); }
.ranking-toggle { margin-top: 10px; }
.usage-ring { position: relative; width: min(150px, 100%); aspect-ratio: 1; margin: 16px auto; border-radius: 50%; }
.usage-ring::after { content: ''; position: absolute; inset: 24%; background: var(--c-bg-soft); border-radius: 50%; }
.swatch { display: inline-block; width: 9px; height: 9px; margin-inline-end: 8px; }
.table-scroll { overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--c-border-soft); font-weight: 400; }
th { text-align: start; }
td, thead th:not(:first-child) { text-align: end; }
@container usage (max-width: 550px) {
  .activity-section:not(.tool-shares) .ranking-row:not(.ring-row) { grid-template-columns: minmax(0, 1fr) minmax(0, auto); }
  .activity-section:not(.tool-shares) .ranking-row:not(.ring-row) .ranking-name { grid-column: 1 / -1; }
}
.ranking-bar { width: var(--bar-size); }
.column-chart { display: flex; overflow-x: auto; gap: 12px; align-items: start; }
.column-chart .ranking-row { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: 7rem auto auto; flex: 1 0 7rem; max-width: 13rem; gap: 4px; text-align: center; }
.column-chart .ranking-track { grid-row: 1; align-self: stretch; justify-self: center; width: min(45%, 36px); height: auto; display: flex; align-items: end; }
.column-chart .ranking-bar { width: 100%; height: var(--bar-size); }
.column-chart .ranking-count { text-align: center; }
</style>
