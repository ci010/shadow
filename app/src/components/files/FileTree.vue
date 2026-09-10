<template>
  <div class="file-tree">
    <div class="file-tree-header">
      <span class="file-tree-title">Workspace Files</span>
      <button class="file-tree-refresh" title="Refresh" @click="reload">&#8635;</button>
    </div>
    <div class="file-tree-body">
      <div v-if="!sessionId" class="file-tree-note">Select a session to browse its files.</div>
      <div v-else-if="loading" class="file-tree-note">Loading…</div>
      <div v-else-if="error" class="file-tree-note error">{{ error }}</div>
      <div v-else-if="rootEntries.length === 0" class="file-tree-note">No files in this workspace.</div>
      <template v-else>
        <FileTreeNode
          v-for="entry in rootEntries"
          :key="entry.name"
          :api-base="apiBase"
          :session-id="sessionId"
          dir=""
          :entry="entry"
          :depth="0"
          @open="onOpen"
        />
      </template>
    </div>

    <FilePreviewModal
      v-if="previewEntry"
      :api-base="apiBase"
      :session-id="sessionId"
      :dir="previewDir"
      :entry="previewEntry"
      @close="previewEntry = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import FileTreeNode from './FileTreeNode.vue'
import FilePreviewModal from './FilePreviewModal.vue'
import { type FileEntry, useSessionFiles } from '../../composables/useSessionFiles'

const props = defineProps<{
  apiBase: string
  sessionId: string
  /** When true, clicking a file opens the inline preview modal. */
  previewOnOpen?: boolean
}>()

const emit = defineEmits<{ open: [payload: { path: string; entry: FileEntry }] }>()

const files = useSessionFiles(props.apiBase)

const rootEntries = ref<FileEntry[]>([])
const loading = ref(false)
const error = ref('')

const previewEntry = ref<FileEntry | null>(null)
const previewDir = ref('')

async function reload(): Promise<void> {
  if (!props.sessionId) {
    rootEntries.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const listing = await files.listDir(props.sessionId, '')
    rootEntries.value = listing.entries
  } catch {
    error.value = 'Failed to load files.'
    rootEntries.value = []
  } finally {
    loading.value = false
  }
}

function onOpen(payload: { path: string; entry: FileEntry }): void {
  emit('open', payload)
  if (props.previewOnOpen) {
    // path = dir/name → derive the parent dir for the modal.
    const idx = payload.path.lastIndexOf('/')
    previewDir.value = idx >= 0 ? payload.path.slice(0, idx) : ''
    previewEntry.value = payload.entry
  }
}

// Re-wire the emit so the modal opens when previewOnOpen is set.
defineExpose({ reload })

watch(() => props.sessionId, reload, { immediate: true })
</script>

<style scoped>
.file-tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.file-tree-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--c-border);
}

.file-tree-title {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--c-text-muted);
}

.file-tree-refresh {
  border: none;
  background: transparent;
  color: var(--c-text-muted);
  cursor: pointer;
  font-size: 0.85rem;
}

.file-tree-refresh:hover {
  color: var(--c-text);
}

.file-tree-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.4rem 0.3rem;
}

.file-tree-note {
  padding: 1rem 0.75rem;
  font-size: 0.75rem;
  color: var(--c-text-muted);
  text-align: center;
}

.file-tree-note.error {
  color: var(--c-error, #ef4444);
}
</style>
