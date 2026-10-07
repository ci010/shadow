<template>
  <component :is="embedded ? 'section' : 'details'" v-show="!embedded || expanded" class="work-alignment" :class="{ 'is-embedded': embedded }" @toggle="toggle">
    <summary v-if="!embedded">{{ t('Work') }} <span v-if="needsAttention">{{ t('— review needed') }}</span></summary>
    <p class="work-note">{{ t('A revision changes the agreement, not permissions or external operations.') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="button" :disabled="busy" @click="load">{{ busy ? t('Loading...') : t('Refresh work state') }}</button>
    <label v-if="view.records.length > 1">{{ t('Work item') }}
      <select v-model="selected" :disabled="busy || editing">
        <option v-for="item in view.records" :key="item.key" :value="item.key">{{ item.workflow?.title || item.key }} {{ t('· v') }}{{ item.revision }}</option>
      </select>
    </label>
    <template v-if="current">
      <p><strong>{{ current.definition.objective }}</strong></p>
      <p>{{ current.origin === 'human' ? t('Human-confirmed agreement') : t('Agent interpretation — not a quoted user requirement') }}</p>
      <p>{{ t('Managed by:') }} {{ sessionTitle(current.authority.manager) }} {{ t('· Assigned to:') }} {{ sessionTitle(current.authority.executor) }}</p>
      <p v-if="current.workflow">{{ t('Progress:') }} {{ enumLabel(current.workflow.status) }}<template v-if="current.workflow.blockedReason"> — {{ current.workflow.blockedReason }}</template></p>
      <p v-if="current.workflow?.parentKey">{{ t('Parent work:') }} {{ current.workflow.parentKey }}</p>
      <p v-if="current.workflow?.dependencies.length">{{ t('Dependencies:') }} {{ current.workflow.dependencies.join(', ') }}</p>
      <details v-if="view.records.some(item => item.workflow?.parentKey === current?.key)">
        <summary>{{ t('Initiative · child work') }}</summary>
        <ul><li v-for="item in view.records.filter(item => item.workflow?.parentKey === current?.key)" :key="item.key">
          {{ item.workflow?.title }} — {{ enumLabel(item.workflow?.status) }} · {{ item.authority.executor || t('unassigned') }}
        </li></ul>
        <p>{{ t('Child completion does not replace this item\'s acceptance review.') }}</p>
      </details>
      <p>{{ t('Acceptance:') }} {{ current.definition.acceptance.join('; ') }}</p>
      <p>{{ t('Existing boundaries:') }} {{ current.definition.boundaries.join('; ') || t('Not recorded — do not infer permission') }}</p>
      <p>{{ t('Status:') }} {{ current.paused ? t('Paused') : current.adoption?.revision === current.revision ? t('Adopted by executor') : t('Awaiting executor adoption') }} · {{ current.reason }}</p>
      <p v-if="current.answerReview">{{ t('Custom answer needs interpretation review:') }} {{ current.answerReview.text }}</p>
      <section v-for="proposal in current.proposals?.filter(item => item.status === 'pending' && item.baseRevision === current?.revision && item.assignmentRevision === current?.workflow?.assignmentRevision)" :key="proposal.id" :aria-label="t('Pending work proposal')">
        <h3>{{ t('Proposed change') }}</h3>
        <p>{{ t('Change type:') }} {{ proposal.change }} {{ t('· New execution:') }} {{ proposal.paused ? t('paused') : t('not paused') }}</p>
        <p>{{ proposal.definition.objective }}</p>
        <p>{{ t('Acceptance:') }} {{ proposal.definition.acceptance.join('; ') }}</p>
        <p>{{ t('Boundaries:') }} {{ proposal.definition.boundaries.join('; ') || t('Not recorded — no new permission') }}</p>
        <p>{{ proposal.reason }}</p>
        <button v-if="canWrite" type="button" :disabled="busy" @click="perform('apply_proposal', { proposalId: proposal.id })">{{ t('Approve this exact change') }}</button>
        <p>{{ t('Uses the same proposal as Ask. Approval is recorded once.') }}</p>
      </section>
      <dl v-if="current.adoption">
        <dt>{{ t('Executor understanding') }}</dt><dd>{{ current.adoption.understanding }}</dd>
        <dt>{{ t('Stop / retain') }}</dt><dd>{{ current.adoption.stop.join('; ') || t('None') }} / {{ current.adoption.retain.join('; ') || t('None') }}</dd>
        <dt>{{ t('Agent-chosen next phase (not user scope)') }}</dt><dd>{{ current.adoption.next.join('; ') }}</dd>
      </dl>
      <p v-if="current.transition">{{ t('Context transition:') }} {{ enumLabel(current.transition.strategy) }} — {{ enumLabel(current.transition.status) }}.
        <span v-if="current.transition.successorId">{{ t('Successor:') }} {{ current.transition.successorId }}{{ t('. Initiative assignment is unchanged until explicitly released and reassigned.') }}</span>
      </p>
      <details v-if="current.history.length">
        <summary>{{ t('Revision history and proposals') }}</summary>
        <article v-for="(event, index) in current.history" :key="index">
          <p>{{ event.kind }} · {{ event.actor }} · {{ event.at }}</p>
          <pre>{{ JSON.stringify(event.data, null, 2) }}</pre>
        </article>
      </details>
      <div v-if="canWrite" class="work-actions">
        <button type="button" :disabled="busy || editing || !current.authority.active" @click="edit()">{{ t('Revise work') }}</button>
        <button v-if="!project" type="button" :disabled="busy || editing" @click="edit(false, true)">{{ t('New work item') }}</button>
        <button v-if="!project" type="button" :disabled="busy || editing" @click="edit(true)">{{ t('Add child work') }}</button>
      </div>
      <details v-if="canWrite && current.workflow && current.sequence">
        <summary>{{ t('Assignment and progress') }}</summary>
        <label v-if="!current.workflow.assignee">{{ t('Assign to session') }}
          <select v-if="sessions" v-model="assignee"><option value="">{{ t('Choose a session') }}</option><option v-for="session in sessions" :key="session.sessionId" :value="session.sessionId">{{ session.title }}</option></select>
          <input v-else v-model="assignee" :placeholder="t('Session ID')">
        </label>
        <button v-if="!current.workflow.assignee" type="button" :disabled="busy || !assignee.trim()" @click="manage('assign', { assignee: assignee.trim() })">{{ t('Assign work') }}</button>
        <template v-else>
          <label>{{ t('Release reason') }} <input v-model="releaseReason" :placeholder="t('Verified handoff context')"></label>
          <button type="button" :disabled="busy || !releaseReason.trim()" @click="manage('assign', { assignee: null, reason: releaseReason })">{{ t('Release assignment') }}</button>
          <p>{{ t('An executor checkpoint and settled effects are required after execution has started.') }}</p>
        </template>
        <label>{{ t('Progress') }} <select v-model="progress"><option value="pending">{{ t('Pending') }}</option><option value="in_progress">{{ t('In progress') }}</option><option value="blocked">{{ t('Blocked') }}</option><option value="done">{{ t('Done') }}</option><option value="cancelled">{{ t('Cancelled') }}</option></select></label>
        <label v-if="progress === 'blocked'">{{ t('Blocker') }} <textarea v-model="blocker" required /></label>
        <label v-if="progress === 'done'">{{ t('Verified acceptance and result') }} <textarea v-model="result" required /></label>
        <button type="button" :disabled="busy || progress === 'done' && !result.trim() || progress === 'blocked' && !blocker.trim()" @click="saveProgress">{{ t('Record progress') }}</button>
      </details>
      <details class="advanced-work">
        <summary>{{ t('Advanced recovery') }}</summary>
        <details v-if="current.checkpoint">
          <summary>{{ t('Executor checkpoint · v') }}{{ current.checkpoint.revision }}</summary>
          <p v-for="field in inventoryFields" :key="field">{{ field }}: {{ current.checkpoint[field].join('; ') || t('None reported') }}</p>
        </details>
        <div v-if="canWrite" class="work-actions">
          <button type="button" :disabled="busy || !current.authority.executor" @click="perform('request_checkpoint')">{{ t('Request executor checkpoint') }}</button>
          <button type="button" :disabled="busy || !canTransition" @click="transition = 'fresh'">{{ t('Fresh context') }}</button>
          <button type="button" :disabled="busy || !canTransition" @click="transition = 'successor'">{{ t('Prepare successor') }}</button>
        </div>
        <p v-if="!canTransition">{{ t('A current executor checkpoint with no unresolved effects is required before context replacement.') }}</p>
      </details>
    </template>
    <template v-else-if="!busy">
      <p>{{ t('No work is assigned here. Conversation needs no work item; create one when execution or tracking is needed.') }}</p>
      <button v-if="canWrite && !project" type="button" @click="edit()">{{ t('Create work item') }}</button>
    </template>
    <form v-if="editing && canWrite" @submit.prevent="save">
      <label v-if="creating">{{ t('Work title') }} <input v-model="title" required maxlength="160"></label>
      <label>{{ t('Outcome') }} <textarea v-model="objective" required maxlength="4000" /></label>
      <label>{{ t('Acceptance (one per line)') }} <textarea v-model="acceptance" required /></label>
      <label>{{ t('Existing boundaries (one per line; not new permission)') }} <textarea v-model="boundaries" /></label>
      <label v-if="!creating">{{ t('Change type') }} <select v-model="change"><option value="understanding">{{ t('Correct interpretation') }}</option><option value="goal">{{ t('Change goal / acceptance') }}</option><option value="authorization">{{ t('Review authorization boundary') }}</option><option value="pause">{{ t('Pause / resume work') }}</option></select></label>
      <label>{{ t('Why this revision is needed') }} <textarea v-model="reason" required maxlength="2000" /></label>
      <label v-if="!creating"><input v-model="paused" type="checkbox"> {{ t('Pause new execution') }}</label>
      <button type="submit" :disabled="busy">{{ creating ? t('Create work (executor must adopt)') : t('Apply revision (executor must adopt)') }}</button>
      <button type="button" :disabled="busy" @click="editing = false">{{ t('Cancel edit') }}</button>
    </form>
    <div v-if="transition && canWrite" role="alert">
      <p>{{ transition === 'fresh' ? t('Replace reasoning context at the next safe boundary, retaining history, files and queued input?') : t('Retire this execution and prepare an idle successor? This does not transfer Initiative assignments.') }}</p>
      <button type="button" :disabled="busy" @click="perform('transition', { strategy: transition })">{{ t('Confirm') }} {{ transition }}</button>
      <button type="button" :disabled="busy" @click="transition = ''">{{ t('Cancel') }}</button>
    </div>
    <article v-for="effect in view.effects" :key="effect.id">
      <p>{{ t('Unresolved operation:') }} {{ effect.tool }} — {{ enumLabel(effect.status) }} · {{ effect.sessionId }}</p>
      <button v-if="canWrite && effect.status === 'unknown'" type="button" :disabled="busy" @click="settleId = effect.id">{{ t('Review external outcome') }}</button>
    </article>
    <div v-if="settleId && canWrite" role="alert">
      <p>{{ t('Only confirm after independently checking the external outcome. This records your reconciliation, not cancellation or rollback.') }}</p>
      <button type="button" :disabled="busy" @click="perform('settle', { effectId: settleId })">{{ t('I verified the outcome') }}</button>
      <button type="button" :disabled="busy" @click="settleId = ''">{{ t('Cancel') }}</button>
    </div>
  </component>
</template>
<script setup lang="ts">
import { enumLabel } from '../display-labels.ts'
import { t } from '../i18n.ts'
import { computed, onUnmounted, ref, watch } from 'vue'
import { apiUrl } from '../api-url.ts'
import { parseWorkView, type WorkView } from '../work-alignment.ts'
const props = defineProps<{ sessionId: string; apiBase: string; canWrite: boolean; embedded?: boolean; expanded?: boolean; revision?: number;
  project?: boolean; workKey?: string; sessions?: { sessionId: string; title: string }[] }>()
const emit = defineEmits<{ attention: [needed: boolean]; updated: []; editing: [value: boolean] }>()
const sessionTitle = (id: string | null) => id ? props.sessions?.find(session => session.sessionId === id)?.title ?? id : t('Unassigned')
const view = ref<WorkView>({ records: [], effects: [] })
const selected = ref('')
const current = computed(() => view.value.records.find(record => record.key === selected.value))
const needsAttention = computed(() => view.value.records.some(record =>
  (!record.workflow || !['done', 'cancelled'].includes(record.workflow.status))
  && (record.paused || record.adoption?.revision !== record.revision || record.answerReview
    || record.proposals?.some(proposal => proposal.status === 'pending' && proposal.baseRevision === record.revision
      && proposal.assignmentRevision === record.workflow?.assignmentRevision))))
const canTransition = computed(() => current.value?.checkpoint?.revision === current.value?.revision
  && !!current.value?.checkpoint && !current.value.checkpoint.inFlight.length && !current.value.checkpoint.unknown.length && !view.value.effects.length)
const inventoryFields = ['completed', 'artifacts', 'inFlight', 'unknown', 'retired'] as const
const busy = ref(false), readError = ref(''), actionError = ref(''), editing = ref(false)
const error = computed(() => actionError.value || readError.value)
const objective = ref(''), acceptance = ref(''), boundaries = ref(''), reason = ref('')
const title = ref(''), creating = ref(false), parentKey = ref<string>()
const assignee = ref(''), releaseReason = ref(''), progress = ref('in_progress'), blocker = ref(''), result = ref('')
const change = ref('understanding'), paused = ref(false), transition = ref(''), settleId = ref('')
let expectedRevision = 0
let edited: WorkView['records'][number] | undefined
let opened = false
let controller: AbortController | undefined
let refreshPending = false
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
  }
  finally {
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
function edit(child = false, root = false) {
  actionError.value = ''
  creating.value = root || child || !current.value
  parentKey.value = child ? current.value?.key : undefined
  const record = creating.value ? undefined : current.value
  edited = record
  title.value = ''
  expectedRevision = record?.revision ?? 0
  objective.value = record?.definition.objective ?? ''
  acceptance.value = record?.definition.acceptance.join('\n') ?? ''
  boundaries.value = record?.definition.boundaries.join('\n') ?? ''
  paused.value = record?.paused ?? false; reason.value = ''; change.value = 'understanding'; editing.value = true
}
async function save() {
  if (!props.canWrite) return
  const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)
  const definition = { objective: objective.value, acceptance: lines(acceptance.value), boundaries: lines(boundaries.value),
    evidence: edited?.definition.evidence ?? [] }
  const body = creating.value ? { action: 'create', data: { title: title.value, parentKey: parentKey.value, reason: reason.value, definition } }
    : { action: 'update', key: edited?.key, revision: expectedRevision,
      data: { change: change.value, reason: reason.value, paused: paused.value, definition } }
  if (await request(body)) editing.value = false
}
async function manage(action: string, data: object) {
  if (current.value?.sequence) await perform(action, { ...data, expectedSequence: current.value.sequence })
}
async function saveProgress() {
  await manage('progress', { status: progress.value,
    ...(progress.value === 'blocked' ? { blockedReason: blocker.value } : {}),
    ...(progress.value === 'done' ? { result: { summary: result.value, evidence: [] } } : {}),
  })
}
async function perform(action: string, data?: object) {
  if (!props.canWrite || !current.value) return
  if (await request({ action, key: current.value.key, revision: current.value.revision, data })) { transition.value = ''; settleId.value = '' }
}
watch(() => [props.apiBase, props.sessionId, props.canWrite, props.workKey], () => {
  controller?.abort(); view.value = { records: [], effects: [] }; selected.value = readError.value = actionError.value = transition.value = settleId.value = ''
  editing.value = false; if (opened) void load()
})
onUnmounted(() => controller?.abort())
</script>
<style scoped>
.work-alignment { margin: 4px 16px; font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
.work-alignment.is-embedded { margin: 0; }
summary { cursor: pointer; color: var(--c-text-secondary); }
p, dl { margin: 6px 0; }
dd { margin: 0 0 8px 12px; }
label { display: block; margin: 8px 0; }
textarea, select, input:not([type=checkbox]) { display: block; width: 100%; box-sizing: border-box; color: var(--c-text); background: var(--c-bg-input); }
textarea { min-height: 64px; resize: vertical; }
button, select, textarea, input:not([type=checkbox]) { min-height: 36px; border: 1px solid var(--c-border); padding: 4px 8px; border-radius: var(--radius-control); }
button { background: var(--c-bg-card); color: var(--c-text); cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible, select:focus-visible, textarea:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.is-embedded > :first-child { margin-top: 0; }
.is-embedded > :last-child { margin-bottom: 0; }
.work-actions { display: flex; flex-wrap: wrap; gap: 6px; }
pre { white-space: pre-wrap; max-height: 260px; overflow: auto; }
[role=alert] { color: var(--c-error); }
@media (max-width: 700px), (pointer: coarse) { button, select { min-height: 44px; } }
</style>
