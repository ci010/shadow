<template>
  <div class="usage-chart">
    <div class="chart-interaction" tabindex="0" role="group" :aria-label="title" :aria-describedby="hintId"
      @keydown="onKey" @focus="select(points.length - 1)" @blur="dismiss">
      <div ref="host" class="echart-plot" aria-hidden="true" />
    </div>
    <p :id="hintId" class="chart-readout" role="status" aria-live="polite">{{ selectedLabel || t('Hover or tap a date; use left and right arrow keys when focused.') }}</p>
    <p v-if="failed" role="alert">{{ t('Chart unavailable. Use the data table below.') }}</p>
    <details class="chart-data" :open="failed || undefined">
      <summary>{{ t('View chart data') }}</summary>
      <table :aria-label="title"><tbody><tr v-for="point in points" :key="point.date"><th scope="row">{{ point.date }}</th><td>{{ point.label.slice(point.date.length + 2) }}</td></tr></tbody></table>
    </details>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import type { EChartsType } from 'echarts/core'
import { t } from '../i18n.ts'
import { usageChartOption, type UsageChartDatum } from '../usage-chart-options.ts'

const props = defineProps<{ title: string; kind: 'bar' | 'line'; points: UsageChartDatum[]; formatAxis: (value: number) => string; minInterval?: number }>()
const host = ref<HTMLDivElement>()
const hintId = useId()
const selected = ref<number | null>(null)
const selectedLabel = computed(() => selected.value === null ? '' : props.points[selected.value]?.label ?? '')
const failed = ref(false)
let chart: EChartsType | undefined
let resize: ResizeObserver | undefined
let theme: MutationObserver | undefined
let disposed = false

function render() {
  if (!chart || !host.value) return
  const css = getComputedStyle(host.value)
  const color = (name: string) => css.getPropertyValue(`--c-${name}`).trim()
  chart.setOption(usageChartOption(props.title, props.kind, props.points, {
    primary: color('primary'), text: color('text'), muted: color('text-secondary'),
    border: color('border'), surface: color('bg-card'), selection: color('selection-bg'),
  }, props.formatAxis, props.minInterval), { notMerge: true })
}
function select(index: number) {
  if (!props.points.length) return
  selected.value = Math.max(0, Math.min(props.points.length - 1, index))
  chart?.dispatchAction({ type: 'downplay', seriesIndex: 0 })
  chart?.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: selected.value })
  chart?.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: selected.value })
}
function dismiss() {
  selected.value = null
  chart?.dispatchAction({ type: 'hideTip' })
  chart?.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' })
  chart?.dispatchAction({ type: 'downplay', seriesIndex: 0 })
}
function onKey(event: KeyboardEvent) {
  if (event.target !== event.currentTarget) return
  const index = selected.value ?? props.points.length - 1
  if (event.key === 'ArrowLeft') select(index - 1)
  else if (event.key === 'ArrowRight') select(index + 1)
  else if (event.key === 'Home') select(0)
  else if (event.key === 'End') select(props.points.length - 1)
  else if (event.key === 'Escape') dismiss()
  else return
  event.preventDefault()
}
watch(() => [props.title, props.kind, props.points, props.formatAxis, props.minInterval], () => { dismiss(); render() })
onMounted(async () => {
  try {
    const { init } = await import('../usage-chart-engine.ts')
    if (disposed || !host.value) return
    chart = init(host.value, undefined, { renderer: 'canvas' })
    chart.on('updateAxisPointer', (event: unknown) => {
      const value = (event as { axesInfo?: { value?: unknown }[] }).axesInfo?.[0]?.value
      const index = typeof value === 'number' ? value : props.points.findIndex(p => p.date === value)
      if (Number.isInteger(index) && index >= 0 && index < props.points.length) selected.value = index
    })
    chart.getZr().on('globalout', () => {
      if (document.activeElement !== host.value?.parentElement) dismiss()
    })
    render()
    resize = new ResizeObserver(() => { if (host.value?.clientWidth) chart?.resize() })
    resize.observe(host.value)
    theme = new MutationObserver(() => { dismiss(); render() })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  } catch {
    if (!disposed) failed.value = true
  }
})
onUnmounted(() => { disposed = true; resize?.disconnect(); theme?.disconnect(); chart?.dispose(); chart = undefined })
</script>
<style scoped>
.usage-chart { min-width: 0; width: 100%; margin-top: auto; }
.chart-interaction { min-width: 0; outline-offset: 2px; }
.chart-interaction:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); }
.echart-plot { width: 100%; height: 240px; }
.chart-readout { min-height: 36px; margin: 8px 0; font-size: 12px; line-height: 1.5; color: var(--c-text-secondary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
p { font-size: 12px; color: var(--c-text-secondary); }
.chart-data { font-size: 12px; color: var(--c-text-secondary); }
summary { cursor: pointer; width: fit-content; padding: 6px 0; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; margin-top: 8px; }
th, td { padding: 8px 0; border-top: 1px solid var(--c-border-soft); text-align: left; vertical-align: top; }
th { font-weight: 400; white-space: nowrap; padding-right: 12px; }
td { overflow-wrap: anywhere; }
</style>
