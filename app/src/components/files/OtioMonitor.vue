<template>
  <div class="otio-monitor" role="region" :aria-label="label">
    <video v-if="identity && mediaKind === 'video'" :key="identity" ref="video"
      :class="{ 'picture-hidden': state !== 'ready' }" :aria-hidden="state !== 'ready'" :aria-label="label"
      crossorigin="anonymous" :src="sourceUrl" :muted="muted" playsinline preload="auto"
      @loadedmetadata="onVideoEvent" @loadeddata="onVideoEvent" @durationchange="onVideoEvent"
      @canplay="onVideoEvent" @seeking="onVideoEvent" @seeked="onVideoEvent" @waiting="onVideoEvent" @playing="onVideoEvent"
      @ended="onVideoEvent" @error="onVideoEvent" />
    <img v-else-if="identity && mediaKind === 'image'" :key="identity" ref="image"
      :class="{ 'picture-hidden': state !== 'ready' }" :alt="label"
      crossorigin="anonymous" :src="sourceUrl" referrerpolicy="no-referrer"
      @load="onImageEvent" @error="onImageEvent" />
    <p v-if="status" class="monitor-status" role="status">{{ status }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { t } from '../../i18n.ts'
import { useMobileResources } from '../../mobile-resources.ts'
import { annotationSizeError } from '../../image-annotation.ts'
import {
  atRequestedPosition, exportMonitorPicture, PLAYBACK_DRIFT_SECONDS, SEEK_TIMEOUT_MS, validMediaPosition, withinMediaDuration,
} from '../../otio-monitor.ts'

const props = withDefaults(defineProps<{
  pictureKey: string
  url: string | null
  mediaKind: 'video' | 'image' | null
  sourceSeconds: number | null
  playing: boolean
  active: boolean
  label: string
  unavailable: string
  muted?: boolean
}>(), { muted: true })
const emit = defineEmits<{ 'capture-ready': [boolean] }>()
const resources = useMobileResources()
const pageVisible = ref(typeof document === 'undefined' || !document.hidden)
const paneMounted = ref(true)
const active = computed(() => props.active && pageVisible.value && paneMounted.value)
const sourceUrl = computed(() => active.value && props.mediaKind ? resources.resolve(props.url) : undefined)
// Remount even when adjacent clips share a URL. An old decoder/event cannot publish a frame for the next clip.
const identity = computed(() => sourceUrl.value ? JSON.stringify([props.pictureKey, props.mediaKind, sourceUrl.value]) : '')
const video = ref<HTMLVideoElement>()
const image = ref<HTMLImageElement>()
const state = ref<'empty' | 'waiting' | 'ready' | 'range' | 'error'>('empty')
const terminalError = ref(false)
const imageLoaded = ref(false)
const liveElement = ref<HTMLVideoElement | HTMLImageElement>()
let seek: { target: number; resume: boolean } | undefined
let presentationNotBefore = 0
let seekTimer: ReturnType<typeof setTimeout> | undefined
let failedSeek: number | undefined
let synchronized = false
let buffering = false
let pendingPlay: HTMLVideoElement | undefined
let captureRequest: AbortController | undefined
let frameRequest: number | undefined
let frameElement: HTMLVideoElement | undefined
const presentedTime = ref<number | null>(null)

const status = computed(() => {
  switch (state.value) {
    case 'ready': return ''
    case 'empty': return props.unavailable
    case 'waiting': return t('Waiting for picture…')
    case 'range': return t('This position is outside the available media.')
    case 'error': return t('This picture could not be played or decoded.')
  }
})
function currentPicture() {
  if (!active.value || !identity.value || props.playing || state.value !== 'ready') return null
  const movie = video.value
  if (movie && movie === liveElement.value && validMediaPosition(props.sourceSeconds) && movie.paused && !movie.seeking
    && movie.readyState >= 2 && atRequestedPosition(movie.currentTime, props.sourceSeconds)) {
    return { source: movie, width: movie.videoWidth, height: movie.videoHeight }
  }
  const still = image.value
  return still && still === liveElement.value ? { source: still, width: still.naturalWidth, height: still.naturalHeight } : null
}
const captureReady = computed(() => {
  const picture = currentPicture()
  return !!picture && !annotationSizeError(0, picture.width, picture.height)
})
watch(captureReady, (value) => emit('capture-ready', value), { immediate: true, flush: 'sync' })

function stopObservingFrame() {
  if (frameRequest !== undefined) frameElement?.cancelVideoFrameCallback?.(frameRequest)
  frameRequest = undefined
  frameElement = undefined
  presentedTime.value = null
}

function observePausedFrame(movie: HTMLVideoElement) {
  if (frameRequest !== undefined || presentedTime.value !== null || !movie.requestVideoFrameCallback || !movie.paused) return
  const requested = props.sourceSeconds
  const notBefore = presentationNotBefore
  const id = movie.requestVideoFrameCallback((_now, metadata) => {
    if (frameRequest !== id || frameElement !== movie) return
    frameRequest = undefined
    frameElement = undefined
    // The compositor callback can precede `seeked`. It must nonetheless be
    // a newly submitted frame and the media element must have settled at the target.
    if (movie !== liveElement.value || !active.value || props.playing || !movie.paused
      || !validMediaPosition(requested) || requested !== props.sourceSeconds) return
    if (!movie.seeking && metadata.presentationTime >= notBefore && atRequestedPosition(movie.currentTime, requested)
      && withinMediaDuration(metadata.mediaTime, movie.duration)) {
      presentedTime.value = metadata.mediaTime
    } else if (seek) {
      observePausedFrame(movie)
    }
  })
  frameElement = movie
  frameRequest = id
}

function clearSeek() {
  clearTimeout(seekTimer)
  seekTimer = undefined
  seek = undefined
}

function startSeek(movie: HTMLVideoElement, target: number) {
  movie.pause()
  stopObservingFrame()
  clearSeek()
  const attempt = { target, resume: props.playing }
  presentationNotBefore = performance.now()
  seek = attempt
  state.value = 'waiting'
  try { movie.currentTime = target } catch {
    clearSeek()
    failedSeek = target
    state.value = 'error'
    return
  }
  if (!props.playing) observePausedFrame(movie)
  seekTimer = setTimeout(() => {
    if (seek !== attempt) return
    clearSeek()
    stopObservingFrame()
    failedSeek = props.sourceSeconds ?? target
    state.value = 'error'
  }, SEEK_TIMEOUT_MS)
}

function syncPicture() {
  if (!active.value || !props.mediaKind || !props.url) { state.value = 'empty'; return }
  if (!sourceUrl.value) { state.value = 'waiting'; return }
  if (terminalError.value) { state.value = 'error'; return }
  if (props.mediaKind === 'image') { state.value = imageLoaded.value ? 'ready' : 'waiting'; return }
  const movie = video.value === liveElement.value ? video.value : undefined
  const target = props.sourceSeconds
  if (!validMediaPosition(target) || (movie && movie.readyState >= 1 && !withinMediaDuration(target, movie.duration))) {
    movie?.pause()
    clearSeek()
    stopObservingFrame()
    state.value = 'range'
    return
  }
  if (!movie || movie.readyState < 1) { state.value = 'waiting'; return }
  if (movie.readyState >= 2 && (!movie.videoWidth || !movie.videoHeight)) {
    movie.pause()
    state.value = 'error'
    return
  }
  if (!props.playing) movie.pause()
  if (failedSeek !== undefined) {
    if (props.playing || atRequestedPosition(failedSeek, target)) { state.value = 'error'; return }
    failedSeek = undefined
  }
  if (seek && (seek.resume !== props.playing || (!props.playing && !atRequestedPosition(seek.target, target)))) {
    clearSeek()
    // Supersede the old seek even if the clock currently reads the new target.
    startSeek(movie, target)
    return
  }
  if (seek || movie.seeking) { state.value = 'waiting'; return }
  const aligned = props.playing && synchronized
    ? Math.abs(movie.currentTime - target) <= PLAYBACK_DRIFT_SECONDS
    : atRequestedPosition(movie.currentTime, target)
  if (!aligned || movie.ended) { startSeek(movie, target); return }
  synchronized = true
  state.value = movie.readyState >= 2 && (!props.playing || !buffering) ? 'ready' : 'waiting'
  if (!props.playing) {
    observePausedFrame(movie)
    return
  }
  if (movie.readyState >= 2 && movie.paused && pendingPlay !== movie) {
    pendingPlay = movie
    void movie.play().catch((error: unknown) => {
      if (movie === liveElement.value && active.value && props.playing && !(error instanceof DOMException && error.name === 'AbortError')) {
        terminalError.value = true
        state.value = 'error'
      }
    }).finally(() => { if (pendingPlay === movie) pendingPlay = undefined })
  }
}

function onVideoEvent(event: Event) {
  const movie = video.value
  if (!movie || event.currentTarget !== movie || movie !== liveElement.value) return
  if (event.type === 'error') {
    clearSeek()
    stopObservingFrame()
    terminalError.value = true
    captureRequest?.abort()
  } else if (event.type === 'seeked' && seek && !movie.seeking) {
    const completed = seek
    clearSeek()
    if (atRequestedPosition(movie.currentTime, completed.target)) synchronized = true
    else {
      stopObservingFrame()
      failedSeek = completed.target
    }
  }
  if (event.type === 'waiting') buffering = true
  if (event.type === 'playing' || event.type === 'canplay') buffering = false
  syncPicture()
}

function onImageEvent(event: Event) {
  if (event.currentTarget !== image.value || image.value !== liveElement.value) return
  imageLoaded.value = event.type === 'load'
  terminalError.value = !imageLoaded.value
  if (terminalError.value) captureRequest?.abort()
  syncPicture()
}

function releasePicture() {
  captureRequest?.abort()
  stopObservingFrame()
  clearSeek()
  const current = liveElement.value
  liveElement.value = undefined
  if (current && current instanceof HTMLVideoElement) {
    current.pause()
    current.removeAttribute('src')
    current.load()
  } else current?.removeAttribute('src')
  failedSeek = undefined
  synchronized = buffering = false
  presentationNotBefore = 0
  terminalError.value = false
  imageLoaded.value = false
  state.value = 'empty'
}

watch([identity, active, () => props.url, () => props.mediaKind], ([key], [previousKey]) => {
  if (key !== previousKey) releasePicture()
  syncPicture()
}, { immediate: true, flush: 'sync' })
watch([video, image], () => {
  if (!identity.value) return
  liveElement.value = video.value ?? image.value
  if (image.value?.complete) {
    imageLoaded.value = image.value.naturalWidth > 0
    terminalError.value = !imageLoaded.value
  }
  syncPicture()
}, { flush: 'post' })
watch([() => props.playing, () => props.sourceSeconds], () => {
  captureRequest?.abort()
  stopObservingFrame()
  syncPicture()
}, { flush: 'sync' })

watch([() => props.label, () => props.unavailable], () => captureRequest?.abort(), { flush: 'sync' })

function visibilityChanged() { pageVisible.value = !document.hidden }
onMounted(() => { visibilityChanged(); document.addEventListener('visibilitychange', visibilityChanged) })
onActivated(() => { paneMounted.value = true })
onDeactivated(() => { paneMounted.value = false })
onBeforeUnmount(() => {
  releasePicture()
  document.removeEventListener('visibilitychange', visibilityChanged)
})

function waitForCapture(signal: AbortSignal): Promise<void> {
  if (captureReady.value) return Promise.resolve()
  return new Promise((resolve, reject) => {
    function finish(error?: unknown) {
      stop()
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    function abort() { finish(signal.reason) }
    const stop = watch(state, (next) => {
      if (next === 'ready') finish()
      else if (next === 'range' || next === 'error') finish(new Error(t('The current picture could not be captured.')))
    }, { flush: 'post' })
    const timer = setTimeout(() => finish(new Error(t('The current picture could not be captured.'))), SEEK_TIMEOUT_MS)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function waitForPresentation(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    function finish() {
      stop()
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const stop = watch(presentedTime, finish)
    // `seeked` can arrive just before the compositor callback. Some browsers
    // never report an already-paused frame; don't make capture depend on it.
    const timer = setTimeout(finish, 100)
    signal.addEventListener('abort', finish, { once: true })
  })
}

async function capture(): Promise<{ file: File; mediaSeconds: number | null }> {
  const failure = () => new Error(t('The current picture could not be captured.'))
  if (!active.value || !identity.value || props.playing || terminalError.value) throw failure()
  captureRequest?.abort()
  const request = new AbortController()
  captureRequest = request
  try {
    syncPicture()
    if (state.value === 'range' || state.value === 'error') throw failure()
    if (state.value !== 'ready') await waitForCapture(request.signal)
    request.signal.throwIfAborted()
    if (frameRequest !== undefined && presentedTime.value === null) await waitForPresentation(request.signal)
    request.signal.throwIfAborted()
    const picture = currentPicture()
    if (!picture) throw failure()
    // Timeline offset is a seek request, not the timestamp of a decoded frame.
    // Only compositor metadata can supply a presented PTS; browsers may not report one for a paused frame.
    const mediaSeconds = picture.source === video.value ? presentedTime.value : null
    const file = await exportMonitorPicture(picture.source, picture.width, picture.height, request.signal)
    request.signal.throwIfAborted()
    return { file, mediaSeconds }
  } finally {
    if (captureRequest === request) captureRequest = undefined
  }
}

defineExpose({ capture })
</script>

<style scoped>
.otio-monitor {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  min-width: 0;
  min-height: 0;
  height: clamp(8rem, 27dvh, 23rem);
  overflow: hidden;
  border: 1px solid var(--c-border);
  background: var(--c-bg-muted);
}
.otio-monitor video, .otio-monitor img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.picture-hidden { visibility: hidden; }
.monitor-status {
  margin: 0;
  padding: 0.75rem;
  color: var(--c-text-secondary);
  font-size: 0.8rem;
  text-align: center;
  overflow-wrap: anywhere;
}
</style>
