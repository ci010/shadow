<template>
  <details class="decision-source" @toggle="onToggle">
    <summary>{{ answered ? t('Answered decision') : t('Related decision') }} · {{ source.sessionId }}</summary>
    <p class="source-note">{{ answered ? t('Reference from the answer receipt.') : t('Agent-selected reference.') }} {{ t('The record\'s existence is checked; this is not proof of causation or permission.') }}</p>
    <p v-if="loading" role="status">{{ t('Loading original decision…') }}</p>
    <p v-else-if="error" role="alert">{{ error }} <button type="button" @click="load">{{ t('Retry') }}</button></p>
    <template v-else-if="record">
      <strong>{{ decisionStatusLabel(recordedDecision(record).status) }}</strong>
      <p class="source-question">{{ record.request.question }}</p>
      <ol><li v-for="option in record.request.options" :key="option">{{ option }}</li></ol>
      <p v-if="record.answer"><strong>{{ t('Recorded response:') }}</strong> {{ record.answer.option }}</p>
      <p v-else-if="record.closed">{{ record.closed.message }}</p>
      <p v-else>{{ t('No confirmed answer in this record. This preview does not indicate an active wait.') }}</p>
      <p class="source-note">{{ t('Request:') }} {{ record.request.id }} {{ t('· Segment:') }} {{ record.request.origin?.physicalId }}</p>
      <button type="button" @click="emit('inspect', source.sessionId)">{{ t('Open source session') }}</button>
    </template>
  </details>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { onUnmounted, ref, shallowRef, watch } from 'vue'
import { decisionReader } from '../decision-graph.ts'
import { decisionStatusLabel, recordedDecision } from '../yield-history.ts'
import type { YieldDecisionRecord, YieldReference } from '../../../src/sessions/yield-contract.ts'

const props = defineProps<{ source: YieldReference; apiBase: string; answered?: boolean }>()
const emit = defineEmits<{ inspect: [sessionId: string] }>()
const record = shallowRef<YieldDecisionRecord | null>(null)
const error = ref('')
const loading = ref(false)
let controller: AbortController | undefined
let opened = false

async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  error.value = ''
  const source = props.source
  try {
    const next = await decisionReader(props.apiBase, current.signal)(source)
    if (!current.signal.aborted) record.value = next
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not load the original decision.')
  } finally {
    if (controller === current) loading.value = false
  }
}

function onToggle(event: Event) {
  opened = (event.currentTarget as HTMLDetailsElement).open
  if (opened) void load()
}
watch(() => JSON.stringify([props.apiBase, props.source]), () => {
  controller?.abort()
  record.value = null
  error.value = ''
  if (opened) void load()
})
onUnmounted(() => controller?.abort())
</script>

<style scoped>
.decision-source { margin: 12px 0; padding: 8px 12px; border: 1px dashed var(--c-border); background: var(--c-bg-soft); }
summary { cursor: pointer; }
.source-note { color: var(--c-text-secondary); font-size: 12px; }
.source-question, li { white-space: pre-wrap; }
ol { padding-left: 24px; list-style: upper-alpha; }
button { padding: 4px 8px; border: 1px solid var(--c-border); cursor: pointer; }
summary:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
