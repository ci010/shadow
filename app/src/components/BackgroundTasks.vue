<template>
  <section v-if="embedded || tasks.length || error" v-show="active" class="background-tasks" :class="{ embedded }" aria-label="Background tasks" :aria-busy="loading">
    <button v-if="!embedded && tasks.length" type="button" class="background-toggle" :aria-expanded="expanded" :aria-controls="listId" @click="expanded = !expanded">
      <span class="i-lucide-terminal task-icon" aria-hidden="true" />
      <span>Background tasks</span>
      <span class="background-count" role="status">{{ loading ? 'Checking…' : `${total} running` }}</span>
      <span :class="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="task-icon" aria-hidden="true" />
    </button>
    <div v-if="error" class="background-error" role="alert">
      <span>{{ error }}</span><button type="button" class="background-retry" :disabled="loading" @click="refresh">Retry</button>
    </div>
    <p v-if="embedded && !tasks.length && !error" class="background-empty">{{ loading ? 'Checking background tasks…' : 'No background tasks running.' }}</p>
    <div v-if="tasks.length" v-show="embedded || expanded" :id="listId" class="background-list">
      <ul>
        <li v-for="task in tasks" :key="task.id">
          <span class="running-dot" aria-hidden="true" />
          <div class="background-detail">
            <code class="background-title">{{ task.title || 'Untitled task' }}</code>
            <div class="background-meta">
              <span>{{ labels[task.kind] }}</span>
              <code>bg:{{ task.id }}</code>
              <span v-if="task.status === 'cancelling'" role="status">Cancelling…</span>
              <span>Started <time :datetime="task.createdAt">{{ started(task.createdAt) }}</time></span>
            </div>
          </div>
        </li>
      </ul>
      <p v-if="total > tasks.length" class="background-limit">Showing the latest {{ tasks.length }} of {{ total }} running tasks.</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { fetchBackgroundTasks, type ActiveBackgroundTask } from '../background-tasks.ts'
import { createLiveRefresh } from '../live-refresh.ts'
import { liveProjectId, useLiveClientPool } from '../composables/useLiveClient.ts'
import { isRecord } from '../folders-sidebar.ts'

const props = defineProps<{ apiBase: string; sessionId: string; active: boolean; embedded?: boolean }>()
const emit = defineEmits<{ status: [value: { total: number; loading: boolean; error: string }] }>()
const pool = useLiveClientPool()
const listId = useId()
const tasks = ref<ActiveBackgroundTask[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const expanded = ref(false)
const labels = { process: 'Process', tool: 'Tool', subagent: 'Agent' }
let identity = ''
let refresh = () => {}
watch([total, loading, error], () => emit('status', { total: total.value, loading: loading.value, error: error.value }), { immediate: true })

function started(value: string) {
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

watch(() => [props.apiBase, props.sessionId, props.active] as const, ([base, sessionId, active], _old, onCleanup) => {
  const nextIdentity = JSON.stringify([base, sessionId])
  if (identity !== nextIdentity) {
    identity = nextIdentity
    tasks.value = []
    total.value = 0
    error.value = ''
    expanded.value = false
  }
  refresh = () => {}
  loading.value = false
  if (!active || !sessionId) return
  const snapshot = createLiveRefresh({
    load: signal => {
      loading.value = true
      return fetchBackgroundTasks(base, sessionId, signal)
    },
    apply: value => {
      tasks.value = value.tasks
      total.value = value.total
      loading.value = false
      error.value = ''
    },
    onError: cause => {
      tasks.value = []
      total.value = 0
      loading.value = false
      error.value = cause instanceof Error && cause.name !== 'TypeError' && cause.name !== 'TimeoutError' && cause.name !== 'SyntaxError'
        ? cause.message : 'Background task status is unavailable. Check Main and retry.'
    },
  })
  refresh = () => { loading.value = true; snapshot.refresh() }
  const subscription = pool.client(base).subscribe({ kind: 'sessions', projectId: liveProjectId(base) }, {
    event: envelope => {
      if (!isRecord(envelope.payload) || envelope.payload.event === 'activity'
        || (envelope.payload.sessionId !== undefined && envelope.payload.sessionId !== sessionId)) return
      refresh()
    },
    reset: () => refresh(),
  })
  const timer = setInterval(() => refresh(), 20_000)
  refresh()
  onCleanup(() => {
    clearInterval(timer)
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
.background-list { max-height: 160px; overflow: auto; border: 1px solid var(--c-border); background: var(--c-bg-soft); }
.background-list ul { list-style: none; padding: 4px 10px; margin: 0; }
.background-list li { display: flex; align-items: flex-start; gap: 9px; padding: 8px 0; }
.background-detail { flex: 1; min-width: 0; }
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
