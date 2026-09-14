<template>
  <div class="tree-node" :class="decoration ? `git-${decoration}` : undefined">
    <TreeRow button-class="tree-row" :button-attrs="{ 'data-path': fullPath, 'aria-busy': loading, 'aria-disabled': !active }" :label="entry.name" :depth="depth"
      :title="decoration ? `${fullPath}\n${entry.type === 'dir' ? 'Contains changes: ' : ''}${gitChangeLabel(decoration)}` : fullPath"
      :expanded="entry.type === 'dir' ? expanded : undefined" @select="onRowClick">
      <template #icon><span :class="entry.type === 'dir' ? (expanded ? 'i-lucide-folder-open' : 'i-lucide-folder') : 'i-lucide-file'" /></template>
      <template v-if="entry.type === 'file'" #meta>
        <span v-if="decoration" class="git-status" :aria-label="gitChangeLabel(decoration)">{{ gitChangeBadge(decoration) }}</span>
        <span v-else>{{ sizeLabel }}</span>
      </template>
    </TreeRow>

    <div v-if="entry.type === 'dir'" v-show="expanded" class="tree-children">
      <div v-if="loading && !loaded && !changesOnly" class="tree-note">…</div>
      <div v-else-if="loadError && !changesOnly" class="tree-note error" role="alert">{{ loadError }} <button class="btn btn-sm" @click="loadChildren">Retry</button></div>
      <FileTreeNode
        v-for="child in displayChildren"
        :key="fileEntryKey(child)"
        :api-base="apiBase"
        :session-id="sessionId"
        :project-id="projectId"
        :dir="fullPath"
        :entry="child"
        :depth="depth + 1"
        :active="active && expanded"
        :refresh-version="refreshVersion"
        :workspace-key="workspaceKey"
        :changes="changes"
        :changes-only="changesOnly"
        @open="$emit('open', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import FileTreeNode from './FileTreeNode.vue'
import TreeRow from '../TreeRow.vue'
import { fileEntryKey, reconcileFileEntries } from '../../file-tree-state.ts'
import { changedDirectory, gitChangeBadge, gitChangeLabel, gitDecoration, type GitChange } from '../../git-files.ts'
import {
  type FileEntry,
  formatSize,
  joinPath,
  useSessionFiles,
} from '../../composables/useSessionFiles'

const props = withDefaults(defineProps<{
  apiBase: string
  sessionId: string
  projectId?: string
  dir: string
  entry: FileEntry
  depth: number
  active?: boolean
  changes?: readonly GitChange[]
  changesOnly?: boolean
  refreshVersion?: number
  workspaceKey?: string
}>(), { active: true, changes: () => [], changesOnly: false, refreshVersion: 0 })

const emit = defineEmits<{ open: [payload: { path: string; entry: FileEntry }] }>()

const files = computed(() => useSessionFiles(props.apiBase, props.projectId))

const fullPath = computed(() => joinPath(props.dir, props.entry.name))
const sizeLabel = computed(() => props.entry.mtime === null ? '' : formatSize(props.entry.size))
const decoration = computed(() => gitDecoration(fullPath.value, props.entry.type === 'dir', props.changes))

const expanded = ref(props.changesOnly && props.entry.type === 'dir')
const children = ref<FileEntry[]>([])
const displayChildren = computed(() => props.changesOnly ? changedDirectory(props.changes, fullPath.value) : children.value)
const loaded = ref(false)
const stale = ref(false)
const loading = ref(false)
const loadError = ref('')
let request: AbortController | undefined

async function loadChildren(): Promise<void> {
  if (props.changesOnly || (loaded.value && !stale.value) || loading.value || !props.active || !(props.projectId || props.sessionId)) return
  const controller = new AbortController()
  request = controller
  loading.value = true
  loadError.value = ''
  try {
    const listing = await files.value.listDir(props.sessionId, fullPath.value, controller.signal)
    if (controller.signal.aborted) return
    children.value = reconcileFileEntries(children.value, listing.entries)
    loaded.value = true
    stale.value = false
  } catch (cause) {
    if (!controller.signal.aborted) loadError.value = cause instanceof Error ? cause.message : 'Could not load folder.'
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}

function onRowClick(): void {
  if (!props.active) return
  if (props.entry.type === 'dir') {
    expanded.value = !expanded.value
    if (expanded.value) void loadChildren()
  } else {
    emit('open', { path: fullPath.value, entry: props.entry })
  }
}
const sourceKey = computed(() => JSON.stringify([props.apiBase, props.sessionId, props.projectId]))
watch(() => [props.workspaceKey ?? sourceKey.value, fullPath.value, sourceKey.value, props.active, props.refreshVersion] as const,
  ([workspace, path, source, active, refresh], [previousWorkspace, previousPath, previousSource, , previousRefresh]) => {
    const reset = workspace !== previousWorkspace || path !== previousPath
    const changed = source !== previousSource || refresh !== previousRefresh
    if (reset || changed || !active) {
      request?.abort()
      request = undefined
      loading.value = false
    }
    if (reset) {
      loaded.value = false
      stale.value = false
      expanded.value = props.changesOnly && props.entry.type === 'dir'
      children.value = []
      loadError.value = ''
    } else if (changed) stale.value = true
    if (active && expanded.value && (!loaded.value || stale.value)) void loadChildren()
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
</style>
