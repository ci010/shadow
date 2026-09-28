<template>
  <section ref="rootElement" class="project-workbench" :class="{ compact: !wide, 'has-panel': !!panel }"
    :style="{ '--coordination-panel-width': `${panelWidth}px` }" aria-label="Project workbench">
    <header class="workbench-heading">
      <div><h1>{{ projectName }}</h1><p>Work, assignments and decisions</p></div>
      <button type="button" :aria-pressed="appsVisible" @click="toggleApps">{{ appsVisible ? 'Back to work' : 'Apps' }}</button>
      <button ref="chatTrigger" type="button" :aria-expanded="panel === 'chat'" @click="toggleChat">
        <span class="i-lucide-messages-square" aria-hidden="true" />Coordinator
      </button>
      <button type="button" :aria-expanded="!appsVisible && panel === 'github'" @click="appsVisible = false; panel = panel === 'github' ? '' : 'github'">GitHub</button>
    </header>
    <ProjectMicroApps v-if="appsVisible" :api-base="apiBase" :active="visible" :can-write="canWrite" @compose="discussApp" />
    <div v-show="!appsVisible" class="workbench-body">
      <main v-show="wide || !panel" class="workbench-main">
        <div class="workbench-toolbar">
          <div class="work-view-switch" role="group" aria-label="Work view">
            <button type="button" :aria-pressed="view === 'board'" @click="view = 'board'">Board</button>
            <button type="button" :aria-pressed="view === 'graph'" @click="view = 'graph'">Graph</button>
          </div>
          <span class="work-count">{{ filtered.length }} of {{ data?.items.length ?? 0 }} items</span>
          <button type="button" :disabled="loading" @click="refresh">{{ loading ? 'Refreshing…' : 'Refresh' }}</button>
          <button v-if="canWrite" type="button" class="new-work" @click="newWork">New work</button>
        </div>
        <form class="work-filters" aria-label="Filter work" @submit.prevent>
          <label class="work-search">Search<input v-model="filter.query" type="search" placeholder="Find work…" /></label>
          <label>Initiative<select v-model="filter.root"><option value="">All work</option><option v-for="item in initiatives" :key="item.key" :value="item.key">{{ item.title }}</option></select></label>
          <label>Assigned to<select v-model="filter.assignee"><option value="">Any session</option><option value="unassigned">Unassigned</option>
            <option v-for="session in assignedSessions" :key="session.sessionId" :value="session.sessionId">{{ session.title }}</option>
          </select></label>
          <label class="completed-filter"><input v-model="filter.terminal" type="checkbox" />Include completed</label>
        </form>
        <p v-if="error" class="workbench-error" role="alert">{{ error }} Showing the last loaded state, if available. <button @click="refresh">Retry</button></p>
        <div v-if="!data && loading" class="workbench-empty" role="status">Loading Project work…</div>
        <template v-if="data">
          <details v-if="data.requests.length || reviews.length || unknownEffects.length" class="work-attention" open>
            <summary>Needs your attention</summary>
            <button v-for="request in data.requests" :key="request.id" type="button" @click="openSession(request.sessionId)">
              <span>{{ request.kind === 'decision' ? 'Decision' : 'Question' }} · {{ sessionTitle(request.sessionId) }}</span>
              <strong>{{ request.question }}</strong><span>Open request →</span>
            </button>
            <button v-for="item in reviews" :key="item.key" type="button" @click="selectWork(item.key)">
              <span>{{ item.proposals ? 'Proposed change' : 'Clarification' }}</span><strong>{{ item.title }}</strong><span>Review →</span>
            </button>
            <button v-for="effect in unknownEffects" :key="effect.id" type="button" @click="effect.workKeys[0] ? selectWork(effect.workKeys[0]) : openSession(effect.sessionId)">
              <span>Outcome unknown</span><strong>{{ effect.tool }} · {{ sessionTitle(effect.sessionId) }}</strong><span>Reconcile →</span>
            </button>
          </details>
          <div v-if="!data.items.length" class="workbench-empty">
            <span class="i-lucide-workflow empty-work-icon" aria-hidden="true" />
            <h2>No work items yet</h2><p>Conversations can stay conversations. Ask the coordinator to organize work when there is an outcome to track.</p>
            <button @click="canWrite ? newWork() : toggleChat()">{{ canWrite ? 'Talk to coordinator' : 'View coordinator conversation' }}</button>
          </div>
          <div v-else-if="!filtered.length" class="workbench-empty"><h2>No matching work</h2><p>Try another Initiative, session or search.</p><button @click="clearFilters">Clear filters</button></div>
          <div v-else-if="view === 'board'" class="work-board" tabindex="0" aria-label="Work board">
            <section v-for="group in groups" :key="group.key" class="initiative-group" :aria-label="group.title">
              <h2><span v-if="group.initiative" class="i-lucide-layers" aria-hidden="true" />{{ group.title }}<span>{{ group.items.length }}</span></h2>
              <div class="work-columns" :style="{ '--work-columns': columns.length }">
                <section v-for="column in columns" :key="String(column.status)" class="work-column" :aria-label="column.label">
                  <h3><span :class="`column-dot status-${column.status}`" />{{ column.label }}<span>{{ group.items.filter(item => item.status === column.status).length }}</span></h3>
                  <WorkItemCard v-for="item in group.items.filter(item => item.status === column.status)" :key="item.key"
                    :item="item" :selected="selected === item.key" :session-title="sessionTitle(item.assignee)"
                    :session-exists="sessionExists(item.assignee)" @select="selectWork" @session="openSession" />
                  <p v-if="!group.items.some(item => item.status === column.status)" class="column-empty">No items</p>
                </section>
              </div>
            </section>
          </div>
          <WorkGraph v-else :items="filtered" :selected="selected" :sessions="data.sessions" @select="selectWork" @session="openSession" />
        </template>
      </main>
      <aside v-show="panel" :id="panelId" class="coordination-panel" :aria-label="panel === 'github' ? 'GitHub integration' : panel === 'chat' ? 'Coordinator conversation' : 'Work details'">
        <SidebarResizer v-if="visible && wide && panel" edge="left" :model-value="panelWidth" :bounds="resizeBounds"
          label="Resize coordination panel" :controls="panelId" @update:model-value="preferredPanelWidth = $event" />
        <header class="coordination-panel-heading">
          <h2 ref="panelHeading" tabindex="-1">{{ panel === 'github' ? 'GitHub' : panel === 'chat' ? 'Coordinator' : 'Work details' }}</h2>
          <button v-if="selected && panel !== 'work'" @click="panel = 'work'">Task</button>
          <button v-if="panel === 'work' && canWrite" @click="discussSelected">Discuss</button>
          <button type="button" aria-label="Close coordination panel" @click="closePanel"><span class="i-lucide-x" aria-hidden="true" /></button>
        </header>
        <div v-show="panel === 'chat'" class="coordinator-conversation">
          <slot :active="visible && panel === 'chat'" />
        </div>
        <div v-show="panel === 'github'" class="project-work-detail">
          <ProjectGitHub :api-base="apiBase" :project-id="projectId" :active="visible && panel === 'github'"
            :can-write="canWrite" :selected="selected" :works="data?.items ?? []" :sessions="data?.sessions ?? []"
            @work="selectWork" @updated="refresh" @compose="discussGitHub" />
        </div>
        <div v-show="panel === 'work'" class="project-work-detail">
          <template v-if="selected">
            <p v-if="selectedItem" class="work-key">{{ selectedItem.title }}</p>
            <button v-if="selectedItem?.assignee && sessionExists(selectedItem.assignee)" class="open-executor" @click="openSession(selectedItem.assignee)">Open {{ sessionTitle(selectedItem.assignee) }} →</button>
            <p v-if="selectedItem?.dependencies.length" class="detail-links">Depends on:
              <button v-for="key in selectedItem.dependencies" :key="key" @click="selectWork(key)">{{ data?.items.find(item => item.key === key)?.title ?? key }}</button>
            </p>
            <WorkAlignment :key="selected" :api-base="apiBase" :session-id="coordinatorId" project :work-key="selected"
              embedded :expanded="visible && panel === 'work'" :can-write="canWrite" :revision="lease?.work.state.revision"
              :sessions="data?.sessions.filter(session => session.assignable)" @updated="refresh" @editing="editing = $event" />
            <details v-if="canWrite && selectedItem?.assignee && sessionExists(selectedItem.assignee)" class="reporting-settings">
              <summary>Advanced reporting settings</summary>
              <DecisionOwner :api-base="apiBase" :session-id="selectedItem.assignee" />
            </details>
          </template>
        </div>
      </aside>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectLiveState } from '../composables/useProjectLiveState.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import type { ProjectLiveLease } from '../project-live-state.ts'
import { ORCHESTRATOR_SESSION_ID as coordinatorId } from '../project-coordination.ts'
import { filterWork, groupWork, workAttention, workColumns, workRoots } from '../project-work.ts'
import WorkItemCard from './WorkItemCard.vue'
import WorkGraph from './WorkGraph.vue'
import WorkAlignment from './WorkAlignment.vue'
import DecisionOwner from './DecisionOwner.vue'
import ProjectGitHub from './ProjectGitHub.vue'
import ProjectMicroApps from './ProjectMicroApps.vue'
import SidebarResizer from './SidebarResizer.vue'
import { clampSidebarWidth, sidebarWidthBounds } from '../sidebar-resize.ts'

const props = defineProps<{ apiBase: string; projectId: string; projectName: string; visible: boolean }>()
const emit = defineEmits<{ navigate: [sessionId: string]; compose: [text: string] }>()
const live = useProjectLiveState(), installation = useInstallationContext(), route = useRoute(), router = useRouter()
const lease = shallowRef<ProjectLiveLease>()
const data = computed(() => lease.value?.work.state.value)
const error = computed(() => lease.value?.work.state.error)
const loading = computed(() => lease.value?.work.state.loading)
const canWrite = computed(() => installation.value.uiScopes.includes('chat:write'))
const view = ref<'board' | 'graph'>('board'), panel = ref<'chat' | 'work' | 'github' | ''>('')
const selected = ref(''), editing = ref(false), wide = ref(false)
const appsVisible = ref(false)
function toggleApps() {
  appsVisible.value = !appsVisible.value
  if (!appsVisible.value && route.query.microApp) {
    const { microApp: _app, ...query } = route.query
    void router.replace({ query })
  }
}
async function discussApp(text: string) { appsVisible.value = false; await discussGitHub(text) }
watch(() => route.query.microApp, id => { if (typeof id === 'string') appsVisible.value = true }, { immediate: true })
const panelId = `coordination-${useId()}`
const containerWidth = ref(0), preferredPanelWidth = ref(400)
const resizeBounds = computed(() => sidebarWidthBounds(containerWidth.value, 320, containerWidth.value))
const panelWidth = computed(() => clampSidebarWidth(preferredPanelWidth.value, resizeBounds.value))
const filter = reactive({ query: '', root: '', assignee: '', terminal: true })
const filtered = computed(() => filterWork(data.value?.items ?? [], filter))
const groups = computed(() => groupWork(filtered.value, data.value?.items ?? []))
const columns = computed(() => workColumns.filter(column => column.status !== 'cancelled' && column.status !== null
  || filtered.value.some(item => item.status === column.status)))
const selectedItem = computed(() => data.value?.items.find(item => item.key === selected.value))
const reviews = computed(() => data.value ? workAttention(data.value) : [])
const unknownEffects = computed(() => data.value?.effects.filter(effect => effect.status === 'unknown') ?? [])
const initiatives = computed(() => {
  const items = data.value?.items ?? [], roots = workRoots(items)
  const keys = new Set(items.filter(item => item.parentKey).map(item => roots.get(item.key)))
  return items.filter(item => keys.has(item.key))
})
const assignedSessions = computed(() => {
  const overview = data.value
  if (!overview) return []
  const keys = new Set(overview.items.flatMap(item => item.assignee ? [item.assignee] : []))
  return [...keys].map(sessionId => ({ sessionId,
    title: overview.sessions.find(session => session.sessionId === sessionId)?.title ?? `${sessionId} (unavailable)` }))
})
const rootElement = ref<HTMLElement>(), panelHeading = ref<HTMLElement>(), chatTrigger = ref<HTMLButtonElement>()
let observer: ResizeObserver | undefined
const sessionTitle = (id: string | null) => data.value?.sessions.find(session => session.sessionId === id)?.title ?? id ?? 'Unassigned'
const sessionExists = (id: string | null) => !!id && !!data.value?.sessions.some(session => session.sessionId === id)
function refresh() { void lease.value?.work.refresh() }
function clearFilters() { Object.assign(filter, { query: '', root: '', assignee: '', terminal: true }) }
async function selectWork(key: string) {
  await router.replace({ query: { ...route.query, work: key } })
  if (route.query.work !== key) return
  panel.value = 'work'
  await nextTick(); panelHeading.value?.focus()
}
function toggleChat() {
  panel.value = appsVisible ? 'chat' : panel.value === 'chat' ? '' : 'chat'
  appsVisible.value = false
}
async function discussGitHub(text: string) {
  panel.value = 'chat'
  await nextTick()
  emit('compose', text)
}
function openSession(id: string) {
  if (id === coordinatorId) panel.value = 'chat'
  else emit('navigate', id)
}
async function closePanel() {
  panel.value = ''
  await nextTick(); chatTrigger.value?.focus()
}
async function discussSelected() {
  panel.value = 'chat'
  await nextTick()
  emit('compose', `About work ${selected.value}${selectedItem.value ? ` (${selectedItem.value.title})` : ''}:\n`)
}
async function newWork() {
  panel.value = 'chat'
  await nextTick()
  emit('compose', 'Help me organize a new work item:\n')
}
watch(() => [props.apiBase, props.projectId, props.visible] as const, () => {
  lease.value?.release(); lease.value = undefined
  if (props.visible) lease.value = live.acquireProject(props.apiBase, props.projectId, undefined, true)
}, { immediate: true })
watch(() => route.query.work, key => {
  if (props.visible && typeof key === 'string' && key !== selected.value) {
    editing.value = false; selected.value = key; panel.value = 'work'
  }
}, { immediate: true })
const removeGuard = router.beforeEach((to, from) => {
  if (!props.visible || !editing.value || to.fullPath === from.fullPath || to.query.work === selected.value) return true
  return window.confirm('Leave this item with an unsaved work revision? Switching work items discards the revision.')
})
onMounted(() => {
  let measured = false
  observer = new ResizeObserver(() => {
    const width = rootElement.value?.clientWidth ?? 0
    if (!width) return
    containerWidth.value = width
    wide.value = width >= 1000
    if (!measured) { measured = true; if (wide.value && !selected.value) panel.value = 'chat' }
  })
  if (rootElement.value) observer.observe(rootElement.value)
})
onUnmounted(() => { lease.value?.release(); observer?.disconnect(); removeGuard() })
defineExpose({ openConversation: () => { appsVisible.value = false; panel.value = 'chat' } })
</script>
<style scoped>
.project-workbench { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; color: var(--c-text); }
.workbench-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--c-border); }
h1 { margin: 0; font-size: 24px; font-weight: 600; line-height: 30px; }
.workbench-heading p { margin: 3px 0 0; font-size: 12px; color: var(--c-text-secondary); }
.workbench-heading > div { flex: 1; min-width: 0; overflow-wrap: anywhere; }
button, input, select { font: inherit; font-size: 12px; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 5px 9px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-card); cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled { opacity: .6; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
button > span[class^=i-], h2 > span[class^=i-] { width: 15px; height: 15px; flex-shrink: 0; }
.workbench-body { display: grid; grid-template-columns: minmax(0, 1fr); flex: 1; min-height: 0; }
.has-panel:not(.compact) .workbench-body { grid-template-columns: minmax(0, 1fr) var(--coordination-panel-width); }
.workbench-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.workbench-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 14px 16px 8px; }
.work-view-switch { display: flex; }
.work-view-switch button + button { margin-left: -1px; }
[aria-pressed=true] { background: var(--c-selection-bg); border-color: var(--c-selection-border); color: var(--c-primary); }
.work-count { flex: 1; min-width: 80px; font-size: 12px; color: var(--c-text-secondary); }
.new-work { color: var(--c-primary); }
.work-filters { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; padding: 4px 16px 14px; border-bottom: 1px solid var(--c-border-soft); }
.work-filters label { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 100px; font-size: 12px; color: var(--c-text-secondary); }
.work-filters input:not([type=checkbox]), .work-filters select { width: 100%; min-width: 0; min-height: 34px; padding: 5px 7px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); }
.work-filters .completed-filter { flex: none; flex-direction: row; align-items: center; min-height: 34px; }
.workbench-error { padding: 10px 16px; margin: 0; color: var(--c-error); font-size: 12px; }
.work-attention { flex-shrink: 0; max-height: 200px; overflow-y: auto; padding: 10px 16px; border-bottom: 1px solid var(--c-border); background: var(--c-warn-bg); }
.work-attention summary { font-size: 13px; font-weight: 600; cursor: pointer; color: var(--c-warn); }
.work-attention button { display: flex; width: 100%; justify-content: start; text-align: left; flex-wrap: wrap; border: 0; border-top: 1px solid var(--c-border-soft); background: transparent; margin-top: 6px; padding: 7px 0; }
.work-attention strong { flex: 1; min-width: 120px; font-weight: 500; overflow-wrap: anywhere; }
.work-attention button > span { color: var(--c-text-secondary); }
.work-board { flex: 1; overflow: auto; min-height: 0; padding: 14px 16px 24px; background: var(--c-bg-soft); }
.work-board:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.initiative-group + .initiative-group { margin-top: 24px; }
.initiative-group > h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 13px; font-weight: 600; }
.initiative-group > h2 > span:last-child { font-weight: 400; color: var(--c-text-secondary); }
.work-columns { display: grid; grid-template-columns: repeat(var(--work-columns), minmax(220px, 1fr)); gap: 12px; }
.work-column { min-width: 0; }
.work-column h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 12px; font-weight: 500; color: var(--c-text-secondary); }
.work-column h3 > span:last-child { margin-left: auto; }
.column-dot { width: 7px; height: 7px; background: var(--c-text-muted); border-radius: 50%; }
.column-dot.status-in_progress { background: var(--c-blue); }
.column-dot.status-blocked { background: var(--c-warn); }
.column-dot.status-done { background: var(--c-success); }
.work-column > article + article { margin-top: 10px; }
.column-empty { margin: 16px 0; font-size: 12px; color: var(--c-text-muted); }
.workbench-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 12px; min-height: 200px; padding: 24px; text-align: center; }
.workbench-empty h2 { margin: 0; font-size: 16px; }
.workbench-empty p { max-width: 48ch; margin: 0; font-size: 13px; line-height: 1.6; color: var(--c-text-secondary); }
.empty-work-icon { width: 28px; height: 28px; color: var(--c-text-muted); }
.coordination-panel { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--c-border); background: var(--c-bg); }
.coordination-panel-heading { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--c-border-soft); }
.coordination-panel-heading h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; }
.coordinator-conversation { display: flex; flex: 1; min-height: 0; overflow: hidden; }
.project-work-detail { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; }
.work-key { margin: 0 0 12px; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.open-executor { margin-bottom: 10px; }
.detail-links { font-size: 12px; }
.detail-links button { border: 0; color: var(--c-primary); text-align: left; }
.reporting-settings { margin-top: 20px; font-size: 12px; color: var(--c-text-secondary); }
.reporting-settings summary { cursor: pointer; }
.compact .workbench-heading { padding: 12px; }
.compact .workbench-heading h1 { font-size: 16px; }
.compact .coordination-panel { border-left: 0; }
.compact .work-columns { grid-template-columns: minmax(0, 1fr); }
.compact .work-column:has(.column-empty) { display: none; }
.compact .work-column + .work-column { margin-top: 14px; }
@media (max-width: 700px) {
  .workbench-heading { flex-wrap: wrap; }
  .workbench-heading > div { flex-basis: 100%; }
}
@media (pointer: coarse), (max-width: 700px) { button, .work-filters input:not([type=checkbox]), .work-filters select { min-height: 44px; } }
</style>
