<template>
  <section ref="preview" class="image-annotation-preview" :aria-label="t('Image preview: {name}', { name: name })" :aria-busy="loading || busy">
    <div class="image-annotation-toolbar">
      <div class="image-annotation-colors" role="group" :aria-label="t('Marker color')">
        <HoverInfo v-for="swatch in palette" :key="swatch.color" :text="t('{label} marker', { label: swatch.label })">
          <template #default="{ triggerProps }">
            <button v-bind="triggerProps" type="button" class="image-annotation-swatch"
              :style="{ '--marker-color': swatch.color }" :aria-label="t('{label} marker', { label: swatch.label })"
              :aria-pressed="color === swatch.color" :disabled="!canEdit" @click="color = swatch.color">
              <span aria-hidden="true">{{ color === swatch.color ? '✓' : '' }}</span>
            </button>
          </template>
        </HoverInfo>
        <HoverInfo text="Choose a custom marker color">
          <template #default="{ triggerProps }">
            <label class="image-annotation-custom">
              <span>{{ t('Color') }}</span>
              <input v-bind="triggerProps" v-model="color" type="color" :aria-label="t('Custom marker color')" :disabled="!canEdit">
            </label>
          </template>
        </HoverInfo>
      </div>
      <div class="image-annotation-actions">
        <HoverInfo text="Undo the last stroke (Ctrl+Z)">
          <template #default="{ triggerProps }">
            <button v-bind="triggerProps" type="button" class="image-annotation-undo" :aria-label="t('Undo last stroke')" aria-keyshortcuts="Control+Z"
              :disabled="!canUndo" @click="undoStroke">{{ t('Undo') }}</button>
          </template>
        </HoverInfo>
        <HoverInfo text="Remove all marks and the marked image from the next message">
          <template #default="{ triggerProps }">
            <button v-bind="triggerProps" type="button" class="image-annotation-clear"
              :disabled="!editable || !active || !hasMarks" @click="clearMarks">{{ t('Clear') }}</button>
          </template>
        </HoverInfo>
      </div>
    </div>
    <p class="image-annotation-hint">
      {{ sourceError ? t('Image preview · References unavailable') : editable ? t('Draw to mark · Ctrl-drag to attach') : t('Marking unavailable in this chat · Ctrl-drag to attach elsewhere') }}
    </p>
    <p v-if="loading" class="image-annotation-status" role="status">{{ t('Loading image…') }}</p>
    <div v-if="loaded && sourceError" class="image-annotation-error image-annotation-source-error" role="status">
      <p>{{ sourceError }} {{ t('You can still view the image; marking and references are disabled until its source is available.') }}</p>
      <button type="button" class="image-annotation-retry image-annotation-source-retry" @click="loadImage">{{ t('Reload image source') }}</button>
    </div>
    <div v-if="loadError || exportError" class="image-annotation-error" role="alert">
      <p>{{ loadError || exportError }}</p>
      <button type="button" class="image-annotation-retry" :disabled="busy || (!loadError && !canEdit)"
        @click="retry">{{ loadError ? t('Retry image') : t('Retry marked image') }}</button>
    </div>
    <div v-show="loaded" class="image-annotation-stage">
      <canvas ref="canvas" class="image-annotation-canvas" :class="{ 'is-readonly': !editable || !!sourceError, 'is-drag-ready': dragReady }"
        :draggable="dragReady" :aria-label="`${name}. ${editable && !sourceError ? t('Hold the pointer and draw to mark the image.') : t('Read-only image preview.')}`"
        role="img" tabindex="0" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp"
        @pointercancel="pointerCancel" @lostpointercapture="lostPointerCapture"
        @dragstart="dragStart" @dragend="dragEnd" @contextmenu="contextMenu" />
    </div>
    <p v-if="busy" class="image-annotation-status" role="status">
      {{ drawing ? t('Marking image…') : t('Preparing marked image…') }}
    </p>
    <p v-else-if="hasMarks && !exportError" class="image-annotation-status" role="status">
      {{ editable ? t('Marked preview · Finish a stroke to update the attached copy.') : t('Marked preview · Ctrl-drag to attach elsewhere') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { t } from '../../i18n.ts'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import HoverInfo from '../HoverInfo.vue'
import { imageSourcePath, startImageReferenceDrag, type ImageContextBusy, type ImageContextUpdate } from '../../image-context.ts'
import { AnnotationLoadError, AnnotationPointer, annotationLoadErrorMessage, annotationPoint, annotationSizeError, drawAnnotationStroke, isAnnotationUndo, markedImageName, type AnnotationPoint, type AnnotationStroke } from '../../image-annotation.ts'

const props = defineProps<{
  src: string
  name: string
  sourceKey: string
  contextKey: string
  active: boolean
  editable: boolean
  keyboardActive?: boolean
}>()
const emit = defineEmits<{
  'image-context': [payload: ImageContextUpdate]
  'image-busy': [payload: ImageContextBusy]
}>()
const palette = [
  { get label() { return t('Red') }, color: '#ef4444' },
  { get label() { return t('Amber') }, color: '#f59e0b' },
  { get label() { return t('Blue') }, color: '#3b82f6' },
]
const canvas = ref<HTMLCanvasElement>()
const preview = ref<HTMLElement>()
const color = ref(palette[0]!.color)
const loading = ref(false)
const loaded = ref(false)
const busy = ref(false)
const drawing = ref(false)
const hasMarks = ref(false)
const strokes: AnnotationStroke[] = []
const loadError = ref('')
const exportError = ref('')
const sourceError = ref('')
const controlHeld = ref(false)
const canEdit = computed(() => props.active && props.editable && loaded.value && !busy.value && !sourceError.value)
const canUndo = computed(() => props.active && props.editable && loaded.value && hasMarks.value && !sourceError.value)
const dragReady = computed(() => props.active && loaded.value && controlHeld.value && !busy.value && !exportError.value && !sourceError.value)
const pointer = new AnnotationPointer()
let lastPoint: AnnotationPoint | null = null
let strokeColor = ''
let strokeWidth = 1
let image: HTMLImageElement | undefined
let originalFile: File | undefined
let originalPath: string | undefined
let markedFile: File | undefined
let request: AbortController | undefined
let objectUrl: string | undefined
let loadGeneration = 0
let exportGeneration = 0
let disposed = false
let identity = { sourceKey: props.sourceKey, contextKey: props.contextKey }
let releaseDrag: (() => void) | undefined

function updateContext(file: File | null) {
  if (!disposed) emit('image-context', { ...identity, file, ...(file ? { source: imageSource(true) } : {}) })
}
function imageSource(modified: boolean) {
  if (!originalPath) throw new Error(t('The image source is unavailable. Reopen the image to retry.'))
  return { path: originalPath, modified }
}
function setBusy(value: boolean) {
  if (busy.value === value) return
  busy.value = value
  if (!disposed) emit('image-busy', { ...identity, busy: value })
}
function releasePointer() {
  const id = pointer.release()
  drawing.value = false
  lastPoint = null
  if (id !== null && canvas.value?.hasPointerCapture(id)) canvas.value.releasePointerCapture(id)
}
function cancelPending(message = '') {
  ++exportGeneration
  releasePointer()
  if (busy.value) {
    updateContext(null)
    markedFile = undefined
  }
  setBusy(false)
  if (message && hasMarks.value) exportError.value = message
}
function disposeImage() {
  request?.abort()
  request = undefined
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = undefined
  image = undefined
  originalFile = undefined
  originalPath = undefined
  markedFile = undefined
}
async function loadImage() {
  const generation = ++loadGeneration
  cancelPending()
  dragEnd()
  disposeImage()
  loaded.value = false
  loading.value = true
  hasMarks.value = false
  strokes.length = 0
  loadError.value = ''
  exportError.value = ''
  sourceError.value = ''
  const abort = new AbortController()
  request = abort
  let url: string | undefined
  try {
    const response = await fetch(props.src, { signal: abort.signal })
    if (disposed || generation !== loadGeneration || abort.signal.aborted) return
    if (!response.ok) throw new AnnotationLoadError(t('Image request failed (HTTP {status}). Retry or open the raw image.', { status: response.status }))
    let sourcePath: string | undefined
    try {
      sourcePath = imageSourcePath(response.headers)
    } catch (error) {
      sourceError.value = error instanceof Error ? error.message : t('The image source could not be read. Reload the image source to retry.')
    }
    const length = Number(response.headers.get('content-length'))
    const headerError = annotationSizeError(length)
    if (headerError) throw new AnnotationLoadError(headerError)
    const blob = await response.blob()
    const sizeError = annotationSizeError(blob.size)
    if (sizeError) throw new AnnotationLoadError(sizeError)
    if (!blob.type.toLowerCase().startsWith('image/')) throw new AnnotationLoadError(t('The response is not an image. Retry or open the raw image.'))
    if (disposed || generation !== loadGeneration) return
    url = URL.createObjectURL(blob)
    objectUrl = url
    const decoded = new Image()
    decoded.src = url
    await decoded.decode()
    if (disposed || generation !== loadGeneration) return
    const dimensionError = annotationSizeError(blob.size, decoded.naturalWidth, decoded.naturalHeight)
    if (dimensionError) throw new AnnotationLoadError(dimensionError)
    const target = canvas.value
    const context = target?.getContext('2d')
    if (!target || !context) throw new AnnotationLoadError(t('Image drawing is unavailable. Retry or open the raw image.'))
    target.width = decoded.naturalWidth
    target.height = decoded.naturalHeight
    context.drawImage(decoded, 0, 0)
    // A decoded image can still taint a canvas (for example, an externally referenced SVG).
    context.getImageData(0, 0, 1, 1)
    image = decoded
    originalFile = new File([blob], props.name, { type: blob.type })
    originalPath = sourcePath
    loaded.value = true
  } catch (error) {
    if (disposed || generation !== loadGeneration || abort.signal.aborted) return
    loadError.value = annotationLoadErrorMessage(error)
  } finally {
    if (url) {
      URL.revokeObjectURL(url)
      if (objectUrl === url) objectUrl = undefined
    }
    if (!disposed && generation === loadGeneration) loading.value = false
  }
}
function renderOriginal() {
  const target = canvas.value
  const context = target?.getContext('2d')
  if (!target || !context || !image) return
  context.clearRect(0, 0, target.width, target.height)
  context.drawImage(image, 0, 0)
}
function clearMarks() {
  if (!props.editable || !props.active) return
  ++exportGeneration
  releasePointer()
  updateContext(null)
  setBusy(false)
  hasMarks.value = false
  strokes.length = 0
  markedFile = undefined
  exportError.value = ''
  renderOriginal()
}
function undoStroke() {
  if (!canUndo.value) return
  ++exportGeneration
  releasePointer()
  dragEnd()
  strokes.pop()
  hasMarks.value = strokes.length > 0
  markedFile = undefined
  exportError.value = ''
  renderOriginal()
  const context = canvas.value?.getContext('2d')
  if (context) for (const stroke of strokes) drawAnnotationStroke(context, stroke)
  if (hasMarks.value) exportMarkedImage()
  else {
    updateContext(null)
    setBusy(false)
  }
}
function eventPoint(event: PointerEvent) {
  const target = canvas.value
  return target ? annotationPoint(event.clientX, event.clientY, target.getBoundingClientRect(), target.width, target.height) : null
}
function pointerDown(event: PointerEvent) {
  controlHeld.value = event.ctrlKey
  if (event.ctrlKey) {
    // Set the DOM property synchronously, before the browser starts native dragging.
    if (canvas.value) canvas.value.draggable = dragReady.value
    return
  }
  if (!pointer.start(event, canEdit.value)) return
  const point = eventPoint(event)
  const target = canvas.value
  const context = target?.getContext('2d')
  if (!point || !target || !context) { releasePointer(); return }
  event.preventDefault()
  try { target.setPointerCapture(event.pointerId) } catch { releasePointer(); return }
  target.focus({ preventScroll: true })
  setBusy(true)
  drawing.value = true
  hasMarks.value = true
  exportError.value = ''
  markedFile = undefined
  strokeWidth = 4 * target.width / target.getBoundingClientRect().width
  strokeColor = color.value
  lastPoint = point
  strokes.push({ color: strokeColor, width: strokeWidth, points: [point] })
  context.fillStyle = strokeColor
  context.beginPath()
  context.arc(point.x, point.y, strokeWidth / 2, 0, Math.PI * 2)
  context.fill()
}
function pointerMove(event: PointerEvent) {
  controlHeld.value = event.ctrlKey
  if (!pointer.owns(event.pointerId)) return
  if (!(event.buttons & 1)) { finishStroke(); return }
  event.preventDefault()
  const events = event.getCoalescedEvents?.() ?? []
  for (const sample of events.length ? events : [event]) drawSegment(sample)
}
function drawSegment(event: PointerEvent) {
  const point = eventPoint(event)
  const context = canvas.value?.getContext('2d')
  if (!point || !lastPoint || !context) return
  context.strokeStyle = strokeColor
  context.lineWidth = strokeWidth
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  context.moveTo(lastPoint.x, lastPoint.y)
  context.lineTo(point.x, point.y)
  context.stroke()
  strokes.at(-1)?.points.push(point)
  lastPoint = point
}
function pointerUp(event: PointerEvent) {
  if (!pointer.owns(event.pointerId)) return
  drawSegment(event)
  finishStroke()
}
function finishStroke() {
  if (!pointer.active) return
  releasePointer()
  exportMarkedImage()
}
function pointerCancel(event: PointerEvent) {
  if (pointer.owns(event.pointerId)) cancelPending(t('Drawing was interrupted. Retry marked image to attach the visible marks.'))
}
function lostPointerCapture(event: PointerEvent) {
  if (pointer.owns(event.pointerId)) cancelPending(t('Drawing was interrupted. Retry marked image to attach the visible marks.'))
}
function exportMarkedImage() {
  const target = canvas.value
  if (!target || !hasMarks.value || !props.editable) { cancelPending(); return }
  const generation = ++exportGeneration
  const filename = markedImageName(props.name)
  setBusy(true)
  exportError.value = ''
  function fail() {
    updateContext(null)
    markedFile = undefined
    exportError.value = t('The marked image could not be prepared. Retry marked image or clear the marks.')
    setBusy(false)
  }
  try {
    target.toBlob((blob) => {
      if (disposed || generation !== exportGeneration) return
      if (!props.editable) { cancelPending(); return }
      if (!blob) { fail(); return }
      markedFile = new File([blob], filename, { type: 'image/png' })
      updateContext(markedFile)
      setBusy(false)
    }, 'image/png')
  } catch {
    if (!disposed && generation === exportGeneration) fail()
  }
}
function retry() {
  if (loadError.value) void loadImage()
  else if (canEdit.value) exportMarkedImage()
}
function dragStart(event: DragEvent) {
  if (!event.ctrlKey || !props.active || !loaded.value || busy.value || exportError.value || sourceError.value || !event.dataTransfer) {
    event.preventDefault()
    return
  }
  const file = hasMarks.value ? markedFile : originalFile
  if (!file) { event.preventDefault(); return }
  dragEnd()
  releaseDrag = startImageReferenceDrag(event.dataTransfer, { sourceKey: props.sourceKey, file, source: imageSource(hasMarks.value) })
}
function dragEnd() { releaseDrag?.(); releaseDrag = undefined }
function contextMenu(event: MouseEvent) { if (drawing.value) event.preventDefault() }
function keyChange(event: KeyboardEvent) {
  controlHeld.value = event.ctrlKey
  if (!isAnnotationUndo(event) || props.keyboardActive === false || !canUndo.value) return
  const target = document.activeElement
  if (!(target instanceof Element) || !preview.value?.contains(target)
    || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
  event.preventDefault()
  event.stopPropagation()
  undoStroke()
}
function windowBlur() {
  controlHeld.value = false
  if (pointer.active) cancelPending(t('Drawing was interrupted. Retry marked image to attach the visible marks.'))
}
watch(() => [props.src, props.sourceKey, props.contextKey], () => {
  cancelPending()
  identity = { sourceKey: props.sourceKey, contextKey: props.contextKey }
  void loadImage()
})
watch(() => props.editable, (editable) => {
  if (!editable && busy.value) cancelPending(t('Marking paused. Retry marked image when this chat is editable.'))
})
watch(() => props.active, (active) => {
  if (!active) {
    controlHeld.value = false
    if (pointer.active) finishStroke()
  }
})
onMounted(() => {
  window.addEventListener('keydown', keyChange)
  window.addEventListener('keyup', keyChange)
  window.addEventListener('blur', windowBlur)
  void loadImage()
})
onBeforeUnmount(() => {
  cancelPending()
  disposed = true
  ++loadGeneration
  disposeImage()
  dragEnd()
  window.removeEventListener('keydown', keyChange)
  window.removeEventListener('keyup', keyChange)
  window.removeEventListener('blur', windowBlur)
})
</script>

<style scoped>
.image-annotation-preview { display: flex; flex-direction: column; width: 100%; min-width: 0; min-height: 0; gap: 10px; color: var(--c-text); }
.image-annotation-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; }
.image-annotation-colors { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.image-annotation-actions { display: flex; gap: 6px; }
.image-annotation-swatch, .image-annotation-clear, .image-annotation-undo, .image-annotation-retry { min-height: 32px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 12px; cursor: pointer; }
.image-annotation-swatch { display: grid; place-items: center; width: 32px; padding: 5px; }
.image-annotation-swatch span { display: grid; place-items: center; width: 20px; height: 20px; background: var(--marker-color); color: #111; font-weight: 800; }
.image-annotation-swatch[aria-pressed="true"] { border-color: var(--c-text); }
.image-annotation-clear, .image-annotation-undo, .image-annotation-retry { padding: 5px 10px; }
.image-annotation-custom { display: flex; align-items: center; gap: 6px; margin-inline-start: 4px; color: var(--c-text-secondary); font-size: 12px; }
.image-annotation-custom input { width: 32px; height: 32px; padding: 3px; background: var(--c-bg-card); border: 1px solid var(--c-border); border-radius: var(--radius-control); cursor: pointer; }
.image-annotation-toolbar button:hover:not(:disabled), .image-annotation-retry:hover:not(:disabled) { background: var(--c-bg-muted); border-color: var(--c-border-hover); }
.image-annotation-preview button:focus-visible, .image-annotation-custom input:focus-visible { outline: 2px solid var(--c-primary); outline-offset: 2px; }
.image-annotation-preview button:disabled, .image-annotation-custom input:disabled { opacity: .45; cursor: not-allowed; }
.image-annotation-hint, .image-annotation-status { margin: 0; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; }
.image-annotation-stage { display: flex; justify-content: center; align-items: flex-start; width: 100%; min-width: 0; }
.image-annotation-canvas { display: block; width: auto; height: auto; max-width: 100%; max-height: 60vh; object-fit: contain; touch-action: none; cursor: crosshair; }
.image-annotation-canvas.is-readonly { cursor: default; touch-action: pan-y; }
.image-annotation-canvas:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.image-annotation-canvas.is-drag-ready { cursor: grab; }
.image-annotation-error { color: var(--c-error); font-size: 12px; line-height: 1.5; }
.image-annotation-error p { margin: 0 0 8px; max-width: 65ch; }
@media (pointer: coarse) {
  .image-annotation-swatch, .image-annotation-clear, .image-annotation-undo, .image-annotation-retry, .image-annotation-custom input { min-height: 44px; }
  .image-annotation-swatch, .image-annotation-custom input { width: 44px; }
}
</style>
