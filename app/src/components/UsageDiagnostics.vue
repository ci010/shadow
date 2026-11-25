<template>
  <section class="diagnostics" :aria-label="t('Request quality')">
    <h3>{{ t('Request quality') }}</h3>
    <div class="quality-charts">
      <UsageBreakdown v-for="chart in charts" :key="chart.key" :title="t(chart.title)"
        :category="t(dimensions.find(item => item.key === groups[chart.key])!.label)" :count-label="t(chart.title)"
        :rows="chartRows(chart.key)" :scope="`${period}:${groups[chart.key]}:${latencyMetric}:${projects.map(project => project.id).join(',')}`"
        allow-column :allow-ring="chart.key === 'outcomes'" :format-value="formatters[chart.key]">
        <template #controls>
          <UiSelect v-if="chart.key === 'latency'" v-model="latencyMetric" :aria-label="t('Measurement')">
            <option v-for="entry in latencyOptions" :key="entry.key" :value="entry.key">{{ t(entry.label) }} · {{ entry.percentile }}</option>
          </UiSelect>
          <UiSelect v-model="groups[chart.key]" :aria-label="t('Group by')">
            <option v-for="item in dimensions" :key="item.key" :value="item.key">{{ t(item.label) }}</option>
          </UiSelect>
        </template>
      </UsageBreakdown>
    </div>
    <details class="raw-data" v-if="scopedProjects.some(project => project.quality)">
      <summary>{{ t('Request quality details') }}</summary>
      <UiSelect v-model="detailProject" :aria-label="t('Project')">
        <option v-for="entry in scopedProjects.filter(entry => entry.quality)" :key="entry.id" :value="entry.id">{{ entry.name || t('Selected project') }}</option>
      </UiSelect>
      <template v-if="project?.quality">
          <div class="tables">
            <div class="scroll" tabindex="0" :aria-label="t('Request outcomes')">
              <table><caption>{{ t('Request outcomes') }}</caption><thead><tr><th scope="col">{{ t('Result') }}</th><th scope="col">{{ t('Requests') }}</th><th scope="col">{{ t('Observed attempts') }}</th><th scope="col">{{ t('Requests with attempt data') }}</th></tr></thead>
                <tbody><tr v-for="row in project.quality.outcomes" :key="row.outcome"><th scope="row">{{ outcome(row.outcome) }}</th><td>{{ number(row.requests) }}</td><td>{{ number(row.observedAttempts) }}</td><td>{{ number(row.requestsWithAttempts) }}</td></tr></tbody>
              </table>
              <p v-if="!project.quality.outcomes.length">{{ t('No recorded requests.') }}</p>
              <p v-for="row in project.quality.textObservations" :key="row.observation">{{ observation(row.observation) }}: {{ number(row.requests) }}</p>
            </div>
            <div class="scroll" tabindex="0" :aria-label="t('Request latency')">
              <table><caption>{{ t('Request latency') }}</caption><thead><tr><th scope="col">{{ t('Measurement') }}</th><th scope="col">P50</th><th scope="col">P95</th><th scope="col">{{ t('Samples') }}</th></tr></thead>
                <tbody><tr v-for="entry in latency" :key="entry.key"><th scope="row">{{ t(entry.label) }}</th><td>{{ milliseconds(project.quality[entry.key].p50Ms) }}</td><td>{{ milliseconds(project.quality[entry.key].p95Ms) }}</td><td>{{ number(project.quality[entry.key].samples) }}</td></tr></tbody>
              </table>
            </div>
            <div class="scroll" tabindex="0" :aria-label="t('Token telemetry')">
              <table><caption>{{ t('Token telemetry') }}</caption><thead><tr><th scope="col">{{ t('Measurement') }}</th><th scope="col">{{ t('Known tokens') }}</th><th scope="col">{{ t('Requests reporting') }}</th></tr></thead>
                <tbody><tr v-for="entry in telemetry" :key="entry.value"><th scope="row">{{ t(entry.label) }}</th><td>{{ number(project.quality.cache[entry.value]) }}</td><td>{{ number(project.quality.cache[entry.samples]) }} / {{ number(project.quality.outcomes.reduce((sum, row) => sum + row.requests, 0)) }}</td></tr></tbody>
              </table>
            </div>
          </div>
      </template>
    </details>
  </section>
</template>
<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { formatNumber, t, type MessageKey } from '../i18n.ts'
import type { ProjectUsage } from '../../../src/projects/usage-contract.ts'
import UiSelect from './UiSelect.vue'
import UsageBreakdown from './UsageBreakdown.vue'
const props = defineProps<{ projects: { id: string; name: string; usage?: ProjectUsage | null }[]; period: 'today' | 'past7Days' | 'month' | 'total' }>()
const scopedProjects = computed(() => props.projects.map(project => {
  const periodData = project.usage?.requestQualityByPeriod?.[props.period]
  return { ...project, periodData, quality: periodData ?? (props.period === 'total' ? project.usage?.requestQuality : undefined) }
}))
const detailSelection = ref('')
const project = computed(() => scopedProjects.value.find(row => row.quality && row.id === detailSelection.value) ?? scopedProjects.value.find(row => row.quality))
const detailProject = computed({ get: () => project.value?.id ?? '', set: value => { detailSelection.value = value } })
const charts = [{ key: 'outcomes', title: 'Request outcomes' }, { key: 'latency', title: 'Request latency' }, { key: 'speed', title: 'Estimated output speed' }] as const
const dimensions = [{ key: 'project', label: 'Project' }, { key: 'model', label: 'Model' }, { key: 'provider', label: 'Provider' }] as const
type Chart = typeof charts[number]['key']
type Dimension = typeof dimensions[number]['key']
type Quality = NonNullable<ProjectUsage['requestQuality']>
type QualityRow = { id: string; name: string; calls?: number; rate?: Quality['outputRate'] }
const groups = reactive<Record<Chart, Dimension>>({ outcomes: 'project', latency: 'project', speed: 'model' })
const latency = [{ key: 'firstText', label: 'First streamed text' }, { key: 'queue', label: 'Queue latency' }, { key: 'duration', label: 'Request duration' }] as const
const latencyOptions = latency.flatMap(item => (['p50Ms', 'p95Ms'] as const).map(field => ({ ...item, field, percentile: field === 'p50Ms' ? 'P50' : 'P95' })))
  .map(item => ({ ...item, measurement: item.key, key: `${item.key}:${item.field}` }))
const latencyMetric = ref('firstText:p50Ms')
const formatters = { outcomes: number, latency: milliseconds, speed: formatOutputRate }
function chartRows(chart: Chart) {
  const dimension = groups[chart]
  const measurement = latencyOptions.find(item => item.key === latencyMetric.value) ?? latencyOptions[0]!
  const rows = scopedProjects.value.flatMap(project => {
    const projectName = project.name || t('Selected project')
    const groups: { id: string; name: string; quality: Quality }[] = dimension === 'project'
      ? project.quality ? [{ id: project.id, name: projectName, quality: project.quality }] : []
      : dimension === 'model'
        ? (project.periodData?.models ?? []).map(row => ({ id: JSON.stringify(['model', row.model, ...(chart === 'latency' ? [row.provider] : [])]), name: chart === 'latency' && row.provider ? `${row.model ?? t('Unknown')} · ${row.provider}` : row.model ?? t('Unknown'), quality: row.quality }))
        : (project.periodData?.providers ?? []).map(row => ({ id: JSON.stringify(['provider', row.provider]), name: row.provider ?? t('Unknown'), quality: row.quality }))
    return groups.flatMap<QualityRow>(row => {
      const splitByProject = chart === 'latency' && dimension !== 'project'
      const name = splitByProject && scopedProjects.value.length > 1 ? `${row.name} · ${projectName}` : row.name
      const id = splitByProject ? JSON.stringify([project.id, row.id]) : row.id
      if (chart === 'outcomes') return row.quality.outcomes.map(entry => ({ id: `${id}:${entry.outcome}`, name: `${name} · ${outcome(entry.outcome)}`, calls: entry.requests }))
      const value = chart === 'speed' ? row.quality.outputRate?.tokensPerSecond : row.quality[measurement.measurement][measurement.field]
      return [{ id, name, calls: value ?? undefined, rate: row.quality.outputRate }]
    })
  })
  if (dimension === 'project' || chart === 'latency') return rows
  const totals = new Map<string, { id: string; name: string; calls?: number; tokens: number; durationMs: number }>()
  for (const row of rows) {
    const total = totals.get(row.id) ?? { id: row.id, name: row.name, tokens: 0, durationMs: 0 }
    if (chart === 'speed' && row.rate) {
      total.tokens += row.rate.outputTokens
      total.durationMs += row.rate.activeDurationMs
      total.calls = total.durationMs > 0 ? total.tokens * 1000 / total.durationMs : undefined
    } else if (chart === 'outcomes') total.calls = (total.calls ?? 0) + (row.calls ?? 0)
    totals.set(row.id, total)
  }
  return [...totals.values()]
}
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
function outcome(value: string) { return t(({ success: 'Succeeded', failure: 'Failed', cancelled: 'Cancelled', aborted: 'Cancelled', unknown: 'Unknown' } as Record<string, MessageKey>)[value] ?? 'Unknown') }
function observation(value: string) { return t(({ stream_text: 'First text observed', stream_no_text: 'Stream without text', tool_only: 'Tool-only response', nonstream: 'Non-streamed response', unknown: 'Unknown text observation' } as Record<string, MessageKey>)[value] ?? 'Unknown') }
</script>
<style scoped>
.diagnostics { margin-block: 24px; min-width: 0; }
h3 { margin: 0; font-size: 13px; font-weight: 600; }
p, details { font-size: 12px; color: var(--c-text-secondary); }
details { border-top: 1px solid var(--c-border); padding: 10px 0; }
summary { cursor: pointer; margin-bottom: 6px; overflow-wrap: anywhere; }
.quality-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 410px), 1fr)); gap: 16px; margin-block: 14px; }
.tables { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 16px; }
.scroll { overflow: auto; }
table { width: 100%; text-align: end; border-collapse: collapse; font-variant-numeric: tabular-nums; }
caption { text-align: start; font-weight: 600; color: var(--c-text); }
th, td { padding: 6px; border-bottom: 1px solid var(--c-border-soft); font-weight: 400; }
th:first-child { text-align: start; }
</style>
