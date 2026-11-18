<template>
  <section class="diagnostics" :aria-label="t('Request quality')">
    <h3>{{ t('Request quality') }}</h3>
    <p>{{ t('All dated records through each snapshot, independent of the summary and trend windows. Percentiles use observed samples within each project.') }}</p>
    <p v-if="!projects.length || !projects.some(project => project.usage?.requestQuality)">{{ t('Unavailable') }}</p>
    <details v-for="project in projects" :key="project.id" :open="projects.length === 1">
      <summary>{{ project.name || t('Selected project') }}<template v-if="!project.usage?.requestQuality"> · {{ t('Unavailable') }}</template></summary>
      <template v-if="project.usage?.requestQuality">
        <p>{{ through(project.usage.requestQuality.asOf) }} · {{ coverage(project.usage.requestQuality.coverage) }}</p>
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
      </template>
    </details>
  </section>
  <section v-if="projects.some(project => project.usage?.recall)" class="diagnostics" :aria-label="t('Recall')">
    <div class="heading"><h3>{{ t('Recall') }}</h3><div role="group" :aria-label="t('Recall type')">
      <button v-for="item in recallTypes" :key="item.key" class="btn btn-sm" type="button" :aria-pressed="recallType === item.key" @click="recallType = item.key">{{ t(item.label) }}</button>
    </div></div>
    <p>{{ t('Cumulative recorded reads, up to 100 entries per project. Legacy Skill counts have no dates. Summary and trend windows do not apply.') }}</p>
    <details v-for="project in projects" :key="project.id" :open="projects.length === 1">
      <summary>{{ project.name || t('Selected project') }}<template v-if="!project.usage?.recall"> · {{ t('Unavailable') }}</template></summary>
      <UsageBreakdown v-if="project.usage?.recall" :title="t(recallType === 'skills' ? 'Skill body reads' : 'Memory recall')" :category="t('Entry')"
        :description="coverage(project.usage.recall.coverage)" :count-label="t('Reads')" :allow-ring="false" :scope="`${project.id}:${recallType}`"
        :rows="recallType === 'skills' ? project.usage.recall.skills.map(row => ({ id: row.entry, name: row.entry, calls: row.reads }))
          : project.usage.recall.memory.map(row => ({ id: `${row.source}:${row.entry}`, name: `${row.entry} · ${t(row.source === 'active' ? 'Active Wiki read' : 'Automatic log brief')}`, calls: row.reads }))" />
    </details>
  </section>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { formatDateTime, formatNumber, t, type MessageKey } from '../i18n.ts'
import type { ProjectUsage } from '../../../src/projects/usage-contract.ts'
import UsageBreakdown from './UsageBreakdown.vue'
defineProps<{ projects: { id: string; name: string; usage?: ProjectUsage | null }[] }>()
const recallType = ref<'skills' | 'memory'>('skills')
const recallTypes = [{ key: 'skills', label: 'Skill' }, { key: 'memory', label: 'Memory' }] as const
const latency = [{ key: 'firstText', label: 'First streamed text' }, { key: 'queue', label: 'Queue latency' }, { key: 'duration', label: 'Request duration' }] as const
const telemetry = [
  { value: 'inputTokens', samples: 'requestsWithInputTokens', label: 'Input tokens' },
  { value: 'outputTokens', samples: 'requestsWithOutputTokens', label: 'Output tokens' },
  { value: 'readTokens', samples: 'requestsWithReadTokens', label: 'Cache read tokens' },
  { value: 'writeTokens', samples: 'requestsWithWriteTokens', label: 'Cache write tokens' },
] as const
function number(value: number | null) { return value === null ? t('Unavailable') : formatNumber(value) }
function milliseconds(value: number | null) { return value === null ? t('Unavailable') : `${number(value)} ms` }
function coverage(value: string) { return t(value === 'complete' ? 'Index backfill complete' : 'Index coverage partial') }
function through(asOf: string) { return t('As of {time} UTC', { time: formatDateTime(asOf, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) }) }
function outcome(value: string) { return t(({ success: 'Succeeded', failure: 'Failed', cancelled: 'Cancelled', aborted: 'Cancelled', unknown: 'Unknown' } as Record<string, MessageKey>)[value] ?? 'Unknown') }
function observation(value: string) { return t(({ stream_text: 'First text observed', stream_no_text: 'Stream without text', tool_only: 'Tool-only response', nonstream: 'Non-streamed response', unknown: 'Unknown text observation' } as Record<string, MessageKey>)[value] ?? 'Unknown') }
</script>
<style scoped>
.diagnostics { margin-block: 24px; min-width: 0; }
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.heading button[aria-pressed=true] { background: var(--c-selection-bg); color: var(--c-primary); }
h3 { margin: 0; font-size: 13px; font-weight: 600; }
p, details { font-size: 12px; color: var(--c-text-secondary); }
details { border-top: 1px solid var(--c-border); padding: 10px 0; }
summary { cursor: pointer; margin-bottom: 6px; overflow-wrap: anywhere; }
.tables { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 16px; }
.scroll { overflow: auto; }
table { width: 100%; text-align: end; border-collapse: collapse; font-variant-numeric: tabular-nums; }
caption { text-align: start; font-weight: 600; color: var(--c-text); }
th, td { padding: 6px; border-bottom: 1px solid var(--c-border-soft); font-weight: 400; }
th:first-child { text-align: start; }
</style>
