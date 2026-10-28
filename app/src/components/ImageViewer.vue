<template>
  <Teleport to="body">
    <dialog ref="dialog" class="image-viewer" :aria-labelledby="titleId"
      @cancel.prevent="close" @close="closed" @keydown="viewerKeydown"
      @pointerdown="backdropStart" @click="backdropEnd">
      <header class="image-viewer-header">
        <h2 :id="titleId" :title="image.name">{{ image.name }}</h2>
        <button v-if="!image.localFile" type="button" class="viewer-control" :disabled="status !== 'ready'" :aria-pressed="actualSize"
          :aria-label="actualSize ? t('Fit image to window') : t('View image at actual size')" @click="toggleSize">
          <span :class="actualSize ? 'i-lucide-minimize' : 'i-lucide-scan'" aria-hidden="true" />
          <span class="viewer-control-label">{{ actualSize ? t('Fit') : '100%' }}</span>
        </button>
        <a v-if="downloadUrl" class="viewer-control" :href="downloadUrl" :download="image.name" :aria-label="t('Download {name}', { name: image.name })" referrerpolicy="no-referrer"
          :aria-busy="downloads.pending.has(downloadUrl)" :aria-disabled="downloads.pending.has(downloadUrl)"
          @click="downloads.download($event, downloadUrl, image.name)">
          <span :class="downloads.pending.has(downloadUrl) ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-download'" aria-hidden="true" />
        </a>
        <button ref="closeButton" type="button" class="viewer-control" :aria-label="t('Close image viewer')" autofocus @click="close">
          <span class="i-lucide-x" aria-hidden="true" />
        </button>
      </header>
      <p v-if="downloadUrl && downloads.errors.has(downloadUrl)" class="viewer-download-error" role="alert">{{ downloads.errors.get(downloadUrl) }}</p>
      <nav v-if="image.localFile && image.attachmentKey" class="viewer-modes" :aria-label="t('Image interaction mode')">
        <button type="button" class="btn" :aria-pressed="mode === 'marks'" @click="mode = 'marks'">{{ t('Freehand marks') }}</button>
        <button type="button" class="btn" :aria-pressed="mode === 'alignment'" @click="openAlignment">{{ t('Region instructions') }}</button>
      </nav>
      <div ref="viewport" class="image-viewer-viewport" :class="{ 'actual-size': actualSize }" tabindex="0" role="region"
        :aria-label="t('Image preview')" :aria-busy="status === 'loading'">
        <ImageAlignmentPanel v-if="alignmentOpened && image.localFile" v-show="mode === 'alignment'" ref="alignmentPanel"
          :key="image.attachmentKey" :file="image.localFile" :initial="image.alignment" :editable="!!editable" :active="mode === 'alignment'"
          @apply="applyAlignment" @clear="clearAlignment" />
        <ImageAnnotationPreview v-if="image.localFile && image.attachmentKey" v-show="mode === 'marks'" class="viewer-annotation"
          :src="image.src" :name="image.name" :local-file="image.localFile"
          :source-key="image.attachmentKey" :context-key="contextKey ?? ''" :active="mode === 'marks'" :editable="!!editable"
          @image-context="emit('image-context', $event)" @image-busy="emit('image-busy', $event)" />
        <div v-else-if="status !== 'error'" class="image-viewer-canvas">
          <img :key="attempt" :src="resources.resolve(image.src)" :alt="image.name" :class="{ loading: status === 'loading' }" referrerpolicy="no-referrer"
            @load="status = 'ready'" @error="status = 'error'">
        </div>
        <p v-if="!image.localFile && status === 'loading'" class="image-viewer-status" role="status">{{ t('Loading image...') }}</p>
        <div v-else-if="status === 'error'" class="image-viewer-status" role="alert">
          <p>{{ t('Could not load this image.') }}</p>
          <button type="button" class="btn" @click="retry">{{ t('Retry') }}</button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, useId, watch } from 'vue'
import { useFileDownload } from '../composables/useFileDownload.ts'
import type { ImagePreview } from '../image-viewer.ts'
import { useMobileResources } from '../mobile-resources.ts'

import ImageAnnotationPreview from './files/ImageAnnotationPreview.vue'
import type { ImageAlignmentDocument } from '../image-alignment.ts'
const ImageAlignmentPanel = defineAsyncComponent(() => import('./alignment/ImageAlignmentPanel.vue'))
import type { ImageContextUpdate, ImageContextBusy } from '../image-context.ts'

const props = defineProps<{ image: ImagePreview; contextKey?: string; editable?: boolean }>()
const resources = useMobileResources()
const downloads = useFileDownload()
const downloadUrl = computed(() => resources.resolve(props.image.downloadUrl))
const emit = defineEmits<{ close: []; 'image-context': [update: ImageContextUpdate]; 'image-busy': [update: ImageContextBusy] }>()
const dialog = ref<HTMLDialogElement>()
const closeButton = ref<HTMLButtonElement>()
const viewport = ref<HTMLElement>()
const titleId = useId()
const status = ref<'loading' | 'ready' | 'error'>('loading')
const actualSize = ref(false)
const attempt = ref(0)
const mode = ref<'marks' | 'alignment'>(props.image.alignment ? 'alignment' : 'marks')
const alignmentOpened = ref(!!props.image.alignment)
const alignmentPanel = ref<{ hasUnsavedChanges: boolean; flush: () => void }>()
function openAlignment() { alignmentOpened.value = true; mode.value = 'alignment' }
function applyAlignment(alignment: ImageAlignmentDocument) {
  if (!props.editable || !props.image.localFile || !props.image.attachmentKey) return
  emit('image-context', { contextKey: props.contextKey ?? '', sourceKey: props.image.attachmentKey, file: props.image.localFile, alignment })
}
function clearAlignment() {
  if (!props.editable || !props.image.localFile || !props.image.attachmentKey) return
  emit('image-context', { contextKey: props.contextKey ?? '', sourceKey: props.image.attachmentKey, file: props.image.localFile, alignment: null })
}
let trigger: HTMLElement | undefined
let outsideStart = false
let closing = false

function restoreFocus() {
  if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true })
  trigger = undefined
}
function closed() {
  if (closing) return
  closing = true
  restoreFocus()
  emit('close')
}
function close() {
  alignmentPanel.value?.flush()
  if (alignmentPanel.value?.hasUnsavedChanges && !window.confirm(t('Discard unapplied region instructions?'))) return
  dialog.value?.close(); closed()
}
function outside(event: MouseEvent) {
  if (event.target !== dialog.value) return false
  const rect = dialog.value.getBoundingClientRect()
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
}
function backdropStart(event: PointerEvent) { outsideStart = outside(event) }
function backdropEnd(event: MouseEvent) {
  if (outsideStart && outside(event)) close()
  outsideStart = false
}
function viewerKeydown(event: KeyboardEvent) {
  // The shared annotator listens on window for Ctrl/Cmd+Z, scoped to its focused controls.
  if (!props.image.localFile || !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z')) event.stopPropagation()
}
function retry() { status.value = 'loading'; attempt.value++ }
async function toggleSize() {
  actualSize.value = !actualSize.value
  await nextTick()
  viewport.value?.scrollTo(0, 0)
}
watch(() => props.image.src, () => {
  downloads.reset()
  status.value = 'loading'
  actualSize.value = false
  attempt.value++
})
onMounted(() => {
  trigger = props.image.trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
  dialog.value?.showModal()
  closeButton.value?.focus({ preventScroll: true })
})
onDeactivated(close)
onBeforeUnmount(() => { closing = true; dialog.value?.close(); restoreFocus() })
</script>

<style scoped>
.image-viewer { width: min(1200px, calc(100vw - 32px)); height: min(900px, calc(100dvh - 32px)); max-width: none; max-height: none; padding: 0; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 16px 48px var(--c-shadow); }
.image-viewer[open] { display: flex; flex-direction: column; }
.image-viewer::backdrop { background: rgb(0 0 0 / 65%); }
.viewer-modes { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--c-border); }
.viewer-modes button[aria-pressed="true"] { border-color: var(--c-blue); }
.image-viewer-header { display: flex; align-items: center; gap: 4px; flex-shrink: 0; min-height: 52px; padding: 4px 8px 4px 16px; border-bottom: 1px solid var(--c-border); }
.image-viewer-header h2 { flex: 1; min-width: 0; margin: 0 8px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 20px; font-weight: 500; }
.viewer-control { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex-shrink: 0; min-width: 44px; min-height: 44px; padding: 0 10px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; font-size: 12px; text-decoration: none; cursor: pointer; }
.viewer-control > span:first-child { width: 18px; height: 18px; }
.viewer-control:hover:not(:disabled) { background: var(--c-bg-muted); }
.viewer-control:disabled { opacity: .5; cursor: default; }
.viewer-control:focus-visible, .image-viewer-viewport:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.viewer-download-error { margin: 0; padding: 8px 16px; color: var(--c-error); font-size: 13px; overflow-wrap: anywhere; }
.image-viewer-viewport { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; background: var(--c-bg-soft); }
.viewer-annotation { padding: 16px; }
.image-viewer-canvas { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; padding: 16px; }
.image-viewer-canvas img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
.image-viewer-canvas img.loading { visibility: hidden; }
.actual-size .image-viewer-canvas { width: max-content; height: max-content; min-width: 100%; min-height: 100%; }
.actual-size img { max-width: none; max-height: none; }
.image-viewer-status { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; margin: 0; padding: 24px; text-align: center; color: var(--c-text-secondary); font-size: 14px; }
.image-viewer-status p { margin: 0; }
@media (max-width: 700px) {
  .image-viewer { width: calc(100vw - 16px); height: calc(100dvh - 16px); }
  .image-viewer-header { padding-left: 12px; }
  .viewer-control-label { display: none; }
  .image-viewer-canvas { padding: 8px; }
}
</style>
