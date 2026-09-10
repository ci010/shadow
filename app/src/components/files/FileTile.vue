<template>
  <button class="file-tile" :class="`kind-${kind}`" @click="$emit('open', entry)">
    <div class="file-tile-preview">
      <template v-if="entry.type === 'dir'">
        <span class="file-tile-glyph">{{ glyph }}</span>
      </template>
      <template v-else-if="kind === 'image'">
        <img v-if="!mediaFailed" :src="raw" class="file-tile-img" loading="lazy" @error="onMediaError" >
        <span v-else class="file-tile-glyph">{{ glyph }}</span>
      </template>
      <template v-else-if="kind === 'video'">
        <video :src="raw" class="file-tile-img" muted preload="metadata" />
        <span class="file-tile-badge">&#9654;</span>
      </template>
      <template v-else-if="kind === 'audio'">
        <span class="file-tile-glyph">{{ glyph }}</span>
      </template>
      <template v-else-if="kind === 'html'">
        <iframe
          :src="staticSrc"
          class="file-tile-frame"
          scrolling="no"
          tabindex="-1"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
        ></iframe>
        <span class="file-tile-badge html">&#127760;</span>
      </template>
      <template v-else-if="kind === 'text'">
        <pre v-if="textPreview" class="file-tile-text">{{ textPreview }}</pre>
        <span v-else class="file-tile-glyph">{{ glyph }}</span>
      </template>
      <template v-else>
        <span class="file-tile-glyph">{{ glyph }}</span>
      </template>
    </div>
    <div class="file-tile-meta">
      <span class="file-tile-name" :title="entry.name">{{ entry.name }}</span>
      <span v-if="entry.type === 'file'" class="file-tile-size">{{ sizeLabel }}</span>
    </div>
  </button>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  type FileEntry,
  fileGlyph,
  fileKind,
  formatSize,
  joinPath,
  useSessionFiles,
} from '../../composables/useSessionFiles'

const props = defineProps<{
  apiBase: string
  sessionId: string
  dir: string
  entry: FileEntry
}>()

defineEmits<{ open: [entry: FileEntry] }>()

const files = useSessionFiles(props.apiBase)

const fullPath = computed(() => joinPath(props.dir, props.entry.name))
const kind = computed(() => (props.entry.type === 'dir' ? 'other' : fileKind(props.entry.ext)))
const glyph = computed(() => fileGlyph(props.entry))
const sizeLabel = computed(() => formatSize(props.entry.size))
const raw = computed(() => files.rawUrl(props.sessionId, fullPath.value))
const staticSrc = computed(() => files.staticUrl(props.sessionId, fullPath.value))

const textPreview = ref('')
const mediaFailed = ref(false)

function onMediaError(): void {
  mediaFailed.value = true
}

async function loadTextPreview(): Promise<void> {
  if (props.entry.type !== 'file' || kind.value !== 'text') return
  try {
    const p = await files.preview(props.sessionId, fullPath.value, 512)
    if (!p.binary && p.content) textPreview.value = p.content
  } catch { /* leave glyph fallback */ }
}

onMounted(loadTextPreview)
watch(fullPath, loadTextPreview)
</script>

<style scoped>
.file-tile {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: var(--c-bg-card);
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  padding: 0;
  transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
}

.file-tile:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 14px var(--c-shadow-soft);
  border-color: var(--c-primary, #6366f1);
}

.file-tile.kind-other,
.file-tile[data-dir] {
  background: var(--c-bg-muted);
}

.file-tile-preview {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--c-bg-muted);
  overflow: hidden;
}

.file-tile-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.file-tile-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
  pointer-events: none;
  transform-origin: top left;
}

.file-tile-glyph {
  font-size: 2.2rem;
  line-height: 1;
  opacity: 0.75;
}

.file-tile-badge {
  position: absolute;
  bottom: 0.3rem;
  right: 0.4rem;
  font-size: 0.7rem;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 50%;
  width: 1.3rem;
  height: 1.3rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.file-tile-text {
  margin: 0;
  padding: 0.4rem 0.5rem;
  width: 100%;
  height: 100%;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.55rem;
  line-height: 1.35;
  color: var(--c-text-secondary, var(--c-text-body));
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}

.file-tile-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  padding: 0.35rem 0.5rem;
  border-top: 1px solid var(--c-border-soft, var(--c-border));
  background: var(--c-bg-card);
}

.file-tile-name {
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.file-tile-size {
  flex-shrink: 0;
  font-size: 0.58rem;
  color: var(--c-text-faint);
}
</style>
