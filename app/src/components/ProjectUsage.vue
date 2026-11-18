<template>
  <section class="project-usage" :aria-label="t(globalMode ? 'Usage' : 'Project usage')">
    <header><h2>{{ t(globalMode ? 'Usage' : 'Project usage') }}</h2><button class="btn btn-sm" type="button" :disabled="loading" @click="refresh">{{ loading ? t('Refreshing…') : t('Refresh') }}</button></header>
    <div v-if="globalMode" class="project-filter"><span aria-hidden="true">{{ t('Project') }}</span>
      <UiSelect ref="filterControl" v-model="filter" :aria-label="t('Project')" :disabled="!rows?.length">
        <option value="">{{ t('All projects') }}</option>
        <option v-for="row in rows" :key="row.project.id" :value="row.project.id">{{ row.project.name }}</option>
      </UiSelect>
    </div>
    <p v-if="allProjects && failedProjects && data" role="status">{{ t('Some projects could not be loaded ({count}). Totals include only available usage.', { count: failedProjects }) }}</p>
    <p v-if="loading" role="status">{{ t('Loading usage…') }}</p>
    <p v-if="error" role="alert">{{ t(globalMode ? 'Could not load usage. Retry to load the latest statistics.' : 'Could not load Project usage. Retry to load the latest statistics.') }} <button class="btn btn-sm" @click="refresh">{{ t('Retry') }}</button></p>
    <template v-if="data">
      <div class="summary-toolbar"><h3>{{ t('Usage summary') }}</h3><div class="period-switch" role="group" :aria-label="t('Usage period')"><button class="btn btn-sm" v-for="period in periods" :key="period.key" type="button" :aria-pressed="selectedPeriod === period.key" @click="selectedPeriod = period.key">{{ t(period.label) }}</button></div></div>
      <p v-if="mixedSnapshotDates && selectedPeriod !== 'total'">{{ t('The selected period is relative to each project’s snapshot date.') }}</p>
      <div class="summary-grid">
        <article class="metric-card"><h3>{{ t('Tokens') }}</h3><div class="metric-value" :title="tokens(selectedUsage)">{{ compactNumber(selectedUsage.tokens) }}</div></article>
        <article class="metric-card"><h3>{{ t('Estimated cost') }}</h3><div v-if="summaryCosts.length" class="cost-values"><div v-for="cost in summaryCosts" :key="cost.currency" class="metric-value" :title="exactCost(cost)">{{ compactCost(cost.amount) }} <span class="unit">{{ cost.currency }}</span></div></div><div v-else class="metric-value unavailable">{{ t('Unavailable') }}</div></article>
        <article class="metric-card"><h3>{{ t('Model call time') }}</h3><div class="metric-value" :title="duration(selectedUsage)">{{ compactDuration(selectedUsage.durationMs) }}</div></article>
        <article class="metric-card"><h3>{{ t('Provider calls') }}</h3><div class="metric-value" :title="formatNumber(selectedUsage.calls)">{{ compactNumber(selectedUsage.calls) }}</div></article>
      </div>
      <p v-if="hasMissing" class="notice" role="status">{{ t('Some usage is unavailable or partial; known subtotals may be lower. See data completeness.') }}</p>
      <div class="activity-grid">
        <UsageBreakdown v-if="allProjects && projectRows.length" :title="t('Usage by project')" :category="t('Project')"
          :description="t('Select a project to inspect its usage.')" :rows="projectRows" initial-metric="tokens" :scope="activityScope">
          <template #entry="{ row }"><button class="btn btn-sm project-link" type="button" @click="filter = row.id; filterControl?.focus()">{{ row.name }}</button></template>
        </UsageBreakdown>
        <UsageBreakdown :title="t('Model usage')" :category="t('Model')" initial-metric="calls" :rows="modelRows" :scope="activityScope"
          :description="t('Recorded models in the selected period.')">
          <template #coverage><p v-if="unnamedCalls">{{ t('{count} calls without a recorded model are excluded.', { count: formatNumber(unnamedCalls) }) }}</p></template>
        </UsageBreakdown>
        <UsageBreakdown :title="t('Tool usage')" :category="t('Tool')" :rows="toolRows" :scope="activityScope"
          :description="t('Calls by tool, regardless of arguments. invoke_tool is counted under its dynamic tool name.')" />
      </div>
      <p class="conversion-note">{{ t('100 AI credits = 1 USD · CNY shown separately') }}</p>
      <p class="scope-brief">{{ t('UTC dates · estimated costs · cumulative model call time') }}</p>
      <div class="chart-toolbar"><h3>{{ t('Usage trends') }}</h3></div>
      <p v-if="mixedSnapshotDates" class="trend-range">{{ t('Daily trends are unavailable because the project snapshots span different UTC dates. Refresh to align them.') }}</p>
      <p v-else class="trend-range"><template v-if="selectedPeriod === 'total'">{{ t('All-time trends show only the latest {days} UTC dates.', { days: windowDays }) }} · </template>{{ points[0]?.date }}<template v-if="points.length > 1"> — {{ points.at(-1)?.date }}</template> · UTC</p>
      <article v-if="!mixedSnapshotDates" class="chart-card" :aria-label="t('Usage trends')">
        <div class="cost-heading"><h3>{{ trendTitle }}</h3>
          <UsageViewControls v-model:metric="trendMetric" v-model:unit="costUnit" v-model:view="trendView" :views="['line', 'column', 'table']" />
        </div>
        <p>{{ t(trendMetric === 'time' ? 'Cumulative call time, not work duration; gaps are not interpolated.' : trendMetric === 'cost' ? 'Includes converted AI credits in USD.' : 'Missing telemetry is unavailable, not zero.') }}</p>
        <div v-if="trendView === 'table'" class="trend-table" tabindex="0" :aria-label="trendTitle">
          <table><thead><tr><th scope="col">{{ t('Date') }}</th><th scope="col">{{ trendTitle }}</th></tr></thead>
            <tbody><tr v-for="point in trendSeries" :key="point.date"><th scope="row">{{ point.date }}</th><td>{{ point.label.slice(point.date.length + 2) }}</td></tr></tbody>
          </table>
        </div>
        <p v-else-if="!trendSeries.some(p => p.value !== null)" class="empty-chart">{{ t('No known values in this window.') }}</p>
        <UsageTrendChart v-else :title="trendTitle" :kind="trendView === 'column' ? 'bar' : 'line'" :points="trendSeries" :entrance-key="`${activityScope}:${trendMetric}:${trendMetric === 'cost' && currencyChosen ? costUnit : ''}`" :format-axis="axisFormat" :min-interval="['tokens', 'calls'].includes(trendMetric) ? 1 : 0" />
      </article>
      <UsageDiagnostics :projects="diagnosticProjects" />

      <p v-if="allProjects">{{ t('Select a project to browse its daily history.') }}</p>
      <template v-else>
        <h3>{{ t('Daily usage (UTC)') }}</h3>
        <p>{{ t('Daily history loads 10 dates per page, newest first.') }}</p>
        <div class="pagination">
          <button class="btn btn-sm" v-if="!dailyPage" :disabled="pageLoading || loading" @click="loadPage(1)">{{ t('Load daily history') }}</button>
          <template v-if="dailyPage">
            <button class="btn btn-sm" :disabled="pageLoading || loading || dailyPage.page <= 1" @click="loadPage(dailyPage.page - 1)">{{ t('Previous page') }}</button>
            <span>{{ t('Page {page} · {total} dates', { page: dailyPage.page, total: dailyPage.total }) }} · {{ dailyPage.daily[0]?.date }} — {{ dailyPage.daily.at(-1)?.date }}</span>
            <button class="btn btn-sm" :disabled="pageLoading || loading || !dailyPage.hasMore" @click="loadPage(dailyPage.page + 1)">{{ t('Next page') }}</button>
          </template>
          <span v-if="pageLoading" role="status">{{ t('Loading daily history…') }}</span>
          <span v-if="pageError" role="alert">{{ t('Could not load daily history.') }} <button class="btn btn-sm" @click="loadPage(requestedPage)">{{ t('Retry') }}</button></span>
        </div>
        <div v-if="dailyPage" class="daily-table" tabindex="0" :aria-label="t('Daily usage (UTC)')">
          <table><thead><tr><th scope="col">{{ t('Date') }}</th><th scope="col">{{ t('Tokens') }}</th><th scope="col">{{ t('Estimated cost') }}</th><th scope="col">{{ t('Provider time') }}</th><th scope="col">{{ t('Provider calls') }}</th></tr></thead>
            <tbody><tr v-for="day in dailyPage?.daily ?? []" :key="day.date"><th scope="row">{{ day.date }}</th><td :title="tokens(day.usage)"><span class="trend" aria-hidden="true" :style="{ width: `${(day.usage.tokens ?? 0) / maximum * 100}%` }" /><span class="value">{{ compactNumber(day.usage.tokens) }} </span></td><td :title="costs(day.usage)"><div v-for="cost in displayCosts(day.usage.costs)" :key="cost.currency">{{ compactCost(cost.amount) }} <span class="unit">{{ cost.currency }}</span></div><span v-if="!displayCosts(day.usage.costs).length">{{ t('Unavailable') }}</span></td><td :title="duration(day.usage)">{{ compactDuration(day.usage.durationMs) }} </td><td :title="formatNumber(day.usage.calls)">{{ compactNumber(day.usage.calls) }}</td></tr></tbody>
          </table>
        </div>
      </template>
      <details class="completeness"><summary>{{ t('Data completeness') }}</summary>
        <p v-if="data.coverage === 'partial'">{{ t('Historical indexing is incomplete; totals may grow as data becomes available.') }}</p>
        <p v-if="data.firstText && !data.requestQuality">{{ t('First streamed text (all time): P50 {p50}, P95 {p95} ({count} samples)', { p50: data.firstText.p50Ms === null ? t('Unavailable') : `${Math.round(data.firstText.p50Ms)} ms`, p95: data.firstText.p95Ms === null ? t('Unavailable') : `${Math.round(data.firstText.p95Ms)} ms`, count: data.firstText.samples }) }}</p>
        <template v-if="!mixedSnapshotDates"><p>{{ t('Daily tokens') }} · {{ t('{count} of {days} days available', { count: points.filter(p => p.tokens !== null).length, days: windowDays }) }}</p>
        <p>{{ t('Daily estimated cost') }} · {{ t('{count} of {days} days available', { count: costPoints.filter(p => p.amount !== null).length, days: windowDays }) }} · {{ costUnit }}</p>
        <p>{{ t('Daily provider time') }} · {{ t('{count} of {days} days available', { count: points.filter(p => p.seconds !== null).length, days: windowDays }) }}</p></template><p>{{ t('Selected usage period: {period}', { period: t(periods.find(p => p.key === selectedPeriod)!.label) }) }}</p><ul><li>{{ t('Missing token telemetry: {count} calls', { count: selectedUsage.unknownTokenCalls }) }}</li><li>{{ t('Missing cost telemetry: {count} calls', { count: selectedUsage.unknownCostCalls }) }}</li><li>{{ t('Missing duration telemetry: {count} calls', { count: selectedUsage.unknownDurationCalls }) }}</li></ul><p>{{ t('Coverage: {untracked} sessions without complete tracking; {undated} undated calls excluded. Scan capped: {capped}. Totals may be lower bounds.', { untracked: data.untrackedSessions, undated: data.undatedCalls, capped: data.scanLimitReached ? t('Yes') : t('No') }) }}</p><table class="coverage-table"><thead><tr><th>{{ t('Date') }}</th><th>{{ t('Missing tokens / cost / duration') }}</th></tr></thead><tbody><tr v-for="day in dailyPage?.daily ?? []" :key="day.date"><th>{{ day.date }}</th><td>{{ day.usage.unknownTokenCalls }} / {{ day.usage.unknownCostCalls }} / {{ day.usage.unknownDurationCalls }}</td></tr></tbody></table></details>
      <details class="methodology"><summary>{{ t('How usage is measured') }}</summary>
      <p>{{ t('As of {time}. Calendar dates use UTC; past 7 days includes today and the previous 6 days.', { time: formatDateTime(data.asOf, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) }) }}</p>
      <p>{{ t('Costs are provider/model estimates, not invoices. AI credits are converted to USD at 100 credits = 1 USD and added to USD estimates. CNY remains separate; original records are unchanged.') }}</p>
      <p>{{ t('Time is summed provider-call elapsed time, including failed calls, excluding tools and user waiting. Concurrent calls overlap; this is not wall-clock work time. Older calls may have no duration.') }}</p>
      <p>{{ t('Model counts require recorded model names; older calls without names are excluded. Tool counts use recorded results, including errors; unfinished calls without results are excluded.') }}</p>
      <p class="notice">{{ t('Values are known subtotals. Missing telemetry is unavailable, not zero; partial marks calls with missing data.') }}</p>

      </details>
    </template>
    <p v-else-if="!loading && !error">{{ t(allProjects && rows ? 'No project usage available.' : 'No usage loaded yet.') }}</p>
  </section>
</template>
<script setup lang="ts">
import { projectBase } from '../api-url.ts'
import UiSelect from './UiSelect.vue'
import UsageTrendChart from './UsageTrendChart.vue'
import UsageBreakdown from './UsageBreakdown.vue'
import UsageDiagnostics from './UsageDiagnostics.vue'
import UsageViewControls from './UsageViewControls.vue'
import { measure, type UsageMetric } from '../usage-breakdown.ts'
import { computed, ref, shallowRef, watch } from 'vue'
import { compactUsageNumber, compactUsageCost, durationParts, usageTrendDays, usageWindow, displayCosts, type CostUnit } from '../project-usage-charts.ts'
import type { UsageChartDatum } from '../usage-chart-options.ts'
import { useCatalogResourceStore } from '../stores/catalog.ts'
import { useCatalogVisibility } from '../resources/catalog-visibility.ts'
import { requireResourcePinia } from '../stores/app.ts'
import { t, formatDateTime, formatNumber } from '../i18n.ts'
import type { ProjectUsageMetrics } from '../../../src/projects/usage-contract.ts'
const props = defineProps<{ apiBase: string; projectId?: string; active: boolean }>()
const owner = useCatalogResourceStore(requireResourcePinia()).owner
const enabled = useCatalogVisibility(() => props.active)
const globalMode = computed(() => props.projectId === undefined)
const filter = ref('')
const filterControl = ref<InstanceType<typeof UiSelect>>()
const selectedProjectId = computed(() => props.projectId ?? filter.value)
const allProjects = computed(() => globalMode.value && !filter.value)
const scopedBase = computed(() => globalMode.value && filter.value ? projectBase(props.apiBase, filter.value) : props.apiBase)
const global = shallowRef<ReturnType<typeof owner.globalUsage>>()
const rows = computed(() => global.value?.state.value.value?.rows)
const failedProjects = computed(() => rows.value?.filter(row => !row.usage).length ?? 0)
const aggregate = computed(() => global.value?.state.value.value?.aggregate)
const summary = shallowRef<ReturnType<typeof owner.usage>>()
const state = computed(() => allProjects.value ? global.value?.state.value : summary.value?.state.value)
const data = computed(() => allProjects.value ? aggregate.value : summary.value?.state.value.value)
const loading = computed(() => state.value?.loading ?? false)
const error = computed(() => !!state.value?.error)
watch(() => [props.apiBase, globalMode.value && enabled.value] as const, ([base, active], previous, cleanup) => {
  if (previous && base !== previous[0]) filter.value = ''
  global.value = undefined
  if (!active) return
  const lease = owner.globalUsage(base); global.value = lease
  cleanup(lease.release)
}, { immediate: true })
watch(rows, value => {
  if (value && filter.value && !value.some(row => row.project.id === filter.value)) filter.value = ''
})
const periods = [{ key: 'today', label: 'Today' }, { key: 'past7Days', label: 'Past 7 days' }, { key: 'month', label: 'This month' }, { key: 'total', label: 'All time' }] as const
const selectedPeriod = ref<typeof periods[number]['key']>('past7Days')
const selectedUsage = computed(() => data.value![selectedPeriod.value])
const selectedActivity = computed(() => data.value!.activity[selectedPeriod.value])
const activityScope = computed(() => `${selectedProjectId.value}:${selectedPeriod.value}`)
const projectRows = computed(() => (rows.value ?? []).map(({ project, usage }) => ({ id: project.id, name: project.name, usage: usage?.[selectedPeriod.value] })))
const modelRows = computed(() => selectedActivity.value.models.map(row => ({ id: row.name, ...row })))
const unnamedCalls = computed(() => Math.max(0, selectedUsage.value.calls - modelRows.value.reduce((sum, row) => sum + row.calls, 0)))
const toolRows = computed(() => selectedActivity.value.tools.map(row => ({ id: row.name, ...row })))
const diagnosticProjects = computed(() => allProjects.value
  ? (rows.value ?? []).map(({ project, usage }) => ({ id: project.id, name: project.name, usage }))
  : [{ id: selectedProjectId.value ?? '', name: rows.value?.find(row => row.project.id === selectedProjectId.value)?.project.name ?? '', usage: data.value }])
const summaryCosts = computed(() => displayCosts(selectedUsage.value.costs))
const incompleteIndex = computed(() => !!data.value && (data.value.coverage === 'partial' || data.value.scanLimitReached || data.value.untrackedSessions > 0 || data.value.undatedCalls > 0))
const hasMissing = computed(() => incompleteIndex.value || !!data.value && [data.value.total, ...data.value.daily.map(d => d.usage)]
  .some(u => u.calls > 0 && (u.tokens === null || u.durationMs === null || u.unknownTokenCalls || u.unknownCostCalls || u.unknownDurationCalls)))
function compactNumber(value: number | null) { return value === null ? t('Unavailable') : compactUsageNumber(value, formatNumber) }
function compactCost(value: number) { return compactUsageCost(value, formatNumber) }
function exactCost(cost: ProjectUsageMetrics['costs'][number]) { return `${formatNumber(cost.amount, { maximumSignificantDigits: 15 })} ${cost.currency}` }
function compactDuration(ms: number | null) {
  if (ms === null) return t('Unavailable')
  const { hours, minutes, seconds } = durationParts(ms)
  if (hours) return t('{hours}h {minutes}m {seconds}s', { hours, minutes, seconds })
  if (minutes) return t('{minutes}m {seconds}s', { minutes, seconds })
  return t('{seconds} s', { seconds: formatNumber(seconds, { maximumFractionDigits: 1 }) })
}
const mixedSnapshotDates = computed(() => allProjects.value && new Set((rows.value ?? []).flatMap(row => row.usage ? [row.usage.asOf.slice(0, 10)] : [])).size > 1)
const windowDays = computed(() => data.value ? usageTrendDays(data.value.asOf, selectedPeriod.value) : 0)
const points = computed(() => data.value && !mixedSnapshotDates.value ? usageWindow(data.value, windowDays.value) : [])
const currency = ref<CostUnit>('USD')
const currencyChosen = ref(false)
const costUnit = computed({ get: () => currency.value, set: value => { currencyChosen.value = true; currency.value = value } })
watch(points, rows => {
  if (currencyChosen.value) return
  const available = rows.flatMap(row => displayCosts(row.usage?.costs ?? []))
  if (available.length && !available.some(cost => cost.currency === currency.value)) currency.value = available[0]!.currency
})
const trendMetric = ref<UsageMetric>('tokens')
const trendView = ref<'bar' | 'ring' | 'column' | 'line' | 'table'>('column')
const trendTitles = { tokens: 'Daily tokens', calls: 'Daily provider calls', cost: 'Daily estimated cost', time: 'Daily provider time' } as const
const trendTitle = computed(() => `${t(trendTitles[trendMetric.value])}${trendMetric.value === 'cost' ? ` (${costUnit.value})` : ''}`)
const costPoints = computed(() => points.value.map(p => ({ amount: measure(p, 'cost', costUnit.value).value })))
const trendSeries = computed<UsageChartDatum[]>(() => points.value.map(p => {
  const metric = trendMetric.value
  const { value, partial } = measure(p, metric, costUnit.value)
  // Padded no-activity days are not verified zero if index coverage is incomplete.
  const known = metric === 'calls' && value === 0 && (incompleteIndex.value || data.value?.coverage !== 'complete') ? null : value
  const exact = known === null ? t('Unavailable') : formatNumber(known, { maximumSignificantDigits: 15 })
  const label = known === null ? exact : metric === 'cost' ? `${exact} ${costUnit.value}` : metric === 'time' ? t('{seconds} s', { seconds: exact }) : exact
  return { date: p.date, value: known, partial, label: `${p.date}: ${label}${partial && known !== null ? ` · ${t('Partial telemetry')}` : ''}` }
}))
function axisFormat(value: number) {
  return trendMetric.value === 'cost' ? compactCost(value) : trendMetric.value === 'time' ? compactDuration(value * 1000) : compactNumber(value)
}
const maximum = computed(() => dailyPage.value?.daily.reduce((max, day) => Math.max(max, day.usage.tokens ?? 0), 1) ?? 1)
function tokens(usage: ProjectUsageMetrics) { return usage.tokens === null ? t('Unavailable') : formatNumber(usage.tokens) }
function costs(usage: ProjectUsageMetrics) {
  return usage.costs.length ? displayCosts(usage.costs).map(exactCost).join(' · ') : t('Unavailable')
}
function duration(usage: ProjectUsageMetrics) {
  return usage.durationMs === null ? t('Unavailable') : t('{seconds} s', { seconds: formatNumber(usage.durationMs / 1000, { maximumFractionDigits: 3 }) })
}
const pageLease = shallowRef<ReturnType<typeof owner.usagePage>>()
const previousPageLease = shallowRef<ReturnType<typeof owner.usagePage>>()
const dailyPage = computed(() => pageLease.value?.state.value.value ?? previousPageLease.value?.state.value.value)
const pageLoading = computed(() => pageLease.value?.state.value.loading ?? false)
const pageError = computed(() => !!pageLease.value?.state.value.error)
const requestedPage = ref(1)
function resetPage() { pageLease.value?.release(); previousPageLease.value?.release(); pageLease.value = undefined; previousPageLease.value = undefined; requestedPage.value = 1 }
function loadPage(page: number) {
  if (!enabled.value || !data.value || loading.value) return
  if (pageLease.value?.state.value.value) {
    previousPageLease.value?.release(); previousPageLease.value = pageLease.value
  } else pageLease.value?.release()
  requestedPage.value = page
  pageLease.value = owner.usagePage(scopedBase.value, selectedProjectId.value, page)
}
function refresh() { resetPage(); return allProjects.value ? global.value?.refresh() : summary.value?.refresh() }
watch(() => [scopedBase.value, selectedProjectId.value, enabled.value] as const, ([base, projectId, active], _, cleanup) => {
  resetPage(); summary.value = undefined
  if (!active || !projectId) return
  const lease = owner.usage(base, projectId); summary.value = lease
  cleanup(() => { lease.release(); resetPage() })
}, { immediate: true })
</script>
<style scoped>
.project-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-block: 0 16px; }
.project-filter .ui-select { max-width: 100%; }
.project-usage { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 24px; color: var(--c-text); background: var(--c-bg-soft); container: usage / inline-size; }
header, .summary-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
h2 { margin: 0; font-size: 16px; font-weight: 600; }
h3 { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; }
p { margin: 8px 0; font-size: 12px; line-height: 1.5; color: var(--c-text-secondary); }
.notice { color: var(--c-warn); }
.btn { cursor: pointer; }
.btn:disabled { cursor: default; }
.period-switch { display: flex; flex-wrap: wrap; gap: 0; }
.period-switch .btn + .btn { margin-left: -1px; }
.period-switch .btn[aria-pressed="true"] { position: relative; background: var(--c-selection-bg); border-color: var(--c-selection-border); color: var(--c-primary); }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-block: 1px solid var(--c-border); background: var(--c-bg-card); padding: 20px 0; }
.metric-card { min-width: 0; padding: 0 20px; }
.metric-card + .metric-card { border-left: 1px solid var(--c-border-soft); }
.metric-card h3 { margin-bottom: 10px; color: var(--c-text-secondary); font-size: 12px; font-weight: 500; }
.metric-value { font-size: 26px; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; letter-spacing: -.02em; }
.cost-values { display: grid; gap: 4px; }
.unit { color: var(--c-text-secondary); font-size: 12px; font-weight: 400; letter-spacing: normal; }
.unavailable { color: var(--c-text-secondary); font-size: 20px; font-weight: 500; }
.partial { color: var(--c-text-muted); font-size: 11px; font-weight: 400; }
.metric-card > .partial { display: block; margin-top: 6px; }
.activity-grid { display: grid; gap: 28px; margin: 28px 0; }
.project-link { max-width: 100%; white-space: normal; text-align: start; overflow-wrap: anywhere; }
.conversion-note { margin-top: 12px; }
.scope-brief { margin: 4px 0; }
.chart-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin: 28px 0 8px; }
.trend-range { margin: 0 0 12px; font-variant-numeric: tabular-nums; }
.chart-card { min-width: 0; border: 1px solid var(--c-border); background: var(--c-bg-card); padding: 16px 20px; display: flex; flex-direction: column; }
.chart-card > p { margin: 6px 0 12px; }
.chart-card > .chart-stat { margin: 12px 0 0; font-variant-numeric: tabular-nums; }
.cost-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.trend-table { overflow: auto; }
.empty-chart { display: grid; place-content: center; min-height: 210px; text-align: center; }
.pagination { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; color: var(--c-text-secondary); font-size: 12px; }
.daily-table { overflow-x: auto; margin: 12px 0 24px; }
table { width: 100%; border-collapse: collapse; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--c-border-soft); min-width: 100px; }
th:first-child { text-align: left; }
thead th { color: var(--c-text-secondary); font-weight: 500; }
tbody th { font-weight: 400; }
td { position: relative; }
.trend { position: absolute; inset: 8px auto 8px 0; background: var(--c-selection-bg); }
.value { position: relative; }
details { border-top: 1px solid var(--c-border); padding: 12px 0; font-size: 12px; }
summary { cursor: pointer; color: var(--c-text-secondary); }
details li { line-height: 1.8; color: var(--c-text-secondary); }
.coverage-table { width: auto; font-size: 11px; }
.daily-table:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@container usage (max-width: 850px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 24px; }
  .metric-card:nth-child(3) { border-left: 0; }
}
@container usage (max-width: 380px) {
  .metric-card { padding: 0 12px; }
  .chart-card { padding: 14px 12px; }
  .metric-value { font-size: 22px; }
}
</style>
