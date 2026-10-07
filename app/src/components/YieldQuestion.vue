<template>
  <section v-if="enabled && (request || error)" class="yield-question" :class="{ 'yield-question-custom': customMode }" :aria-label="t('Pending question')">
    <form v-if="request" @submit.prevent="submit" @keydown="handleKeydown">
      <header class="yield-heading">
        <span>{{ inputQuestion ? t('Input') : t('Decision') }} · {{ request.recipient.kind === 'user' ? t('Needs your reply') : request.recipient.kind === 'parent' ? t('Waiting for parent') : t('Waiting for caller') }}</span>
        <span class="i-lucide-signpost" aria-hidden="true" />
      </header>
      <div class="yield-body">
        <DecisionBrief v-if="decisionRequest?.brief" :brief="decisionRequest.brief" @inspect="emit('inspect', $event)" />
        <section v-if="decisionRequest?.workProposal" class="work-proposal selectable-text" :aria-label="t('Exact proposed work change')">
          <h3>{{ t('Proposed work · v') }}{{ decisionRequest.workProposal.baseRevision }}</h3>
          <p>{{ t('Change type:') }} {{ decisionRequest.workProposal.change }} {{ t('· New execution:') }} {{ decisionRequest.workProposal.paused ? t('paused') : t('not paused') }}</p>
          <p>{{ decisionRequest.workProposal.definition.objective }}</p>
          <p><strong>{{ t('Acceptance:') }}</strong> {{ decisionRequest.workProposal.definition.acceptance.join('; ') }}</p>
          <p><strong>{{ t('Boundaries:') }}</strong> {{ decisionRequest.workProposal.definition.boundaries.join('; ') || t('Not recorded; no new permission') }}</p>
          <p>{{ decisionRequest.workProposal.reason }}</p>
          <p class="yield-status">{{ t('One approval applies this exact change. The executor must adopt the new version. A custom answer or timeout does not approve it.') }}</p>
        </section>
        <p v-if="decisionRequest?.reportingSessionId" class="yield-status">{{ t('Reporting responsibility:') }} {{ decisionRequest.reportingSessionId }}{{ t('. Answer authority is unchanged.') }}</p>
        <fieldset :disabled="!answerable || busy" :aria-describedby="`${id}-status${request.deadline ? ` ${id}-deadline` : ''}`">
          <legend class="selectable-text">{{ request.question }}</legend>
          <div v-if="decisionRequest" class="yield-options">
            <label v-for="(option, index) in decisionRequest.options" :key="option" class="yield-option" :class="{ selected: !customMode && selected === option }">
              <input class="yield-sr-only" type="radio" :name="id" :value="option" :aria-keyshortcuts="optionLetter(index)"
                :checked="!customMode && selected === option" @change="selected = option; customMode = false">
              <span class="yield-index" aria-hidden="true">{{ optionLetter(index) }}</span>
              <span class="yield-option-text">{{ option }}</span>
              <span v-if="option === decisionRequest.defaultOption" class="yield-default">{{ t('Default') }}</span>
              <span class="yield-selected i-lucide-check" :class="{ visible: !customMode && selected === option }" aria-hidden="true" />
            </label>
            <button type="button" class="yield-option yield-custom-toggle" :class="{ selected: customMode }"
              :aria-expanded="useComposer ? undefined : customMode" :aria-controls="useComposer ? composerId : `${id}-custom`" :aria-keyshortcuts="optionLetter(decisionRequest.options.length)" @click="openCustomResponse">
              <span class="yield-index" aria-hidden="true">{{ optionLetter(decisionRequest.options.length) }}</span>
              <span class="yield-option-text">{{ useComposer ? t('Write your own answer in the message box below') : customMode ? t('Your answer') : t('Or type your own answer...') }}</span>
              <span class="yield-selected i-lucide-check" :class="{ visible: customMode }" aria-hidden="true" />
            </button>
          </div>
          <p v-if="useComposer && answerable" class="yield-composer-note">{{ t('Type your answer in the message box below and send it to reply to this question. You can attach images and files.') }}</p>
          <div v-if="!useComposer && (customMode || inputQuestion)" :id="`${id}-custom`" class="yield-custom" :class="{ 'input-response': inputQuestion }">
            <label :for="`${id}-response`" class="yield-sr-only">{{ t('Your response') }}</label>
            <textarea :id="`${id}-response`" ref="customInput" v-model="customText" rows="3" required
              :placeholder="t('Type your answer...')" :maxlength="MAX_YIELD_CUSTOM_TEXT_LENGTH" />
          </div>
        </fieldset>
        <p :id="`${id}-status`" class="yield-status" :class="{ 'yield-sr-only': answerable }">{{ request.recipient.kind === 'parent'
          ? t('Waiting for the parent session. Only that session can answer.') : request.recipient.kind === 'caller' ? t('Waiting for the authenticated A2A caller.')
          : canAnswer ? inputQuestion ? t('Provide the requested information. This reply does not grant new permissions.') : t('Choose an option, then Continue, or write your own answer. Letter keys select options while this question is focused.') : t('Waiting for an authorized user. You have read-only access.') }}</p>
        <p v-if="request.deadline || decisionRequest?.timeoutPaused || inputQuestion" :id="`${id}-deadline`" class="yield-status">{{ yieldDeadlineText(request, now) }}</p>
        <p v-if="decisionRequest?.supersedes" class="yield-status">{{ t('Revised in response to your feedback:') }} {{ decisionRequest.revisionReason }}{{ t('. This is a new unanswered version.') }}</p>
        <DecisionDiscussion v-if="decisionRequest?.origin && !decisionRequest.ownerOnly && answerable" :exact-proposal="!!decisionRequest.workProposal"
          :key="request.id" :reference="{ sessionId: request.sessionId, physicalId: decisionRequest.origin.physicalId, requestId: request.id }"
          :api-base="apiBase" :can-request="answerable && !busy" @updated="refresh" />
      </div>
      <div class="yield-actions">
        <button v-if="error" class="btn yield-reload" type="button" :disabled="loading || busy" @click="refresh">{{ loading ? t('Reloading…') : t('Reload question') }}</button>
        <button v-if="answerable" class="btn yield-cancel" type="button" :disabled="busy" :title="decisionRequest?.ownerOnly ? t('Cancel only this confirmation without choosing an option') : t('Cancel this question and stop the current task without choosing an option')" @click="cancelQuestion">{{ cancelling ? t('Cancelling…') : decisionRequest?.ownerOnly ? t('Cancel confirmation') : t('Cancel task') }}</button>
        <button v-if="answerable && !(useComposer && (inputQuestion || customMode))" class="btn yield-continue" type="submit" :disabled="busy || (customMode && !customText.trim())">
          <span>{{ submitting ? t('Submitting…') : customMode ? t('Send response') : t('Continue') }}</span>
          <span v-if="!customMode" class="i-lucide-corner-down-left yield-enter" aria-hidden="true" />
        </button>
      </div>
    </form>
    <p v-if="error" class="yield-error" role="alert">{{ error }}</p>
    <button v-if="error && !request" class="btn btn-sm" type="button" :disabled="loading" @click="refresh">{{ loading ? t('Retrying…') : t('Retry') }}</button>
  </section>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { MAX_YIELD_CUSTOM_TEXT_LENGTH, useYieldRequest, yieldDeadlineText, isInputRequest, type AskRequest } from '../yield-requests.ts'
import DecisionDiscussion from './DecisionDiscussion.vue'
import DecisionBrief from './DecisionBrief.vue'

const props = defineProps<{ apiBase: string; sessionId: string; active: boolean; stage?: string | null; canAnswer: boolean; expectedRequestId?: string; useComposer?: boolean; composerId?: string; composerBusy?: boolean }>()
const emit = defineEmits<{ cancelled: [sessionId: string]; request: [request: AskRequest | null]; inspect: [sessionId: string]; custom: [] }>()
const id = `yield-${useId()}`
const documentVisible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
const enabled = computed(() => props.active && documentVisible.value)
const customInput = ref<HTMLTextAreaElement>()
const { request, selected, customMode, customText, error, submitting, cancelling, busy: requestBusy, loading, now, answerable, refresh, submit, submitCustom, cancelQuestion: cancelPendingQuestion } = useYieldRequest(
  () => ({ ...props, active: enabled.value }),
)
const busy = computed(() => requestBusy.value || props.composerBusy)
defineExpose({ submitCustom, busy })
const inputQuestion = computed(() => !!request.value && isInputRequest(request.value))
const decisionRequest = computed(() => request.value && !isInputRequest(request.value) ? request.value : null)
watch(request, (value, previous) => {
  if (value?.id !== previous?.id) emit('request', value)
}, { immediate: true })
function optionLetter(index: number) { return String.fromCharCode(65 + index) }
function handleKeydown(event: KeyboardEvent) {
  if (event.target instanceof HTMLTextAreaElement && event.target === customInput.value
    && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !event.repeat) {
    event.preventDefault()
    if (answerable.value && !busy.value) void submit()
    return
  }
  if (!answerable.value || busy.value || event.defaultPrevented || event.isComposing || event.repeat
    || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
    || event.target instanceof HTMLTextAreaElement) return
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'radio') {
    event.preventDefault()
    event.stopPropagation()
    if (props.useComposer && customMode.value) emit('custom')
    else void submit()
    return
  }
  if (!/^[a-z]$/i.test(event.key) || !decisionRequest.value) return
  const index = event.key.toUpperCase().charCodeAt(0) - 65
  if (index > decisionRequest.value.options.length) return
  event.preventDefault()
  event.stopPropagation()
  if (index === decisionRequest.value.options.length) {
    void openCustomResponse()
  } else {
    selected.value = decisionRequest.value.options[index]!
    customMode.value = false
    if (event.currentTarget instanceof HTMLFormElement) {
      event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="radio"]')[index]?.focus({ preventScroll: true })
    }
  }
}
async function openCustomResponse() {
  if (!answerable.value || busy.value) return
  customMode.value = true
  if (props.useComposer) { emit('custom'); return }
  await nextTick()
  customInput.value?.focus()
}
async function cancelQuestion() {
  const sessionId = props.sessionId
  const ownerOnly = decisionRequest.value?.ownerOnly
  if (await cancelPendingQuestion() && !ownerOnly) emit('cancelled', sessionId)
}
function updateVisibility() { documentVisible.value = document.visibilityState !== 'hidden' }
onMounted(() => document.addEventListener('visibilitychange', updateVisibility))
onUnmounted(() => {
  document.removeEventListener('visibilitychange', updateVisibility)
  emit('request', null)
})
</script>

<style scoped>
.yield-question { box-sizing: border-box; display: flex; flex-direction: column; flex: 0 1 auto; min-height: 0; width: calc(100% - 40px); max-width: 860px; max-height: min(50dvh, 420px); overflow: hidden; margin: 8px auto 0; padding: 16px; border: 1px solid var(--c-border); border-left: 3px solid var(--c-warn); border-radius: 0; background: var(--c-bg-card); color: var(--c-text); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.yield-question:last-child { margin-bottom: 16px; }
.yield-question-custom { max-height: min(60dvh, 540px); }
.yield-question form { display: flex; flex-direction: column; min-height: 0; }
.yield-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0; padding: 0 4px; margin-bottom: 8px; color: var(--c-text-secondary); font-size: 12px; font-weight: 600; }
.yield-heading > span:last-child { width: 18px; height: 18px; }
.yield-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend { width: 100%; margin-bottom: 16px; padding: 0; font-size: 14px; font-weight: 500; white-space: pre-wrap; }
.yield-options { display: grid; gap: 4px; }
.yield-option { position: relative; display: flex; align-items: flex-start; gap: 12px; width: 100%; min-height: 40px; box-sizing: border-box; padding: 8px 12px; border: 0; border-radius: 0; background: transparent; color: var(--c-text); font: inherit; text-align: start; cursor: pointer; }
fieldset:not(:disabled) .yield-option:hover, .yield-option.selected { background: var(--c-bg-muted); }
.yield-option:has(input:focus-visible) { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.yield-index { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 24px; height: 24px; border: 1px solid var(--c-border); border-radius: 0; background: var(--c-bg-soft); color: var(--c-text-secondary); font-size: 12px; line-height: 1; }
.yield-option.selected .yield-index { border-color: var(--c-border-hover); color: var(--c-text); }
.yield-option-text { flex: 1; min-width: 0; white-space: pre-wrap; }
.yield-default { flex: 0 0 auto; padding-top: 2px; color: var(--c-text-secondary); font-size: 12px; }
.yield-selected { visibility: hidden; flex: 0 0 16px; height: 16px; margin-top: 3px; color: var(--c-text-secondary); }
.yield-selected.visible { visibility: visible; }
fieldset:disabled .yield-option { cursor: default; }
fieldset:disabled .yield-index { color: var(--c-text-muted); }
.yield-status { margin: 8px 0 0; color: var(--c-text-secondary); font-size: 12px; }
.yield-composer-note { margin: 8px 0 0; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; }
.yield-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; flex-shrink: 0; gap: 8px; margin-top: 16px; }
.yield-actions:empty { display: none; }
.yield-reload { margin-right: auto; }
.yield-custom-toggle { color: var(--c-text-muted); }
.yield-custom-toggle.selected { color: var(--c-text); }
.yield-custom { margin: 8px 4px 4px 48px; }
.yield-custom.input-response { margin-inline: 0; }
.yield-custom textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; min-height: 80px; padding: 8px 12px; border: 1px solid var(--c-control-border); border-radius: 0; background: var(--c-bg-input); color: var(--c-text); font: inherit; line-height: 1.5; resize: vertical; }
.yield-custom textarea::placeholder { color: var(--c-text-muted); }
.yield-error { flex-shrink: 0; max-height: 6em; overflow-y: auto; margin: 12px 4px 0; color: var(--c-error); font-size: 12px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 6px 12px; border: 1px solid var(--c-border); border-radius: 0; background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--c-bg-muted); }
.btn:active:not(:disabled) { background: var(--c-selection-bg); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.yield-continue { border-color: transparent; background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.yield-continue:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
.yield-enter { width: 16px; height: 16px; }
.yield-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 600px) { .yield-question { width: calc(100% - 24px); padding: 12px; } .yield-option { padding-inline: 8px; gap: 8px; } .yield-custom { margin-left: 40px; } .yield-custom textarea { font-size: 16px; } }
@media (max-width: 600px), (pointer: coarse) { .yield-option, .btn { min-height: 44px; } }
</style>
