<template>
  <div class="process-output">
    <div class="output-controls">
      <span>{{ status }}</span>
      <button type="button" @click="following = !following">{{ following ? t('Pause following') : t('Follow output') }}</button>
      <button type="button" :disabled="!output" @click="copy">{{ copied ? t('Copied') : t('Copy') }}</button>
      <button v-if="error" type="button" @click="refresh">{{ t('Retry') }}</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="truncated" role="status">{{ t('Output truncated: showing the last 65,536 characters.') }}</p>
    <pre ref="viewport" tabindex="0" :aria-label="t('Process output')" @scroll="onScroll">{{ output || t('No output yet.') }}</pre>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { t } from '../i18n.ts'
import { fetchBackgroundOutput } from '../background-tasks.ts'
import { createLiveRefresh } from '../live-refresh.ts'
const props = defineProps<{ apiBase: string; sessionId: string; taskId: string; active: boolean }>()
const output = ref(''), status = ref(''), error = ref('')
const truncated = ref(false), following = ref(true), copied = ref(false)
const viewport = ref<HTMLElement>()
let refresh = () => {}
function onScroll() {
  const el = viewport.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 24) following.value = false
}
async function scrollBottom() { await nextTick(); if (following.value && viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight }
watch(following, () => { void scrollBottom() })
async function copy() {
  try { await navigator.clipboard.writeText(output.value); copied.value = true }
  catch { error.value = t('Could not copy output. Select and copy the text manually.') }
}
watch(() => [props.apiBase, props.sessionId, props.taskId, props.active] as const, ([base, sessionId, id, active], old, onCleanup) => {
  if (!old || old[0] !== base || old[1] !== sessionId || old[2] !== id) {
    output.value = ''; status.value = ''; error.value = ''; following.value = true; copied.value = false
  }
  refresh = () => {}
  if (!active) return
  const snapshot = createLiveRefresh({
    load: signal => fetchBackgroundOutput(base, sessionId, id, signal),
    apply: value => {
      output.value = value.output; status.value = value.status; truncated.value = value.truncated
      error.value = ''; copied.value = false
      void scrollBottom()
    },
    onError: () => { error.value = t('Process output is unavailable. Retry to reconnect.') },
  })
  refresh = () => snapshot.refresh()
  const timer = setInterval(() => {
    if (!['completed', 'failed', 'cancelled'].includes(status.value)) refresh()
  }, 1500)
  refresh()
  onCleanup(() => { clearInterval(timer); snapshot.dispose() })
}, { immediate: true })
</script>

<style scoped>
.process-output { margin-top: 8px; min-width: 0; }
.output-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
button { min-height: 32px; border: 1px solid var(--c-border); background: var(--c-bg-soft); color: var(--c-text); cursor: pointer; font: inherit; }
button:hover { background: var(--c-bg-muted); }
button:focus-visible, pre:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
pre { max-height: 280px; overflow: auto; padding: 8px; background: var(--c-bg-soft); color: var(--c-text); border: 1px solid var(--c-border); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
p { font-size: 12px; }
@media (max-width: 700px) { button { min-height: 44px; } }
</style>
