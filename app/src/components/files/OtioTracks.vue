<template>
  <section class="tracks" :aria-label="t('Tracks')">
    <header class="heading"><h3>{{ t('Tracks') }}</h3>
      <HoverInfo :text="t('Fit')"><template #default="{ triggerProps }">
        <button v-bind="triggerProps" type="button" class="fit" :aria-label="t('Fit')" :disabled="window.span >= duration" @click="window = fitOtioWindow(duration)">
          <span class="i-lucide-maximize" aria-hidden="true" /> {{ Math.round(duration / (window.span || 1) * 100) }}%
        </button>
      </template></HoverInfo><span>{{ positionLabel }}</span></header>
    <div class="viewport" :style="{ '--playhead': playhead }" @wheel="onWheel">
      <div class="ruler-row">
        <div class="ruler-label" aria-hidden="true">{{ t('Timeline') }}</div>
        <div class="ruler" role="slider" :tabindex="maxFrame > 0 ? 0 : -1"
          :aria-label="t('Timeline position')" :aria-valuemin="0" :aria-valuemax="maxFrame"
          :aria-valuenow="currentFrame" :aria-valuetext="positionLabel" :aria-disabled="maxFrame === 0"
          @pointerdown="startScrub" @pointermove="moveScrub" @pointerup="endScrub"
          @pointercancel="cancelScrub" @lostpointercapture="cancelScrub" @keydown="onKey">
          <span v-for="(tick, i) in ticks" :key="i" class="tick" :class="{ minor: i % 2 }"
            :style="{ left: `${tick.left}%` }" aria-hidden="true"><span>{{ tick.text }}</span></span>
          <span class="playhead marker" aria-hidden="true" />
        </div>
      </div>
      <div v-for="lane in lanes" :key="lane.node.id" class="lane-row" :data-kind="lane.node.trackKind" :style="{ '--lane-hue': lane.hue }" :class="{ excluded: excluded(lane.node) }">
        <div class="lane-header">
        <button type="button" class="lane-label" :aria-current="lane.node.id === selectedId ? 'true' : undefined"
          @click="emit('select', lane.node.id)">
          <span class="lane-icon" :class="lane.node.trackKind === 'Audio' ? 'i-lucide-audio-lines' : 'i-lucide-film'" aria-hidden="true" />
          <span>{{ lane.node.name || itemKind(lane.node) }}<small v-if="lane.node.name">{{ itemKind(lane.node) }}</small></span>
        </button>
          <HoverInfo v-if="lane.node.trackKind === 'Video' || lane.node.trackKind === 'Audio'" :text="toggleLabel(lane.node)">
            <template #default="{ triggerProps }">
              <button v-bind="triggerProps" type="button" class="lane-toggle" :aria-label="toggleLabel(lane.node)" :aria-pressed="excluded(lane.node)" @click="emit('toggle', lane.node)">
                <span :class="toggleIcon(lane.node)" aria-hidden="true" />
              </button>
            </template>
          </HoverInfo>
        </div>
        <div class="lane">
          <span v-for="tick in ticks.slice(1, -1)" :key="tick.left" class="grid-line" :style="{ left: `${tick.left}%` }" aria-hidden="true" />
          <button v-for="item in lane.items" :key="item.id" type="button" class="block"
            :class="{ clip: item.kind === 'Clip', 'audio-clip': item.kind === 'Clip' && item.trackKind === 'Audio', gap: item.kind === 'Gap', transition: item.kind === 'Transition', muted: !item.enabled }"
            :style="blockStyle(item)" :aria-current="item.id === selectedId ? 'true' : undefined"
            :aria-label="item.name ? `${itemKind(item)}: ${item.name}` : itemKind(item)"
            @click="emit('select', item.id)"><span>{{ item.name || itemKind(item) }}</span>
            <svg v-if="waves.get(item.id)?.path" class="waveform" aria-hidden="true" focusable="false"
              :viewBox="`0 0 ${waves.get(item.id)?.bins} ${WAVE_HEIGHT}`" preserveAspectRatio="none">
              <path :d="waves.get(item.id)?.path" />
            </svg>
          </button>
          <span class="playhead" aria-hidden="true" />
        </div>
      </div>
      <div v-for="row in markerRows" :key="row.id" class="lane-row marker-row">
        <div class="ruler-label">{{ row.owner.name || itemKind(row.owner) }}</div>
        <div class="lane">
          <template v-for="mark in row.markers" :key="mark.id">
            <HoverInfo v-if="otioMarkerGeometry(mark, window)" :text="markerLabel(mark, row.owner)">
              <template #default="{ triggerProps }">
                <span v-bind="triggerProps" tabindex="0" role="note" class="otio-mark" :class="{ point: mark.point }"
                  :style="{ ...otioMarkerGeometry(mark, window), '--mark-color': otioMarkerColor(mark.color) }"
                  :aria-label="markerLabel(mark, row.owner)">{{ mark.name || '◆' }}</span>
              </template>
            </HoverInfo>
          </template>
          <span class="playhead" aria-hidden="true" />
        </div>
      </div>
      <p v-if="!lanes.length" class="empty">{{ t('No tracks') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, shallowReactive, watch } from 'vue'
import { fitOtioWindow, wheelOtioWindow } from '../../otio-viewport.ts'
import { t } from '../../i18n.ts'
import { otioMarkerColor, otioMarkerGeometry, otioMarkerRows } from '../../otio-markers.ts'
import type { OtioMarker, OtioModel, OtioNode } from '../../otio-model.ts'
import { lastOtioFrame, otioLanes, otioPercent, scrubOtioFrame } from '../../otio-navigation.ts'

import { otioAudioTracks } from '../../otio-audio.ts'
import { mediaPosition, type OtioMedium } from '../../otio-review.ts'
import { otioWavePath, readOtioWave, WAVE_HEIGHT } from '../../otio-waveform.ts'

import HoverInfo from '../HoverInfo.vue'

const props = defineProps<{ model: OtioModel; selectedId: string; frame: number; hidden?: ReadonlySet<string>; muted?: ReadonlySet<string>; waveMedia?: (node: OtioNode) => (OtioMedium & { url: string }) | null }>()
const emit = defineEmits<{ select: [id: string]; seek: [frame: number]; toggle: [node: OtioNode] }>()
function excluded(node: OtioNode) {
  return (node.trackKind === 'Audio' ? props.muted : props.hidden)?.has(node.id) ?? false
}
function toggleLabel(node: OtioNode) {
  const name = node.name || itemKind(node)
  return node.trackKind === 'Audio' ? t('Mute audio track: {name}', { name }) : t('Hide video track: {name}', { name })
}
function toggleIcon(node: OtioNode) {
  return node.trackKind === 'Audio' ? (excluded(node) ? 'i-lucide-volume-x' : 'i-lucide-volume-2')
    : (excluded(node) ? 'i-lucide-eye-off' : 'i-lucide-eye')
}
const markerRows = computed(() => otioMarkerRows(props.model))
function markerLabel(marker: OtioMarker, owner: OtioNode) {
  const range = marker.markedRange
  return `${marker.name || '◆'} · ${marker.color}\n${owner.name || itemKind(owner)}\n` +
    `${formatSeconds(marker.start)}–${formatSeconds(marker.end)}s\n` +
    `${range.start.value}/${range.start.rate} + ${range.duration.value}/${range.duration.rate}s` +
    (marker.comment ? `\n${marker.comment}` : '')
}
const duration = computed(() => props.model.duration)
const rate = computed(() => props.model.rate)
const maxFrame = computed(() => lastOtioFrame(duration.value, rate.value))
const currentFrame = computed(() => Math.max(0, Math.min(maxFrame.value, Math.round(props.frame))))
const seconds = computed(() => rate.value > 0 ? props.frame / rate.value : 0)
const window = ref(fitOtioWindow(duration.value))
watch(() => props.model, () => { window.value = fitOtioWindow(duration.value) })
function percent(time: number) { return window.value.span > 0 ? (time - window.value.start) / window.value.span * 100 : 0 }
const playhead = computed(() => `${percent(seconds.value)}%`)
function onWheel(event: WheelEvent) {
  if (!duration.value || pointer !== undefined) return
  const target = event.target as HTMLElement
  const lane = target.closest<HTMLElement>('.lane')
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1
  const delta = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * scale
  if (!delta) return
  const rect = lane?.getBoundingClientRect()
  event.preventDefault()
  event.stopPropagation()
  window.value = wheelOtioWindow(window.value, duration.value, rate.value, delta,
    rect?.width ? (event.clientX - rect.left) / rect.width : null)
}
const positionLabel = computed(() => t('Frame {frame} · {seconds}s', { frame: currentFrame.value, seconds: formatSeconds(seconds.value) }))
const lanes = computed(() => {
  let video = 0, audio = 0
  const videoHues = [250, 305, 55, 215], audioHues = [155, 190, 85, 125]
  return otioLanes(props.model).map(lane => ({
    ...lane,
    hue: lane.node.trackKind === 'Video' ? videoHues[video++ % videoHues.length]
      : lane.node.trackKind === 'Audio' ? audioHues[audio++ % audioHues.length] : undefined,
    items: lane.items.filter(node => otioPercent(node.end, duration.value) > otioPercent(node.start, duration.value)),
  }))
})
const waveSources = computed(() => {
  const groups = new Map<string, OtioNode[]>()
  if (!props.waveMedia) return groups
  for (const { node } of otioAudioTracks(props.model).clips) {
    if (node.end <= node.start) continue
    const media = props.waveMedia(node)
    if (media?.kind !== 'audio' || !/\.wav$/i.test(media.path)) continue
    const group = groups.get(media.url)
    if (group) group.push(node)
    else groups.set(media.url, [node])
  }
  return groups
})
const waves = shallowReactive(new Map<string, { bins: number; path: string; url: string }>())
type Wave = Awaited<ReturnType<typeof readOtioWave>>
const waveCache = new Map<string, Wave>()
watch(() => props.model, () => { waveCache.clear(); waves.clear() }, { flush: 'sync' })
watch(waveSources, async (groups, _, cleanup) => {
  if (!groups.size) return
  const abort = new AbortController()
  cleanup(() => abort.abort())
  // One bounded request at a time; clips sharing a URL share its decoded index.
  for (const [url, clips] of groups) {
    if (abort.signal.aborted) break
    if (clips.every(node => waves.get(node.id)?.url === url)) continue
    const wave = waveCache.has(url) ? waveCache.get(url) ?? null
      : await readOtioWave(url, abort.signal).catch(() => null)
    if (abort.signal.aborted) break
    waveCache.delete(url)
    waveCache.set(url, wave)
    if (waveCache.size > 4) waveCache.delete(waveCache.keys().next().value!)
    for (const node of clips) {
      const start = mediaPosition(node, node.start), span = node.end - node.start
      const bins = Math.max(8, Math.min(256, Math.ceil(640 * span / duration.value)))
      const path = wave && start !== null && Number.isFinite(start) ? otioWavePath(wave.peaks(start, span, bins)) : ''
      waves.set(node.id, { bins, path, url })
    }
  }
}, { immediate: true })
const ticks = computed(() => Array.from({ length: duration.value > 0 ? 5 : 1 }, (_, i) => ({
  left: i * 25, text: formatSeconds(window.value.start + window.value.span * i / 4),
})))
function formatSeconds(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3, useGrouping: false })
}
function itemKind(node: OtioNode) {
  switch (node.kind) {
    case 'Track': return node.trackKind === 'Audio' ? t('Audio') : node.trackKind === 'Video' ? t('Video') : node.trackKind || t('Track')
    case 'Clip': return t('Clip')
    case 'Gap': return t('Gap')
    case 'Transition': return t('Transition')
    case 'Stack': return t('Stack')
    case 'Timeline': return t('Timeline')
    default: return node.kind
  }
}
function blockStyle(node: OtioNode) {
  const left = percent(node.start)
  return { left: `${left}%`, width: `${percent(node.end) - left}%` }
}
let pointer: number | undefined
let lastSent: number | undefined
function scrub(event: PointerEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  if (!rect.width) return
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const time = window.value.start + ratio * window.value.span
  const frame = scrubOtioFrame(duration.value > 0 ? time / duration.value : 0, duration.value, rate.value)
  if (frame !== lastSent) {
    lastSent = frame
    emit('seek', frame)
  }
}
function startScrub(event: PointerEvent) {
  if (!maxFrame.value || event.button !== 0 || pointer !== undefined) return
  const ruler = event.currentTarget as HTMLElement
  pointer = event.pointerId
  lastSent = undefined
  ruler.focus({ preventScroll: true })
  ruler.setPointerCapture(event.pointerId)
  scrub(event)
}
function moveScrub(event: PointerEvent) { if (pointer === event.pointerId) scrub(event) }
function cancelScrub(event: PointerEvent) { if (pointer === event.pointerId) pointer = undefined }
function endScrub(event: PointerEvent) {
  if (pointer !== event.pointerId) return
  scrub(event)
  cancelScrub(event)
}
function onKey(event: KeyboardEvent) {
  const current = currentFrame.value
  const step = Math.max(1, Math.round(rate.value))
  let frame: number
  switch (event.key) {
    case 'ArrowRight': case 'ArrowUp': frame = current + 1; break
    case 'ArrowLeft': case 'ArrowDown': frame = current - 1; break
    case 'PageUp': frame = current + step; break
    case 'PageDown': frame = current - step; break
    case 'Home': frame = 0; break
    case 'End': frame = maxFrame.value; break
    default: return
  }
  event.preventDefault()
  event.stopPropagation()
  emit('seek', Math.max(0, Math.min(maxFrame.value, frame)))
}
</script>

<style scoped>
.marker-row { min-height: 28px; }
.otio-mark { position: absolute; top: 4px; height: 20px; box-sizing: border-box; border-inline-start: 2px solid var(--mark-color); border-block-start: 3px solid var(--mark-color); background: var(--c-bg-soft); color: var(--c-text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; }
.otio-mark.point { overflow: visible; font-size: 0; }
.otio-mark.point::after { content: ''; position: absolute; top: -3px; left: -4px; width: 7px; height: 7px; background: var(--mark-color); transform: rotate(45deg); }
.otio-mark:focus-visible { outline: 2px solid var(--c-primary); outline-offset: -2px; z-index: 2; }
.tracks { display: flex; flex-direction: column; min-width: 0; min-height: 0; max-height: 100%; background: var(--c-bg-card); color: var(--c-text); }
.heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 12px; padding: 8px 10px; background: var(--c-bg-soft); border-block-end: 1px solid var(--c-border); }
h3 { margin: 0; font-size: 12px; font-weight: 650; }
.heading span, .ruler-row { color: var(--c-text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.viewport { overflow: auto; min-height: 0; container-type: inline-size; padding-bottom: 32px; overscroll-behavior: contain; }
.fit { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; padding: 2px 6px; }
.fit:disabled { cursor: default; opacity: .55; }
.lane-row, .ruler-row { display: grid; grid-template-columns: minmax(0, clamp(46px, 24%, 142px)) minmax(0, 1fr); min-width: 0; border-block-end: 1px solid var(--c-border); }
.ruler-row { position: sticky; inset-block-start: 0; z-index: 4; background: var(--c-bg-soft); }
.ruler-label { padding: 7px 6px; align-self: center; overflow-wrap: anywhere; }
.ruler, .lane { margin-inline-end: 6px; position: relative; direction: ltr; }
.ruler { overflow: hidden; min-height: 32px; border-left: 1px solid var(--c-border); touch-action: none; user-select: none; cursor: ew-resize; }
.ruler[aria-disabled="true"] { cursor: default; }
.tick, .grid-line, .playhead { position: absolute; pointer-events: none; }
.tick { bottom: 0; height: 7px; border-left: 1px solid var(--c-control-border); }
.tick span { position: absolute; inset-block-end: 9px; transform: translateX(-50%); white-space: nowrap; }
.tick:first-child span { transform: none; margin-inline-start: 3px; }
.tick:nth-child(5) span { transform: translateX(-100%); }
.grid-line { inset-block: 0; border-left: 1px solid var(--c-border-soft); }
.playhead { inset-block: 0; left: var(--playhead); z-index: 3; border-left: 1px solid var(--c-primary); }
.marker::after { content: ''; position: absolute; bottom: 0; left: -4px; border-inline: 3px solid transparent; border-bottom: 5px solid var(--c-primary); }
.lane-row { min-height: 37px; content-visibility: auto; }
.lane-header { display: flex; min-width: 0; }
.lane-toggle { flex: 0 0 28px; display: grid; place-items: center; }
.lane-toggle[aria-pressed="true"] { background: var(--c-bg-muted); }
.lane-row:is([data-kind="Video"], [data-kind="Audio"]) {
  --track-accent: oklch(from var(--c-primary) l .14 var(--lane-hue));
  background: color-mix(in srgb, var(--track-accent) 20%, var(--c-bg-card));
}
.lane-row .lane { background: transparent; }

.lane-label small { display: block; color: var(--c-text-secondary); }
.lane-label { flex: 1; display: flex; align-items: center; gap: 4px; padding: 4px 5px; text-align: start; }
.lane-label span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lane-icon { flex: 0 0 12px; }
.lane { overflow: hidden; border-left: 1px solid var(--c-border); background: var(--c-bg-soft); }
button { min-width: 0; border: 0; border-radius: 0; color: inherit; background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
button:hover { background-color: var(--c-bg-muted); }
button:focus-visible, .ruler:focus-visible { outline: 2px solid var(--c-primary); outline-offset: -2px; }
.block { position: absolute; top: 4px; height: 22px; overflow: hidden; padding: 0; text-align: start; background: var(--c-bg-muted); box-shadow: inset 0 0 0 1px var(--c-control-border); }
.block span { display: block; max-width: 100%; padding: 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.block.clip { background: color-mix(in srgb, var(--track-accent, var(--c-control-border)) 40%, var(--c-bg-card)); }
.block.audio-clip { height: 31px; display: flex; flex-direction: column; }
.block.audio-clip > span { flex: 0 0 14px; line-height: 14px; }
.waveform { display: block; width: 100%; height: 14px; flex: none; pointer-events: none; }
.waveform path { stroke: currentColor; stroke-width: 1; fill: none; }
.excluded .block.clip, .block.clip.muted { border: 1px dashed var(--c-control-border); box-shadow: none; }
.excluded .waveform, .muted .waveform { opacity: .55; }
.block:hover { box-shadow: inset 0 0 0 1px var(--c-text); }
.block.gap { background: transparent; box-shadow: none; outline: 1px dashed var(--c-control-border); outline-offset: -1px; color: var(--c-text-secondary); }
.block.transition { z-index: 1; top: auto; bottom: 3px; height: 12px; line-height: 12px; font-size: 9px; background: repeating-linear-gradient(135deg, var(--c-bg-muted) 0 3px, var(--c-bg-card) 3px 6px); }

.block[aria-current="true"], .lane-label[aria-current="true"] { background: var(--c-selection-bg); color: var(--c-primary); box-shadow: inset 0 0 0 1px var(--c-selection-border); }
.block.clip[aria-current="true"] {
  background: color-mix(in srgb, var(--track-accent, var(--c-primary)) 42%, var(--c-bg-card));
  color: var(--c-text);
  box-shadow: inset 0 0 0 2px var(--c-primary);
}
.block.gap[aria-current="true"] { outline-color: var(--c-primary); }
.block.transition[aria-current="true"] { background: repeating-linear-gradient(135deg, var(--c-selection-bg) 0 3px, var(--c-bg-card) 3px 6px); }
.block:focus-visible { z-index: 2; outline: 2px solid var(--c-primary); outline-offset: -2px; }
.empty { margin: 0; padding: 10px; color: var(--c-text-secondary); font-size: 12px; }
@container (max-width: 360px) { .tick.minor span { display: none; } }
@container (max-width: 210px) { .tick:not(:first-child):not(:nth-child(5)) span { display: none; } }
@container (max-width: 360px) { .ruler { min-height: 44px; } }
@media (pointer: coarse) { .ruler { min-height: 44px; } .lane-row { min-height: 48px; } .block { height: 29px; } .block.transition { height: 15px; line-height: 15px; } }
</style>
