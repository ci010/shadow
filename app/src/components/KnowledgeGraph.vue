<template>
  <section class="graph-panel" :aria-label="t('Knowledge relationship graph')">
    <div class="graph-toolbar">
      <span>{{ graph.nodes.length }} {{ t('nodes /') }} {{ graph.links.length }} {{ t('links. Arrows point to referenced entries.') }}</span>
      <label>{{ t('Zoom') }} <input v-model.number="zoom" :aria-label="t('Graph zoom')" type="range" min="50" max="150" step="10" /></label>
    </div>
    <div class="graph-scroll" tabindex="0" :aria-label="t('Scrollable relationship graph')">
      <p v-if="!graph.nodes.length" class="empty">{{ t('No entries match. Change the filter or search.') }}</p>
      <svg v-else :width="graph.width * zoom / 100" :height="graph.height * zoom / 100" :viewBox="`0 0 ${graph.width} ${graph.height}`">
        <defs><marker :id="arrowId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        <text v-for="(label, index) in ['Memory', 'Wiki', 'Skills', 'Outside catalog']" :key="label" :x="20 + index * 280" y="25" class="column-label">{{ label }}</text>
        <path v-for="(link, index) in edges" :key="index" :d="link.path" class="edge"
          :class="{ highlighted: link.source === selectedId || link.target === selectedId }" :marker-end="`url(#${arrowId})`">
          <title>{{ link.source }} → {{ link.target }} ({{ link.label }})</title>
        </path>
        <g v-for="node in graph.nodes" :key="node.id" :transform="`translate(${node.x},${node.y})`"
          class="node" :class="[node.kind, { selected: node.id === selectedId }]" role="button" tabindex="0"
          :aria-label="`${node.title}${node.kind === 'missing' ? t(' (unresolved reference)') : ''}`" :aria-pressed="node.id === selectedId"
          @click="$emit('select', node.id)" @keydown.enter.prevent="$emit('select', node.id)" @keydown.space.prevent="$emit('select', node.id)">
          <title>{{ node.id }}</title>
          <rect width="240" height="52" />
          <text x="12" y="22">{{ short(node.title, 29) }}</text>
          <text x="12" y="40" class="node-kind">{{ enumLabel(node.kind === 'missing' ? t('Unresolved / outside catalog') : node.kind) }}</text>
        </g>
      </svg>
    </div>
  </section>
</template>

<script setup lang="ts">
import { enumLabel } from '../display-labels.ts'
import { t } from '../i18n.ts'
import { computed, ref, useId } from 'vue'
import { layoutKnowledgeGraph, type KnowledgeCatalog } from '../knowledge.ts'
const props = defineProps<{ catalog: KnowledgeCatalog; visibleIds: string[]; selectedId: string }>()
defineEmits<{ select: [id: string] }>()
const zoom = ref(100)
const arrowId = `knowledge-arrow-${useId()}`
const graph = computed(() => layoutKnowledgeGraph(props.catalog, props.visibleIds))
const edges = computed(() => {
  const nodes = new Map(graph.value.nodes.map(node => [node.id, node]))
  return graph.value.links.map(link => {
    const source = nodes.get(link.source)!
    const target = nodes.get(link.target)!
    const same = source.x === target.x
    const x1 = source.x + 240
    const x2 = same ? target.x + 240 : target.x
    const y1 = source.y + 26
    const y2 = target.y + 26
    const bend = same ? x1 + 28 : (x1 + x2) / 2
    const path = link.source === link.target
      ? `M ${x1} ${y1} C ${x1 + 45} ${y1 - 55}, ${x1 + 45} ${y1 + 55}, ${x1} ${y1 + 12}`
      : `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`
    return { ...link, path }
  })
})
const short = (value: string, size: number) => value.length > size ? `${value.slice(0, size - 3)}...` : value
</script>

<style scoped>
.graph-panel { min-width: 0; border: 1px solid var(--c-border); border-radius: var(--radius-control); }
.graph-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; font-size: 12px; color: var(--c-text-secondary); }
label { display: flex; align-items: center; gap: 8px; }
.graph-scroll { overflow: auto; height: min(55vh, 480px); background: var(--c-bg-soft); }
svg { display: block; color: var(--c-text-muted); }
.column-label { fill: var(--c-text-secondary); font-size: 13px; font-weight: 600; }
.edge { fill: none; stroke: var(--c-text-muted); stroke-width: 1.2; opacity: .45; }
.edge.highlighted { stroke: var(--c-blue); stroke-width: 2; opacity: 1; }
.node { cursor: pointer; }
.node rect { rx: var(--radius-surface); fill: var(--c-bg-card); stroke: var(--c-border); }
.node text { fill: var(--c-text); font-size: 12px; }
.node .node-kind { fill: var(--c-text-muted); font-size: 10px; }
.node.memory rect { stroke: var(--c-blue); }
.node.skill rect { stroke: var(--c-text-secondary); }
.node.missing rect { stroke: var(--c-error); stroke-dasharray: 5 3; }
.node.selected rect, .node:focus rect, .node:hover rect { stroke: var(--c-blue); stroke-width: 3; }
.node:focus { outline: none; }
.empty { padding: 16px; color: var(--c-text-muted); }
</style>
