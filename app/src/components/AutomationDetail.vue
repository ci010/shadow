<template>
  <section class="automation-detail" aria-label="Conversation workspace">
    <div v-if="enabled && !selectedSessionId" class="automation-empty" :aria-busy="loading">
      <h1>{{ automation?.name || 'Automation' }}</h1>
      <p v-if="loading" role="status">Loading conversation…</p>
      <template v-else-if="error || history.error">
        <p role="alert">{{ error || history.error }}</p>
        <button class="btn btn-sm" @click="refresh">Retry</button>
      </template>
      <p v-else>No saved runs yet. The conversation will appear after the first run.</p>
      <AutomationConversationInfo v-if="automation && !error && !history.error" :conversation="conversation" />
    </div>
    <slot />
  </section>
</template>

<script setup lang="ts">
import { computed, provide, reactive, watch } from 'vue'
import { automationConversationKey, type AutomationConversation } from '../composables/useAutomationConversation.ts'
import { createAutomationConversation, automationRunPosition } from '../automation-conversation.ts'
import { createAutomationRunHistory, emptyAutomationRunHistory } from '../automation-run-history.ts'
import { useAutomationCatalog } from '../composables/useAutomationCatalog.ts'
import AutomationConversationInfo from './AutomationConversationInfo.vue'

const props = withDefaults(defineProps<{ apiBase: string; automationId: string; active: boolean; enabled?: boolean; selectedSessionId?: string }>(), { enabled: true })
const emit = defineEmits<{ open: [sessionId: string, replace: boolean] }>()
const catalog = useAutomationCatalog(() => props.apiBase, () => props.active && props.enabled && !!props.automationId)
const automation = computed(() => catalog.jobs.value.find(item => item.id === props.automationId) ?? null)
const error = computed(() => catalog.error.value || (catalog.loaded.value && !automation.value
  ? 'This automation is no longer available. Saved conversations can still be viewed.' : ''))
const history = reactive(emptyAutomationRunHistory())
const position = computed(() => automationRunPosition(history, props.selectedSessionId))
const loading = computed(() => history.loading || catalog.loading.value)
const historyError = computed(() => history.error || (position.value.missing
  ? 'This conversation is no longer in the automation history. Return to the current conversation or refresh.' : ''))
const historyCache = new Map<string, ReturnType<typeof emptyAutomationRunHistory>>()
let identity = ''
let runHistory: ReturnType<typeof createAutomationRunHistory> | undefined
let navigation: ReturnType<typeof createAutomationConversation> | undefined
function refresh() { catalog.refresh(); runHistory?.refresh() }

const conversation: AutomationConversation = {
  sessionId: computed(() => props.enabled ? props.selectedSessionId : undefined),
  automation, run: computed(() => position.value.run), loading, error, historyError,
  hasPrevious: computed(() => position.value.hasPrevious),
  historical: computed(() => position.value.historical),
  previous: () => navigation?.previous(),
  next: () => navigation?.next(),
  current: () => navigation?.current(),
  refresh,
  retry: () => runHistory?.retry(),
}
provide(automationConversationKey, conversation)
watch(() => [props.apiBase, props.automationId, catalog.enabled.value] as const, ([base, job, active], _previous, onCleanup) => {
  const key = JSON.stringify([base, job])
  if (identity !== key) {
    if (identity) historyCache.set(identity, { ...history, runs: [...history.runs], loading: false })
    identity = key
    Object.assign(history, historyCache.get(key) ?? emptyAutomationRunHistory())
    navigation = createAutomationConversation(history, {
      selected: () => props.selectedSessionId,
      open: (sessionId, replace) => emit('open', sessionId, replace),
      loadMore: () => runHistory?.loadMore(),
    })
  }
  if (!active || !job) return
  const current = runHistory = createAutomationRunHistory(base, job, history)
  current.refresh()
  onCleanup(() => { current.dispose(); if (runHistory === current) runHistory = undefined })
}, { immediate: true })
watch(catalog.revision, () => runHistory?.refresh())
watch(() => [props.selectedSessionId, history.runs, history.loading, props.active, props.enabled] as const, () => {
  if (catalog.enabled.value) navigation?.reconcile()
}, { immediate: true })
</script>

<style scoped>
.automation-detail { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.automation-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; color: var(--c-text-secondary); text-align: center; overflow-wrap: anywhere; }
.automation-empty h1 { margin: 0; color: var(--c-text); font-size: 14px; font-weight: 500; }
.automation-empty p { margin: 0; max-width: 60ch; }
</style>
