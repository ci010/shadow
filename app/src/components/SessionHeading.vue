<template>
  <header class="session-heading">
    <ComposerPopover ref="detailsPopover" :label="t('Session details')" :disabled="!active" :sheet="mobileLayout" :title="`${name} · ${folder}`" :width="520" @opened="loadDetails" @closed="stopRename">
      <template #trigger>
        <span class="heading-name">{{ name }}</span>
        <span class="heading-separator" aria-hidden="true">&middot;</span>
        <span class="heading-folder">{{ folder }}</span>
        <span class="heading-chevron i-lucide-chevron-down" aria-hidden="true" />
      </template>
      <template #default>
        <div class="session-details">
          <section v-if="coordinator || details?.description" class="details-topic" :aria-label="t('Session description')">
            <h3>{{ coordinator ? t('Project coordination') : t('Description') }}</h3>
            <p v-if="coordinator" class="details-note">{{ t('Coordinate Project work here. Peer sessions are independent conversations, not tasks or child chats.') }}</p>
            <p v-else class="details-topic-title">{{ details?.description }}</p>
          </section>
          <p v-if="loading" class="details-note" role="status">{{ t('Loading session details...') }}</p>
          <p v-if="error" class="details-error" role="alert">{{ error }}</p>
          <dl class="details-identity">
            <template v-if="details?.workdir.kind === 'remote'">
              <dt>{{ t('Device') }}</dt><dd>{{ details.workdir.nodeName || details.workdir.nodeId || t('Remote device') }}</dd>
              <dt>{{ t('Workspace') }}</dt><dd>{{ details.workdir.displayName || t('Remote workspace') }}<template v-if="details.workdir.available === false"> {{ t('(unavailable)') }}</template></dd>
            </template>
            <dt>{{ t('Path') }}</dt>
            <dd>
              <CopyableId v-if="details?.workdir.displayPath" class="detail-copy" :value="details.workdir.displayPath" :label="t('Path')" wrap />
              <span v-else>{{ details?.workdir.kind === 'remote' ? t('Not advertised by this device') : t('Unavailable') }}</span>
            </dd>
            <dt>{{ t('Session name') }}</dt>
            <dd class="detail-name" :class="{ 'is-editing': editing }">
              <form v-if="editing" class="session-rename" :aria-label="t('Rename session')" :aria-busy="saving"
                @submit.prevent="saveName" @keydown.stop="renameKeydown">
                <input ref="nameInput" v-model="draftName" class="rename-input" :maxlength="SESSION_NAME_MAX_LENGTH" :disabled="saving"
                  required :aria-label="t('Session name')" :aria-invalid="!!renameError" autocomplete="off">
                <div class="rename-actions">
                  <button class="btn btn-sm primary" type="submit" :disabled="saving || !draftName.trim()">{{ saving ? t('Saving...') : t('Save') }}</button>
                  <button class="btn btn-sm" type="button" :disabled="saving" @click="cancelRename">{{ t('Cancel') }}</button>
                </div>
                <p v-if="renameError" class="details-error" role="alert">{{ renameError }}</p>
              </form>
              <template v-else>
                <span>{{ name }}</span>
                <button v-if="canRename" ref="renameButton" type="button" class="rename-button" :disabled="!active"
                  :aria-label="t('Rename session')" :title="t('Rename session')" @click="startRename"><span class="i-lucide-pencil w-3.5 h-3.5" aria-hidden="true" /></button>
              </template>
            </dd>
            <dt>{{ t('Session ID') }}</dt><dd class="detail-id"><CopyableId class="detail-copy" :value="sessionId" :label="t('Session ID')" wrap /></dd>
          </dl>
          <div class="details-usage">
            <h3 class="token-heading">{{ t('Tokens') }}</h3>
            <dl class="token-columns">
              <div v-for="column in tokenColumns" :key="column.label" class="token-column">
                <dt>{{ column.label }}</dt>
                <dd v-if="column.usage" class="token-counts">
                  <span :title="t('{value1} input tokens', { value1: formatNumber(column.usage.promptTokens) })"><span class="i-lucide-arrow-up" aria-hidden="true" />{{ formatTokenCount(column.usage.promptTokens) }} <small>{{ t('input') }}</small></span>
                  <span :title="t('Cache-read tokens / input tokens')"><span class="i-lucide-database" aria-hidden="true" /><span :title="column.usage.cachedTokens === undefined ? undefined : formatNumber(column.usage.cachedTokens)">{{ column.usage.cachedTokens === undefined ? t('Not reported') : formatTokenCount(column.usage.cachedTokens) }}</span> <small :aria-label="t('Cache rate')">({{ cacheRate(column.usage) === null ? t('Not reported') : `${cacheRate(column.usage)}%` }})</small> <small>{{ t('cache') }}</small></span>
                  <small v-if="column.usage.cacheReportedPromptTokens !== undefined" class="details-note">{{ t('Partial cache report: {reported} / {total} input tokens. Rate covers reported inputs only.', { reported: formatTokenCount(column.usage.cacheReportedPromptTokens), total: formatTokenCount(column.usage.promptTokens) }) }}</small>
                  <span :title="t('{value1} output tokens', { value1: formatNumber(column.usage.completionTokens) })"><span class="i-lucide-arrow-down" aria-hidden="true" />{{ formatTokenCount(column.usage.completionTokens) }} <small>{{ t('output') }}</small></span>
                </dd>
                <dd v-else>{{ t('Not reported') }}</dd>
              </div>
            </dl>
            <p v-if="details?.usageIncomplete" class="details-note">{{ t('Token totals are partial; some calls have no reported usage.') }}</p>
            <div class="context-heading"><span>{{ t('Context') }}</span><span v-if="percent !== null">{{ percent }}%</span></div>
            <div class="context-counts">
              <span>{{ details?.context.usedTokens != null ? formatTokenCount(details.context.usedTokens) : t('Not reported') }}</span>
              <span>{{ details?.context.windowTokens != null ? t('{value1} limit', { value1: formatTokenCount(details.context.windowTokens) }) : t('Limit unavailable') }}</span>
            </div>
            <div v-if="details?.context.windowTokens != null" class="context-bar" role="img"
              :aria-label="percent === null ? t('Context usage not reported') : t('{value1}% context used', { value1: percent })">
              <span v-if="capacity.usedPercent !== null" class="context-used" :style="{ width: `${capacity.usedPercent}%` }" />
              <span v-else class="context-unknown" />
              <span v-for="marker in capacity.markers" :key="marker.kind" class="context-marker" :class="marker.kind"
                :style="{ left: `${marker.percent}%` }" aria-hidden="true" />
            </div>
            <ul class="context-legend">
              <li><span class="context-swatch used" aria-hidden="true" />{{ t('Reported prompt (all content)') }}</li>
              <li><span class="context-swatch remaining" aria-hidden="true" />{{ capacity.remainingTokens === null ? t('Remaining unknown') : t('{value1} remaining', { value1: formatTokenCount(capacity.remainingTokens) }) }}</li>
            </ul>
            <p v-if="capacity.overflowTokens" class="details-note">{{ t('{value1} over capacity', { value1: formatTokenCount(capacity.overflowTokens) }) }}</p>
            <ul v-if="capacity.markers.length" class="context-legend">
              <li v-for="marker in capacity.markers" :key="marker.kind"><span class="context-swatch" :class="marker.kind" aria-hidden="true" />{{ marker.kind === 'low' ? t('Low (between turns)') : t('High (during turn)') }}: {{ Math.round(marker.ratio * 1000) / 10 }}% · {{ formatTokenCount(marker.tokens) }}</li>
            </ul>
          </div>
        </div>
      </template>
    </ComposerPopover>
  </header>
</template>

<script setup lang="ts">
import { t, formatNumber } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import { computed, nextTick, onDeactivated, onUnmounted, ref, watch } from 'vue'
import { parseSessionName, SESSION_NAME_MAX_LENGTH } from '../../../src/sessions/session-name.ts'
import ComposerPopover from './ComposerPopover.vue'
import CopyableId from './CopyableId.vue'
import { useMobileChrome } from '../composables/useMobileChrome.ts'
import { chatContextName } from '../chat-draft.ts'
import { cacheRate, contextCapacity, contextPercent, formatTokenCount, parseSessionDetails, type SessionDetails } from '../session-details.ts'
import { ORCHESTRATOR_SESSION_ID, type TopicMetadata } from '../project-coordination.ts'

const props = defineProps<{ apiBase: string; sessionId: string; name: string; projectName?: string; topic?: TopicMetadata; physicalId: string | null; revision: number; active: boolean; canRename?: boolean }>()
const emit = defineEmits<{ workdir: [workdir: SessionDetails['workdir']]; renamed: [name: string] }>()
const mobile = useMobileChrome()
const mobileLayout = computed(() => !!mobile?.enabled.value)
const detailsPopover = ref<InstanceType<typeof ComposerPopover>>()
defineExpose({ showDetails: () => detailsPopover.value?.show(), startRename })
const details = ref<SessionDetails | null>(null)
const loading = ref(false)
const error = ref('')
const coordinator = computed(() => props.sessionId === ORCHESTRATOR_SESSION_ID || details.value?.sessionKind === 'orchestrator')
const topic = computed(() => details.value?.topic ?? props.topic)
const sessionName = computed(() => details.value?.name?.trim() || (coordinator.value ? t('Project coordination') : props.name || topic.value?.title || t('Conversation')))
const name = computed(() => [props.projectName, sessionName.value].filter(Boolean).join(' / '))
const editing = ref(false)
const saving = ref(false)
const draftName = ref('')
const renameError = ref('')
const nameInput = ref<HTMLInputElement>()
const renameButton = ref<HTMLButtonElement>()
let renameRequest: AbortController | undefined

async function startRename() {
  if (!props.canRename || !props.active || saving.value) return
  draftName.value = sessionName.value
  renameError.value = ''
  editing.value = true
  await detailsPopover.value?.show()
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}
function cancelRename() {
  if (saving.value) return
  editing.value = false
  renameError.value = ''
  void restoreRenameFocus()
}
async function restoreRenameFocus() {
  const sessionId = props.sessionId
  await nextTick()
  if (props.active && props.sessionId === sessionId && !editing.value) renameButton.value?.focus({ preventScroll: true })
}
function renameKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); cancelRename() }
}
async function saveName() {
  if (saving.value || !editing.value || !props.canRename || !props.active) return
  renameError.value = ''
  let nextName: string
  try { nextName = parseSessionName(draftName.value) }
  catch (cause) { renameError.value = cause instanceof Error ? cause.message : t('Enter a valid session name.'); return }
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
    if (!response.ok) throw new Error(t('Could not save the session name ({status}). Retry.', { status: response.status }))
    const result = await response.json()
    if (!result || result.sessionId !== props.sessionId || result.name !== nextName) throw new Error(t('Could not confirm the saved name. Retry.'))
    if (controller.signal.aborted) return
    if (details.value) details.value = { ...details.value, name: nextName }
    emit('renamed', nextName)
    editing.value = false
    void restoreRenameFocus()
    void loadDetails()
  } catch (cause) {
    if (!controller.signal.aborted) renameError.value = cause instanceof Error ? cause.message : t('Could not save the session name. Retry.')
  } finally {
    if (renameRequest === controller) { renameRequest = undefined; saving.value = false }
  }
}
const folder = computed(() => coordinator.value ? t('Project-wide · No folder') : details.value?.workdir.kind === 'remote'
  ? `${details.value.workdir.nodeName || details.value.workdir.nodeId || t('Remote device')} · ${details.value.workdir.displayName || (details.value.workdir.displayPath ? chatContextName(details.value.workdir.displayPath) : t('Remote folder'))}${details.value.workdir.available === false ? ' (unavailable)' : ''}`
  : details.value?.workdir.displayPath
  ? chatContextName(details.value.workdir.displayPath)
  : loading.value ? t('Loading folder...') : t('Folder unavailable'))
const capacity = computed(() => contextCapacity(details.value?.context ?? { usedTokens: null, windowTokens: null }))
const percent = computed(() => details.value ? contextPercent(details.value.context) : null)
const tokenColumns = computed(() => [
  { label: t('Total'), usage: details.value?.usage },
  ...(details.value?.subagentUsage !== undefined
    ? [{ label: t('Subagents'), usage: details.value.subagentUsage }] : []),
])
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
    if (!response.ok) throw new Error(t('Session details are unavailable ({status}). Reopen the menu to retry.', { status: response.status }))
    const result = parseSessionDetails(await response.json(), props.sessionId)
    if (!controller.signal.aborted) { details.value = result; emit('workdir', result.workdir) }
  } catch (cause) {
    if (!controller.signal.aborted) {
      error.value = cause instanceof Error ? cause.message : t('Session details are unavailable. Reopen the menu to retry.')
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
.session-rename { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.rename-input { width: 100%; box-sizing: border-box; min-width: 0; min-height: 32px; padding: 6px 8px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 14px; }
.rename-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.session-rename .details-error { margin: 0; font-size: 12px; }
.rename-button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); cursor: pointer; }
.rename-button:hover { background: var(--c-bg-muted); color: var(--c-text); }
.rename-button:focus-visible, .rename-input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.rename-button:disabled { opacity: .5; cursor: not-allowed; }
.session-heading :deep(.composer-control) { flex: 1 1 0; width: 0; min-height: 36px; gap: 10px; max-width: 100%; padding: 7px 8px; text-align: left; }
.heading-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text); font-size: 14px; font-weight: 600; }
.heading-folder { flex: 0 1 30ch; min-width: 0; max-width: 35%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-secondary); font-size: 13px; }
.heading-separator { flex-shrink: 0; color: var(--c-text-secondary); }
.heading-chevron { width: 14px; height: 14px; flex-shrink: 0; }
.session-details { min-width: 0; max-width: 100%; box-sizing: border-box; padding: 9px 10px 4px; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.session-details dl { display: grid; grid-template-columns: 94px minmax(0, 1fr); gap: 12px 10px; margin: 0; }
.session-details dt, .context-heading { color: var(--c-text-secondary); }
.session-details dd { margin: 0; min-width: 0; color: var(--c-text); overflow-wrap: anywhere; user-select: text; cursor: text; }
.detail-name { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px; }
.detail-name > span { min-width: 0; }
.detail-name.is-editing { grid-template-columns: minmax(0, 1fr); }
.detail-copy :deep(.copy-value) { padding-block: 0; }
.details-topic { margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--c-border); }
.details-topic h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.details-topic-title { margin: 0 0 12px; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.details-topic dd { white-space: pre-wrap; }
.detail-id { font-size: 12px; }
.details-usage { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--c-border); }
.token-heading { margin: 0 0 12px; font-size: 13px; font-weight: 600; }
.session-details .token-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.token-column { min-width: 0; }
.token-column dt { margin-bottom: 6px; }
.token-counts { display: flex; flex-direction: column; gap: 3px; font-variant-numeric: tabular-nums; }
.token-counts > span { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.token-counts > span > span[aria-hidden="true"] { flex: 0 0 14px; width: 14px; height: 14px; }
.token-counts small, .details-note { color: var(--c-text-secondary); font-size: 12px; }
.context-heading, .context-counts { display: flex; justify-content: space-between; gap: 12px; }
.context-heading { margin-top: 18px; }
.context-counts { margin: 8px 0 6px; font-size: 12px; font-variant-numeric: tabular-nums; }
.context-bar { position: relative; display: flex; width: 100%; height: 10px; border-radius: var(--radius-pill); background: var(--c-bg-muted); }
.context-used { background: var(--c-blue); border-radius: inherit; }
.context-unknown { width: 100%; border-radius: inherit; background: repeating-linear-gradient(135deg, transparent 0 4px, var(--c-border) 4px 8px); }
.context-marker { position: absolute; top: -3px; bottom: -3px; border-left: 2px solid; transform: translateX(-1px); }
.context-marker.low { border-color: #b7791f; }
.context-marker.high { border-color: var(--c-error); border-left-style: dashed; }
.context-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 0; margin: 8px 0; list-style: none; color: var(--c-text-secondary); font-size: 12px; }
.context-legend li { display: flex; align-items: center; gap: 5px; }
.context-swatch { display: inline-block; width: 9px; height: 9px; flex-shrink: 0; border: 1px solid var(--c-border); }
.context-swatch.used { background: var(--c-blue); }
.context-swatch.remaining { background: var(--c-bg-muted); }
.context-swatch.low { background: #b7791f; }
.context-swatch.high { background: var(--c-error); }
.details-note { margin: 8px 0; }
.details-error { color: var(--c-error); overflow-wrap: anywhere; }
@media (max-width: 700px), (pointer: coarse) {
  .rename-button { width: 44px; height: 44px; }
  .rename-input { min-height: 44px; font-size: 16px; }
}
@media (max-width: 700px) {
  .session-heading { padding: 4px 8px; }
  .session-heading :deep(.composer-control) { gap: 7px; }
  .session-details dl { grid-template-columns: minmax(0, 72px) minmax(0, 1fr); gap: 10px 8px; }
  .heading-name { font-size: 13px; }
  .heading-folder { max-width: 38%; font-size: 12px; }
}
</style>
