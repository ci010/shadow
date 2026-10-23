<template>
  <section class="maintenance" :aria-label="t('Knowledge maintenance')">
    <header>
      <div><h2>{{ t('Link health') }}</h2><p>{{ t('Checked daily without an AI session. Scans never modify knowledge. Repair requires a reviewed preview and confirmation.') }}</p></div>
      <div class="actions">
        <button type="button" :disabled="busy || !!preview" @click="refresh">{{ t('Refresh report') }}</button>
        <button type="button" :disabled="busy || !!preview || status?.scanning" @click="scan">{{ scanning ? t('Scanning...') : t('Scan now') }}</button>
      </div>
    </header>
    <p v-if="loading" role="status">{{ t('Loading scan report...') }}</p>
    <p v-if="status?.scanning && !scanning" role="status">{{ t('A scan is in progress. Refresh the report shortly.') }}</p>
    <p v-if="error || status?.lastError" role="alert" class="error">{{ error || status?.lastError }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="status?.report">
      <div class="report-summary">
        <span>{{ t('Last scan:') }} {{ formatDate(status.report.scannedAt) }} · {{ status.report.entriesScanned }} {{ t('entries') }}</span>
        <button type="button" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? t('Hide findings') : t('Show findings ({length})', { length: status.report.findings.length }) }}</button>
      </div>
      <p v-if="!status.report.findings.length" class="muted">{{ t('No unresolved local references were found in this snapshot.') }}</p>
      <template v-if="expanded && status.report.findings.length">
        <label>{{ t('Show') }}
          <UiSelect v-model="filter" :aria-label="t('Filter link findings')">
            <option value="all">{{ t('All findings') }}</option>
            <option value="missing">{{ t('Confirmed missing') }}</option>
            <option value="unavailable">{{ t('Unavailable / unsafe to inspect') }}</option>
            <option value="outside-catalog">{{ t('Exists outside catalog') }}</option>
          </UiSelect>
        </label>
        <div class="findings">
          <article v-for="group in groups" :key="group.sourceId">
            <div class="source-heading">
              <button type="button" class="source-link" @click="$emit('select', group.sourceId)">{{ group.title }}</button>
              <button v-if="group.repairable" type="button" :disabled="busy || !!preview" @click="prepare(group.sourceId)">{{ t('Preview Wiki repair') }}</button>
              <span v-else class="muted">{{ t('Review only') }}</span>
            </div>
            <div v-if="filteredFindings.length > pageSize" class="pagination">
              <button type="button" :disabled="page === 0" @click="page--">{{ t('Previous findings') }}</button>
              <span>{{ page * pageSize + 1 }}–{{ Math.min((page + 1) * pageSize, filteredFindings.length) }} {{ t('of') }} {{ filteredFindings.length }}</span>
              <button type="button" :disabled="(page + 1) * pageSize >= filteredFindings.length" @click="page++">{{ t('Next findings') }}</button>
            </div>
            <code>{{ group.sourceId }}</code>
            <ul><li v-for="finding in group.findings" :key="finding.id">
              <span class="badge" :class="finding.reason">{{ reasonLabel(finding.reason) }}</span>
              <code>{{ finding.target }}</code>
              <p>{{ finding.message }}</p>
            </li></ul>
          </article>
        </div>
        <p v-if="!groups.length" class="muted">{{ t('No findings match this filter.') }}</p>
      </template>
    </template>
    <p v-else-if="!loading" class="muted">{{ t('No saved report yet. Scan now or wait for the scheduled check.') }}</p>
    <KnowledgeRepairDialog v-if="preview" :api-base="apiBase" :project-id="projectId" :preview="preview"
      @close="preview = undefined" @applied="applied" />
  </section>
</template>

<script setup lang="ts">
import UiSelect from './UiSelect.vue'
import { t, formatDateTime } from '../i18n.ts'
import { computed, onUnmounted, ref, watch } from 'vue'
import { createKnowledgeMaintenanceClient, type KnowledgeMaintenanceFinding, type KnowledgeMaintenanceStatus, type KnowledgeRepairPreview } from '../knowledge-maintenance.ts'
import KnowledgeRepairDialog from './KnowledgeRepairDialog.vue'
const props = withDefaults(defineProps<{ apiBase: string; projectId: string; revision?: number; active?: boolean }>(), { active: true })
const emit = defineEmits<{ select: [id: string]; changed: [id: string] }>()
const status = ref<KnowledgeMaintenanceStatus>()
const preview = ref<KnowledgeRepairPreview>()
const loading = ref(false)
const scanning = ref(false)
const preparing = ref(false)
const busy = computed(() => loading.value || scanning.value || preparing.value)
const expanded = ref(false)
const filter = ref<'all' | KnowledgeMaintenanceFinding['reason']>('all')
const page = ref(0)
const pageSize = 100
const error = ref('')
const notice = ref('')
let request: AbortController | undefined
interface FindingGroup {
  sourceId: string
  title: string
  repairable: boolean
  findings: KnowledgeMaintenanceFinding[]
}
const groups = computed(() => {
  const result = new Map<string, FindingGroup>()
  for (const finding of filteredFindings.value.slice(page.value * pageSize, (page.value + 1) * pageSize)) {
    const group: FindingGroup = result.get(finding.sourceId) ?? { sourceId: finding.sourceId, title: finding.sourceTitle, repairable: false, findings: [] }
    group.findings.push(finding)
    group.repairable ||= finding.repairable
    result.set(finding.sourceId, group)
  }
  return [...result.values()]
})
const filteredFindings = computed(() => (status.value?.report?.findings ?? [])
  .filter(finding => filter.value === 'all' || finding.reason === filter.value))
watch(() => [filter.value, status.value?.report?.id], () => { page.value = 0 })
const reasonLabel = (reason: KnowledgeMaintenanceFinding['reason']) => reason === 'missing' ? t('Confirmed missing') : reason === 'unavailable' ? t('Unavailable / unverified') : t('Exists outside catalog')
const formatDate = (value: string) => formatDateTime(new Date(value))
function begin() {
  request?.abort()
  request = new AbortController()
  error.value = ''
  return request
}
async function refresh() {
  if (!props.active) return
  const current = begin()
  loading.value = true
  try {
    const result = await createKnowledgeMaintenanceClient(props.apiBase).status(current.signal)
    if (!current.signal.aborted) status.value = result
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not load the maintenance report.')
  } finally { if (!current.signal.aborted) loading.value = false }
}
async function scan() {
  if (!props.active || busy.value) return
  const current = begin()
  scanning.value = true
  try {
    const client = createKnowledgeMaintenanceClient(props.apiBase)
    const report = await client.scan(current.signal)
    if (current.signal.aborted) return
    status.value = { intervalMs: status.value?.intervalMs ?? 86_400_000, scanning: false, report }
    expanded.value = true
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : t('The scan failed. The previous report may be stale.')
  } finally { if (!current.signal.aborted) scanning.value = false }
}
async function prepare(sourceId: string) {
  if (!props.active || busy.value || !status.value?.report) return
  const current = begin()
  preparing.value = true
  try {
    const result = await createKnowledgeMaintenanceClient(props.apiBase).preview(status.value.report.id, sourceId, current.signal)
    if (!current.signal.aborted) preview.value = result
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not prepare a repair preview.')
  } finally { if (!current.signal.aborted) preparing.value = false }
}
async function applied(id: string) {
  preview.value = undefined
  notice.value = t('Repair applied to the selected Wiki file. Pages and historical references were preserved.')
  if (status.value) status.value = { ...status.value, report: null }
  emit('changed', id)
  await scan()
}
watch(() => [props.apiBase, props.revision, props.active] as const, ([base, revision, active], previous) => {
  request?.abort()
  preview.value = undefined
  if (base !== previous?.[0] || revision !== previous?.[1]) {
    status.value = undefined
    notice.value = ''
  }
  loading.value = false
  scanning.value = false
  preparing.value = false
  if (active) void refresh()
}, { immediate: true })
onUnmounted(() => request?.abort())
</script>

<style scoped>
.maintenance { padding: 16px; margin-bottom: 20px; border: 1px solid var(--c-border); background: var(--c-bg-card); border-radius: var(--radius-control); }
header, .actions, .report-summary, .source-heading, .pagination { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
h2 { margin: 0; font-size: 15px; }
p, .report-summary, label, .muted { font-size: 12px; color: var(--c-text-secondary); line-height: 1.6; }
button:where(:not(.ui-select)), .ui-select { font: inherit; font-size: 12px; padding: 7px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); cursor: pointer; }
button:where(:not(.ui-select)):disabled { opacity: .5; cursor: not-allowed; }
button:where(:not(.ui-select)):focus-visible, .ui-select:is(:focus-visible, :has(:focus-visible)) { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.report-summary { border-top: 1px solid var(--c-border); padding-top: 10px; margin-top: 10px; }
.findings { max-height: 440px; overflow: auto; margin-top: 12px; }
article { border-top: 1px solid var(--c-border); padding: 12px 0; }
.source-link { border: 0; padding-left: 0; color: var(--c-blue); text-align: left; }
code { font-size: 12px; overflow-wrap: anywhere; }
ul { margin: 8px 0; padding-left: 20px; }
li { margin: 8px 0; }
li p { margin: 4px 0; }
.badge { margin-right: 8px; font-size: 11px; color: var(--c-text-secondary); }
.badge.missing, .error { color: var(--c-error); }
.badge.unavailable { color: var(--c-warn); }
.pagination { font-size: 12px; color: var(--c-text-secondary); margin-top: 12px; }
</style>
