<template>
  <section v-show="active" class="automation-detail" :class="{ compact }" aria-label="Automation" :aria-busy="loading">
    <header class="automation-header">
      <button v-if="compact" type="button" class="automation-button" @click="emit('overview')">
        <span class="i-lucide-arrow-left" aria-hidden="true" /> Back to runs
      </button>
      <h2>{{ automation?.name || 'Automation' }}</h2>
      <span v-if="automation && !compact" class="automation-dispatch">{{ automation.enabled ? 'Dispatch enabled' : 'Dispatch disabled' }}</span>
    </header>

    <div v-if="compact" class="run-navigation">
      <label :for="selectId">Run</label>
      <select :id="selectId" aria-label="Run" :value="selectedSessionId || ''" :disabled="loading || !!error" @change="selectRun">
        <option v-if="!selectedSessionId" value="" disabled>Select a run</option>
        <option v-else-if="!selectedInPage" :value="selectedSessionId">Current run</option>
        <option v-for="run in runs" :key="run.id" :value="run.sessionId" :title="run.startedAt">
          {{ started(run.startedAt) }} · {{ statusLabel(run.status) }}{{ run.title ? ` · ${run.title}` : '' }}
        </option>
      </select>
    </div>
    <nav v-else class="automation-sections" aria-label="Automation sections">
      <button type="button" :aria-pressed="section === 'runs'" @click="section = 'runs'">Runs</button>
      <button type="button" :aria-pressed="section === 'configuration'" @click="section = 'configuration'">Configuration</button>
    </nav>

    <div v-if="error" class="automation-message" role="alert">
      <p>{{ error }}</p>
      <button type="button" class="automation-button" :disabled="loading" @click="refresh">Retry</button>
    </div>
    <p v-else-if="loading && !automation" class="automation-message" role="status">Loading automation…</p>

    <template v-if="!compact && automation">
      <div v-if="section === 'configuration'" class="automation-configuration">
        <dl>
          <dt>{{ automation.source === 'learning' ? 'Check frequency' : 'Schedule' }}</dt>
          <dd><code>{{ automation.schedule }}</code></dd>
          <dt>Agent</dt><dd>{{ automation.agentType || 'Default agent' }}</dd>
          <dt>Session mode</dt><dd>Fresh — each dispatch starts a separate conversation.</dd>
          <dt>Prompt</dt><dd class="automation-prompt">{{ automation.task || 'No prompt is available for this automation.' }}</dd>
        </dl>
        <p v-if="automation.source === 'learning'">Checks are activity-gated. A check does not necessarily start a run.</p>
        <p v-if="!automation.enabled">Dispatch is disabled. Saved runs remain available.</p>
        <p>Configuration is read-only here. Dispatch state does not describe a run’s outcome.</p>
      </div>
      <div v-else class="automation-runs">
        <p v-if="loading" class="automation-note" role="status">Updating runs…</p>
        <p v-else-if="!error && !runs.length" class="automation-message">{{ offset ? 'No runs on this page. Return to the previous page.' : 'No saved runs yet. Runs appear here after this automation starts a conversation.' }}</p>
        <ul v-if="runs.length" class="run-list" aria-label="Runs, most recent first">
          <li v-for="run in runs" :key="run.id">
            <button type="button" class="run-button automation-run" :data-session-id="run.sessionId" @click="emit('open', run.sessionId)">
              <span class="run-description">
                <time :datetime="run.startedAt" :title="run.startedAt">{{ started(run.startedAt) }}</time>
                <span v-if="run.title" class="run-title">{{ run.title }}</span>
              </span>
              <span class="run-status" :class="`status-${run.status}`">{{ statusLabel(run.status) }}</span>
              <span class="i-lucide-chevron-right" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </div>
    </template>
    <nav v-if="(compact || section === 'runs') && (total > 0 || offset > 0)" class="run-pagination" aria-label="Run pages">
      <button type="button" class="automation-button" :disabled="loading || offset === 0" @click="previousPage">Previous</button>
      <span>{{ runs.length ? `${offset + 1}–${offset + runs.length} of ${total}` : `Page ${Math.floor(offset / AUTOMATION_PAGE_SIZE) + 1}` }}</span>
      <button type="button" class="automation-button" :disabled="loading || !!error || offset + AUTOMATION_PAGE_SIZE >= total" @click="nextPage">Next</button>
    </nav>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { AUTOMATION_PAGE_SIZE, AutomationRequestError, fetchAutomationRuns, type AutomationRunSummary } from '../automations.ts'
import { createLiveRefresh } from '../live-refresh.ts'
import { useAutomationCatalog } from '../composables/useAutomationCatalog.ts'

const props = defineProps<{ apiBase: string; automationId: string; active: boolean; compact?: boolean; selectedSessionId?: string }>()
const emit = defineEmits<{ open: [sessionId: string]; overview: [] }>()
const catalog = useAutomationCatalog(() => props.apiBase, () => props.active && !!props.automationId)
const selectId = useId()
const automation = computed(() => catalog.jobs.value.find(item => item.id === props.automationId) ?? null)
const runs = ref<AutomationRunSummary[]>([])
const total = ref(0)
const offset = ref(0)
const runsLoading = ref(false)
const runsError = ref('')
const loading = computed(() => runsLoading.value || catalog.loading.value)
const error = computed(() => catalog.error.value || runsError.value
  || (catalog.loaded.value && !automation.value ? 'This automation is no longer available. Retry to check for saved runs.' : ''))
const section = ref<'runs' | 'configuration'>('runs')
const selectedInPage = computed(() => runs.value.some(run => run.sessionId === props.selectedSessionId))
const labels = { running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', unknown: 'Status unknown' }
const statusLabel = (status: AutomationRunSummary['status']) => labels[status]
const started = (value: string) => new Date(value).toLocaleString([], {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
})
let identity = ''
let refreshRuns = () => {}
const refresh = () => catalog.refresh()
const previousPage = () => { if (!loading.value) offset.value = Math.max(0, offset.value - AUTOMATION_PAGE_SIZE) }
const nextPage = () => { if (!loading.value && !error.value && offset.value + AUTOMATION_PAGE_SIZE < total.value) offset.value += AUTOMATION_PAGE_SIZE }

function selectRun(event: Event) {
  const sessionId = (event.target as HTMLSelectElement).value
  if (sessionId && sessionId !== props.selectedSessionId && runs.value.some(run => run.sessionId === sessionId)) emit('open', sessionId)
}

watch(() => [props.apiBase, props.automationId, catalog.enabled.value, offset.value] as const,
  ([base, id, active, pageOffset], _previous, onCleanup) => {
    const nextIdentity = JSON.stringify([base, id])
    if (identity !== nextIdentity) {
      identity = nextIdentity
      runs.value = []
      total.value = 0
      runsError.value = ''
      section.value = 'runs'
      offset.value = 0
      if (pageOffset !== 0) return
    }
    refreshRuns = () => {}
    runsLoading.value = false
    if (!active || !id) return
    runs.value = []
    const snapshot = createLiveRefresh({
      load: signal => fetchAutomationRuns(base, id, pageOffset, signal),
      apply: page => {
        runs.value = page.runs
        total.value = page.total
        runsLoading.value = false
        runsError.value = ''
      },
      onError: cause => {
        runs.value = []
        runsLoading.value = false
        runsError.value = cause instanceof AutomationRequestError ? cause.message : 'Automations could not be loaded. Check Main and retry.'
      },
    })
    refreshRuns = () => { runsLoading.value = true; snapshot.refresh() }
    refreshRuns()
    onCleanup(() => { refreshRuns = () => {}; snapshot.dispose() })
  }, { immediate: true })
watch(catalog.revision, () => refreshRuns())
</script>

<style scoped>
.automation-detail { min-width: 0; overflow: auto; padding: 20px; color: var(--c-text); font-size: 14px; }
.automation-header { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.automation-header h2 { flex: 1; min-width: 0; margin: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
.automation-dispatch, .automation-note, .run-pagination > span, .automation-configuration > p { color: var(--c-text-secondary); font-size: 13px; }
.automation-button, .automation-sections button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 6px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-soft); color: var(--c-text); font: inherit; cursor: pointer; }
.automation-button:hover:not(:disabled), .automation-sections button:hover, .run-button:hover { background: var(--c-bg-muted); }
.automation-detail button:focus-visible, .automation-detail select:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.automation-detail button:disabled, .automation-detail select:disabled { opacity: .6; cursor: default; }
.automation-sections { display: flex; gap: 4px; margin: 20px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--c-border); }
.automation-sections button { border-color: transparent; background: transparent; }
.automation-sections button[aria-pressed="true"] { background: var(--c-bg-muted); border-color: var(--c-border); font-weight: 600; }
.automation-message { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 0; padding: 20px 0; color: var(--c-text-secondary); }
.automation-message p { flex: 1; min-width: 180px; margin: 0; }
.automation-message[role="alert"] { color: var(--c-text); }
.run-list { margin: 0; padding: 0; list-style: none; }
.run-list li { border-bottom: 1px solid var(--c-border); }
.run-button { display: flex; align-items: center; gap: 12px; width: 100%; padding: 14px 8px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.run-description { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.run-description time { font-variant-numeric: tabular-nums; }
.run-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; margin-top: 4px; color: var(--c-text-secondary); }
.run-status { flex-shrink: 0; font-size: 13px; color: var(--c-text-secondary); }
.status-running { color: var(--c-info); }
.status-failed { color: var(--c-error); }
.run-pagination { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 16px; font-variant-numeric: tabular-nums; }
.automation-configuration { max-width: 72ch; padding: 8px 0; }
.automation-configuration dl { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 16px; margin: 8px 0 24px; }
.automation-configuration dt { color: var(--c-text-secondary); }
.automation-configuration dd { margin: 0; overflow-wrap: anywhere; }
.automation-prompt { white-space: pre-wrap; }
.automation-configuration p { line-height: 1.6; }
.compact { flex: 0 0 auto; padding: 10px 16px; border-bottom: 1px solid var(--c-border); background: var(--c-bg-soft); max-height: 45vh; }
.compact h2 { font-size: 14px; }
.run-navigation { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.run-navigation select { flex: 1; min-width: 0; min-height: 36px; padding: 6px 8px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-input); font: inherit; }
.compact .run-pagination { margin-top: 8px; }
@media (max-width: 700px) {
  .automation-detail { padding: 12px; }
  .automation-button, .automation-sections button, .run-navigation select { min-height: 44px; }
  .run-button { flex-wrap: wrap; gap: 8px; }
  .run-description { flex-basis: calc(100% - 30px); }
  .run-status { margin-right: auto; }
  .automation-configuration dl { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .automation-configuration dd { margin-bottom: 12px; }
}
</style>
