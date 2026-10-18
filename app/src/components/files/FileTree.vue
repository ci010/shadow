<template>
  <div ref="tree" @dragstart="referenceDragStart" @dragend="referenceDragEnd" class="file-tree" :class="{ 'has-preview': previewEntry, 'tree-only': treeOnly }">
    <section class="file-tree-list" :aria-label="folderId ? t('Folder files') : t('Session files')" :aria-busy="loading || sourcePending">
      <header class="file-tree-header">
        <div v-if="treeOnly" class="file-tree-modes" role="tablist" :aria-label="t('Explorer view')">
          <button :id="`${id}-files-tab`" role="tab" :aria-selected="!changesOnly" :aria-controls="`${id}-body`" :tabindex="changesOnly ? -1 : 0" @click="changesOnly = false" @keydown="viewKey">{{ t('Files') }}</button>
          <HoverInfo :text="offline ? t('Node offline') : gitError || (gitStatus?.available ? t('All uncommitted changes from HEAD') : gitLoading ? t('Checking Git status...') : gitUnavailableLabel(gitStatus?.reason))" v-slot="{ triggerProps }">
          <button v-bind="triggerProps" :id="`${id}-changes-tab`" role="tab" :aria-selected="changesOnly" :aria-controls="`${id}-body`" :tabindex="changesOnly ? 0 : -1" :disabled="!changesAvailable" @click="changesOnly = true" @keydown="viewKey">{{ t('Changes') }}</button>
          </HoverInfo>
        </div>
        <span v-else>{{ t('Current workdir') }}</span>
        <div class="file-tree-actions">
          <HoverInfo text="Refresh files and changes" v-slot="{ triggerProps }">
          <button v-bind="triggerProps" class="file-tree-refresh" :aria-label="t('Refresh files')" :aria-busy="loading" :disabled="loading || !hasSource" @click="reload(); $emit('refresh-git')">
            <span class="i-lucide-refresh-cw w-4 h-4" aria-hidden="true" />
          </button>
          </HoverInfo>
          <slot name="actions" />
        </div>
      </header>
      <div class="file-tree-search">
        <input v-model="filterQuery" type="search" :aria-label="t('Search file paths')" :placeholder="t('Search file paths')" />
        <p v-if="filterQuery && !changesOnly" class="file-tree-search-hint">{{ t('Searches file paths with ripgrep; respects ignore rules.') }}</p>
      </div>
      <div ref="body" :id="`${id}-body`" class="file-tree-body" :role="treeOnly ? 'tabpanel' : undefined" :aria-labelledby="treeOnly ? `${id}-${changesOnly ? 'changes' : 'files'}-tab` : undefined" @scroll="saveScroll">
        <HoverInfo v-if="loaded" :text="workspaceInfo" v-slot="{ triggerProps }">
          <div v-bind="triggerProps" class="file-tree-root" tabindex="0" :aria-label="workspaceInfo"
            @contextmenu.prevent.stop="openContextMenu({ event: $event, path: '' })" @keydown="menuKey($event, '')">
            <span :class="workdir?.kind === 'remote' ? 'i-lucide-cloud' : folderIcon(workspaceLabel, true)" aria-hidden="true" />
            <span class="file-tree-root-label">{{ workspaceLabel }}</span>
          </div>
        </HoverInfo>
        <NodeOfflineState v-if="offline" :checking="loading || gitLoading" @retry="reload(); $emit('refresh-git')" />
        <template v-else>
        <div v-if="changesOnly && gitError" class="file-tree-note error" role="alert">{{ gitError }} <button class="file-tree-retry" :disabled="gitLoading" @click="$emit('refresh-git')">{{ t('Retry Git') }}</button></div>
        <p v-if="!hasSource" class="file-tree-note">{{ t('Open a folder or select a conversation to browse files.') }}</p>
        <p v-else-if="changesOnly && gitLoading" class="file-tree-note" role="status">{{ t('Loading changes...') }}</p>
        <p v-else-if="changesOnly && !gitStatus?.available && !gitError" class="file-tree-note">{{ gitUnavailableLabel(gitStatus?.reason) }}</p>
        <p v-else-if="!changesOnly && loading && !loaded" class="file-tree-note" role="status">{{ remote ? t('Loading remote files...') : t('Loading files...') }}</p>
        <div v-if="!changesOnly && error" class="file-tree-note error" role="alert">
          <p>{{ error }}</p><button class="file-tree-retry" @click="reload()">{{ t('Retry') }}</button>
        </div>
        <p v-if="changesOnly && gitStatus?.truncated" class="file-tree-note" role="status">{{ t('Git changes are incomplete. Use a smaller workdir to see all changes.') }}</p>
        <p v-if="hasSource && changesOnly && gitStatus?.available && !gitStatus.truncated && !gitLoading && displayEntries.length === 0 && !gitError" class="file-tree-note">{{ t('Working tree clean.') }}</p>
        <template v-if="normalizedFilter && !changesOnly && hasSource">
          <p v-if="searching" class="file-tree-note" role="status">{{ t('Searching file paths...') }}</p>
          <p v-if="searchError" class="file-tree-note error" role="alert">{{ searchError }}</p>
          <p v-if="!searching && !searchError && !searchPaths.length" class="file-tree-note">{{ t('No matching file paths.') }}</p>
          <p v-if="searchTruncated" class="file-tree-note">{{ t('Showing the first 200 matches. Narrow your search to find more.') }}</p>
          <template v-for="path in searchPaths" :key="path">
          <FileTreeNode v-if="isArchive(path)" :api-base="displaySource.apiBase" :session-id="displaySource.sessionId"
            :folder-id="displaySource.folderId" :session-workspace="sessionWorkspace" :dir="path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''"
            :entry="searchEntry(path)" :depth="0" :active="active && !sourcePending" :workspace-key="workspaceKey"
            :selected-path="selectedPath" :reveal-version="revealVersion" :refresh-version="revision"
            @open="onOpen" @node-offline="fileOffline = true" @context-menu="openContextMenu" />
          <button v-else type="button" class="file-search-result" :draggable="active && !sourcePending"
            :data-path="path" data-reference-kind="file"
            :aria-current="selectedPath === path ? 'page' : undefined" :title="path" @click="openSearchResult(path)"
            @contextmenu.prevent.stop="openContextMenu({ event: $event, path })" @keydown="menuKey($event, path)">
            <span class="i-lucide-file w-4 h-4" aria-hidden="true" /><span>{{ path }}</span>
          </button>
          </template>
        </template>
        <p v-if="filterQuery && changesOnly && !filteredEntries.length && gitStatus?.available && !gitStatus.truncated && !gitLoading && !gitError" class="file-tree-note">{{ t('No matching changes.') }}</p>
        <template v-if="!normalizedFilter || changesOnly">
        <template v-if="hasSource && (changesOnly ? gitStatus?.available : loaded)">
          <FileTreeNode v-for="entry in filteredEntries" :key="`${workspaceKey}:${changesOnly}:${fileEntryKey(entry)}`" :api-base="displaySource.apiBase"
            :session-id="displaySource.sessionId" :folder-id="displaySource.folderId" :session-workspace="sessionWorkspace" dir="" :entry="entry" :depth="0" :active="active && !sourcePending"
            :filter-query="changesOnly ? normalizedFilter : ''"
            :workspace-key="workspaceKey"
            :selected-path="selectedPath" :reveal-version="revealVersion"
            :refresh-version="homeState?.revision ?? revision" :home-state="changesOnly ? undefined : homeState"
            :changes-only="changesOnly" :changes="gitStatus?.available ? gitStatus.entries : []" @open="onOpen" @node-offline="fileOffline = true" @context-menu="openContextMenu" />
        </template>
        </template>
        </template>
      </div>
    </section>
    <FilePreviewModal v-if="previewEntry" :key="previewPath" inline :api-base="apiBase" :session-id="sessionId"
      :remote="workdir?.kind === 'remote'"
      :folder-id="folderId" :session-workspace="sessionWorkspace" :dir="previewDir" :entry="previewEntry" @close="closePreview" />
    <div v-else-if="previewOnOpen" class="file-preview-empty">{{ t('Select a file to preview its current contents.') }}</div>
    <FileTreeContextMenu v-if="contextMenu" :request="contextMenu" :workdir="workdir" @close="contextMenu = undefined" />
  </div>
</template>

<script setup lang="ts">
import { t } from '../../i18n.ts'
import { computed, inject, nextTick, onUnmounted, ref, shallowRef, useId, watch } from 'vue'
import FileTreeNode from './FileTreeNode.vue'
import FileTreeContextMenu from './FileTreeContextMenu.vue'
import { fileTreeShortcut, type FileTreeMenuRequest } from '../../file-tree-menu.ts'
import FilePreviewModal from './FilePreviewModal.vue'
import HoverInfo from '../HoverInfo.vue'
import NodeOfflineState from './NodeOfflineState.vue'
import { sessionWorkspaceLabel } from '../../file-spaces.ts'
import { folderIcon } from '../../file-icons.ts'
import { isNodeOfflineError } from '../../workdir-request-error.ts'
import { type DirListing, type FileEntry, useSessionFiles } from '../../composables/useSessionFiles'
import { changedDirectory, gitUnavailableLabel, type GitStatus } from '../../git-files.ts'
import type { OpenFile } from '../../file-workbench.ts'
import { canRetainHomeTree, fileEntryKey, fileWorkspaceKey, reconcileFileEntries, type FileTreeSource } from '../../file-tree-state.ts'
import { HomeTreeCacheKey, type HomeTreeState } from '../../home-tree-cache.ts'
import { isArchive } from '../../archive-format.ts'
import { startFileReferenceDrag } from '../../file-reference-drag.ts'

const props = withDefaults(defineProps<{ apiBase: string; sessionId: string; sessionWorkspace?: boolean; folderId?: string; previewOnOpen?: boolean; treeOnly?: boolean; active?: boolean; gitStatus?: GitStatus; gitLoading?: boolean; gitError?: string; gitOffline?: boolean; remote?: boolean; selectedPath?: string; revealVersion?: number }>(), { active: true, remote: false, revealVersion: 0 })
const emit = defineEmits<{ open: [payload: OpenFile]; 'refresh-git': [] }>()
const id = `file-tree-${useId()}`
const changesOnly = ref(false)
const filterQuery = ref('')
const normalizedFilter = computed(() => filterQuery.value.trim().toLocaleLowerCase())
const searchPaths = ref<string[]>([])
const searching = ref(false)
const searchError = ref('')
const searchTruncated = ref(false)
const files = computed(() => useSessionFiles(props.apiBase, props.folderId, props.sessionWorkspace))
const hasSource = computed(() => !!(props.folderId || props.sessionId))
const tree = ref<HTMLElement>()
const body = ref<HTMLElement>()
const homeCache = inject(HomeTreeCacheKey, undefined)
const homeState = shallowRef<HomeTreeState>()
const rootEntries = ref<FileEntry[]>([])
const displayEntries = computed(() => changesOnly.value ? changedDirectory(props.gitStatus?.entries ?? []) : homeState.value?.entries ?? rootEntries.value)
const filteredEntries = computed(() => displayEntries.value.filter(entry =>
  !normalizedFilter.value || entry.type === 'dir' || entry.name.toLocaleLowerCase().includes(normalizedFilter.value)))
const loading = ref(false)
const loaded = ref(false)
const workdir = ref<DirListing['workdir']>()
const expectedHome = computed(() => !props.sessionWorkspace && homeCache?.expectsHome({ apiBase: props.apiBase, sessionId: props.sessionId, folderId: props.folderId }) === true)
const currentSource = (): FileTreeSource => ({ apiBase: props.apiBase, sessionId: props.sessionId, folderId: props.folderId, sessionWorkspace: props.sessionWorkspace, home: expectedHome.value })
const displaySource = ref(currentSource())
const sourcePending = ref(false)
let releaseReferenceDrag: (() => void) | undefined
function referenceDragEnd() { releaseReferenceDrag?.(); releaseReferenceDrag = undefined }
function referenceDragStart(event: DragEvent) {
  referenceDragEnd()
  const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-reference-kind][data-path]') : null
  if (!row || !event.dataTransfer || !props.active || sourcePending.value || offline.value) { event.preventDefault(); return }
  const kind = row.dataset.referenceKind
  if (kind !== 'file' && kind !== 'folder') { event.preventDefault(); return }
  releaseReferenceDrag = startFileReferenceDrag(event.dataTransfer, displaySource.value.apiBase, workdir.value, row.dataset.path ?? '', kind)
  if (!releaseReferenceDrag) event.preventDefault()
}
onUnmounted(referenceDragEnd)
watch(() => [props.apiBase, props.sessionId, props.folderId, props.sessionWorkspace, props.active], referenceDragEnd)
const contextMenu = shallowRef<FileTreeMenuRequest>()
function openContextMenu(request: FileTreeMenuRequest) {
  if (props.active && !sourcePending.value && !offline.value) contextMenu.value = request
}
function menuKey(event: KeyboardEvent, path: string) {
  if (!props.active || sourcePending.value || offline.value || event.defaultPrevented || event.isComposing) return
  const shortcut = fileTreeShortcut(event)
  if (!shortcut && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) openContextMenu({ event, path, shortcut })
}
watch(() => [props.apiBase, props.sessionId, props.folderId, props.sessionWorkspace, props.active, workdir.value, sourcePending.value, filterQuery.value, changesOnly.value],
  () => { contextMenu.value = undefined })
const workspaceKey = computed(() => fileWorkspaceKey(displaySource.value, workdir.value))
const workspaceLabel = computed(() => props.sessionWorkspace ? sessionWorkspaceLabel(workdir.value?.displayPath, props.sessionId) : workdir.value?.scope === 'home' ? t('Home')
  : workdir.value?.displayPath?.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
    || (workdir.value?.kind === 'remote' ? t('Remote workspace') : props.folderId ? t('Folder workspace') : t('Session workspace')))
const workspaceInfo = computed(() => [
  workdir.value?.scope === 'home' ? t('Home') : workdir.value?.kind === 'remote' ? t('Remote workspace') : t('Current workspace'),
  workdir.value?.displayPath,
].filter(Boolean).join('\n'))
const error = ref('')
const fileOffline = ref(false)
const offline = computed(() => fileOffline.value || props.gitOffline)
const changesAvailable = computed(() => hasSource.value && !offline.value && !!(props.gitStatus?.available || props.gitError || props.gitLoading))
const revision = ref(0)
const previewEntry = ref<FileEntry | null>(null)
const previewDir = ref('')
const previewPath = ref('')
let request: AbortController | undefined
function viewKey(event: KeyboardEvent) {
  if (!changesAvailable.value || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  changesOnly.value = event.key === 'Home' ? false : event.key === 'End' ? true : !changesOnly.value
  void nextTick(() => document.getElementById(`${id}-${changesOnly.value ? 'changes' : 'files'}-tab`)?.focus())
}

async function reload(refreshChildren = true): Promise<void> {
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
    fileOffline.value = false
    rootEntries.value = fileWorkspaceKey(source, listing.workdir) === workspaceKey.value
      ? reconcileFileEntries(rootEntries.value, listing.entries) : listing.entries
    homeState.value = (props.sessionWorkspace ? undefined : homeCache?.confirm(source, listing, refreshChildren))
    if (homeState.value) rootEntries.value = homeState.value.entries
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
      fileOffline.value = isNodeOfflineError(cause)
      error.value = fileOffline.value ? '' : cause instanceof Error ? cause.message : t('Could not load files. Retry.')
    }
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}
function saveScroll() {
  if (!props.active || changesOnly.value || !body.value?.getClientRects().length || !homeState.value) return
  homeState.value.scrollTop = body.value.scrollTop
  homeState.value.scrollLeft = body.value.scrollLeft
}
async function restoreScroll() {
  await nextTick()
  if (!props.active || changesOnly.value || !body.value || !homeState.value) return
  body.value.scrollTop = homeState.value.scrollTop
  body.value.scrollLeft = homeState.value.scrollLeft
}
function onOpen(payload: { path: string; entry: FileEntry }): void {
  if (!props.active || sourcePending.value || offline.value) return
  emit('open', { ...payload, ...(changesOnly.value ? { view: 'diff' as const } : {}) })
  if (!props.previewOnOpen) return
  const index = payload.path.lastIndexOf('/')
  previewDir.value = index >= 0 ? payload.path.slice(0, index) : ''
  previewPath.value = payload.path
  previewEntry.value = payload.entry
}
function searchEntry(path: string): FileEntry {
  const name = path.split('/').at(-1)!
  const dot = name.lastIndexOf('.')
  return { name, type: 'file', ext: dot < 0 ? '' : name.slice(dot).toLowerCase(), size: 0, mtime: null }
}
function openSearchResult(path: string) {
  onOpen({ path, entry: searchEntry(path) })
}
function closePreview(): void {
  previewEntry.value = null
  void nextTick(() => Array.from(tree.value?.querySelectorAll<HTMLButtonElement>('.tree-row') ?? [])
    .find(row => row.dataset.path === previewPath.value)?.focus({ preventScroll: true }))
}
function clearListing(): void {
  homeState.value = undefined
  loaded.value = false
  workdir.value = undefined
  rootEntries.value = []
  previewEntry.value = null
}
watch([() => props.apiBase, () => props.sessionId, () => props.folderId, () => props.sessionWorkspace, expectedHome], () => {
  request?.abort()
  request = undefined
  loading.value = false
  error.value = ''
  fileOffline.value = false
  const next = currentSource()
  if (!canRetainHomeTree(displaySource.value, next, workdir.value)) {
    clearListing()
    displaySource.value = next
  }
  if (!loaded.value) {
    const cached = props.sessionWorkspace ? undefined : homeCache?.candidate(next)
    if (cached) {
      homeState.value = cached
      rootEntries.value = cached.entries
      workdir.value = cached.workdir
      displaySource.value = cached.source
      loaded.value = true
    }
  }
  sourcePending.value = hasSource.value
  changesOnly.value = false
  filterQuery.value = ''
  previewEntry.value = null
  if (props.active) void reload(false)
}, { immediate: true })
watch(() => props.active, active => {
  if (active && (!loaded.value || sourcePending.value)) void reload(false)
  else if (!active) { request?.abort(); request = undefined; loading.value = false; previewEntry.value = null }
})
watch([normalizedFilter, changesOnly, () => props.active, () => props.apiBase, () => props.sessionId, () => props.folderId, () => props.sessionWorkspace, loaded, sourcePending],
  ([query, changes, active], _previous, onCleanup) => {
    searchPaths.value = []
    searching.value = false
    searchError.value = ''
    searchTruncated.value = false
    if (!query || changes || !active || !hasSource.value || !loaded.value || sourcePending.value) return
    const controller = new AbortController()
    searching.value = true
    const timer = setTimeout(async () => {
      try {
        const result = await files.value.searchPaths(props.sessionId, query, controller.signal)
        if (!controller.signal.aborted) {
          searchPaths.value = result.paths
          searchTruncated.value = result.truncated
        }
      } catch (cause) {
        if (!controller.signal.aborted) searchError.value = cause instanceof Error ? cause.message : t('File search failed. Retry.')
      } finally { if (!controller.signal.aborted) searching.value = false }
    }, 200)
    onCleanup(() => { clearTimeout(timer); controller.abort() })
  }, { immediate: true })
watch(() => props.revealVersion, () => {
  changesOnly.value = false
  if (props.active && loaded.value && !loading.value) void reload()
})
watch([homeState, () => props.active, changesOnly], restoreScroll, { flush: 'post', immediate: true })
watch(workspaceKey, () => { previewEntry.value = null })
watch([() => props.gitStatus, () => props.gitError, () => props.gitLoading], ([status, error, loading]) => {
  if (status && !status.available && !error && !loading) changesOnly.value = false
})
watch(() => props.gitOffline, (offline, previous) => {
  if (previous && !offline && !props.gitError && fileOffline.value && props.active) void reload()
})
onUnmounted(() => request?.abort())
defineExpose({ reload })
</script>

<style scoped>
.file-tree { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; container: session-files / inline-size; }
.file-tree-list { display: flex; flex-direction: column; flex: 0 0 35%; max-width: 300px; min-width: 180px; border-right: 1px solid var(--c-border); }
.tree-only .file-tree-list { flex: 1; max-width: none; min-width: 0; border-right: 0; }
.file-tree-actions { display: flex; align-items: center; gap: 2px; }
.tree-only .file-tree-header { min-height: 40px; box-sizing: border-box; padding: 4px 6px; border-bottom: 1px solid var(--c-border); }
.file-tree-search { padding: 8px; border-bottom: 1px solid var(--c-border); }
.file-tree-search input { box-sizing: border-box; width: 100%; min-height: 32px; padding: 6px 8px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 12px; }
.file-tree-search input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.file-tree-search-hint { margin: 6px 0 0; color: var(--c-text-secondary); font-size: 12px; }
.file-search-result { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 6px; border: 0; background: transparent; color: var(--c-text); text-align: left; font: inherit; font-size: 12px; cursor: pointer; overflow-wrap: anywhere; }
.file-search-result:hover, .file-search-result[aria-current="page"] { background: var(--c-bg-muted); }
.file-search-result:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.file-search-result > span:last-child { min-width: 0; }
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
.file-tree-retry { min-height: 32px; padding: 6px 8px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text-secondary); font: inherit; cursor: pointer; }
.file-tree-retry:hover { background: var(--c-bg-muted); color: var(--c-text); }
.file-tree-retry:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.file-preview-empty { display: grid; place-items: center; flex: 1; padding: 24px; color: var(--c-text-secondary); font-size: 13px; text-align: center; }
@container session-files (max-width: 620px) {
  .file-tree-list { flex: 1; max-width: none; border: 0; }
  .file-preview-empty, .has-preview > .file-tree-list { display: none; }
}
</style>
