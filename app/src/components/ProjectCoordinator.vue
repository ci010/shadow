<template>
  <span class="project-coordinator">
    <button type="button" class="coordinator-entry" :class="{ selected }" :aria-disabled="loading"
      :aria-label="`Open Project coordination in ${projectName}`" :aria-current="selected ? 'page' : undefined"
      :aria-busy="loading" @click="open">
      <span :title="projectName">{{ projectName }}</span>
    </button>
    <span v-if="error" class="coordinator-error" role="alert">{{ error }} <button type="button" class="text-action" @click="open">Retry</button></span>
  </span>
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
.project-coordinator { display: block; min-width: 0; }
.coordinator-entry { display: flex; align-items: center; width: 100%; min-width: 0; min-height: var(--sidebar-row-height); padding: 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); text-align: left; font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.coordinator-entry > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.coordinator-entry:hover { background: var(--c-bg-muted); color: var(--c-text); }
.coordinator-entry.selected { color: var(--c-primary); }
.coordinator-entry.selected > span { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px; }
.coordinator-entry[aria-busy="true"] { cursor: progress; }
.coordinator-entry:focus-visible, .text-action:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.coordinator-error { display: block; margin: 6px 4px; color: var(--c-error); font-size: 12px; font-weight: 400; overflow-wrap: anywhere; }
.text-action { border: 0; padding: 0; background: transparent; color: inherit; text-decoration: underline; cursor: pointer; }
</style>
