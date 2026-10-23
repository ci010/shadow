<template>
  <section class="learning-runtime" :aria-labelledby="headingId">
    <h3 :id="headingId">{{ t('Runtime status') }}</h3>
    <p v-if="loading && !status" role="status">{{ t('Loading learning status...') }}</p>
    <div v-if="error" class="learning-error" role="alert">
      <p>{{ error }}</p>
      <button type="button" class="btn btn-sm" :disabled="loading" @click="refresh">{{ t('Retry learning status') }}</button>
    </div>
    <template v-if="status">
      <p>{{ status.stopped ? t('Learning service stopped.') : status.enabled ? t('Automatic learning is enabled.') : t('Automatic learning is paused.') }}</p>
      <dl class="learning-pipelines">
        <div v-for="pipeline in learningPipelines" :key="pipeline.id" class="learning-pipeline">
          <dt>{{ pipeline.label }}</dt>
          <dd>
            <span>{{ learningPipelineState(status, status.pipelines[pipeline.id]) }}</span>
            <span v-if="status.pipelines[pipeline.id].lastCheckedAt">{{ t('Last checked:') }} <time :datetime="status.pipelines[pipeline.id].lastCheckedAt">{{ formatTime(status.pipelines[pipeline.id].lastCheckedAt) }}</time></span>
            <span v-if="status.pipelines[pipeline.id].lastDispatchedAt">{{ t('Last launch accepted:') }} <time :datetime="status.pipelines[pipeline.id].lastDispatchedAt">{{ formatTime(status.pipelines[pipeline.id].lastDispatchedAt) }}</time></span>
            <span v-if="status.pipelines[pipeline.id].lastError" class="learning-error">{{ t('Last error:') }} {{ status.pipelines[pipeline.id].lastError }}</span>
          </dd>
        </div>
      </dl>
      <p class="learning-help">{{ t('Launch acceptance is not task completion. Open Self-reflection conversations to follow the resulting work.') }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { t, formatDateTime } from '../i18n.ts'
import { onUnmounted, ref, useId, watch } from 'vue'
import { fetchLearningStatus, learningPipelines, learningPipelineState, type LearningStatus } from '../learning-settings.ts'

const props = withDefaults(defineProps<{ apiBase: string; projectId: string; active: boolean; revision?: number }>(), { revision: 0 })
const headingId = useId()
const status = ref<LearningStatus>()
const loading = ref(false)
const error = ref('')
let request: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const formatTime = (value?: string) => value ? formatDateTime(new Date(value)) : ''
function stop() {
  clearTimeout(timer)
  request?.abort()
  request = undefined
  loading.value = false
}
async function refresh() {
  stop()
  if (!props.active || disposed) return
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const next = await fetchLearningStatus(props.apiBase, props.projectId, controller.signal)
    if (!controller.signal.aborted) status.value = next
  } catch (cause) {
    if (!controller.signal.aborted) {
      status.value = undefined
      error.value = cause instanceof Error ? cause.message : t('Could not load learning status. Retry.')
    }
  } finally {
    if (request === controller) {
      request = undefined
      loading.value = false
      if (props.active && !disposed) timer = setTimeout(refresh, 5000)
    }
  }
}
watch(() => [props.active, props.apiBase, props.projectId, props.revision], () => {
  status.value = undefined
  if (props.active) void refresh()
  else stop()
}, { immediate: true })
onUnmounted(() => { disposed = true; stop() })
</script>

<style scoped>
.learning-runtime { margin-top: 28px; max-width: 600px; font-size: 13px; }
.learning-runtime h3 { margin: 0 0 12px; font-size: 15px; }
.learning-pipelines { margin: 16px 0; }
.learning-pipeline { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--c-border); }
.learning-pipeline dt { font-weight: 600; }
.learning-pipeline dd { display: grid; gap: 6px; margin: 0; min-width: 0; overflow-wrap: anywhere; }
.learning-help { color: var(--c-text-secondary); line-height: 1.6; }
.learning-error { color: var(--c-error); overflow-wrap: anywhere; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 500px) { .learning-pipeline { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
</style>
