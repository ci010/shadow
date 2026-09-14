<template>
  <section v-if="enabled && (request || error)" class="yield-question" aria-label="Pending question">
    <form v-if="request" @submit.prevent="submit">
      <fieldset :disabled="!answerable || busy" :aria-describedby="`${id}-status ${id}-deadline`">
        <legend>{{ request.question }}</legend>
        <label v-for="option in request.options" :key="option" class="yield-option" :class="{ selected: selected === option }">
          <input v-model="selected" type="radio" :name="id" :value="option">
          <span class="yield-option-text">{{ option }}</span>
          <span v-if="option === request.defaultOption" class="yield-default">Default</span>
        </label>
      </fieldset>
      <p :id="`${id}-status`" class="yield-status">{{ request.recipient.kind === 'parent'
        ? 'Waiting for the parent session. Only that session can answer.'
        : canAnswer ? 'Choose one option to continue.' : 'Waiting for an authorized user. You have read-only access.' }}</p>
      <p :id="`${id}-deadline`" class="yield-status">{{ yieldDeadlineText(request, now) }}</p>
      <div class="yield-actions">
        <button v-if="answerable" class="btn btn-sm yield-cancel" type="button" :disabled="busy" title="Cancel this question and stop the current task without choosing an option" @click="cancelQuestion">{{ cancelling ? 'Cancelling…' : 'Cancel task' }}</button>
        <button v-if="answerable" class="btn btn-sm yield-continue" type="submit" :disabled="busy">{{ submitting ? 'Submitting…' : 'Continue' }}</button>
        <button v-if="error" class="btn btn-sm" type="button" :disabled="loading || busy" @click="refresh">{{ loading ? 'Reloading…' : 'Reload question' }}</button>
      </div>
    </form>
    <p v-if="error" class="yield-error" role="alert">{{ error }}</p>
    <button v-if="error && !request" class="btn btn-sm" type="button" :disabled="loading" @click="refresh">{{ loading ? 'Retrying…' : 'Retry' }}</button>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import { useYieldRequest, yieldDeadlineText } from '../yield-requests.ts'

const props = defineProps<{ apiBase: string; sessionId: string; active: boolean; stage?: string | null; canAnswer: boolean }>()
const emit = defineEmits<{ cancelled: [sessionId: string] }>()
const id = `yield-${useId()}`
const documentVisible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
const enabled = computed(() => props.active && documentVisible.value)
const { request, selected, error, submitting, cancelling, busy, loading, now, answerable, refresh, submit, cancelQuestion: cancelPendingQuestion } = useYieldRequest(
  () => ({ ...props, active: enabled.value }),
)
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
.yield-continue { margin-left: auto; }
.yield-error { margin: 10px 0; color: var(--c-error); font-size: 12px; }
.btn { min-height: 32px; padding: 5px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--c-bg-muted); }
.btn:active:not(:disabled) { background: var(--c-selection-bg); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.yield-continue { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.yield-continue:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 600px) { .yield-question { width: calc(100% - 24px); padding: 12px; } }
</style>
