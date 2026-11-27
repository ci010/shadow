<template>
  <section v-show="!pinnedOnly || shown.length || error" ref="root" class="quick-actions" :class="{ pinned: pinnedOnly }" :aria-label="t('Project Quick Actions')" :aria-busy="busy" @keydown.esc.stop.prevent="escape">
    <header><div class="heading"><span class="action-icon i-lucide-terminal" style="width:17px;height:17px" aria-hidden="true" /><h2>{{ pinnedOnly ? t('Pinned actions') : t('Quick Actions') }}</h2></div><HoverInfo :text="t('Refresh')" v-slot="{ triggerProps }"><button v-bind="triggerProps" class="icon-button" type="button" :disabled="busy" :aria-label="t('Refresh')" @click="refresh"><span class="action-icon i-lucide-refresh-cw" style="width:15px;height:15px" aria-hidden="true" /></button></HoverInfo><HoverInfo v-if="!pinnedOnly" :text="t('Close actions')" v-slot="{ triggerProps }"><button v-bind="triggerProps" class="icon-button" type="button" :aria-label="t('Close actions')" @click="emit('close')"><span class="action-icon i-lucide-x" style="width:16px;height:16px" aria-hidden="true" /></button></HoverInfo></header>
    <p v-if="!pinnedOnly" class="scope">{{ t('Project scoped · commands run directly in their saved target folder, not the chat folder.') }}</p>
    <p v-if="busy && !shown.length && !pinnedOnly" class="scope" role="status">{{ t('Loading actions…') }}</p>
    <p v-if="error" role="alert">{{ error }} <button type="button" :disabled="busy" @click="refresh">{{ t('Retry') }}</button></p>
    <p v-if="!pinnedOnly && !shown.length && !busy && !error">{{ pinnedOnly ? t('Pin an action from chat to show it here.') : t('No actions yet. Create one or discover package scripts.') }}</p>
    <div v-for="action in shown" :key="action.id" class="action-row">
      <div class="action-heading"><strong>{{ action.name }}</strong><span v-if="latest(action.id)" class="state">{{ t(latest(action.id)!.state) }}</span><button v-if="canWrite" class="run-button" type="button" :disabled="busy || !isSupported(action.folderId) || !!latest(action.id) && actionRunning(latest(action.id)!)" @click="confirmRun = action.id"><span class="action-icon i-lucide-play" style="width:13px;height:13px" aria-hidden="true" />{{ t('Run') }}</button></div>
      <code class="command-preview">{{ action.command }}</code><p class="target"><span class="action-icon i-lucide-folder" style="width:13px;height:13px" aria-hidden="true" />{{ folderName(action.folderId) }} · {{ folderPath(action.folderId) }}</p>
      <p v-if="!isSupported(action.folderId)" class="target">{{ t('Remote execution is unavailable.') }}</p>
      <details><summary>{{ t('Details') }}</summary>
      <div class="buttons">
        <button v-if="canWrite" type="button" :disabled="busy" @click="pin(action)">{{ action.pinned ? t('Unpin') : t('Pin to Dashboard') }}</button>
        <button v-if="canWrite && !pinnedOnly" type="button" :disabled="busy" @click="edit(action)">{{ t('Edit') }}</button>
        <button v-if="canWrite && !pinnedOnly" type="button" :disabled="busy" @click="deleting = action.id">{{ t('Delete') }}</button>
      </div>
      </details>
      <div v-if="confirmRun === action.id" class="run-confirmation" role="group" :aria-label="t('Run')"><p>{{ t('Run this command directly?') }}</p><code>{{ action.command }}</code><p>{{ folderName(action.folderId) }} · {{ folderPath(action.folderId) }}</p><div class="buttons"><button :disabled="busy" @click="runAction(action.id)">{{ t('Run') }}</button><button @click="confirmRun = ''">{{ t('Cancel') }}</button></div></div>
      <div v-if="deleting === action.id" class="buttons" role="group" :aria-label="t('Confirm deletion')"><span>{{ t('Delete saved action? Running commands are not stopped.') }}</span><button :disabled="busy" @click="remove(action.id)">{{ t('Confirm delete') }}</button><button @click="deleting = ''">{{ t('Cancel') }}</button></div>
      <ActionRunLog v-if="latest(action.id)" :run="latest(action.id)!" :can-write="canWrite" :busy="busy" @stop="stop" />
    </div>
    <details v-if="!pinnedOnly && runs.some(run => !actions.some(action => action.id === run.actionId))"><summary>{{ t('Runs of deleted actions') }}</summary><ActionRunLog v-for="run in runs.filter(run => !actions.some(action => action.id === run.actionId))" :key="run.id" :run="run" :can-write="canWrite" :busy="busy" @stop="stop" /></details>
    <template v-if="!pinnedOnly && canWrite">
      <div class="creation-entries"><button type="button" :disabled="busy" @click="edit()"><span class="action-icon i-lucide-plus" style="width:14px;height:14px" aria-hidden="true" />{{ t('Bind CLI command') }}</button><button type="button" :disabled="busy" :aria-expanded="importOpen" @click="importOpen = !importOpen"><span class="action-icon i-lucide-package" style="width:14px;height:14px" aria-hidden="true" />{{ t('Import package scripts') }}</button></div>
      <form v-if="editing" @submit.prevent="save">
        <h3>{{ editingId ? t('Edit action') : t('New action') }}</h3>
        <label>{{ t('Name') }}<UiInput ref="nameInput" v-model="form.name" required maxlength="120" /></label>
        <label>{{ t('Command') }}<textarea v-model="form.command" required spellcheck="false" /></label>
        <label>{{ t('Target folder') }}<UiSelect v-model="form.folderId" required><option value="" disabled>{{ t('Choose a folder explicitly') }}</option><option v-for="folder in folders" :key="folder.id" :value="folder.id" :disabled="folder.kind !== 'local' && folder.kind !== 'remote'">{{ folder.name }} · {{ folder.path }}{{ folder.kind !== 'local' && folder.kind !== 'remote' ? ' · ' + t('Remote execution is unavailable.') : '' }}</option></UiSelect></label>
        <label class="checkbox"><input v-model="form.pinned" type="checkbox" />{{ t('Pin to Dashboard') }}</label>
        <div class="buttons"><button type="submit" :disabled="busy || !supportedTarget">{{ t('Save') }}</button><button type="button" @click="editing = false">{{ t('Cancel') }}</button></div>
      </form>
      <details class="discovery" :open="importOpen" @toggle="importOpen = ($event.target as HTMLDetailsElement).open"><summary>{{ t('package.json scripts') }}</summary>
        <label>{{ t('Target folder') }}<UiSelect v-model="discoveryFolder" :disabled="busy"><option value="" disabled>{{ t('Choose a folder explicitly') }}</option><option v-for="folder in folders.filter(f => f.kind === 'local' || f.kind === 'remote')" :key="folder.id" :value="folder.id">{{ folder.name }} · {{ folder.path }}</option></UiSelect></label>
        <button type="button" :disabled="busy || !discoveryFolder" @click="discover">{{ t('Discover scripts') }}</button>
        <p v-if="discovered">{{ packageManager }} · {{ scripts.length }} {{ t('scripts found') }}</p>
        <p v-if="unsupportedScripts.length" role="status">{{ t('Unsupported script names (not imported):') }} {{ unsupportedScripts.join(', ') }}</p>
        <div v-for="script in scripts" :key="script.name" class="script"><span>{{ script.name }}</span><code>{{ script.command }}</code><button type="button" :disabled="busy || imported(script)" @click="importScript(script)">{{ imported(script) ? t('Imported') : t('Import') }}</button></div>
      </details>
    </template>
    <details v-if="!pinnedOnly && runs.length" class="run-history"><summary>{{ t('Run history') }}</summary><ActionRunLog v-for="run in runs" :key="run.id" :run="run" :can-write="canWrite" :busy="busy" @stop="stop" /></details>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import { t } from '../i18n.ts'
import { actionRunning, createQuickActionsClient, notifyQuickActionsChanged, type QuickAction, type ActionRun, type ActionFolder, type ActionScript } from '../quick-actions.ts'
import ActionRunLog from './ActionRunLog.vue'
import UiInput from './UiInput.vue'
import UiSelect from './UiSelect.vue'
import HoverInfo from './HoverInfo.vue'
const props = withDefaults(defineProps<{ apiBase: string; projectId: string; active: boolean; canWrite: boolean; pinnedOnly?: boolean }>(), { pinnedOnly: false })
const emit = defineEmits<{ close: [] }>()
const client = computed(() => createQuickActionsClient(props.apiBase, props.projectId))
const actions = ref<QuickAction[]>([]), runs = ref<ActionRun[]>([]), folders = ref<ActionFolder[]>([])
const busy = ref(false), error = ref(''), editing = ref(false), editingId = ref(''), deleting = ref(''), confirmRun = ref(''), nameInput = ref<InstanceType<typeof UiInput>>(), root = ref<HTMLElement>()
const form = reactive({ name: '', command: '', folderId: '', pinned: false })
const importOpen = ref(false)
const isSupported = (id: string) => folders.value.some(folder => folder.id === id && (folder.kind === 'local' || folder.kind === 'remote'))
const discoveryFolder = ref(''), scripts = ref<ActionScript[]>([]), packageManager = ref(''), discovered = ref(false), unsupportedScripts = ref<string[]>([])
const shown = computed(() => actions.value.filter(action => !props.pinnedOnly || action.pinned))
const supportedTarget = computed(() => folders.value.some(folder => folder.id === form.folderId && (folder.kind === 'local' || folder.kind === 'remote')))
let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined, generation = 0
const folderName = (id: string) => folders.value.find(folder => folder.id === id)?.name ?? t('Unavailable folder')
const folderPath = (id: string) => folders.value.find(folder => folder.id === id)?.path ?? id
const latest = (id: string) => runs.value.filter(run => run.actionId === id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
function escape() {
  if (confirmRun.value) { confirmRun.value = ''; return }
  if (deleting.value) { deleting.value = ''; return }
  if (editing.value) { editing.value = false; return }
  emit('close')
}
function setRun(run: ActionRun) { runs.value = [run, ...runs.value.filter(item => item.id !== run.id)] }
function capture() {
  const epoch = generation, current = controller, api = client.value, projectId = props.projectId
  return { api, projectId, signal: current?.signal, valid: () => epoch === generation && !current?.signal.aborted && props.active }
}
type OperationScope = ReturnType<typeof capture>
async function loadActions(scope: OperationScope) { const result = await scope.api.actions(scope.signal); if (scope.valid()) actions.value = result }
async function changedActions(scope: OperationScope) { if (!scope.valid()) return; await loadActions(scope); if (scope.valid()) notifyQuickActionsChanged(scope.projectId) }
function pin(action: QuickAction) { const scope = capture(); return operate(async () => { await scope.api.save({ pinned: !action.pinned }, action.id, scope.signal); await changedActions(scope) }) }
function remove(id: string) { const scope = capture(); return operate(async () => { await scope.api.remove(id, scope.signal); if (!scope.valid()) return; deleting.value = ''; await changedActions(scope) }) }
async function operate(operation: () => Promise<unknown>) {
  if (busy.value || !props.active) return
  const epoch = generation
  busy.value = true; error.value = ''
  try { await operation() } catch (cause) { if (epoch === generation) error.value = cause instanceof Error ? cause.message : t('Quick Actions request failed.') }
  finally { if (epoch === generation) { busy.value = false; schedulePoll() } }
}
function refresh() { return operate(async () => {
  const current = controller
  const result = await Promise.all([client.value.actions(controller?.signal), client.value.runs(controller?.signal), client.value.folders(controller?.signal)])
  if (current?.signal.aborted) return
  ;[actions.value, runs.value, folders.value] = result
}) }
function schedulePoll() {
  clearTimeout(timer)
  if (!props.active || !runs.value.some(actionRunning)) return
  timer = setTimeout(() => { const current = controller; void operate(async () => { const result = await client.value.runs(current?.signal); if (!current?.signal.aborted) runs.value = result }) }, 1000)
}
async function edit(action?: QuickAction) {
  editingId.value = action?.id ?? ''; Object.assign(form, { name: action?.name ?? '', command: action?.command ?? '', folderId: action?.folderId ?? '', pinned: action?.pinned ?? false }); editing.value = true
  await nextTick(); nameInput.value?.$el.focus()
}
function save() {
  if (!supportedTarget.value) return
  const scope = capture(), input = { ...form }, id = editingId.value || undefined
  return operate(async () => { await scope.api.save(input, id, scope.signal); if (!scope.valid()) return; editing.value = false; await changedActions(scope) })
}
function runAction(id: string) { if (!isSupported(actions.value.find(action => action.id === id)?.folderId ?? '')) return; const scope = capture(); return operate(async () => { const run = await scope.api.run(id, scope.signal); if (!scope.valid()) return; setRun(run); confirmRun.value = '' }) }
function stop(id: string) { const scope = capture(); return operate(async () => { const run = await scope.api.stop(id, scope.signal); if (scope.valid()) setRun(run) }) }
function discover() {
  const scope = capture(), folderId = discoveryFolder.value
  return operate(async () => {
    const result = await scope.api.scripts(folderId, scope.signal)
    if (!scope.valid() || discoveryFolder.value !== folderId) return
    unsupportedScripts.value = result.unsupportedScripts; scripts.value = result.scripts; packageManager.value = result.packageManager; discovered.value = true
  })
}
function imported(script: ActionScript) { return actions.value.some(action => action.folderId === discoveryFolder.value && action.command === script.command) }
function importScript(script: ActionScript) {
  const scope = capture(), folderId = discoveryFolder.value
  if (!discovered.value || !scripts.value.includes(script)) return
  return operate(async () => { await scope.api.save({ name: script.name, command: script.command, folderId }, undefined, scope.signal); await changedActions(scope) })
}
watch(discoveryFolder, () => { scripts.value = []; unsupportedScripts.value = []; discovered.value = false })
watch(() => [props.active, props.projectId, props.apiBase], () => {
  generation++; controller?.abort(); clearTimeout(timer); busy.value = false; controller = new AbortController()
  actions.value = []; runs.value = []; folders.value = []; error.value = ''; editing.value = false; deleting.value = ''; confirmRun.value = ''; importOpen.value = false; discoveryFolder.value = ''; scripts.value = []; unsupportedScripts.value = []
  if (props.active) void refresh()
}, { immediate: true })
function changed(event: Event) { if ((event as CustomEvent).detail === props.projectId && props.active && !busy.value) void refresh() }
window.addEventListener('shadow:quick-actions-changed', changed)
onUnmounted(() => { generation++; controller?.abort(); clearTimeout(timer); window.removeEventListener('shadow:quick-actions-changed', changed) })
defineExpose({ focus: () => root.value?.querySelector<HTMLElement>('button')?.focus() })
</script>
<style scoped>
.action-icon { display: inline-block; flex: 0 0 auto; }
.quick-actions.pinned { flex: 0 0 auto; max-height: 160px; overflow: auto; border-bottom: 1px solid var(--c-border); padding: 6px 16px; font-size: 12px; }
.pinned header h2 { font-size: 12px; font-weight: 500; }
.pinned header button { min-height: 26px; padding: 3px 6px; }
.pinned .action-row { padding: 4px 0; margin-top: 4px; }
.pinned [role=alert] { margin: 4px 0; line-height: 1.4; }
.pinned .action-row > .buttons { display: inline-flex; margin-right: 12px; }
.pinned .action-row > details { display: inline-block; vertical-align: top; }
.pinned .action-row > details[open] { display: block; }
.pinned .action-row > details > summary { padding: 6px 0; }
.quick-actions { padding: 12px; color: var(--c-text); font-size: 13px; }
header, .buttons, .script { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } header h2 { margin: 0; flex: 1; font-size: 14px; }
.scope, .target, summary span { color: var(--c-text-secondary); font-size: 12px; overflow-wrap: anywhere; }
.action-row, .discovery, .run-history { border-top: 1px solid var(--c-border); padding: 10px 0; margin-top: 8px; } summary { cursor: pointer; overflow-wrap: anywhere; } summary span { margin-left: 8px; }
code { display: block; white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; } button, input, textarea, select { font: inherit; color: var(--c-text); border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); padding: 6px 8px; min-height: 32px; } button { cursor: pointer; } button:disabled { opacity: .5; cursor: not-allowed; }
form { margin: 12px 0; } label { display: flex; flex-direction: column; gap: 5px; margin: 8px 0; } .checkbox { flex-direction: row; align-items: center; } input, textarea, select { min-width: 0; max-width: 100%; } .script code { flex: 1; } [role=alert] { color: var(--c-error); }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
header { padding-bottom: 12px; border-bottom: 1px solid var(--c-border); }
.heading { display: flex; align-items: center; gap: 8px; flex: 1; }
.quick-actions { padding: 16px; background: var(--c-bg-card); }
.scope { line-height: 1.6; margin: 12px 0 20px; max-width: 65ch; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-color: var(--c-border); background: transparent; }
button:hover:not(:disabled) { background: var(--c-bg-muted); border-color: var(--c-border-hover); }
.icon-button { padding: 6px; width: 32px; }
.action-row { margin: 0; padding: 14px 0; }
.action-heading { display: flex; align-items: center; gap: 10px; }
.action-heading strong { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 600; }
.state { font-size: 12px; color: var(--c-text-secondary); }
.run-button { flex: 0 0 auto; }
.command-preview { color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; margin: 6px 0; }
.target { display: flex; align-items: baseline; gap: 5px; margin: 4px 0; line-height: 1.5; }
.target svg { flex: 0 0 auto; }
summary { padding: 7px 0; font-size: 12px; color: var(--c-text-secondary); }
.creation-entries { display: flex; flex-wrap: wrap; gap: 8px; border-top: 1px solid var(--c-border); padding-top: 16px; margin-top: 4px; }
form, .run-confirmation { padding: 14px; background: var(--c-bg-soft); border: 1px solid var(--c-border); margin: 12px 0; }
form h3 { margin: 0 0 12px; font-size: 13px; }
form label { margin: 12px 0; }
form textarea { min-height: 88px; resize: vertical; font-family: var(--font-mono, monospace); }
form .buttons button[type=submit], .run-confirmation .buttons button:first-child { background: var(--c-primary-bg); color: var(--c-text-on-primary); border-color: transparent; }
.run-confirmation p { overflow-wrap: anywhere; line-height: 1.5; }
.script { display: grid; grid-template-columns: minmax(60px, 1fr) minmax(0, 2fr) auto; border-top: 1px solid var(--c-border-soft); padding: 8px 0; }
.pinned header { padding-bottom: 4px; border: 0; }
.pinned .action-heading { gap: 8px; }
@media (max-width: 700px), (pointer: coarse) { button, input, .icon-button, summary { min-height: 44px; } .icon-button { width: 44px; } .quick-actions { padding: 12px; } .script { grid-template-columns: minmax(0, 1fr) auto; } .script code { grid-row: 2; grid-column: 1 / -1; } .state { max-width: 90px; overflow-wrap: anywhere; } }
</style>
