<template>
  <section ref="root" class="automation-detail" :class="{ 'automation-enabled': enabled, 'runs-open': runsOpen }" aria-label="Automation workspace">
    <button v-if="enabled && runsOpen && narrow" class="runs-backdrop" aria-label="Close runs" @click="runsOpen = false" />
    <aside v-if="enabled" v-show="runsOpen || !narrow" :id="`${id}-runs`" class="automation-explorer" aria-label="Automation runs">
      <header class="explorer-heading">
        <h2>Runs</h2>
        <button type="button" class="icon-button" aria-label="Refresh runs" :disabled="loading" @click="refresh">
          <span class="i-lucide-refresh-cw" :class="{ 'animate-spin': loading && history.loaded }" aria-hidden="true" />
        </button>
        <button v-if="narrow" type="button" class="icon-button" aria-label="Close runs" @click="runsOpen = false"><span class="i-lucide-x" aria-hidden="true" /></button>
      </header>
      <div v-if="catalogError" class="explorer-note" role="alert"><p>{{ catalogError }}</p><button class="text-button" :disabled="catalog.loading.value" @click="catalog.refresh()">Retry automation</button></div>
      <p v-if="automation?.notice" class="explorer-note" role="status">{{ automation.notice }}</p>
      <details class="automation-info">
        <summary>Automation details</summary>
        <div class="automation-info-body" :aria-busy="catalog.loading.value">
          <p v-if="!automation && !catalogError" role="status">Loading automation…</p>
          <template v-if="automation">
            <h3>{{ automation.name }}</h3>
            <dl>
              <dt>{{ automation.source === 'learning' ? 'Check frequency' : 'Schedule' }}</dt><dd><code>{{ automation.schedule }}</code></dd>
              <dt>Agent</dt><dd>{{ automation.agentType || 'Default agent' }}</dd>
              <dt>Dispatch</dt><dd>{{ automation.enabled ? 'Enabled' : 'Disabled' }}</dd>
              <dt>Session mode</dt><dd>Fresh — each dispatch starts a separate conversation.</dd>
              <dt>Prompt</dt><dd class="automation-prompt">{{ automation.task || 'No prompt is available for this automation.' }}</dd>
            </dl>
            <p v-if="automation.source === 'learning'">Checks are activity-gated. A check does not necessarily start a run.</p>
            <p v-if="!automation.enabled">Dispatch is disabled. Saved runs remain available.</p>
            <p>Read-only automation information, not a run’s outcome.</p>
          </template>
        </div>
      </details>
      <div ref="scrollRoot" class="runs-scroll" :aria-busy="history.loading" @scroll="checkMore">
        <TreeRow :label="automation?.name || 'Automation'" :expanded="expanded" :button-attrs="{ 'aria-controls': `${id}-run-list` }" @select="expanded = !expanded">
          <template #icon><span class="i-lucide-repeat-2" /></template>
          <template #meta><span v-if="history.loaded">{{ history.total }}</span></template>
        </TreeRow>
        <div v-show="expanded" :id="`${id}-run-list`" class="run-list" aria-label="Runs, most recent first">
          <div v-if="!history.loaded && history.loading" class="run-skeletons" role="status" aria-label="Loading runs">
            <div v-for="row in 8" :key="row" class="run-skeleton" aria-hidden="true"><i /><i /></div>
          </div>
          <TreeRow v-for="run in history.runs" :key="run.sessionId" :label="started(run.startedAt)" :depth="1"
            :title="`${started(run.startedAt)} · Execution: ${statusLabel(run.status)}${run.learning ? `\nLearning: ${learningOutcomeLabel(run.learning)} — ${run.learning.summary}` : ''}${run.title ? `\n${run.title}` : ''}`"
            :selected="selectedSessionId === run.sessionId" :current="selectedSessionId === run.sessionId ? 'page' : undefined"
            button-class="automation-run" :button-attrs="{ 'data-session-id': run.sessionId }" @select="openRun(run.sessionId)">
            <template #icon><span :class="run.learning && ['partial', 'blocked', 'draft_only'].includes(run.learning.status) ? 'i-lucide-circle-alert' : !run.learning && automation?.source === 'learning' && run.status === 'completed' ? 'i-lucide-circle-help' : statusIcon(run.status)" /></template>
            <template #meta><span class="run-status" :class="`status-${run.learning?.status || run.status}`">{{ run.learning ? learningOutcomeLabel(run.learning) : automation?.source === 'learning' && run.status === 'completed' ? 'Unverified' : statusLabel(run.status) }}</span></template>
          </TreeRow>
          <p v-if="history.loaded && !history.runs.length && !history.error" class="explorer-note">No saved runs yet.</p>
          <div v-if="history.error" class="explorer-note" role="alert"><p>{{ history.error }}</p><button class="text-button" :disabled="history.loading" @click="runHistory?.retry()">Retry runs</button></div>
          <div v-if="history.loaded && history.nextOffset < history.total" ref="sentinel" class="load-more">
            <button class="text-button" :disabled="history.loading" @click="loadMore">{{ history.loading ? 'Loading runs…' : 'Load more runs' }}</button>
          </div>
        </div>
      </div>
      <SidebarResizer v-if="!narrow && active" :model-value="explorerWidth" :bounds="bounds" label="Resize runs" :controls="`${id}-runs`" @update:model-value="preferredWidth = $event" />
    </aside>
    <div class="automation-editor" :style="enabled ? { '--runs-width': `${explorerWidth}px` } : undefined">
      <header v-if="enabled" class="automation-toolbar">
        <button v-if="narrow" :id="`${id}-runs-toggle`" type="button" class="icon-button" aria-label="Toggle runs" :aria-expanded="runsOpen" :aria-controls="`${id}-runs`" @click="runsOpen = !runsOpen"><span class="i-lucide-list-tree" aria-hidden="true" /></button>
        <div ref="tabStrip" class="automation-tabstrip" @wheel="scrollTabStrip">
        <div class="automation-tabs" role="tablist" aria-label="Automation views">
          <div v-for="tab in openTabs" :key="tab.sessionId" class="run-tab" :class="{ selected: selectedSessionId === tab.sessionId && !selectedDocument }">
            <button :id="tabId(tab.sessionId)" class="automation-tab" role="tab" :aria-selected="selectedSessionId === tab.sessionId && !selectedDocument"
              :tabindex="selectedSessionId === tab.sessionId ? 0 : -1" :aria-controls="panelId(tab.sessionId)"
              :title="tab.label" @click="openRun(tab.sessionId)" @keydown="tabKey($event, tab.sessionId)">
              <span class="i-lucide-messages-square" aria-hidden="true" /><span class="tab-label">{{ tab.label }}</span>
            </button>
            <button class="icon-button tab-close" :aria-label="`Close run ${tab.label}`" @click="closeTab(tab.sessionId)"><span class="i-lucide-x" aria-hidden="true" /></button>
          </div>
        </div>
        <div :id="`${id}-documents`" class="automation-documents" />
        </div>
      </header>
      <div v-if="enabled && selectedRun && !selectedDocument && automation?.source === 'learning'" class="learning-outcome" role="status">
        <template v-if="selectedRun.learning">
          <strong>{{ learningOutcomeLabel(selectedRun.learning) }}</strong>
          <p>{{ selectedRun.learning.summary }}</p>
          <small>Execution: {{ statusLabel(selectedRun.status) }} · {{ selectedRun.learning.artifacts }} {{ selectedRun.learning.status === 'applied' ? 'verified' : 'recorded' }} {{ selectedRun.learning.artifacts === 1 ? 'artifact' : 'artifacts' }} · {{ selectedRun.learning.events }} {{ selectedRun.learning.events === 1 ? 'event' : 'events' }} · {{ selectedRun.learning.evaluated }} {{ selectedRun.learning.evaluated === 1 ? 'decision' : 'decisions' }} evaluated</small>
        </template>
        <p v-else>{{ selectedRun.status === 'running' ? 'Learning is in progress. Its outcome has not been verified.' : 'No verified learning receipt is available for this run. Execution status alone does not confirm learning.' }}</p>
      </div>
      <div v-if="enabled && !selectedSessionId" class="automation-empty">
        <p>Select a run to view its conversation.</p>
        <button v-if="narrow" class="text-button" @click="runsOpen = true">Browse runs</button>
      </div>
      <div v-show="!enabled || !!selectedSessionId" :id="enabled && selectedSessionId ? panelId(selectedSessionId) : undefined" class="automation-conversation"
        :role="enabled ? 'tabpanel' : undefined" :aria-labelledby="enabled && selectedSessionId ? tabId(selectedSessionId) : undefined">
        <slot :toolbar-target="enabled ? `#${id}-documents` : undefined" :conversation-request="conversationRequest" :conversation-tab-id="selectedSessionId ? tabId(selectedSessionId) : undefined" />
      </div>
      <div v-for="tab in openTabs.filter(tab => tab.sessionId !== selectedSessionId)" :id="panelId(tab.sessionId)" :key="`panel:${tab.sessionId}`" v-show="false" role="tabpanel" :aria-labelledby="tabId(tab.sessionId)" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, reactive, ref, useId, watch } from 'vue'
import { automationDocumentTabsKey } from '../composables/useAutomationDocumentTabs.ts'
import { learningOutcomeLabel, type AutomationRunSummary } from '../automations.ts'
import { createAutomationRunHistory, emptyAutomationRunHistory } from '../automation-run-history.ts'
import { useAutomationCatalog } from '../composables/useAutomationCatalog.ts'
import { clampSidebarWidth, sidebarWidthBounds } from '../sidebar-resize.ts'
import { documentTabScrollLeft, nextDocumentTab } from '../file-workbench.ts'
import TreeRow from './TreeRow.vue'
import SidebarResizer from './SidebarResizer.vue'

const props = withDefaults(defineProps<{ apiBase: string; automationId: string; active: boolean; enabled?: boolean; selectedSessionId?: string }>(), { enabled: true })
const emit = defineEmits<{ open: [sessionId: string]; overview: [] }>()
const id = useId()
const root = ref<HTMLElement>()
const scrollRoot = ref<HTMLElement>()
const tabStrip = ref<HTMLElement>()
const sentinel = ref<HTMLElement>()
const width = ref(typeof window === 'undefined' ? 1000 : window.innerWidth)
const preferredWidth = ref(280)
const bounds = computed(() => sidebarWidthBounds(width.value, 220, 420))
const explorerWidth = computed(() => clampSidebarWidth(preferredWidth.value, bounds.value))
const narrow = computed(() => width.value <= 700)
const runsOpen = ref(false)
const expanded = ref(true)
const catalog = useAutomationCatalog(() => props.apiBase, () => props.active && props.enabled && !!props.automationId)
const automation = computed(() => catalog.jobs.value.find(item => item.id === props.automationId) ?? null)
const catalogError = computed(() => catalog.error.value || (catalog.loaded.value && !automation.value
  ? 'This automation is no longer available. Retry to check for saved runs.' : ''))
const history = reactive(emptyAutomationRunHistory())
const selectedRun = computed(() => history.runs.find(run => run.sessionId === props.selectedSessionId))
const loading = computed(() => history.loading || catalog.loading.value)
let runHistory: ReturnType<typeof createAutomationRunHistory> | undefined
const labels = { running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', unknown: 'Status unknown' }
const statusLabel = (status: AutomationRunSummary['status']) => labels[status]
const statusIcon = (status: AutomationRunSummary['status']) => ({
  running: 'i-lucide-loader-circle', completed: 'i-lucide-check', failed: 'i-lucide-circle-alert',
  cancelled: 'i-lucide-ban', unknown: 'i-lucide-circle-help',
})[status]
const started = (value: string) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
interface RunTab { sessionId: string; label: string }
const openTabs = ref<RunTab[]>([])
const conversationRequest = ref(0)
const selectedDocument = ref('')
provide(automationDocumentTabsKey, { selectDocument(sessionId, key) {
  if (sessionId === props.selectedSessionId) selectedDocument.value = key
} })
watch(() => props.selectedSessionId, () => { selectedDocument.value = '' })
const tabCache = new Map<string, RunTab[]>()
const historyCache = new Map<string, ReturnType<typeof emptyAutomationRunHistory>>()
const identity = ref('')
const tabId = (key: string) => `${id}-tab-${encodeURIComponent(key)}`
const panelId = (key: string) => `${id}-panel-${encodeURIComponent(key)}`
function refresh() { catalog.refresh(); runHistory?.refresh() }
function scrollTabStrip(event: WheelEvent) {
  if (!tabStrip.value) return
  const next = documentTabScrollLeft(event, tabStrip.value)
  if (next === undefined) return
  event.preventDefault()
  tabStrip.value.scrollLeft = next
}
function loadMore() { if (expanded.value && props.active) runHistory?.loadMore() }
function checkMore() {
  const element = scrollRoot.value
  if (element && element.clientHeight > 0 && element.scrollHeight - element.scrollTop - element.clientHeight < 100
    && !history.error && (!narrow.value || runsOpen.value)) loadMore()
}
function openRun(sessionId: string) {
  selectedDocument.value = ''
  conversationRequest.value++
  runsOpen.value = false
  emit('open', sessionId)
}
function closeTab(sessionId: string) {
  const index = openTabs.value.findIndex(tab => tab.sessionId === sessionId)
  openTabs.value = openTabs.value.filter(tab => tab.sessionId !== sessionId)
  if (props.selectedSessionId === sessionId) {
    const next = openTabs.value[Math.min(index, openTabs.value.length - 1)]
    if (next) openRun(next.sessionId)
    else {
      emit('overview')
      void nextTick(() => (narrow.value ? document.getElementById(`${id}-runs-toggle`)
        : document.getElementById(`${id}-runs`)?.querySelector<HTMLButtonElement>('.automation-run'))?.focus({ preventScroll: true }))
    }
  }
  void nextTick(() => document.getElementById(tabId(props.selectedSessionId || ''))?.focus({ preventScroll: true }))
}
function tabKey(event: KeyboardEvent, key: string) {
  if (event.key === 'Delete' && key) { event.preventDefault(); closeTab(key); return }
  const next = nextDocumentTab(openTabs.value.map(tab => tab.sessionId), key, event.key)
  if (next === undefined) return
  event.preventDefault()
  openRun(next)
  void nextTick(() => document.getElementById(tabId(next))?.focus({ preventScroll: true }))
}
watch(() => [props.apiBase, props.automationId, catalog.enabled.value, expanded.value && (!narrow.value || runsOpen.value)] as const, ([base, job, active, shown], _previous, onCleanup) => {
  runHistory = undefined
  const key = JSON.stringify([base, job])
  if (identity.value !== key) {
    if (identity.value) { historyCache.set(identity.value, { ...history, runs: [...history.runs] }); tabCache.set(identity.value, openTabs.value) }
    identity.value = key
    Object.assign(history, historyCache.get(key) ?? emptyAutomationRunHistory(), { loading: false })
    openTabs.value = tabCache.get(key) ?? []
    expanded.value = true
    runsOpen.value = false
  }
  if (!active || !job || !shown) return
  const current = runHistory = createAutomationRunHistory(base, job, history)
  current.refresh()
  onCleanup(() => { current.dispose(); if (runHistory === current) runHistory = undefined })
}, { immediate: true })
watch(catalog.revision, () => runHistory?.refresh())
watch(() => [identity.value, props.selectedSessionId, history.runs] as const, () => {
  const sessionId = props.selectedSessionId
  if (!props.enabled || !sessionId) return
  const run = history.runs.find(run => run.sessionId === sessionId)
  const tab = openTabs.value.find(tab => tab.sessionId === sessionId)
  const label = run ? started(run.startedAt) : 'Run conversation'
  if (!tab) openTabs.value.push({ sessionId, label })
  else if (run) tab.label = label
  if (!selectedDocument.value) void nextTick(() => document.getElementById(tabId(sessionId))?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
}, { immediate: true })
watch(() => [history.runs, history.loading, expanded.value, runsOpen.value, props.active], () => { void nextTick(checkMore) })
let observer: ResizeObserver | undefined
let intersection: IntersectionObserver | undefined
watch(() => [sentinel.value, scrollRoot.value, catalog.enabled.value, expanded.value, runsOpen.value, narrow.value] as const, ([target, scroll, active], _previous, onCleanup) => {
  if (!target || !scroll || !active || !expanded.value || narrow.value && !runsOpen.value || typeof IntersectionObserver === 'undefined') return
  intersection = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && !history.error) loadMore() }, { root: scroll, rootMargin: '100px' })
  intersection.observe(target)
  const current = intersection
  onCleanup(() => current.disconnect())
}, { flush: 'post' })
onMounted(() => {
  observer = new ResizeObserver(() => {
    const measured = root.value?.getBoundingClientRect().width
    if (measured) width.value = measured
  })
  if (root.value) observer.observe(root.value)
})
onUnmounted(() => { observer?.disconnect(); intersection?.disconnect() })
</script>

<style scoped>
.automation-detail { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; color: var(--c-text); font-size: 14px; }
.automation-explorer { position: relative; display: flex; flex-direction: column; flex: 0 0 v-bind('`${explorerWidth}px`'); width: v-bind('`${explorerWidth}px`'); min-width: 0; min-height: 0; border-inline-end: 1px solid var(--c-border); background: var(--c-bg-card); --tree-row-height: var(--sidebar-row-height); }
.explorer-heading { display: flex; align-items: center; gap: 4px; min-height: 40px; padding-inline: 12px 6px; border-bottom: 1px solid var(--c-border); }
.explorer-heading h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 500; }
.icon-button { display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; padding: 0; border: 0; color: var(--c-text-secondary); background: transparent; cursor: pointer; }
.icon-button > span, .automation-tab > span:first-child { display: block; flex-shrink: 0; width: 16px; height: 16px; }
.icon-button:hover, .automation-tab:hover { background: var(--c-bg-muted); color: var(--c-text); }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
button:disabled { opacity: .6; cursor: default; }
.runs-scroll { flex: 1; min-height: 0; overflow: auto; padding: 6px 4px; overscroll-behavior: contain; }
.run-status { font-size: 12px; color: var(--c-text-secondary); }
.status-running { color: var(--c-info); }
.status-failed { color: var(--c-error); }
.status-blocked, .status-partial, .status-draft_only { color: var(--c-error); }
.learning-outcome { flex: 0 0 auto; max-height: 160px; overflow: auto; padding: 10px 16px; border-bottom: 1px solid var(--c-border); font-size: 13px; overflow-wrap: anywhere; }
.learning-outcome p { margin: 4px 0; white-space: pre-wrap; }
.learning-outcome small { color: var(--c-text-secondary); }
.explorer-note { margin: 12px; color: var(--c-text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.explorer-note p { margin: 0 0 8px; }
.load-more { min-height: var(--sidebar-row-height); padding-inline-start: 32px; }
.text-button { min-height: 32px; padding: 4px 8px; border: 1px solid var(--c-border); background: var(--c-bg-soft); color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; }
.automation-editor, .automation-conversation { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.automation-toolbar { display: flex; flex: 0 0 40px; min-width: 0; min-height: 40px; max-height: 40px; box-sizing: border-box; border-bottom: 1px solid var(--c-border); background: var(--c-bg-card); }
.automation-tabstrip { display: flex; flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.automation-tabstrip::-webkit-scrollbar { display: none; }
.automation-tabs { display: flex; flex: 0 0 auto; }
.automation-documents { display: flex; flex: 1 0 auto; width: max-content; }
.automation-tab { display: inline-flex; align-items: center; gap: 8px; min-height: 39px; padding: 8px 12px; border: 0; color: var(--c-text-secondary); background: transparent; font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; }
.automation-tab[aria-selected="true"], .run-tab.selected { color: var(--c-text); background: var(--c-bg); box-shadow: inset 0 2px var(--c-blue); }
.run-tab { display: flex; align-items: center; flex-shrink: 0; border-inline-start: 1px solid var(--c-border); }
.run-tab.selected .automation-tab { box-shadow: none; background: transparent; }
.tab-label { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.tab-close { width: 28px; margin-inline-end: 4px; }
.automation-empty { padding: 28px; color: var(--c-text-secondary); }
.automation-info { flex-shrink: 0; border-bottom: 1px solid var(--c-border); font-size: 13px; }
.automation-info summary { padding: 10px 12px; color: var(--c-text-secondary); cursor: pointer; }
.automation-info summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.automation-info-body { max-height: 40vh; overflow: auto; padding: 0 12px 12px; overflow-wrap: anywhere; line-height: 1.6; }
.automation-info h3 { margin: 0 0 12px; font-size: 13px; }
.automation-info dl { margin: 0; }
.automation-info dt { color: var(--c-text-secondary); }
.automation-info dd { margin: 0 0 12px; }
.automation-info p { color: var(--c-text-secondary); }
.automation-prompt { white-space: pre-wrap; }
.run-skeleton i { display: block; background: var(--c-border-soft); }
.run-skeleton { display: flex; align-items: center; gap: 8px; height: var(--sidebar-row-height); padding-inline: 42px 12px; }
.run-skeleton i:first-child { flex-shrink: 0; width: 16px; height: 16px; }
.run-skeleton i:last-child { width: 70%; height: 12px; }
.runs-backdrop { position: absolute; inset: 40px 0 0; z-index: 9; border: 0; background: var(--c-shadow); }
.automation-detail:has(.runs-backdrop) .automation-explorer { position: absolute; inset: 40px auto 0 0; z-index: 10; width: min(320px, 90%); }
@media (max-width: 700px) {
  .automation-toolbar { flex-basis: 44px; min-height: 44px; max-height: 44px; }
  .automation-tab, .icon-button { min-height: 44px; }
  .automation-empty { padding: 16px; }
  .automation-info summary { min-height: 44px; box-sizing: border-box; }
}
</style>
