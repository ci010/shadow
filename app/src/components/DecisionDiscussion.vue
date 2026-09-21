<template>
  <details class="decision-discussion" @toggle="toggle">
    <summary>{{ canRequest ? 'Need context or a revised question?' : 'Questions and revisions' }}</summary>
    <p>Asking here does not select an answer. Automatic defaults are paused after a request is accepted.
      Explanations are generated without tools from saved context, not an independent investigation.</p>
    <template v-if="canRequest || canInvalidate">
      <label :for="inputId">What needs explaining or changing?</label>
      <textarea :id="inputId" v-model="question" rows="3" maxlength="4000" :disabled="sending" />
      <div v-if="canRequest" class="discussion-actions">
        <button type="button" :disabled="sending || running || !question.trim()" @click="submit('clarify')">Ask for explanation</button>
        <button type="button" :disabled="sending || running || !question.trim()" @click="submit('revise')">Request revised question</button>
        <button type="button" :disabled="sending || running || !question.trim()" @click="submit('investigation')">Return for investigation · no approval</button>
        <button type="button" :disabled="sending || running || !question.trim()" @click="submit('deferred')">Defer · continue independent work</button>
      </div>
      <p v-if="canRequest">A revision remains unanswered. Investigation or deferral ends this wait without selecting an option; the original session can investigate or continue only already-authorized unaffected work.</p>
      <button v-if="canInvalidate" type="button" :disabled="sending || !question.trim()" @click="submit('invalidate')">Mark premise obsolete and flag dependent decisions</button>
      <p v-if="canInvalidate">Explain which premise changed. This preserves historical answers, flags linked decisions for revalidation and does not undo completed work.</p>
    </template>
    <p v-if="loading || sending" role="status">{{ sending ? 'Requesting discussion...' : 'Loading discussion...' }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <article v-for="review in reviews" :key="review.id" class="discussion-record">
      <strong>{{ review.kind === 'clarify' ? 'User asked for context' : 'User requested revision' }}</strong>
      <p class="discussion-text">{{ review.question }}</p>
      <p v-if="review.status === 'running'" role="status">Preparing a tool-free response. The original decision is still unanswered.</p>
      <p v-else-if="review.status === 'interrupted'">This discussion was interrupted. It has not been resumed automatically.</p>
      <template v-else>
        <strong>{{ review.status === 'failed' ? 'Discussion failed' : 'Agent explanation — not an answer or approval' }}</strong>
        <p class="discussion-text">{{ review.response }}</p>
        <p v-if="review.replacement">New version: {{ review.replacement.requestId }}. Use the current question's answer controls.</p>
      </template>
    </article>
    <p v-if="!loading && !reviews.length && !error">No discussions have been recorded for this version.</p>
    <button type="button" :disabled="loading" @click="refresh">Refresh discussion</button>
  </details>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import { apiUrl } from '../api-url.ts'
import { decisionKey } from '../decision-graph.ts'
import { parseYieldReview, type YieldReference, type YieldReview } from '../../../src/sessions/yield-contract.ts'
const props = defineProps<{ reference: YieldReference; apiBase: string; canRequest?: boolean; canInvalidate?: boolean }>()
const emit = defineEmits<{ updated: [] }>()
const inputId = `decision-discussion-${useId()}`
const question = ref('')
const reviews = ref<YieldReview[]>([])
const loading = ref(false)
const sending = ref(false)
const error = ref('')
const notice = ref('')
const running = computed(() => reviews.value.some(review => review.status === 'running'))
let opened = false
let generation = 0
let read: AbortController | undefined
let write: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let attempt: { key: string; id: string } | undefined
function stop() { generation++; read?.abort(); write?.abort(); clearTimeout(timer); loading.value = sending.value = false }
async function refresh() {
  if (!opened || read && loading.value) return
  const current = generation
  const controller = new AbortController()
  read = controller
  loading.value = true
  clearTimeout(timer)
  try {
    const url = apiUrl(props.apiBase, `/api/sessions/${encodeURIComponent(props.reference.sessionId)}/decisions/reviews`,
      { physicalId: props.reference.physicalId, requestId: props.reference.requestId })
    const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
    if (!response.ok) throw new Error('Could not load this decision discussion.')
    const data = await response.json()
    if (!Array.isArray(data.reviews)) throw new Error('Invalid decision discussion response.')
    const next = data.reviews.map(parseYieldReview)
    if (next.some((review: YieldReview) => decisionKey(review.reference) !== decisionKey(props.reference))) throw new Error('Discussion origin does not match.')
    if (generation !== current || controller.signal.aborted) return
    reviews.value = next
    error.value = ''
    if (running.value) timer = setTimeout(() => { void refresh() }, 1500)
    else emit('updated')
  } catch (cause) {
    if (generation === current && !controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load discussion.'
  } finally { if (generation === current) loading.value = false }
}
async function submit(kind: 'clarify' | 'revise' | 'investigation' | 'deferred' | 'invalidate') {
  if (!(kind === 'invalidate' ? props.canInvalidate : props.canRequest) || sending.value || (running.value && kind !== 'invalidate') || !question.value.trim()) return
  stop()
  const current = generation
  const controller = new AbortController()
  write = controller
  sending.value = true
  error.value = ''
  notice.value = ''
  const key = JSON.stringify([props.reference, kind, question.value.trim()])
  if (attempt?.key !== key) attempt = { key, id: crypto.randomUUID() }
  try {
    const discussion = kind === 'clarify' || kind === 'revise'
    const route = discussion ? 'yield/reviews' : kind === 'invalidate' ? 'decisions/invalidate' : 'yield/follow-up'
    const body = discussion ? { id: attempt.id, requestId: props.reference.requestId, kind, question: question.value.trim() }
      : kind === 'invalidate' ? { reference: props.reference, reason: question.value.trim() }
      : { requestId: props.reference.requestId, kind, reason: question.value.trim() }
    const response = await fetch(apiUrl(props.apiBase, `/api/sessions/${encodeURIComponent(props.reference.sessionId)}/${route}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(typeof data.message === 'string' ? data.message : 'Discussion was not accepted. Reload the current question.')
    if (generation !== current || controller.signal.aborted) return
    if (!discussion) {
      if (kind === 'invalidate' ? data.approved !== false || !Array.isArray(data.affected)
        : data.continuation?.approved !== false || data.continuation?.requestId !== props.reference.requestId
          || data.continuation?.disposition !== kind) throw new Error('Decision follow-up receipt did not match.')
      notice.value = kind === 'invalidate' ? 'Premise marked obsolete. Linked decisions require revalidation.' : 'No option was selected. The original session received your follow-up.'
      if (kind === 'invalidate' && data.notificationErrors?.length) error.value = 'The premise was saved as obsolete, but some sessions could not be notified. Their decision history will require revalidation when reopened.'
      question.value = ''; attempt = undefined; emit('updated')
      return
    }
    const review = parseYieldReview(data.review)
    if (review.id !== attempt?.id || decisionKey(review.reference) !== decisionKey(props.reference)) throw new Error('Discussion receipt did not match.')
    reviews.value = [...reviews.value.filter(item => item.id !== review.id), review]
    attempt = undefined
    question.value = ''
    emit('updated')
    void refresh()
  } catch (cause) {
    if (generation === current && !controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not request discussion.'
  } finally { if (generation === current) sending.value = false }
}
function toggle(event: Event) {
  opened = (event.currentTarget as HTMLDetailsElement).open
  if (opened) void refresh()
  else stop()
}
watch(() => JSON.stringify([props.apiBase, decisionKey(props.reference)]), () => {
  stop(); reviews.value = []; question.value = ''; error.value = notice.value = ''; attempt = undefined
  if (opened) void refresh()
})
watch(() => [props.canRequest, props.canInvalidate], ([request, invalidate], [priorRequest, priorInvalidate]) => {
  if ((priorRequest && !request) || (priorInvalidate && !invalidate)) { stop(); if (opened) void refresh() }
})
onUnmounted(stop)
</script>

<style scoped>
.decision-discussion { min-width: 0; margin: 12px 0; padding: 8px; border: 1px dashed var(--c-border); font-size: 12px; }
summary { cursor: pointer; }
p { margin: 8px 0; }
textarea { display: block; box-sizing: border-box; width: 100%; padding: 8px; border: 1px solid var(--c-border); background: var(--c-bg-input); color: var(--c-text); resize: vertical; }
.discussion-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
button { padding: 6px 10px; min-height: 36px; border: 1px solid var(--c-border); cursor: pointer; background: var(--c-bg-card); }
button:disabled { opacity: .5; cursor: default; }
.discussion-record { margin: 8px 0; padding: 8px; background: var(--c-bg-soft); }
.discussion-text { white-space: pre-wrap; overflow-wrap: anywhere; }
[role="alert"] { color: var(--c-error); }
button:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 600px) { textarea { font-size: 16px; } button { min-height: 44px; } }
</style>
