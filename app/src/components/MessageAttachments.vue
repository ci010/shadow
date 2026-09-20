<template>
  <div v-if="paths.length" class="message-attachments" aria-label="Attachments">
    <div v-for="item in items" :key="item.path" class="message-attachment" :class="`attachment-${item.kind}`">
      <button v-if="item.kind === 'image' && item.url && !failed.has(item.path)" type="button" class="attachment-image-link"
        aria-haspopup="dialog" :aria-label="`View image: ${item.name}`"
        @click="$emit('preview', { src: item.url, name: item.name, downloadUrl: item.downloadUrl ?? undefined, trigger: $event.currentTarget as HTMLButtonElement })">
        <img :src="item.url" :alt="item.name" loading="lazy" class="attachment-image" @error="failed.add(item.path)">
      </button>
      <video v-else-if="item.kind === 'video' && item.url && !failed.has(item.path)"
        :src="item.url" controls playsinline preload="none" :aria-label="item.name" @error="failed.add(item.path)" />
      <audio v-else-if="item.kind === 'audio' && item.url && !failed.has(item.path)"
        :src="item.url" controls preload="none" :aria-label="item.name" @error="failed.add(item.path)" />
      <div v-if="item.kind !== 'image' || !item.url || failed.has(item.path)" class="attachment-details">
        <span class="attachment-icon" :class="item.kind === 'video' ? 'i-lucide-file-video' : item.kind === 'audio' ? 'i-lucide-file-audio' : 'i-lucide-file'" aria-hidden="true" />
        <div class="attachment-description">
          <span class="attachment-name" :title="item.name">{{ item.name }}</span>
          <span class="attachment-type">{{ item.extension ? item.extension.toUpperCase() + ' file' : 'File' }}</span>
        </div>
        <a v-if="item.downloadUrl" class="attachment-download" :href="item.downloadUrl" :download="item.name" :aria-label="`Download ${item.name}`" :title="`Download ${item.name}`">
          <span class="i-lucide-download" aria-hidden="true" /><span>Download</span>
        </a>
      </div>
      <p v-if="!item.url" class="attachment-error" role="status">Attachment unavailable in this conversation.</p>
      <p v-else-if="failed.has(item.path)" class="attachment-error" role="status">Preview unavailable. Download the file to open it on your device.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import { buildMediaUrl } from '../media-url.ts'
import { attachmentExtension, attachmentKind, attachmentName } from '../message-attachments.ts'
import type { ImagePreview } from '../image-viewer.ts'

const props = defineProps<{ paths: string[]; apiBase: string; sessionId: string }>()
defineEmits<{ preview: [image: ImagePreview] }>()
const failed = reactive(new Set<string>())
const items = computed(() => props.paths.map(path => ({
  path, name: attachmentName(path), kind: attachmentKind(path), extension: attachmentExtension(path),
  url: buildMediaUrl(props.apiBase, props.sessionId, path),
  downloadUrl: buildMediaUrl(props.apiBase, props.sessionId, path, true),
})))
</script>

<style scoped>
.message-attachments { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; min-width: 0; }
.message-attachment { max-width: 100%; width: 420px; overflow: hidden; }
.attachment-image { width: auto; max-width: 100%; max-height: 320px; display: block; object-fit: contain; }
.attachment-image-link { display: block; width: fit-content; max-width: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
video { display: block; width: 100%; max-height: 360px; aspect-ratio: 16 / 9; background: #000; }
audio { display: block; width: 100%; }
.attachment-details { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--c-border); background: var(--c-bg-soft); }
.attachment-icon { width: 22px; height: 22px; flex: 0 0 22px; color: var(--c-text-secondary); }
.attachment-description { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.attachment-name { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; color: var(--c-text); }
.attachment-type { font-size: 12px; color: var(--c-text-secondary); }
.attachment-download { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 8px; color: var(--c-text); font-size: 12px; text-decoration: none; flex-shrink: 0; }
.attachment-download:hover { background: var(--c-bg-muted); }
.attachment-download > span:first-child { width: 16px; height: 16px; }
.attachment-download:focus-visible, .attachment-image-link:focus-visible { outline: 2px solid var(--c-text-secondary); outline-offset: -2px; }
.attachment-error { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--c-text-secondary); background: var(--c-bg-soft); overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .attachment-details { gap: 8px; padding: 10px; }
  .attachment-download > span:last-child { display: none; }
  .attachment-download { min-width: 36px; }
}
</style>
