<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import type { AnswerData } from '../../../src/shared/answer-data.ts'
import AnswerDataTable from './AnswerDataTable.vue'
const props = defineProps<{ data: AnswerData }>()
const plot = computed(() => {
  const { kind, rows } = props.data
  if (kind === 'table') return
  const values = rows.map(([, value]) => value)
  const min = Math.min(0, ...values), max = Math.max(0, ...values)
  const scale = Math.max(Math.abs(min), Math.abs(max)) || 1
  const low = min / scale, high = max / scale
  const y = (value: number) => 158 - 144 * ((value / scale - low) / (high - low || 1))
  const step = 440 / values.length
  const marks = values.map((value, i) => ({ x: 10 + step * (i + 0.5), y: y(value) }))
  return { marks, width: step * 0.7, zero: y(0), min, max, points: marks.map(p => `${p.x},${p.y}`).join(' ') }
})
</script>

<template>
  <figure class="answer-data" :aria-label="data.title || t('Computed data')">
    <figcaption v-if="data.title">{{ data.title }}</figcaption>
    <template v-if="plot">
      <div class="value-axis">{{ data.columns[1] }} · {{ plot.min }} — {{ plot.max }}</div>
      <svg viewBox="0 0 460 172" aria-hidden="true">
        <line x1="10" x2="450" :y1="plot.zero" :y2="plot.zero" class="baseline" />
        <g v-if="data.kind === 'bar'" class="marks">
          <rect v-for="(mark, i) in plot.marks" :key="i" :x="mark.x - plot.width / 2" :y="Math.min(mark.y, plot.zero)" :width="plot.width" :height="Math.abs(mark.y - plot.zero)" />
        </g>
        <g v-else class="marks">
          <polyline :points="plot.points" fill="none" stroke="currentColor" stroke-width="2" />
          <circle v-for="(mark, i) in plot.marks" :key="i" :cx="mark.x" :cy="mark.y" r="3" />
        </g>
      </svg>
      <div class="category-axis"><span>{{ data.rows[0][0] }}</span><span>{{ data.columns[0] }}</span><span>{{ data.rows.at(-1)?.[0] }}</span></div>
      <details><summary>{{ t('Chart values') }}</summary><AnswerDataTable :data="data" /></details>
    </template>
    <AnswerDataTable v-else :data="data" />
  </figure>
</template>

<style scoped>
.answer-data { margin: .5rem 0 1rem; padding: .75rem; min-width: 0; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); overflow-wrap: anywhere; }
figcaption { font-weight: 600; margin-bottom: .5rem; }
svg { display: block; width: 100%; max-height: 16rem; }
.marks { color: var(--c-primary); fill: currentColor; }
.baseline { stroke: var(--c-text-muted); }
.value-axis, .category-axis { color: var(--c-text-secondary); font-size: .85em; }
.category-axis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; }
.category-axis span:nth-child(2) { text-align: center; }
.category-axis span:last-child { text-align: right; }
details { margin-top: .5rem; }
</style>
