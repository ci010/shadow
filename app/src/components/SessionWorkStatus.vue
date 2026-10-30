<template>
  <div v-if="record || state?.error" class="session-work-status">
    <p v-if="state?.error" role="alert">{{ t('Task status unavailable.') }} <button @click="snapshot?.refresh()">{{ t('Retry') }}</button></p>
    <button v-if="record" type="button" class="current-task" :title="record.workflow?.title || record.definition.objective" @click="$emit('open', record.key)">
      <span class="i-lucide-workflow" aria-hidden="true" />
      <span>{{ records.length > 1 ? t('{length} work items', { length: records.length }) : record.workflow?.title || record.definition.objective }}</span>
      <span class="current-task-state">{{ record.paused ? t('Paused') : enumLabel(record.workflow?.status) || t('Review needed') }}</span>
      <span class="i-lucide-arrow-up-right" aria-hidden="true" />
    </button>
  </div>
</template>
<script setup lang="ts">
import { affectsSessionResource } from '../session-invalidation.ts'
import { t } from '../i18n.ts'
import { enumLabel } from '../display-labels.ts'
import { computed, onUnmounted, shallowRef, watch } from 'vue'
import { createInitialLiveSnapshot } from '../initial-live-snapshot.ts'
import { isRecord } from '../folders-sidebar.ts'
import { createSessionWorkStatus } from '../session-work-status.ts'
import { liveProjectId, useLiveClientPool } from '../composables/useLiveClient.ts'
const props = defineProps<{ apiBase: string; sessionId: string; active: boolean; revision: number }>()
defineEmits<{ open: [key: string] }>()
const pool = useLiveClientPool()
function create() {
  const base = props.apiBase, id = props.sessionId
  return createSessionWorkStatus(base, id)
}
const snapshot = shallowRef<ReturnType<typeof create>>()
const state = computed(() => snapshot.value?.state)
const records = computed(() => state.value?.value?.records.filter(record => !['done', 'cancelled'].includes(record.workflow?.status ?? '')
  || state.value?.value?.effects.length) ?? [])
const record = computed(() => records.value[0])
watch(() => [props.apiBase, props.sessionId], () => {
  snapshot.value?.dispose(); snapshot.value = create()
}, { immediate: true })
watch(() => [props.apiBase, props.sessionId, props.active] as const, ([base, id, active], _old, onCleanup) => {
  const current = snapshot.value
  if (!active || !id || !current) { current?.pause(); return }
  const gate = createInitialLiveSnapshot({ refresh: () => { void current.autoRefresh() } })
  const subscription = pool.client(base).subscribe({ kind: 'sessions', projectId: liveProjectId(base) }, {
    event: envelope => {
      const payload = envelope.payload
      if (!isRecord(payload) || payload.event !== 'invalidate'
        || (payload.sessionId !== undefined && payload.sessionId !== id)) return
      if (typeof payload.completedTurnId === 'string'
        && payload.completedTurnId && !current.reconcile(payload, false)) return
      if (affectsSessionResource(payload, id, 'work')) gate.invalidate()
    },
    reset: gate.reset, reconnected: gate.reconnected,
  })
  gate.attach(subscription)
  onCleanup(() => { gate.dispose(); subscription.close(); current.pause() })
}, { immediate: true })
// revision is a graph publication counter, not a session-work invalidation.
onUnmounted(() => snapshot.value?.dispose())
</script>
<style scoped>
.session-work-status { min-width: 0; max-width: min(260px, 100%); margin-top: 8px; font-size: 12px; }
.session-work-status p { color: var(--c-error); margin: 0; }
button { font: inherit; cursor: pointer; color: var(--c-text-secondary); background: transparent; border: 0; padding: 5px 0; }
.current-task { display: inline-flex; align-items: center; gap: 8px; box-sizing: border-box; max-width: 100%; min-height: 32px; padding: 5px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-soft); text-align: left; line-height: 20px; }
.current-task > span:nth-child(2) { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.current-task-state { flex: 0 0 auto; white-space: nowrap; }
.current-task > span[class^=i-] { width: 14px; height: 14px; flex-shrink: 0; }
.current-task:hover { color: var(--c-text); background: var(--c-bg-muted); }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (pointer: coarse), (max-width: 700px) { button { min-height: 44px; } }
</style>
