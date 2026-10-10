<template>
  <component :is="embedded ? 'section' : 'details'" v-show="!embedded || expanded" class="work-alignment" :class="{ 'is-embedded': embedded }" @toggle="toggle">
    <summary v-if="!embedded">{{ t('Shared work notes') }} <span v-if="needsAttention">{{ t('— review needed') }}</span></summary>
    <p class="work-note">{{ t('A shared notebook, not an execution gate. Routine updates do not wake other agents.') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="button" :disabled="busy" @click="load">{{ busy ? t('Loading...') : t('Refresh work state') }}</button>
    <label v-if="view.records.length > 1">{{ t('Work item') }}
      <UiSelect v-model="selected" :disabled="busy || editing">
        <option v-for="item in view.records" :key="item.key" :value="item.key">{{ item.workflow?.title || item.key }}</option>
      </UiSelect>
    </label>
    <template v-if="current">
      <h3>{{ current.definition.objective }}</h3>
      <p class="provenance">{{ current.origin === 'human' ? t('User-defined goal') : t('Working interpretation') }}</p>
      <p v-if="current.notes?.relation">{{ relationLabel(current.notes.relation.kind) }}: {{ current.notes.relation.reason }}</p>
      <p v-if="current.contextChanged" class="pending-impact">{{ t('An ancestor changed. This branch has not been reassessed yet.') }}</p>
      <p v-if="current.notes?.attention && !current.notes.attention.reviewed" class="pending-impact">
        <strong>{{ t('Impact not yet reviewed') }}</strong> {{ current.notes.attention.summary }}
      </p>
      <WorkNoteContent v-if="current.notes" :notes="current.notes" :api-base="apiBase" />
      <p v-if="current.workflow">{{ t('Progress:') }} {{ enumLabel(current.workflow.status) }}<template v-if="current.workflow.blockedReason"> - {{ current.workflow.blockedReason }}</template></p>
      <p class="provenance">{{ t('Managed by:') }} {{ sessionTitle(current.authority.manager) }}</p>
      <label v-if="canWrite && current.workflow">{{ t('Assigned to') }}
        <UiSelect v-if="sessions" :value="current.workflow.assignee ?? ''" :disabled="busy || editing" @change="assign(($event.target as HTMLSelectElement).value)">
          <option value="">{{ t('Unassigned') }}</option>
          <option v-for="session in sessions" :key="session.sessionId" :value="session.sessionId">{{ session.title }}</option>
        </UiSelect>
        <span v-else>{{ sessionTitle(current.authority.executor) }}</span>
      </label>
      <p v-else>{{ t('Assigned to') }}: {{ sessionTitle(current.authority.executor) }}</p>
      <details v-if="current.definition.acceptance.length || current.definition.boundaries.length">
        <summary>{{ t('Acceptance and boundaries') }}</summary>
        <p v-if="current.definition.acceptance.length">{{ current.definition.acceptance.join('\n') }}</p>
        <p v-if="current.definition.boundaries.length">{{ current.definition.boundaries.join('\n') }}</p>
      </details>
      <form v-if="canWrite && (current.contextChanged || current.notes?.attention && !current.notes.attention.reviewed)" @submit.prevent="review">
        <label>{{ t('Impact assessment') }}<textarea v-model="conclusion" required maxlength="2000"
          :placeholder="t('What changes for the parent goal, and what can continue?')" @focus="reviewVersion ??= current.sequence" /></label>
        <p v-if="reviewVersion !== undefined && reviewVersion !== current.sequence" class="pending-impact">
          {{ t('The branch changed. Read its latest note before assessing the impact.') }}
          <button type="button" :disabled="busy" @click="reviewVersion = current.sequence">{{ t('Assess this version') }}</button>
        </p>
        <button type="submit" :disabled="busy || !conclusion.trim()">{{ t('Record assessment') }}</button>
      </form>
    </template>
    <p v-else-if="!busy">{{ t('No shared work notes here. Execution does not require a note.') }}</p>
    <div v-if="canWrite && !editing" class="work-actions">
      <button v-if="current" type="button" :disabled="busy" @click="edit()">{{ t('Edit note') }}</button>
      <button v-if="!project" type="button" :disabled="busy" @click="edit('root')">{{ t('New work item') }}</button>
      <button v-if="!project && current" type="button" :disabled="busy" @click="edit('child')">{{ t('Add child work') }}</button>
    </div>
    <form v-if="editing && canWrite" class="note-editor" @submit.prevent="save">
      <p v-if="edited && current?.sequence !== edited.sequence" class="pending-impact">
        {{ t('This note changed while you were editing. Your draft is retained; reload it before applying a new version.') }}
        <button type="button" :disabled="busy" @click="edit()">{{ t('Discard draft and load latest') }}</button>
      </p>
      <label>{{ t('Work title') }}<input v-model="draft.title" required maxlength="160" /></label>
      <label>{{ t('Outcome') }}<textarea v-model="draft.objective" required maxlength="4000" /></label>
      <label>{{ t('Kind') }}<UiSelect v-model="draft.kind"><option v-for="kind in kinds" :key="kind" :value="kind">{{ workKind(kind) }}</option></UiSelect></label>
      <template v-if="parentKey">
        <label>{{ t('Reasoning link') }}<UiSelect v-model="draft.relationKind"><option v-for="kind in relations" :key="kind" :value="kind">{{ relationLabel(kind) }}</option></UiSelect></label>
        <label>{{ t('Why this branch follows') }}<textarea v-model="draft.relationReason" required maxlength="2000" /></label>
      </template>
      <label>{{ t('Current conclusion') }}<textarea v-model="draft.summary" maxlength="2000" /></label>
      <label>{{ t('Working plan (one step per line)') }}<textarea v-model="draft.plan" /></label>
      <label>{{ t('Next action') }}<textarea v-model="draft.next" maxlength="2000" /></label>
      <label v-if="edited">{{ t('Progress') }}<UiSelect v-model="draft.status"><option v-for="column in columns" :key="column.status" :value="column.status">{{ column.label }}</option></UiSelect></label>
      <label v-if="edited && draft.status === 'blocked'">{{ t('Blocker') }}<textarea v-model="draft.blocker" required maxlength="2000" /></label>
      <details>
        <summary>{{ t('Evidence and presentation') }}</summary>
        <label>{{ t('Acceptance (one per line)') }}<textarea v-model="draft.acceptance" /></label>
        <label>{{ t('Existing boundaries (one per line; not new permission)') }}<textarea v-model="draft.boundaries" /></label>
        <fieldset v-for="(artifact, index) in draft.artifacts" :key="index">
          <label>{{ t('Artifact label') }}<input v-model="artifact.label" required maxlength="160" /></label>
          <label>{{ t('Artifact URL') }}<input v-model="artifact.href" required maxlength="2000" /></label>
          <button type="button" @click="draft.artifacts.splice(index, 1)">{{ t('Remove link') }}</button>
        </fieldset>
        <button type="button" :disabled="draft.artifacts.length >= 20" @click="draft.artifacts.push({ label: '', href: '' })">{{ t('Add artifact link') }}</button>
        <label>{{ t('Read-only exhibit HTML') }}<textarea v-model="draft.html" class="html-source" maxlength="48000" spellcheck="false" /></label>
      </details>
      <div class="work-actions">
        <button type="submit" :disabled="busy">{{ t('Save note') }}</button>
        <button type="button" :disabled="busy" @click="editing = false">{{ t('Cancel edit') }}</button>
      </div>
    </form>
  </component>
</template>
<script setup lang="ts">
import UiSelect from './UiSelect.vue'
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { enumLabel } from '../display-labels.ts'
import { t } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import { parseWorkView, type WorkView, type WorkAgreement } from '../work-alignment.ts'
import { workNotesSchema, type WorkNotes } from '../../../src/initiatives/work-notes.ts'
import { relationLabel, workColumns, workKind } from '../project-work.ts'
import WorkNoteContent from './WorkNoteContent.vue'
const props = defineProps<{ sessionId: string; apiBase: string; canWrite: boolean; embedded?: boolean; expanded?: boolean; revision?: number;
  project?: boolean; workKey?: string; sessions?: { sessionId: string; title: string }[] }>()
const emit = defineEmits<{ attention: [needed: boolean]; updated: []; editing: [value: boolean] }>()
const sessionTitle = (id: string | null) => id ? props.sessions?.find(session => session.sessionId === id)?.title ?? id : t('Unassigned')
const view = ref<WorkView>({ records: [], effects: [] }), selected = ref('')
const current = computed(() => view.value.records.find(record => record.key === selected.value))
const needsAttention = computed(() => view.value.records.some(record => record.contextChanged || record.notes?.attention && !record.notes.attention.reviewed))
const busy = ref(false), readError = ref(''), actionError = ref(''), editing = ref(false), conclusion = ref('')
const error = computed(() => actionError.value || readError.value)
const kinds = ['goal', 'approach', 'task', 'finding'] as const, relations = ['supports', 'requires', 'assumption'] as const
const columns = workColumns.filter(column => column.status !== null)
const draft = reactive({ title: '', objective: '', kind: 'task' as WorkNotes['kind'],
  relationKind: 'supports' as typeof relations[number], relationReason: '', summary: '', plan: '', next: '',
  html: '', artifacts: [] as WorkNotes['artifacts'], acceptance: '', boundaries: '', status: 'pending', blocker: '' })
const parentKey = ref<string>(), edited = ref<WorkAgreement>()
const reviewVersion = ref<number>()
let opened = false, refreshPending = false
let controller: AbortController | undefined
async function request(body?: object) {
  controller?.abort()
  const pending = new AbortController()
  controller = pending; busy.value = true
  if (body) actionError.value = ''
  else readError.value = ''
  try {
    const path = props.project ? `/api/work/${encodeURIComponent(props.workKey ?? '')}` : `/api/sessions/${encodeURIComponent(props.sessionId)}/work`
    const response = await fetch(apiUrl(props.apiBase, path), {
      method: body ? 'POST' : 'GET', signal: AbortSignal.any([pending.signal, AbortSignal.timeout(15000)]),
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
    const data: unknown = await response.json()
    if (!response.ok) throw new Error(data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' ? data.message : t('Could not load or change work alignment.'))
    const parsed = parseWorkView(data)
    if (pending.signal.aborted) return false
    view.value = parsed
    if (!parsed.records.some(record => record.key === selected.value)) selected.value = parsed.selected ?? parsed.records[0]?.key ?? ''
    if (body) emit('updated')
    return true
  } catch (cause) {
    if (!pending.signal.aborted) {
      const message = cause instanceof Error ? cause.message : t('Work alignment failed.')
      if (body) actionError.value = message
      else readError.value = message
    }
    return false
  } finally {
    if (controller === pending) {
      busy.value = false
      if (refreshPending && opened) { refreshPending = false; void load() }
    }
  }
}
const load = () => request()
watch(() => props.revision, () => {
  if (!opened) return
  if (busy.value) refreshPending = true
  else void load()
})
function toggle(event: Event) { opened = (event.currentTarget as HTMLDetailsElement).open; if (opened) void load(); else controller?.abort() }
watch(needsAttention, needed => emit('attention', !!needed), { immediate: true })
watch(editing, value => emit('editing', value))
watch(() => props.expanded, expanded => {
  if (!props.embedded) return
  opened = !!expanded
  if (opened) void load()
  else controller?.abort()
}, { immediate: true })
function edit(create?: 'child' | 'root') {
  actionError.value = ''
  const record = create ? undefined : current.value
  const notes = record?.notes ?? workNotesSchema.parse({})
  edited.value = record
  parentKey.value = create === 'child' ? current.value?.key : record?.workflow?.parentKey
  Object.assign(draft, { title: record?.workflow?.title ?? '', objective: record?.definition.objective ?? '',
    kind: notes.kind, relationKind: notes.relation?.kind ?? 'supports', relationReason: notes.relation?.reason ?? '',
    summary: notes.summary, plan: notes.plan.join('\n'), next: notes.next, html: notes.html,
    artifacts: notes.artifacts.map(artifact => ({ ...artifact })), acceptance: record?.definition.acceptance.join('\n') ?? '',
    boundaries: record?.definition.boundaries.join('\n') ?? '', status: record?.workflow?.status ?? 'pending',
    blocker: record?.workflow?.blockedReason ?? '' })
  editing.value = true
}
async function save() {
  if (!props.canWrite) return
  const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)
  const definition = { objective: draft.objective, acceptance: lines(draft.acceptance), boundaries: lines(draft.boundaries),
    evidence: edited.value?.definition.evidence ?? [] }
  const notes = { kind: draft.kind, summary: draft.summary, plan: lines(draft.plan), next: draft.next, html: draft.html,
    artifacts: draft.artifacts, ...(parentKey.value ? { relation: { kind: draft.relationKind, reason: draft.relationReason } } : {}) }
  let body: object
  if (!edited.value) body = { action: 'create', data: { title: draft.title, parentKey: parentKey.value, definition, notes } }
  else {
    const prior = edited.value
    const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
    const changedNotes = Object.fromEntries(Object.entries(notes).filter(([key, value]) =>
      changed(value, (prior.notes ?? workNotesSchema.parse({}))[key as keyof WorkNotes])))
    const data = {
      ...(changed(definition, prior.definition) ? { definition } : {}),
      ...(draft.title !== prior.workflow?.title ? { title: draft.title } : {}),
      ...(Object.keys(changedNotes).length ? { notes: changedNotes } : {}),
      ...(draft.status !== prior.workflow?.status ? { status: draft.status } : {}),
      ...(draft.status === 'blocked' && draft.blocker !== prior.workflow?.blockedReason ? { blockedReason: draft.blocker } : {}),
    }
    if (!Object.keys(data).length) { actionError.value = t('No changes to save.'); return }
    body = { action: 'update', key: prior.key, version: prior.sequence, data }
  }
  if (await request(body)) editing.value = false
}
async function assign(assignee: string) {
  if (!props.canWrite || !current.value) return
  await request({ action: 'assign', key: current.value.key, version: current.value.sequence, data: { assignee: assignee || null } })
}
async function review() {
  if (!props.canWrite || !current.value) return
  if (await request({ action: 'review', key: current.value.key, version: reviewVersion.value ?? current.value.sequence,
    data: { conclusion: conclusion.value } })) { conclusion.value = ''; reviewVersion.value = undefined }
}
watch(() => [props.apiBase, props.sessionId, props.canWrite, props.workKey], () => {
  controller?.abort(); view.value = { records: [], effects: [] }; selected.value = readError.value = actionError.value = ''
  editing.value = false; conclusion.value = ''; reviewVersion.value = undefined
  if (opened) void load()
})
onUnmounted(() => controller?.abort())
</script>
<style scoped>
.work-alignment { margin: 4px 16px; font-size: 13px; line-height: 1.6; min-width: 0; overflow-wrap: anywhere; }
.work-alignment.is-embedded { margin: 0; }
summary { cursor: pointer; color: var(--c-text-secondary); }
h3 { font-size: 16px; line-height: 1.5; margin: 18px 0 6px; }
p { margin: 8px 0; white-space: pre-wrap; }
.work-note, .provenance { color: var(--c-text-secondary); font-size: 12px; }
.pending-impact { color: var(--c-warn); background: var(--c-warn-bg); padding: 10px; }
.pending-impact strong { font-weight: 500; }
label { display: block; margin: 12px 0; }
textarea, input { display: block; }
textarea, .ui-select, input { width: 100%; box-sizing: border-box; color: var(--c-text); background: var(--c-bg-input); font: inherit; }
textarea { min-height: 74px; resize: vertical; }
button:where(:not(.ui-select)), .ui-select, textarea, input { min-height: 36px; border: 1px solid var(--c-control-border); padding: 6px 8px; border-radius: var(--radius-control); }
button:where(:not(.ui-select)) { font: inherit; background: var(--c-bg-card); color: var(--c-text); cursor: pointer; }
button:where(:not(.ui-select)):hover:not(:disabled) { background: var(--c-bg-muted); }
button:where(:not(.ui-select)):disabled { opacity: .5; cursor: not-allowed; }
button:where(:not(.ui-select)):focus-visible, .ui-select:is(:focus-visible, :has(:focus-visible)), textarea:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.work-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
form { margin-block: 20px; padding-block: 12px; border-block: 1px solid var(--c-border); }
fieldset { min-width: 0; margin: 10px 0; padding: 0 10px 10px; border: 1px solid var(--c-border); }
.html-source { min-height: 120px; font-family: var(--font-mono); font-size: 12px; }
[role=alert] { color: var(--c-error); }
@media (max-width: 700px), (pointer: coarse) { button:where(:not(.ui-select)), .ui-select { min-height: 44px; } input, textarea { font-size: 16px; } }
</style>
