<template>
  <section class="workflow-manager" :aria-label="t('Workflows')" :aria-busy="loading">
    <header class="workflow-heading">
      <div><h1>{{ t('Workflows') }}</h1><p>{{ t('Read-only execution map. Create and edit workflows in chat.') }}</p></div>
      <button class="btn btn-sm" :disabled="loading || busy" @click="refreshAll">{{ t('Refresh') }}</button>
    </header>
    <div v-if="error" class="workflow-message failure" role="alert"><p>{{ error }}</p><button class="btn btn-sm" :disabled="loading || busy" @click="refreshAll">{{ t('Retry') }}</button></div>
    <p v-if="snapshot?.botsUnavailable" class="workflow-message failure" role="alert">{{ t('BOT projection unavailable. Refresh to retry.') }}</p>
    <p v-if="snapshot?.bots?.warnings.length" class="workflow-message" role="status">{{ t('BOT inventory is incomplete. Some entries are unavailable or limited.') }}</p>
    <p v-if="snapshot?.runtimeError" class="workflow-message failure" role="alert">{{ t('Workflow persistence or execution needs attention. Check Main before retrying effects.') }}</p>
    <p v-if="loading && !snapshot" class="workflow-message" role="status">{{ t('Loading workflows…') }}</p>
    <div v-else-if="snapshot && !snapshot.definitions.length && !botFlows.length" class="workflow-empty">
      <h2>{{ t('No workflows yet') }}</h2><p>{{ t('Ask an Agent to create a workflow with a signal source, an explicit first-batch policy and typed actions. Its saved definition will appear here.') }}</p>
      <RouterLink class="btn" :to="chatLocation">{{ t('Open chat') }}</RouterLink>
    </div>
    <div v-else-if="snapshot" class="workflow-layout" :class="{ 'has-inspector': inspectorOpen }" :style="{ '--workflow-inspector-width': `${inspectorWidth}px` }">
      <WorkflowGraph ref="graphView" :flows="canvasFlows" :project-id="projectId" :selected-id="selectedBot?.definition.id ?? (inspectorOpen ? definition?.id : undefined)" @inspect="inspectFlow" @clear="closeInspector" @toggle="(id, enabled) => operate(enabled ? 'resume' : 'pause', id)" />
      <p v-if="documentQuery.bot && !selectedBot || documentQuery.workflow && !definition" class="workflow-message" role="status">{{ t('This workflow is not available. Choose a current definition from the list.') }}</p>
      <aside v-if="selectedBot" :id="inspectorId" ref="inspector" tabindex="-1" class="workflow-inspector" :aria-label="t('Workflow details')" @keydown.esc="closeInspector">
        <SidebarResizer edge="left" v-model="inspectorWidth" :bounds="{ min: 300, max: 560 }" :label="t('Resize details')" :controls="inspectorId" />
        <div class="inspector-toolbar"><span>{{ t('BOT topology') }}</span><button class="btn btn-sm" @click="closeInspector">{{ t('Close') }}</button></div>
        <header class="workflow-title"><h2>{{ selectedBot.definition.name }}</h2></header>
        <section v-if="selectedBot.sinkProjection" class="receiver-directory">
          <p>{{ t('Records messages without model reactions') }}</p>
          <p v-if="!selectedBot.sinkProjection.receivers.length">{{ t('No received conversations yet') }}</p>
          <ul><li v-for="receiver in selectedBot.sinkProjection.receivers" :key="receiver.id">
            <button class="btn btn-sm" @click="inspectedNode = `receiver:${receiver.id}`">{{ receiver.name ?? receiver.address.conversationId }}</button>
            <RouterLink v-if="sinkNavigationLocation(receiver.navigation)" :to="sinkNavigationLocation(receiver.navigation)!">{{ sinkNavigationLabel(receiver.navigation) }}</RouterLink>
            <span v-else>{{ t('Channel metadata unavailable. Waiting for received content.') }}</span>
          </li></ul>
          <p>{{ t('Agent resource') }} <code>{{ selectedBot.sinkProjection.sinkPath }}</code> · <code>{{ selectedBot.sinkProjection.guidePath }}</code></p>
        </section>
        <p v-else class="workflow-explanation">{{ t('Read-only BOT projection. Messages still use InputRouter and SessionManager. Connection health is not delivery success; routing is not probed.') }}</p>
        <details v-for="node in selectedBot.graph" :key="node.id" class="workflow-node" :open="!inspectedNode || inspectedNode === node.id">
          <summary>{{ node.label }} · {{ node.detail }}</summary><pre>{{ JSON.stringify(node.config, null, 2) }}</pre>
          <RouterLink v-if="node.targetSessionId" :to="{ name: 'chat', params: { projectId, sessionId: node.targetSessionId } }">{{ t('Open conversation') }}</RouterLink>
        </details>
      </aside>
      <aside v-if="inspectorOpen && !selectedBot && definition && displayed" :id="inspectorId" ref="inspector" tabindex="-1" class="workflow-inspector" :aria-label="t('Workflow details')" @keydown.esc="closeInspector">
        <SidebarResizer edge="left" v-model="inspectorWidth" :bounds="{ min: 300, max: 560 }" :label="t('Resize details')" :controls="inspectorId" />
        <div class="inspector-toolbar"><span>{{ t('Workflow details') }}</span><button class="btn btn-sm" @click="closeInspector">{{ t('Close') }}</button></div>
        <header class="workflow-title">
          <div><h2>{{ definition.name || definition.id }}</h2><p>{{ t('Workflow ID') }} <code>{{ definition.id }}</code></p></div>
          <button class="btn btn-sm" :disabled="selectedControl?.disabled ?? true" @click="operate(selectedControl?.enabled ? 'pause' : 'resume', definition.id)">{{ selectedControl?.busy ? t('Saving…') : selectedControl?.enabled ? t('Pause') : t('Resume') }}</button>
        </header>
        <p v-if="sourceStatus" class="workflow-explanation">{{ t('Signal source') }}: {{ sourceStatus.enabled ? t('Enabled') : t('Paused') }}<span v-if="sourceStatus.nextAt"> · {{ t('Next collection check') }}: {{ formatDateTime(sourceStatus.nextAt) }}</span></p>
        <p v-if="sourceStatus?.error" class="workflow-run-hint failure" role="alert">{{ t('Source collection failed. Inspect its authorized binding and source status in chat; no collector checkpoint was advanced for this failure.') }} <code>{{ sourceStatus.error }}</code></p>
        <p v-if="documentQuery.run && !selectedRun" class="workflow-message" role="status">{{ t('This run is no longer retained. The current definition is shown instead.') }}</p>
        <p class="workflow-explanation">{{ t('A workflow run is not a model session. Deterministic actions can finish without starting a conversation.') }}</p>
        <p v-if="notice" class="workflow-message" role="status">{{ notice }}</p>
        <p v-if="operationError" class="workflow-message failure" role="alert">{{ operationError }}</p>
        <WorkflowAutomationProfile :key="`${apiBase}:${definition.id}`" :api-base="apiBase" :workflow-id="definition.id" :active="enabled" />
        <div class="workflow-map-heading">
          <h3>{{ selectedRun ? t('This run configuration') : t('Current configuration') }}</h3>
          <button v-if="selectedRun" class="btn btn-sm" @click="selectRun()">{{ t('Current configuration') }}</button>
        </div>
        <p v-if="selectedRun && selectedRun.definition.revision !== definition.revision" class="workflow-explanation">{{ t('This run retains its admitted definition. Later edits apply to future runs.') }}</p>
        <p v-if="!selectedRun" class="workflow-explanation">{{ t('Latest retained run state') }}</p>
        <details class="graph-text" :open="!!inspectedNode"><summary>{{ t('Node details') }}</summary>
          <ol><li v-for="node in graph" :key="node.id"><details class="workflow-node" :data-state="node.status" :open="inspectedNode === node.id">
            <summary>{{ node.label }} · {{ node.detail }} · {{ workflowStatus(node.status) }}</summary>
            <p v-if="node.targetSessionId"><RouterLink :to="{ name: 'chat', params: { projectId, sessionId: node.targetSessionId } }">{{ t('Target session') }}: {{ node.targetSessionId }}</RouterLink></p>
            <p v-if="node.description">{{ node.description }}</p><pre>{{ JSON.stringify(node.config, null, 2) }}</pre>
          </details></li></ol>
        </details>
        <p v-if="githubTarget" class="workflow-explanation">
          <RouterLink :to="{ name: 'chat', params: { projectId, sessionId: githubTarget.sessionId } }">{{ t('Target session') }}: {{ githubTarget.sessionId }}</RouterLink>
          · <RouterLink :to="{ name: 'project-dashboard', params: { projectId }, query: { work: githubTarget.workKey } }">{{ t('Open Work') }}: {{ githubTarget.workKey }}</RouterLink>
          · {{ t('Inbox acceptance is not user visibility or completed Work.') }}
        </p>
        <p v-if="displayed.gate" class="workflow-explanation">{{ displayed.gate.first === 'baseline' ? t('First successful collection establishes a baseline without actions.') : t('First successful collection acts on observations not seen before.') }}</p>
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
          <p v-if="selectedRun.output?.stale">{{ t('An older observation was ignored; the stored data is retained.') }}</p>
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
            <time :datetime="run.timestamp">{{ formatDateTime(run.timestamp) }}</time><span class="workflow-state" :data-state="run.status">{{ workflowStatus(run.status) }}</span><code>{{ run.id }}</code>
          </button><RouterLink v-if="run.output?.sessionId" class="run-session-link" :to="{ name: 'chat', params: { projectId, sessionId: run.output.sessionId } }">{{ t('Open model session') }}: {{ run.output.sessionId }}</RouterLink><p v-else class="workflow-explanation">{{ t('No model session was recorded for this run.') }}</p></li></ol>
        </section>
        <footer class="workflow-footer"><RouterLink :to="chatLocation">{{ t('Create or edit in chat') }}</RouterLink><p>{{ t('Pause, resume, retry and cancel are operational controls, not configuration edits. Pausing does not roll back accepted effects.') }}</p></footer>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, useId, onActivated, onDeactivated, onUnmounted, ref, shallowRef, watch } from 'vue'
import { WorkflowInputReferencesKey, workflowInputReference, connectionSinkInputReference } from '../workflow-input-references.ts'
import WorkflowGraph from './WorkflowGraph.vue'
import { sinkNavigationLabel, sinkNavigationLocation } from '../connection-sinks.ts'
import { botCanvas } from '../bot-workflows.ts'
import WorkflowAutomationProfile from './WorkflowAutomationProfile.vue'
import SidebarResizer from './SidebarResizer.vue'
import { useRoute, useRouter } from 'vue-router'
import { useAutomationCatalog } from '../composables/useAutomationCatalog.ts'
import { workflowAutomation } from '../workflow-automation.ts'
import { canToggleAutomation } from '../automations.ts'
import { isRecord } from '../folders-sidebar.ts'
import { t, formatDateTime } from '../i18n.ts'
import { createWorkflowClient, recentWorkflowRuns, workflowConversation, workflowGraph, workflowHint, workflowStatus, type WorkflowRun, type WorkflowSnapshot } from '../workflows.ts'
const props = withDefaults(defineProps<{ apiBase: string; projectId: string; active?: boolean }>(), { active: true })
const route = useRoute(), router = useRouter()
// Other documents/routes must not clear an open Workflow's inspector.
const documentQuery = shallowRef(route.query)
watch(() => route.fullPath, () => {
  if (route.name === 'project-workflows' && route.params.projectId === props.projectId) documentQuery.value = route.query
})
const snapshot = shallowRef<WorkflowSnapshot>(), loading = ref(false), error = ref(''), operationError = ref(''), busy = ref(false), confirmation = ref(''), notice = ref('')
const activated = ref(true), pageVisible = ref(typeof document === 'undefined' || !document.hidden)
const enabled = computed(() => props.active && activated.value && pageVisible.value)
const catalog = useAutomationCatalog(() => props.apiBase, () => enabled.value)
const operationId = ref('')
const definition = computed(() => typeof documentQuery.value.workflow === 'string' ? snapshot.value?.definitions.find(d => d.id === documentQuery.value.workflow) : snapshot.value?.definitions[0])
const sourceStatus = computed(() => snapshot.value?.sources?.find(s => s.kind === definition.value?.source.kind && s.id === definition.value?.source.id))
const runs = computed(() => definition.value && snapshot.value ? recentWorkflowRuns(snapshot.value, definition.value.id) : [])
const githubTarget = computed(() => {
  const node = displayed.value?.nodes.find(n => n.kind === 'github-notify')
  const target = node?.subscription as { sessionId?: unknown; workKey?: unknown } | undefined
  return typeof target?.sessionId === 'string' && typeof target.workKey === 'string' ? { sessionId: target.sessionId, workKey: target.workKey } : undefined
})
const selectedRun = computed(() => snapshot.value?.runs.find(r => r.workflow === definition.value?.id && r.id === documentQuery.value.run))
const displayed = computed(() => selectedRun.value?.definition ?? definition.value)
const graph = computed(() => displayed.value ? workflowGraph(displayed.value, selectedRun.value ?? runs.value.find(r => r.definition.revision === displayed.value?.revision)) : [])
const inspector = ref<HTMLElement>(), inspectedNode = ref<string>(), inspectedFlow = ref<string>(), graphView = ref<InstanceType<typeof WorkflowGraph>>()
watch(() => documentQuery.value.workflow, id => { if (typeof id === 'string' && id !== inspectedFlow.value) inspectedNode.value = undefined })
const referenceHub = inject(WorkflowInputReferencesKey, undefined)
const inspectorId = useId(), inspectorWidth = ref(380)
const botFlows = computed(() => botCanvas(snapshot.value?.bots))
const selectedBot = computed(() => botFlows.value.find(flow => flow.definition.id === documentQuery.value.bot))
const inspectorOpen = computed(() => !!selectedBot.value || typeof documentQuery.value.workflow === 'string' && !!definition.value)
const referenceSelection = computed(() => {
  if (!props.active || !activated.value || !inspectorOpen.value) return
  const sink = selectedBot.value?.sinkProjection
  if (sink) return connectionSinkInputReference(props.projectId, sink.connectionId, selectedBot.value!.definition.name ?? sink.connectionId,
    inspectedNode.value?.startsWith('receiver:') ? inspectedNode.value.slice('receiver:'.length) : undefined)
  return !selectedBot.value && displayed.value ? workflowInputReference(props.projectId, displayed.value, inspectedNode.value, selectedRun.value) : undefined
})
watch(referenceSelection, item => referenceHub?.select?.(item, () => { void closeInspector() }, props.projectId), { immediate: true, flush: 'sync' })
onUnmounted(() => referenceHub?.select?.(undefined, undefined, props.projectId))
async function closeInspector() {
  inspectedNode.value = undefined
  documentQuery.value = {}
  // In a split workbench the current route can belong to the chat target.
  // Clear this document's selection without changing that chat (or its child).
  if (route.name === 'project-workflows' && route.params.projectId === props.projectId) await router.replace({ query: {} })
  await nextTick(); graphView.value?.focusCanvas()
}
const canvasFlows = computed(() => [...(snapshot.value?.definitions ?? []).map(flow => {
  const selected = selectedRun.value?.workflow === flow.id ? selectedRun.value : undefined
  const job = workflowAutomation(catalog.jobs.value, flow.id)
  const schedule = flow.nodes.find(node => node.kind === 'schedule-action')
  const configured = job ? (job.toggleEnabled ?? job.configuredEnabled ?? job.enabled) : isRecord(schedule?.job) ? schedule.job.enabled !== false : true
  const source = snapshot.value?.sources?.find(source => source.kind === flow.source.kind && source.id === flow.source.id)
  const effective = flow.enabled && (job ? job.enabled : source?.enabled ?? configured)
  const available = !catalog.error.value && catalog.loaded.value && !catalog.loading.value
  const control = {
    enabled: flow.enabled && configured,
    disabled: busy.value || !!error.value || !available || !!job && !canToggleAutomation(job),
    busy: busy.value && operationId.value === flow.id,
    error: operationId.value === flow.id ? operationError.value : undefined,
    notice: job?.disabledByGlobal ? t('Learning is disabled globally. This control saves the workflow preference only.') : !available ? t('Workflow controls are unavailable. Refresh to retry.') : undefined,
  }
  return { definition: selected?.definition ?? flow, conversation: workflowConversation(flow, snapshot.value!.runs, available ? catalog.jobs.value : []), enabled: effective, control, snapshot: !!selected, run: selected ?? recentWorkflowRuns(snapshot.value!, flow.id).find(run => run.definition.revision === flow.revision) }
}), ...botFlows.value])
const selectedControl = computed(() => canvasFlows.value.find(flow => flow.definition.id === definition.value?.id)?.control)
async function inspectFlow(id: string, nodeId?: string) {
  inspectedFlow.value = id
  inspectedNode.value = nodeId
  await router.replace({ name: 'project-workflows', params: { projectId: props.projectId }, query: botFlows.value.some(flow => flow.definition.id === id) ? { bot: id } : { workflow: id, ...(definition.value?.id === id && selectedRun.value ? { run: selectedRun.value.id } : {}) } })
  confirmation.value = ''; operationError.value = ''; notice.value = ''
  await nextTick(); inspector.value?.focus({ preventScroll: true })
}
const chatLocation = computed(() => ({ name: 'chat', params: { projectId: props.projectId } }))
let client = createWorkflowClient(props.apiBase, props.projectId)
let timer: ReturnType<typeof setTimeout> | undefined, reader: AbortController | undefined, mutation: AbortController | undefined
function stopRead() { clearTimeout(timer); reader?.abort(); reader = undefined; loading.value = false }
function refreshAll() { catalog.refresh(); void refresh() }
async function refresh() {
  if (!enabled.value || loading.value || busy.value) return
  clearTimeout(timer)
  const controller = reader = new AbortController(), base = props.apiBase, project = props.projectId
  loading.value = true
  try {
    const value = await client.read(controller.signal)
    if (!controller.signal.aborted && base === props.apiBase && project === props.projectId) { snapshot.value = value; error.value = '' }
  } catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Workflows are unavailable. Refresh to retry.') }
  finally {
    if (reader === controller) { reader = undefined; loading.value = false; if (enabled.value) timer = setTimeout(refresh, 30_000) }
  }
}
function selectRun(id?: string) { confirmation.value = ''; void router.replace({ query: { workflow: definition.value?.id, ...(id ? { run: id } : {}) } }) }
function requestRetry(run: WorkflowRun) { if (run.status === 'blocked') confirmation.value = run.id; else void operate('retry', run.id) }
async function operate(action: 'pause' | 'resume' | 'retry' | 'cancel', id: string, acknowledgeReplay = false) {
  if (busy.value) return
  stopRead(); busy.value = true; operationId.value = id; operationError.value = ''; notice.value = ''
  const controller = mutation = new AbortController(), base = props.apiBase, project = props.projectId
  try {
    await createWorkflowClient(base, project).control(id, action, acknowledgeReplay, controller.signal)
    if (!controller.signal.aborted) { notice.value = t('Control saved. Accepted effects are not rolled back.'); confirmation.value = '' }
  } catch {
    if (!controller.signal.aborted) operationError.value = t('Control was not confirmed. Refresh and inspect the current state before trying again; the request may have been applied.')
  } finally { if (mutation === controller) { mutation = undefined; busy.value = false; catalog.refresh(); void refresh() } }
}
function visibility() { pageVisible.value = !document.hidden }
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
watch(() => [props.apiBase, props.projectId], () => { stopRead(); mutation?.abort(); mutation = undefined; busy.value = false; client = createWorkflowClient(props.apiBase, props.projectId); snapshot.value = undefined; error.value = ''; operationError.value = ''; confirmation.value = ''; notice.value = ''; void refresh() })
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
.workflow-layout { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; flex: 1; overflow: hidden; }
.workflow-layout.has-inspector { grid-template-columns: minmax(0, 1fr) var(--workflow-inspector-width); }
.workflow-inspector { position: relative; min-width: 0; overflow: auto; padding: 16px; border-left: 1px solid var(--c-border); background: var(--c-bg-card); }
.inspector-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; color: var(--c-text-secondary); }
.workflow-inspector:focus { outline: none; }.workflow-inspector:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.graph-text { margin-top: 12px; border-bottom: 1px solid var(--c-border); }.graph-text summary { padding: 10px 0; cursor: pointer; overflow-wrap: anywhere; }
.workflow-title { display: flex; justify-content: space-between; gap: 12px; align-items: start; }.workflow-title>div, .workflow-heading>div { min-width: 0; flex: 1; }.workflow-title h2 { overflow-wrap: anywhere; }.workflow-title>.btn, .workflow-heading>.btn { flex-shrink: 0; white-space: nowrap; }.workflow-title p { margin-top: 8px; font-size: 12px; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.workflow-map-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 24px 0 12px; }.workflow-map-heading>span { color: var(--c-text-secondary); font-size: 12px; }
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
@container (max-width: 900px) { .workflow-layout.has-inspector { grid-template-columns: minmax(0, 1fr); }.workflow-inspector { position: absolute; inset: 0 0 0 auto; width: min(380px, 100%); box-sizing: border-box; z-index: 5; box-shadow: -8px 0 24px var(--c-shadow-soft); }.workflow-inspector :deep(.sidebar-resizer) { display: none; }.workflow-heading { padding: 16px; } }
@media (max-width: 700px), (pointer: coarse) { .workflow-run-choice, summary, .btn { min-height: 44px; } }
</style>
