<template>
  <section v-if="embedded || visibleTasks.length || error" v-show="active" class="background-tasks" :class="{ embedded }" :aria-label="t('Background tasks')" :aria-busy="loading">
    <button v-if="!embedded && visibleTasks.length" type="button" class="background-toggle" :aria-expanded="expanded" :aria-controls="listId" @click="expanded = !expanded">
      <span class="i-lucide-terminal task-icon" aria-hidden="true" />
      <span>{{ t('Background tasks') }}</span>
      <span class="background-count" role="status">{{ loading ? t('Checking…') : t('{total} running', { total: total }) }}</span>
      <span :class="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="task-icon" aria-hidden="true" />
    </button>
    <div v-if="error" class="background-error" role="alert">
      <span>{{ error }}</span><button type="button" class="background-retry" :disabled="loading" @click="refresh">{{ t('Retry') }}</button>
    </div>
    <p v-if="embedded && !visibleTasks.length && !error" class="background-empty">{{ loading ? t('Checking background tasks…') : t('No background tasks running.') }}</p>
    <div v-if="visibleTasks.length" v-show="embedded || expanded" :id="listId" class="background-list">
      <ul>
        <li v-for="task in visibleTasks" :key="task.id">
          <span v-if="tasks.some(item => item.id === task.id)" class="running-dot" aria-hidden="true" />
          <div class="background-detail">
            <button v-if="task.kind === 'process'" type="button" class="process-toggle background-title" :aria-expanded="selected?.id === task.id && logsOpen" :aria-controls="`${listId}-output`" @click="inspect(task)">{{ task.title || t('Untitled task') }} <span aria-hidden="true">{{ selected?.id === task.id && logsOpen ? '−' : '+' }}</span></button>
            <code v-else class="background-title">{{ task.title || t('Untitled task') }}</code>
            <div class="background-meta">
              <span>{{ labels[task.kind] }}</span>
              <span v-if="!tasks.some(item => item.id === task.id)">{{ t('Last inspected process (retained)') }}</span>
              <code>bg:{{ task.id }}</code>
              <span v-if="task.status === 'cancelling'" role="status">{{ t('Cancelling…') }}</span>
              <span>{{ t('Started') }} <time :datetime="task.createdAt">{{ started(task.createdAt) }}</time></span>
            </div>
            <ProcessOutput v-if="selected?.id === task.id" v-show="logsOpen" :id="`${listId}-output`" :api-base="apiBase" :session-id="sessionId" :task-id="task.id" :active="active && logsOpen && (embedded || expanded)" />
          </div>
        </li>
      </ul>
      <p v-if="total > visibleTasks.length" class="background-limit">{{ t('Showing the latest {shown} of {total} running tasks.', { shown: visibleTasks.length, total }) }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { t, formatDateTime } from '../i18n.ts'
import ProcessOutput from './ProcessOutput.vue'
import { computed, ref, useId, watch } from 'vue'
import { BackgroundSessionNotFoundError, fetchBackgroundTasks, type ActiveBackgroundTask } from '../background-tasks.ts'
import { createLiveRefresh } from '../live-refresh.ts'
import { liveProjectId, useLiveClientPool } from '../composables/useLiveClient.ts'
import type { LiveStatus } from '../live-client.ts'
import { isRecord } from '../folders-sidebar.ts'

const props = defineProps<{ apiBase: string; sessionId: string; active: boolean; embedded?: boolean }>()
const emit = defineEmits<{ status: [value: { total: number; loading: boolean; error: string }] }>()
const pool = useLiveClientPool()
const listId = useId()
const tasks = ref<ActiveBackgroundTask[]>([])
// Retain the last inspected process even after the active inventory drops it.
// A single bounded snapshot is kept; switching conversation disposes it.
const selected = ref<ActiveBackgroundTask>()
const logsOpen = ref(false)
const visibleTasks = computed(() => selected.value && !tasks.value.some(task => task.id === selected.value!.id)
  ? [...tasks.value, selected.value] : tasks.value)
function inspect(task: ActiveBackgroundTask) {
  logsOpen.value = selected.value?.id === task.id ? !logsOpen.value : true
  selected.value = task
}
const total = ref(0)
const loading = ref(false)
const error = ref('')
const expanded = ref(false)
const labels = { get process() { return t('Process') }, get tool() { return t('Tool') }, get subagent() { return t('Agent') } }
let identity = ''
// Keep terminal absence across visibility toggles, but permit explicit retry
// (including a draft that has since been persisted by Main).
let sessionMissing = false
let completedTurn = ''
let refresh = () => {}
watch([total, loading, error], () => emit('status', { total: total.value, loading: loading.value, error: error.value }), { immediate: true })

function started(value: string) {
  return formatDateTime(new Date(value), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

watch(() => [props.apiBase, props.sessionId, props.active] as const, ([base, sessionId, active], _old, onCleanup) => {
  const nextIdentity = JSON.stringify([base, sessionId])
  if (identity !== nextIdentity) {
    identity = nextIdentity
    sessionMissing = false
    completedTurn = ''
    tasks.value = []
    selected.value = undefined
    logsOpen.value = false
    total.value = 0
    error.value = ''
    expanded.value = false
  }
  refresh = () => {}
  loading.value = false
  if (!active || !sessionId) return
  const snapshot = createLiveRefresh({
    load: async signal => {
      // A coalesced invalidation may execute after the page was hidden.
      if (document.hidden) return null
      if (sessionMissing) throw new BackgroundSessionNotFoundError(t('This conversation is no longer available.'))
      loading.value = true
      const turnAtRead = completedTurn
      try { return await fetchBackgroundTasks(base, sessionId, signal) } catch (cause) {
        // A completed turn may have persisted the draft while this read was in flight.
        if (cause instanceof BackgroundSessionNotFoundError && turnAtRead !== completedTurn) throw new Error(cause.message)
        throw cause
      }
    },
    apply: value => {
      if (!value) { loading.value = false; return }
      tasks.value = value.tasks
      total.value = value.total
      loading.value = false
      error.value = ''
    },
    onError: cause => {
      if (cause instanceof BackgroundSessionNotFoundError) sessionMissing = true
      tasks.value = []
      total.value = 0
      loading.value = false
      error.value = cause instanceof Error && cause.name !== 'TypeError' && cause.name !== 'TimeoutError' && cause.name !== 'SyntaxError'
        ? cause.message : t('Background task status is unavailable. Check Main and retry.')
    },
  })
  const autoRefresh = () => { if (!sessionMissing && !document.hidden) { loading.value = true; snapshot.refresh() } }
  refresh = () => { sessionMissing = false; autoRefresh() }
  const subscription = pool.client(base).subscribe({ kind: 'sessions', projectId: liveProjectId(base) }, {
    event: envelope => {
      if (!isRecord(envelope.payload) || envelope.payload.event === 'activity'
        || (envelope.payload.sessionId !== undefined && envelope.payload.sessionId !== sessionId)) return
      if (envelope.payload.sessionId === sessionId && typeof envelope.payload.completedTurnId === 'string'
        && envelope.payload.completedTurnId && envelope.payload.completedTurnId !== completedTurn) {
        completedTurn = envelope.payload.completedTurnId
        sessionMissing = false
      }
      autoRefresh()
    },
    reset: autoRefresh,
    reconnected: autoRefresh,
  })
  let phase: LiveStatus['phase'] = 'connecting'
  const stopHost = pool.observeHost(base, status => { phase = status.phase })
  const timer = setInterval(() => {
    if (phase === 'connecting' || phase === 'reconnecting' || phase === 'error') autoRefresh()
  }, 30_000)
  const visibilityChanged = () => { if (!document.hidden) autoRefresh() }
  document.addEventListener('visibilitychange', visibilityChanged)
  autoRefresh()
  onCleanup(() => {
    clearInterval(timer)
    stopHost()
    document.removeEventListener('visibilitychange', visibilityChanged)
    subscription.close()
    snapshot.dispose()
  })
}, { immediate: true })
</script>

<style scoped>
.background-tasks { margin-bottom: 8px; min-width: 0; color: var(--c-text-secondary); font-size: 13px; }
.background-tasks.embedded { margin: 0; }
.background-empty { margin: 0; padding: 8px 0; }
.embedded .background-list { max-height: none; border: 0; background: transparent; }
.background-toggle { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; padding: 6px 10px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.background-toggle:hover, .background-retry:hover { background: var(--c-bg-muted); color: var(--c-text); }
.background-toggle:focus-visible, .background-retry:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.task-icon { width: 16px; height: 16px; flex-shrink: 0; }
.background-count { flex: 1; text-align: right; white-space: nowrap; }
.background-list { max-height: 520px; overflow: auto; border: 1px solid var(--c-border); background: var(--c-bg-soft); }
.background-list ul { list-style: none; padding: 4px 10px; margin: 0; }
.background-list li { display: flex; align-items: flex-start; gap: 9px; padding: 8px 0; }
.background-detail { flex: 1; min-width: 0; }
.process-toggle { width: 100%; padding: 0; border: 0; background: transparent; text-align: left; cursor: pointer; font-family: inherit; }
.process-toggle:focus-visible { outline: 2px solid var(--c-blue); }
.background-title { display: block; color: var(--c-text); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.background-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; font-size: 12px; }
.running-dot { width: 6px; height: 6px; margin-top: 6px; background: var(--c-text-secondary); flex-shrink: 0; }
.background-error { display: flex; align-items: center; gap: 10px; padding: 6px 10px; overflow-wrap: anywhere; }
.background-error > span { flex: 1; min-width: 0; }
.background-retry { flex-shrink: 0; min-height: 32px; padding: 4px 8px; border: 1px solid var(--c-border); background: var(--c-bg-soft); color: var(--c-text); font: inherit; cursor: pointer; }
.background-retry:disabled { opacity: .6; cursor: wait; }
.background-limit { margin: 0; padding: 6px 10px 10px; }
@media (max-width: 700px) { .background-toggle, .background-retry { min-height: 44px; } }
</style>
