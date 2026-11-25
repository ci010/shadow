<template>
  <component :is="embedded ? 'section' : 'details'" v-show="!embedded || expanded" class="work-alignment" :class="{ 'is-embedded': embedded }" @toggle="toggle">
    <summary v-if="!embedded">{{ t('Shared work notes') }} <span v-if="needsReview">{{ t('— review needed') }}</span></summary>
    <div class="alignment-toolbar">
      <span class="provenance">{{ current ? (current.origin === 'human' ? t('User-defined goal') : t('Working interpretation')) : t('Shared work notes') }}</span>
      <HoverInfo :text="t('Refresh work state')" v-slot="{ triggerProps }">
        <button v-bind="triggerProps" type="button" class="refresh-state" :disabled="busy" :aria-label="busy ? t('Loading...') : t('Refresh work state')" @click="load"><span class="i-lucide-refresh-cw" aria-hidden="true" /></button>
      </HoverInfo>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <label v-if="view.records.length > 1">{{ t('Work item') }}
      <UiSelect v-model="selected" :disabled="busy">
        <option v-for="item in view.records" :key="item.key" :value="item.key">{{ item.title }}</option>
      </UiSelect>
    </label>
    <template v-if="current">
      <header class="alignment-heading">
        <h3>{{ current.title }}</h3>
        <details v-if="hasDistinctDefinition && !embedded" class="definition-disclosure">
          <summary>{{ t('Work definition') }}</summary>
          <WorkMarkdownContent class="work-definition" :text="current.definition" />
        </details>
        <WorkMarkdownContent v-else-if="hasDistinctDefinition" class="definition-body work-definition" :text="current.definition" />
        <div class="work-status" :class="`status-${current.status}`">
          <span class="status-mark" aria-hidden="true" />{{ enumLabel(current.status) }}
        </div>
      </header>
      <section v-if="current.blockedReason" class="work-blocker">
        <h4>{{ t('Blocked') }}</h4><p>{{ current.blockedReason }}</p>
      </section>
      <p v-if="current.contextChanged" class="pending-impact">{{ t('An ancestor changed. This branch has not been reassessed yet.') }}</p>
      <div class="work-people">
        <div class="person-row"><span class="field-label">{{ t('Managed by:') }}</span><HoverInfo :text="current.authority.manager || t('Unassigned')" v-slot="{ triggerProps }"><span v-bind="triggerProps" tabindex="0">{{ sessionTitle(current.authority.manager) }}</span></HoverInfo></div>
        <div class="person-row"><span class="field-label">{{ t('Assigned to') }}</span><HoverInfo :text="current.authority.executor || t('Unassigned')" v-slot="{ triggerProps }"><span v-bind="triggerProps" tabindex="0">{{ sessionTitle(current.authority.executor) }}</span></HoverInfo></div>
      </div>
      <section v-if="current.summary || current.artifacts.length || contextAssessment" class="progress-section">
        <h4>{{ t('Progress') }}</h4>
        <WorkReportContent :summary="current.summary" :artifacts="current.artifacts" :context-assessment="contextAssessment" :api-base="apiBase" />
      </section>
      <details class="technical-details">
        <summary>{{ t('Technical details') }}</summary>
        <dl><dt>{{ t('Work item') }}</dt><dd>{{ current.key }}</dd>
        </dl>
        <p class="work-note">{{ t('A shared notebook, not an execution gate. Routine updates do not wake other agents.') }}</p>
      </details>
      <form v-if="canWrite && current.contextChanged" @submit.prevent="review">
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
import WorkMarkdownContent from './WorkMarkdownContent.vue'
import WorkReportContent from './WorkReportContent.vue'
const props = defineProps<{ sessionId: string; apiBase: string; canWrite: boolean; embedded?: boolean; expanded?: boolean; revision?: number;
  project?: boolean; workKey?: string; sessionCatalog?: { sessionId: string; title: string }[] }>()
const emit = defineEmits<{ updated: []; loaded: [record: { key: string; sequence: number; status?: string }] }>()
const sessionTitle = (id: string | null) => id
  ? props.sessionCatalog?.find(session => session.sessionId === id)?.title?.trim() || `${t('Session')} · ${id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id}`
  : t('Unassigned')
const view = ref<WorkView>({ records: [], effects: [] }), selected = ref('')
const current = computed(() => view.value.records.find(record => record.key === selected.value))
const contextAssessment = computed(() => current.value?.contextChanged ? undefined : current.value?.contextAssessment)
const hasDistinctDefinition = computed(() => !!current.value && current.value.definition !== current.value.title)
const needsReview = computed(() => view.value.records.some(record => record.contextChanged))
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
    if (current.value) emit('loaded', { key: current.value.key, sequence: current.value.sequence, status: current.value.status })
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
watch(() => props.expanded, expanded => {
  if (!props.embedded) return
  opened = !!expanded
  if (opened) void load()
  else controller?.abort()
}, { immediate: true })

async function review() {
  if (!props.canWrite || !current.value?.contextChanged) return
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
.definition-body, .definition-disclosure { margin-top: 12px; }
.definition-disclosure summary { padding-block: 4px; font-size: 12px; }
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
.technical-details { border-bottom: 1px solid var(--c-border-soft); }
.technical-details > summary { padding-block: 12px; min-height: 44px; box-sizing: border-box; font-size: 12px; }
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
@media (max-width: 700px), (pointer: coarse) { button:where(:not(.ui-select)), .ui-select, .alignment-toolbar .refresh-state { min-height: 44px; } .alignment-toolbar .refresh-state { width: 44px; } .definition-disclosure summary { min-height: 44px; box-sizing: border-box; } input, textarea { font-size: 16px; } }
</style>
