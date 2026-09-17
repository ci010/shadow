<template>
  <div class="project-coordinator">
    <button class="coordinator-entry" :class="{ selected }" :disabled="loading"
      :aria-label="`Open Project coordination in ${projectName}`" :aria-current="selected ? 'page' : undefined"
      :aria-busy="loading" @click="open">
      <span :class="loading ? 'i-lucide-loader-circle' : 'i-lucide-network'" class="w-4 h-4" aria-hidden="true" />
      <span>{{ loading ? 'Opening coordination…' : 'Project coordination' }}</span>
    </button>
    <p v-if="error" class="coordinator-error" role="alert">{{ error }} <button class="text-action" @click="open">Retry</button></p>
  </div>
</template>

<script setup lang="ts">
import { onDeactivated, onUnmounted, ref, watch } from 'vue'
import { ensureProjectOrchestrator } from '../projects.ts'

const props = defineProps<{
  apiBase: string; projectId: string; projectName: string; selected: boolean; navigationKey: string; pendingProjectId?: string
}>()
const emit = defineEmits<{ open: [id: string]; opening: [] }>()
const loading = ref(false)
const error = ref('')
let request: AbortController | undefined
function cancel() {
  request?.abort()
  request = undefined
  loading.value = false
  error.value = ''
}
async function open() {
  if (props.selected || request) return
  emit('opening')
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const id = await ensureProjectOrchestrator(props.apiBase, props.projectId, controller.signal)
    if (!controller.signal.aborted && request === controller) emit('open', id)
  } catch (cause) {
    if (!controller.signal.aborted && request === controller) {
      error.value = cause instanceof Error ? cause.message : 'Could not open Project coordination. Retry.'
    }
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}
watch(() => [props.apiBase, props.projectId, props.navigationKey], cancel, { flush: 'sync' })
watch(() => props.pendingProjectId, id => { if (id && id !== props.projectId) cancel() }, { flush: 'sync' })
onDeactivated(cancel)
onUnmounted(cancel)
</script>

<style scoped>
.project-coordinator { padding: 2px 8px 8px; }
.coordinator-entry { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); text-align: left; font: inherit; font-size: 13px; cursor: pointer; }
.coordinator-entry:hover, .coordinator-entry.selected { background: var(--c-bg-muted); color: var(--c-text); }
.coordinator-entry.selected { border-color: var(--c-border); }
.coordinator-entry:disabled { cursor: progress; }
.coordinator-entry:focus-visible, .text-action:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.coordinator-error { margin: 6px 10px; color: var(--c-error); font-size: 12px; overflow-wrap: anywhere; }
.text-action { border: 0; padding: 0; background: transparent; color: inherit; text-decoration: underline; cursor: pointer; }
</style>
