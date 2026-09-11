<template>
  <div class="tree-node">
    <div
      class="tree-row"
      :style="{ paddingLeft: `${depth * 12 + 6}px` }"
      @click="onRowClick"
    >
      <span v-if="entry.type === 'dir'" class="tree-caret" :class="{ open: expanded }">&#9654;</span>
      <span v-else class="tree-caret-spacer" />
      <span class="tree-glyph">{{ glyph }}</span>
      <span class="tree-name" :title="entry.name">{{ entry.name }}</span>
      <span v-if="entry.type === 'file'" class="tree-size">{{ sizeLabel }}</span>
    </div>

    <div v-if="entry.type === 'dir' && expanded" class="tree-children">
      <div v-if="loading" class="tree-note">…</div>
      <div v-else-if="loadError" class="tree-note error">failed</div>
      <div v-else-if="children.length === 0" class="tree-note">empty</div>
      <FileTreeNode
        v-for="child in children"
        :key="child.name"
        :api-base="apiBase"
        :session-id="sessionId"
        :dir="fullPath"
        :entry="child"
        :depth="depth + 1"
        @open="$emit('open', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import FileTreeNode from './FileTreeNode.vue'
import {
  type FileEntry,
  fileGlyph,
  formatSize,
  joinPath,
  useSessionFiles,
} from '../../composables/useSessionFiles'

const props = defineProps<{
  apiBase: string
  sessionId: string
  dir: string
  entry: FileEntry
  depth: number
}>()

const emit = defineEmits<{ open: [payload: { path: string; entry: FileEntry }] }>()

const files = useSessionFiles(props.apiBase)

const fullPath = computed(() => joinPath(props.dir, props.entry.name))
const glyph = computed(() => fileGlyph(props.entry))
const sizeLabel = computed(() => formatSize(props.entry.size))

const expanded = ref(false)
const children = ref<FileEntry[]>([])
const loaded = ref(false)
const loading = ref(false)
const loadError = ref(false)

async function loadChildren(): Promise<void> {
  if (loaded.value || loading.value) return
  loading.value = true
  loadError.value = false
  try {
    const listing = await files.listDir(props.sessionId, fullPath.value)
    children.value = listing.entries
    loaded.value = true
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

function onRowClick(): void {
  if (props.entry.type === 'dir') {
    expanded.value = !expanded.value
    if (expanded.value) void loadChildren()
  } else {
    emit('open', { path: fullPath.value, entry: props.entry })
  }
}
</script>

<style scoped>
.tree-row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.4rem 0.15rem 0;
  border-radius: var(--radius-control);
  cursor: pointer;
  font-size: 0.72rem;
  color: var(--c-text);
  user-select: none;
}

.tree-row:hover {
  background: var(--c-bg-muted);
}

.tree-caret {
  flex-shrink: 0;
  font-size: 0.5rem;
  color: var(--c-text-faint);
  transition: transform 0.12s ease;
}

.tree-caret.open {
  transform: rotate(90deg);
}

.tree-caret-spacer {
  width: 0.5rem;
  flex-shrink: 0;
}

.tree-glyph {
  flex-shrink: 0;
  font-size: 0.75rem;
}

.tree-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.tree-size {
  flex-shrink: 0;
  font-size: 0.55rem;
  color: var(--c-text-faint);
}

.tree-note {
  padding: 0.1rem 0.4rem 0.1rem 1.2rem;
  font-size: 0.6rem;
  color: var(--c-text-faint);
}

.tree-note.error {
  color: var(--c-error, #ef4444);
}
</style>
