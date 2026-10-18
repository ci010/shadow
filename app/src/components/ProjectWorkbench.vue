<template>
  <section ref="rootElement" class="project-workbench" :class="{ compact: !wide, 'has-panel': !!panel, 'dashboard-panel': view === 'history' }"
    :style="{ '--coordination-panel-width': `${panelWidth}px` }" :aria-label="t('Project workbench')">
    <header class="workbench-heading">
      <h1 class="project-identity" :title="projectName">{{ projectName }}</h1>
      <div v-show="!appsVisible" class="workbench-controls">
        <div class="work-view-switch" role="group" :aria-label="t('Work view')">
          <button type="button" :aria-pressed="view === 'history'" @click="view = 'history'">{{ t('Dashboard') }}</button>
          <button type="button" :aria-pressed="view === 'board'" @click="view = 'board'">{{ t('Board') }}</button>
        </div>
        <button v-if="canWrite && view === 'history'" type="button" :disabled="organizationBusy || organizationDisabled" :title="t('Uses multiple bounded model requests and saves valid patches progressively; no calls on opening.')" :aria-describedby="modelCallNoticeId" @click="organizeTopics('full')">{{ organizing ? t('Organizing…') : t('Reorganize recent topics') }}</button>
        <button v-if="canWrite && view === 'history'" type="button" :disabled="organizationBusy || organizationDisabled" :aria-describedby="modelCallNoticeId" @click="organizeTopics('delta')">{{ t('Update changed topics') }}</button>
        <span :id="modelCallNoticeId" class="model-call-description">{{ t('Up to 8 model requests, 24 tool calls and 120 seconds. Valid patches are saved immediately.') }}</span>
        <button type="button" :aria-expanded="diagnosticsOpen" @click="diagnosticsOpen = !diagnosticsOpen">{{ t('Agent diagnostics') }}</button>
        <span v-if="view !== 'history'" class="work-count">{{ filtered.length }} {{ t('of') }} {{ data?.items.length ?? 0 }} {{ t('items') }}</span>
        <button type="button" class="work-refresh" :disabled="loading" @click="refresh">{{ loading ? t('Refreshing…') : t('Refresh') }}</button>
        <button v-if="canWrite" type="button" class="new-work" @click="newWork">{{ t('New work') }}</button>
      </div>
      <div class="workbench-integrations">
        <button type="button" :aria-pressed="appsVisible" @click="toggleApps">{{ appsVisible ? t('Back to work') : t('Apps') }}</button>
        <button type="button" :aria-expanded="!appsVisible && panel === 'github'" @click="appsVisible = false; panel = panel === 'github' ? '' : 'github'">GitHub</button>
      </div>
      <div v-if="!appsVisible && view === 'history' && organizationDisabled" class="organization-status" role="status">{{ t('Topic organization is disabled. Enable it in Automations to organize topics.') }} <RouterLink :to="automationChatLocation(projectId, 'system:work-organizer')">{{ t('Automation details') }}</RouterLink></div>
      <div v-if="!appsVisible && view === 'history' && organizationProgress" class="organization-status" role="status" aria-live="polite">{{ organizationProgress }}</div>
      <div v-if="!appsVisible && view === 'history' && organizationMessage" class="organization-status" role="status" aria-live="polite">{{ organizationMessage }}</div>
    </header>
    <QuickActions :api-base="apiBase" :project-id="projectId" :active="visible" :can-write="installation.uiScopes.includes('main:admin')" pinned-only />
    <ProjectMicroApps v-if="appsVisible" :api-base="apiBase" :active="visible" :can-write="canWrite" @compose="discussApp" />
    <div v-show="!appsVisible" class="workbench-body">
      <main v-show="wide || !panel || view === 'history'" class="workbench-main">
        <form v-if="view === 'board'" class="work-filters" :aria-label="t('Filter work')" @submit.prevent>
          <label class="work-search">{{ t('Search') }}<input v-model="filter.query" type="search" :placeholder="t('Find work…')" /></label>
          <label>{{ t('Initiative') }}<UiSelect v-model="filter.root"><option value="">{{ t('All work') }}</option><option v-for="item in initiatives" :key="item.key" :value="item.key">{{ item.title }}</option></UiSelect></label>
          <label>{{ t('Assigned to') }}<UiSelect v-model="filter.assignee"><option value="">{{ t('Any session') }}</option><option value="unassigned">{{ t('Unassigned') }}</option>
            <option v-for="session in assignedSessions" :key="session.sessionId" :value="session.sessionId">{{ session.title }}</option>
          </UiSelect></label>
          <label class="completed-filter"><input v-model="filter.terminal" type="checkbox" />{{ t('Include completed') }}</label>
        </form>
        <p v-if="error" class="workbench-error" role="alert">{{ error }} {{ t('Showing the last loaded state, if available.') }} <button @click="refresh">{{ t('Retry') }}</button></p>
        <div v-if="!data && loading" class="workbench-empty" role="status">{{ t('Loading Project work…') }}</div>
        <template v-if="data">
          <details v-if="data.requests.some(request => request.recipient !== 'parent' && request.recipient !== 'caller')" class="work-attention" :open="true">
            <summary>{{ t('Needs your attention') }} · {{ data.requests.filter(request => request.recipient !== 'parent' && request.recipient !== 'caller').length }}</summary>
            <button v-for="request in data.requests.filter(request => request.recipient !== 'parent' && request.recipient !== 'caller')" :key="request.id" type="button" @click="focusRequest(request)">
              <span>{{ request.kind === 'decision' ? t('Decision') : t('Question') }} · {{ sessionTitle(request.sessionId) }}</span>
              <strong>{{ request.question }}</strong><span>{{ t('Open request →') }}</span>
            </button>
          </details>
          <details v-if="diagnosticsOpen" class="work-diagnostics"><summary>{{ t('Internal review and recovery') }} · {{ reviews.length + unknownEffects.length }}</summary>
            <p>{{ t('Agents reassess these branches. You do not need to fill in a review; only explicit questions require your reply.') }}</p>
            <button v-for="item in reviews" :key="item.key" type="button" @click="selectWork(item.key)">
              <span>{{ t('Impact not yet reviewed') }}</span><strong>{{ item.title }}</strong><span>{{ t('Inspect note →') }}</span>
            </button>
            <button v-for="effect in unknownEffects" :key="effect.id" type="button" @click="effect.workKeys[0] ? selectWork(effect.workKeys[0]) : openSession(effect.sessionId)">
              <span>{{ t('Outcome unknown') }}</span><strong>{{ effect.tool }} · {{ sessionTitle(effect.sessionId) }}</strong><span>{{ t('Inspect note →') }}</span>
            </button>
          </details>
          <div v-if="view === 'history'" class="overview-content">
            <ProjectOverviewGraph :data="data" :api-base="apiBase" v-model:query="filter.query" @select="selectWork" @session="openSession" />
          </div>
          <div v-else-if="!data.items.length" class="workbench-empty">
            <span class="i-lucide-workflow empty-work-icon" aria-hidden="true" />
            <h2>{{ t('No work items yet') }}</h2><p>{{ t('Conversations can stay conversations. Ask the coordinator to organize work when there is an outcome to track.') }}</p>
            <button @click="canWrite ? newWork() : emit('coordinator')">{{ canWrite ? t('Talk to coordinator') : t('View coordinator conversation') }}</button>
          </div>
          <div v-else-if="!filtered.length" class="workbench-empty"><h2>{{ t('No matching work') }}</h2><p>{{ t('Try another Initiative, session or search.') }}</p><button @click="clearFilters">{{ t('Clear filters') }}</button></div>
          <div v-else-if="view === 'board'" class="work-board" tabindex="0" :aria-label="t('Work board')">
            <section v-for="group in groups" :key="group.key" class="initiative-group" :aria-label="group.title">
              <h2><span v-if="group.initiative" class="i-lucide-layers" aria-hidden="true" />{{ group.title }}<span>{{ group.items.length }}</span></h2>
              <div class="work-columns" :style="{ '--work-columns': columns.length }">
                <section v-for="column in columns" :key="String(column.status)" class="work-column" :aria-label="column.label">
                  <h3><span :class="`column-dot status-${column.status}`" />{{ column.label }}<span>{{ group.items.filter(item => item.status === column.status).length }}</span></h3>
                  <WorkItemCard v-for="item in group.items.filter(item => item.status === column.status)" :key="item.key"
                    :item="item" :selected="selected === item.key" :session-title="sessionTitle(item.assignee)"
                    :session-exists="sessionExists(item.assignee)" @select="selectWork" @session="openSession" />
                  <p v-if="!group.items.some(item => item.status === column.status)" class="column-empty">{{ t('No items') }}</p>
                </section>
              </div>
            </section>
          </div>

        </template>
      </main>
      <aside v-show="panel" :id="panelId" class="coordination-panel" :aria-label="panel === 'github' ? t('GitHub integration') : t('Work details')">
        <SidebarResizer v-if="visible && wide && panel" edge="left" :model-value="panelWidth" :bounds="resizeBounds"
          :label="t('Resize coordination panel')" :controls="panelId" @update:model-value="preferredPanelWidth = $event" />
        <header class="coordination-panel-heading">
          <h2 ref="panelHeading" tabindex="-1">{{ panel === 'github' ? 'GitHub' : t('Work details') }}</h2>
          <button v-if="selected && panel !== 'work'" @click="panel = 'work'">{{ t('Task') }}</button>
          <button v-if="panel === 'work' && canWrite" @click="discussSelected">{{ t('Discuss') }}</button>
          <button type="button" :aria-label="t('Close coordination panel')" @click="closePanel"><span class="i-lucide-x" aria-hidden="true" /></button>
        </header>
        <div v-show="panel === 'github'" class="project-work-detail">
          <ProjectGitHub :api-base="apiBase" :project-id="projectId" :active="visible && panel === 'github'"
            :can-write="canWrite" :selected="selected" :works="data?.items ?? []" :sessions="data?.sessions ?? []"
            @work="selectWork" @updated="refresh" @compose="discussGitHub" />
        </div>
        <div v-show="panel === 'work'" class="project-work-detail">
          <template v-if="selected">
            <p v-if="selectedItem" class="work-key">{{ selectedItem.title }}</p>
            <button v-if="selectedItem?.assignee && sessionExists(selectedItem.assignee)" class="open-executor" @click="openSession(selectedItem.assignee)">{{ t('Open') }} {{ sessionTitle(selectedItem.assignee) }} →</button>
            <p v-if="selectedItem?.dependencies.length" class="detail-links">{{ t('Depends on:') }}
              <button v-for="key in selectedItem.dependencies" :key="key" @click="selectWork(key)">{{ data?.items.find(item => item.key === key)?.title ?? key }}</button>
            </p>
            <WorkAlignment :key="selected" :api-base="apiBase" :session-id="coordinatorId" project :work-key="selected"
              embedded :expanded="visible && panel === 'work'" :can-write="canWrite" :revision="lease?.work.state.revision"
              :sessions="data?.sessions.filter(session => session.assignable)" @updated="refresh" @editing="editing = $event" />
            <details v-if="canWrite && selectedItem?.assignee && sessionExists(selectedItem.assignee)" class="reporting-settings">
              <summary>{{ t('Advanced reporting settings') }}</summary>
              <DecisionOwner :api-base="apiBase" :session-id="selectedItem.assignee" />
            </details>
          </template>
        </div>
      </aside>
    </div>
  </section>
</template>
<script setup lang="ts">
import { organizationErrorMessage, organizationDiagnostic } from '../organization-error.ts'
import { apiUrl } from '../api-url.ts'
import UiSelect from './UiSelect.vue'
import QuickActions from './QuickActions.vue'
import { t } from '../i18n.ts'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { automationChatLocation } from '../automations.ts'
import { useProjectLiveState } from '../composables/useProjectLiveState.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import type { ProjectLiveLease } from '../project-live-state.ts'
import { ORCHESTRATOR_SESSION_ID as coordinatorId } from '../project-coordination.ts'
import { filterWork, groupWork, workAttention, workColumns, workRoots } from '../project-work.ts'
import WorkItemCard from './WorkItemCard.vue'
import ProjectOverviewGraph from './ProjectOverviewGraph.vue'


import { projectWorkOverviewSchema, type ProjectWorkOverview } from '../../../src/projects/work-overview.ts'
import WorkAlignment from './WorkAlignment.vue'
import DecisionOwner from './DecisionOwner.vue'
import ProjectGitHub from './ProjectGitHub.vue'
import ProjectMicroApps from './ProjectMicroApps.vue'
import SidebarResizer from './SidebarResizer.vue'
import { clampSidebarWidth, sidebarWidthBounds } from '../sidebar-resize.ts'

const props = defineProps<{ apiBase: string; projectId: string; projectName: string; visible: boolean }>()
const emit = defineEmits<{ navigate: [sessionId: string]; compose: [text: string]; coordinator: [] }>()
const live = useProjectLiveState(), installation = useInstallationContext(), route = useRoute(), router = useRouter()
const lease = shallowRef<ProjectLiveLease>()
const lastSnapshot = shallowRef<ProjectWorkOverview>()
const organizationSnapshot = shallowRef<ProjectWorkOverview>()
const data = computed(() => organizationSnapshot.value ?? lease.value?.work.state.value ?? lastSnapshot.value)
const error = computed(() => lease.value?.work.state.error)
const loading = computed(() => lease.value?.work.state.loading)
const canWrite = computed(() => installation.value.uiScopes.includes('chat:write'))
const view = ref<'history' | 'board'>('history'), panel = ref<'work' | 'github' | ''>('')

const selected = ref(''), editing = ref(false), wide = ref(false)

const diagnosticsOpen = ref(false)
const organizing = ref(false), organizationMessage = ref('')
const liveOrganization = computed(() => data.value?.organization?.organization ?? data.value?.focus?.organization)
const organizationDisabled = computed(() => data.value?.organization?.enabled === false)
const organizationBusy = computed(() => organizing.value || liveOrganization.value?.status === 'running')
const organizationProgress = computed(() => {
  const status = liveOrganization.value
  if (!status) return ''
  return `${t(status.mode === 'delta' ? 'Incremental organization' : 'Full organization')} · ${t(status.status === 'running' ? 'Organizing…' : status.status === 'partial' ? 'Partial results saved' : 'Organization complete')} · ${status.coveredCount}/${status.manifestCount} ${t('topics covered')} · ${status.patches} ${t('patches saved')}`
})
let organizationController: AbortController | undefined
async function organizeTopics(mode: 'full' | 'delta' = 'full') {
  if (organizationDisabled.value || organizationBusy.value || !canWrite.value) return
  const apiBase = props.apiBase, projectId = props.projectId
  const controller = new AbortController()
  organizationController = controller
  organizing.value = true; organizationMessage.value = t('Valid patches appear live and remain saved if organization stops.')
  let failureMessage = organizationErrorMessage('organization_network_failed'), diagnostic = ''
  try {
    const response = await fetch(apiUrl(apiBase, '/api/work/organize'), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }), signal: controller.signal })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      failureMessage = organizationErrorMessage(body?.error, response.status)
      diagnostic = organizationDiagnostic(body, response.status)
      throw new Error('Organization HTTP failure')
    }
    if (apiBase !== props.apiBase || projectId !== props.projectId || controller.signal.aborted) return
    const result = projectWorkOverviewSchema.safeParse(await response.json())
    if (!result.success) { failureMessage = organizationErrorMessage('organization_response_invalid'); throw new Error('Invalid organization response') }
    organizationSnapshot.value = result.data
    void lease.value?.work.refresh()
    if (apiBase !== props.apiBase || projectId !== props.projectId || controller.signal.aborted) return
    organizationMessage.value = t('Recent topics organized. Interpretations are not confirmed user intent.')
  } catch {
    void lease.value?.work.refresh()
    if (!controller.signal.aborted && apiBase === props.apiBase && projectId === props.projectId)
      organizationMessage.value = t(failureMessage) + ' ' + t('Any valid partial patches remain saved. Refresh to see the latest results.') + diagnostic
  } finally {
    if (organizationController === controller) { organizing.value = false; organizationController = undefined }
  }
}
watch(() => lease.value?.work.state.revision, () => { organizationSnapshot.value = undefined })
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
const modelCallNoticeId = `model-call-${useId()}`
const containerWidth = ref(0), preferredPanelWidth = ref(400)
const resizeBounds = computed(() => sidebarWidthBounds(containerWidth.value, 320, containerWidth.value))
const panelWidth = computed(() => clampSidebarWidth(preferredPanelWidth.value, resizeBounds.value))
const filter = reactive({ query: '', root: '', assignee: '', terminal: false })
const overviewMatches = computed(() => filterWork(data.value?.items ?? [], { query: filter.query, root: '', assignee: '', terminal: true }))
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
    title: overview.sessions.find(session => session.sessionId === sessionId)?.title ?? t('{sessionId} (unavailable)', { sessionId: sessionId }) }))
})
const rootElement = ref<HTMLElement>(), panelHeading = ref<HTMLElement>()
let observer: ResizeObserver | undefined
const sessionTitle = (id: string | null) => data.value?.sessions.find(session => session.sessionId === id)?.title ?? id ?? t('Unassigned')
const sessionExists = (id: string | null) => !!id && !!data.value?.sessions.some(session => session.sessionId === id)
function refresh() { if (props.visible) void lease.value?.work.refresh() }
function clearFilters() { Object.assign(filter, { query: '', root: '', assignee: '', terminal: false }) }
async function selectWork(key: string) {
  await router.replace({ query: { ...route.query, work: key } })
  if (route.query.work !== key) return
  panel.value = 'work'
  await nextTick(); panelHeading.value?.focus()
}
async function discussGitHub(text: string) {
  await nextTick()
  emit('compose', text)
}
function openSession(id: string) {
  if (id === coordinatorId) emit('coordinator')
  else emit('navigate', id)
}
async function closePanel() {
  panel.value = ''
  await nextTick(); rootElement.value?.querySelector<HTMLButtonElement>('.work-view-switch button')?.focus()
}
async function discussSelected() {
  await nextTick()
  emit('compose', `About work ${selected.value}${selectedItem.value ? ` (${selectedItem.value.title})` : ''}:\n`)
}
async function discussNode(key: string) {
  const item = data.value?.items.find(item => item.key === key)
  await nextTick()
  emit('compose', t('Discuss the premise of {title} ({key}):', { title: item?.title ?? key, key }) + '\n')
}
async function focusRequest(request: ProjectWorkOverview['requests'][number]) {
  view.value = 'history'

  clearFilters()
  panel.value = ''
  openSession(request.sessionId)
}
async function newWork() {
  panel.value = ''
  await nextTick()
  emit('compose', 'Help me organize a new work item:\n')
}
watch(() => [props.apiBase, props.projectId, props.visible] as const, ([apiBase, projectId, visible], previous) => {
  if (apiBase !== previous?.[0] || projectId !== previous?.[1]) {
    organizationSnapshot.value = undefined; organizationController?.abort(); organizationController = undefined; organizing.value = false; organizationMessage.value = ''
  }
  lastSnapshot.value = apiBase === previous?.[0] && projectId === previous?.[1] ? data.value : undefined
  lease.value?.release(); lease.value = undefined
  if (visible) lease.value = live.acquireProject(apiBase, projectId, undefined, true)
}, { immediate: true })
watch(() => route.query.work, key => {
  if (props.visible && typeof key === 'string' && key !== selected.value) {
    editing.value = false; selected.value = key; panel.value = 'work'
  }
}, { immediate: true })
const removeGuard = router.beforeEach((to, from) => {
  if (!props.visible || !editing.value || to.fullPath === from.fullPath || to.query.work === selected.value) return true
  return window.confirm(t('Leave this item with an unsaved work revision? Switching work items discards the revision.'))
})
onMounted(() => {
  observer = new ResizeObserver(() => {
    const width = rootElement.value?.clientWidth ?? 0
    if (!width) return
    containerWidth.value = width
    wide.value = width >= 1000
  })
  if (rootElement.value) observer.observe(rootElement.value)
})
onUnmounted(() => { organizationController?.abort(); lease.value?.release(); observer?.disconnect(); removeGuard() })
</script>
<style scoped>
.model-call-description { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.overview-content { display:flex; flex:1; overflow:hidden; min-height:0; }
.overview-structure, .overview-graph { margin: 16px; border: 1px solid var(--c-border); border-radius: 8px; padding: 12px; }
.overview-structure summary, .overview-graph summary { cursor: pointer; }
.project-workbench { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; color: var(--c-text); }
.workbench-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 12px; border-bottom: 1px solid var(--c-border); flex-shrink: 0; }
.project-identity { margin: 0; min-width: 0; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 600; line-height: 34px; }
.workbench-controls { display: flex; flex: 1; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.workbench-integrations { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.organization-status { flex-basis: 100%; min-width: 0; overflow-wrap: anywhere; font-size: 12px; line-height: 1.4; color: var(--c-text-secondary); }
button:where(:not(.ui-select)), input, .ui-select { font: inherit; font-size: 12px; }
button:where(:not(.ui-select)) { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 5px 9px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-card); cursor: pointer; }
button:where(:not(.ui-select)):hover:not(:disabled) { background: var(--c-bg-muted); }
button:where(:not(.ui-select)):disabled { opacity: .6; cursor: default; }
button:where(:not(.ui-select)):focus-visible, input:focus-visible, .ui-select:is(:focus-visible, :has(:focus-visible)), summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
button:where(:not(.ui-select)) > span[class^=i-], h2 > span[class^=i-] { width: 15px; height: 15px; flex-shrink: 0; }
.workbench-body { position:relative; display: grid; grid-template-columns: minmax(0, 1fr); flex: 1; min-height: 0; }
.has-panel:not(.compact) .workbench-body { grid-template-columns: minmax(0, 1fr) var(--coordination-panel-width); }
.workbench-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.work-view-switch { display: inline-flex; align-items: center; flex-shrink: 0; gap: 0; }
.work-view-switch button:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.work-view-switch button:last-child { border-top-left-radius: 0; border-bottom-left-radius: 0; }
.advanced-views { font-size: 12px; }
.advanced-views summary { cursor: pointer; padding: 6px; }
.advanced-views[open] { display: flex; }
.advanced-views button { margin: 2px; }
.work-view-switch button:where(:not(.ui-select)) + button:where(:not(.ui-select)) { margin-left: -1px; }
[aria-pressed=true] { background: var(--c-selection-bg); border-color: var(--c-selection-border); color: var(--c-primary); }
.work-count { white-space: nowrap; font-size: 12px; color: var(--c-text-secondary); }
.new-work { color: var(--c-primary); }
.work-filters { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; padding: 4px 16px 14px; border-bottom: 1px solid var(--c-border-soft); }
.work-filters label { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 100px; font-size: 12px; color: var(--c-text-secondary); }
.work-filters input:not([type=checkbox]), .work-filters .ui-select { width: 100%; min-width: 0; min-height: 34px; padding: 5px 7px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); }
.work-filters .completed-filter { flex: none; flex-direction: row; align-items: center; min-height: 34px; }
.workbench-error { padding: 10px 16px; margin: 0; color: var(--c-error); font-size: 12px; }
.work-diagnostics { flex-shrink: 0; padding: 8px 16px; font-size: 12px; color: var(--c-text-secondary); max-height: 180px; overflow: auto; border-bottom: 1px solid var(--c-border-soft); }
.work-diagnostics summary { cursor: pointer; }
.work-diagnostics button { margin: 4px; }
.work-attention { flex-shrink: 0; max-height: 200px; overflow-y: auto; padding: 10px 16px; border-bottom: 1px solid var(--c-border); background: var(--c-warn-bg); }
.work-attention summary { font-size: 13px; font-weight: 600; cursor: pointer; color: var(--c-warn); }
.work-attention button:where(:not(.ui-select)) { display: flex; width: 100%; justify-content: start; text-align: left; flex-wrap: wrap; border: 0; border-top: 1px solid var(--c-border-soft); background: transparent; margin-top: 6px; padding: 7px 0; }
.work-attention strong { flex: 1; min-width: 120px; font-weight: 500; overflow-wrap: anywhere; }
.work-attention button:where(:not(.ui-select)) > span { color: var(--c-text-secondary); }
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
.dashboard-panel.has-panel .workbench-body { grid-template-columns:minmax(0,1fr); }
.dashboard-panel .coordination-panel { position:absolute;z-index:10;right:0;top:0;bottom:0;width:min(var(--coordination-panel-width),100%);box-shadow:-8px 0 24px #00000018; }
.coordination-panel-heading { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--c-border-soft); }
.coordination-panel-heading h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; }
.project-work-detail { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; }
.work-key { margin: 0 0 12px; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.open-executor { margin-bottom: 10px; }
.detail-links { font-size: 12px; }
.detail-links button:where(:not(.ui-select)) { border: 0; color: var(--c-primary); text-align: left; }
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
  .workbench-controls { order: 3; flex-basis: 100%; }
  .organization-status { order: 4; }
  .project-identity { flex: 1; max-width: none; }
}
@media (pointer: coarse), (max-width: 700px) { button:where(:not(.ui-select)), .work-filters input:not([type=checkbox]), .work-filters .ui-select { min-height: 44px; } }
</style>
