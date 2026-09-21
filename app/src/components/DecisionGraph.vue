<template>
  <details class="decision-graph" @toggle="toggle">
    <summary>Decision relationship graph</summary>
    <p>Read-only snapshot. Dashed arrows mean an agent selected a citation, not a verified cause or reporting hierarchy.
      Solid arrows are recorded revisions. Nodes quote agent-authored questions; their claims are not independently verified.</p>
    <p v-if="loading" role="status">Loading decision references...</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="graph && layout">
      <p v-if="graph.limited" class="graph-warning" role="status">Partial graph: at most {{ DECISION_GRAPH_LIMIT }} records and {{ DECISION_GRAPH_DEPTH }} reference steps are loaded. Open a source session to inspect further.</p>
      <div class="decision-graph-scroll" tabindex="0" aria-label="Scrollable decision relationship graph">
        <svg :width="layout.width" :height="layout.height" :viewBox="`0 0 ${layout.width} ${layout.height}`">
          <defs><marker :id="arrowId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
          <path v-for="(edge, index) in edges" :key="index" :d="edge.path" class="graph-edge" :class="{ citation: edge.kind === 'cites' || edge.kind === 'reconsiders' }" :marker-end="`url(#${arrowId})`">
            <title>{{ edge.kind }}</title>
          </path>
          <g v-for="node in layout.nodes" :key="node.id" :transform="`translate(${node.x},${node.y})`"
            class="graph-node" :class="{ selected: selected === node.id, unavailable: node.error }" role="button" tabindex="0"
            :aria-pressed="selected === node.id" :aria-label="`Decision ${node.number}: ${node.record?.request.question ?? node.error}`"
            @click="selected = node.id" @keydown.enter.prevent="selected = node.id" @keydown.space.prevent="selected = node.id">
            <rect width="240" height="96" />
            <text x="10" y="20">{{ node.number }} · {{ node.id === graph.root ? 'Selected decision' : 'Referenced decision' }}</text>
            <text x="10" y="42">{{ short(node.reference.sessionId, 30) }}</text>
            <text x="10" y="62">{{ short(node.record?.request.question ?? node.error ?? '', 32) }}</text>
            <text x="10" y="82">{{ node.record ? decisionStatusLabel(recordedDecision(node.record).status) : 'Unavailable record' }}</text>
          </g>
        </svg>
      </div>
      <ul class="graph-relations" aria-label="Recorded decision relationships">
        <li v-for="(edge, index) in graph.edges" :key="index">
          <button type="button" @click="selected = edge.from">#{{ numberOf(edge.from) }}</button>
          {{ edge.kind === 'cites' ? 'cites (agent-selected)' : edge.kind === 'reconsiders' ? 'reconsiders (history, not an inherited premise)' : edge.kind === 'supersedes' ? 'supersedes (recorded revision)' : 'was replaced by (recorded revision)' }}
          <button type="button" @click="selected = edge.to">#{{ numberOf(edge.to) }}</button>
        </li>
      </ul>
      <p v-if="!graph.edges.length">No linked decisions were recorded. This does not establish that the question is independent.</p>
      <section v-if="inspected" class="graph-inspector" aria-label="Selected decision record">
        <strong>Decision #{{ numberOf(inspected.id) }} · Recorded facts</strong>
        <p>Owner: {{ inspected.reference.sessionId }}</p>
        <template v-if="inspected.record">
          <p>Addressed to: {{ inspected.record.request.recipient.kind }} · {{ inspected.record.request.recipient.sessionId }}</p>
          <p>{{ decisionStatusLabel(recordedDecision(inspected.record).status) }}. This snapshot does not indicate an active wait.</p>
          <strong>Agent-authored question (original text)</strong>
          <p class="graph-original">{{ inspected.record.request.question }}</p>
          <p v-if="inspected.record.invalidated" role="alert">Premise changed: {{ inspected.record.invalidated.reason }}. Revalidation is required even if an answer was previously recorded.</p>
          <DecisionBrief v-if="inspected.record.request.brief" :brief="inspected.record.request.brief" graph @inspect="emit('inspect', $event)" />
          <ol><li v-for="option in inspected.record.request.options" :key="option">{{ option }}</li></ol>
          <p v-if="inspected.record.answer">Recorded response: {{ inspected.record.answer.option }}</p>
          <p v-if="inspected.record.closed">{{ inspected.record.closed.message }}</p>
          <p v-if="inspected.record.request.revisionReason">Revision requested by user: {{ inspected.record.request.revisionReason }}</p>
          <MessageTimestamp :timestamp="inspected.record.request.createdAt" />
          <button type="button" @click="emit('inspect', inspected.reference.sessionId)">Open source session</button>
        </template>
        <p v-else role="alert">{{ inspected.error }}</p>
        <p class="graph-identity">Request: {{ inspected.reference.requestId }} · Segment: {{ inspected.reference.physicalId }}</p>
      </section>
    </template>
    <button v-if="!loading" type="button" @click="load">Refresh graph</button>
  </details>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, useId, watch } from 'vue'
import { DECISION_GRAPH_LIMIT, DECISION_GRAPH_DEPTH, decisionKey, decisionReader, loadDecisionGraph, layoutDecisionGraph, type DecisionGraph } from '../decision-graph.ts'
import { decisionStatusLabel, recordedDecision } from '../yield-history.ts'
import type { YieldReference } from '../../../src/sessions/yield-contract.ts'
import MessageTimestamp from './MessageTimestamp.vue'
import DecisionBrief from './DecisionBrief.vue'
const props = defineProps<{ reference: YieldReference; apiBase: string }>()
const emit = defineEmits<{ inspect: [sessionId: string] }>()
const graph = shallowRef<DecisionGraph>()
const selected = ref('')
const loading = ref(false)
const error = ref('')
let opened = false
let controller: AbortController | undefined
const arrowId = `decision-arrow-${useId()}`
const layout = computed(() => graph.value && layoutDecisionGraph(graph.value))
const inspected = computed(() => graph.value?.nodes.find(node => node.id === selected.value))
const numberOf = (id: string) => layout.value?.nodes.find(node => node.id === id)?.number
const short = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 3)}...` : text
const edges = computed(() => (graph.value?.edges ?? []).map(edge => {
  const source = layout.value!.nodes.find(node => node.id === edge.from)!
  const target = layout.value!.nodes.find(node => node.id === edge.to)!
  const x1 = source.x + 240, x2 = source.x === target.x ? target.x + 240 : target.x
  if (source.id === target.id) return { ...edge, path: `M ${x1} ${source.y + 28} C ${x1 + 32} ${source.y + 8}, ${x1 + 32} ${source.y + 88}, ${x1} ${source.y + 68}` }
  const bend = source.x === target.x ? x1 + 28 : (x1 + x2) / 2
  return { ...edge, path: `M ${x1} ${source.y + 48} C ${bend} ${source.y + 48}, ${bend} ${target.y + 48}, ${x2} ${target.y + 48}` }
}))
async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  graph.value = undefined
  error.value = ''
  loading.value = true
  try {
    const next = await loadDecisionGraph(props.reference, decisionReader(props.apiBase, current.signal), current.signal)
    if (!current.signal.aborted) { graph.value = next; selected.value = next.root }
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load the decision graph.'
  } finally { if (controller === current) loading.value = false }
}
function toggle(event: Event) {
  opened = (event.currentTarget as HTMLDetailsElement).open
  if (opened) void load()
  else { controller?.abort(); loading.value = false }
}
watch(() => JSON.stringify([props.apiBase, decisionKey(props.reference)]), () => {
  controller?.abort()
  graph.value = undefined
  if (opened) void load()
})
onUnmounted(() => controller?.abort())
</script>

<style scoped>
.decision-graph { min-width: 0; margin: 12px 0; border: 1px solid var(--c-border); padding: 8px; font-size: 12px; }
summary, button { cursor: pointer; }
p { margin: 8px 0; }
.decision-graph-scroll { overflow: auto; max-height: 45vh; background: var(--c-bg-soft); }
svg { display: block; color: var(--c-text-secondary); }
.graph-edge { fill: none; stroke: var(--c-text-secondary); stroke-width: 1.5; }
.graph-edge.citation { stroke-dasharray: 5 4; }
.graph-node { cursor: pointer; }
.graph-node rect { fill: var(--c-bg-card); stroke: var(--c-border); }
.graph-node text { fill: var(--c-text); font-size: 11px; }
.graph-node.selected rect, .graph-node:focus rect { stroke: var(--c-blue); stroke-width: 3; }
.graph-node.unavailable rect { stroke: var(--c-error); stroke-dasharray: 4 3; }
.graph-warning { color: var(--c-warn); }
.graph-inspector { padding: 8px; border: 1px solid var(--c-border); }
.graph-original, li { white-space: pre-wrap; }
.graph-identity { color: var(--c-text-secondary); overflow-wrap: anywhere; }
ol { list-style: upper-alpha; padding-left: 24px; }
button { min-height: 32px; padding: 4px 8px; border: 1px solid var(--c-border); background: var(--c-bg-card); }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
