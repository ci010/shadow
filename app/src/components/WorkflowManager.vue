<template>
  <section class="workflow-manager" :aria-label="t('Workflows')" :aria-busy="loading">
    <header class="workflow-heading">
      <div><h1>{{ t('Workflows') }}</h1><p>{{ t('Read-only execution map. Create and edit workflows in chat.') }}</p></div>
      <button class="btn btn-sm" :disabled="loading || busy" @click="refresh">{{ t('Refresh') }}</button>
    </header>
    <div v-if="error" class="workflow-message failure" role="alert"><p>{{ error }}</p><button class="btn btn-sm" :disabled="loading || busy" @click="refresh">{{ t('Retry') }}</button></div>
    <p v-if="snapshot?.runtimeError" class="workflow-message failure" role="alert">{{ t('Workflow persistence or execution needs attention. Check Main before retrying effects.') }}</p>
    <p v-if="loading && !snapshot" class="workflow-message" role="status">{{ t('Loading workflows…') }}</p>
    <div v-else-if="snapshot && !snapshot.definitions.length" class="workflow-empty">
      <h2>{{ t('No workflows yet') }}</h2><p>{{ t('Ask an Agent to create a workflow with a signal source, an explicit first-batch policy and typed actions. Its saved definition will appear here.') }}</p>
      <RouterLink class="btn" :to="chatLocation">{{ t('Open chat') }}</RouterLink>
    </div>
    <div v-else-if="snapshot" class="workflow-layout">
      <nav class="workflow-inventory" :aria-label="t('Workflow definitions')">
        <button v-for="flow in snapshot.definitions" :key="flow.id" class="workflow-choice" :class="{ selected: definition?.id === flow.id }"
          :aria-current="definition?.id === flow.id ? 'page' : undefined" @click="selectFlow(flow.id)">
          <strong>{{ flow.name || flow.id }}</strong><span>{{ flow.source.kind }} · {{ flow.enabled ? t('Enabled') : t('Paused') }}</span>
        </button>
      </nav>
      <p v-if="!definition" class="workflow-message" role="status">{{ t('This workflow is not available. Choose a current definition from the list.') }}</p>
      <div v-if="definition && displayed" class="workflow-inspector">
        <header class="workflow-title">
          <div><h2>{{ definition.name || definition.id }}</h2><p>{{ t('Workflow ID') }} <code>{{ definition.id }}</code> · {{ t('Revision {revision}', { revision: definition.revision }) }}</p></div>
          <button class="btn btn-sm" :disabled="busy || !!error" @click="operate(definition.enabled ? 'pause' : 'resume', definition.id)">{{ definition.enabled ? t('Pause') : t('Resume') }}</button>
        </header>
        <p v-if="sourceStatus" class="workflow-explanation">{{ t('Signal source') }}: {{ sourceStatus.enabled ? t('Enabled') : t('Paused') }}<span v-if="sourceStatus.nextAt"> · {{ t('Next collection check') }}: {{ formatDateTime(sourceStatus.nextAt) }}</span></p>
        <p v-if="sourceStatus?.error" class="workflow-run-hint failure" role="alert">{{ t('Source collection failed. Inspect its authorized binding and source status in chat; no collector checkpoint was advanced for this failure.') }} <code>{{ sourceStatus.error }}</code></p>
        <p v-if="route.query.run && !selectedRun" class="workflow-message" role="status">{{ t('This run is no longer retained. The current definition is shown instead.') }}</p>
        <p class="workflow-explanation">{{ t('A workflow run is not a model session. Deterministic actions can finish without starting a conversation.') }}</p>
        <p v-if="notice" class="workflow-message" role="status">{{ notice }}</p>
        <p v-if="operationError" class="workflow-message failure" role="alert">{{ operationError }}</p>
        <div class="workflow-map-heading">
          <h3>{{ selectedRun ? t('Run snapshot') : t('Current definition') }}</h3>
          <span>{{ t('Revision {revision}', { revision: displayed.revision }) }}</span>
          <button v-if="selectedRun" class="btn btn-sm" @click="selectRun()">{{ t('Current definition') }}</button>
        </div>
        <p v-if="selectedRun && selectedRun.definition.revision !== definition.revision" class="workflow-explanation">{{ t('This run retains its admitted definition. Later edits apply to future runs.') }}</p>
        <p v-if="!selectedRun" class="workflow-explanation">{{ t('Node states use the latest retained run at this revision.') }}</p>
        <ol class="workflow-graph" :aria-label="t('Read-only workflow graph')">
          <li v-for="(node, index) in graph" :key="node.id" class="workflow-graph-step">
            <svg v-if="index" class="workflow-connector" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12h18m-6-6 6 6-6 6" /></svg>
            <details class="workflow-node" :data-state="node.status">
              <summary><span>{{ node.label }}</span><small>{{ node.detail }}</small><span class="workflow-state" :data-state="node.status">{{ workflowStatus(node.status) }}</span></summary>
              <pre>{{ JSON.stringify(node.config, null, 2) }}</pre>
            </details>
          </li>
        </ol>
        <p v-if="githubTarget" class="workflow-explanation">
          <RouterLink :to="{ name: 'chat', params: { projectId, sessionId: githubTarget.sessionId } }">{{ t('Target session') }}: {{ githubTarget.sessionId }}</RouterLink>
          · <RouterLink :to="{ name: 'project-dashboard', params: { projectId }, query: { work: githubTarget.workKey } }">{{ t('Open Work') }}: {{ githubTarget.workKey }}</RouterLink>
          · {{ t('Inbox acceptance is not user visibility or completed Work.') }}
        </p>
        <p class="workflow-explanation">{{ displayed.gate.first === 'baseline' ? t('First successful collection establishes a baseline without actions.') : t('First successful collection emits actions for unseen revisions.') }} {{ t('Revision deduplication is bounded; external effects are not exactly-once.') }}</p>
        <details class="workflow-definition">
          <summary>{{ t('Source and definition details') }}</summary>
          <dl><dt>{{ t('Source ID') }}</dt><dd><code>{{ displayed.source.id }}</code></dd><dt>{{ t('Owner session') }}</dt><dd><code>{{ displayed.owner || t('Host managed') }}</code></dd></dl>
          <pre>{{ JSON.stringify(displayed, null, 2) }}</pre>
          <p>{{ t('Agent resource') }} <code>{{ `v:workflows/definitions/${encodeURIComponent(definition.id)}.json` }}</code></p>
        </details>
        <section v-if="selectedRun" class="workflow-run-detail" :aria-label="t('Selected run')">
          <h3>{{ t('Selected run') }} <span class="workflow-state" :data-state="selectedRun.status">{{ workflowStatus(selectedRun.status) }}</span></h3>
          <dl><dt>{{ t('Run ID') }}</dt><dd><code>{{ selectedRun.id }}</code></dd><dt>{{ t('Admitted') }}</dt><dd>{{ formatDateTime(selectedRun.timestamp) }}</dd><dt>{{ t('Current node attempts') }}</dt><dd>{{ selectedRun.attempts }}</dd><template v-if="selectedRun.output?.sessionId"><dt>{{ t('Session ID') }}</dt><dd><code>{{ selectedRun.output.sessionId }}</code></dd></template></dl>
          <p v-if="selectedRun.error" class="workflow-run-hint" :data-state="selectedRun.status">{{ workflowHint(selectedRun.error) }}</p>
          <p v-if="selectedRun.status === 'retry' && selectedRun.nextAt">{{ t('Next eligible retry') }}: {{ formatDateTime(selectedRun.nextAt) }}</p>
          <p v-if="selectedRun.output?.stale">{{ t('An older or equal revision was ignored; newer materialized data is retained.') }}</p>
          <div class="workflow-actions">
            <RouterLink v-if="selectedRun.output?.sessionId" class="btn btn-sm" :to="{ name: 'chat', params: { projectId, sessionId: selectedRun.output.sessionId } }">{{ t('Open model session') }}</RouterLink>
            <RouterLink v-if="selectedRun.output?.workKey" class="btn btn-sm" :to="{ name: 'project-dashboard', params: { projectId }, query: { work: selectedRun.output.workKey } }">{{ t('Open Work') }}</RouterLink>
            <button v-if="['blocked', 'retry'].includes(selectedRun.status)" class="btn btn-sm" :disabled="busy || !!error" @click="requestRetry(selectedRun)">{{ t('Retry run') }}</button>
            <button v-if="['queued', 'retry', 'blocked'].includes(selectedRun.status)" class="btn btn-sm" :disabled="busy || !!error" @click="operate('cancel', selectedRun.id)">{{ t('Cancel run') }}</button>
          </div>
          <div v-if="confirmation === selectedRun.id" class="workflow-confirm" role="alert">
            <p>{{ t('Confirm only after inspecting the destination. Retrying may duplicate an effect that already happened. Cancellation does not undo accepted effects.') }}</p>
            <button class="btn btn-sm" :disabled="busy" @click="operate('retry', selectedRun.id, true)">{{ t('I inspected effects — retry') }}</button>
            <button class="btn btn-sm" :disabled="busy" @click="confirmation = ''">{{ t('Keep blocked') }}</button>
          </div>
          <p v-if="!selectedRun.output?.sessionId" class="workflow-explanation">{{ t('No model session was recorded for this run.') }}</p>
        </section>
        <section class="workflow-runs" :aria-label="t('Recent workflow runs')">
          <h3>{{ t('Recent workflow runs') }} <small>{{ t('Latest 30 retained runs') }}</small></h3>
          <p v-if="!runs.length">{{ t('No runs have been admitted yet. A baseline or idle source may produce no run.') }}</p>
          <ol v-else><li v-for="run in runs" :key="run.id"><button class="workflow-run-choice" :class="{ selected: selectedRun?.id === run.id }" :aria-pressed="selectedRun?.id === run.id" @click="selectRun(run.id)">
            <time :datetime="run.timestamp">{{ formatDateTime(run.timestamp) }}</time><span class="workflow-state" :data-state="run.status">{{ workflowStatus(run.status) }}</span><code>{{ run.id }}</code><span>{{ t('Revision {revision}', { revision: run.definition.revision }) }}</span>
          </button></li></ol>
        </section>
        <footer class="workflow-footer"><RouterLink :to="chatLocation">{{ t('Create or edit in chat') }}</RouterLink><p>{{ t('Pause, resume, retry and cancel are operational controls, not configuration edits. Pausing does not roll back accepted effects.') }}</p></footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onActivated, onDeactivated, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { t, formatDateTime } from '../i18n.ts'
import { createWorkflowClient, recentWorkflowRuns, workflowGraph, workflowHint, workflowStatus, type WorkflowRun, type WorkflowSnapshot } from '../workflows.ts'
const props = withDefaults(defineProps<{ apiBase: string; projectId: string; active?: boolean }>(), { active: true })
const route = useRoute(), router = useRouter()
const snapshot = shallowRef<WorkflowSnapshot>(), loading = ref(false), error = ref(''), operationError = ref(''), busy = ref(false), confirmation = ref(''), notice = ref('')
const activated = ref(true), pageVisible = ref(typeof document === 'undefined' || !document.hidden)
const enabled = computed(() => props.active && activated.value && pageVisible.value)
const definition = computed(() => typeof route.query.workflow === 'string' ? snapshot.value?.definitions.find(d => d.id === route.query.workflow) : snapshot.value?.definitions[0])
const sourceStatus = computed(() => snapshot.value?.sources?.find(s => s.kind === definition.value?.source.kind && s.id === definition.value?.source.id))
const runs = computed(() => definition.value && snapshot.value ? recentWorkflowRuns(snapshot.value, definition.value.id) : [])
const githubTarget = computed(() => {
  const node = displayed.value?.nodes.find(n => n.kind === 'github-notify')
  const target = node?.subscription as { sessionId?: unknown; workKey?: unknown } | undefined
  return typeof target?.sessionId === 'string' && typeof target.workKey === 'string' ? { sessionId: target.sessionId, workKey: target.workKey } : undefined
})
const selectedRun = computed(() => snapshot.value?.runs.find(r => r.workflow === definition.value?.id && r.id === route.query.run))
const displayed = computed(() => selectedRun.value?.definition ?? definition.value)
const graph = computed(() => displayed.value ? workflowGraph(displayed.value, selectedRun.value ?? runs.value.find(r => r.definition.revision === displayed.value?.revision)) : [])
const chatLocation = computed(() => ({ name: 'chat', params: { projectId: props.projectId } }))
let timer: ReturnType<typeof setTimeout> | undefined, reader: AbortController | undefined, mutation: AbortController | undefined
function stopRead() { clearTimeout(timer); reader?.abort(); reader = undefined; loading.value = false }
async function refresh() {
  if (!enabled.value || loading.value || busy.value) return
  clearTimeout(timer)
  const controller = reader = new AbortController(), base = props.apiBase, project = props.projectId
  loading.value = true
  try {
    const value = await createWorkflowClient(base, project).read(controller.signal)
    if (!controller.signal.aborted && base === props.apiBase && project === props.projectId) { snapshot.value = value; error.value = '' }
  } catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Workflows are unavailable. Refresh to retry.') }
  finally {
    if (reader === controller) { reader = undefined; loading.value = false; if (enabled.value) timer = setTimeout(refresh, 30_000) }
  }
}
function selectFlow(id: string) { confirmation.value = ''; operationError.value = ''; notice.value = ''; void router.replace({ query: { workflow: id } }) }
function selectRun(id?: string) { confirmation.value = ''; void router.replace({ query: { workflow: definition.value?.id, ...(id ? { run: id } : {}) } }) }
function requestRetry(run: WorkflowRun) { if (run.status === 'blocked') confirmation.value = run.id; else void operate('retry', run.id) }
async function operate(action: 'pause' | 'resume' | 'retry' | 'cancel', id: string, acknowledgeReplay = false) {
  if (busy.value) return
  stopRead(); busy.value = true; operationError.value = ''; notice.value = ''
  const controller = mutation = new AbortController(), base = props.apiBase, project = props.projectId
  try {
    await createWorkflowClient(base, project).control(id, action, acknowledgeReplay, controller.signal)
    if (!controller.signal.aborted) { notice.value = t('Control saved. Accepted effects are not rolled back.'); confirmation.value = '' }
  } catch {
    if (!controller.signal.aborted) operationError.value = t('Control was not confirmed. Refresh and inspect the current state before trying again; the request may have been applied.')
  } finally { if (mutation === controller) { mutation = undefined; busy.value = false; void refresh() } }
}
function visibility() { pageVisible.value = !document.hidden }
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
watch(() => [props.apiBase, props.projectId], () => { stopRead(); mutation?.abort(); mutation = undefined; busy.value = false; snapshot.value = undefined; error.value = ''; operationError.value = ''; confirmation.value = ''; notice.value = ''; void refresh() })
watch(enabled, value => { if (value) void refresh(); else stopRead() }, { immediate: true })
onActivated(() => { activated.value = true })
onDeactivated(() => { activated.value = false })
onUnmounted(() => { activated.value = false; stopRead(); mutation?.abort(); document.removeEventListener('visibilitychange', visibility) })
</script>

<style scoped>
.workflow-manager { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; color: var(--c-text); font-size: 13px; container-type: inline-size; }
.workflow-heading { display: flex; gap: 16px; justify-content: space-between; align-items: start; padding: 18px 20px; border-bottom: 1px solid var(--c-border); }
h1, h2, h3, p { margin: 0; } h1 { font-size: 18px; font-weight: 600; } h2 { font-size: 16px; font-weight: 600; } h3 { font-size: 14px; font-weight: 600; }
.workflow-heading p, .workflow-explanation, .workflow-footer p { margin-top: 6px; color: var(--c-text-secondary); line-height: 1.6; max-width: 75ch; }
.workflow-layout { display: grid; grid-template-columns: 210px minmax(0, 1fr); min-height: 0; flex: 1; }
.workflow-inventory { overflow: auto; border-right: 1px solid var(--c-border); padding: 8px; }
.workflow-choice { display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 12px 10px; text-align: start; border: 0; background: transparent; color: var(--c-text); cursor: pointer; overflow-wrap: anywhere; }
.workflow-choice span { color: var(--c-text-secondary); font-size: 12px; } .workflow-choice strong { font-weight: 500; }
.workflow-choice:hover, .workflow-run-choice:hover { background: var(--c-bg-muted); } .workflow-choice.selected, .workflow-run-choice.selected { background: var(--c-selection-bg); color: var(--c-primary); }
.workflow-inspector { overflow: auto; min-width: 0; padding: 20px; }
.workflow-title { display: flex; justify-content: space-between; gap: 12px; align-items: start; }.workflow-title p { margin-top: 8px; font-size: 12px; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.workflow-map-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 24px 0 12px; }.workflow-map-heading>span { color: var(--c-text-secondary); font-size: 12px; }
.workflow-graph { list-style: none; display: flex; margin: 0; padding: 0 0 8px; overflow-x: auto; align-items: start; }
.workflow-graph-step { display: flex; align-items: start; min-width: 0; flex: 1 0 150px; }
.workflow-connector { flex: 0 0 24px; width: 24px; height: 24px; margin-top: 28px; stroke: var(--c-text-muted); stroke-width: 1.5; fill: none; }
.workflow-node { flex: 1; min-width: 0; background: var(--c-bg-card); border: 1px solid var(--c-border); }.workflow-node[data-state=running] { border-color: var(--c-info); }.workflow-node[data-state=blocked] { border-color: var(--c-warn); }
.workflow-node summary { display: flex; flex-direction: column; gap: 8px; padding: 12px; cursor: pointer; overflow-wrap: anywhere; }.workflow-node summary>span:first-child { font-weight: 500; }.workflow-node small { color: var(--c-text-secondary); }.workflow-node pre { min-width: 180px; max-width: 300px; }
.workflow-state { font-size: 12px; color: var(--c-text-secondary); font-weight: 400; }.workflow-state[data-state=completed] { color: var(--c-success); }.workflow-state[data-state=blocked], .workflow-run-hint[data-state=blocked] { color: var(--c-warn); }.workflow-state[data-state=retry], .failure { color: var(--c-error); }.workflow-state[data-state=running] { color: var(--c-info); }
.workflow-definition { margin-top: 18px; border-top: 1px solid var(--c-border); border-bottom: 1px solid var(--c-border); }.workflow-definition summary { padding: 12px 0; cursor: pointer; }.workflow-definition>p { margin: 10px 0; overflow-wrap: anywhere; }
pre { margin: 0; padding: 12px; max-height: 280px; overflow: auto; background: var(--c-bg-soft); color: var(--c-text-body); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; } code { font-size: 12px; overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 16px; margin: 12px 0; }dt { color: var(--c-text-secondary); }dd { margin: 0; overflow-wrap: anywhere; }
.workflow-run-detail { padding: 20px 0; border-bottom: 1px solid var(--c-border); }.workflow-run-detail h3 { display: flex; gap: 12px; }.workflow-run-detail p { margin-top: 12px; line-height: 1.6; }.workflow-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.workflow-confirm { margin-top: 16px; border: 1px solid var(--c-warn); padding: 12px; }.workflow-confirm p { margin: 0 0 12px; }.workflow-confirm button { margin: 0 8px 4px 0; }
.workflow-runs { margin-top: 22px; }.workflow-runs h3 { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; margin-bottom: 12px; }.workflow-runs small { font-weight: 400; color: var(--c-text-secondary); }.workflow-runs ol { list-style: none; margin: 0; padding: 0; }
.workflow-run-choice { width: 100%; padding: 12px 0; background: transparent; border: 0; border-bottom: 1px solid var(--c-border-soft); color: var(--c-text); display: grid; grid-template-columns: minmax(0, 1fr) auto; text-align: start; gap: 6px 16px; cursor: pointer; }.workflow-run-choice>span:last-child { font-size: 12px; color: var(--c-text-secondary); }.workflow-run-choice code { color: var(--c-text-secondary); }
.workflow-message { padding: 12px 20px; }.workflow-message p { margin-bottom: 8px; }.workflow-empty { padding: 40px 24px; }.workflow-empty p { margin: 12px 0 20px; max-width: 65ch; line-height: 1.6; color: var(--c-text-secondary); }.workflow-footer { padding: 24px 0 8px; }.workflow-footer a { color: var(--c-primary); }.workflow-footer p { font-size: 12px; }
button:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@container (max-width: 760px) { .workflow-layout { grid-template-columns: minmax(0, 1fr); overflow: auto; display: block; }.workflow-inventory { display: flex; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--c-border); }.workflow-choice { flex: 0 0 170px; }.workflow-inspector { overflow: visible; padding: 16px; }.workflow-heading { padding: 16px; }.workflow-graph { flex-direction: column; overflow: visible; }.workflow-graph-step { width: 100%; flex: none; flex-direction: column; align-items: center; }.workflow-node { width: 100%; }.workflow-node summary { display: grid; grid-template-columns: 1fr auto; }.workflow-node small { grid-row: 2; }.workflow-node .workflow-state { grid-column: 2; grid-row: 1 / 3; align-self: center; }.workflow-connector { transform: rotate(90deg); margin: 0; }.workflow-node pre { max-width: none; min-width: 0; } }
@media (max-width: 700px), (pointer: coarse) { .workflow-choice, .workflow-run-choice, summary, .btn { min-height: 44px; } }
</style>
