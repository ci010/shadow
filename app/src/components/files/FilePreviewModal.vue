<template>
  <div class="file-modal-backdrop" :class="{ fullscreen }" @click.self="$emit('close')">
    <div class="file-modal" :class="{ fullscreen }">
      <div class="file-modal-header">
        <span class="file-modal-title" :title="path">{{ entry.name }}</span>
        <div class="file-modal-actions">
          <button v-if="kind === 'html'" class="file-modal-btn" title="Reload preview" @click="reloadFrame">&#8635; Refresh</button>
          <button
            class="file-modal-btn"
            :title="fullscreen ? 'Exit fullscreen' : 'Fullscreen'"
            @click="fullscreen = !fullscreen"
          >{{ fullscreen ? '\u2716 Exit' : '\u26F6 Fullscreen' }}</button>
          <a class="file-modal-btn" :href="raw" target="_blank" rel="noopener noreferrer">Open raw</a>
          <button class="file-modal-btn" @click="$emit('close')">&times;</button>
        </div>
      </div>
      <div class="file-modal-body">
        <img v-if="kind === 'image'" :src="raw" class="file-modal-media" >
        <video v-else-if="kind === 'video'" :src="raw" class="file-modal-media" controls autoplay />
        <audio v-else-if="kind === 'audio'" :src="raw" controls class="file-modal-audio" />
        <iframe
          v-else-if="kind === 'html'"
          :key="frameNonce"
          :src="staticSrc"
          class="file-modal-frame"
          sandbox="allow-scripts allow-forms allow-popups"
          referrerpolicy="no-referrer"
        ></iframe>
        <iframe v-else-if="kind === 'pdf'" :src="raw" class="file-modal-frame"></iframe>
        <div v-else-if="kind === 'text'" class="file-modal-text-wrap">
          <div v-if="loading" class="file-modal-note">Loading…</div>
          <pre v-else class="file-modal-text">{{ textContent }}</pre>
          <div v-if="truncated" class="file-modal-note">Preview truncated — use “Open raw” for the full file.</div>
        </div>
        <div v-else class="file-modal-note">
          No inline preview available.
          <a :href="raw" target="_blank" rel="noopener noreferrer">Download</a>.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  type FileEntry,
  fileKind,
  joinPath,
  useSessionFiles,
} from '../../composables/useSessionFiles'

const props = defineProps<{
  apiBase: string
  sessionId: string
  dir: string
  entry: FileEntry
}>()

defineEmits<{ close: [] }>()

const files = useSessionFiles(props.apiBase)

const path = computed(() => joinPath(props.dir, props.entry.name))
const kind = computed(() => fileKind(props.entry.ext))
const raw = computed(() => files.rawUrl(props.sessionId, path.value))
const staticSrc = computed(() => files.staticUrl(props.sessionId, path.value))

// Bumping this recreates the preview iframe, forcing a fresh reload.
const frameNonce = ref(0)
function reloadFrame(): void {
  frameNonce.value++
}

// Whether the modal fills the whole viewport.
const fullscreen = ref(false)

const textContent = ref('')
const truncated = ref(false)
const loading = ref(false)

async function loadText(): Promise<void> {
  if (kind.value !== 'text') return
  loading.value = true
  textContent.value = ''
  try {
    const p = await files.preview(props.sessionId, path.value, 65536)
    if (!p.binary && p.content != null) {
      textContent.value = p.content
      truncated.value = !!p.truncated
    }
  } catch {
    textContent.value = '(failed to load preview)'
  } finally {
    loading.value = false
  }
}

onMounted(loadText)
watch(path, loadText)
</script>

<style scoped>
.file-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  backdrop-filter: blur(2px);
}

.file-modal {
  display: flex;
  flex-direction: column;
  max-width: min(1100px, 92vw);
  max-height: 88vh;
  width: 100%;
  background: var(--c-bg-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-overlay);
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

/* Fullscreen: fill the whole viewport. */
.file-modal-backdrop.fullscreen {
  padding: 0;
}

.file-modal.fullscreen {
  max-width: 100vw;
  max-height: 100vh;
  width: 100vw;
  height: 100vh;
  border: none;
  border-radius: 0;
}

.file-modal.fullscreen .file-modal-media {
  max-height: calc(100vh - 4rem);
}

.file-modal.fullscreen .file-modal-frame {
  height: calc(100vh - 3.2rem);
}

.file-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-bg-muted);
}

.file-modal-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-modal-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.file-modal-btn {
  font-size: 0.75rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-bg-card);
  color: var(--c-text);
  cursor: pointer;
  text-decoration: none;
  line-height: 1.4;
}

.file-modal-btn:hover {
  border-color: var(--c-primary, #6366f1);
}

.file-modal-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 1rem;
  background: var(--c-bg-muted);
}

.file-modal-media {
  max-width: 100%;
  max-height: calc(88vh - 4rem);
  object-fit: contain;
  border-radius: var(--radius-control);
}

.file-modal-audio {
  width: 80%;
}

.file-modal-frame {
  width: 100%;
  height: calc(88vh - 4rem);
  border: none;
  background: #fff;
}

.file-modal-text-wrap {
  align-self: stretch;
  width: 100%;
}

.file-modal-text {
  margin: 0;
  padding: 0.75rem 1rem;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--c-text);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--c-bg-card);
  border-radius: var(--radius-control);
}

.file-modal-note {
  padding: 0.6rem 1rem;
  font-size: 0.75rem;
  color: var(--c-text-muted);
  text-align: center;
}
</style>
