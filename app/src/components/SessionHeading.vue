<template>
  <header class="session-heading" :class="{ 'has-topic': topic || coordinator }">
    <ComposerPopover label="Session details" :title="`${name} · ${folder}`" :width="360" @opened="loadDetails">
      <template #trigger>
        <span class="heading-name">{{ name }}</span>
        <span class="heading-separator" aria-hidden="true">&middot;</span>
        <span class="heading-folder">{{ folder }}</span>
        <span class="heading-chevron i-lucide-chevron-down" aria-hidden="true" />
      </template>
      <template #default>
        <div class="session-details">
          <p v-if="loading" class="details-note" role="status">Loading session details...</p>
          <p v-if="error" class="details-error" role="alert">{{ error }}</p>
          <dl class="details-identity">
            <template v-if="details?.workdir.kind === 'remote'">
              <dt>Device</dt><dd>{{ details.workdir.nodeName || details.workdir.nodeId || 'Remote device' }}</dd>
              <dt>Workspace</dt><dd>{{ details.workdir.displayName || 'Remote workspace' }}<template v-if="details.workdir.available === false"> (unavailable)</template></dd>
            </template>
            <dt>Path</dt><dd>{{ details?.workdir.displayPath ?? (details?.workdir.kind === 'remote' ? 'Not advertised by this device' : 'Unavailable') }}</dd>
            <dt>Session name</dt><dd>{{ name }}</dd>
            <dt>Session ID</dt><dd class="detail-id">{{ sessionId }}</dd>
          </dl>
          <div class="details-usage">
            <dl>
              <dt>Tokens</dt>
              <dd v-if="details?.usage" class="token-counts">
                <span :title="`${details.usage.promptTokens.toLocaleString()} input tokens`"><span class="i-lucide-arrow-up" aria-hidden="true" />{{ formatTokenCount(details.usage.promptTokens) }} <small>input</small></span>
                <span :title="`${details.usage.completionTokens.toLocaleString()} output tokens`"><span class="i-lucide-arrow-down" aria-hidden="true" />{{ formatTokenCount(details.usage.completionTokens) }} <small>output</small></span>
                <small>{{ details.usageScope === 'session' ? 'This conversation' : details.usageScope === 'segment' ? 'This segment' : 'Last model call' }}</small>
              </dd>
              <dd v-else>Not reported</dd>
            </dl>
            <div class="context-heading"><span>Context</span><span v-if="percent !== null">{{ percent }}%</span></div>
            <div class="context-counts">
              <span>{{ details?.context.usedTokens != null ? formatTokenCount(details.context.usedTokens) : 'Not reported' }}</span>
              <span>{{ details?.context.windowTokens != null ? `${formatTokenCount(details.context.windowTokens)} limit` : 'Limit unavailable' }}</span>
            </div>
            <progress v-if="percent !== null" :value="Math.min(percent, 100)" max="100" aria-label="Context window usage" :aria-valuetext="`${percent}%`" />
            <p class="details-note">Last reported context, not a live draft estimate.</p>
          </div>
        </div>
      </template>
    </ComposerPopover>
    <p v-if="coordinator" class="coordination-description">Coordinate this Project here. Topics are independent conversations in the sidebar, not tasks or child chats.</p>
    <details v-else-if="topic" class="topic-metadata">
      <summary>{{ topic.goal || 'Topic details' }}</summary>
      <dl>
        <dt>Goal</dt><dd>{{ topic.goal }}</dd>
        <dt>Scope</dt><dd>{{ topic.scope }}</dd>
        <template v-if="topic.nonGoals"><dt>Out of scope</dt><dd>{{ topic.nonGoals }}</dd></template>
      </dl>
    </details>
  </header>
</template>

<script setup lang="ts">
import { apiUrl } from '../api-url.ts'
import { computed, onDeactivated, onUnmounted, ref, watch } from 'vue'
import ComposerPopover from './ComposerPopover.vue'
import { chatContextName } from '../chat-draft.ts'
import { contextPercent, formatTokenCount, parseSessionDetails, type SessionDetails } from '../session-details.ts'
import { ORCHESTRATOR_SESSION_ID, type TopicMetadata } from '../project-coordination.ts'

const props = defineProps<{ apiBase: string; sessionId: string; name: string; projectName?: string; topic?: TopicMetadata; physicalId: string | null; revision: number; active: boolean }>()
const emit = defineEmits<{ workdir: [workdir: SessionDetails['workdir']] }>()
const details = ref<SessionDetails | null>(null)
const loading = ref(false)
const error = ref('')
const coordinator = computed(() => props.sessionId === ORCHESTRATOR_SESSION_ID || details.value?.sessionKind === 'orchestrator')
const topic = computed(() => details.value?.topic ?? props.topic)
const name = computed(() => [props.projectName, coordinator.value ? 'Project coordination' : topic.value?.title || details.value?.name?.trim() || props.name || 'Conversation'].filter(Boolean).join(' / '))
const folder = computed(() => coordinator.value ? 'Project-wide · No folder' : details.value?.workdir.kind === 'remote'
  ? `${details.value.workdir.nodeName || details.value.workdir.nodeId || 'Remote device'} · ${details.value.workdir.displayName || (details.value.workdir.displayPath ? chatContextName(details.value.workdir.displayPath) : 'Remote folder')}${details.value.workdir.available === false ? ' (unavailable)' : ''}`
  : details.value?.workdir.displayPath
  ? chatContextName(details.value.workdir.displayPath)
  : loading.value ? 'Loading folder...' : 'Folder unavailable')
const percent = computed(() => details.value ? contextPercent(details.value.context) : null)
let request: AbortController | undefined

async function loadDetails() {
  if (!props.active || !props.sessionId || request) return
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const query = props.physicalId ? `?${new URLSearchParams({ physicalId: props.physicalId })}` : ''
    const response = await fetch(apiUrl(props.apiBase, `/api/sessions/${encodeURIComponent(props.sessionId)}/details${query}`), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
    if (!response.ok) throw new Error(`Session details are unavailable (${response.status}). Reopen the menu to retry.`)
    const result = parseSessionDetails(await response.json(), props.sessionId)
    if (!controller.signal.aborted) { details.value = result; emit('workdir', result.workdir) }
  } catch (cause) {
    if (!controller.signal.aborted) {
      error.value = cause instanceof Error ? cause.message : 'Session details are unavailable. Reopen the menu to retry.'
    }
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}
function cancel() {
  request?.abort()
  request = undefined
  loading.value = false
}
watch(() => [props.apiBase, props.sessionId, props.physicalId, props.revision, props.active] as const, (next, previous) => {
  cancel()
  if (!previous || next[0] !== previous[0] || next[1] !== previous[1] || next[2] !== previous[2]) {
    details.value = null
    error.value = ''
  }
  if (props.active) void loadDetails()
}, { immediate: true })
onDeactivated(cancel)
onUnmounted(cancel)
</script>

<style scoped>
.session-heading { display: flex; flex: 0 0 auto; align-items: center; min-width: 0; min-height: 52px; padding: 4px 16px; color: var(--c-text); }
.session-heading.has-topic { flex-wrap: wrap; }
.coordination-description, .topic-metadata { flex-basis: 100%; margin: 0 8px 8px; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.topic-metadata summary { cursor: pointer; max-height: 3em; overflow: hidden; }
.topic-metadata dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 8px 0; max-height: 180px; overflow: auto; }
.topic-metadata dd { margin: 0; white-space: pre-wrap; user-select: text; }
.session-heading :deep(.composer-control) { min-height: 36px; gap: 10px; max-width: 100%; padding: 7px 8px; text-align: left; }
.heading-name { min-width: 0; max-width: 65%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text); font-size: 14px; font-weight: 600; }
.heading-folder { min-width: min(80px, 25vw); max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-secondary); font-size: 13px; }
.heading-separator { flex-shrink: 0; color: var(--c-text-secondary); }
.heading-chevron { width: 14px; height: 14px; flex-shrink: 0; }
.session-details { padding: 9px 10px 4px; font-size: 13px; line-height: 1.6; }
.session-details dl { display: grid; grid-template-columns: 94px minmax(0, 1fr); gap: 12px 10px; margin: 0; }
.session-details dt, .context-heading { color: var(--c-text-secondary); }
.session-details dd { margin: 0; min-width: 0; color: var(--c-text); overflow-wrap: anywhere; user-select: text; cursor: text; }
.detail-id { font-size: 12px; }
.details-usage { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--c-border); }
.token-counts { display: flex; flex-direction: column; gap: 3px; font-variant-numeric: tabular-nums; }
.token-counts > span { display: flex; align-items: center; gap: 6px; }
.token-counts small, .details-note { color: var(--c-text-secondary); font-size: 11px; }
.context-heading, .context-counts { display: flex; justify-content: space-between; gap: 12px; }
.context-heading { margin-top: 18px; }
.context-counts { margin: 8px 0 6px; font-size: 12px; font-variant-numeric: tabular-nums; }
progress { display: block; width: 100%; height: 6px; border: 0; border-radius: var(--radius-pill); overflow: hidden; background: var(--c-bg-muted); appearance: none; }
progress::-webkit-progress-bar { background: var(--c-bg-muted); border-radius: var(--radius-pill); }
progress::-webkit-progress-value { background: var(--c-blue); border-radius: var(--radius-pill); }
progress::-moz-progress-bar { background: var(--c-blue); border-radius: var(--radius-pill); }
.details-note { margin: 8px 0; }
.details-error { color: var(--c-error); overflow-wrap: anywhere; }
@media (max-width: 700px) {
  .session-heading { padding: 4px 8px; }
  .session-heading :deep(.composer-control) { gap: 7px; }
  .heading-name { font-size: 13px; }
  .heading-folder { max-width: 38%; font-size: 12px; }
}
</style>
