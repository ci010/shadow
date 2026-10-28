<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createImageAnnotator, ShapeType, UserSelectAction, type ImageAnnotation, type ImageAnnotator, type PolygonGeometry, type RectangleGeometry } from '@annotorious/annotorious'
import '@annotorious/annotorious/annotorious.css'
import { t } from '../../i18n.ts'
import { annotationSizeError } from '../../image-annotation.ts'
import { parseImageAlignment, type ImageAlignmentDocument, type ImageAlignmentRegion } from '../../image-alignment.ts'

const props = defineProps<{ file: File; initial?: ImageAlignmentDocument; editable: boolean; active: boolean; compact?: boolean }>()
const emit = defineEmits<{ apply: [document: ImageAlignmentDocument]; clear: [] }>()
const image = ref<HTMLImageElement>()
const src = ref('')
const ready = ref(false)
const error = ref('')
const feedback = ref('')
const regions = ref<ImageAlignmentRegion[]>([])
const description = ref('')
const selected = ref('')
const drawing = ref(false)
const tool = ref<'rectangle' | 'polygon' | 'stroke'>('rectangle')
const strokePoints = ref<[number, number][]>([])
const strokeSurface = ref<SVGSVGElement>()
let pointerId: number | undefined
const asset = ref<ImageAlignmentDocument['asset']>()
const selectedRegion = computed(() => regions.value.find(region => region.id === selected.value))
const snapshot = () => JSON.stringify({ description: description.value, regions: regions.value })
const savedSnapshot = ref('')
const hasUnsavedChanges = computed(() => ready.value && snapshot() !== savedSnapshot.value)
const candidate = computed<ImageAlignmentDocument | undefined>(() => asset.value ? {
  version: 1, asset: asset.value, regions: regions.value, description: description.value,
} : undefined)
const valid = computed(() => { try { return !!candidate.value && !!parseImageAlignment(candidate.value) } catch { return false } })
let annotator: ImageAnnotator | undefined
let disposed = false
let generation = 0

function toAnnotation(region: ImageAlignmentRegion): ImageAnnotation {
  return { id: region.id, bodies: [], target: { annotation: region.id, selector: {
    type: region.geometry?.type === 'polygon' ? ShapeType.POLYGON : ShapeType.RECTANGLE,
    geometry: region.geometry?.type === 'polygon' ? { points: region.geometry.points, bounds: { minX: region.x, minY: region.y, maxX: region.x + region.width, maxY: region.y + region.height } } as PolygonGeometry : { bounds: { minX: region.x, minY: region.y, maxX: region.x + region.width, maxY: region.y + region.height },
      x: region.x, y: region.y, w: region.width, h: region.height } as RectangleGeometry,
  } } } as ImageAnnotation
}
function refreshStyle() {
  annotator?.setStyle(annotation => {
    const region = regions.value.find(item => item.id === annotation.id)
    const preserve = region?.intent === 'preserve'
    return { fill: preserve ? '#22c55e' : '#f59e0b', fillOpacity: 0.15,
      stroke: preserve ? '#22c55e' : '#f59e0b', strokeOpacity: 1, strokeWidth: 2 }
  })
}
function geometry(annotation: ImageAnnotation) {
  // Use authoritative rectangle coordinates, not cached bounds. In upstream 3.9.5
  // RectangleEditor can calculate bounds from the previous handle position.
  if (annotation.target.selector.type === ShapeType.POLYGON) {
    const size = asset.value!
    const points = (annotation.target.selector.geometry as PolygonGeometry).points.map(([x, y]) => [Math.max(0, Math.min(size.width, x)), Math.max(0, Math.min(size.height, y))] as [number, number])
    const x = Math.min(...points.map(p => p[0])), y = Math.min(...points.map(p => p[1]))
    return { x, y, width: Math.max(...points.map(p => p[0])) - x, height: Math.max(...points.map(p => p[1])) - y, geometry: { type: 'polygon' as const, points } }
  }
  const rectangle = annotation.target.selector.geometry as RectangleGeometry
  const bounds = { minX: rectangle.x, minY: rectangle.y, maxX: rectangle.x + rectangle.w, maxY: rectangle.y + rectangle.h }
  const size = asset.value!
  // The annotator may let a handle travel outside the source. Clip explicitly to source pixels.
  const x = Math.max(0, Math.min(size.width, bounds.minX))
  const y = Math.max(0, Math.min(size.height, bounds.minY))
  const right = Math.max(0, Math.min(size.width, bounds.maxX))
  const bottom = Math.max(0, Math.min(size.height, bounds.maxY))
  return { x, y, width: right - x, height: bottom - y }
}
function syncRegion(annotation: ImageAnnotation, created: boolean) {
  // Lifecycle notifications are deferred by the library. Ignore removed/stale objects.
  const current = annotator?.getAnnotationById(annotation.id)
  if (disposed || !current) return
  annotation = current
  const rect = geometry(annotation)
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) {
    annotator?.removeAnnotation(annotation.id)
    regions.value = regions.value.filter(item => item.id !== annotation.id)
    return
  }
  const previous = regions.value.find(item => item.id === annotation.id)
  if (!previous && regions.value.length >= 50) {
    annotator?.removeAnnotation(annotation.id)
    feedback.value = t('Use at most 50 regions per image.')
    return
  }
  const region: ImageAlignmentRegion = { id: annotation.id, ...rect, intent: previous?.intent ?? 'change', description: previous?.description ?? '', ...(previous?.label !== undefined ? { label: previous.label } : {}) }
  regions.value = previous ? regions.value.map(item => item.id === region.id ? region : item) : [...regions.value, region]
  if (created) {
    selected.value = region.id
    drawing.value = false
    annotator?.setDrawingEnabled(false)
  }
  // Reconcile clipped geometry, so the visible rectangle and exported coordinates match.
  const bounds = annotation.target.selector.geometry.bounds
  if (!region.geometry && (bounds.minX !== rect.x || bounds.minY !== rect.y || bounds.maxX !== rect.x + rect.width || bounds.maxY !== rect.y + rect.height)) {
    annotator?.updateAnnotation(toAnnotation(region))
  }
  if (region.geometry?.type === 'polygon' && JSON.stringify((annotation.target.selector.geometry as PolygonGeometry).points) !== JSON.stringify(region.geometry.points)) annotator?.updateAnnotation(toAnnotation(region))
  refreshStyle()
}
function choose(id: string) {
  cancelDrawing()
  selected.value = id
  if (selectedRegion.value?.geometry?.type === 'stroke') annotator?.cancelSelected()
  else annotator?.setSelected(id)
}
function addRegion() {
  if (!ready.value || !props.editable || regions.value.length >= 50) return
  selected.value = ''
  annotator?.cancelSelected()
  drawing.value = true
  annotator?.setDrawingMode(tool.value === 'polygon' ? 'click' : 'drag')
  annotator?.setDrawingTool(tool.value === 'polygon' ? 'polygon' : 'rectangle')
  annotator?.setDrawingEnabled(tool.value !== 'stroke')
  feedback.value = ''
}
function cancelDrawing() {
  annotator?.cancelDrawing()
  annotator?.setDrawingEnabled(false)
  drawing.value = false
  strokePoints.value = []
  if (pointerId !== undefined && strokeSurface.value?.hasPointerCapture(pointerId)) strokeSurface.value.releasePointerCapture(pointerId)
  pointerId = undefined
}
function point(event: PointerEvent): [number, number] {
  const bounds = strokeSurface.value!.getBoundingClientRect(), size = asset.value!
  return [Math.max(0, Math.min(size.width, (event.clientX - bounds.left) / bounds.width * size.width)), Math.max(0, Math.min(size.height, (event.clientY - bounds.top) / bounds.height * size.height))]
}
function strokeStart(event: PointerEvent) {
  if (!props.active || !props.editable || !drawing.value || tool.value !== 'stroke') return
  pointerId = event.pointerId
  strokeSurface.value!.setPointerCapture(pointerId)
  strokePoints.value = [point(event)]
}
function strokeMove(event: PointerEvent) {
  if (pointerId !== event.pointerId) return
  if (strokePoints.value.length < 9999) strokePoints.value.push(point(event))
}
function strokeEnd(event: PointerEvent) {
  if (pointerId !== event.pointerId) return
  strokeMove(event)
  const points = [...strokePoints.value], size = asset.value!
  const x = Math.min(...points.map(p => p[0])), y = Math.min(...points.map(p => p[1]))
  const width = Math.max(...points.map(p => p[0])) - x, height = Math.max(...points.map(p => p[1])) - y
  if (width > 1 || height > 1) {
    const id = crypto.randomUUID()
    regions.value.push({ id, x: Math.min(x, size.width - 1), y: Math.min(y, size.height - 1), width: Math.max(1, width), height: Math.max(1, height), intent: 'change', description: '', geometry: { type: 'stroke', points } })
    selected.value = id
  }
  cancelDrawing()
}
function removeRegion(id: string) {
  if (!props.editable) return
  annotator?.removeAnnotation(id)
  regions.value = regions.value.filter(region => region.id !== id)
  selected.value = ''
}
function reconcileRegions() {
  if (!annotator || !asset.value) return
  // Read the synchronous store: autoSave/updateAnnotation events can lag handle movement by 1s.
  const order = new Map(regions.value.map((region, index) => [region.id, index]))
  regions.value = [...regions.value.filter(region => region.geometry?.type === 'stroke'), ...annotator.getAnnotations().map(annotation => {
    const previous = regions.value.find(item => item.id === annotation.id)
    return { id: annotation.id, ...geometry(annotation), intent: previous?.intent ?? 'change', description: previous?.description ?? '', ...(previous?.label !== undefined ? { label: previous.label } : {}) }
  })].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}
function apply() {
  annotator?.cancelSelected()
  reconcileRegions()
  if (!props.editable || !candidate.value) return
  try {
    const document = parseImageAlignment(candidate.value)
    emit('apply', document)
    savedSnapshot.value = snapshot()
    feedback.value = t('Instructions added to the draft. Send the message to ask the agent to make the changes.')
  } catch { feedback.value = t('Describe the requested change before adding instructions.') }
}
function clear() {
  if (!props.editable) return
  cancelDrawing()
  annotator?.clearAnnotations()
  regions.value = []
  description.value = ''
  selected.value = ''
  savedSnapshot.value = snapshot()
  emit('clear')
  feedback.value = t('Region instructions removed from the draft. The image is unchanged.')
}
function downloadJson() {
  reconcileRegions()
  if (!candidate.value || !valid.value) return
  const blob = new Blob([JSON.stringify(parseImageAlignment(candidate.value), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'image-alignment.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function load() {
  const ticket = ++generation
  ready.value = false
  error.value = ''
  annotator?.destroy()
  annotator = undefined
  if (src.value) URL.revokeObjectURL(src.value)
  try {
    const sizeError = annotationSizeError(props.file.size)
    if (sizeError) throw new Error(sizeError)
    src.value = URL.createObjectURL(props.file)
    await nextTick()
    const target = image.value!
    await target.decode()
    const dimensionError = annotationSizeError(props.file.size, target.naturalWidth, target.naturalHeight)
    if (dimensionError) throw new Error(dimensionError)
    const digest = await crypto.subtle.digest('SHA-256', await props.file.arrayBuffer())
    if (disposed || ticket !== generation) return
    asset.value = { sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''), width: target.naturalWidth, height: target.naturalHeight }
    regions.value = []
    description.value = ''
    if (props.initial) {
      const initial = parseImageAlignment(props.initial)
      if (initial.asset.sha256 !== asset.value.sha256 || initial.asset.width !== asset.value.width || initial.asset.height !== asset.value.height) {
        throw new Error(t('These instructions belong to a different image version. Reopen the matching image.'))
      }
      regions.value = initial.regions
      description.value = initial.description
    }
    annotator = createImageAnnotator(target, { drawingEnabled: false, drawingMode: 'drag', autoSave: true,
      disableUndoRedoKeys: true, userSelectAction: props.editable ? UserSelectAction.EDIT : UserSelectAction.SELECT })
    annotator.setDrawingTool('rectangle')
    annotator.setAnnotations(regions.value.filter(region => region.geometry?.type !== 'stroke').map(toAnnotation))
    annotator.on('createAnnotation', annotation => syncRegion(annotation, true))
    annotator.on('updateAnnotation', annotation => syncRegion(annotation, false))
    annotator.on('selectionChanged', (annotations: ImageAnnotation[]) => { if (annotations[0]) selected.value = annotations[0].id })
    refreshStyle()
    savedSnapshot.value = snapshot()
    ready.value = true
  } catch (cause) {
    if (!disposed && ticket === generation) error.value = cause instanceof Error ? cause.message : t('Could not prepare image alignment. Retry.')
  }
}
watch(() => [props.active, props.editable], () => {
  annotator?.setUserSelectAction(props.editable && props.active ? UserSelectAction.EDIT : UserSelectAction.SELECT)
  if (!props.active || !props.editable) {
    annotator?.cancelDrawing()
    annotator?.cancelSelected()
    annotator?.setDrawingEnabled(false)
    cancelDrawing()
  }
})
watch(() => selectedRegion.value?.intent, refreshStyle)
onMounted(load)
onBeforeUnmount(() => { disposed = true; ++generation; annotator?.destroy(); if (src.value) URL.revokeObjectURL(src.value) })
defineExpose({ hasUnsavedChanges, flush: reconcileRegions })
</script>

<template>
  <section class="alignment-panel" :aria-label="t('Image region instructions')" :aria-busy="!ready && !error">
    <p v-if="!compact" class="alignment-note">{{ t('Select where, describe what. The agent edits the image; these rectangles are instructions, not pixels in the result.') }}</p>
    <div v-if="error" role="alert"><p>{{ error }}</p><button class="btn" @click="load">{{ t('Retry') }}</button></div>
    <p v-else-if="!ready" role="status">{{ t('Preparing image alignment…') }}</p>
    <div class="alignment-layout">
      <div class="alignment-visual">
        <div class="alignment-controls">
          <select v-model="tool" :aria-label="t('Annotation tool')" :disabled="!ready || !editable" @change="cancelDrawing"><option value="rectangle">{{ t('Rectangle') }}</option><option value="polygon">{{ t('Polygon') }}</option><option value="stroke">{{ t('Freehand') }}</option></select>
          <button class="btn alignment-add" :disabled="!ready || !editable || regions.length >= 50" :aria-pressed="drawing" @click="addRegion">{{ t('Add region') }}</button>
          <span v-if="drawing" role="status">{{ tool === 'stroke' ? t('Draw an open line on the image.') : tool === 'polygon' ? t('Click points; double-click to finish.') : t('Drag a rectangle on the image.') }}</span><button v-if="drawing" class="btn" @click="cancelDrawing">{{ t('Cancel') }}</button>
        </div>
        <div class="alignment-image-host" :class="{ 'is-loading': !ready }"><div class="alignment-source"><img ref="image" :src="src || undefined" :alt="file.name" draggable="false"><svg v-if="asset" ref="strokeSurface" class="stroke-surface" :class="{ drawing: drawing && tool === 'stroke' }" :viewBox="`0 0 ${asset.width} ${asset.height}`" @pointerdown="strokeStart" @pointermove="strokeMove" @pointerup="strokeEnd" @pointercancel="cancelDrawing">
          <polyline v-for="region in regions.filter(r => r.geometry?.type === 'stroke')" :key="region.id" :points="region.geometry!.points.map(p => p.join(',')).join(' ')" :class="{ selected: selected === region.id }" :style="{ pointerEvents: drawing || !active ? 'none' : 'stroke' }" @pointerdown.stop="choose(region.id)" />
          <polyline v-if="strokePoints.length" :points="strokePoints.map(p => p.join(',')).join(' ')" class="selected" />
        </svg></div></div>
        <p v-if="asset" class="alignment-coordinate">{{ t('Coordinates refer to the original {width} × {height} image.', { width: asset.width, height: asset.height }) }}</p>
      </div>
      <aside class="alignment-details">
        <h3>{{ t('Local annotations') }}</h3>
        <label>{{ t('Overall change and constraints') }}<textarea v-model="description" class="alignment-description" rows="3" maxlength="8000" :disabled="!ready || !editable" :placeholder="t('What should change? What must stay the same?')" /></label>
        <ol class="alignment-regions">
          <li v-for="(region, index) in regions" :key="region.id">
            <button class="alignment-region" :class="{ preserve: region.intent === 'preserve' }" :aria-pressed="selected === region.id" @click="choose(region.id)">
              {{ region.label || t('Region {number}', { number: index + 1 }) }} · {{ region.intent === 'preserve' ? t('Keep unchanged') : t('Change region') }}
            </button>
          </li>
        </ol>
        <div v-if="selectedRegion" class="alignment-region-editor">
          <label>{{ t('Annotation label') }}<input v-model="selectedRegion.label" class="alignment-region-label" maxlength="200" :disabled="!editable"></label>
          <label>{{ t('Region intent') }}<select v-model="selectedRegion.intent" :disabled="!editable"><option value="change">{{ t('Change region') }}</option><option value="preserve">{{ t('Keep unchanged') }}</option></select></label>
          <label>{{ t('Region description') }}<textarea v-model="selectedRegion.description" class="alignment-region-description" rows="4" maxlength="4000" :disabled="!editable" :placeholder="t('Describe the change or what to preserve here.')" /></label>
          <button class="btn alignment-remove" :disabled="!editable" @click="removeRegion(selectedRegion.id)">{{ t('Remove region') }}</button>
        </div>
        <p v-if="ready && !valid" class="alignment-note">{{ t('Describe the requested change before adding instructions.') }}</p>
        <div class="alignment-controls">
          <button class="btn alignment-apply" :disabled="!ready || !editable || !valid" @click="apply">{{ t('Add instructions to draft') }}</button>
          <button class="btn alignment-clear" :disabled="!ready || !editable" @click="clear">{{ t('Clear instructions') }}</button>
          <button class="btn" :disabled="!ready || !valid" @click="downloadJson">{{ t('Export instructions') }}</button>
        </div>
        <p v-if="feedback" class="alignment-feedback" role="status">{{ feedback }}</p>
        <p v-if="hasUnsavedChanges" class="alignment-note">{{ t('Unapplied instructions') }}</p>
        <slot name="details" />
      </aside>
    </div>
  </section>
</template>

<style scoped>
.alignment-details h3 { margin:0 0 14px;font-size:14px;letter-spacing:.02em; }
.alignment-controls select { padding:8px 10px;border:1px solid var(--c-border);border-radius:8px;color:inherit;background:var(--c-bg-card);font:inherit; }
.alignment-source { position:relative;display:inline-block;max-width:100%;line-height:0; }
.stroke-surface { position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible; }
.stroke-surface.drawing { pointer-events:auto;touch-action:none;cursor:crosshair; }
.stroke-surface polyline { fill:none;stroke:#e49b25;stroke-width:3;vector-effect:non-scaling-stroke;cursor:pointer; }
.stroke-surface polyline.selected { stroke:#9673ed;stroke-width:6;filter:drop-shadow(0 0 2px white); }
.alignment-panel { padding: 16px; color: var(--c-text); }
.alignment-note, .alignment-coordinate, .alignment-feedback { font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); }
.alignment-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 300px); gap: 18px; }
.alignment-visual, .alignment-details { min-width: 0; }
.alignment-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; font-size: 12px; }
.alignment-image-host { text-align: center; overflow: auto; }
.alignment-image-host.is-loading { visibility: hidden; }
.alignment-image-host img { max-width: 100%; max-height: 60vh; object-fit: contain; }
/* v1 anchors are axis-aligned rectangles: do not expose the upstream rotation tool. */
.alignment-image-host :deep(.a9s-rotation-handle-group) { display: none; }
.alignment-image-host :deep(.a9s-annotationlayer) { touch-action: none; }
.alignment-details label { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; font-size: 12px; }
.alignment-details input, .alignment-details textarea, .alignment-details select { width: 100%; padding: 8px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; }
.alignment-details textarea { resize: vertical; }
.alignment-regions { list-style: none; padding: 0; margin: 0 0 12px; max-height: 170px; overflow: auto; }
.alignment-region { min-height:36px;border-radius:6px;margin-bottom:4px;font-size:12px;width: 100%; padding: 8px; text-align: start; border: 1px solid var(--c-border); border-inline-start: 4px solid #f59e0b; background: var(--c-bg-card); color: var(--c-text); cursor: pointer; }
.alignment-region.preserve { border-inline-start-color: #22c55e; }
.alignment-region[aria-pressed="true"] { background: var(--c-bg-muted); outline: 1px solid var(--c-blue); outline-offset: -1px; }
.alignment-panel button:focus-visible, .alignment-panel textarea:focus-visible, .alignment-panel select:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.alignment-panel .btn { min-height: 36px; }
@media (max-width: 760px) { .alignment-layout { grid-template-columns: 1fr; } .alignment-panel .btn { min-height: 44px; } }
</style>
