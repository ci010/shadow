<template>
  <div ref="root" class="media-player" :class="`media-player-${kind}`" role="group" :aria-label="label">
    <component :is="kind" :ref="setMedia" v-mobile-media="mobileSource" :src="src" :aria-label="label"
      :autoplay="autoplay" :preload="preload" playsinline
      @play="sync" @pause="sync" @ended="sync" @emptied="sync" @timeupdate="sync" @durationchange="sync" @volumechange="sync"
      @loadedmetadata="metadata" @error="mediaError" />
    <HoverInfo v-if="kind === 'video' && paused" :text="t('Play')" v-slot="{ triggerProps }">
      <button v-bind="triggerProps" type="button" class="media-center media-button" :aria-label="t('Play')" @click="togglePlay"><span class="i-lucide-play" aria-hidden="true" /></button>
    </HoverInfo>
    <div class="media-controls">
      <input class="media-seek" type="range" min="0" :max="duration || 0" step="0.1" :value="position" :disabled="!duration" :aria-label="t('Seek')" :aria-valuetext="formatTime(position) + ' / ' + formatTime(duration)" @input="seek" />
      <div class="media-toolbar">
        <HoverInfo :text="paused ? t('Play') : t('Pause')" v-slot="{ triggerProps }">
          <button v-bind="triggerProps" type="button" class="media-button" :aria-label="paused ? t('Play') : t('Pause')" @click="togglePlay"><span :class="paused ? 'i-lucide-play' : 'i-lucide-pause'" aria-hidden="true" /></button>
        </HoverInfo>
        <HoverInfo :text="muted ? t('Unmute') : t('Mute')" v-slot="{ triggerProps }">
          <button v-bind="triggerProps" type="button" class="media-button" :aria-label="muted ? t('Unmute') : t('Mute')" @click="toggleMute"><span :class="muted || !volume ? 'i-lucide-volume-x' : 'i-lucide-volume-2'" aria-hidden="true" /></button>
        </HoverInfo>
        <input class="media-volume" type="range" min="0" max="1" step="0.05" :value="muted ? 0 : volume" :aria-label="t('Volume')" @input="setVolume" />
        <span class="media-time">{{ formatTime(position) }} / {{ formatTime(duration) }}</span>
        <HoverInfo v-if="kind === 'video'" :text="isFullscreen ? t('Exit fullscreen') : t('Fullscreen')" v-slot="{ triggerProps }">
          <button v-bind="triggerProps" type="button" class="media-button media-fullscreen" :aria-label="isFullscreen ? t('Exit fullscreen') : t('Fullscreen')" @click="toggleFullscreen"><span :class="isFullscreen ? 'i-lucide-minimize' : 'i-lucide-maximize'" aria-hidden="true" /></button>
        </HoverInfo>
      </div>
    </div>
    <p v-if="error" class="media-error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n.ts'
import { vMobileMedia } from '../mobile-resources.ts'
import HoverInfo from './HoverInfo.vue'
withDefaults(defineProps<{ kind: 'audio' | 'video'; src?: string; label?: string; mobileSource?: string; autoplay?: boolean; preload?: 'none' | 'metadata' | 'auto' }>(), { preload: 'metadata', autoplay: false })
const emit = defineEmits<{ element: [element: HTMLMediaElement | null]; loadedmetadata: [event: Event]; error: [event: Event]; fullscreenchange: [fullscreen: boolean] }>()
const root = ref<HTMLElement>()
let media: HTMLMediaElement | null = null
const paused = ref(true), position = ref(0), duration = ref(0), volume = ref(1), muted = ref(false), isFullscreen = ref(false), error = ref('')
function setMedia(element: unknown) {
  media = element as HTMLMediaElement | null
  emit('element', media)
  sync()
}
function sync() {
  if (!media) return
  paused.value = media.paused
  position.value = Number.isFinite(media.currentTime) ? media.currentTime : 0
  duration.value = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0
  volume.value = media.volume
  muted.value = media.muted
}
function metadata(event: Event) { error.value = ''; emit('loadedmetadata', event); sync() }
function mediaError(event: Event) { error.value = t('Could not play media. Try again or download the file.'); sync(); emit('error', event) }
async function togglePlay() {
  if (!media) return
  error.value = ''
  if (!media.paused) { media.pause(); return }
  try { await media.play() } catch { error.value = t('Could not play media. Try again or download the file.') }
}
function seek(event: Event) {
  if (media && duration.value) { media.currentTime = Math.min(duration.value, Math.max(0, Number((event.target as HTMLInputElement).value))); sync() }
}
function setVolume(event: Event) {
  if (!media) return
  media.volume = Math.min(1, Math.max(0, Number((event.target as HTMLInputElement).value)))
  media.muted = false
  sync()
}
function toggleMute() { if (media) { media.muted = !media.muted; sync() } }
function formatTime(value: number) {
  const seconds = Math.max(0, Math.floor(value))
  const hours = Math.floor(seconds / 3600)
  return `${hours ? hours + ':' : ''}${hours ? String(Math.floor(seconds / 60) % 60).padStart(2, '0') : Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
function fullscreenChanged() {
  isFullscreen.value = !!root.value && root.value.ownerDocument.fullscreenElement === root.value
  emit('fullscreenchange', isFullscreen.value)
}
async function toggleFullscreen() {
  error.value = ''
  try {
    if (root.value?.ownerDocument.fullscreenElement === root.value) await root.value?.ownerDocument.exitFullscreen()
    else if (root.value?.requestFullscreen) await root.value.requestFullscreen()
    else {
      const native = media as HTMLVideoElement & { webkitEnterFullscreen?: () => void } | null
      if (!native?.webkitEnterFullscreen) throw new Error()
      native.webkitEnterFullscreen()
    }
  } catch { error.value = t('Could not enter fullscreen.') }
}
onMounted(() => root.value?.ownerDocument.addEventListener('fullscreenchange', fullscreenChanged))
onBeforeUnmount(() => { root.value?.ownerDocument.removeEventListener('fullscreenchange', fullscreenChanged); media?.pause() })
defineExpose({ get element() { return media }, toggleFullscreen })
</script>

<style scoped>
.media-player { display: flex; flex-direction: column; position: relative; width: 100%; min-width: 0; overflow: hidden; background: #141414; color: #fff; border-radius: 0; color-scheme: dark; }
.media-player video { min-height: 0; display: block; width: 100%; max-height: min(60vh, 640px); aspect-ratio: 16 / 9; object-fit: contain; background: #000; }
.media-player audio { display: none; }
.media-controls { flex-shrink: 0; position: relative; padding: 0 8px; background: #141414; }
.media-player-video .media-controls { position: absolute; inset: auto 0 0; background: linear-gradient(transparent, rgb(0 0 0 / 90%)); }
.media-player-video .media-error { position: absolute; inset: 0 0 auto; box-sizing: border-box; background: #141414; }
.media-toolbar { display: flex; align-items: center; min-width: 0; gap: 0; }
.media-button { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 0; color: #fff; background: transparent; cursor: pointer; }
.media-button span { display: block; width: 20px; height: 20px; }
.media-button:hover { background: #353535; }
.media-center { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 64px; height: 64px; background: rgb(20 20 20 / 75%); }
.media-center span { width: 32px; height: 32px; }
.media-time { min-width: 0; margin-left: 8px; white-space: nowrap; font-size: 12px; font-variant-numeric: tabular-nums; }
.media-fullscreen { margin-left: auto; }
.media-player input[type='range'] { display: block; appearance: none; height: 44px; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; accent-color: white; cursor: pointer; }
.media-seek { width: 100%; }
.media-volume { width: 64px; min-width: 44px; flex-shrink: 1; }
.media-player input::-webkit-slider-runnable-track { height: 2px; background: #888; }
.media-player input::-moz-range-track { height: 2px; background: #888; }
.media-player input::-webkit-slider-thumb { appearance: none; width: 10px; height: 10px; margin-top: -4px; background: #fff; border: 0; border-radius: 0; }
.media-player input::-moz-range-thumb { width: 10px; height: 10px; background: #fff; border: 0; border-radius: 0; }
.media-player :is(button,input):focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
.media-player input:disabled { opacity: .4; cursor: default; }
.media-error { padding: 8px 12px; margin: 0; font-size: 12px; }
.media-player:fullscreen { display: flex; flex-direction: column; justify-content: center; width: 100vw; height: 100vh; }
.media-player:fullscreen video { flex: 1; min-height: 0; max-height: none; }
@media (max-width: 360px) { .media-volume { width: 44px; } .media-time { font-size: 11px; margin-left: 2px; } .media-controls { padding: 0 4px; } }
</style>
