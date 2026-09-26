<template>
  <header class="session-heading">
    <MobileSheet v-if="mobileLayout" :open="editing" label="Rename session" @update:open="cancelRename"><div ref="mobileRenameTarget" /></MobileSheet>
    <Teleport :to="mobileRenameTarget || 'body'" :disabled="!mobileLayout || !mobileRenameTarget">
    <form v-if="editing" class="session-rename" aria-label="Rename session" :aria-busy="saving" @submit.prevent="saveName" @keydown.esc.prevent.stop="cancelRename">
      <label class="rename-field">
        <span>Session name</span>
        <input ref="nameInput" v-model="draftName" :maxlength="SESSION_NAME_MAX_LENGTH" :disabled="saving"
          required aria-label="Session name" :aria-invalid="!!renameError" autocomplete="off">
      </label>
      <div class="rename-actions">
        <button class="btn btn-sm" type="submit" :disabled="saving || !draftName.trim()">{{ saving ? 'Saving...' : 'Save' }}</button>
        <button class="btn btn-sm" type="button" :disabled="saving" @click="cancelRename">Cancel</button>
      </div>
      <p v-if="renameError" class="details-error" role="alert">{{ renameError }}</p>
    </form>
    </Teleport>
    <ComposerPopover v-if="!editing" ref="detailsPopover" label="Session details" :disabled="!active" :sheet="mobileLayout" :title="`${name} · ${folder}`" :width="520" @opened="loadDetails">
      <template #trigger>
        <span class="heading-name">{{ name }}</span>
        <span class="heading-separator" aria-hidden="true">&middot;</span>
        <span class="heading-folder">{{ folder }}</span>
        <span class="heading-chevron i-lucide-chevron-down" aria-hidden="true" />
      </template>
      <template #default>
        <div class="session-details">
          <section v-if="coordinator || details?.description" class="details-topic" aria-label="Session description">
            <h3>{{ coordinator ? 'Project coordination' : 'Description' }}</h3>
            <p v-if="coordinator" class="details-note">Coordinate Project work here. Peer sessions are independent conversations, not tasks or child chats.</p>
            <p v-else class="details-topic-title">{{ details?.description }}</p>
          </section>
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
    <button v-if="canRename && !editing" ref="renameButton" type="button" class="rename-button" aria-label="Rename session"
      title="Rename session" @click="startRename"><span class="i-lucide-pencil w-3.5 h-3.5" aria-hidden="true" /></button>
  </header>
</template>

<script setup lang="ts">
import { apiUrl } from '../api-url.ts'
import { computed, nextTick, onDeactivated, onUnmounted, ref, watch } from 'vue'
import { parseSessionName, SESSION_NAME_MAX_LENGTH } from '../../../src/sessions/session-name.ts'
import ComposerPopover from './ComposerPopover.vue'
import MobileSheet from './MobileSheet.vue'
import { useMobileChrome } from '../composables/useMobileChrome.ts'
import { chatContextName } from '../chat-draft.ts'
import { contextPercent, formatTokenCount, parseSessionDetails, type SessionDetails } from '../session-details.ts'
import { ORCHESTRATOR_SESSION_ID, type TopicMetadata } from '../project-coordination.ts'

const props = defineProps<{ apiBase: string; sessionId: string; name: string; projectName?: string; topic?: TopicMetadata; physicalId: string | null; revision: number; active: boolean; canRename?: boolean }>()
const emit = defineEmits<{ workdir: [workdir: SessionDetails['workdir']]; renamed: [name: string] }>()
const mobile = useMobileChrome()
const mobileLayout = computed(() => !!mobile?.enabled.value)
const mobileRenameTarget = ref<HTMLElement>()
const detailsPopover = ref<InstanceType<typeof ComposerPopover>>()
defineExpose({ showDetails: () => detailsPopover.value?.show(), startRename })
const details = ref<SessionDetails | null>(null)
const loading = ref(false)
const error = ref('')
const coordinator = computed(() => props.sessionId === ORCHESTRATOR_SESSION_ID || details.value?.sessionKind === 'orchestrator')
const topic = computed(() => details.value?.topic ?? props.topic)
const sessionName = computed(() => details.value?.name?.trim() || (coordinator.value ? 'Project coordination' : props.name || topic.value?.title || 'Conversation'))
const name = computed(() => [props.projectName, sessionName.value].filter(Boolean).join(' / '))
const editing = ref(false)
const saving = ref(false)
const draftName = ref('')
const renameError = ref('')
const nameInput = ref<HTMLInputElement>()
const renameButton = ref<HTMLButtonElement>()
let renameRequest: AbortController | undefined

async function startRename() {
  if (!props.canRename || !props.active) return
  draftName.value = sessionName.value
  renameError.value = ''
  editing.value = true
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}
function cancelRename() {
  if (saving.value) return
  editing.value = false
  renameError.value = ''
  if (!mobileLayout.value) void nextTick(() => renameButton.value?.focus())
}
async function saveName() {
  if (saving.value || !editing.value || !props.canRename || !props.active) return
  renameError.value = ''
  let nextName: string
  try { nextName = parseSessionName(draftName.value) }
  catch (cause) { renameError.value = cause instanceof Error ? cause.message : 'Enter a valid session name.'; return }
  const controller = new AbortController()
  renameRequest = controller
  saving.value = true
  // A pending details read must not restore the pre-rename name.
  cancel()
  try {
    const response = await fetch(apiUrl(props.apiBase, `/api/sessions/${encodeURIComponent(props.sessionId)}/name`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nextName }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
    if (!response.ok) throw new Error(`Could not save the session name (${response.status}). Retry.`)
    const result = await response.json()
    if (!result || result.sessionId !== props.sessionId || result.name !== nextName) throw new Error('Could not confirm the saved name. Retry.')
    if (controller.signal.aborted) return
    if (details.value) details.value = { ...details.value, name: nextName }
    emit('renamed', nextName)
    editing.value = false
    if (!mobileLayout.value) void nextTick(() => renameButton.value?.focus())
    void loadDetails()
  } catch (cause) {
    if (!controller.signal.aborted) renameError.value = cause instanceof Error ? cause.message : 'Could not save the session name. Retry.'
  } finally {
    if (renameRequest === controller) { renameRequest = undefined; saving.value = false }
  }
}
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
watch(() => [props.apiBase, props.sessionId, props.physicalId, props.revision, props.active, props.name] as const, (next, previous) => {
  cancel()
  if (!props.active || previous && (next[0] !== previous[0] || next[1] !== previous[1])) stopRename()
  if (!previous || next[0] !== previous[0] || next[1] !== previous[1] || next[2] !== previous[2]) {
    details.value = null
    error.value = ''
  }
  if (props.active && !saving.value) void loadDetails()
}, { immediate: true })
function stopRename() {
  renameRequest?.abort()
  renameRequest = undefined
  saving.value = false
  editing.value = false
  renameError.value = ''
}
onDeactivated(() => { cancel(); stopRename() })
onUnmounted(() => { cancel(); stopRename() })
</script>

<style scoped>
.session-heading { display: flex; flex: 0 0 auto; align-items: center; min-width: 0; min-height: 52px; padding: 4px 16px; color: var(--c-text); }
.session-rename { display: flex; flex: 1; flex-wrap: wrap; align-items: end; gap: 8px; min-width: 0; padding: 6px 0; }
.rename-field { display: flex; flex: 1 1 180px; min-width: 0; flex-direction: column; gap: 4px; font-size: 12px; }
.rename-field input { width: 100%; box-sizing: border-box; min-width: 0; padding: 6px 8px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 14px; }
.rename-actions { display: flex; gap: 6px; }
.session-rename .details-error { flex-basis: 100%; margin: 0; font-size: 12px; }
.rename-button { display: grid; place-items: center; flex: 0 0 32px; height: 32px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); cursor: pointer; }
.rename-button:hover { background: var(--c-bg-muted); color: var(--c-text); }
.rename-button:focus-visible, .rename-field input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.session-heading :deep(.composer-control) { min-height: 36px; gap: 10px; max-width: 100%; padding: 7px 8px; text-align: left; }
.heading-name { min-width: 0; max-width: 65%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text); font-size: 14px; font-weight: 600; }
.heading-folder { min-width: min(80px, 25vw); max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-secondary); font-size: 13px; }
.heading-separator { flex-shrink: 0; color: var(--c-text-secondary); }
.heading-chevron { width: 14px; height: 14px; flex-shrink: 0; }
.session-details { padding: 9px 10px 4px; font-size: 13px; line-height: 1.6; }
.session-details dl { display: grid; grid-template-columns: 94px minmax(0, 1fr); gap: 12px 10px; margin: 0; }
.session-details dt, .context-heading { color: var(--c-text-secondary); }
.session-details dd { margin: 0; min-width: 0; color: var(--c-text); overflow-wrap: anywhere; user-select: text; cursor: text; }
.details-topic { margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--c-border); }
.details-topic h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.details-topic-title { margin: 0 0 12px; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.details-topic dd { white-space: pre-wrap; }
.detail-id { font-size: 12px; }
.details-usage { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--c-border); }
.token-counts { display: flex; flex-direction: column; gap: 3px; font-variant-numeric: tabular-nums; }
.token-counts > span { display: flex; align-items: center; gap: 6px; }
.token-counts small, .details-note { color: var(--c-text-secondary); font-size: 12px; }
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
