<template>
  <div v-if="paths.length" class="message-attachments" :aria-label="t('Attachments')">
    <div v-for="item in items" :key="item.path" class="message-attachment" :class="`attachment-${item.kind}`">
      <button v-if="item.kind === 'image' && item.url && !failed.has(item.path)" type="button" class="attachment-image-link"
        aria-haspopup="dialog" :aria-label="t('View image: {name}', { name: item.name })"
        @click="$emit('preview', { src: item.url, name: item.name, downloadUrl: item.downloadUrl ?? undefined, trigger: $event.currentTarget as HTMLButtonElement })">
        <img :src="item.url" :alt="item.name" loading="lazy" class="attachment-image" referrerpolicy="no-referrer" @error="failed.add(item.path)">
      </button>
      <video v-else-if="item.kind === 'video' && item.url && !failed.has(item.path)"
        v-mobile-media="resources.native ? item.path : undefined"
        :src="item.url" controls playsinline preload="none" :aria-label="item.name" @error="failed.add(item.path)" />
      <audio v-else-if="item.kind === 'audio' && item.url && !failed.has(item.path)"
        v-mobile-media="resources.native ? item.path : undefined"
        :src="item.url" controls preload="none" :aria-label="item.name" @error="failed.add(item.path)" />
      <div v-if="item.kind !== 'image' || !item.url || failed.has(item.path)" class="attachment-details">
        <component :is="item.file ? 'button' : 'div'" class="attachment-main" :class="{ 'attachment-open': item.file }"
          :type="item.file ? 'button' : undefined" :aria-label="item.file ? t('Open {name} in tab', { name: item.name }) : undefined"
          @click="item.file && $emit('open', item.file)">
          <span class="attachment-icon" :class="item.kind === 'video' ? 'i-lucide-file-video' : item.kind === 'audio' ? 'i-lucide-file-audio' : 'i-lucide-file'" aria-hidden="true" />
          <span class="attachment-description">
            <span class="attachment-name" :title="item.name">{{ item.name }}</span>
            <span class="attachment-type">{{ item.extension ? item.extension.toUpperCase() + t(' file') : t('File') }}</span>
          </span>
        </component>
        <a v-if="item.downloadUrl" class="attachment-download" :href="item.downloadUrl" :download="item.name" :aria-label="t('Download {name}', { name: item.name })" :title="t('Download {name}', { name: item.name })" referrerpolicy="no-referrer"
          :aria-busy="downloads.pending.has(item.downloadUrl)" :aria-disabled="downloads.pending.has(item.downloadUrl)"
          @click="downloads.download($event, item.downloadUrl, item.name)">
          <span :class="downloads.pending.has(item.downloadUrl) ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-download'" aria-hidden="true" /><span>{{ downloads.pending.has(item.downloadUrl) ? t('Downloading...') : t('Download') }}</span>
        </a>
      </div>
      <p v-if="!item.url" class="attachment-error" role="status">{{ t('Attachment unavailable in this conversation.') }}</p>
      <p v-else-if="failed.has(item.path)" class="attachment-error" role="status">{{ t('Preview unavailable. Download the file to open it on your device.') }}</p>
      <p v-if="item.downloadUrl && downloads.errors.has(item.downloadUrl)" class="attachment-error" role="alert">{{ downloads.errors.get(item.downloadUrl) }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, reactive, watch } from 'vue'
import { useFileDownload } from '../composables/useFileDownload.ts'
import { buildMediaUrl, chatIdForMediaSession } from '../media-url.ts'
import { useMobileResources, vMobileMedia } from '../mobile-resources.ts'
import { attachmentExtension, attachmentFile, attachmentKind, attachmentName } from '../message-attachments.ts'
import type { ImagePreview } from '../image-viewer.ts'
import type { OpenFile } from '../file-workbench.ts'
import type { SessionDetails } from '../session-details.ts'

const props = defineProps<{ paths: string[]; apiBase: string; sessionId: string; workdir?: SessionDetails['workdir'] }>()
defineEmits<{ preview: [image: ImagePreview]; open: [file: OpenFile] }>()
const failed = reactive(new Set<string>())
const resources = useMobileResources()
const downloads = useFileDownload()
watch(() => JSON.stringify([props.apiBase, props.sessionId, props.paths]), () => { downloads.reset(); failed.clear() })
const items = computed(() => props.paths.map(path => ({
  path, name: attachmentName(path), kind: attachmentKind(path), extension: attachmentExtension(path),
  file: attachmentKind(path) === 'file' && chatIdForMediaSession(props.sessionId) ? attachmentFile(path, props.workdir) : undefined,
  url: resources.resolve(buildMediaUrl(props.apiBase, props.sessionId, path)),
  downloadUrl: resources.resolve(buildMediaUrl(props.apiBase, props.sessionId, path, true)),
})))
</script>

<style scoped>
.message-attachments { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; min-width: 0; }
.message-attachment { max-width: 100%; width: 420px; overflow: hidden; }
.attachment-image { width: auto; max-width: 100%; max-height: 320px; display: block; object-fit: contain; }
.attachment-image-link { display: block; width: fit-content; max-width: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
video { display: block; width: 100%; max-height: 360px; aspect-ratio: 16 / 9; background: #000; }
audio { display: block; width: 100%; }
.attachment-details { position: relative; display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--c-border); background: var(--c-bg-soft); }
.attachment-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; }
.attachment-open { cursor: pointer; }
.attachment-open::after { content: ''; position: absolute; inset: 0; }
.attachment-open:hover .attachment-name { text-decoration: underline; }
.attachment-open:focus-visible { outline: none; }
.attachment-open:focus-visible::after { outline: 2px solid var(--c-text-secondary); outline-offset: -2px; }
.attachment-icon { width: 22px; height: 22px; flex: 0 0 22px; color: var(--c-text-secondary); }
.attachment-description { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.attachment-name { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; color: var(--c-text); }
.attachment-type { font-size: 12px; color: var(--c-text-secondary); }
.attachment-download { position: relative; display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 8px; color: var(--c-text); font-size: 12px; text-decoration: none; flex-shrink: 0; }
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
