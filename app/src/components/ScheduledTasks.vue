<template>
  <section :aria-label="t('Scheduled tasks')" :aria-busy="loading" class="scheduled-tasks">
    <p v-if="error" role="alert">{{ error }} <button type="button" @click="refresh">{{ t('Retry') }}</button></p>
    <p v-else-if="!tasks.length">{{ loading ? t('Checking…') : t('No scheduled tasks.') }}</p>
    <article v-for="task in tasks" :key="task.id">
      <strong>{{ task.name }}</strong>
      <p v-if="task.task && task.task !== task.name">{{ task.task }}</p>
      <p><span>{{ t('Schedule') }}: </span><code>{{ task.schedule }}</code></p>
      <p v-if="!task.enabled">{{ t('Disabled') }}</p>
      <p v-else>{{ t('Next run') }}: <time v-if="task.nextRun" :datetime="task.nextRun">{{ formatDateTime(new Date(task.nextRun), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }) }}</time><span v-else>{{ t('Unavailable') }}</span></p>
    </article>
  </section>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import { t, formatDateTime } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import { isRecord } from '../folders-sidebar.ts'
import { createLiveRefresh } from '../live-refresh.ts'
import { createInitialLiveSnapshot } from '../initial-live-snapshot.ts'
import { liveProjectId, useLiveClientPool } from '../composables/useLiveClient.ts'
interface ScheduledTask { id: string; name: string; task: string; schedule: string; enabled: boolean; nextRun: string | null }
const props = defineProps<{ apiBase: string; sessionId: string; active: boolean }>()
const emit = defineEmits<{ status: [value: { total: number; error: string }] }>()
const pool = useLiveClientPool()
const tasks = ref<ScheduledTask[]>([])
const error = ref('')
const loading = ref(false)
let identity = ''
let refresh = () => {}
watch([tasks, error], () => emit('status', { total: tasks.value.length, error: error.value }), { immediate: true })
watch(() => [props.apiBase, props.sessionId, props.active] as const, ([base, sessionId, active], _old, onCleanup) => {
  const nextIdentity = JSON.stringify([base, sessionId])
  if (identity !== nextIdentity) {
    identity = nextIdentity
    tasks.value = []
    error.value = ''
  }
  refresh = () => {}
  loading.value = false
  if (!active || !sessionId) return
  const snapshot = createLiveRefresh({
    load: async signal => {
      const response = await fetch(apiUrl(base, `/api/sessions/${encodeURIComponent(sessionId)}/scheduled-tasks`), { signal, cache: 'no-store' })
      if (!response.ok) throw new Error(t('Scheduled tasks are unavailable. Retry to reconnect.'))
      const value: unknown = await response.json()
      if (!isRecord(value) || value.sessionId !== sessionId || !Array.isArray(value.tasks)
        || !value.tasks.every(task => isRecord(task) && typeof task.id === 'string' && typeof task.name === 'string'
          && typeof task.task === 'string' && typeof task.schedule === 'string' && typeof task.enabled === 'boolean'
          && (task.nextRun === null || typeof task.nextRun === 'string' && Number.isFinite(Date.parse(task.nextRun))))) throw new Error(t('Invalid scheduled task data.'))
      return value.tasks as ScheduledTask[]
    },
    apply: value => { tasks.value = value; error.value = ''; loading.value = false },
    onError: () => { error.value = t('Scheduled tasks are unavailable. Retry to reconnect.'); loading.value = false },
  })
  const autoRefresh = () => { if (!document.hidden) { loading.value = true; snapshot.refresh() } }
  refresh = autoRefresh
  const initial = createInitialLiveSnapshot({ refresh: autoRefresh })
  const subscription = pool.client(base).subscribe({ kind: 'sessions', projectId: liveProjectId(base) }, {
    event: envelope => {
      if (!isRecord(envelope.payload) || envelope.payload.event === 'activity'
        || (envelope.payload.sessionId !== undefined && envelope.payload.sessionId !== sessionId)) return
      initial.invalidate()
    },
    reset: initial.reset,
    reconnected: initial.reconnected,
  })
  initial.attach(subscription)
  const timer = setInterval(() => {
    autoRefresh()
  }, 30_000)
  const visibilityChanged = () => { if (!document.hidden) initial.invalidate() }
  document.addEventListener('visibilitychange', visibilityChanged)
  onCleanup(() => {
    initial.dispose()
    clearInterval(timer)
    document.removeEventListener('visibilitychange', visibilityChanged)
    subscription.close()
    snapshot.dispose()
  })
}, { immediate: true })
</script>
<style scoped>
.scheduled-tasks { font-size: 12px; overflow-wrap: anywhere; }
article { padding: 8px 0; }
article + article { border-top: 1px solid var(--c-border-soft); }
strong { font-size: 13px; font-weight: 500; }
p { margin: 6px 0; color: var(--c-text-secondary); }
button { color: var(--c-primary); background: transparent; border: 0; cursor: pointer; min-height: 32px; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
