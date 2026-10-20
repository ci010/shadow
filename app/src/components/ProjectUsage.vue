<template>
  <section class="project-usage" :aria-label="t('Project usage')">
    <header><h2>{{ t('Project usage') }}</h2><button class="btn btn-sm" type="button" :disabled="loading" @click="refresh">{{ loading ? t('Refreshing…') : t('Refresh') }}</button></header>
    <p v-if="loading" role="status">{{ t('Loading usage…') }}</p>
    <p v-if="error" role="alert">{{ t('Could not load Project usage. Retry to load the latest statistics.') }} <button class="btn btn-sm" @click="refresh">{{ t('Retry') }}</button></p>
    <template v-if="data">
      <div class="period-switch" role="group" :aria-label="t('Summary period')"><button class="btn btn-sm" v-for="period in periods" :key="period.key" type="button" :aria-pressed="selectedPeriod === period.key" @click="selectedPeriod = period.key">{{ t(period.label) }}</button></div>
      <div class="summary-grid">
        <article class="metric-card"><h3>{{ t('Tokens') }}</h3><div class="metric-value" :title="tokens(selectedUsage)">{{ compactNumber(selectedUsage.tokens) }}</div><small v-if="selectedUsage.unknownTokenCalls" class="partial">{{ t('Partial') }}</small></article>
        <article class="metric-card"><h3>{{ t('Estimated cost') }}</h3><div v-if="selectedUsage.costs.length" class="cost-values"><div v-for="cost in selectedUsage.costs" :key="cost.currency" class="metric-value" :title="exactCost(cost)">{{ compactCost(cost.amount) }} <span class="unit">{{ cost.currency }}</span></div></div><div v-else class="metric-value unavailable">{{ t('Unavailable') }}</div><small v-if="selectedUsage.unknownCostCalls" class="partial">{{ t('Partial') }}</small></article>
        <article class="metric-card"><h3>{{ t('Model call time') }}</h3><div class="metric-value" :title="duration(selectedUsage)">{{ compactDuration(selectedUsage.durationMs) }}</div><small v-if="selectedUsage.unknownDurationCalls" class="partial">{{ t('Partial') }}</small></article>
        <article class="metric-card"><h3>{{ t('Provider calls') }}</h3><div class="metric-value" :title="formatNumber(selectedUsage.calls)">{{ compactNumber(selectedUsage.calls) }}</div></article>
      </div>
      <p class="scope-brief">{{ t('UTC dates · estimated costs · cumulative model call time') }}</p>
      <p v-if="hasMissing" class="notice" role="status">{{ t('Some usage is unavailable or partial; known subtotals may be lower. See data completeness.') }}</p>
      <div class="chart-toolbar">
        <div><h3>{{ t('Usage trends') }}</h3><p>{{ t('Trend window is independent of the summary period · UTC') }}</p></div>
        <div class="window-switch" :aria-label="t('Chart window')" role="group"><button class="btn btn-sm" v-for="days in [7, 30]" :key="days" type="button" :aria-pressed="windowDays === days" @click="windowDays = days">{{ t('Last {days} days', { days }) }}</button></div>
      </div>
      <div class="charts">
        <article class="chart-card token-card">
          <h3>{{ t('Daily tokens') }}</h3><p>{{ t('Known tokens; gaps are unavailable.') }}</p>
          <svg viewBox="0 0 600 195" role="img" :aria-label="t('Daily tokens')">
            <text x="30" y="16" class="axis">{{ formatNumber(tokenMax) }}</text><line x1="30" y1="160" x2="580" y2="160" class="grid-line" />
            <template v-for="(point, i) in points" :key="point.date">
              <rect v-if="point.tokens !== null" :x="32 + i * 540 / windowDays" :y="160 - point.tokens / tokenMax * 130" :width="Math.max(2, 540 / windowDays - 4)" :height="Math.max(point.tokens === 0 ? 1 : 0, point.tokens / tokenMax * 130)" class="token-bar" tabindex="0" :aria-label="pointLabel(point, 'tokens')"><title>{{ pointLabel(point, 'tokens') }}</title></rect>
              <text v-else :x="36 + i * 540 / windowDays" y="157" class="missing" :aria-label="`${point.date}: ${t('Unavailable')}`">·</text>
            </template>
            <text x="30" y="185" class="axis">{{ points[0]?.date }}</text><text x="575" y="185" text-anchor="end" class="axis">{{ points.at(-1)?.date }}</text>
          </svg>
          <p class="chart-stat">{{ t('{count} of {days} days available', { count: points.filter(p => p.tokens !== null).length, days: windowDays }) }}</p>
        </article>
        <article class="chart-card">
          <h3>{{ t('Daily provider time') }}</h3><p>{{ t('Seconds of provider calls; gaps are not interpolated.') }}</p>
          <svg viewBox="0 0 600 195" role="img" :aria-label="t('Daily provider time')">
            <text x="30" y="16" class="axis">{{ t('{seconds} s', { seconds: formatNumber(timeMax, { maximumFractionDigits: 1 }) }) }}</text><line x1="30" y1="160" x2="580" y2="160" class="grid-line" />
            <polyline v-for="(segment, i) in segments" :key="i" :points="segment" class="time-line" />
            <template v-for="(point, i) in points" :key="point.date"><circle v-if="point.seconds !== null" :cx="30 + i * 540 / (windowDays - 1)" :cy="160 - point.seconds / timeMax * 130" r="4" class="time-point" tabindex="0" :aria-label="pointLabel(point, 'seconds')"><title>{{ pointLabel(point, 'seconds') }}</title></circle></template>
            <text x="30" y="185" class="axis">{{ points[0]?.date }}</text><text x="575" y="185" text-anchor="end" class="axis">{{ points.at(-1)?.date }}</text>
          </svg>
          <p class="chart-stat">{{ t('{count} of {days} days available', { count: points.filter(p => p.seconds !== null).length, days: windowDays }) }}</p>
        </article>
        <article class="chart-card cost-card">
          <div class="cost-heading"><h3>{{ t('Daily estimated cost') }}</h3><label>{{ t('Cost unit') }} <UiSelect :value="costUnit" :aria-label="t('Cost unit')" @change="costChosen = true; costUnit = ($event.target as HTMLSelectElement).value as CostUnit"><option v-for="unit in costUnits" :key="unit" :value="unit">{{ unit }}</option></UiSelect></label></div>
          <p>{{ t('Known cost in selected unit; dashed bars are partial.') }}</p>
          <p v-if="!costPoints.some(p => p.amount !== null)" class="empty-chart">{{ t('No known cost in this window for this unit.') }}</p>
          <svg v-else viewBox="0 0 600 195" role="img" :aria-label="`${t('Daily estimated cost')} (${costUnit})`">
            <text x="30" y="16" class="axis">{{ formatNumber(costPoints.some(p => (p.amount ?? 0) > 0) ? costMax : 0, { maximumSignificantDigits: 6 }) }} {{ costUnit }}</text><line x1="30" y1="160" x2="580" y2="160" class="grid-line" />
            <template v-for="(point, i) in costPoints" :key="point.date">
              <rect v-if="point.amount !== null" :x="32 + i * 540 / windowDays" :y="160 - point.amount / costMax * 130" :width="Math.max(2, 540 / windowDays - 4)" :height="Math.max(point.amount === 0 ? 1 : 0, point.amount / costMax * 130)" class="cost-bar" :class="{ 'cost-partial': point.partial }" tabindex="0" :aria-label="costLabel(point)"><title>{{ costLabel(point) }}</title></rect>
              <text v-else :x="36 + i * 540 / windowDays" y="157" class="missing" :aria-label="`${point.date}: ${t('Unavailable')}`">·</text>
            </template>
            <text x="30" y="185" class="axis">{{ points[0]?.date }}</text><text x="575" y="185" text-anchor="end" class="axis">{{ points.at(-1)?.date }}</text>
          </svg>
          <p class="chart-stat">{{ t('{count} of {days} days available', { count: costPoints.filter(p => p.amount !== null).length, days: windowDays }) }} · {{ costUnit }}</p>

        </article>
        <article class="chart-card share-card">
          <h3>{{ t('Token share by day') }}</h3><p>{{ t('Known tokens · top 5 dates and remaining dates.') }}</p>
            <p v-if="!shares.length" class="empty-chart share-empty">{{ t('No positive known tokens in this window.') }}</p>
            <ul v-else class="share-legend"><li v-for="(share, i) in shares" :key="share.label"><span class="swatch" :style="{ background: palette[i] }" />{{ share.label === 'Other days' ? t('Other days') : share.label.slice(5) }} <strong :title="formatNumber(share.value)">{{ compactNumber(share.value) }} · {{ formatNumber(share.share * 100, { maximumFractionDigits: 1 }) }}%</strong></li></ul>
          <svg v-if="shares.length" class="donut" viewBox="0 0 180 180" role="img" :aria-label="t('Token share by day')"><circle cx="90" cy="90" r="60" fill="none" class="donut-track" stroke-width="24" />
            <circle v-for="(share, i) in shares" :key="share.label" cx="90" cy="90" r="60" fill="none" :stroke="palette[i]" stroke-width="24" pathLength="100" :stroke-dasharray="`${share.share * 100} ${100 - share.share * 100}`" :stroke-dashoffset="-share.offset * 100" transform="rotate(-90 90 90)" tabindex="0" :aria-label="`${share.label === 'Other days' ? t('Other days') : share.label}: ${formatNumber(share.value)} (${formatNumber(share.share * 100, { maximumFractionDigits: 1 })}%)`"><title>{{ share.label }}: {{ formatNumber(share.value) }}</title></circle>
            <text x="90" y="88" text-anchor="middle" class="donut-value">{{ compactNumber(knownTokens) }}</text><text x="90" y="108" text-anchor="middle" class="axis">{{ t('Known tokens') }}</text>
          </svg>
        </article>
      </div>

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
          <tbody><tr v-for="day in dailyPage?.daily ?? []" :key="day.date"><th scope="row">{{ day.date }}</th><td :title="tokens(day.usage)"><span class="trend" aria-hidden="true" :style="{ width: `${(day.usage.tokens ?? 0) / maximum * 100}%` }" /><span class="value">{{ compactNumber(day.usage.tokens) }} <small v-if="day.usage.unknownTokenCalls" class="partial">{{ t('Partial') }}</small></span></td><td :title="costs(day.usage)"><div v-for="cost in day.usage.costs" :key="cost.currency">{{ compactCost(cost.amount) }} <span class="unit">{{ cost.currency }}</span></div><span v-if="!day.usage.costs.length">{{ t('Unavailable') }}</span><small v-if="day.usage.unknownCostCalls" class="partial">{{ t('Partial') }}</small></td><td :title="duration(day.usage)">{{ compactDuration(day.usage.durationMs) }} <small v-if="day.usage.unknownDurationCalls" class="partial">{{ t('Partial') }}</small></td><td :title="formatNumber(day.usage.calls)">{{ compactNumber(day.usage.calls) }}</td></tr></tbody>
        </table>
      </div>
      <details class="completeness"><summary>{{ t('Data completeness') }}</summary><p>{{ t('Selected summary period: {period}', { period: t(periods.find(p => p.key === selectedPeriod)!.label) }) }}</p><ul><li>{{ t('Missing token telemetry: {count} calls', { count: selectedUsage.unknownTokenCalls }) }}</li><li>{{ t('Missing cost telemetry: {count} calls', { count: selectedUsage.unknownCostCalls }) }}</li><li>{{ t('Missing duration telemetry: {count} calls', { count: selectedUsage.unknownDurationCalls }) }}</li></ul><p>{{ t('Coverage: {untracked} sessions without complete tracking; {undated} undated calls excluded. Scan capped: {capped}. Totals may be lower bounds.', { untracked: data.untrackedSessions, undated: data.undatedCalls, capped: data.scanLimitReached ? t('Yes') : t('No') }) }}</p><table class="coverage-table"><thead><tr><th>{{ t('Date') }}</th><th>{{ t('Missing tokens / cost / duration') }}</th></tr></thead><tbody><tr v-for="day in dailyPage?.daily ?? []" :key="day.date"><th>{{ day.date }}</th><td>{{ day.usage.unknownTokenCalls }} / {{ day.usage.unknownCostCalls }} / {{ day.usage.unknownDurationCalls }}</td></tr></tbody></table></details>
      <details class="methodology"><summary>{{ t('How usage is measured') }}</summary>
      <p>{{ t('As of {time}. Calendar dates use UTC; past 7 days includes today and the previous 6 days.', { time: formatDateTime(data.asOf, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) }) }}</p>
      <p>{{ t('Costs are persisted provider/model estimates, not invoices. Currencies and AI credits are not converted or added together.') }}</p>
      <p>{{ t('Time is summed provider-call elapsed time, including failed calls, excluding tools and user waiting. Concurrent calls overlap; this is not wall-clock work time. Older calls may have no duration.') }}</p>
      <p class="notice">{{ t('Values are known subtotals. Missing telemetry is unavailable, not zero; partial marks calls with missing data.') }}</p>

      </details>
    </template>
    <p v-else-if="!loading && !error">{{ t('No usage loaded yet.') }}</p>
  </section>
</template>
<script setup lang="ts">
import UiSelect from './UiSelect.vue'
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import { compactUsageNumber, compactUsageCost, durationParts, usageWindow, lineSegments, tokenShares, costWindow, costUnits, type CostUnit, type UsagePoint } from '../project-usage-charts.ts'
import { apiUrl } from '../api-url.ts'
import { t, formatDateTime, formatNumber } from '../i18n.ts'
import { projectUsageSchema, projectUsagePageSchema, type ProjectUsagePage, type ProjectUsage, type ProjectUsageMetrics } from '../../../src/projects/usage-contract.ts'
const props = defineProps<{ apiBase: string; projectId: string; active: boolean }>()
const data = shallowRef<ProjectUsage>(), loading = ref(false), error = ref(false)
const periods = [{ key: 'today', label: 'Today' }, { key: 'past7Days', label: 'Past 7 days' }, { key: 'month', label: 'This month' }, { key: 'total', label: 'All time' }] as const
const selectedPeriod = ref<typeof periods[number]['key']>('past7Days')
const selectedUsage = computed(() => data.value![selectedPeriod.value])
const hasMissing = computed(() => !!data.value && (data.value.scanLimitReached || data.value.untrackedSessions > 0 || data.value.undatedCalls > 0 || [data.value.total, ...data.value.daily.map(d => d.usage)].some(u => u.tokens === null || u.durationMs === null || u.unknownTokenCalls || u.unknownCostCalls || u.unknownDurationCalls)))
function compactNumber(value: number | null) { return value === null ? t('Unavailable') : compactUsageNumber(value, formatNumber) }
function compactCost(value: number) { return compactUsageCost(value, formatNumber) }
function exactCost(cost: ProjectUsageMetrics['costs'][number]) { return `${formatNumber(cost.amount, { maximumSignificantDigits: 21 })} ${cost.currency}` }
function compactDuration(ms: number | null) {
  if (ms === null) return t('Unavailable')
  const { hours, minutes, seconds } = durationParts(ms)
  if (hours) return t('{hours}h {minutes}m {seconds}s', { hours, minutes, seconds })
  if (minutes) return t('{minutes}m {seconds}s', { minutes, seconds })
  return t('{seconds} s', { seconds: formatNumber(seconds, { maximumFractionDigits: 1 }) })
}
const windowDays = ref(7)
const points = computed(() => data.value ? usageWindow(data.value, windowDays.value) : [])
const costUnit = ref<CostUnit>('USD')
const costChosen = ref(false)
watch(points, () => {
  if (!costChosen.value) {
    const available = points.value.flatMap(p => p.usage?.costs ?? [])
    if (available.length && !available.some(c => c.currency === costUnit.value)) costUnit.value = available[0]!.currency
  }
})
const costPoints = computed(() => costWindow(points.value, costUnit.value))
const costMax = computed(() => Math.max(1e-12, ...costPoints.value.map(p => p.amount ?? 0)))
function costLabel(point: ReturnType<typeof costWindow>[number]) {
  const value = point.amount === null ? t('Unavailable') : `${formatNumber(point.amount, { maximumSignificantDigits: 21 })} ${costUnit.value}`
  const missing = points.value.find(p => p.date === point.date)?.usage?.unknownCostCalls ?? 0
  return `${point.date}: ${partial(value, missing)}`
}
const tokenMax = computed(() => Math.max(1, ...points.value.map(p => p.tokens ?? 0)))
const timeMax = computed(() => Math.max(1, ...points.value.map(p => p.seconds ?? 0)))
const segments = computed(() => lineSegments(points.value, timeMax.value))
const shares = computed(() => tokenShares(points.value))
const knownTokens = computed(() => points.value.reduce((sum, p) => sum + (p.tokens ?? 0), 0))
// Use the same blue at stepped strengths, not semantic status colors for dates.
const palette = ['var(--c-primary)', 'color-mix(in srgb, var(--c-primary) 80%, var(--c-bg-card))', 'color-mix(in srgb, var(--c-primary) 60%, var(--c-bg-card))', 'color-mix(in srgb, var(--c-primary) 40%, var(--c-bg-card))', 'color-mix(in srgb, var(--c-primary) 20%, var(--c-bg-card))', 'var(--c-text-muted)']
function pointLabel(point: UsagePoint, metric: 'tokens' | 'seconds') {
  return `${point.date}: ${point.usage ? metric === 'tokens' ? tokens(point.usage) : duration(point.usage) : t('Unavailable')}`
}
const maximum = computed(() => dailyPage.value?.daily.reduce((max, day) => Math.max(max, day.usage.tokens ?? 0), 1) ?? 1)
function partial(value: string, missing: number) { return missing ? t('{value} (partial; {count} calls missing)', { value, count: missing }) : value }
function tokens(usage: ProjectUsageMetrics) { return partial(usage.tokens === null ? t('Unavailable') : formatNumber(usage.tokens), usage.unknownTokenCalls) }
function costs(usage: ProjectUsageMetrics) {
  return partial(usage.costs.length ? usage.costs.map(cost => `${formatNumber(cost.amount, { maximumSignificantDigits: 21 })} ${cost.currency}`).join(' · ') : t('Unavailable'), usage.unknownCostCalls)
}
function duration(usage: ProjectUsageMetrics) {
  return partial(usage.durationMs === null ? t('Unavailable') : t('{seconds} s', { seconds: formatNumber(usage.durationMs / 1000, { maximumFractionDigits: 3 }) }), usage.unknownDurationCalls)
}
const dailyPage = shallowRef<ProjectUsagePage>()
const pageLoading = ref(false), pageError = ref(false), requestedPage = ref(1)
let pageController: AbortController | undefined
function resetPage() {
  pageController?.abort(); pageController = undefined
  dailyPage.value = undefined; pageLoading.value = false; pageError.value = false; requestedPage.value = 1
}
async function loadPage(page: number) {
  if (!props.active || !data.value || loading.value) return
  pageController?.abort()
  const current = new AbortController(); pageController = current
  requestedPage.value = page; pageLoading.value = true; pageError.value = false
  try {
    const response = await fetch(apiUrl(props.apiBase, `/api/project/usage/daily?page=${page}`), { signal: current.signal, cache: 'no-store' })
    if (!response.ok) throw new Error('Usage page request failed')
    const result = projectUsagePageSchema.parse(await response.json())
    if (result.projectId !== props.projectId || result.page !== page) throw new Error('Usage page mismatch')
    if (pageController === current && !current.signal.aborted) dailyPage.value = result
  } catch {
    if (pageController === current && !current.signal.aborted) pageError.value = true
  } finally { if (pageController === current) pageLoading.value = false }
}
let controller: AbortController | undefined
async function refresh() {
  resetPage()
  controller?.abort()
  const current = new AbortController(); controller = current
  loading.value = true; error.value = false
  try {
    const response = await fetch(apiUrl(props.apiBase, '/api/project/usage'), { signal: current.signal })
    if (!response.ok) throw new Error('Usage request failed')
    const result = projectUsageSchema.parse(await response.json())
    if (result.projectId !== props.projectId) throw new Error('Project mismatch')
    if (controller === current && !current.signal.aborted) data.value = result
  } catch {
    if (controller === current && !current.signal.aborted) error.value = true
  } finally { if (controller === current) loading.value = false }
}
watch(() => [props.apiBase, props.projectId, props.active] as const, (_, previous) => {
  resetPage()
  controller?.abort(); controller = undefined; loading.value = false
  if (props.apiBase !== previous?.[0] || props.projectId !== previous?.[1]) { data.value = undefined; error.value = false }
  if (props.active) void refresh()
}, { immediate: true })
onUnmounted(() => { controller?.abort(); resetPage() })
</script>
<style scoped>
/* Shape and palette inherit the workbench theme, including .dark overrides. */
.project-usage { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 16px; color: var(--c-text); background: var(--c-bg-soft); container: usage / inline-size; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
h2 { margin: 0; font-size: 16px; font-weight: 600; }
h3 { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; }
p { margin: 8px 0; font-size: 12px; line-height: 1.5; color: var(--c-text-secondary); }
.notice { color: var(--c-warn); }
.btn { cursor: pointer; }
.btn:disabled { cursor: default; }
.period-switch, .window-switch { display: flex; flex-wrap: wrap; gap: 0; }
.period-switch { margin-bottom: 12px; }
.period-switch .btn + .btn, .window-switch .btn + .btn { margin-left: -1px; }
:is(.period-switch, .window-switch) .btn[aria-pressed="true"] { position: relative; background: var(--c-selection-bg); border-color: var(--c-selection-border); color: var(--c-primary); }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.metric-card, .chart-card { min-width: 0; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); padding: 16px; }
.metric-card { min-height: 112px; }
.metric-card h3 { margin-bottom: 12px; color: var(--c-text-secondary); font-size: 12px; font-weight: 500; }
.metric-value { font-size: 28px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.cost-values { display: grid; gap: 4px; }
.cost-values .metric-value { font-size: 24px; }
.unit { color: var(--c-text-secondary); font-size: 12px; font-weight: 400; }
.unavailable { color: var(--c-text-secondary); font-size: 20px; font-weight: 500; }
.partial { color: var(--c-text-muted); font-size: 11px; font-weight: 400; }
.metric-card > .partial { display: block; margin-top: 6px; }
.scope-brief { margin: 8px 0; }
.chart-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin: 24px 0 12px; }
.chart-toolbar p { margin: 4px 0 0; }
.charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; align-items: stretch; }
/* All four cards share heading, caption, fixed plot and footer slots. */
.chart-card { display: grid; grid-template-rows: 40px 46px 210px 72px; align-content: start; }
.chart-card > p { margin: 0; }
.chart-card > svg { display: block; width: 100%; height: 210px; overflow: hidden; }
.chart-stat { align-self: end; font-variant-numeric: tabular-nums; }
.cost-heading { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
.cost-heading label { display: flex; align-items: center; gap: 6px; color: var(--c-text-secondary); font-size: 12px; white-space: nowrap; }
.cost-heading .ui-select { width: 110px; font-size: 12px; }
.empty-chart { display: grid; place-content: center; height: 210px; text-align: center; }
.axis { fill: var(--c-text-secondary); font-size: 11px; }
.grid-line { stroke: var(--c-border); }
.token-bar, .cost-bar { fill: var(--c-primary); }
.time-line { fill: none; stroke: var(--c-primary); stroke-width: 2.5; }
.time-point { fill: var(--c-primary); stroke: var(--c-bg-card); stroke-width: 1; }
.missing { fill: var(--c-text-muted); }
.cost-partial { fill-opacity: .55; stroke: var(--c-text); stroke-width: 1; stroke-dasharray: 3 2; }
.share-card { grid-column: 2; grid-row: 1; }
.share-card .donut { grid-row: 3; width: 180px; justify-self: center; }
.share-empty { grid-row: 3; }
.donut-track { stroke: var(--c-border-soft); }
.donut-value { fill: var(--c-text); font-size: 18px; font-weight: 600; }
.share-legend { grid-row: 4; align-self: start; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; list-style: none; padding: 0; margin: 0; font-size: 11px; }
.share-legend li { min-width: 0; display: flex; align-items: center; gap: 6px; }
.share-legend strong { margin-left: auto; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
.swatch { flex: none; width: 10px; height: 10px; border-radius: var(--radius-sm); }
.pagination { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; color: var(--c-text-secondary); font-size: 12px; }
.daily-table { overflow-x: auto; margin: 12px 0 24px; }
table { width: 100%; border-collapse: collapse; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--c-border-soft); min-width: 100px; }
th:first-child { text-align: left; }
thead th { color: var(--c-text-secondary); font-weight: 500; }
tbody th { font-weight: 400; }
td { position: relative; }
.trend { position: absolute; inset: 8px auto 8px 0; background: var(--c-selection-bg); border-radius: var(--radius-sm); }
.value { position: relative; }
details { border-top: 1px solid var(--c-border); padding: 12px 0; font-size: 12px; }
summary { cursor: pointer; color: var(--c-text-secondary); }
details li { line-height: 1.8; color: var(--c-text-secondary); }
.coverage-table { width: auto; font-size: 11px; }
svg [tabindex]:focus-visible, .daily-table:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
/* Respond to the available panel width, not the viewport behind the sidebar. */
@container usage (max-width: 850px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .charts { grid-template-columns: minmax(0, 1fr); }
  .share-card { grid-column: auto; grid-row: auto; }
}
@container usage (max-width: 380px) {
  .summary-grid { gap: 8px; }
  .metric-card, .chart-card { padding: 12px; }
  .metric-value, .cost-values .metric-value { font-size: 22px; }
  .cost-heading label { gap: 4px; }
  .cost-heading .ui-select { width: 94px; }
  .share-legend { grid-template-columns: minmax(0, 1fr); }
  .chart-card { grid-template-rows: 56px 72px 210px 112px; }
}
</style>
