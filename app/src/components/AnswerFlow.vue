<script setup lang="ts">
import { computed, ref } from 'vue'
import { VueFlow, Handle, Position, MarkerType, useVueFlow, type Node, type Edge } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { layoutAnswerFlow, type AnswerFlow, type AnswerFlowNode } from '../answer-flow'
const props = defineProps<{ flow: AnswerFlow; instanceId: string }>()
const selected = ref<AnswerFlowNode>()
const { fitView, zoomIn, zoomOut } = useVueFlow({ id: props.instanceId })
const layout = computed(() => layoutAnswerFlow(props.flow))
const nodes = computed<Node[]>(() => [
  ...layout.value.bounds.map(g => ({ id: `g:${g.id}`, type: 'boundary', position: { x: g.x, y: g.y }, data: { label: g.label }, style: { width: `${g.width}px`, height: `${g.height}px` }, draggable: false, selectable: false, connectable: false, deletable: false, focusable: false, zIndex: -1 })),
  ...props.flow.nodes.map(n => ({ id: `n:${n.id}`, type: 'answer', position: layout.value.positions.get(n.id)!, data: n, draggable: false, connectable: false, deletable: false, selectable: true, focusable: true, sourcePosition: props.flow.direction === 'TB' ? Position.Bottom : Position.Right, targetPosition: props.flow.direction === 'TB' ? Position.Top : Position.Left })),
])
const color = (status?: string) => status === 'implemented' ? 'var(--answer-success)' : status === 'proposed' ? 'var(--answer-info)' : 'var(--answer-text-muted)'
const edges = computed<Edge[]>(() => props.flow.edges.map((e, i) => ({ id: `e:${i}`, source: `n:${e.source}`, target: `n:${e.target}`, type: 'smoothstep', label: [e.label, e.status].filter(Boolean).join(' · ') || undefined, markerEnd: { type: MarkerType.ArrowClosed, color: color(e.status) }, style: { stroke: color(e.status), strokeDasharray: e.status === 'proposed' ? '6 4' : e.status === 'unverified' ? '2 4' : undefined }, labelStyle: { fill: 'var(--answer-text)' }, labelBgStyle: { fill: 'var(--answer-surface)' }, selectable: false, deletable: false, focusable: false })))
</script>
<template>
  <section class="native-answer-flow" :aria-label="flow.title || 'Answer diagram'">
    <h4 v-if="flow.title">{{ flow.title }}</h4><p v-if="flow.summary">{{ flow.summary }}</p>
    <div class="answer-flow-toolbar" role="group" aria-label="Diagram viewport">
      <button type="button" @click="zoomIn()" aria-label="Zoom in">+</button><button type="button" @click="zoomOut()" aria-label="Zoom out">−</button><button type="button" @click="fitView({ padding: .15 })">Fit diagram</button><span>Scroll to zoom · drag to pan · select a node for details</span>
    </div>
    <div class="answer-flow-canvas" :style="{ height: `${flow.height}px` }">
      <VueFlow :id="instanceId" :nodes="nodes" :edges="edges" :nodes-draggable="false" :nodes-connectable="false" :delete-key-code="null" :min-zoom=".001" :max-zoom="2" :fit-view-on-init="true" :connect-on-click="false" :pan-on-drag="true" :zoom-on-scroll="true" :pan-on-scroll="false" :prevent-scrolling="true" :zoom-on-pinch="true" :zoom-on-double-click="false" @node-click="({ node }) => { if (node.type === 'answer') selected = node.data }">
        <template #node-boundary="{ data }"><div class="answer-flow-boundary">{{ data.label }}</div></template>
        <template #node-answer="{ data, sourcePosition, targetPosition }">
          <Handle type="target" :position="targetPosition || Position.Top" :connectable="false" /><div class="answer-flow-node"><strong>{{ data.label }}</strong><small v-if="data.status">{{ data.status }}</small></div><Handle type="source" :position="sourcePosition || Position.Bottom" :connectable="false" />
        </template>
      </VueFlow>
    </div>
    <aside v-if="selected" class="answer-flow-detail" aria-live="polite"><strong>{{ selected.label }}</strong><p>{{ selected.detail || 'No additional details.' }}</p><button type="button" @click="selected = undefined">Close details</button></aside>
    <details class="answer-flow-text"><summary>Diagram text (searchable)</summary>
      <ul><li v-for="group in flow.groups" :key="group.id">Group: {{ group.label }}</li></ul>
      <ul><li v-for="node in flow.nodes" :key="node.id"><strong>{{ node.label }}</strong> [{{ node.id }}]<span v-if="node.group"> · group {{ flow.groups.find(g => g.id === node.group)?.label }}</span><span v-if="node.status"> · {{ node.status }}</span><p v-if="node.detail">{{ node.detail }}</p></li></ul>
      <ul><li v-for="(edge, i) in flow.edges" :key="i">{{ flow.nodes.find(n => n.id === edge.source)?.label }} → {{ flow.nodes.find(n => n.id === edge.target)?.label }}<span v-if="edge.label">: {{ edge.label }}</span><span v-if="edge.status"> ({{ edge.status }})</span></li></ul>
    </details>
  </section>
</template>
<style>
.native-answer-flow{contain:layout style;isolation:isolate;max-width:100%;min-width:0;margin:1em 0;border:1px solid var(--answer-border);background:var(--answer-surface);color:var(--answer-text);font-family:var(--answer-font);overflow-wrap:anywhere}.native-answer-flow h4,.native-answer-flow>p{margin:12px}.answer-flow-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--answer-border);font-size:12px}.native-answer-flow button{font:inherit;color:var(--answer-text);background:var(--answer-surface-soft);border:1px solid var(--answer-border);padding:4px 10px;cursor:pointer}.native-answer-flow button:focus-visible{outline:2px solid var(--answer-accent)}.answer-flow-canvas{width:100%;min-width:0;max-height:640px;overflow:hidden;position:relative;touch-action:none}.native-answer-flow .vue-flow{background:var(--answer-bg)}.native-answer-flow .vue-flow__node-answer{width:208px;border:1px solid var(--answer-border-strong);border-radius:var(--answer-radius);background:var(--answer-surface);color:var(--answer-text);font-size:13px}.native-answer-flow .vue-flow__node-answer.selected{outline:2px solid var(--answer-accent)}.answer-flow-node{padding:12px;max-height:104px;overflow:auto}.answer-flow-node strong{white-space:pre-wrap;font-weight:600}.answer-flow-node small{display:block;color:var(--answer-text-secondary)}.native-answer-flow .vue-flow__node-boundary{border:1px dashed var(--answer-border-strong);background:var(--answer-surface-soft);pointer-events:none}.answer-flow-boundary{padding:8px;font-size:12px;color:var(--answer-text-secondary)}.native-answer-flow .vue-flow__handle{opacity:0;pointer-events:none}.answer-flow-detail,.answer-flow-text{padding:12px;border-top:1px solid var(--answer-border)}.answer-flow-detail p,.answer-flow-text p{white-space:pre-wrap}.answer-flow-text summary{cursor:pointer}.native-answer-flow .vue-flow__edge-text{font-size:12px}.native-answer-flow .vue-flow__node:focus-visible{outline:2px solid var(--answer-accent)}
</style>
