<template>
  <section class="graph-panel" :aria-label="t('Knowledge relationship graph')">
    <div class="graph-toolbar">
      <slot name="tools" />
      <HoverInfo :text="t('Fit diagram')" v-slot="{ triggerProps }"><button v-bind="triggerProps" :aria-label="t('Fit diagram')" @click="fit"><span class="i-lucide-maximize" aria-hidden="true" /><span class="fit-label">{{ t('Fit diagram') }}</span></button></HoverInfo>
      <HoverInfo :text="t('Zoom out')" v-slot="{ triggerProps }"><button v-bind="triggerProps" :aria-label="t('Zoom out')" :disabled="zoom <= 30" @click="changeZoom(zoom / 1.3)"><span class="i-lucide-minus" aria-hidden="true" /></button></HoverInfo>
      <output :aria-label="t('Graph zoom')">{{ Math.round(zoom) }}%</output>
      <HoverInfo :text="t('Zoom in')" v-slot="{ triggerProps }"><button v-bind="triggerProps" :aria-label="t('Zoom in')" :disabled="zoom >= 800" @click="changeZoom(zoom * 1.3)"><span class="i-lucide-plus" aria-hidden="true" /></button></HoverInfo>
      <HoverInfo :text="t('links. Arrows point to referenced entries.')" v-slot="{ triggerProps }"><span v-bind="triggerProps" tabindex="0" class="graph-count">{{ graph.nodes.length }} / {{ graph.links.length }}</span></HoverInfo>
    </div>
    <div ref="canvas" class="graph-canvas" tabindex="0" :aria-label="t('Knowledge relationship graph')" @keydown="canvasKey">
      <p v-if="!graph.nodes.length" class="empty">{{ t('No entries match. Change the filter or search.') }}</p>
      <svg v-else ref="svg" :viewBox="`0 0 ${size.width} ${size.height}`" @pointerdown="startPan" @pointermove="pan" @pointerup="endPan" @pointercancel="endPan" @lostpointercapture="endPan" @wheel.prevent="wheel">
        <defs><marker :id="arrowId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        <path v-for="(edge, index) in edges" :key="index" :d="edge.path" class="edge" :class="{ highlighted: edge.source === selectedId || edge.target === selectedId, dimmed: selectedId && edge.source !== selectedId && edge.target !== selectedId }" :marker-end="`url(#${arrowId})`" />
        <g v-for="node in nodes" :key="node.id" :transform="`translate(${node.x},${node.y})`" class="node" :class="[node.kind, { selected: node.id === selectedId, neighbor: neighbors.has(node.id), dimmed: selectedId && !neighbors.has(node.id) }]" role="button" tabindex="0" :aria-label="`${node.title} · ${node.kind === 'missing' ? t('Outside catalog') : enumLabel(node.kind)}`" :aria-pressed="node.id === selectedId" @pointerdown.stop @pointerenter="hovered = node.id" @pointerleave="hovered = ''" @focus="focusNode(node.id)" @blur="hovered = ''" @click="emit('select', node.id)" @keydown.enter.prevent.stop="emit('select', node.id)" @keydown.space.prevent.stop="emit('select', node.id)">
          <circle class="hit" r="14" /><circle class="dot" :r="node.id === selectedId ? 7 : 5.5" />
        </g>
        <g class="graph-labels" aria-hidden="true"><text v-for="node in labeledNodes" :key="node.id" :x="node.x + (node.x > size.width - 220 ? -12 : 12)" :text-anchor="node.x > size.width - 220 ? 'end' : 'start'" :y="node.y + 4">{{ short(node.title, 28) }}</text></g>
      </svg>
    </div>
    <div v-if="selection" class="graph-selection" aria-live="polite">
      <div><strong>{{ selection.title }}</strong><small>{{ selection.kind === 'missing' ? t('Outside catalog') : enumLabel(selection.kind) }}</small></div>
      <button @click="emit('open', selection.id)">{{ t('Open document') }}</button>
      <HoverInfo :text="t('Clear selection')" v-slot="{ triggerProps }"><button v-bind="triggerProps" :aria-label="t('Clear selection')" @click="emit('select', '')"><span class="i-lucide-x" aria-hidden="true" /></button></HoverInfo>
    </div>
  </section>
</template>
<script setup lang="ts">
import { enumLabel } from '../display-labels.ts'
import { t } from '../i18n.ts'
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { layoutKnowledgeGraph, type KnowledgeCatalog } from '../knowledge.ts'
import { graphLabels, graphScale } from '../knowledge-graph-viewport.ts'
import HoverInfo from './HoverInfo.vue'
const props = defineProps<{ catalog: KnowledgeCatalog; visibleIds: string[]; selectedId: string }>()
const emit = defineEmits<{ select: [id: string]; open: [id: string] }>()
const zoom = ref(100), center = ref({ x: 0, y: 0 }), svg = ref<SVGSVGElement>(), canvas = ref<HTMLDivElement>()
const size = ref({ width: 800, height: 600 }), hovered = ref('')
let observer: ResizeObserver | undefined
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !canvas.value) return
  observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width && entry.contentRect.height) size.value = { width: entry.contentRect.width, height: entry.contentRect.height } })
  observer.observe(canvas.value)
})
onUnmounted(() => observer?.disconnect())
const arrowId = `knowledge-arrow-${useId()}`
const graph = computed(() => layoutKnowledgeGraph(props.catalog, props.visibleIds))
function fit() { zoom.value = 100; center.value = { x: graph.value.width / 2, y: graph.value.height / 2 } }
watch(graph, fit, { immediate: true })
const scale = computed(() => graphScale(size.value.width, size.value.height, graph.value.width, graph.value.height, zoom.value))
const nodes = computed(() => graph.value.nodes.map(node => ({ ...node, x: (node.x - center.value.x) * scale.value + size.value.width / 2, y: (node.y - center.value.y) * scale.value + size.value.height / 2 })))
// Keep node DOM order stable for Tab navigation; paint labels in a separate layer.
const labeledNodes = computed(() => nodes.value.filter(node => labels.value.has(node.id)))
const selection = computed(() => graph.value.nodes.find(node => node.id === props.selectedId))
const neighbors = computed(() => new Set([props.selectedId, ...graph.value.links.filter(link => link.source === props.selectedId || link.target === props.selectedId).flatMap(link => [link.source, link.target])]))
const degrees = computed(() => { const result = new Map<string, number>(); for (const link of graph.value.links) for (const id of [link.source, link.target]) result.set(id, (result.get(id) ?? 0) + 1); return result })
const labels = computed(() => graphLabels(nodes.value, size.value.width, size.value.height, props.selectedId, hovered.value, neighbors.value, degrees.value))
const edges = computed(() => {
  const positions = new Map(nodes.value.map(node => [node.id, node]))
  return graph.value.links.map(link => {
    const source = positions.get(link.source)!, target = positions.get(link.target)!
    const dx = target.x - source.x, dy = target.y - source.y, length = Math.max(1, Math.hypot(dx, dy))
    return { ...link, path: source === target ? `M ${source.x} ${source.y - 6} C ${source.x + 30} ${source.y - 40}, ${source.x + 40} ${source.y + 20}, ${source.x + 6} ${source.y}` : `M ${source.x + dx / length * 7} ${source.y + dy / length * 7} L ${target.x - dx / length * 9} ${target.y - dy / length * 9}` }
  })
})
let drag: { id: number; x: number; y: number } | undefined
function startPan(event: PointerEvent) { if (event.button !== 0 && event.button !== 1) return; canvas.value?.focus({ preventScroll: true }); svg.value?.setPointerCapture(event.pointerId); drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; event.preventDefault() }
function pan(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  center.value = { x: center.value.x + (drag.x - event.clientX) / scale.value, y: center.value.y + (drag.y - event.clientY) / scale.value }
  drag.x = event.clientX; drag.y = event.clientY
}
function endPan() { drag = undefined }
function focusNode(id: string) {
  hovered.value = id
  const node = nodes.value.find(item => item.id === id)
  if (node && (node.x < 24 || node.x > size.value.width - 24 || node.y < 80 || node.y > size.value.height - 80)) {
    const world = graph.value.nodes.find(item => item.id === id)!
    center.value = { x: world.x, y: world.y }
  }
}
function changeZoom(value: number) { zoom.value = Math.max(30, Math.min(800, value)) }
function wheel(event: WheelEvent) { changeZoom(zoom.value * Math.exp(-event.deltaY * .002)) }
function canvasKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('select', '')
  else if (event.target !== event.currentTarget) return
  else if (event.key === 'Home') fit()
  else if (event.key === '+' || event.key === '=') changeZoom(zoom.value * 1.3)
  else if (event.key === '-') changeZoom(zoom.value / 1.3)
  else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { center.value = { x: center.value.x + (event.key === 'ArrowLeft' ? -40 : event.key === 'ArrowRight' ? 40 : 0) / scale.value, y: center.value.y + (event.key === 'ArrowUp' ? -40 : event.key === 'ArrowDown' ? 40 : 0) / scale.value } }
  else return
  event.preventDefault()
}
const short = (value: string, size: number) => value.length > size ? `${value.slice(0, size - 1)}…` : value
</script>
<style scoped>
.graph-panel { position: relative; min-width: 0; min-height: 0; height: 100%; isolation: isolate; }
.graph-toolbar { position: absolute; z-index: 2; top: 12px; left: 12px; max-width: calc(100% - 24px); display: flex; align-items: center; gap: 2px; padding: 4px; background: var(--c-bg-card); box-shadow: 0 4px 16px var(--c-shadow-soft); color: var(--c-text-secondary); font-size: 12px; }
.graph-toolbar output { min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; }
.graph-count { padding: 8px; white-space: nowrap; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: 0; padding: 6px 8px; background: var(--c-bg-card); color: var(--c-text); cursor: pointer; min-width: 32px; min-height: 32px; font-size: 12px; }
button:hover { background: var(--c-bg-muted); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, .graph-count:focus-visible, .graph-canvas:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.graph-canvas { height: 100%; min-height: 240px; overflow: hidden; touch-action: none; }
svg { display: block; width: 100%; height: 100%; color: var(--c-text-muted); cursor: grab; }
.edge { fill: none; stroke: var(--c-text-muted); stroke-width: 1; opacity: .38; pointer-events: none; }
.edge.highlighted { stroke: var(--c-blue); stroke-width: 1.5; opacity: .85; }
.edge.dimmed { opacity: .1; }
.fit-label { white-space: nowrap; }
@container (max-width: 440px) { .fit-label { display: none; } }
.node { cursor: pointer; }
.node .hit { fill: transparent; stroke: none; pointer-events: all; }
.node .dot { fill: var(--c-text-secondary); stroke: var(--c-bg); stroke-width: 1.5; pointer-events: none; }
.node.memory .dot { fill: var(--c-blue); }
.node.skill .dot { fill: var(--c-amber); }
.node.missing .dot { fill: var(--c-bg); stroke: var(--c-text-secondary); stroke-dasharray: 3 2; }
.graph-labels { pointer-events: none; }
.graph-labels text { fill: var(--c-text); font-size: 12px; paint-order: stroke; stroke: var(--c-bg); stroke-width: 4px; stroke-linejoin: round; pointer-events: none; }
.node.dimmed { opacity: .35; }
.node.selected .dot, .node:focus .dot, .node:hover .dot { stroke: var(--c-blue); stroke-width: 3; }
.node:focus, .node:hover { outline: none; opacity: 1; }
.graph-selection { position: absolute; right: 12px; bottom: 12px; max-width: min(460px, calc(100% - 24px)); box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 8px; background: var(--c-bg-card); box-shadow: 0 4px 16px var(--c-shadow-soft); font-size: 12px; }
.graph-selection > div { min-width: 0; }
.graph-selection strong { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-weight: 500; }
.graph-selection small { display: block; color: var(--c-text-secondary); }
.graph-selection button { flex-shrink: 0; }
.empty { padding: 80px 20px; color: var(--c-text-secondary); }
@media (pointer: coarse), (max-width: 700px) { button { min-height: 44px; min-width: 44px; } .graph-count { display: none; } }
</style>
