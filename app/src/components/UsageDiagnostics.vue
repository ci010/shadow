<template>
  <section class="diagnostics" :aria-label="t('Request quality')">
    <h3>{{ t('Request quality') }}</h3>
    <p>{{ t('All dated records through each snapshot, independent of the selected usage period. Percentiles use observed samples within each project.') }}</p>
    <p v-if="!projects.length || !projects.some(project => project.usage?.requestQuality)">{{ t('Unavailable') }}</p>
    <details v-for="project in projects" :key="project.id" :open="projects.length === 1">
      <summary>{{ project.name || t('Selected project') }}<template v-if="!project.usage?.requestQuality"> · {{ t('Unavailable') }}</template></summary>
      <template v-if="project.usage?.requestQuality">
        <p>{{ through(project.usage.requestQuality.asOf) }} · {{ coverage(project.usage.requestQuality.coverage) }}</p>
        <div class="output-rate">
          <span>{{ t('Estimated output speed') }}</span>
          <strong>{{ formatOutputRate(project.usage.requestQuality.outputRate?.tokensPerSecond) }}</strong>
          <template v-if="project.usage.requestQuality.outputRate">
            <small>{{ t('From first streamed text to attempt end. Samples: {count}.', { count: number(project.usage.requestQuality.outputRate.samples) }) }}</small>
          </template>
        </div>
        <div class="charts">
          <div class="chart">
            <h4>{{ t('Request outcomes') }}</h4>
            <p v-if="!project.usage.requestQuality.outcomes.length">{{ t('No recorded requests.') }}</p>
            <div v-for="row in project.usage.requestQuality.outcomes" :key="row.outcome" class="chart-row">
              <div class="chart-label"><span>{{ outcome(row.outcome) }}</span><strong>{{ number(row.requests) }}</strong></div>
              <div class="track" aria-hidden="true"><span :class="['bar', row.outcome]" :style="{ width: width(row.requests, totalRequests(project.usage.requestQuality)) }" /></div>
            </div>
          </div>
          <div class="chart">
            <h4>{{ t('Request latency') }}</h4>
            <div v-for="entry in latency" :key="entry.key" class="chart-row">
              <div class="chart-label"><span>{{ t(entry.label) }}</span><span>{{ t('Samples') }}: {{ number(project.usage.requestQuality[entry.key].samples) }}</span></div>
              <div v-for="percentile in percentiles" :key="percentile.key" class="latency-row">
                <span>{{ percentile.label }}</span>
                <div class="track" aria-hidden="true"><span :class="['bar', percentile.key]" :style="{ width: width(project.usage.requestQuality[entry.key][percentile.key], latencyMax(project.usage.requestQuality)) }" /></div>
                <strong>{{ milliseconds(project.usage.requestQuality[entry.key][percentile.key]) }}</strong>
              </div>
            </div>
          </div>
        </div>
        <details class="raw-data">
          <summary>{{ t('Request quality details') }}</summary>
          <div class="tables">
            <div class="scroll" tabindex="0" :aria-label="t('Request outcomes')">
              <table><caption>{{ t('Request outcomes') }}</caption><thead><tr><th scope="col">{{ t('Result') }}</th><th scope="col">{{ t('Requests') }}</th><th scope="col">{{ t('Observed attempts') }}</th><th scope="col">{{ t('Requests with attempt data') }}</th></tr></thead>
                <tbody><tr v-for="row in project.usage.requestQuality.outcomes" :key="row.outcome"><th scope="row">{{ outcome(row.outcome) }}</th><td>{{ number(row.requests) }}</td><td>{{ number(row.observedAttempts) }}</td><td>{{ number(row.requestsWithAttempts) }}</td></tr></tbody>
              </table>
              <p v-if="!project.usage.requestQuality.outcomes.length">{{ t('No recorded requests.') }}</p>
              <p v-for="row in project.usage.requestQuality.textObservations" :key="row.observation">{{ observation(row.observation) }}: {{ number(row.requests) }}</p>
            </div>
            <div class="scroll" tabindex="0" :aria-label="t('Request latency')">
              <table><caption>{{ t('Request latency') }}</caption><thead><tr><th scope="col">{{ t('Measurement') }}</th><th scope="col">P50</th><th scope="col">P95</th><th scope="col">{{ t('Samples') }}</th></tr></thead>
                <tbody><tr v-for="entry in latency" :key="entry.key"><th scope="row">{{ t(entry.label) }}</th><td>{{ milliseconds(project.usage.requestQuality[entry.key].p50Ms) }}</td><td>{{ milliseconds(project.usage.requestQuality[entry.key].p95Ms) }}</td><td>{{ number(project.usage.requestQuality[entry.key].samples) }}</td></tr></tbody>
              </table>
            </div>
            <div class="scroll" tabindex="0" :aria-label="t('Token telemetry')">
              <table><caption>{{ t('Token telemetry') }}</caption><thead><tr><th scope="col">{{ t('Measurement') }}</th><th scope="col">{{ t('Known tokens') }}</th><th scope="col">{{ t('Requests reporting') }}</th></tr></thead>
                <tbody><tr v-for="entry in telemetry" :key="entry.value"><th scope="row">{{ t(entry.label) }}</th><td>{{ number(project.usage.requestQuality.cache[entry.value]) }}</td><td>{{ number(project.usage.requestQuality.cache[entry.samples]) }} / {{ number(project.usage.requestQuality.outcomes.reduce((sum, row) => sum + row.requests, 0)) }}</td></tr></tbody>
              </table>
            </div>
          </div>
        </details>
      </template>
    </details>
  </section>
</template>
<script setup lang="ts">
import { formatDateTime, formatNumber, t, type MessageKey } from '../i18n.ts'
import type { ProjectUsage } from '../../../src/projects/usage-contract.ts'
defineProps<{ projects: { id: string; name: string; usage?: ProjectUsage | null }[] }>()
const latency = [{ key: 'firstText', label: 'First streamed text' }, { key: 'queue', label: 'Queue latency' }, { key: 'duration', label: 'Request duration' }] as const
const percentiles = [{ key: 'p50Ms', label: 'P50' }, { key: 'p95Ms', label: 'P95' }] as const
type RequestQuality = NonNullable<ProjectUsage['requestQuality']>
function totalRequests(quality: RequestQuality) { return quality.outcomes.reduce((sum, row) => sum + row.requests, 0) }
function latencyMax(quality: RequestQuality) {
  return Math.max(...latency.flatMap(({ key }) => percentiles.map(percentile => quality[key][percentile.key] ?? 0)))
}
function width(value: number | null, max: number) { return `${value === null || max === 0 ? 0 : value / max * 100}%` }
const telemetry = [
  { value: 'inputTokens', samples: 'requestsWithInputTokens', label: 'Input tokens' },
  { value: 'outputTokens', samples: 'requestsWithOutputTokens', label: 'Output tokens' },
  { value: 'readTokens', samples: 'requestsWithReadTokens', label: 'Cache read tokens' },
  { value: 'writeTokens', samples: 'requestsWithWriteTokens', label: 'Cache write tokens' },
] as const
function number(value: number | null) { return value === null ? t('Unavailable') : formatNumber(value) }
function milliseconds(value: number | null) { return value === null ? t('Unavailable') : `${number(value)} ms` }
function formatOutputRate(value: number | null | undefined) {
  return value == null ? t('Unavailable') : t('{rate} tokens/s', { rate: formatNumber(value, { maximumSignificantDigits: 3 }) })
}
function coverage(value: string) { return t(value === 'complete' ? 'Index backfill complete' : 'Index coverage partial') }
function through(asOf: string) { return t('As of {time} UTC', { time: formatDateTime(asOf, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) }) }
function outcome(value: string) { return t(({ success: 'Succeeded', failure: 'Failed', cancelled: 'Cancelled', aborted: 'Cancelled', unknown: 'Unknown' } as Record<string, MessageKey>)[value] ?? 'Unknown') }
function observation(value: string) { return t(({ stream_text: 'First text observed', stream_no_text: 'Stream without text', tool_only: 'Tool-only response', nonstream: 'Non-streamed response', unknown: 'Unknown text observation' } as Record<string, MessageKey>)[value] ?? 'Unknown') }
</script>
<style scoped>
.diagnostics { margin-block: 24px; min-width: 0; }
h3 { margin: 0; font-size: 13px; font-weight: 600; }
p, details { font-size: 12px; color: var(--c-text-secondary); }
details { border-top: 1px solid var(--c-border); padding: 10px 0; }
summary { cursor: pointer; margin-bottom: 6px; overflow-wrap: anywhere; }
.output-rate { display: grid; gap: 4px; padding: 14px 16px; margin-block: 12px; border-inline-start: 2px solid var(--c-primary); background: var(--c-bg-soft); }
.output-rate strong { font-size: 24px; color: var(--c-text); font-variant-numeric: tabular-nums; }
.output-rate small { font-size: inherit; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 12px; margin-block: 12px; }
.chart { padding: 14px 16px; border: 1px solid var(--c-border); min-width: 0; }
.chart h4 { margin: 0 0 12px; color: var(--c-text); font-size: 13px; }
.chart-row + .chart-row { margin-top: 12px; }
.chart-label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; margin-bottom: 5px; }
.chart strong { color: var(--c-text); font-variant-numeric: tabular-nums; }
.track { height: 6px; background: var(--c-bg-muted); }
.bar { display: block; height: 100%; background: var(--c-primary); }
.bar.success { background: var(--c-success); }
.bar.failure { background: var(--c-error); }
.bar.cancelled, .bar.aborted { background: var(--c-warn); }
.bar.unknown { background: var(--c-text-muted); }
.bar.p50Ms { background: var(--c-text-muted); }
.latency-row { display: grid; grid-template-columns: 3ch minmax(0, 1fr) minmax(8ch, max-content); align-items: center; gap: 8px; margin-block: 4px; }
.latency-row strong { text-align: end; }
.tables { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 16px; }
.scroll { overflow: auto; }
table { width: 100%; text-align: end; border-collapse: collapse; font-variant-numeric: tabular-nums; }
caption { text-align: start; font-weight: 600; color: var(--c-text); }
th, td { padding: 6px; border-bottom: 1px solid var(--c-border-soft); font-weight: 400; }
th:first-child { text-align: start; }
</style>
