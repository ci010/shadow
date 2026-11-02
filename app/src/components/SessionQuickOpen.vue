<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import { t } from '../i18n.ts'
import type { ProjectRecord } from '../projects.ts'
import type { ProjectLiveLease } from '../project-live-state.ts'
import { useProjectLiveState } from '../composables/useProjectLiveState.ts'
import { searchQuickOpenSessions } from '../session-quick-open.ts'

const props = defineProps<{ apiBase: string; projects: ProjectRecord[] }>()
const emit = defineEmits<{ close: []; select: [projectId: string, sessionId: string] }>()
const live = useProjectLiveState()
const leases = shallowRef<Array<{ projectId: string; lease: ProjectLiveLease }>>([])
const dialog = ref<HTMLDialogElement>()
const input = ref<HTMLInputElement>()
const query = ref('')
const selected = ref(0)
const id = useId()
let previousFocus: HTMLElement | null = null
let closing = false
const composing = ref(false)
watch(() => [props.apiBase, ...props.projects.map(project => project.id)], () => {
  for (const { lease } of leases.value) lease.release()
  leases.value = [...new Set(props.projects.map(project => project.id))].map(projectId => ({
    projectId, lease: live.acquireProject(props.apiBase, projectId),
  }))
  for (const { lease } of leases.value) void lease.graph.read()
}, { immediate: true })
const results = computed(() => searchQuickOpenSessions(leases.value.flatMap(({ projectId, lease }) =>
  (lease.graph.state.value ?? []).map(session => ({ ...session, projectId }))), query.value))
const loading = computed(() => leases.value.some(({ lease }) => lease.graph.state.loading))
const failures = computed(() => leases.value.filter(({ lease }) => lease.graph.state.error))
const projectLabel = (projectId: string) => props.projects.find(project => project.id === projectId)?.name ?? projectId
const optionId = (index: number) => `${id}-option-${index}`
watch([query, results], () => { selected.value = 0 })
watch([selected, results], async () => {
  await nextTick()
  document.getElementById(optionId(selected.value))?.scrollIntoView({ block: 'nearest' })
}, { flush: 'post' })
function close() {
  if (closing) return
  closing = true
  dialog.value?.close()
  previousFocus?.focus({ preventScroll: true })
  emit('close')
}
function choose(index = selected.value) {
  const session = results.value[index]
  if (!session) return
  emit('select', session.projectId, session.sessionId)
  close()
}
function keydown(event: KeyboardEvent) {
  if (composing.value || event.isComposing || event.keyCode === 229) return
  // The dialog stops propagation, so consume even repeated open chords here
  // rather than allowing the browser's hard-reload shortcut to run.
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'r') {
    event.preventDefault()
    input.value?.focus()
    return
  }
  if (event.key === 'Escape') { event.preventDefault(); close() }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const count = results.value.length
    if (count) selected.value = (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
  } else if (event.key === 'Enter' && event.target === input.value) {
    event.preventDefault(); choose()
  }
}
function retry(projectId: string) {
  const entry = leases.value.find(entry => entry.projectId === projectId)
  if (entry) void entry.lease.graph.refresh()
}
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
  input.value?.focus()
})
onBeforeUnmount(() => {
  for (const { lease } of leases.value) lease.release()
  dialog.value?.close()
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <dialog ref="dialog" class="quick-open" :aria-label="t('Open session')"
    @keydown.stop="keydown" @cancel.prevent="!composing && close()" @close="close">
    <header>
      <label :for="`${id}-search`">{{ t('Open session') }}</label>
      <button type="button" @click="close">{{ t('Close') }}</button>
    </header>
    <input :id="`${id}-search`" ref="input" v-model="query" type="search" role="combobox"
      :placeholder="t('Search session titles across projects')" :aria-label="t('Search session titles across projects')"
      aria-autocomplete="list" aria-expanded="true" :aria-controls="`${id}-results`"
      :aria-activedescendant="results.length ? optionId(selected) : undefined"
      autocomplete="off" @compositionstart="composing = true" @compositionend="composing = false">
    <div class="status" role="status" aria-live="polite">
      <span v-if="loading">{{ t('Loading sessions…') }}</span>
      <span v-else-if="!results.length">{{ t('No matching sessions') }}</span>
    </div>
    <div v-if="failures.length" class="failures">
      <div v-for="failure in failures" :key="failure.projectId" class="failure">
        <span>{{ t('Could not load sessions for {project}', { project: projectLabel(failure.projectId) }) }}</span>
        <button type="button" :disabled="failure.lease.graph.state.loading" @click="retry(failure.projectId)">{{ t('Retry') }}</button>
      </div>
    </div>
    <ul :id="`${id}-results`" role="listbox" :aria-label="t('Sessions')" class="results">
      <li v-for="(session, index) in results" :id="optionId(index)" :key="JSON.stringify([session.projectId, session.sessionId])"
        role="option" :aria-selected="selected === index" :class="{ selected: selected === index }"
        @pointermove="selected = index" @mousedown.prevent @click="choose(index)">
        <span class="session-title">{{ session.title || session.label }}</span>
        <span class="project-label">{{ projectLabel(session.projectId) }}</span>
      </li>
    </ul>
  </dialog>
</template>

<style scoped>
.quick-open { position: fixed; inset: max(24px, 10dvh) auto auto 50%; transform: translateX(-50%); margin: 0; width: min(600px, calc(100vw - 32px)); max-height: 75dvh; padding: 0; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 12px 36px var(--c-shadow); overflow: auto; font-size: 13px; }
.quick-open::backdrop { background: var(--c-shadow); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px 8px; }
header label { font-weight: 600; }
input { display: block; box-sizing: border-box; width: calc(100% - 32px); margin: 0 16px 8px; padding: 10px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; }
input::placeholder { color: var(--c-text-secondary); }
input:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
button { min-height: 32px; padding: 5px 10px; background: transparent; color: var(--c-text); border: 1px solid var(--c-border); font: inherit; cursor: pointer; }
button:hover { background: var(--c-bg-muted); }
button:disabled { cursor: default; opacity: .6; }
.status:empty { display: none; }
.status, .failures { padding: 4px 16px 12px; color: var(--c-text-secondary); }
.failure { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.failure span { overflow-wrap: anywhere; }
.results { list-style: none; margin: 0; padding: 4px 0; max-height: 48dvh; overflow-y: auto; border-top: 1px solid var(--c-border-soft); }
.results li { display: flex; align-items: center; gap: 16px; padding: 10px 16px; min-height: 20px; cursor: pointer; }
.results li:hover { background: var(--c-bg-muted); }
.results li.selected { background: var(--c-selection-bg); color: var(--c-primary); }
.session-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.project-label { max-width: 35%; color: var(--c-text-secondary); overflow-wrap: anywhere; font-size: 12px; }
@media (max-width: 700px), (pointer: coarse) { button { min-height: 44px; } input { font-size: 16px; min-height: 44px; } .results li { min-height: 44px; box-sizing: border-box; } }
</style>
