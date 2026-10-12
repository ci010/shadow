<template>
  <section class="overview" :aria-label="t('Project overview graph')">
    <header><h2>{{ t('Project overview graph') }}</h2><p>{{ t('One graph connects topics, approaches, decisions and reported results. Time order is not causation.') }}</p></header>
    <nav class="focus-groups" :aria-label="t('Recent focus')"><button :aria-pressed="!focus" @click="focus = ''">{{ t('All work') }}</button><button v-for="group in groups" :key="group.key" :aria-pressed="focus === group.key" @click="focus = group.key">{{ group.title || t('Unclassified topics') }} · {{ group.topics.length }}</button></nav>
    <p v-if="activeGroup?.inferred" class="notice">{{ t('Model interpretation — not confirmed user intent') }} · {{ activeGroup.purpose }} · {{ activeGroup.motivation }} <span v-if="activeGroup.stale">{{ t('Topics changed since organization. This interpretation may be stale.') }}</span></p>
    <div class="legend"><span v-for="kind in relationKinds" :key="kind" :class="kind">{{ label(kind) }}</span></div>
    <p class="notice">{{ t('Saved references and work links show recorded context, not verified downstream impact. Missing causal evidence is not invented.') }}</p>
    <div class="graph-scroll"><div class="graph" :style="{ height: `${layout.height}px`, width: `${layout.width}px` }">
      <svg aria-hidden="true" :height="layout.height" :width="layout.width"><path v-for="(edge, index) in visibleEdges" :key="index" :class="edge.kind" :d="path(edge)" /></svg>
      <button v-for="node in visibleNodes" :key="node.id" class="node" :data-node-id="node.id" :class="{ selected: selectedNode?.id === node.id }" :aria-expanded="childCount(node.id) ? expanded.has(node.id) : undefined" :style="{ top: `${layout.positions.get(node.id)!.y}px`, left: `${layout.positions.get(node.id)!.x}px` }" @click="activate(node.id)">
        <small>{{ role(node.kind) }} · {{ authority(node.authority) }}<span v-if="node.status"> · {{ status(node.status) }}</span></small><strong>{{ node.title }}</strong><time>{{ node.at ? new Date(node.at).toLocaleString() : t('Unknown time') }}</time>
        <small v-if="childCount(node.id)">{{ expanded.has(node.id) ? t('Collapse children') : t('Expand children') }} · {{ childCount(node.id) }}</small>
      </button>
    </div></div>
    <p v-if="!visibleNodes.length">{{ t('No recorded topics yet') }}</p>
    <aside v-if="selectedNode" class="context"><h3>{{ selectedNode.title }}</h3><p>{{ selectedNode.detail }}</p><p>{{ role(selectedNode.kind) }} · {{ authority(selectedNode.authority) }}</p><small>{{ t('Evidence') }}: {{ selectedNode.evidence }}</small>
      <p><button v-if="selectedNode.workKey" @click="emit('select', selectedNode.workKey)">{{ t('Work details') }}</button> <button v-if="selectedNode.sessionId" @click="emit('session', selectedNode.sessionId)">{{ t('Open conversation') }}</button></p>
      <ul><li v-for="(edge, index) in selectedEdges" :key="index"><strong>{{ label(edge.kind) }}</strong> · <button @click="selectedId = edge.from === selectedNode.id ? edge.to : edge.from">{{ graph.nodes.find(node => node.id === (edge.from === selectedNode?.id ? edge.to : edge.from))?.title }}</button><p>{{ edge.evidence }}</p></li></ul>
      <p v-if="historyError" role="alert">{{ t('Decision history unavailable') }} <button @click="loadContext(selectedNode.workKey, true)">{{ t('Retry') }}</button></p><p v-if="partial" class="notice">{{ t('History is partial: older records or unreadable segments are not shown.') }}</p><p v-if="loading" role="status">{{ t('Loading…') }}</p>
    </aside>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { t } from '../i18n.ts'
import type { ProjectWorkOverview } from '../../../src/projects/work-overview.ts'
import { parseYieldDecisionRecord, type YieldDecisionRecord } from '../../../src/sessions/yield-contract.ts'
import { overviewGraph, overviewLayout, type OverviewEdge } from '../project-overview-graph.ts'
import { projectTopics, projectFocusGroups } from '../project-topic-history.ts'
const props = defineProps<{ data: ProjectWorkOverview; apiBase: string; query: string }>()
const emit = defineEmits<{ select: [key: string]; session: [id: string] }>()
const focus = ref(''), selectedId = ref(''), history = shallowRef<Record<string, YieldDecisionRecord[]>>({}), loading = ref(false), historyError = ref(false), partial = ref(false)
const expanded = ref(new Set<string>())
let generation = 0
watch(() => props.apiBase, () => { generation++; expanded.value = new Set(); history.value = {}; selectedId.value = ''; loading.value = false; historyError.value = false; partial.value = false })
const topics = computed(() => projectTopics(props.data)), groups = computed(() => projectFocusGroups(topics.value, props.data.focus)), activeGroup = computed(() => groups.value.find(group => group.key === focus.value))
const graph = computed(() => overviewGraph(props.data, Object.values(history.value).flat()))
const layout = computed(() => {
  const keys = activeGroup.value ? new Set(activeGroup.value.topics.flatMap(topic => [topic.key, ...topic.items.map(item => item.key)])) : undefined
  return overviewLayout(graph.value, expanded.value, node => (!keys || keys.has(node.workKey ?? node.id)) && (!props.query.trim() || `${node.title} ${node.detail ?? ''}`.toLowerCase().includes(props.query.trim().toLowerCase())))
})
const visibleNodes = computed(() => layout.value.nodes), visibleEdges = computed(() => layout.value.edges)
function childCount(id: string) { return layout.value.children.get(id)?.length ?? 0 }
function activate(id: string) {
  selectedId.value = id
  if (childCount(id)) { const next = new Set(expanded.value); if (next.has(id)) next.delete(id); else next.add(id); expanded.value = next }
  void loadContext(graph.value.nodes.find(node => node.id === id)?.workKey)
}
const selectedNode = computed(() => graph.value.nodes.find(node => node.id === selectedId.value)), selectedEdges = computed(() => graph.value.edges.filter(edge => edge.from === selectedId.value || edge.to === selectedId.value))
const relationKinds = ['causal', 'hierarchy', 'dependency', 'relation', 'precedence', 'context', 'reference', 'reconsiders']
function label(kind: string) { return t(({ causal: 'Decision changed work (applied)', hierarchy: 'Parent → child', dependency: 'Dependency', relation: 'Saved purpose relation', precedence: 'Earlier → later (not cause)', context: 'Recorded context', reference: 'Cited decision (not cause)', reconsiders: 'Reconsiders prior decision' } as const)[kind as 'hierarchy'] ?? 'Recorded context') }
function role(kind: string) { return t(({ topic: 'Session-derived topic', goal: 'Goal', task: 'Task', approach: 'Approach', decision: 'Decision', result: 'Reported result', question: 'Question', unavailable: 'Unavailable record', constraint: 'Constraint', evidence: 'Evidence' } as const)[kind as 'goal'] ?? 'Task') }
function authority(value: string) { return t(({ session_derived: 'Session-derived topic', human: 'Human', user: 'Human answer', parent: 'Parent model answer', timeout: 'Timeout default (not a human or model choice)', agent_interpretation: 'Observer interpretation', reported: 'Reported state', pending: 'Pending — no decision recorded', invalidated: 'Invalidated', unknown: 'Unknown' } as const)[value as 'human'] ?? 'Unknown') }
function status(value: string) { return t(({ done: 'Execution ended', in_progress: 'In progress', blocked: 'Blocked', pending: 'Pending', cancelled: 'Cancelled' } as const)[value as 'done'] ?? 'Reported state') }
function path(edge: OverviewEdge) {
  const a = layout.value.positions.get(edge.from)!, b = layout.value.positions.get(edge.to)!
  return `M ${a.x + 140} ${a.y + 112} C ${a.x + 140} ${a.y + 128}, ${b.x + 140} ${b.y - 16}, ${b.x + 140} ${b.y}`
}
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
.overview { padding:16px; } h2 { margin:0; font-size:18px; } p { font-size:13px; overflow-wrap:anywhere; } .notice, small,time { font-size:12px; color:var(--c-text-secondary); } .focus-groups,.legend { display:flex;gap:8px;flex-wrap:wrap;margin:12px 0; } button { cursor:pointer;border:1px solid var(--c-border);background:var(--c-bg-card);color:var(--c-text);border-radius:6px;padding:8px; } button:focus-visible { outline:2px solid var(--c-blue); } [aria-pressed=true],.selected { border-color:var(--c-blue);background:var(--c-selection-bg); } .legend span { font-size:12px;border-bottom:2px solid var(--c-text-secondary);padding:4px; } .graph-scroll { min-width:0;max-width:100%;overflow:auto;border:1px solid var(--c-border);border-radius:8px; } .graph { min-width:100%;position:relative; } svg { position:absolute;inset:0;overflow:visible; } path { fill:none;stroke:var(--c-text-muted);stroke-width:1.5; } path.causal { stroke:var(--c-success);stroke-width:3; } path.hierarchy { stroke:var(--c-blue); } path.dependency { stroke:var(--c-warn); } path.precedence { stroke-dasharray:3 6;opacity:.5; } path.reference,path.context { stroke-dasharray:8 4; } path.reconsiders { stroke:var(--c-error); } .node { position:absolute;width:280px;height:112px;display:flex;flex-direction:column;text-align:left;gap:4px; } .node strong { font-size:13px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical; } .context { margin-top:16px;padding:14px;background:var(--c-bg-soft);border-radius:8px; } .context small { overflow-wrap:anywhere; } .context li { font-size:12px;margin-bottom:10px; }
</style>
