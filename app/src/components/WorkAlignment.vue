<template>
  <component :is="embedded ? 'section' : 'details'" v-show="!embedded || expanded" class="work-alignment" :class="{ 'is-embedded': embedded }" @toggle="toggle">
    <summary v-if="!embedded">{{ t('Shared work notes') }} <span v-if="needsAttention">{{ t('— review needed') }}</span></summary>
    <div class="alignment-toolbar">
      <span class="provenance">{{ current ? (current.origin === 'human' ? t('User-defined goal') : t('Working interpretation')) : t('Shared work notes') }}</span>
      <HoverInfo :text="t('Refresh work state')" v-slot="{ triggerProps }">
        <button v-bind="triggerProps" type="button" class="refresh-state" :disabled="busy" :aria-label="busy ? t('Loading...') : t('Refresh work state')" @click="load"><span class="i-lucide-refresh-cw" aria-hidden="true" /></button>
      </HoverInfo>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <label v-if="view.records.length > 1">{{ t('Work item') }}
      <UiSelect v-model="selected" :disabled="busy">
        <option v-for="item in view.records" :key="item.key" :value="item.key">{{ item.workflow?.title || item.key }}</option>
      </UiSelect>
    </label>
    <template v-if="current">
      <header class="alignment-heading">
        <h3>{{ current.workflow?.title || current.definition.objective }}</h3>
        <details v-if="hasDistinctObjective && current.definition.objective.length > 240" class="long-objective">
          <summary>{{ t('Goal') }}<span class="objective-preview">{{ current.definition.objective }}</span></summary>
          <p class="work-objective">{{ current.definition.objective }}</p>
        </details>
        <p v-else-if="hasDistinctObjective" class="work-objective">{{ current.definition.objective }}</p>
        <div v-if="current.workflow" class="work-status" :class="`status-${current.workflow.status}`">
          <span class="status-mark" aria-hidden="true" />{{ enumLabel(current.workflow.status) }}
        </div>
      </header>
      <section v-if="current.workflow?.blockedReason" class="work-blocker">
        <h4>{{ t('Blocked') }}</h4><p>{{ current.workflow.blockedReason }}</p>
      </section>
      <p v-if="current.notes?.relation">{{ relationLabel(current.notes.relation.kind) }}: {{ current.notes.relation.reason }}</p>
      <p v-if="current.contextChanged" class="pending-impact">{{ t('An ancestor changed. This branch has not been reassessed yet.') }}</p>
      <p v-if="current.notes?.attention && !current.notes.attention.reviewed" class="pending-impact">
        <strong>{{ t('Impact not yet reviewed') }}</strong> {{ current.notes.attention.summary }}
      </p>
      <div class="work-people">
        <div class="person-row"><span class="field-label">{{ t('Managed by:') }}</span><HoverInfo :text="current.authority.manager || t('Unassigned')" v-slot="{ triggerProps }"><span v-bind="triggerProps" tabindex="0">{{ sessionTitle(current.authority.manager) }}</span></HoverInfo></div>
        <div class="person-row"><span class="field-label">{{ t('Assigned to') }}</span><HoverInfo :text="current.authority.executor || t('Unassigned')" v-slot="{ triggerProps }"><span v-bind="triggerProps" tabindex="0">{{ sessionTitle(current.authority.executor) }}</span></HoverInfo></div>
      </div>
      <section v-if="current.notes" class="progress-section">
        <h4>{{ t('Progress') }}</h4>
        <WorkNoteContent :notes="current.notes" :api-base="apiBase" />
      </section>
      <div class="work-criteria">
        <details v-if="current.definition.acceptance.length">
          <summary>{{ t('Acceptance criteria') }}<span class="item-count">{{ current.definition.acceptance.length }}</span></summary>
          <ul><li v-for="(item, index) in current.definition.acceptance" :key="index">{{ item }}</li></ul>
        </details>
        <details v-if="current.definition.boundaries.length">
          <summary>{{ t('Work boundaries') }}<span class="item-count">{{ current.definition.boundaries.length }}</span></summary>
          <ul><li v-for="(item, index) in current.definition.boundaries" :key="index">{{ item }}</li></ul>
        </details>
      </div>
      <details class="technical-details">
        <summary>{{ t('Technical details') }}</summary>
        <dl><dt>{{ t('Work item') }}</dt><dd>{{ current.key }}</dd>
        </dl>
        <p class="work-note">{{ t('A shared notebook, not an execution gate. Routine updates do not wake other agents.') }}</p>
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
  </component>
</template>
<script setup lang="ts">
import UiSelect from './UiSelect.vue'
import HoverInfo from './HoverInfo.vue'
import { computed, onUnmounted, ref, watch } from 'vue'
import { enumLabel } from '../display-labels.ts'
import { t } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import { parseWorkView, type WorkView } from '../work-alignment.ts'
import { relationLabel } from '../project-work.ts'
import WorkNoteContent from './WorkNoteContent.vue'
const props = defineProps<{ sessionId: string; apiBase: string; canWrite: boolean; embedded?: boolean; expanded?: boolean; revision?: number;
  project?: boolean; workKey?: string; sessionCatalog?: { sessionId: string; title: string }[] }>()
const emit = defineEmits<{ attention: [needed: boolean]; updated: []; loaded: [record: { key: string; sequence: number; status?: string }] }>()
const sessionTitle = (id: string | null) => id
  ? props.sessionCatalog?.find(session => session.sessionId === id)?.title?.trim() || `${t('Session')} · ${id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id}`
  : t('Unassigned')
const view = ref<WorkView>({ records: [], effects: [] }), selected = ref('')
const current = computed(() => view.value.records.find(record => record.key === selected.value))
const hasDistinctObjective = computed(() => {
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')
  return !!current.value?.workflow && normalize(current.value.workflow.title) !== normalize(current.value.definition.objective)
})
const needsAttention = computed(() => view.value.records.some(record => record.contextChanged || record.notes?.attention && !record.notes.attention.reviewed))
const busy = ref(false), readError = ref(''), actionError = ref(''), conclusion = ref('')
const error = computed(() => actionError.value || readError.value)
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
    if (current.value) emit('loaded', { key: current.value.key, sequence: current.value.sequence, status: current.value.workflow?.status })
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
watch(() => props.expanded, expanded => {
  if (!props.embedded) return
  opened = !!expanded
  if (opened) void load()
  else controller?.abort()
}, { immediate: true })

async function review() {
  if (!props.canWrite || !current.value) return
  if (await request({ action: 'review', key: current.value.key, version: reviewVersion.value ?? current.value.sequence,
    data: { conclusion: conclusion.value } })) { conclusion.value = ''; reviewVersion.value = undefined }
}
watch(() => [props.apiBase, props.sessionId, props.canWrite, props.workKey], () => {
  controller?.abort(); view.value = { records: [], effects: [] }; selected.value = readError.value = actionError.value = ''
  conclusion.value = ''; reviewVersion.value = undefined
  if (opened) void load()
})
onUnmounted(() => controller?.abort())
</script>
<style scoped>
.work-alignment { margin: 4px 16px; font-size: 13px; line-height: 1.6; min-width: 0; overflow-wrap: anywhere; }
.work-alignment.is-embedded { margin: 0; }
summary { cursor: pointer; color: var(--c-text-secondary); }
h3 { font-size: 18px; font-weight: 600; line-height: 1.4; margin: 0; letter-spacing: -.015em; }
h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--c-text-secondary); }
.alignment-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.alignment-toolbar .refresh-state { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; width: 32px; padding: 6px; border-color: transparent; background: transparent; }
.refresh-state span { display: inline-block; width: 15px; height: 15px; flex-shrink: 0; }
.alignment-heading { margin-bottom: 20px; }
.work-objective { color: var(--c-text-body); max-width: 65ch; margin-top: 12px; }
.long-objective { margin-top: 12px; }
.long-objective summary { padding-block: 4px; font-size: 12px; }
.objective-preview { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin-top: 6px; font-size: 13px; color: var(--c-text-body); }
.long-objective[open] .objective-preview { display: none; }
.work-status { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; font-size: 12px; color: var(--c-text-secondary); }
.status-mark { width: 6px; height: 6px; background: currentColor; }
.status-blocked { color: var(--c-warn); }
.status-done { color: var(--c-success); }
.work-blocker { margin-bottom: 20px; padding: 12px; background: var(--c-warn-bg); }
.work-blocker h4 { color: var(--c-warn); }
.work-blocker p { margin: 0; color: var(--c-text-body); }
.work-people { display: grid; gap: 8px; padding-block: 16px; border-block: 1px solid var(--c-border-soft); }
.person-row, label.person-row { display: grid; grid-template-columns: minmax(72px, auto) minmax(0, 1fr); align-items: center; gap: 12px; margin: 0; font-size: 12px; }
.field-label { color: var(--c-text-secondary); }
.person-row [tabindex]:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.progress-section { margin-block: 24px; }
.work-criteria > details, .technical-details { border-bottom: 1px solid var(--c-border-soft); }
.work-criteria summary, .technical-details > summary { padding-block: 12px; min-height: 44px; box-sizing: border-box; font-size: 12px; }
.item-count { margin-left: 8px; color: var(--c-text-muted); font-weight: 400; font-variant-numeric: tabular-nums; }
ul { padding-left: 20px; margin: 0 0 16px; }
li { white-space: pre-wrap; }
li + li { margin-top: 8px; }
.technical-details dl { margin: 0 0 12px; font-size: 12px; }
.technical-details dt { color: var(--c-text-secondary); margin-top: 8px; }
.technical-details dd { margin: 2px 0 0; font-family: var(--font-mono, monospace); user-select: text; }
.technical-details .work-note { margin-bottom: 16px; }
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
form { margin-block: 20px; padding-block: 12px; border-block: 1px solid var(--c-border); }
[role=alert] { color: var(--c-error); }
@media (max-width: 700px), (pointer: coarse) { button:where(:not(.ui-select)), .ui-select, .alignment-toolbar .refresh-state { min-height: 44px; } .alignment-toolbar .refresh-state { width: 44px; } .long-objective summary { min-height: 44px; box-sizing: border-box; } input, textarea { font-size: 16px; } }
</style>
