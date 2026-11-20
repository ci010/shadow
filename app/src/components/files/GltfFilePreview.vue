<template>
  <section class="model-view" :aria-label="playground ? t('Three.js Playground') : t('3D model')">
    <header class="model-toolbar">
      <div class="model-tools" role="group" :aria-label="t('Camera')">
        <button type="button" class="btn btn-sm" :disabled="!shown" @click="viewer?.setView('front')">{{ t('Front') }}</button>
        <button type="button" class="btn btn-sm" :disabled="!shown" @click="viewer?.setView('back')">{{ t('Back view') }}</button>
        <button type="button" class="btn btn-sm" :disabled="!shown" @click="viewer?.setView('top')">{{ t('Top') }}</button>
        <button type="button" class="btn btn-sm" :disabled="!shown" @click="viewer?.fit()">{{ t('Frame model') }}</button>
        <button type="button" class="btn btn-sm" :disabled="!shown" :aria-pressed="player" @click="togglePlayer">{{ t('Fly camera') }}</button>
      </div>
      <div class="model-tools" role="group" :aria-label="t('Model actions')">
        <button v-if="playground" type="button" class="btn btn-sm" @click="reload">{{ t('Rebuild') }}</button>
        <button v-if="playground" type="button" class="btn btn-sm" :disabled="!shown?.glb" @click="downloadGlb">{{ t('Download GLB') }}</button>
        <button type="button" class="btn btn-sm" :disabled="!shown" @click="saveView">{{ t('Save view') }}</button>
      </div>
    </header>
    <div class="model-stage"><canvas ref="canvas" tabindex="0" :aria-label="t('3D model')" :aria-describedby="helpId" /></div>
    <div class="model-status">
      <div class="selection" aria-live="polite">
        <strong>{{ playground ? t('Three.js Playground') : t('glTF asset') }}</strong>
        <HoverInfo v-if="shown" :text="shown.version" v-slot="{ triggerProps }"><code v-bind="triggerProps" tabindex="0">{{ shortVersion(shown.version) }}</code></HoverInfo>
        <span>{{ busy ? t('Building preview…') : selected.length ? t('{count} selected', { count: selected.length }) : t('No objects selected') }}</span>
      </div>
      <button type="button" class="btn btn-primary btn-sm" :disabled="!active || !shown || !selected.length || !target" @click="addToChat">{{ t('Add to chat') }}</button>
    </div>
    <div v-if="error" class="model-error" role="alert"><strong>{{ shown ? t('Preview unchanged. The new build failed.') : t('Could not open this model.') }}</strong><pre>{{ error }}</pre><button v-if="!playground" type="button" class="btn btn-sm" @click="reload">{{ t('Retry preview') }}</button></div>
    <p v-if="missing.length" class="model-warning" role="status">{{ t('No longer in this build: {ids}', { ids: missing.join(', ') }) }}</p>
    <p v-if="actionError || captureError" class="model-warning" role="status">{{ actionError || captureError }}</p>
    <details class="model-help"><summary>{{ t('Controls and selection') }}</summary>
      <p :id="helpId">{{ t('Left-click to pick, or drag a box. Hold Shift to extend. Right-drag to look, middle-drag to pan, and scroll to zoom.') }}</p>
      <p>{{ t('Fly camera: focus the canvas and move with WASD. Shift speeds up, Space rises, Ctrl descends. Escape exits.') }}</p>
      <p v-if="!target">{{ t('Open an editable conversation to add model references.') }}</p>
      <ul v-if="selected.length"><li v-for="id in selected.slice(0, 40)" :key="id">{{ viewer?.labelFor(id) }} · <code>{{ id }}</code></li></ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import { ThreeViewer, type ModelInput } from '@shadow/three-viewer'
import HoverInfo from '../HoverInfo.vue'
import { t } from '../../i18n.ts'
import { apiUrl } from '../../api-url.ts'
import { liveProjectId } from '../../composables/useLiveClient.ts'
import { useSessionFiles } from '../../composables/useSessionFiles.ts'
import { readAttachmentBytes } from '../../attachment-preview.ts'
import type { ArchiveReference } from '../../archive-format.ts'
import { isPlaygroundFile, collectModelResources, modelVersion, MODEL_MAX_BYTES } from '../../gltf-file-source.ts'
import { GltfReferenceDraftKey, type GltfFileOwner, type GltfReferenceSource, type GltfPrepareCapture } from '../../gltf-reference.ts'
import { createUuid } from '../../uuid.ts'
import { useModelCapture } from '../../composables/useModelCapture.ts'
import { exportSnapshot, fetchPlaygroundSnapshot, watchPlayground } from '../../three-playground-client.ts'

// FilePreviewModal keys this editor by its source owner and path, never by mtime.
const props = defineProps<{ apiBase: string; path: string; sessionId: string; folderId?: string; sessionWorkspace?: boolean;
  active: boolean; canReview: boolean; remote?: boolean; attachmentUrl?: string; archive?: ArchiveReference; sourceBlob?: Blob }>()
const emit = defineEmits<{ added: [] }>()
const helpId = useId(), canvas = ref<HTMLCanvasElement>(), viewer = shallowRef<ThreeViewer>()
const draft = inject(GltfReferenceDraftKey, null)
const projectId = computed(() => liveProjectId(props.apiBase))
const source = computed<GltfReferenceSource>(() => {
  const owner: GltfFileOwner = props.attachmentUrl ? { kind: 'attachment', sessionId: props.sessionId }
    : props.folderId ? { kind: 'folder', folderId: props.folderId }
    : { kind: props.sessionWorkspace ? 'session-files' : 'session-workdir', sessionId: props.sessionId }
  return { apiBase: props.apiBase, projectId: projectId.value, ...(props.archive
    ? { kind: 'archive', owner, archivePath: props.archive.path, members: props.archive.members.slice(0, -1) } as const : owner) }
})
const path = computed(() => props.archive?.members.at(-1) ?? props.path)
// An attachment's signed URL is not a publishable identity, and basenames can collide.
const attachmentKey = props.attachmentUrl ? createUuid() : undefined
const assetId = computed(() => { const { apiBase: _, ...owner } = source.value; return JSON.stringify([owner, path.value, ...(attachmentKey ? [attachmentKey] : [])]) })
const playground = computed(() => !props.archive && !props.attachmentUrl && isPlaygroundFile(props.path.split('/').at(-1)!))
const target = computed(() => props.canReview ? draft?.target(source.value) : null)
const shown = shallowRef<{ version: string; glb?: ArrayBuffer }>()
const selected = shallowRef<readonly string[]>([]), missing = shallowRef<readonly string[]>([])
const busy = ref(false), player = ref(false), error = ref(''), actionError = ref('')
const mounted = ref(false), linked = ref<string | null>(null)
let filesWatch: ReturnType<typeof watchPlayground> | undefined, assetRead: AbortController | undefined
const shortVersion = (v: string) => v.includes(':') ? v.split(':').map(p => p.slice(0, 8)).join(':') : v.slice(0, 12)
function failure(cause: unknown, version?: string) {
  busy.value = false
  error.value = [version, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
}
function initialize() {
  if (viewer.value) return viewer.value
  if (!canvas.value) throw new Error('Viewer canvas unavailable')
  viewer.value = new ThreeViewer(canvas.value, { ariaLabel: t('3D model'),
    background: getComputedStyle(canvas.value.parentElement!).backgroundColor, ground: true,
    instructions: t('Left-click to pick, or drag a box. Hold Shift to extend. Right-drag to look, middle-drag to pan, and scroll to zoom.'),
    onPlayerModeChange: enabled => { player.value = enabled }, onSelectionChange: event => {
      selected.value = event.selection
      if (event.reason === 'load') missing.value = event.removed
      else if (event.reason === 'selection') missing.value = []
    },
  })
  return viewer.value
}
async function display(input: ModelInput, glb?: ArrayBuffer) {
  input.signal?.throwIfAborted()
  const view = initialize()
  missing.value = []
  await view.load(input)
  input.signal?.throwIfAborted()
  shown.value = { version: input.version, glb }; selected.value = view.selection; busy.value = false; error.value = ''
}
async function loadAsset() {
  assetRead?.abort()
  const request = assetRead = new AbortController(), { signal } = request
  busy.value = true; error.value = ''
  try {
    const files = useSessionFiles(props.apiBase, props.folderId, props.sessionWorkspace)
    let bytes: Uint8Array<ArrayBuffer>
    if (props.attachmentUrl) {
      const read = await readAttachmentBytes(props.attachmentUrl, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), MODEL_MAX_BYTES)
      if (read.truncated) throw new Error('Attachment exceeds 32 MiB')
      bytes = new Uint8Array(read.bytes)
    } else {
      const blob = props.sourceBlob ?? await files.readBlob(props.sessionId, props.path, signal, MODEL_MAX_BYTES, 'Model exceeds 32 MiB')
      if (blob.size > MODEL_MAX_BYTES) throw new Error('Model exceeds 32 MiB')
      bytes = new Uint8Array(await blob.arrayBuffer())
    }
    const dir = props.path.slice(0, props.path.lastIndexOf('/') + 1)
    const resources = await collectModelResources(bytes, signal, props.attachmentUrl || props.sourceBlob ? undefined : async (relative, maxBytes) =>
      new Uint8Array(await (await files.readBlob(props.sessionId, dir + relative, signal, maxBytes, 'glTF resource byte limit exceeded')).arrayBuffer()))
    await display({ bytes, resources, identity: 'gltf', version: await modelVersion(bytes, resources), signal })
  } catch (e) { if (!signal.aborted) failure(e) }
}
function start() {
  if (!playground.value) { if (!shown.value) void loadAsset(); return }
  if (filesWatch) return
  const scope = props.folderId ? `folders/${encodeURIComponent(props.folderId)}` : `sessions/${encodeURIComponent(props.sessionId)}${props.sessionWorkspace ? '/workspace' : ''}`
  const url = apiUrl(props.apiBase, `/api/${scope}/three-snapshot`, { path: props.path })
  if (!shown.value) busy.value = true
  filesWatch = watchPlayground({ read: (tag, signal) => fetchPlaygroundSnapshot(url, tag, signal), failed: failure,
    async build(snapshot, signal) {
      busy.value = true; error.value = ''
      const glb = await exportSnapshot(snapshot, signal)
      const version = `${snapshot.version}:${await modelVersion(new Uint8Array(glb), new Map())}`
      await display({ bytes: glb, version, identity: 'playground', shaders: snapshot.shaders, signal }, glb)
    },
  })
}
function stop() { filesWatch?.dispose(); filesWatch = undefined; assetRead?.abort(); busy.value = false }
function reload() { if (playground.value) filesWatch ? filesWatch.rebuild() : start(); else void loadAsset() }
function togglePlayer() { viewer.value?.setPlayerMode(!player.value); canvas.value?.focus({ preventScroll: true }) }
function addToChat() {
  const dest = target.value, build = shown.value, view = viewer.value
  if (!props.active || !build || !view || !dest || !draft) return
  const refs = view.selection.map(objectId => ({ assetId: assetId.value, path: path.value, buildVersion: build.version,
    objectId, label: view.labelFor(objectId) || objectId }))
  if (draft.add(source.value, dest.key, refs, prepareCapture)) { linked.value = dest.sessionId; actionError.value = ''; emit('added') }
  else actionError.value = t('Could not add these objects to the current draft.')
}
// Retain a hidden editor only after an explicit Add, and only for that same chat.
const { status: captureError, ready: captureReady } = useModelCapture(viewer, () => ({ apiBase: props.apiBase, projectId: projectId.value, assetId: assetId.value,
  sessionId: (props.active && target.value?.sessionId) || linked.value, version: shown.value?.version }))
const prepareCapture: GltfPrepareCapture = async (allocated, signal) => {
  if (signal.aborted || !mounted.value || allocated.apiBase !== props.apiBase || allocated.projectId !== projectId.value
    || allocated.assetId !== assetId.value || allocated.version !== shown.value?.version || !allocated.sessionId.startsWith('web:')) return false
  const abort = () => { if (linked.value === allocated.sessionId) linked.value = null }
  signal.addEventListener('abort', abort, { once: true })
  linked.value = allocated.sessionId
  try {
    const ready = await captureReady(allocated.sessionId, allocated.version)
    if (!ready || signal.aborted) { abort(); return false }
    return true
  } finally { signal.removeEventListener('abort', abort) }
}
const urls = new Map<string, ReturnType<typeof setTimeout>>()
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  urls.set(url, setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url) }, 60_000))
  const link = document.createElement('a'); link.href = url; link.download = name
  document.body.append(link); try { link.click() } finally { link.remove() }
}
function downloadGlb() {
  const build = shown.value
  if (build?.glb) download(new Blob([build.glb], { type: 'model/gltf-binary' }), `${props.path.split('/').at(-2) || 'model'}-${shortVersion(build.version).replace(':', '-')}.glb`)
}
async function saveView() {
  try {
    const frame = await viewer.value?.captureFrame()
    if (frame?.version && mounted.value) download(frame.image, `model-${shortVersion(frame.version).replace(':', '-')}.png`)
  } catch (e) { actionError.value = String(e) }
}
watch([mounted, () => !!(props.active || linked.value)], ([ready, retained]) => { if (ready && retained) start(); else stop() })
watch(() => props.active, active => { if (!active && player.value) viewer.value?.setPlayerMode(false) })
onMounted(() => { mounted.value = true })
onBeforeUnmount(() => { mounted.value = false; stop(); viewer.value?.dispose(); viewer.value = undefined
  for (const [url, timeout] of urls) { clearTimeout(timeout); URL.revokeObjectURL(url) } urls.clear() })
</script>

<style scoped>
.model-view { display:flex; flex-direction:column; width:100%; min-width:0; height:100%; min-height:0; overflow:auto; color:var(--c-text); background:var(--c-bg-card); font-size:13px }
.model-toolbar,.model-status,.model-tools,.selection { display:flex; flex-wrap:wrap; align-items:center; gap:4px }
.model-toolbar,.model-status { justify-content:space-between; gap:8px; padding:6px 10px; border-bottom:1px solid var(--c-border-soft) }
.model-stage { flex:1 1 auto; min-height:140px; min-width:0; position:relative; background:var(--c-bg-soft) }
.model-stage canvas { display:block; position:absolute; inset:0; width:100%; height:100%; outline-offset:-2px }
.model-toolbar .btn[aria-pressed=true] { color:var(--c-primary); background:var(--c-selection-bg) }
.selection { gap:8px; color:var(--c-text-secondary) }
.selection strong { color:var(--c-text); font-weight:500 }
.model-help,.model-warning,.model-error { padding:6px 10px; margin:0; overflow-wrap:anywhere }
.model-help { color:var(--c-text-secondary); font-size:12px }
.model-help summary { cursor:pointer; padding:4px 0 }
.model-help p { margin:4px 0 }
.model-help ul { max-height:5rem; overflow:auto; margin:4px 0 }
.model-error { background:var(--c-error-bg); color:var(--c-error) }
.model-error pre { margin:4px 0; max-height:7em; overflow:auto; white-space:pre-wrap; font-size:12px }
.model-warning { color:var(--c-warn); background:var(--c-warn-bg) }
</style>
