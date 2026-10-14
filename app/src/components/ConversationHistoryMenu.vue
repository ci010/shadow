<template>
  <ComposerPopover :key="contextKey" :label="t('Conversation history')" :width="440" @opened="opened">
    <template #trigger><span class="history-ellipsis" aria-hidden="true">···</span></template>
    <template #default="{ close }">
      <div class="conversation-history" :aria-busy="loading">
        <strong>{{ t(automation ? 'Execution history' : 'Conversation history') }}<template v-if="history"> · {{ history.total }}</template></strong>
        <template v-if="history">
          <div class="history-toolbar"><UiSelect v-model="scope" :aria-label="t('Scope')"><option value="all">{{ t('All') }}</option><option value="full">{{ t('Full') }}</option><option value="delta">{{ t('Delta') }}</option></UiSelect><span>{{ t('Showing {count} loaded runs', { count: filteredRuns.length }) }}</span></div>
          <button v-for="item in visibleRuns" :key="item.id" type="button" class="history-row" :class="{ selected: item.sessionId === sessionId }" :aria-current="item.sessionId === sessionId ? 'true' : undefined" @click="automation?.select?.(item.sessionId); close()">
            <span class="run-title">{{ item.title || automation?.automation.value?.name }}</span><span class="run-status" :class="item.status">{{ statusLabel(item.status) }}</span><time :datetime="item.startedAt" :title="fullDate(item.startedAt)">{{ shortDate(item.startedAt) }}</time>
            <small v-if="item.sessionId === history.runs[0]?.sessionId">{{ t('Current session') }}</small>
            <small v-if="item.organization">{{ t(item.scope === 'full' ? 'Full' : 'Delta') }} · {{ item.organization.coveredCount }}/{{ item.organization.manifestCount }} {{ t('Coverage') }} · {{ t(item.organization.status === 'partial' ? 'Partial' : item.organization.status === 'completed' ? 'Completed' : 'Running') }}</small>
          </button>
          <p v-if="!filteredRuns.length && !loading">{{ t('No loaded runs match this scope.') }}</p>
        </template>
        <template v-else>
          <button v-for="item in visibleSegments" :key="item.id ?? 'current'" type="button" class="history-row" :class="{ selected: item.id === physicalId }" :aria-current="item.id === physicalId ? 'true' : undefined" @click="emit('select', item.id, segments.slice(0, segments.indexOf(item)).map(segment => segment.id)); close()">
            <span class="run-title">{{ item.id ? (item.data.name || item.id) : t('Current session') }}</span>
            <small v-if="item.id">{{ item.id }}</small>
          </button>
        </template>
        <p v-if="loading" role="status">{{ t('Loading conversation…') }}</p>
        <p v-if="error" role="alert">{{ error }}</p>
        <button v-if="error" class="btn btn-sm" type="button" :disabled="loading" @click="retry">{{ t('Retry') }}</button>
        <div v-if="count > pageSize" class="history-pages"><button class="btn btn-sm" type="button" :disabled="page === 0" @click="page--">{{ t('Previous') }}</button><span>{{ page + 1 }} / {{ Math.ceil(count / pageSize) }}</span><button class="btn btn-sm" type="button" :disabled="(page + 1) * pageSize >= count" @click="page++">{{ t('Next') }}</button></div>
        <button v-if="history && history.nextOffset < history.total" class="btn btn-sm" type="button" :disabled="loading" @click="automation?.loadMore?.()">{{ t('Load more') }}</button>
      </div>
    </template>
  </ComposerPopover>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { t, formatDateTime } from '../i18n.ts'
import type { AutomationConversation } from '../composables/useAutomationConversation.ts'
import { loadConversationSearchHistory, type ConversationSearchSegment } from '../conversation-search.ts'
import ComposerPopover from './ComposerPopover.vue'
import UiSelect from './UiSelect.vue'
const props = defineProps<{ apiBase: string; sessionId: string; physicalId: string | null; automation?: AutomationConversation }>()
const emit = defineEmits<{ select: [id: string | null, newer: (string | null)[]] }>()
const contextKey = computed(() => JSON.stringify([props.apiBase, props.automation ? null : props.sessionId, props.automation?.automation.value?.id]))
const history = computed(() => props.automation?.history)
const scope = ref<'all' | 'full' | 'delta'>('all')
const page = ref(0), pageSize = 6
const segments = ref<ConversationSearchSegment[]>([])
const physicalLoading = ref(false), physicalError = ref('')
const loading = computed(() => history.value?.loading ?? physicalLoading.value)
const error = computed(() => props.automation?.historyError.value || physicalError.value)
const filteredRuns = computed(() => (history.value?.runs ?? []).filter(run => scope.value === 'all' || run.scope === scope.value))
const count = computed(() => history.value ? filteredRuns.value.length : segments.value.length)
const visibleRuns = computed(() => filteredRuns.value.slice(page.value * pageSize, (page.value + 1) * pageSize))
const visibleSegments = computed(() => segments.value.slice(page.value * pageSize, (page.value + 1) * pageSize))
let request: AbortController | undefined
watch(contextKey, () => { request?.abort(); segments.value = []; physicalError.value = ''; physicalLoading.value = false; page.value = 0; scope.value = 'all' })
watch(scope, () => { page.value = 0 })
watch(count, value => { page.value = Math.min(page.value, Math.max(0, Math.ceil(value / pageSize) - 1)) })
async function load() {
  request?.abort()
  const controller = request = new AbortController()
  physicalLoading.value = true; physicalError.value = ''
  try {
    const result = await loadConversationSearchHistory(props.apiBase, props.sessionId, controller.signal)
    if (!controller.signal.aborted) {
      segments.value = result.reverse()
      page.value = Math.max(0, Math.floor(segments.value.findIndex(segment => segment.id === props.physicalId) / pageSize))
    }
  } catch (cause) {
    if (!controller.signal.aborted) physicalError.value = cause instanceof Error ? cause.message : String(cause)
  } finally { if (request === controller) physicalLoading.value = false }
}
function opened() {
  if (!props.automation) void load()
  const index = history.value ? filteredRuns.value.findIndex(run => run.sessionId === props.sessionId) : segments.value.findIndex(segment => segment.id === props.physicalId)
  page.value = Math.max(0, Math.floor(index / pageSize))
}
function retry() { if (props.automation) props.automation.retry(); else void load() }
onUnmounted(() => request?.abort())
const statusLabel = (status: string) => t(status === 'running' ? 'Running' : status === 'completed' ? 'Completed' : status === 'failed' ? 'Failed' : status === 'cancelled' ? 'Cancelled' : 'Status unknown')
const shortDate = (value: string) => formatDateTime(new Date(value), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const fullDate = (value: string) => formatDateTime(new Date(value), { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })
</script>

<style scoped>
.conversation-history { display: flex; flex-direction: column; gap: 6px; font-size: 12px; min-width: 0; }
.history-ellipsis { font-size: 22px; line-height: 20px; letter-spacing: 2px; }
.history-toolbar, .history-pages { display: flex; gap: 12px; align-items: center; padding: 4px 0; color: var(--c-text-secondary); }
.history-toolbar .ui-select { width: 110px; }
.history-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; width: 100%; align-items: center; gap: 4px 12px; min-height: 36px; padding: 8px; font: inherit; color: var(--c-text); background: transparent; border: 0; border-radius: var(--radius-control); text-align: start; cursor: pointer; }
.history-row:hover { background: var(--c-bg-muted); } .history-row.selected { background: var(--c-selection-bg); color: var(--c-primary); }
.history-row:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.run-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; } .run-status { padding: 1px 5px; background: var(--c-bg-muted); color: var(--c-text-secondary); }
.run-status.failed { color: var(--c-error); background: var(--c-error-bg); } .run-status.completed { color: var(--c-success); background: var(--c-success-bg); }
.history-row time, .history-row small { color: var(--c-text-secondary); font-variant-numeric: tabular-nums; grid-column: 1 / -1; overflow-wrap: anywhere; }
@media (max-width: 700px), (pointer: coarse) { .history-row { min-height: 44px; } }
</style>
