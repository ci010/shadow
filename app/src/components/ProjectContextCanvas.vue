<template>
  <div ref="root" class="context-canvas" :aria-label="t('Project goal map')" tabindex="0">
    <header class="canvas-intro">
      <h2>{{ t('Project goal map') }}</h2>
      <p>{{ t('Follow a branch for context, notes and decisions.') }}</p>
    </header>
    <p v-if="!data.items.length" class="canvas-empty">{{ t('There is no goal map yet. Conversations and questions still appear below; tracking is optional.') }}</p>
    <p v-else-if="!rows.length" class="canvas-empty">{{ t('No matching work') }}</p>
    <article v-for="row in rows" :key="row.item.key" :data-work-key="row.item.key"
      class="context-node" :class="{ root: row.depth === 0, selected: selected === row.item.key, contextual: row.contextOnly }"
      :style="{ '--node-depth': Math.min(row.depth, 4) }">
      <p v-if="row.item.notes?.relation" class="node-relation">{{ relationLabel(row.item.notes.relation.kind) }}: {{ row.item.notes.relation.reason }}</p>
      <header class="node-heading">
        <button v-if="row.children" class="branch-toggle" type="button" :aria-expanded="expanded.has(row.item.key)"
          :aria-label="t('Toggle branch: {title}', { title: row.item.title })" @click="toggle(row.item.key)">
          <span :class="expanded.has(row.item.key) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" aria-hidden="true" />
        </button>
        <h3><button type="button" @click="emit('select', row.item.key)">{{ row.item.title }}</button></h3>
        <span class="node-kind">{{ workKind(row.item.notes?.kind ?? 'task') }}</span>
        <span class="node-status" :class="`status-${row.item.status}`">{{ workStatus(row.item) }}</span>
      </header>
      <div class="node-body">
        <p v-if="row.item.objective" class="node-objective">{{ row.item.objective }}</p>
        <p class="node-provenance">{{ row.item.origin === 'human' ? t('User-defined goal') : t('Working interpretation') }}</p>
        <p v-if="row.item.contextChanged" class="impact-pending" role="status">{{ t('An ancestor changed. This branch has not been reassessed yet.') }}</p>
        <p v-if="row.item.notes?.attention && !row.item.notes.attention.reviewed" class="impact-pending">
          <strong>{{ t('Impact not yet reviewed') }}</strong> {{ row.item.notes.attention.summary }}
        </p>
        <WorkNoteContent v-if="row.item.notes" :notes="row.item.notes" :api-base="apiBase" :compact="!details.has(row.item.key)" />
        <p v-if="row.item.blockedReason" class="node-blocker">{{ t('Blocker') }}: {{ row.item.blockedReason }}</p>
        <div class="node-executions">
          <template v-for="session in linkedSessions(row.item)" :key="session.sessionId">
            <button type="button" @click="emit('session', session.sessionId)">{{ session.title }}</button>
            <span>{{ sessionActivity(session.activity).label }}</span>
          </template>
        </div>
        <div class="node-actions">
          <button type="button" :aria-expanded="details.has(row.item.key)" @click="toggleDetails(row.item.key)">{{ details.has(row.item.key) ? t('Less detail') : t('Inspect notes') }}</button>
          <button v-if="canWrite" type="button" @click="emit('select', row.item.key)">{{ t('Edit note') }}</button>
          <button v-if="canWrite" type="button" @click="emit('discuss', row.item.key)">{{ t('Discuss this premise') }}</button>
          <span v-if="row.children && !expanded.has(row.item.key)" class="collapsed-count">{{ t('{count} branches', { count: row.children }) }}</span>
        </div>
        <YieldQuestion v-for="request in anchored.get(row.item.key) ?? []" :key="request.id"
          :api-base="apiBase" :session-id="request.sessionId" :expected-request-id="request.id"
          :active="active" stage="waiting" :can-answer="canWrite" embedded work-navigable
          @work="emit('select', $event)" @inspect="emit('session', $event)" @request="requestChanged(request.id, $event)" @cancelled="emit('updated')" />
      </div>
    </article>
    <section v-if="unanchored.length" class="unlinked-questions" :aria-label="t('Questions without a goal link')">
      <h2>{{ t('Questions without a goal link') }}</h2>
      <p>{{ t('A work item is not required to ask. These questions have no recorded goal path.') }}</p>
      <YieldQuestion v-for="request in unanchored" :key="request.id"
        :api-base="apiBase" :session-id="request.sessionId" :expected-request-id="request.id"
        :active="active" stage="waiting" :can-answer="canWrite" embedded
        @inspect="emit('session', $event)" @request="requestChanged(request.id, $event)" @cancelled="emit('updated')" />
    </section>
    <section class="project-activity" :aria-label="t('Activity outside the map')">
      <h2>{{ t('Activity outside the map') }}</h2>
      <p>{{ t('Live execution activity is not work acceptance. Sessions remain visible without creating notes.') }}</p>
      <p v-if="!unlinkedSessions.length">{{ t('All visible sessions are linked to work.') }}</p>
      <ul><li v-for="session in unlinkedSessions.slice(0, showAll ? undefined : 6)" :key="session.sessionId">
        <button type="button" @click="emit('session', session.sessionId)">{{ session.title }}</button>
        <span>{{ sessionActivity(session.activity).label }}</span>
      </li></ul>
      <button v-if="unlinkedSessions.length > 6" type="button" :aria-expanded="showAll" @click="showAll = !showAll">{{ showAll ? t('Less detail') : t('Show all sessions') }}</button>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { t } from '../i18n.ts'
import { relationLabel, workCanvasRows, workKind, workPath, workStatus } from '../project-work.ts'
import { isWorkingStage, sessionActivity } from '../session-activity.ts'
import type { ProjectWorkItem, ProjectWorkOverview } from '../../../src/projects/work-overview.ts'
import type { AskRequest } from '../yield-requests.ts'
import WorkNoteContent from './WorkNoteContent.vue'
import YieldQuestion from './YieldQuestion.vue'
const props = defineProps<{ data: ProjectWorkOverview; matches: ProjectWorkItem[]; apiBase: string; selected: string; canWrite: boolean; active: boolean; filtering?: boolean; focusRequest?: { id: string } }>()
const emit = defineEmits<{ select: [key: string]; session: [id: string]; discuss: [key: string]; updated: [] }>()
const expanded = ref(new Set<string>()), details = ref(new Set<string>()), showAll = ref(false)
const root = ref<HTMLElement>()
let pendingFocus: string | undefined
const seenNodes = new Set<string>(), seenRequests = new Set<string>(), loadedRequests = new Set<string>()
const matchKeys = computed(() => {
  const anchors = props.data.requests.flatMap(request => request.context ? [request.context.decisionKey] : [])
  return new Set([...props.matches.map(item => item.key), ...(props.selected ? [props.selected] : []), ...anchors])
})
const rows = computed(() => workCanvasRows(props.data.items, matchKeys.value, expanded.value))
const anchored = computed(() => {
  const result = new Map<string, ProjectWorkOverview['requests']>()
  for (const request of props.data.requests) {
    const key = request.context?.decisionKey
    if (key) result.set(key, [...result.get(key) ?? [], request])
  }
  return result
})
const unanchored = computed(() => props.data.requests.filter(request => !request.context
  || !props.data.items.some(item => item.key === request.context?.decisionKey)))
const unlinkedSessions = computed(() => props.data.sessions.filter(session =>
  !props.data.items.some(item => item.assignee === session.sessionId || item.key === session.workKey))
  .sort((a, b) => Number(isWorkingStage(b.activity)) - Number(isWorkingStage(a.activity))))
const linkedSessions = (item: ProjectWorkItem) => props.data.sessions.filter(session => session.sessionId === item.assignee || session.workKey === item.key)
function toggle(key: string) { const next = new Set(expanded.value); next.has(key) ? next.delete(key) : next.add(key); expanded.value = next }
function toggleDetails(key: string) { const next = new Set(details.value); next.has(key) ? next.delete(key) : next.add(key); details.value = next }
function reveal(key: string) {
  expanded.value = new Set([...expanded.value, ...workPath(props.data.items, key).map(item => item.key)])
}
watch(() => props.data, data => {
  for (const item of data.items) {
    if (!seenNodes.has(item.key) && !item.parentKey) expanded.value.add(item.key)
    seenNodes.add(item.key)
  }
  for (const request of data.requests) if (!seenRequests.has(request.id)) {
    if (request.context) reveal(request.context.decisionKey)
    seenRequests.add(request.id)
  }
}, { immediate: true })
watch(() => props.selected, key => { if (key) reveal(key) }, { immediate: true })
watch(() => props.matches.map(item => item.key).join('\n'), () => {
  if (props.filtering) for (const item of props.matches) {
    for (const ancestor of workPath(props.data.items, item.key).slice(0, -1)) expanded.value.add(ancestor.key)
  }
})
watch(() => props.focusRequest, request => {
  if (!request) return
  pendingFocus = request.id
  const context = props.data.requests.find(item => item.id === request.id)?.context
  if (context) reveal(context.decisionKey)
  void focusQuestion()
}, { immediate: true })
async function focusQuestion() {
  await nextTick()
  const element = [...root.value?.querySelectorAll<HTMLElement>('[data-request-id]') ?? []]
    .find(element => element.dataset.requestId === pendingFocus)
  if (!element) return
  element.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  element.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true })
  pendingFocus = undefined
}
function requestChanged(id: string, request: AskRequest | null) {
  if (request) {
    loadedRequests.add(id)
    if (pendingFocus === id) void focusQuestion()
  }
  else if (loadedRequests.delete(id)) emit('updated')
}
</script>
<style scoped>
.context-canvas { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 22px 24px 40px; background: var(--c-bg-card); font-size: 13px; line-height: 1.6; }
.canvas-intro { padding-bottom: 6px; }
h2 { font-size: 19px; font-weight: 600; line-height: 1.4; margin: 0 0 7px; }
.canvas-intro p, .project-activity > p, .unlinked-questions > p { color: var(--c-text-secondary); margin: 0 0 12px; max-width: 75ch; }
.context-node { margin-left: calc(var(--node-depth) * 22px); padding: 16px 0 18px 14px; border-left: 1px solid var(--c-border); border-bottom: 1px solid var(--c-border-soft); overflow-wrap: anywhere; }
.context-node.root { margin-top: 4px; padding-left: 0; border-left: 0; }
.context-node.selected { background: var(--c-bg-soft); }
.node-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
h3 { flex: 1; min-width: 100px; margin: 0; font-size: 16px; font-weight: 600; }
.root h3 { font-size: 19px; }
.node-heading h3 button { text-align: left; font: inherit; padding: 0; }
.node-kind, .node-status, .node-provenance, .node-relation, .node-executions, .collapsed-count { font-size: 12px; color: var(--c-text-secondary); }
.node-relation { margin: 0 0 7px; max-width: 75ch; }
.node-status { white-space: nowrap; }
.status-blocked { color: var(--c-warn); }
.status-done { color: var(--c-success); }
.node-objective { max-width: 75ch; margin: 7px 0 0; white-space: pre-wrap; }
.node-provenance { margin: 3px 0 8px; }
.node-body { min-width: 0; }
.node-executions, .node-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.node-executions button { color: var(--c-primary); padding-inline: 0; }
.node-actions button { padding: 4px 8px; border: 1px solid var(--c-border); }
.impact-pending, .node-blocker { max-width: 75ch; color: var(--c-warn); padding: 8px; background: var(--c-warn-bg); }
.impact-pending strong { font-weight: 500; margin-right: 6px; }
.project-activity, .unlinked-questions { margin-top: 32px; padding-top: 20px; border-top: 1px solid var(--c-border); }
.project-activity ul { list-style: none; padding: 0; margin: 0 0 12px; }
.project-activity li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--c-border-soft); }
.project-activity li span { font-size: 12px; color: var(--c-text-secondary); }
.project-activity li button { text-align: left; overflow-wrap: anywhere; }
button { background: transparent; border: 0; color: var(--c-text); font: inherit; cursor: pointer; min-height: 32px; }
button:hover { background: var(--c-bg-muted); }
.branch-toggle { display: grid; place-items: center; width: 32px; }
.branch-toggle span { width: 16px; height: 16px; }
button:focus-visible, .context-canvas:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.context-canvas:focus-visible { outline-offset: -2px; }
.canvas-empty { padding-block: 20px; color: var(--c-text-secondary); }
@media (max-width: 700px) { .context-canvas { padding: 18px 12px 28px; } .context-node { margin-left: calc(var(--node-depth) * 8px); padding-left: 10px; } .node-kind { display: none; } }
@media (max-width: 700px), (pointer: coarse) { button { min-height: 44px; } }
</style>
