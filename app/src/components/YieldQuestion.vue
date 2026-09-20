<template>
  <section v-if="enabled && (request || error)" class="yield-question" :class="{ 'yield-question-custom': customMode }" aria-label="Pending question">
    <form v-if="request" @submit.prevent="submit">
      <div class="yield-body">
        <fieldset :disabled="!answerable || busy" :aria-describedby="`${id}-status ${id}-deadline`">
          <legend>{{ request.question }}</legend>
          <div v-if="request.options.length === 2" class="yield-binary">
            <button v-for="option in request.options" :key="option" type="button" class="btn yield-choice" @click="choose(option)">
              <span>{{ option }}</span>
              <span v-if="option === request.defaultOption && request.deadline" class="yield-default">Default</span>
            </button>
            <button type="button" class="btn yield-custom-toggle" :aria-expanded="customMode" :aria-controls="`${id}-custom`" @click="openCustomResponse">Write my own response...</button>
          </div>
          <template v-else>
            <label v-for="option in request.options" :key="option" class="yield-option" :class="{ selected: !customMode && selected === option }">
              <input type="radio" :name="id" :value="option" :checked="!customMode && selected === option" @change="selected = option; customMode = false">
              <span class="yield-option-text">{{ option }}</span>
              <span v-if="option === request.defaultOption" class="yield-default">Default</span>
            </label>
            <button type="button" class="btn yield-custom-toggle" :aria-expanded="customMode" :aria-controls="`${id}-custom`" @click="openCustomResponse">Write my own response...</button>
          </template>
          <div v-if="customMode" :id="`${id}-custom`" class="yield-custom">
            <label :for="`${id}-response`">Your response</label>
            <textarea :id="`${id}-response`" ref="customInput" v-model="customText" rows="3" required :maxlength="MAX_YIELD_CUSTOM_TEXT_LENGTH" />
          </div>
        </fieldset>
        <p :id="`${id}-status`" class="yield-status">{{ request.recipient.kind === 'parent'
          ? 'Waiting for the parent session. Only that session can answer.'
          : canAnswer ? 'Choose an option or write your own response.' : 'Waiting for an authorized user. You have read-only access.' }}</p>
        <p :id="`${id}-deadline`" class="yield-status">{{ yieldDeadlineText(request, now) }}</p>
      </div>
      <div class="yield-actions">
        <button v-if="answerable" class="btn btn-sm yield-cancel" type="button" :disabled="busy" title="Cancel this question and stop the current task without choosing an option" @click="cancelQuestion">{{ cancelling ? 'Cancelling…' : 'Cancel task' }}</button>
        <button v-if="answerable && (request.options.length !== 2 || customMode)" class="btn btn-sm yield-continue" type="submit" :disabled="busy || (customMode && !customText.trim())">{{ submitting ? 'Submitting…' : customMode ? 'Send response' : 'Continue' }}</button>
        <span v-if="request.options.length === 2 && submitting && !customMode" role="status" class="yield-status">Submitting…</span>
        <button v-if="error" class="btn btn-sm" type="button" :disabled="loading || busy" @click="refresh">{{ loading ? 'Reloading…' : 'Reload question' }}</button>
      </div>
    </form>
    <p v-if="error" class="yield-error" role="alert">{{ error }}</p>
    <button v-if="error && !request" class="btn btn-sm" type="button" :disabled="loading" @click="refresh">{{ loading ? 'Retrying…' : 'Retry' }}</button>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId } from 'vue'
import { MAX_YIELD_CUSTOM_TEXT_LENGTH, useYieldRequest, yieldDeadlineText } from '../yield-requests.ts'

const props = defineProps<{ apiBase: string; sessionId: string; active: boolean; stage?: string | null; canAnswer: boolean }>()
const emit = defineEmits<{ cancelled: [sessionId: string] }>()
const id = `yield-${useId()}`
const documentVisible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
const enabled = computed(() => props.active && documentVisible.value)
const customInput = ref<HTMLTextAreaElement>()
const { request, selected, customMode, customText, error, submitting, cancelling, busy, loading, now, answerable, refresh, submit, choose, cancelQuestion: cancelPendingQuestion } = useYieldRequest(
  () => ({ ...props, active: enabled.value }),
)
async function openCustomResponse() {
  if (!answerable.value || busy.value) return
  customMode.value = true
  await nextTick()
  customInput.value?.focus()
}
async function cancelQuestion() {
  const sessionId = props.sessionId
  if (await cancelPendingQuestion()) emit('cancelled', sessionId)
}
function updateVisibility() { documentVisible.value = document.visibilityState !== 'hidden' }
onMounted(() => document.addEventListener('visibilitychange', updateVisibility))
onUnmounted(() => document.removeEventListener('visibilitychange', updateVisibility))
</script>

<style scoped>
.yield-question { box-sizing: border-box; flex: 0 1 auto; min-height: 0; width: calc(100% - 40px); max-width: 860px; max-height: min(42dvh, 420px); overflow-y: auto; overscroll-behavior: contain; margin: 8px auto 0; padding: 14px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); color: var(--c-text); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.yield-question:last-child { margin-bottom: 16px; }
.yield-question-custom { display: flex; flex-direction: column; max-height: min(60dvh, 540px); overflow: hidden; }
.yield-question-custom form { display: flex; flex-direction: column; min-height: 0; }
.yield-question-custom .yield-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 3px; }
.yield-question-custom .yield-actions { flex-shrink: 0; }
.yield-question-custom .yield-error { flex-shrink: 0; max-height: 6em; overflow-y: auto; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend { width: 100%; margin-bottom: 10px; padding: 0; font-size: 14px; font-weight: 600; white-space: pre-wrap; }
.yield-option { display: flex; align-items: flex-start; gap: 9px; min-height: 36px; box-sizing: border-box; padding: 8px; cursor: pointer; }
.yield-option:hover { background: var(--c-bg-muted); }
.yield-option.selected { background: var(--c-selection-bg); }
.yield-option input { flex: 0 0 auto; margin: 3px 0 0; accent-color: var(--c-blue); }
.yield-option-text { flex: 1; min-width: 0; white-space: pre-wrap; }
.yield-default { flex: 0 0 auto; padding: 0 5px; border: 1px solid var(--c-border); color: var(--c-text-secondary); font-size: 11px; }
fieldset:disabled .yield-option { cursor: default; }
.yield-status { margin: 8px 0 0; color: var(--c-text-secondary); font-size: 12px; }
.yield-status + .yield-status { margin-top: 3px; }
.yield-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.yield-actions:empty { display: none; }
.yield-binary { display: flex; flex-wrap: wrap; gap: 8px; }
.yield-binary .yield-choice { display: flex; align-items: center; gap: 8px; min-height: 36px; max-width: 100%; text-align: start; white-space: pre-wrap; overflow-wrap: anywhere; }
.yield-choice > span:first-child { min-width: 0; }
.yield-custom-toggle { min-height: 36px; text-align: start; white-space: normal; }
.yield-custom { display: grid; gap: 6px; margin-top: 12px; }
.yield-custom textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: 76px; padding: 8px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; line-height: 1.5; resize: vertical; }
.yield-continue { margin-left: auto; }
.yield-error { margin: 10px 0; color: var(--c-error); font-size: 12px; }
.btn { min-height: 32px; padding: 5px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--c-bg-muted); }
.btn:active:not(:disabled) { background: var(--c-selection-bg); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.yield-continue { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.yield-continue:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 600px) { .yield-question { width: calc(100% - 24px); padding: 12px; } .yield-custom textarea { font-size: 16px; } }
</style>
