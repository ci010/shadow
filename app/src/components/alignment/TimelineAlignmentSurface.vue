<script setup lang="ts">
import AlignmentZoom from './AlignmentZoom.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js'
import { t } from '../../i18n.ts'
import { alignmentRevision, type AlignmentSource, type AlignmentSurfaceProps, type AlignmentTarget } from '../../alignment-lab-model.ts'
import { timelineDemoWav, timelineRange, TIMELINE_MAX_BYTES, TIMELINE_MAX_DURATION, type TimelineTrack } from '../../alignment-timeline.ts'

const props = defineProps<AlignmentSurfaceProps>()
const emit = defineEmits<{ source: [AlignmentSource]; target: [AlignmentTarget]; select: [string] }>()
const wave = ref<HTMLElement>(), media = ref<HTMLVideoElement>()
const ready = ref(false), loading = ref(false), error = ref(''), label = ref(''), video = ref(false)
const duration = ref(0), current = ref(0), playing = ref(false), start = ref(0), end = ref(2), zoom = ref(30)
const track = ref<TimelineTrack>('audio')
let ws: WaveSurfer | undefined, regions: ReturnType<typeof RegionsPlugin.create> | undefined
let disableDragSelection: (() => void) | undefined
let metadataAbort: AbortController | undefined
let url = '', generation = 0, disposed = false, syncing = false
// Never render coordinates belonging to a replaced source, even if a parent clears asynchronously.
const retiredIds = new Set<string>()
const visibleTargets = computed(() => ready.value ? props.targets.filter(target => target.selector.type === 'time-range' && !retiredIds.has(target.id)) : [])
const valid = computed(() => Number.isFinite(start.value) && Number.isFinite(end.value) && start.value >= 0 && start.value < end.value && end.value <= duration.value)
function stop() { ws?.pause(); media.value?.pause(); playing.value = false }
function cleanup() { metadataAbort?.abort(); metadataAbort = undefined; disableDragSelection?.(); disableDragSelection = undefined; stop(); ws?.destroy(); ws = undefined; regions = undefined; if (media.value) { media.value.removeAttribute('src'); media.value.load() }; if (url) URL.revokeObjectURL(url); url = '' }
function syncRegions() {
  if (!regions || !ready.value) return
  syncing = true
  regions.clearRegions()
  for (const target of visibleTargets.value) {
    const s = target.selector
    if (s.type !== 'time-range' || s.duration !== duration.value || s.end > duration.value) continue
    regions.addRegion({ id: target.id, start: s.start, end: s.end, content: target.label, color: target.id === props.selectedId ? 'rgba(84,150,240,.38)' : 'rgba(115,170,155,.22)', drag: props.active, resize: props.active })
  }
  syncing = false
}
async function videoDuration(element: HTMLVideoElement, source: string): Promise<number> {
  metadataAbort = new AbortController()
  const signal = AbortSignal.any([metadataAbort.signal, AbortSignal.timeout(15000)])
  return new Promise((resolve, reject) => {
    const cleanup = () => { element.removeEventListener('loadedmetadata', loaded); element.removeEventListener('error', failed); signal.removeEventListener('abort', failed) }
    const loaded = () => { cleanup(); resolve(element.duration) }
    const failed = () => { cleanup(); reject(new Error('Video metadata unavailable')) }
    element.addEventListener('loadedmetadata', loaded, { once: true }); element.addEventListener('error', failed, { once: true }); signal.addEventListener('abort', failed, { once: true })
    element.src = source; element.load()
  })
}
async function load(file: File) {
  if (loading.value || disposed) return
  error.value = ''
  if (file.size > TIMELINE_MAX_BYTES || !/^(audio|video)\//.test(file.type)) { error.value = t('Choose audio or video up to 40 MB.'); return }
  if ((props.hasInstructions || props.targets.length) && !window.confirm(t('Replace this media and discard its timeline annotations?'))) return
  for (const target of props.targets) retiredIds.add(target.id)
  const token = ++generation
  loading.value = true; ready.value = false; cleanup()
  try {
    const revision = await alignmentRevision(file)
    if (disposed || token !== generation) return
    video.value = file.type.startsWith('video/'); label.value = file.name
    await nextTick()
    if (!media.value || !wave.value) throw new Error('Missing media surface')
    url = URL.createObjectURL(file)
    regions = RegionsPlugin.create()
    ws = WaveSurfer.create({ container: wave.value, media: media.value, height: 120, waveColor: '#769eaa', progressColor: '#529ad5', minPxPerSec: zoom.value, plugins: [regions, TimelinePlugin.create({ height: 20, style: { color: 'var(--c-text-secondary)', fontSize: '11px' } })] })
    ws.on('timeupdate', time => { current.value = time })
    ws.on('play', () => { if (!props.active) stop(); else playing.value = true })
    ws.on('pause', () => { playing.value = false })
    ws.on('error', () => { if (ready.value) { stop(); error.value = t('Cannot decode or play this media. Try a smaller supported file.'); ready.value = false } })
    regions.on('region-clicked', (region, event) => { event.stopPropagation(); if (!ready.value || !props.active) return; emit('select', region.id); start.value = region.start; end.value = region.end; ws?.setTime(region.start) })
    regions.on('region-updated', region => {
      if (syncing || !ready.value || !props.active) return
      const previous = props.targets.find(target => target.id === region.id)
      if (previous?.selector.type !== 'time-range') return
      emit('target', timelineRange(region.start, region.end, duration.value, previous.selector.trackId as TimelineTrack, previous.id, previous.label))
      emit('select', previous.id); start.value = region.start; end.value = region.end
    })
    regions.on('region-created', region => {
      if (syncing || !ready.value || props.targets.some(target => target.id === region.id)) return
      const a = region.start, b = region.end
      region.remove()
      if (props.active && a < b) add(a, b)
    })
    if (video.value) {
      const length = await videoDuration(media.value, url)
      if (disposed || token !== generation) return
      if (!Number.isFinite(length) || length <= 0 || length > TIMELINE_MAX_DURATION) throw new Error('Invalid duration')
      // A silent video has no decodable audio. Use its native media clock with an explicit
      // neutral lane rather than inventing a waveform or rejecting a valid video.
      await ws.load(url, [new Float32Array([0, 0])], length)
    } else await ws.load(url)
    if (disposed || token !== generation) return
    const length = ws.getDuration()
    if (!Number.isFinite(length) || length <= 0 || length > TIMELINE_MAX_DURATION) throw new Error('Invalid duration')
    duration.value = length; start.value = 0; end.value = Math.min(2, length); current.value = 0
    track.value = video.value ? 'video' : 'audio'
    emit('source', { id: `media-${revision}`, label: file.name, revision, context: `Local ${file.type} file: ${file.name}; duration ${length} seconds. Coordinates are source seconds. File bytes are not uploaded or attached.` })
    await nextTick()
    ready.value = true; syncRegions(); syncDragSelection()
  } catch { if (!disposed && token === generation) { cleanup(); error.value = t('Cannot decode or play this media. Try a smaller supported file.') } }
  finally { if (token === generation) loading.value = false }
}
function choose(event: Event) { const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = ''; if (file) void load(file) }
function demo() { void load(new File([timelineDemoWav()], 'timeline-demo.wav', { type: 'audio/wav' })) }
function add(a = start.value, b = end.value) {
  if (!props.active || !ready.value || a < 0 || a >= b || b > duration.value) return
  const id = crypto.randomUUID()
  emit('target', timelineRange(a, b, duration.value, track.value, id, `${track.value} ${a.toFixed(2)}–${b.toFixed(2)} s`)); emit('select', id)
}
function select(target: AlignmentTarget) { if (!props.active || target.selector.type !== 'time-range') return; emit('select', target.id); start.value = target.selector.start; end.value = target.selector.end; track.value = target.selector.trackId as TimelineTrack; ws?.setTime(start.value) }
function updateSelected() { const target = visibleTargets.value.find(item => item.id === props.selectedId); if (props.active && ready.value && valid.value && target) emit('target', timelineRange(start.value, end.value, duration.value, track.value, target.id, target.label)) }
async function togglePlayback() { try { if (playing.value) stop(); else if (props.active) await ws?.play() } catch { error.value = t('Cannot decode or play this media. Try a smaller supported file.') } }
function syncDragSelection() {
  disableDragSelection?.(); disableDragSelection = undefined
  if (props.active && ready.value && regions) disableDragSelection = regions.enableDragSelection({ color: 'rgba(84,150,240,.25)' })
}
watch(() => props.active, active => { if (!active) stop(); syncDragSelection(); syncRegions() }, { flush: 'sync' })
watch(() => [props.targets, props.selectedId], syncRegions, { deep: true })
watch(zoom, value => { if (ready.value) ws?.zoom(value) })
onMounted(demo)
onBeforeUnmount(() => { disposed = true; generation++; cleanup() })
</script>

<template>
  <section class="timeline-surface" :aria-label="t('Timeline alignment')">
    <div class="toolbar">
      <label>{{ t('Choose local audio or video') }}<input type="file" accept="audio/*,video/*" :disabled="loading" @change="choose"></label>
      <button class="btn" :disabled="loading" @click="demo">{{ t('Load synthetic audio sample') }}</button>
    </div>
    <p>{{ t('Local preview only. Select ranges for instructions; no upload, AI execution, or media editing occurs.') }}</p>
    <p v-if="loading" role="status">{{ t('Loading media…') }}</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div class="toolbar"><strong>{{ label }}</strong><a v-if="ready" class="btn" :href="url" :download="label">{{ t('Download source') }}</a></div>
    <video ref="media" :class="{ 'audio-only': !video }" playsinline preload="metadata" @pause="playing = false" />
    <p v-if="video">{{ t('Video ranges use the preview clock. This neutral lane does not represent an audio waveform.') }}</p>
    <div ref="wave" class="wave" />
    <div class="toolbar">
      <button class="btn" :disabled="!ready || !active" @click="togglePlayback">{{ playing ? t('Pause timeline') : t('Play timeline') }}</button>
      <output>{{ current.toFixed(2) }} / {{ duration.toFixed(2) }} s</output>
      <AlignmentZoom v-model="zoom" :min="10" :max="200" :step="2" :disabled="!ready" />
    </div>
    <p>{{ t('Drag on the waveform to add a range. Drag a saved range or its edges to adjust it. Tracks describe intent, not separate editable media layers.') }}</p>
    <fieldset :disabled="!ready || !active">
      <legend>{{ t('Time range in seconds') }}</legend>
      <label>{{ t('Start time') }}<input v-model.number="start" type="number" min="0" :max="duration" step="0.01"></label>
      <label>{{ t('End time') }}<input v-model.number="end" type="number" min="0" :max="duration" step="0.01"></label>
      <label>{{ t('Intent track') }}<select v-model="track"><option value="audio">{{ t('Audio track') }}</option><option value="video">{{ t('Video track') }}</option><option value="subtitle">{{ t('Subtitle track') }}</option><option value="shot">{{ t('Shot track') }}</option></select></label>
      <button class="btn" :disabled="!valid" @click="add()">{{ t('Add time range') }}</button>
      <button class="btn" :disabled="!valid || !selectedId" @click="updateSelected">{{ t('Update selected range') }}</button>
    </fieldset>
    <ul class="ranges"><li v-for="target in visibleTargets" :key="target.id"><button class="btn" :aria-pressed="target.id === selectedId" @click="select(target)">{{ target.label }} <span v-if="target.selector.type === 'time-range'">· {{ target.selector.trackId }} · {{ target.selector.start.toFixed(2) }}–{{ target.selector.end.toFixed(2) }} s</span></button></li></ul>
  </section>
</template>

<style scoped>
.timeline-surface { padding: 18px; color: var(--c-text); border: 1px solid var(--c-border); border-radius: 12px; min-width: 0; }
.toolbar, fieldset { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 12px 0; }
fieldset { border: 1px solid var(--c-border); padding: 12px; border-radius: 8px; }
label { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
input[type=number] { width: 90px; } input, select { color: var(--c-text); background: var(--c-bg-muted); border: 1px solid var(--c-border); padding: 6px; border-radius: 6px; }
p { font-size: 13px; line-height: 1.6; color: var(--c-text-secondary); } .error { color: #d65b63; }
video { display: block; max-width: 100%; max-height: 300px; margin: 12px auto; } video.audio-only { display: none; }
.wave { margin: 12px 0; min-height: 120px; } .ranges { padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 8px; }.ranges [aria-pressed=true] { outline: 2px solid #529ad5; }
</style>
