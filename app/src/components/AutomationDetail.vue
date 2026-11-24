<template>
  <section class="automation-detail" :aria-label="t('Conversation workspace')">
    <component v-if="enabled && !selectedSessionId" :is="editor ? EditorViewHost : 'div'" :key="editor?.id"
      v-bind="editor ? { descriptor: editor, active, selected: true, initialSide: pendingSide } : { class: 'automation-pending' }">
      <div class="automation-empty" :aria-busy="opening">
        <h1>{{ editor?.label || automation?.name || t('Automation') }}</h1>
        <p v-if="opening" role="status">{{ t('Loading conversation…') }}</p>
        <template v-else-if="error || history.error">
          <p role="alert">{{ error || history.error }}</p>
          <button class="btn btn-sm" @click="refresh">{{ t('Retry') }}</button>
        </template>
        <p v-else>{{ t('No saved runs yet. The conversation will appear after the first run.') }}</p>
        <AutomationConversationInfo v-if="automation && !error && !history.error" :conversation="conversation" />
      </div>
    </component>
    <slot />
  </section>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, provide, reactive, watch } from 'vue'
import { automationConversationKey, type AutomationConversation } from '../composables/useAutomationConversation.ts'
import { createAutomationConversation, automationRunPosition } from '../automation-conversation.ts'
import { createAutomationRunHistory, emptyAutomationRunHistory } from '../automation-run-history.ts'
import { useAutomationCatalog } from '../composables/useAutomationCatalog.ts'
import AutomationConversationInfo from './AutomationConversationInfo.vue'
import EditorViewHost from './EditorViewHost.vue'
import type { EditorDescriptor, EditorSide } from '../editor-groups.ts'

const props = withDefaults(defineProps<{
  apiBase: string; automationId: string; active: boolean; enabled?: boolean; selectedSessionId?: string
  pendingEditor?: EditorDescriptor; pendingSide?: EditorSide
}>(), { enabled: true })
const emit = defineEmits<{ open: [sessionId: string, replace: boolean] }>()
const catalog = useAutomationCatalog(() => props.apiBase, () => props.active && props.enabled && !!props.automationId)
const automation = computed(() => catalog.jobs.value.find(item => item.id === props.automationId) ?? null)
const editor = computed(() => props.pendingEditor && { ...props.pendingEditor, label: automation.value?.name || props.pendingEditor.label })
const error = computed(() => catalog.error.value || (catalog.loaded.value && !automation.value
  ? t('This automation is no longer available. Saved conversations can still be viewed.') : ''))
const history = reactive(emptyAutomationRunHistory())
const position = computed(() => automationRunPosition(history, props.selectedSessionId))
const loading = computed(() => history.loading || catalog.loading.value)
// A saved run is still opening until the route commits its session ID.
const opening = computed(() => loading.value || (!error.value && !history.error && !!position.value.current))
const historyError = computed(() => history.error || (position.value.missing
  ? t('This conversation is no longer in the automation history. Return to the current conversation or refresh.') : ''))
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
  history, loadMore: () => runHistory?.loadMore(),
  select: sessionId => emit('open', sessionId, false),
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
.automation-detail { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.automation-pending { display: flex; flex: 1; min-height: 0; overflow: auto; }
.automation-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; color: var(--c-text-secondary); text-align: center; overflow-wrap: anywhere; }
.automation-empty h1 { margin: 0; color: var(--c-text); font-size: 14px; font-weight: 500; }
.automation-empty p { margin: 0; max-width: 60ch; }
</style>
