
import { sourceSha256 } from '../../alignment-sha256.ts'
import { appendImageDrawingPoint, isStraightImageGesture, type ImageDrawingTool } from '../../image-drawing.ts'
import { createUuid } from '../../uuid.ts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createImageAnnotator, ShapeType, UserSelectAction, type ImageAnnotation, type ImageAnnotator, type PolygonGeometry, type RectangleGeometry } from '@annotorious/annotorious'
import { t } from '../../i18n.ts'
import { annotationSizeError } from '../../image-annotation.ts'
import { parseImageAlignment, type ImageAlignmentDocument, type ImageAlignmentRegion } from '../../image-alignment.ts'

export interface ImageAlignmentProps { file: File; initial?: ImageAlignmentDocument; editable: boolean; active: boolean; compact?: boolean }
export function useImageAlignment(props: ImageAlignmentProps, emit: { (event: 'apply', document: ImageAlignmentDocument): void; (event: 'clear'): void }) {
const image = ref<HTMLImageElement>()
const src = ref('')
const ready = ref(false)
const error = ref('')
const feedback = ref('')
const regions = ref<ImageAlignmentRegion[]>([])
const description = ref('')
const selected = ref('')
const drawing = ref(false)
const tool = ref<ImageDrawingTool>('freehand')
let strokeIsLine = false
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
    return { fill: preserve ? '#267047' : '#245bc1', fillOpacity: selected.value === annotation.id ? 0.1 : 0.025,
      stroke: preserve ? '#267047' : '#245bc1', strokeOpacity: 1, strokeWidth: selected.value === annotation.id ? 2.5 : 1.5 }
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
    armTool()
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
  // Inspecting a card must not silently disarm the drawing tool.
  cancelDrawing()
  selected.value = id
  if (tool.value === 'select') {
    annotator?.setUserSelectAction(props.editable && props.active ? UserSelectAction.EDIT : UserSelectAction.SELECT)
    if (selectedRegion.value?.geometry?.type === 'stroke') annotator?.cancelSelected()
    else annotator?.setSelected(id)
  } else armTool()
  refreshStyle()
}
function armTool() {
  if (!ready.value || !props.active || !props.editable || regions.value.length >= 50 || tool.value === 'select') return
  drawing.value = true
  // One pointer surface owns creation, including drawing over existing shapes.
  // Annotorious remains responsible only for selection and resize in Select mode.
  annotator?.cancelSelected()
  annotator?.setUserSelectAction(UserSelectAction.NONE)
  annotator?.setDrawingEnabled(false)
}
function setTool(value: ImageDrawingTool) {
  cancelDrawing()
  annotator?.cancelSelected()
  tool.value = value
  if (value === 'select') {
    annotator?.setUserSelectAction(props.editable ? UserSelectAction.EDIT : UserSelectAction.SELECT)
    if (selectedRegion.value && selectedRegion.value.geometry?.type !== 'stroke') annotator?.setSelected(selected.value)
  } else armTool()
}
function addRegion() { setTool(tool.value === 'select' ? 'rectangle' : tool.value) }
function undo() {
  cancelDrawing()
  const last = regions.value.at(-1)
  if (last) removeRegion(last.id)
  armTool()
}
function keydown(event: KeyboardEvent) {
  if (!props.active || !props.editable || !(event.target instanceof Element) || !event.target.closest('.alignment-visual')) return
  if (event.key === 'Escape' && (pointerId !== undefined || strokePoints.value.length)) { event.preventDefault(); event.stopPropagation(); cancelGesture() }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && !event.repeat && !event.isComposing && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); undo() }
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
function commitRegion(points: [number, number][], kind: 'rectangle' | 'stroke') {
  const size = asset.value!
  const x = Math.min(...points.map(p => p[0])), y = Math.min(...points.map(p => p[1]))
  const width = Math.max(...points.map(p => p[0])) - x, height = Math.max(...points.map(p => p[1])) - y
  const region: ImageAlignmentRegion = {
    id: createUuid(), x: Math.min(x, size.width - 1), y: Math.min(y, size.height - 1),
    width: Math.max(1, width), height: Math.max(1, height), intent: 'change', description: '',
    ...(kind !== 'rectangle' ? { geometry: { type: kind, points } } : {}),
  }
  regions.value.push(region)
  selected.value = region.id
  if (kind !== 'stroke') {
    // Silent source-store replacement avoids competing library drawing gestures
    // and its debounced creation/undo lifecycle. Existing geometry was reconciled.
    annotator?.setAnnotations(regions.value.filter(item => item.geometry?.type !== 'stroke').map(toAnnotation))
  }
  feedback.value = ''
  refreshStyle()
}
function strokeStart(event: PointerEvent) {
  if (!props.active || !props.editable || !ready.value || !drawing.value || tool.value === 'select' || event.button !== 0 || !event.isPrimary || event.ctrlKey || event.metaKey || pointerId !== undefined || regions.value.length >= 50) return
  event.preventDefault()
  strokeSurface.value?.focus({ preventScroll: true })
  reconcileRegions()
  strokeIsLine = isStraightImageGesture(tool.value, event.shiftKey) || tool.value === 'rectangle'
  pointerId = event.pointerId
  try { strokeSurface.value!.setPointerCapture(pointerId) } catch { pointerId = undefined; return }
  strokePoints.value = [point(event)]
}
function strokeMove(event: PointerEvent) {
  if (pointerId !== event.pointerId) return
  if (!(event.buttons & 1)) { cancelGesture(); return }
  appendImageDrawingPoint(strokePoints.value, point(event), strokeIsLine, 9999)
}
function strokeEnd(event: PointerEvent) {
  if (pointerId !== event.pointerId) return
  // pointerup commonly has buttons=0; record its final coordinate directly.
  appendImageDrawingPoint(strokePoints.value, point(event), strokeIsLine, 9999)
  const points = [...strokePoints.value]
  if (tool.value === 'rectangle') {
    const first = points[0]!, last = points.at(-1)!
    if (Math.abs(first[0]-last[0]) >= 1 && Math.abs(first[1]-last[1]) >= 1) commitRegion([first,last], 'rectangle')
    else {
      const hit = [...regions.value].reverse().find(region => !region.geometry && first[0]>=region.x && first[0]<=region.x+region.width && first[1]>=region.y && first[1]<=region.y+region.height)
      if (hit) choose(hit.id)
      else feedback.value = t('Drag a rectangle on the image.')
    }
  } else {
    // A stationary click is a visible dot, not a discarded no-op.
    if (points.length === 1) points.push([...points[0]!] as [number,number])
    commitRegion(points, 'stroke')
  }
  cancelDrawing()
  armTool()
}
function cancelGesture() { cancelDrawing(); armTool() }
function removeRegion(id: string) {
  if (!props.editable) return
  if (annotator?.getAnnotationById(id)) annotator.removeAnnotation(id)
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
  armTool()
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
    const sha256 = await sourceSha256(await props.file.arrayBuffer())
    if (disposed || ticket !== generation) return
    asset.value = { sha256, width: target.naturalWidth, height: target.naturalHeight }
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
    annotator.on('selectionChanged', (annotations: ImageAnnotation[]) => { if (tool.value === 'select' && annotations[0]) selected.value = annotations[0].id })
    refreshStyle()
    savedSnapshot.value = snapshot()
    ready.value = true
    armTool()
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
  } else armTool()
})
watch(() => [selectedRegion.value?.intent, selected.value], refreshStyle)
onMounted(() => { window.addEventListener('keydown', keydown, true); return load() })
onBeforeUnmount(() => { window.removeEventListener('keydown', keydown, true); disposed = true; ++generation; annotator?.destroy(); if (src.value) URL.revokeObjectURL(src.value) })


return { image, src, ready, error, feedback, regions, description, selected, drawing, tool, strokePoints, strokeSurface, asset, selectedRegion, hasUnsavedChanges, valid, choose, addRegion, setTool, undo, cancelGesture, cancelDrawing, strokeStart, strokeMove, strokeEnd, removeRegion, apply, clear, downloadJson, load, reconcileRegions }
}
export type ImageAlignmentController = ReturnType<typeof useImageAlignment>
