<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { t } from '../../i18n'
import { alignmentRevision, type AlignmentSource, type AlignmentSurfaceProps, type AlignmentTarget } from '../../alignment-lab-model'
import { createSpatialExampleGlb, MAX_SPATIAL_GLB_BYTES, spatialPointSelector, validateSpatialGlb, type ModelPoint } from '../../alignment-spatial'

const props = defineProps<AlignmentSurfaceProps & { hasInstructions?: boolean }>()
const emit = defineEmits<{ source: [AlignmentSource]; target: [AlignmentTarget]; select: [string] }>()
interface Viewer extends HTMLElement {
  positionAndNormalFromPoint(x: number, y: number): { position: ModelPoint; normal: ModelPoint } | null
  surfaceFromPoint(x: number, y: number): string | null
  getCameraOrbit(): { theta: number; phi: number; radius: number }
  getCameraTarget(): ModelPoint
  jumpCameraToGoal(): void
}
const viewer = shallowRef<Viewer | null>(null)
const url = ref(''), label = ref(''), ready = ref(false), loading = ref(true), error = ref(''), adding = ref(false), supported = ref(true)
const initialized = ref(false), reading = ref(false)
const input = ref<HTMLInputElement | null>(null)
const camera = ref({ orbit: '0deg 65deg 5m', target: '0m 0m 0m' })
let disposed = false, generation = 0, hotspotNumber = 0
let pointer: { x: number; y: number; id: number; at: number } | undefined
const discardedIds = ref(new Set<string>())
const hotspots = computed(() => props.targets.filter(target => target.selector.type === 'spatial' && !discardedIds.value.has(target.id)))
function rememberCamera() {
  const element = viewer.value
  if (!element || !ready.value) return
  const orbit = element.getCameraOrbit(), target = element.getCameraTarget()
  camera.value = { orbit: `${orbit.theta}rad ${orbit.phi}rad ${orbit.radius}m`, target: `${target.x}m ${target.y}m ${target.z}m` }
}
function selectTarget(target: AlignmentTarget) {
  if (disposed || !props.active || !ready.value || loading.value || reading.value || target.selector.type !== 'spatial') return
  if (target.selector.camera) camera.value = { ...target.selector.camera }
  emit('select', target.id)
}
watch(() => props.selectedId, id => {
  const target = props.targets.find(item => item.id === id)
  if (target?.selector.type === 'spatial' && target.selector.camera) camera.value = { ...target.selector.camera }
})
watch(() => props.active, active => { if (!active) { rememberCamera(); pointer = undefined } })
async function replace(bytes: Uint8Array, name: string) {
  validateSpatialGlb(bytes)
  if ((props.hasInstructions || props.targets.length) && !window.confirm(t('Replace the model and discard all existing spatial targets and instructions?'))) {
    if (!url.value) loading.value = false
    return
  }
  const request = ++generation
  const blob = new Blob([new Uint8Array(bytes)], { type: 'model/gltf-binary' })
  const revision = await alignmentRevision(blob)
  if (disposed || request !== generation) return
  const next = URL.createObjectURL(blob), previous = url.value
  ready.value = false; loading.value = true; error.value = ''; adding.value = false
  camera.value = { orbit: '0deg 65deg auto', target: 'auto auto auto' }
  discardedIds.value = new Set(props.targets.map(target => target.id))
  hotspotNumber = 0
  label.value = name; url.value = next
  emit('source', { id: `spatial:${revision}`, label: name, revision, context: `Local embedded GLB: ${name}. SHA-256: ${revision}. Model-local right-handed glTF coordinates (+Y up), distances in metres (glTF convention; imported author scale is not verified). Hotspot positions/normals refer only to this revision. The local binary is not uploaded or attached to the request.` })
  if (previous) URL.revokeObjectURL(previous)
}
async function choose(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file || disposed || !props.active || !initialized.value || !supported.value || loading.value || reading.value) return
  if (!/\.glb$/i.test(file.name) || file.size > MAX_SPATIAL_GLB_BYTES) { error.value = t('Choose a self-contained .glb file up to 32 MiB.'); return }
  reading.value = true; pointer = undefined
  try { await replace(new Uint8Array(await file.arrayBuffer()), file.name) }
  catch { error.value = t('Invalid or unsupported GLB. Use embedded core glTF resources only; external URIs and extensions are rejected.') }
  finally { reading.value = false }
}
function point(event: PointerEvent) {
  const start = pointer; pointer = undefined
  if (!props.active || loading.value || reading.value || disposed || !adding.value || !ready.value || !start || start.id !== event.pointerId || performance.now() - start.at > 700 || Math.hypot(event.clientX-start.x,event.clientY-start.y) > 5 || event.composedPath().some(node => node instanceof HTMLButtonElement)) return
  const element = viewer.value
  if (!element) return
  const hit = element.positionAndNormalFromPoint(event.clientX, event.clientY)
  if (!hit) { error.value = t('No model surface here. Click directly on the model.'); return }
  rememberCamera()
  const surface = element.surfaceFromPoint(event.clientX,event.clientY)
  const id = `spatial-${crypto.randomUUID()}`
  const selector = spatialPointSelector(hit.position, hit.normal, surface, { ...camera.value })
  emit('target', { id, label: `${t('Spatial hotspot')} ${++hotspotNumber}`, selector })
  emit('select', id); error.value = ''
}
const ModelPreview = () => h('model-viewer', {
  key: url.value,
  ref: (element: unknown) => { viewer.value = element as Viewer | null },
  src: url.value, alt: label.value, 'camera-controls': '', 'touch-action': 'pan-y',
  'camera-orbit': camera.value.orbit, 'camera-target': camera.value.target,
  'environment-image': 'neutral', 'interaction-prompt': 'none', exposure: '1',
  style: { display: 'block', width: '100%', height: '420px', background: '#202632' },
  onLoad: (event: Event) => { if (!props.active || disposed || event.currentTarget !== viewer.value) return; ready.value = true; loading.value = false; error.value = '' },
  onError: (event: Event) => { if (!props.active || disposed || event.currentTarget !== viewer.value) return; ready.value = false; loading.value = false; error.value = t('The 3D model could not be rendered. Check the GLB and WebGL support.') },
  onCameraChange: rememberCamera,
  onPointerdown: (event: PointerEvent) => { if (props.active && ready.value && !loading.value && !reading.value && event.button === 0) pointer = { x: event.clientX, y: event.clientY, id: event.pointerId, at: performance.now() } },
  onPointerup: point, onPointercancel: () => { pointer = undefined },
}, hotspots.value.map(target => {
  if (target.selector.type !== 'spatial') return null
  const s = target.selector
  return h('button', {
    key: target.id, slot: `hotspot-${target.id}`, type: 'button',
    'data-surface': s.surface, 'data-position': s.position.map(v => `${v}m`).join(' '), 'data-normal': s.normal.join(' '),
    'aria-pressed': target.id === props.selectedId, title: target.label,
    style: { borderRadius: '12px', border: target.id === props.selectedId ? '3px solid #ffb638' : '2px solid white', background: '#243c67', color: 'white', padding: '4px 8px', cursor: 'pointer' },
    onClick: (event: MouseEvent) => { event.stopPropagation(); selectTarget(target) },
  }, target.label)
}))
onMounted(async () => {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  if (!gl) { supported.value = false; loading.value = false; error.value = t('WebGL is unavailable. Enable hardware acceleration or use another browser.'); return }
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  try {
    await import('@google/model-viewer')
    if (!disposed) await replace(createSpatialExampleGlb(), t('Three cubes (local example)'))
    if (!disposed) initialized.value = true
  } catch { loading.value = false; error.value = t('The 3D viewer could not be initialized.') }
})
onBeforeUnmount(() => { disposed = true; generation++; pointer = undefined; if (url.value) URL.revokeObjectURL(url.value) })
</script>

<template>
  <section class="spatial-surface" :aria-label="t('Spatial model alignment')">
    <div class="spatial-toolbar">
      <button class="btn" type="button" :disabled="!supported || !initialized || loading || reading || !active" @click="input?.click()">{{ t('Open local GLB') }}</button>
      <input ref="input" type="file" accept=".glb,model/gltf-binary" hidden @change="choose">
      <button class="btn" type="button" :disabled="!ready || loading || reading || !active" :aria-pressed="adding" @click="adding = !adding">{{ adding ? t('Finish adding hotspots') : t('Add surface hotspots') }}</button>
      <span>{{ label }}</span>
      <a v-if="ready && url" class="btn" :href="url" :download="/\.glb$/i.test(label) ? label : `${label}.glb`">{{ t('Download source') }}</a>
    </div>
    <p>{{ t('Drag to orbit; scroll or pinch to zoom. Enable hotspot mode, then click a model surface. Local only; no upload or AI.') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="(loading || reading) && active" role="status">{{ t('Loading 3D model…') }}</p>
    <ModelPreview v-if="active && supported && url" />
    <p v-if="!active">{{ t('3D preview paused while hidden.') }}</p>
    <div class="spatial-targets" :aria-label="t('Spatial hotspots')">
      <button v-for="target in hotspots" :key="target.id" type="button" :disabled="!active || !ready || loading || reading" :aria-pressed="selectedId === target.id" @click="selectTarget(target)">{{ target.label }}</button>
    </div>
  </section>
</template>

<style scoped>
.spatial-surface { min-width: 0; }
.spatial-toolbar, .spatial-targets { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.spatial-surface p { font-size: .9rem; opacity: .85; }
button[aria-pressed="true"] { outline: 2px solid #df9c29; }
</style>
