<template>
  <section class="overview" :aria-label="t('Project overview graph')">
    <div class="graph-workspace"><div class="graph-canvas" ref="canvas" data-overview-canvas @pointerdown="centerToken++" @wheel="centerToken++" @keydown.esc="selectedId = ''; helpOpen = false">
      <form class="canvas-toolbar" :aria-label="t('Filter work')" @submit.prevent>
        <input :value="query" type="search" :aria-label="t('Search')" :placeholder="t('Find work…')" @input="emit('update:query', ($event.target as HTMLInputElement).value)" />
        <select v-model="focus" :aria-label="t('Recent focus')"><option value="">{{ t('All work') }} · {{ topics.length }}</option><option v-for="group in groups" :key="group.key" :value="group.key">{{ group.title || t('Unorganized topics') }} · {{ group.topics.length }}</option></select>
        <button v-if="focus || query" type="button" @click="clearFilters">{{ t('Clear filters') }}</button>
        <button type="button" @click="returnToRecent()">{{ t('Back to recent') }}</button>
        <button type="button" :aria-expanded="helpOpen" @click="helpOpen = !helpOpen">{{ t('Evidence') }} ⓘ</button>
      </form>
      <div v-if="helpOpen" class="canvas-help"><button @click="fitView(fitOptions)">{{ t('Fit all topics') }}</button><p>{{ t('One graph connects topics, approaches, decisions and reported results. Time order is not causation.') }}</p><div class="legend"><span v-for="kind in relationKinds" :key="kind" :class="kind">{{ label(kind) }}</span></div><p>{{ t('Saved references and work links show recorded context, not verified downstream impact. Missing causal evidence is not invented.') }}</p></div>
      <p v-if="activeGroup?.inferred" class="focus-notice notice">{{ t('Model interpretation — not confirmed user intent') }} · {{ activeGroup.purpose }} · {{ activeGroup.motivation }} <span v-if="activeGroup.stale">{{ t('Topics changed since organization. This interpretation may be stale.') }}</span></p>
      <p v-if="!activeGroup && data.focus?.historyPartial" class="focus-notice notice">{{ t('Presentation history is bounded; some older discussion may be omitted.') }}</p>
      <p v-else-if="!activeGroup && groups.some(group => group.stale)" class="focus-notice notice">{{ t('Topics changed since organization. This interpretation may be stale.') }}</p>
      <VueFlow @edge-click="({ edge }) => { if (edge.data) { selectedId = edge.data.from; edgeEvidence = trace(edge.data) } }" :nodes="flowNodes" :edges="flowEdges" :nodes-draggable="false" :nodes-connectable="false" :elements-selectable="false" :delete-key-code="null" :min-zoom="0.15" :max-zoom="2" :zoom-on-double-click="false" :default-viewport="{ x: 16, y: 104, zoom: 1 }">
        <template #node-region="regionProps"><OverviewFlowRegion v-bind="regionProps" /></template><template #node-overview="nodeProps"><OverviewFlowNode v-bind="nodeProps" /></template>
        <Background :gap="24" :size="1" pattern-color="var(--c-border)" />
        <Controls :show-interactive="false" :show-fit-view="false" />
      </VueFlow>
    <div v-if="!visibleNodes.length" class="canvas-empty" role="status"><p>{{ t(query || focus ? 'No matching work' : 'No recorded topics yet') }}</p><button v-if="query || focus" @click="clearFilters">{{ t('Clear filters') }}</button></div>
    </div>
    <aside v-if="selectedNode" class="context" :aria-label="t('Work details')"><button class="context-close" :aria-label="t('Close coordination panel')" @click="selectedId = ''">×</button><h3>{{ selectedNode.title }}</h3><p v-if="edgeEvidence" class="edge-evidence">{{ edgeEvidence }}</p><div v-if="selectedNode.kind === 'outcome'" class="prose outcome-explanation" v-html="outcomeMarkdown(selectedNode.detail ?? '')" /><p v-else>{{ selectedNode.detail }}</p><p v-if="selectedNode.status">{{ status(selectedNode.status) }}</p><p>{{ role(selectedNode.kind) }} · {{ authority(selectedNode.authority) }}</p><time>{{ selectedNode.at ? new Date(selectedNode.at).toLocaleString() : t('Unknown time') }}</time>
      <p><button v-if="selectedNode.workKey" @click="emit('select', selectedNode.workKey)">{{ t('Work details') }}</button> <button v-if="selectedNode.sessionId" @click="emit('session', selectedNode.sessionId)">{{ t('Open conversation') }}</button></p>
      <details><summary>{{ t('Evidence') }} · {{ selectedEdges.length }}</summary><small>{{ selectedNode.evidence }}</small><ul><li v-for="(edge, index) in selectedEdges" :key="index"><strong>{{ label(edge.kind) }}</strong> · <button @click="selectedId = edge.from === selectedNode.id ? edge.to : edge.from">{{ graph.nodes.find(node => node.id === (edge.from === selectedNode?.id ? edge.to : edge.from))?.title }}</button><p>{{ edge.evidence }}</p></li></ul></details>
      <p v-if="historyError" role="alert">{{ t('Decision history unavailable') }} <button @click="loadContext(selectedNode.workKey, true)">{{ t('Retry') }}</button></p><p v-if="partial || data.focus?.historyPartial" class="notice">{{ t('History is partial: older records or unreadable segments are not shown.') }}</p><p v-if="loading" role="status">{{ t('Loading…') }}</p>
    </aside></div>
  </section>
</template>
<script setup lang="ts">
import { markdownHighlight } from '../markdown-highlight.ts'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { VueFlow, useVueFlow, MarkerType } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import OverviewFlowNode from './OverviewFlowNode.vue'
import OverviewFlowRegion from './OverviewFlowRegion.vue'
import { overviewFlowEdges } from '../project-overview-flow.ts'
import { t } from '../i18n.ts'
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
const markdown = new Marked({ breaks: true })
markdown.use(markdownHighlight())
function outcomeMarkdown(text: string) { return DOMPurify.sanitize(markdown.parse(text, { async: false }) as string) }
import type { ProjectWorkOverview } from '../../../src/projects/work-overview.ts'
import { parseYieldDecisionRecord, type YieldDecisionRecord } from '../../../src/sessions/yield-contract.ts'
import { overviewGraph, overviewLayout } from '../project-overview-graph.ts'
import { projectTopics, projectFocusGroups } from '../project-topic-history.ts'
const props = defineProps<{ data: ProjectWorkOverview; apiBase: string; query: string }>()
const emit = defineEmits<{ select: [key: string]; session: [id: string]; 'update:query': [query: string] }>()
const { fitView, setViewport, viewport } = useVueFlow()
const fitOptions = { padding: .22, maxZoom: 1, minZoom: .15 }
const edgeEvidence = ref('')
const canvas = ref<HTMLElement>()
const helpOpen = ref(false)
async function returnToRecent(zoom = 1) { await nextTick(); const first = layout.value.nodes[0]; const position = first && layout.value.positions.get(first.id); if (position) void setViewport({ x: 16 - position.x * zoom, y: 104 - position.y * zoom, zoom }) }
function clearFilters() { focus.value = ''; emit('update:query', '') }
const focus = ref(''), selectedId = ref(''), history = shallowRef<Record<string, YieldDecisionRecord[]>>({}), loading = ref(false), historyError = ref(false), partial = ref(false)
const expanded = ref(new Set<string>())
let generation = 0
watch(() => props.apiBase, () => { generation++; expanded.value = new Set(); history.value = {}; selectedId.value = ''; loading.value = false; historyError.value = false; partial.value = false })
const topics = computed(() => projectTopics(props.data)), groups = computed(() => projectFocusGroups(topics.value, props.data.focus)), activeGroup = computed(() => groups.value.find(group => group.key === focus.value))
const graph = computed(() => overviewGraph(props.data, Object.values(history.value).flat()))
const layout = computed(() => {
  const keys = activeGroup.value ? new Set(activeGroup.value.topics.flatMap(topic => [topic.key, ...topic.items.map(item => item.key)])) : undefined
  return overviewLayout(graph.value, expanded.value, node => (!keys || keys.has(node.workKey ?? node.id) || !!node.parentId && keys.has(node.parentId)) && (!props.query.trim() || `${node.title} ${node.detail ?? ''}`.toLowerCase().includes(props.query.trim().toLowerCase())))
})
watch([() => props.query, focus], () => { selectedId.value = ''; void returnToRecent(Math.max(1, viewport.value.zoom)) }, { flush: 'post' })
const visibleNodes = computed(() => layout.value.nodes), visibleEdges = computed(() => layout.value.edges)
const flowNodes = computed(() => [...layout.value.regions.map(region => ({ id: region.id, type: 'region', position: { x: region.x, y: region.y }, zIndex: -1, selectable: false, draggable: false, data: { ...region, ports: flowEdges.value.flatMap(edge => [edge.source === region.id ? { id: edge.id + '-source', type: 'source' as const, title: trace(edge.data) } : undefined, edge.target === region.id ? { id: edge.id + '-target', type: 'target' as const, title: trace(edge.data) } : undefined].filter(port => !!port)) } })), ...visibleNodes.value.map(node => ({
  id: node.id, type: 'overview', position: layout.value.positions.get(node.id)!,
  data: { node, role: role(node.kind), authority: authority(node.authority), status: node.status ? status(node.status) : '',
    children: childCount(node.id), expanded: expanded.value.has(node.id), selected: selectedId.value === node.id,
    disclosure: t(expanded.value.has(node.id) ? 'Collapse children' : 'Expand children'), activate: () => activate(node.id) },
}))])
function trace(edge: { from: string; to: string; evidence: string }) { return edge.from + ' → ' + edge.to + ': ' + edge.evidence }
const flowEdges = computed(() => [...overviewFlowEdges(visibleEdges.value, label).map(edge => ({ ...edge, sourceHandle: edge.source.startsWith('region:') ? edge.id + '-source' : undefined, targetHandle: edge.target.startsWith('region:') ? edge.id + '-target' : undefined, label: edge.source.startsWith('region:') || edge.target.startsWith('region:') ? label(edge.data.kind) : edge.label })), ...layout.value.regions.map(region => ({ id: 'ownership:' + region.owner, data: { from: region.owner, to: region.id, evidence: 'Visual ownership only; not causation.' }, source: region.owner, target: region.id, targetHandle: 'ownership', markerEnd: MarkerType.ArrowClosed, type: 'smoothstep', selectable: false, deletable: false, style: { stroke: 'var(--c-blue)', strokeDasharray: '5 5' } }))])
function childCount(id: string) { return layout.value.children.get(id)?.length ?? 0 }
let centerToken = 0
async function centerExpanded(id: string) {
 const token = ++centerToken; await nextTick(); await new Promise<void>(resolve => setTimeout(resolve, 32))
 if (token !== centerToken || !expanded.value.has(id)) return
 const position = layout.value.positions.get(id), element = canvas.value
 if (!position || !element) return
 const panel = element.parentElement?.querySelector('.context')?.getBoundingClientRect()
 const bounds = element.getBoundingClientRect(), available = panel && panel.left > bounds.left + 340 ? panel.left - bounds.left - 12 : bounds.width
 const zoom = Math.max(1, viewport.value.zoom), toolbar = element.querySelector('.canvas-toolbar')?.getBoundingClientRect()
 void setViewport({ x: available / 2 - (position.x + 140) * zoom, y: Math.max(104, (toolbar?.bottom ?? bounds.top + 80) - bounds.top + 20) - position.y * zoom, zoom }, { duration: 240 })
}
function activate(id: string) {
  selectedId.value = id; edgeEvidence.value = ''
  if (childCount(id)) { const next = new Set(expanded.value); if (next.has(id)) next.delete(id); else { next.add(id); void centerExpanded(id) }; expanded.value = next }
  void loadContext(graph.value.nodes.find(node => node.id === id)?.workKey)
}
const selectedNode = computed(() => graph.value.nodes.find(node => node.id === selectedId.value)), selectedEdges = computed(() => graph.value.edges.filter(edge => edge.from === selectedId.value || edge.to === selectedId.value))
const relationKinds = ['causal', 'hierarchy', 'dependency', 'relation', 'precedence', 'context', 'reference', 'reconsiders']
function label(kind: string) { return t(({ causal: 'Decision changed work (applied)', hierarchy: 'Parent → child', dependency: 'Dependency', relation: 'Saved purpose relation', precedence: 'Earlier → later (not cause)', context: 'Recorded context', reference: 'Cited decision (not cause)', reconsiders: 'Reconsiders prior decision' } as const)[kind as 'hierarchy'] ?? 'Recorded context') }
function role(kind: string) { return t(({ group: 'Inferred topic group', outcome: 'Outcome or discussed option', topic: 'Topic', goal: 'Goal', task: 'Task', approach: 'Approach', decision: 'Decision', result: 'Reported result', question: 'Question', unavailable: 'Unavailable record', constraint: 'Constraint', evidence: 'Evidence' } as const)[kind as 'goal'] ?? 'Task') }
function authority(value: string) { return t(({ session_derived: 'Session-derived topic', human: 'Human', user: 'Human answer', parent: 'Parent model answer', timeout: 'Timeout default (not a human or model choice)', agent_interpretation: 'Observer interpretation', reported: 'Reported state', pending: 'Pending — no decision recorded', invalidated: 'Invalidated', unknown: 'Unknown' } as const)[value as 'human'] ?? 'Unknown') }
function status(value: string) { return t(({ running: 'Running', waiting: 'Waiting', 'waiting-for-call': 'Waiting for call', inactive: 'Inactive', failed: 'Failed', mixed: 'Mixed dispositions', completed: 'Completed', reported_complete: 'Reported complete', deferred: 'Deferred', abandoned: 'Abandoned', unknown: 'Unknown', planned: 'Planned', done: 'Execution ended', in_progress: 'In progress', blocked: 'Blocked', pending: 'Pending', cancelled: 'Cancelled' } as const)[value as 'done'] ?? 'Reported state') }
async function loadContext(key?: string, retry = false) {
  if (!key || loading.value) return
  const topic = topics.value.find(topic => topic.items.some(item => item.key === key)); if (!topic) return
  const current = generation; loading.value = true; historyError.value = false
  for (const session of topic.sessions) {
    if (!retry && history.value[session.sessionId]) continue
    try { const response = await fetch(`${props.apiBase}/api/work-history?sessionId=${encodeURIComponent(session.sessionId)}`); if (!response.ok) throw new Error('unavailable'); const body = await response.json(); const records = body.records.map(parseYieldDecisionRecord); if (generation === current) { history.value = { ...history.value, [session.sessionId]: records }; partial.value ||= !!body.truncated || body.errors.length > 0 } }
    catch { if (generation === current) historyError.value = true }
  }
  if (generation === current) loading.value = false
}
</script>
<style scoped>
 .overview { display:flex;flex:1;min-height:0;min-width:0;position:relative; }
p { font-size:13px;overflow-wrap:anywhere; }.notice,small,time { font-size:12px;color:var(--c-text-secondary); }
button,input,select { font:inherit;font-size:12px;border:1px solid var(--c-border);background:var(--c-bg-card);color:var(--c-text);border-radius:6px;padding:8px;min-width:0; }button { cursor:pointer; }button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible { outline:2px solid var(--c-blue); }
.graph-workspace { position:relative;display:flex;flex:1;min-height:0;min-width:0; }.graph-canvas { position:relative;flex:1;min-height:0;min-width:0;overflow:hidden;background:var(--c-bg-soft); }
.canvas-toolbar { position:absolute;z-index:5;top:12px;left:12px;right:12px;display:flex;align-items:center;gap:6px;width:fit-content;max-width:calc(100% - 24px);padding:6px;background:var(--c-bg-card);border:1px solid var(--c-border);border-radius:10px;box-shadow:0 4px 16px #00000012; }
.canvas-toolbar input { width:190px; }.canvas-toolbar select { max-width:240px; }.canvas-toolbar button { white-space:nowrap; }
.canvas-help { position:absolute;z-index:6;top:68px;left:12px;max-width:440px;max-height:calc(100% - 100px);overflow:auto;padding:12px;background:var(--c-bg-card);border:1px solid var(--c-border);border-radius:10px; }
.focus-notice { position:absolute;z-index:4;top:66px;left:18px;right:18px;margin:0;max-height:54px;overflow:auto;pointer-events:auto;background:var(--c-bg-card);padding:6px;border-radius:6px; }
.legend { display:flex;gap:8px;flex-wrap:wrap; }.legend span { font-size:11px;border-bottom:2px solid var(--c-text-muted);padding:4px; }.legend .causal { border-color:var(--c-success); }.legend .hierarchy { border-color:var(--c-blue); }.legend .dependency { border-color:var(--c-warn); }.legend .precedence { border-bottom-style:dotted; }.legend .context,.legend .reference { border-bottom-style:dashed; }
.canvas-empty { position:absolute;top:45%;left:50%;transform:translate(-50%,-50%);text-align:center; }
.context { position:absolute;z-index:7;right:12px;top:68px;bottom:12px;width:min(320px,calc(100% - 24px));box-sizing:border-box;padding:14px;background:var(--c-bg-card);border:1px solid var(--c-border);border-radius:10px;overflow:auto;box-shadow:0 6px 24px #00000018; }.context-close { float:right; }.context h3 { margin-top:0;font-size:15px;padding-right:30px; }.context small { overflow-wrap:anywhere; }.context li { font-size:12px;margin-bottom:10px; }.context ul { padding-left:18px; }.context summary { cursor:pointer;font-size:12px;margin:12px 0; }
:deep(.vue-flow__controls-button) { background:var(--c-bg-card);color:var(--c-text);border-bottom-color:var(--c-border); }:deep(.vue-flow__controls-button svg) { fill:currentColor; }:deep(.vue-flow__edge-text) { fill:var(--c-text-secondary);font-size:10px; }:deep(.vue-flow__edge-textbg) { fill:var(--c-bg-card); }
@media(max-width:600px) { .canvas-toolbar { gap:4px;left:6px;right:6px;max-width:calc(100% - 12px);padding:4px; }.canvas-toolbar input { width:100px;flex:1; }.canvas-toolbar select { width:100px;flex:1; }.canvas-toolbar button { font-size:11px;padding:8px 4px; } }
</style>
