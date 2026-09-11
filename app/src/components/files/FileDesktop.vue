<template>
  <div class="file-desktop">
    <!-- Breadcrumb / toolbar -->
    <div class="file-desktop-bar">
      <button class="crumb" :class="{ active: currentPath === '' }" @click="navigate('')">
        <span class="crumb-home">&#127968;</span> workspace
      </button>
      <template v-for="crumb in crumbs" :key="crumb.path">
        <span class="crumb-sep">/</span>
        <button class="crumb" :class="{ active: crumb.path === currentPath }" @click="navigate(crumb.path)">
          {{ crumb.name }}
        </button>
      </template>
      <span class="file-desktop-spacer" />
      <button class="file-desktop-refresh" title="Refresh" @click="reload">&#8635;</button>
    </div>

    <!-- Grid -->
    <div class="file-desktop-body">
      <div v-if="loading" class="file-desktop-note">Loading…</div>
      <div v-else-if="error" class="file-desktop-note error">{{ error }}</div>
      <div v-else-if="entries.length === 0" class="file-desktop-note">This folder is empty.</div>
      <div v-else class="file-grid">
        <FileTile
          v-for="entry in entries"
          :key="entry.name"
          :api-base="apiBase"
          :session-id="sessionId"
          :dir="currentPath"
          :entry="entry"
          @open="onOpen"
        />
      </div>
    </div>

    <!-- Full preview modal -->
    <FilePreviewModal
      v-if="previewEntry"
      :api-base="apiBase"
      :session-id="sessionId"
      :dir="currentPath"
      :entry="previewEntry"
      @close="previewEntry = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import FileTile from './FileTile.vue'
import FilePreviewModal from './FilePreviewModal.vue'
import {
  breadcrumbs,
  type FileEntry,
  joinPath,
  useSessionFiles,
} from '../../composables/useSessionFiles'

const props = defineProps<{
  apiBase: string
  sessionId: string
}>()

const files = useSessionFiles(props.apiBase)

const currentPath = ref('')
const entries = ref<FileEntry[]>([])
const loading = ref(false)
const error = ref('')
const previewEntry = ref<FileEntry | null>(null)

const crumbs = computed(() => breadcrumbs(currentPath.value))

async function reload(): Promise<void> {
  if (!props.sessionId) {
    entries.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const listing = await files.listDir(props.sessionId, currentPath.value)
    entries.value = listing.entries
  } catch {
    error.value = 'Failed to load workspace files.'
    entries.value = []
  } finally {
    loading.value = false
  }
}

function navigate(path: string): void {
  currentPath.value = path
}

function onOpen(entry: FileEntry): void {
  if (entry.type === 'dir') {
    currentPath.value = joinPath(currentPath.value, entry.name)
  } else {
    previewEntry.value = entry
  }
}

// Reset to root when the session changes, then (re)load on path/session change.
watch(() => props.sessionId, () => {
  currentPath.value = ''
  previewEntry.value = null
  void reload()
})
watch(currentPath, () => {
  previewEntry.value = null
  void reload()
})

void reload()
</script>

<style scoped>
.file-desktop {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.file-desktop-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex-wrap: wrap;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-frosted, var(--c-bg-muted));
}

.crumb {
  font-size: 0.75rem;
  padding: 0.15rem 0.4rem;
  border-radius: var(--radius-control);
  border: none;
  background: transparent;
  color: var(--c-text-muted);
  cursor: pointer;
}

.crumb:hover {
  background: var(--c-bg-muted);
  color: var(--c-text);
}

.crumb.active {
  color: var(--c-text);
  font-weight: 600;
}

.crumb-home {
  font-size: 0.7rem;
}

.crumb-sep {
  color: var(--c-text-faint);
  font-size: 0.7rem;
}

.file-desktop-spacer {
  flex: 1;
}

.file-desktop-refresh {
  border: none;
  background: transparent;
  color: var(--c-text-muted);
  cursor: pointer;
  font-size: 0.9rem;
  padding: 0.15rem 0.4rem;
  border-radius: var(--radius-control);
}

.file-desktop-refresh:hover {
  background: var(--c-bg-muted);
  color: var(--c-text);
}

.file-desktop-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.85rem;
}

.file-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  grid-auto-rows: 140px;
  gap: 0.75rem;
}

.file-desktop-note {
  padding: 2rem;
  text-align: center;
  color: var(--c-text-muted);
  font-size: 0.85rem;
}

.file-desktop-note.error {
  color: var(--c-error, #ef4444);
}
</style>
