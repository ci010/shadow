<template>
  <div ref="node" class="tree-node" :class="decoration ? `git-${decoration}` : undefined">
    <TreeRow button-class="tree-row" :button-attrs="{ 'data-path': fullPath, 'aria-busy': loading, 'aria-disabled': !active }" :label="entry.name" :depth="depth"
      :selected="selectedPath === fullPath" :current="selectedPath === fullPath ? 'page' : undefined"
      :title="decoration ? `${fullPath}\n${entry.type === 'dir' ? t('Contains changes: ') : ''}${gitChangeLabel(decoration)}` : fullPath"
      :expanded="expandable ? expanded : undefined" @select="onRowClick">
      <template #icon><span :class="loading ? 'i-lucide-loader-circle animate-spin' : entry.type === 'dir' ? folderIcon(entry.name, expanded) : fileIcon(entry.name)" /></template>
      <template v-if="entry.type === 'file'" #meta>
        <span v-if="decoration" class="git-status" :aria-label="gitChangeLabel(decoration)">{{ gitChangeBadge(decoration) }}</span>
        <span v-else>{{ sizeLabel }}</span>
      </template>
      <template v-if="archiveContainer" #actions>
        <button type="button" class="archive-open" :aria-label="t('Download or view {name}', { name: entry.name })" :disabled="!active"
          @click="emit('open', { path: fullPath, entry })"><span class="i-lucide-download" aria-hidden="true" /></button>
      </template>
    </TreeRow>

    <div v-if="expandable" v-show="expanded" class="tree-children">
      <div v-if="loadError && !changesOnly" class="tree-note error" role="alert">{{ loadError }} <button class="btn btn-sm" @click="loadChildren">{{ t('Retry') }}</button></div>
      <p v-if="loading" class="tree-note" role="status">{{ archiveContainer ? t('Reading archive directory...') : t('Loading...') }}</p>
      <p v-else-if="loaded && !loadError && !displayChildren.length" class="tree-note">{{ archiveContainer ? t('Empty archive.') : t('Empty folder.') }}</p>
      <FileTreeNode
        v-for="child in filteredChildren"
        :key="fileEntryKey(child)"
        :api-base="apiBase"
        :session-id="sessionId"
        :folder-id="folderId"
        :dir="fullPath"
        :entry="child"
        :depth="depth + 1"
        :active="active && expanded"
        :filter-query="filterQuery"
        :refresh-version="refreshVersion"
        :workspace-key="workspaceKey"
        :home-state="homeState"
        :archive-index="childArchiveIndex"
        :changes="changes"
        :changes-only="changesOnly"
        :selected-path="selectedPath"
        :reveal-version="revealVersion"
        @open="$emit('open', $event)"
        @node-offline="$emit('node-offline')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../i18n.ts'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, toRefs, watch } from 'vue'
import FileTreeNode from './FileTreeNode.vue'
import TreeRow from '../TreeRow.vue'
import { fileIcon, folderIcon } from '../../file-icons.ts'
import { isNodeOfflineError } from '../../workdir-request-error.ts'
import { fileEntryKey, fileWorkspaceKey, reconcileFileEntries } from '../../file-tree-state.ts'
import { homeDirectoryState, type HomeTreeState } from '../../home-tree-cache.ts'
import { changedDirectory, gitChangeBadge, gitChangeLabel, gitDecoration, type GitChange } from '../../git-files.ts'
import { archiveDirectory, isArchive, type ArchiveMember } from '../../archive-format.ts'
import { listArchive } from '../../archive-files.ts'
import {
  type FileEntry,
  formatSize,
  joinPath,
  useSessionFiles,
} from '../../composables/useSessionFiles'

const props = withDefaults(defineProps<{
  apiBase: string
  sessionId: string
  folderId?: string
  dir: string
  entry: FileEntry
  depth: number
  active?: boolean
  changes?: readonly GitChange[]
  changesOnly?: boolean
  refreshVersion?: number
  workspaceKey?: string
  homeState?: HomeTreeState
  selectedPath?: string
  revealVersion?: number
  filterQuery?: string
  archiveIndex?: ArchiveMember[]
}>(), { active: true, changes: () => [], changesOnly: false, refreshVersion: 0 })

const emit = defineEmits<{ open: [payload: { path: string; entry: FileEntry }]; 'node-offline': [] }>()

const files = computed(() => useSessionFiles(props.apiBase, props.folderId))

const fullPath = computed(() => joinPath(props.dir, props.entry.name))
const sizeLabel = computed(() => props.entry.mtime === null ? '' : formatSize(props.entry.size))
const archiveContainer = computed(() => !props.changesOnly && props.entry.type === 'file' && isArchive(props.entry.name))
const expandable = computed(() => props.entry.type === 'dir' || archiveContainer.value)
const decoration = computed(() => props.entry.archive ? undefined : gitDecoration(fullPath.value, props.entry.type === 'dir', props.changes))
const ownArchiveIndex = shallowRef<ArchiveMember[]>()
const childArchiveIndex = computed(() => archiveContainer.value ? ownArchiveIndex.value : props.archiveIndex)

const { expanded, children, loaded, stale } = toRefs(homeDirectoryState(
  props.entry.archive || archiveContainer.value ? undefined : props.homeState, fullPath.value, props.changesOnly && props.entry.type === 'dir'))
const displayChildren = computed(() => props.changesOnly ? changedDirectory(props.changes, fullPath.value) : children.value)
const filteredChildren = computed(() => displayChildren.value.filter(child =>
  !props.filterQuery || child.type === 'dir' || child.name.toLocaleLowerCase().includes(props.filterQuery)))
const loading = ref(false)
const loadError = ref('')
const node = ref<HTMLElement>()
let request: AbortController | undefined

async function loadChildren(): Promise<void> {
  if (props.changesOnly || (loaded.value && !stale.value) || loading.value || !props.active || !(props.folderId || props.sessionId)) return
  const controller = new AbortController()
  request = controller
  loading.value = true
  loadError.value = ''
  try {
    let entries: FileEntry[]
    if (archiveContainer.value) {
      const archive = props.entry.archive ?? { path: fullPath.value, members: [] }
      const index = await listArchive(props.apiBase, props.sessionId, props.folderId, archive, controller.signal)
      if (controller.signal.aborted) return
      entries = archiveDirectory(index, archive)
      ownArchiveIndex.value = index
    } else if (props.entry.archive) {
      if (!props.archiveIndex) throw new Error(t('Archive directory is unavailable. Refresh the file tree.'))
      const { path, members } = props.entry.archive
      entries = archiveDirectory(props.archiveIndex, { path, members: members.slice(0, -1) }, members.at(-1))
    } else {
      const listing = await files.value.listDir(props.sessionId, fullPath.value, controller.signal)
      if (props.homeState && fileWorkspaceKey(props, listing.workdir) !== props.workspaceKey) {
        throw new Error(t('Folder location changed. Refresh files before opening this folder.'))
      }
      entries = listing.entries
    }
    if (controller.signal.aborted) return
    children.value = reconcileFileEntries(children.value, entries)
    loaded.value = true
    stale.value = false
  } catch (cause) {
    if (!controller.signal.aborted) {
      if (isNodeOfflineError(cause)) emit('node-offline')
      else loadError.value = cause instanceof Error ? cause.message : t('Could not load folder.')
    }
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}

function onRowClick(): void {
  if (!props.active) return
  if (expandable.value) {
    expanded.value = !expanded.value
    if (expanded.value) void loadChildren()
    else { request?.abort(); request = undefined; loading.value = false }
  } else {
    emit('open', { path: fullPath.value, entry: props.entry })
  }
}
const sourceKey = computed(() => JSON.stringify([props.apiBase, props.sessionId, props.folderId]))
watch(() => [props.workspaceKey ?? sourceKey.value, fullPath.value, sourceKey.value, props.active, props.refreshVersion] as const,
  ([workspace, path, source, active, refresh], [previousWorkspace, previousPath, previousSource, , previousRefresh]) => {
    const reset = workspace !== previousWorkspace || path !== previousPath
    const changed = source !== previousSource || refresh !== previousRefresh
    if (reset || changed || !active) {
      request?.abort()
      request = undefined
      loading.value = false
    }
    if (reset || (changed && (archiveContainer.value || props.entry.archive))) {
      loaded.value = false
      stale.value = false
      if (reset) expanded.value = props.changesOnly && props.entry.type === 'dir'
      children.value = []
      ownArchiveIndex.value = undefined
      loadError.value = ''
    } else if (refresh !== previousRefresh || (source !== previousSource && !props.homeState)) stale.value = true
    if (active && expanded.value && (!loaded.value || stale.value)) void loadChildren()
})
async function revealSelected(): Promise<void> {
  if (!props.active || !props.selectedPath) return
  if (expandable.value && props.selectedPath.startsWith(`${fullPath.value}/`)) {
    expanded.value = true
    void loadChildren()
  } else if (props.selectedPath === fullPath.value) {
    await nextTick()
    if (props.active && props.selectedPath === fullPath.value) {
      node.value?.querySelector<HTMLElement>('.tree-row')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }
}
watch(() => [props.selectedPath, props.revealVersion, props.active, props.refreshVersion], revealSelected, { flush: 'post' })
onMounted(() => { if (expanded.value) void loadChildren(); void revealSelected() })
watch(() => [props.archiveIndex, props.entry.size, props.entry.mtime], () => {
  if (!archiveContainer.value && !props.entry.archive) return
  request?.abort(); request = undefined; loading.value = false
  stale.value = true
  if (props.active && expanded.value) void loadChildren()
})
onUnmounted(() => request?.abort())
</script>

<style scoped>
.tree-node { --git-status-color: var(--c-text); }
.git-added, .git-untracked { --git-status-color: var(--c-git-added); }
.git-modified, .git-typechanged { --git-status-color: var(--c-git-modified); }
.git-deleted, .git-conflicted { --git-status-color: var(--c-git-deleted); }
.git-renamed { --git-status-color: var(--c-git-renamed); }
.tree-node > :deep(.tree-item .tree-label), .git-status { color: var(--git-status-color); }
.git-status { font-size: 11px; font-weight: 600; }
.tree-note {
  padding: 0.1rem 0.4rem 0.1rem 1.2rem;
  font-size: 12px;
  overflow-wrap: anywhere;
  color: var(--c-text-faint);
}

.tree-note.error {
  color: var(--c-error, #ef4444);
}
.archive-open { display: grid; place-items: center; width: 28px; min-height: 28px; padding: 0; border: 0; color: var(--c-text-secondary); background: transparent; cursor: pointer; }
.archive-open:hover { color: var(--c-text); background: var(--c-bg-soft); }
.archive-open:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
@media (pointer: coarse) { .archive-open { width: 44px; min-height: 44px; } }
</style>
