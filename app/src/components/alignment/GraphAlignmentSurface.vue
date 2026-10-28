<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { VueFlow, MarkerType, type Connection, type Edge, type Node } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import { t } from '../../i18n.ts'
import { createUuid } from '../../uuid.ts'
import { alignmentRevision, type AlignmentSource, type AlignmentSurfaceProps, type AlignmentTarget } from '../../alignment-lab-model.ts'
import { graphConnectionAllowed, parseAlignmentGraph, sampleAlignmentGraph } from '../../alignment-graph.ts'

const props = defineProps<AlignmentSurfaceProps>()
const emit = defineEmits<{ source: [source: AlignmentSource]; target: [target: AlignmentTarget]; select: [id: string] }>()
const instanceId = `alignment-graph-${createUuid()}`
let original = sampleAlignmentGraph()
const nodes = ref<Array<Node & { selected?: boolean }>>(original.nodes.map(node => ({ ...node, data: { label: node.label }, sourcePosition: 'right', targetPosition: 'left' })) as Node[])
let baseEdges = original.edges.map(edge => ({ ...edge, markerEnd: MarkerType.ArrowClosed }))
const edges = ref<Array<Edge & { selected?: boolean }>>([...baseEdges])
const nodeIds = ref<string[]>([])
const edgeIds = ref<string[]>([])
const from = ref('brief'), to = ref('review')
const error = ref('')
const ready = ref(false)
const graphVersion = ref(0)
const loading = ref(false)
let disposed = false
const canConnect = computed(() => graphConnectionAllowed(from.value, to.value, nodes.value, edges.value))
function selectGraph() {
  if (!props.active || loading.value || (!nodeIds.value.length && !edgeIds.value.length)) return
  const nodeSelection = [...nodeIds.value].sort(), edgeSelection = [...edgeIds.value].sort()
  const existing = props.targets.find(target => target.selector.type === 'graph' && !target.selector.proposedConnection
    && JSON.stringify(target.selector.nodeIds) === JSON.stringify(nodeSelection) && JSON.stringify(target.selector.edgeIds) === JSON.stringify(edgeSelection))
  emit('target', { id: existing?.id ?? createUuid(), label: t('Graph selection: {nodes} nodes, {edges} edges', { nodes: nodeSelection.length, edges: edgeSelection.length }),
    selector: { type: 'graph', nodeIds: nodeSelection, edgeIds: edgeSelection } })
}
function connect(connection: Connection) {
  if (!props.active || loading.value || !ready.value || !graphConnectionAllowed(connection.source, connection.target, nodes.value, edges.value)) {
    error.value = t('Choose two different nodes without an existing connection.'); return
  }
  error.value = ''
  const source = connection.source, target = connection.target
  emit('target', { id: `connection:${createUuid()}`, label: t('Proposed connection: {source} → {target}', { source, target }),
    selector: { type: 'graph', nodeIds: [source, target], edgeIds: [], proposedConnection: { source, target } } })
}
function proposeConnection() { connect({ source: from.value, target: to.value, sourceHandle: null, targetHandle: null }) }
function toggleNode(id: string, checked: boolean) {
  nodeIds.value = checked ? [...new Set([...nodeIds.value, id])] : nodeIds.value.filter(value => value !== id)
  nodes.value = nodes.value.map(node => ({ ...node, selected: nodeIds.value.includes(node.id) }))
}
function toggleEdge(id: string, checked: boolean) {
  edgeIds.value = checked ? [...new Set([...edgeIds.value, id])] : edgeIds.value.filter(value => value !== id)
  edges.value = edges.value.map(edge => ({ ...edge, selected: edgeIds.value.includes(edge.id) }))
}
function allowReplacement() { return !(props.hasInstructions || props.targets.length) || window.confirm(t('Replace this source and discard its annotations?')) }
async function publish(graph: ReturnType<typeof sampleAlignmentGraph>, label: string) {
  const context = JSON.stringify(graph)
  if (context.length > 120000) throw new Error('Graph context too large')
  const revision = await alignmentRevision(context)
  if (disposed) return
  original = graph
  graphVersion.value++
  baseEdges = graph.edges.map(edge => ({ ...edge, markerEnd: MarkerType.ArrowClosed }))
  nodes.value = graph.nodes.map(node => ({ ...node, data: { label: node.label }, sourcePosition: 'right', targetPosition: 'left' })) as Node[]
  nodeIds.value = []; edgeIds.value = []; edges.value = [...baseEdges]
  from.value = graph.nodes[0]!.id; to.value = graph.nodes.at(-1)!.id
  emit('source', { id: 'workflow-graph', label, revision, context })
  ready.value = true; error.value = ''
}
async function reset() {
  if (loading.value || !allowReplacement()) return
  loading.value = true
  try { await publish(sampleAlignmentGraph(), t('Creative workflow sample')) }
  catch { error.value = t('Could not prepare this source. Retry.') }
  finally { loading.value = false }
}
async function loadGraph(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  if (!file || loading.value || !allowReplacement()) return
  if (file.size > 128 * 1024) { error.value = t('Choose graph JSON under 128 KiB with at most 100 nodes and 200 edges.'); return }
  loading.value = true
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
    const graph = parseAlignmentGraph(JSON.parse(text))
    if (!disposed) await publish(graph, file.name)
  } catch { error.value = t('Invalid graph JSON. Use nodes with id and label, and edges with id, source and target.') }
  finally { loading.value = false }
}
watch(() => props.targets, targets => {
  const proposals: Edge[] = []
  for (const target of targets) if (target.selector.type === 'graph' && target.selector.proposedConnection) {
    proposals.push({ id: target.id, ...target.selector.proposedConnection, label: t('Proposed'), style: { stroke: '#d97706', strokeDasharray: '6 4' }, markerEnd: MarkerType.ArrowClosed })
  }
  edges.value = [...baseEdges, ...proposals].map(edge => ({ ...edge, selected: edgeIds.value.includes(edge.id) }))
}, { immediate: true })
watch(() => props.selectedId, id => {
  const target = props.targets.find(target => target.id === id)
  if (target?.selector.type !== 'graph') return
  nodeIds.value = [...target.selector.nodeIds]; edgeIds.value = [...target.selector.edgeIds]
  nodes.value = nodes.value.map(node => ({ ...node, selected: nodeIds.value.includes(node.id) }))
  edges.value = edges.value.map(edge => ({ ...edge, selected: edgeIds.value.includes(edge.id) || edge.id === id }))
})
watch(() => nodes.value.filter(node => node.selected).map(node => node.id), ids => { nodeIds.value = ids })
watch(() => edges.value.filter(edge => edge.selected).map(edge => edge.id), ids => { edgeIds.value = ids })
onMounted(reset)
onBeforeUnmount(() => { disposed = true })
</script>

<template>
  <section class="graph-surface" :aria-label="t('Workflow relationship alignment')">
    <p class="surface-hint">{{ t('Select nodes or edges to explain a dependency. Connect handles to propose a relationship; no workflow is executed.') }}</p>
    <div class="surface-toolbar"><button class="btn graph-annotate" :disabled="!ready || (!nodeIds.length && !edgeIds.length)" @click="selectGraph">{{ t('Annotate graph selection') }}</button><label>{{ t('Load graph JSON') }}<input type="file" accept="application/json,.json" :disabled="loading" @change="loadGraph"></label><button class="btn" :disabled="loading" @click="reset">{{ t('Reset sample') }}</button></div>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="graph-canvas">
      <VueFlow v-if="active" :key="graphVersion" :id="`${instanceId}-${graphVersion}`" v-model:nodes="nodes" v-model:edges="edges" :fit-view-on-init="true" :min-zoom="0.2" :max-zoom="2" :delete-key-code="null" :zoom-on-double-click="false" :nodes-connectable="ready" :nodes-draggable="true"
        @connect="connect"><Background /><Controls :show-interactive="false" /></VueFlow>
    </div>
    <details class="graph-accessible"><summary>{{ t('Select graph elements without dragging') }}</summary><fieldset><legend>{{ t('Nodes') }}</legend><label v-for="node in original.nodes" :key="node.id"><input type="checkbox" :checked="nodeIds.includes(node.id)" @change="toggleNode(node.id, ($event.target as HTMLInputElement).checked)"> {{ node.label }}</label></fieldset><fieldset><legend>{{ t('Connections') }}</legend><label v-for="edge in baseEdges" :key="edge.id"><input type="checkbox" :checked="edgeIds.includes(edge.id)" @change="toggleEdge(edge.id, ($event.target as HTMLInputElement).checked)"> {{ edge.source }} → {{ edge.target }}</label></fieldset></details>
    <div class="surface-toolbar graph-proposal"><label>{{ t('From node') }}<select v-model="from"><option v-for="node in original.nodes" :key="node.id" :value="node.id">{{ node.label }}</option></select></label><label>{{ t('To node') }}<select v-model="to"><option v-for="node in original.nodes" :key="node.id" :value="node.id">{{ node.label }}</option></select></label><button class="btn graph-connect" :disabled="!ready || !canConnect" @click="proposeConnection">{{ t('Propose connection') }}</button></div>
  </section>
</template>

<style scoped>
.surface-hint { color: var(--c-text-secondary); font-size: 13px; line-height: 1.6; }
.surface-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.graph-canvas { height: 440px; border: 1px solid var(--c-border); background: var(--c-bg-soft); }
.graph-canvas :deep(.vue-flow__node-default) { background: var(--c-bg-card); color: var(--c-text); border-color: var(--c-border); }
.graph-canvas :deep(.vue-flow__node-default.selected) { outline: 2px solid var(--c-blue); }
.graph-canvas :deep(.vue-flow__controls-button) { background: var(--c-bg-card); color: var(--c-text); fill: currentColor; border-color: var(--c-border); }
.graph-accessible { margin: 12px 0; font-size: 13px; }.graph-accessible fieldset { border: 1px solid var(--c-border); margin-top: 8px; display: flex; gap: 12px; flex-wrap: wrap; }
.graph-proposal { margin-top: 14px; font-size: 12px; }.graph-proposal label { display: flex; flex-direction: column; gap: 4px; }.graph-proposal select { background: var(--c-bg-card); color: var(--c-text); padding: 7px; border: 1px solid var(--c-border); max-width: 210px; }
@media (max-width: 760px) { .graph-canvas { height: 340px; } }
</style>
