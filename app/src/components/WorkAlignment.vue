<template>
  <details class="work-alignment" @toggle="toggle">
    <summary>Work alignment <span v-if="needsAttention">— review needed</span></summary>
    <p>Goals, human boundaries and the agent's current phase are separate. A revision grants no permissions and does not cancel external work.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="button" :disabled="busy" @click="load">{{ busy ? 'Loading...' : 'Refresh work state' }}</button>
    <label v-if="view.records.length">Agreement
      <select v-model="selected" :disabled="busy || editing">
        <option v-for="item in view.records" :key="item.key" :value="item.key">{{ item.key }} · v{{ item.revision }}</option>
      </select>
    </label>
    <template v-if="current">
      <p><strong>{{ current.definition.objective }}</strong></p>
      <p>{{ current.origin === 'human' ? 'Human-confirmed agreement' : 'Agent interpretation — not a quoted user requirement' }}</p>
      <p>Controller: {{ current.authority.manager || 'unassigned' }} · Executor: {{ current.authority.executor || 'unassigned' }}</p>
      <p>Acceptance: {{ current.definition.acceptance.join('; ') }}</p>
      <p>Existing boundaries: {{ current.definition.boundaries.join('; ') || 'Not recorded — do not infer permission' }}</p>
      <p>Status: {{ current.paused ? 'Paused' : current.adoption?.revision === current.revision ? 'Adopted by executor' : 'Awaiting executor adoption' }} · {{ current.reason }}</p>
      <p v-if="current.answerReview">Custom answer needs interpretation review: {{ current.answerReview.text }}</p>
      <dl v-if="current.adoption">
        <dt>Executor understanding</dt><dd>{{ current.adoption.understanding }}</dd>
        <dt>Stop / retain</dt><dd>{{ current.adoption.stop.join('; ') || 'None' }} / {{ current.adoption.retain.join('; ') || 'None' }}</dd>
        <dt>Agent-chosen next phase (not user scope)</dt><dd>{{ current.adoption.next.join('; ') }}</dd>
      </dl>
      <p v-if="current.transition">Context transition: {{ current.transition.strategy }} — {{ current.transition.status }}.
        <span v-if="current.transition.successorId">Successor: {{ current.transition.successorId }}. Initiative assignment is unchanged until explicitly released and reassigned.</span>
      </p>
      <details v-if="current.history.length">
        <summary>Revision history and proposals</summary>
        <article v-for="(event, index) in current.history" :key="index">
          <p>{{ event.kind }} · {{ event.actor }} · {{ event.at }}</p>
          <pre>{{ JSON.stringify(event.data, null, 2) }}</pre>
          <button v-if="canWrite && event.kind === 'proposal'" type="button" :disabled="busy" @click="reviewProposal(event.data)">Review proposal in editor</button>
        </article>
      </details>
      <details v-if="current.checkpoint">
        <summary>Executor checkpoint · v{{ current.checkpoint.revision }}</summary>
        <p v-for="field in inventoryFields" :key="field">{{ field }}: {{ current.checkpoint[field].join('; ') || 'None reported' }}</p>
      </details>
      <div v-if="canWrite" class="work-actions">
        <button type="button" :disabled="busy || editing" @click="edit">Revise agreement</button>
        <button type="button" :disabled="busy" @click="perform('request_checkpoint')">Request executor checkpoint</button>
        <button type="button" :disabled="busy || !canTransition" @click="transition = 'fresh'">Fresh context</button>
        <button type="button" :disabled="busy || !canTransition" @click="transition = 'successor'">Prepare successor</button>
      </div>
      <p v-if="!canTransition">A current executor checkpoint with no unresolved effects is required before context replacement.</p>
    </template>
    <template v-else-if="!busy">
      <p>No versioned agreement is registered here. Historical goals and permissions are not inferred automatically.</p>
      <button v-if="canWrite" type="button" @click="edit">Create work agreement</button>
    </template>
    <form v-if="editing && canWrite" @submit.prevent="save">
      <label>Outcome <textarea v-model="objective" required maxlength="4000" /></label>
      <label>Acceptance (one per line) <textarea v-model="acceptance" required /></label>
      <label>Existing boundaries (one per line; not new permission) <textarea v-model="boundaries" /></label>
      <label>Change type <select v-model="change"><option value="understanding">Correct interpretation</option><option value="goal">Change goal / acceptance</option><option value="authorization">Review authorization boundary</option><option value="pause">Pause / resume work</option></select></label>
      <label>Why this revision is needed <textarea v-model="reason" required maxlength="2000" /></label>
      <label><input v-model="paused" type="checkbox"> Pause new execution</label>
      <button type="submit" :disabled="busy">Apply revision (executor must adopt)</button>
      <button type="button" :disabled="busy" @click="editing = false">Cancel edit</button>
    </form>
    <div v-if="transition && canWrite" role="alert">
      <p>{{ transition === 'fresh' ? 'Replace reasoning context at the next safe boundary, retaining history, files and queued input?' : 'Retire this execution and prepare an idle successor? This does not transfer Initiative assignments.' }}</p>
      <button type="button" :disabled="busy" @click="perform('transition', { strategy: transition })">Confirm {{ transition }}</button>
      <button type="button" :disabled="busy" @click="transition = ''">Cancel</button>
    </div>
    <article v-for="effect in view.effects" :key="effect.id">
      <p>Unresolved operation: {{ effect.tool }} — {{ effect.status }} · {{ effect.sessionId }}</p>
      <button v-if="canWrite && effect.status === 'unknown'" type="button" :disabled="busy" @click="settleId = effect.id">Review external outcome</button>
    </article>
    <div v-if="settleId && canWrite" role="alert">
      <p>Only confirm after independently checking the external outcome. This records your reconciliation, not cancellation or rollback.</p>
      <button type="button" :disabled="busy" @click="perform('settle', { effectId: settleId })">I verified the outcome</button>
      <button type="button" :disabled="busy" @click="settleId = ''">Cancel</button>
    </div>
  </details>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { apiUrl } from '../api-url.ts'
import { parseWorkView, type WorkView } from '../work-alignment.ts'
const props = defineProps<{ sessionId: string; apiBase: string; canWrite: boolean }>()
const view = ref<WorkView>({ records: [], effects: [] })
const selected = ref('')
const current = computed(() => view.value.records.find(record => record.key === selected.value))
const needsAttention = computed(() => view.value.records.some(record => record.paused || record.adoption?.revision !== record.revision || record.answerReview))
const canTransition = computed(() => current.value?.checkpoint?.revision === current.value?.revision
  && !!current.value?.checkpoint && !current.value.checkpoint.inFlight.length && !current.value.checkpoint.unknown.length && !view.value.effects.length)
const inventoryFields = ['completed', 'artifacts', 'inFlight', 'unknown', 'retired'] as const
const busy = ref(false), error = ref(''), editing = ref(false)
const objective = ref(''), acceptance = ref(''), boundaries = ref(''), reason = ref('')
const change = ref('understanding'), paused = ref(false), transition = ref(''), settleId = ref('')
let expectedRevision = 0
let opened = false
let controller: AbortController | undefined
async function request(body?: object) {
  controller?.abort()
  const pending = new AbortController()
  controller = pending; busy.value = true; error.value = ''
  try {
    const response = await fetch(apiUrl(props.apiBase, `/api/sessions/${encodeURIComponent(props.sessionId)}/work`), {
      method: body ? 'POST' : 'GET', signal: AbortSignal.any([pending.signal, AbortSignal.timeout(15000)]),
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
    const data: unknown = await response.json()
    if (!response.ok) throw new Error(data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' ? data.message : 'Could not load or change work alignment.')
    const parsed = parseWorkView(data)
    if (pending.signal.aborted) return false
    view.value = parsed
    if (!parsed.records.some(record => record.key === selected.value)) selected.value = parsed.records[0]?.key ?? ''
    return true
  } catch (cause) { if (!pending.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Work alignment failed.'; return false }
  finally { if (controller === pending) busy.value = false }
}
const load = () => request()
function toggle(event: Event) { opened = (event.currentTarget as HTMLDetailsElement).open; if (opened) void load(); else controller?.abort() }
function edit() {
  const record = current.value
  expectedRevision = record?.revision ?? 0
  objective.value = record?.definition.objective ?? ''
  acceptance.value = record?.definition.acceptance.join('\n') ?? ''
  boundaries.value = record?.definition.boundaries.join('\n') ?? ''
  paused.value = record?.paused ?? false; reason.value = ''; change.value = 'understanding'; editing.value = true
}
function reviewProposal(data: unknown) {
  if (!data || typeof data !== 'object' || !('definition' in data) || !data.definition || typeof data.definition !== 'object') return
  const definition = data.definition
  if (!('objective' in definition) || typeof definition.objective !== 'string' || !('acceptance' in definition) || !Array.isArray(definition.acceptance)
    || !definition.acceptance.every(item => typeof item === 'string') || !('boundaries' in definition) || !Array.isArray(definition.boundaries)
    || !definition.boundaries.every(item => typeof item === 'string')) { error.value = 'Invalid saved proposal.'; return }
  edit()
  objective.value = definition.objective; acceptance.value = definition.acceptance.join('\n'); boundaries.value = definition.boundaries.join('\n')
  reason.value = 'Reviewing an agent proposal; no prior approval is implied.'
}
async function save() {
  if (!props.canWrite) return
  const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)
  if (await request({ action: 'update', data: {
    subject: current.value?.subject ?? { kind: 'topic', sessionId: props.sessionId },
    expectedRevision, change: change.value, reason: reason.value, paused: paused.value,
    definition: { objective: objective.value, acceptance: lines(acceptance.value), boundaries: lines(boundaries.value), evidence: current.value?.definition.evidence ?? [] },
  } })) editing.value = false
}
async function perform(action: string, data?: object) {
  if (!props.canWrite || !current.value) return
  if (await request({ action, key: current.value.key, revision: current.value.revision, data })) { transition.value = ''; settleId.value = '' }
}
watch(() => [props.apiBase, props.sessionId, props.canWrite], () => {
  controller?.abort(); view.value = { records: [], effects: [] }; selected.value = error.value = transition.value = settleId.value = ''
  editing.value = false; if (opened) void load()
})
onUnmounted(() => controller?.abort())
</script>
<style scoped>
.work-alignment { margin: 4px 16px; font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
summary { cursor: pointer; color: var(--c-text-secondary); }
p, dl { margin: 6px 0; }
dd { margin: 0 0 8px 12px; }
label { display: block; margin: 8px 0; }
textarea, select { display: block; width: 100%; box-sizing: border-box; color: var(--c-text); background: var(--c-bg-input); }
textarea { min-height: 64px; resize: vertical; }
button, select, textarea { min-height: 36px; border: 1px solid var(--c-border); padding: 4px 8px; border-radius: var(--radius-control); }
button { background: var(--c-bg-card); color: var(--c-text); cursor: pointer; }
.work-actions { display: flex; flex-wrap: wrap; gap: 6px; }
pre { white-space: pre-wrap; max-height: 260px; overflow: auto; }
[role=alert] { color: var(--c-error); }
</style>
