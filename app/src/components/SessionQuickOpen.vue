<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import SessionListItem from './SessionListItem.vue'
import { sessionListMetadata } from '../session-list-metadata.ts'
import { createFoldersClient, type FolderRecord } from '../folders-client.ts'
import { hostBase, projectBase } from '../api-url.ts'
import { activeSubagentsByOwner, summarizeSubagents } from '../subagent-executions.ts'
import type { SidebarSession } from '../folders-sidebar.ts'
import { t } from '../i18n.ts'
import type { ProjectRecord } from '../projects.ts'
import type { ProjectLiveLease } from '../project-live-state.ts'
import { useProjectLiveState } from '../composables/useProjectLiveState.ts'
import { isQuickOpenBackdropPoint, searchQuickOpenSessions } from '../session-quick-open.ts'

const props = defineProps<{ apiBase: string; projects: ProjectRecord[] }>()
const emit = defineEmits<{ close: []; select: [projectId: string, sessionId: string, automationId?: string] }>()
const live = useProjectLiveState()
const leases = shallowRef<Array<{ projectId: string; lease: ProjectLiveLease }>>([])
const dialog = ref<HTMLDialogElement>()
const input = ref<HTMLInputElement>()
const query = ref('')
const folderCatalogs = ref<Record<string, FolderRecord[]>>({})
const now = ref(Date.now())
const clock = setInterval(() => { now.value = Date.now() }, 15_000)
function entryFor(projectId: string) { return leases.value.find(entry => entry.projectId === projectId) }
function stageFor(session: SidebarSession & { projectId: string }) {
  return entryFor(session.projectId)?.lease.activity.state.value?.stages[session.sessionId]
}
function delegatedFor(session: SidebarSession & { projectId: string }) {
  const lease = entryFor(session.projectId)?.lease
  const stages = lease?.activity.state.value?.stages ?? {}
  return summarizeSubagents(activeSubagentsByOwner(lease?.sessions.state.value ?? [], stages).get(session.sessionId) ?? [], stages)
}
function metadataFor(session: SidebarSession & { projectId: string }) {
  return sessionListMetadata(session, folderCatalogs.value[session.projectId] ?? [], [], now.value)
}
const projectFilter = ref('')
const filteredLeases = computed(() => leases.value.filter(entry => !projectFilter.value || entry.projectId === projectFilter.value))
watch(() => props.projects, projects => {
  if (projectFilter.value && !projects.some(project => project.id === projectFilter.value)) projectFilter.value = ''
})
const selected = ref(0)
const id = useId()
let previousFocus: HTMLElement | null = null
let closing = false
const composing = ref(false)
watch(() => [props.apiBase, ...props.projects.map(project => project.id)], (_, __, onCleanup) => {
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  folderCatalogs.value = {}
  for (const { lease } of leases.value) lease.release()
  leases.value = [...new Set(props.projects.map(project => project.id))].map(projectId => ({
    projectId, lease: live.acquireProject(props.apiBase, projectId, undefined, false, 'full'),
  }))
  for (const { projectId, lease } of leases.value) {
    void lease.read()
    void createFoldersClient(projectBase(hostBase(props.apiBase), projectId)).list(controller.signal).then(folders => {
      if (!controller.signal.aborted) folderCatalogs.value = { ...folderCatalogs.value, [projectId]: folders }
    }).catch(() => { /* Folder IDs remain truthful fallbacks when the catalog is unavailable. */ })
  }
}, { immediate: true })
const results = computed(() => searchQuickOpenSessions(filteredLeases.value.flatMap(({ projectId, lease }) =>
  (lease.sessions.state.value ?? []).map(session => ({ ...session, projectId }))), query.value, props.projects.map(project => project.id), projectFilter.value))
const loading = computed(() => filteredLeases.value.some(({ lease }) => lease.sessions.state.loading))
const failures = computed(() => filteredLeases.value.filter(({ lease }) => lease.sessions.state.error))
const projectLabel = (projectId: string) => props.projects.find(project => project.id === projectId)?.name ?? projectId
const optionId = (index: number) => `${id}-option-${index}`
watch([query, results], () => { selected.value = 0 })
watch([selected, results], async () => {
  await nextTick()
  document.getElementById(optionId(selected.value))?.scrollIntoView({ block: 'nearest' })
}, { flush: 'post' })
let backdropPressed = false
function onBackdropPointerdown(event: PointerEvent) {
  backdropPressed = event.button === 0 && event.target === dialog.value
    && !!dialog.value && isQuickOpenBackdropPoint(event, dialog.value.getBoundingClientRect())
}
function onBackdropClick(event: MouseEvent) {
  const dismiss = backdropPressed && event.target === dialog.value
    && !!dialog.value && isQuickOpenBackdropPoint(event, dialog.value.getBoundingClientRect())
  backdropPressed = false
  if (dismiss) close()
}
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
  emit('select', session.projectId, session.sessionId, session.automation?.jobId)
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
  else if (event.target === input.value && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    const count = results.value.length
    if (count) selected.value = (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
  } else if (event.key === 'Enter' && event.target === input.value) {
    event.preventDefault(); choose()
  }
}
function retry(projectId: string) {
  const entry = leases.value.find(entry => entry.projectId === projectId)
  if (entry) void entry.lease.sessions.refresh()
}
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
  input.value?.focus()
})
onBeforeUnmount(() => {
  clearInterval(clock)
  for (const { lease } of leases.value) lease.release()
  dialog.value?.close()
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <dialog ref="dialog" class="quick-open" :aria-label="t('Open session')"
    @pointerdown="onBackdropPointerdown" @pointercancel="backdropPressed = false" @click="onBackdropClick"
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
    <div class="project-filter" role="group" :aria-label="t('Filter by project')">
      <button type="button" :aria-pressed="!projectFilter" @click="projectFilter = ''">{{ t('All projects') }}</button>
      <button v-for="project in projects" :key="project.id" type="button" :aria-pressed="projectFilter === project.id"
        @click="projectFilter = project.id">{{ project.name }}</button>
    </div>
    <div class="status" role="status" aria-live="polite">
      <span v-if="loading">{{ t('Loading sessions…') }}</span>
      <span v-else-if="!results.length">{{ t('No matching sessions') }}</span>
    </div>
    <div v-if="failures.length" class="failures">
      <div v-for="failure in failures" :key="failure.projectId" class="failure">
        <span>{{ t('Could not load sessions for {project}', { project: projectLabel(failure.projectId) }) }}</span>
        <button type="button" :disabled="failure.lease.sessions.state.loading" @click="retry(failure.projectId)">{{ t('Retry') }}</button>
      </div>
    </div>
    <ul :id="`${id}-results`" role="listbox" :aria-label="t('Sessions')" class="results">
      <li v-for="(session, index) in results" :id="optionId(index)" :key="JSON.stringify([session.projectId, session.sessionId])"
        role="option" :aria-selected="selected === index" class="session-list-row" :class="{ selected: selected === index }"
        @pointermove="selected = index" @mousedown.prevent @click="choose(index)">
        <span class="session-icon" aria-hidden="true"><SessionListItem part="icon" :session="session" :stage="stageFor(session)" :subagents="delegatedFor(session)" /></span>
        <span class="session-copy">
          <SessionListItem part="title" :session="session" />
          <span v-if="session.automation" class="automation-label">{{ t('Automation') }} · {{ session.automation.name }}</span>
          <SessionListItem part="metadata" :session="session" :metadata="metadataFor(session)" :project-label="!projectFilter ? projectLabel(session.projectId) : undefined" />
        </span>
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
.project-filter { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 8px; max-height: 132px; overflow-y: auto; }
.project-filter button { max-width: 100%; overflow-wrap: anywhere; color: var(--c-text-secondary); }
.project-filter button[aria-pressed="true"] { background: var(--c-selection-bg); border-color: var(--c-selection-border); color: var(--c-primary); }
.status:empty { display: none; }
.status, .failures { padding: 4px 16px 12px; color: var(--c-text-secondary); }
.failure { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.failure span { overflow-wrap: anywhere; }
.results { list-style: none; margin: 0; padding: 4px 0; max-height: 48dvh; overflow-y: auto; border-top: 1px solid var(--c-border-soft); }
.results li { display: flex; align-items: center; gap: 8px; padding: 6px 16px; min-height: 48px; box-sizing: border-box; cursor: pointer; line-height: 20px; }
.session-icon { display: grid; place-items: center; flex: 0 0 16px; width: 16px; height: 16px; color: var(--c-text-secondary); }
.session-copy { flex: 1; min-width: 0; }
.session-copy :deep(.session-metadata) { font-size: 11px; color: var(--c-text-secondary); }
@media (max-width: 700px), (pointer: coarse) { button { min-height: 44px; } input { font-size: 16px; min-height: 44px; } .results li { min-height: 44px; box-sizing: border-box; } }
.automation-label { display: block; color: var(--c-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
</style>
