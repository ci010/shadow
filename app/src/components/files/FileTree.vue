<template>
  <div ref="tree" class="file-tree" :class="{ 'has-preview': previewEntry, 'tree-only': treeOnly }">
    <section class="file-tree-list" :aria-label="projectId ? 'Project files' : 'Session files'" :aria-busy="loading || sourcePending">
      <header class="file-tree-header">
        <div v-if="treeOnly" class="file-tree-modes" role="tablist" aria-label="Explorer view">
          <button :id="`${id}-files-tab`" role="tab" :aria-selected="!changesOnly" :aria-controls="`${id}-body`" :tabindex="changesOnly ? -1 : 0" @click="changesOnly = false" @keydown="viewKey">Files</button>
          <HoverInfo :text="gitError || (gitStatus?.available ? 'All uncommitted changes from HEAD' : gitLoading ? 'Checking Git status...' : gitUnavailableLabel(gitStatus?.reason))" v-slot="{ triggerProps }">
          <button v-bind="triggerProps" :id="`${id}-changes-tab`" role="tab" :aria-selected="changesOnly" :aria-controls="`${id}-body`" :tabindex="changesOnly ? 0 : -1" :disabled="!gitStatus?.available" @click="changesOnly = true" @keydown="viewKey">Changes</button>
          </HoverInfo>
        </div>
        <span v-else>Current workdir</span>
        <div class="file-tree-actions">
          <HoverInfo text="Refresh files and changes" v-slot="{ triggerProps }">
          <button v-bind="triggerProps" class="file-tree-refresh" aria-label="Refresh files" :aria-busy="loading" :disabled="loading || !hasSource" @click="reload(); $emit('refresh-git')">
            <span class="i-lucide-refresh-cw w-4 h-4" aria-hidden="true" />
          </button>
          </HoverInfo>
          <slot name="actions" />
        </div>
      </header>
      <div :id="`${id}-body`" class="file-tree-body" :role="treeOnly ? 'tabpanel' : undefined" :aria-labelledby="treeOnly ? `${id}-${changesOnly ? 'changes' : 'files'}-tab` : undefined">
        <HoverInfo v-if="loaded" :text="workspaceInfo" v-slot="{ triggerProps }">
          <div v-bind="triggerProps" class="file-tree-root" tabindex="0" :aria-label="workspaceInfo">
            <span :class="workdir?.kind === 'remote' ? 'i-lucide-cloud' : 'i-lucide-folder-open'" aria-hidden="true" />
            <span class="file-tree-root-label">{{ workspaceLabel }}</span>
          </div>
        </HoverInfo>
        <div v-if="gitError" class="file-tree-note error" role="alert">{{ gitError }} <button class="btn btn-sm" @click="$emit('refresh-git')">Retry Git</button></div>
        <p v-if="!changesOnly && !gitStatus?.available && gitStatus?.reason && gitStatus.reason !== 'not_repository'" class="file-tree-note" role="status">{{ gitUnavailableLabel(gitStatus.reason) }}</p>
        <p v-if="!hasSource" class="file-tree-note">Open a project folder or select a conversation to browse files.</p>
        <p v-else-if="changesOnly && gitLoading" class="file-tree-note" role="status">Loading changes...</p>
        <p v-else-if="changesOnly && !gitStatus?.available" class="file-tree-note">{{ gitUnavailableLabel(gitStatus?.reason) }}</p>
        <p v-else-if="!changesOnly && loading && !loaded" class="file-tree-note" role="status">Loading files...</p>
        <div v-if="!changesOnly && error" class="file-tree-note error" role="alert">
          <p>{{ error }}</p><button class="btn btn-sm" @click="reload">Retry</button>
        </div>
        <p v-if="hasSource && changesOnly && gitStatus?.available && !gitLoading && displayEntries.length === 0 && !gitError" class="file-tree-note">Working tree clean.</p>
        <template v-if="hasSource && (changesOnly ? gitStatus?.available : loaded)">
          <FileTreeNode v-for="entry in displayEntries" :key="`${workspaceKey}:${changesOnly}:${fileEntryKey(entry)}`" :api-base="displaySource.apiBase"
            :session-id="displaySource.sessionId" :project-id="displaySource.projectId" dir="" :entry="entry" :depth="0" :active="active && !sourcePending"
            :workspace-key="workspaceKey"
            :refresh-version="revision" :changes-only="changesOnly" :changes="gitStatus?.available ? gitStatus.entries : []" @open="onOpen" />
        </template>
      </div>
    </section>
    <FilePreviewModal v-if="previewEntry" :key="previewPath" inline :api-base="apiBase" :session-id="sessionId"
      :project-id="projectId" :dir="previewDir" :entry="previewEntry" @close="closePreview" />
    <div v-else-if="previewOnOpen" class="file-preview-empty">Select a file to preview its current contents.</div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import FileTreeNode from './FileTreeNode.vue'
import FilePreviewModal from './FilePreviewModal.vue'
import HoverInfo from '../HoverInfo.vue'
import { type DirListing, type FileEntry, useSessionFiles } from '../../composables/useSessionFiles'
import { changedDirectory, gitUnavailableLabel, type GitStatus } from '../../git-files.ts'
import type { OpenFile } from '../../file-workbench.ts'
import { canRetainHomeTree, fileEntryKey, fileWorkspaceKey, reconcileFileEntries, type FileTreeSource } from '../../file-tree-state.ts'

const props = withDefaults(defineProps<{ apiBase: string; sessionId: string; projectId?: string; previewOnOpen?: boolean; treeOnly?: boolean; active?: boolean; gitStatus?: GitStatus; gitLoading?: boolean; gitError?: string }>(), { active: true })
const emit = defineEmits<{ open: [payload: OpenFile]; 'refresh-git': [] }>()
const id = `file-tree-${useId()}`
const changesOnly = ref(false)
const files = computed(() => useSessionFiles(props.apiBase, props.projectId))
const hasSource = computed(() => !!(props.projectId || props.sessionId))
const tree = ref<HTMLElement>()
const rootEntries = ref<FileEntry[]>([])
const displayEntries = computed(() => changesOnly.value ? changedDirectory(props.gitStatus?.entries ?? []) : rootEntries.value)
const loading = ref(false)
const loaded = ref(false)
const workdir = ref<DirListing['workdir']>()
const currentSource = (): FileTreeSource => ({ apiBase: props.apiBase, sessionId: props.sessionId, projectId: props.projectId })
const displaySource = ref(currentSource())
const sourcePending = ref(false)
const workspaceKey = computed(() => fileWorkspaceKey(displaySource.value, workdir.value))
const workspaceLabel = computed(() => workdir.value?.scope === 'home' ? 'Home'
  : workdir.value?.displayPath?.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
    || (workdir.value?.kind === 'remote' ? 'Remote workspace' : props.projectId ? 'Project workspace' : 'Session workspace'))
const workspaceInfo = computed(() => [
  workdir.value?.scope === 'home' ? 'Home' : workdir.value?.kind === 'remote' ? 'Remote workspace' : 'Current workspace',
  workdir.value?.displayPath,
].filter(Boolean).join('\n'))
const error = ref('')
const revision = ref(0)
const previewEntry = ref<FileEntry | null>(null)
const previewDir = ref('')
const previewPath = ref('')
let request: AbortController | undefined
function viewKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !props.gitStatus?.available) return
  event.preventDefault()
  changesOnly.value = event.key === 'Home' ? false : event.key === 'End' ? true : !changesOnly.value
  void nextTick(() => document.getElementById(`${id}-${changesOnly.value ? 'changes' : 'files'}-tab`)?.focus())
}

async function reload(): Promise<void> {
  request?.abort()
  request = undefined
  loading.value = false
  if (!hasSource.value || !props.active) return
  const controller = new AbortController()
  const source = currentSource()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const listing = await files.value.listDir(props.sessionId, '', controller.signal)
    if (controller.signal.aborted) return
    rootEntries.value = fileWorkspaceKey(source, listing.workdir) === workspaceKey.value
      ? reconcileFileEntries(rootEntries.value, listing.entries) : listing.entries
    workdir.value = listing.workdir
    displaySource.value = source
    sourcePending.value = false
    revision.value++
    loaded.value = true
  } catch (cause) {
    if (!controller.signal.aborted) {
      if (sourcePending.value) {
        clearListing()
        displaySource.value = source
        sourcePending.value = false
      }
      error.value = cause instanceof Error ? cause.message : 'Could not load files. Retry.'
    }
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}
function onOpen(payload: { path: string; entry: FileEntry }): void {
  if (!props.active || sourcePending.value) return
  emit('open', { ...payload, ...(changesOnly.value ? { view: 'diff' as const } : {}) })
  if (!props.previewOnOpen) return
  const index = payload.path.lastIndexOf('/')
  previewDir.value = index >= 0 ? payload.path.slice(0, index) : ''
  previewPath.value = payload.path
  previewEntry.value = payload.entry
}
function closePreview(): void {
  previewEntry.value = null
  void nextTick(() => Array.from(tree.value?.querySelectorAll<HTMLButtonElement>('.tree-row') ?? [])
    .find(row => row.dataset.path === previewPath.value)?.focus({ preventScroll: true }))
}
function clearListing(): void {
  loaded.value = false
  workdir.value = undefined
  rootEntries.value = []
  previewEntry.value = null
}
watch(() => [props.apiBase, props.sessionId, props.projectId], () => {
  request?.abort()
  request = undefined
  loading.value = false
  error.value = ''
  const next = currentSource()
  if (!canRetainHomeTree(displaySource.value, next, workdir.value)) {
    clearListing()
    displaySource.value = next
  }
  sourcePending.value = hasSource.value
  changesOnly.value = false
  previewEntry.value = null
  if (props.active) void reload()
}, { immediate: true })
watch(() => props.active, active => {
  if (active && (!loaded.value || sourcePending.value)) void reload()
  else if (!active) { request?.abort(); request = undefined; loading.value = false; previewEntry.value = null }
})
watch(workspaceKey, () => { previewEntry.value = null })
onUnmounted(() => request?.abort())
defineExpose({ reload })
</script>

<style scoped>
.file-tree { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; container: session-files / inline-size; }
.file-tree-list { display: flex; flex-direction: column; flex: 0 0 35%; max-width: 300px; min-width: 180px; border-right: 1px solid var(--c-border); }
.tree-only .file-tree-list { flex: 1; max-width: none; min-width: 0; border-right: 0; }
.file-tree-actions { display: flex; align-items: center; gap: 2px; }
.tree-only .file-tree-header { min-height: 40px; box-sizing: border-box; padding: 4px 6px; border-bottom: 1px solid var(--c-border); }
.file-tree-modes { display: flex; align-items: stretch; min-width: 0; }
.file-tree-modes button { padding: 6px; min-height: 32px; border: 0; background: transparent; color: var(--c-text-secondary); font: inherit; cursor: pointer; }
.file-tree-modes button[aria-selected="true"] { color: var(--c-text); box-shadow: inset 0 -2px var(--c-blue); }
.file-tree-modes button:disabled { opacity: .45; cursor: default; }
.file-tree-modes button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.file-tree-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; color: var(--c-text-secondary); font-size: 12px; }
.file-tree-refresh { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); cursor: pointer; }
.file-tree-refresh:hover:not(:disabled) { background: var(--c-bg-muted); color: var(--c-text); }
.file-tree-refresh:disabled { opacity: .5; cursor: wait; }
.file-tree-refresh:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.file-tree-body { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; padding: 4px 8px 16px; }
.file-tree-root { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px 6px; color: var(--c-text-secondary); font-size: 12px; }
.file-tree-root > span:first-child { flex: 0 0 16px; width: 16px; height: 16px; }
.file-tree-root-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-tree-root:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.file-tree-note { padding: 12px 8px; color: var(--c-text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.file-tree-note.error { color: var(--c-error); }
.file-preview-empty { display: grid; place-items: center; flex: 1; padding: 24px; color: var(--c-text-secondary); font-size: 13px; text-align: center; }
@container session-files (max-width: 620px) {
  .file-tree-list { flex: 1; max-width: none; border: 0; }
  .file-preview-empty, .has-preview > .file-tree-list { display: none; }
}
</style>
