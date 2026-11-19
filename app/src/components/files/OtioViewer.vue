<template>
  <section class="otio" :aria-label="t('OpenTimelineIO viewer')">
    <div v-if="!review" class="compact-tabs" role="group" :aria-label="t('Review panels')">
      <button v-for="panel in panels.filter(item => !board || item.id !== 'outline')" :key="panel.id" type="button" :aria-pressed="compact === panel.id" @click="pause(); compact = panel.id">{{ t(board && panel.id === 'monitor' ? 'Storyboard' : panel.label) }}</button>
    </div>
    <div class="bench" :class="{ reviewing: review }" :data-panel="compact">
      <OtioOutline v-if="!review && !board" class="outline-pane" :model="model" :selected-id="selected.id" @select="select" />
      <section class="monitor-pane" :class="{ 'storyboard-pane': board && !review }" :aria-label="t(board ? 'Storyboard' : 'Picture monitor')">
        <header class="panel-bar">
          <h3 v-if="review?.capture">{{ t('Frozen frame') }}</h3>
          <div v-else class="modes viewer-modes" role="group" :aria-label="t('Picture view')">
            <button type="button" :aria-pressed="!board" :disabled="locked" @click="showBoard(false)">{{ t('Monitor') }}</button>
            <button type="button" :aria-pressed="board" :disabled="locked" @click="showBoard(true)">{{ t('Storyboard') }}</button>
          </div>
          <span v-if="review?.capture" class="readout">{{ t('Frame {frame}', { frame: format(frame) }) }} · {{ t('{rate} fps', { rate: format(model.rate) }) }}</span>
          <div v-if="(canSolo || videoTrack) && !review && !board" class="modes" role="group" :aria-label="t('Monitor source')">
            <button type="button" :aria-pressed="mode === 'timeline'" @click="setMode('timeline')">{{ t('Timeline') }}</button>
            <button v-if="videoTrack" type="button" :aria-pressed="mode === 'track'" @click="setMode('track')">{{ t('Solo video track') }}</button>
            <button v-if="canSolo" type="button" :aria-pressed="mode === 'clip'" @click="setMode('clip')">{{ t('Clip source') }}</button>
          </div>
        </header>
        <OtioStoryboard v-if="boardOpened" v-show="board" class="storyboard-content" :model="model" :source="source" :api-base="apiBase" :active="active && board"
          :track="videoTrack" :media-for="mediaFor" :unlinked="unlinked" :current="seconds" :selected-id="selected.id" @position="boardPosition" />
        <template v-if="!board">
          <ImageAnnotationPreview v-if="review?.capture" class="frame-editor" staged src="" :local-file="review.capture.file" :name="review.capture.file.name"
            :source-key="review.id" :context-key="review.target" :editable="!!destination && destination.key === review.target" :active="active"
            @image-context="marked" @image-busy="busy" />
          <OtioMonitor v-else ref="monitor" class="picture" :picture-key="picture?.id ?? ''" :url="medium?.url ?? null" :media-kind="medium?.kind ?? null"
            :source-seconds="position" :playing="playing" :muted="muted" :active="active" :label="picture?.name || t('Picture monitor')" :unavailable="unavailable" @capture-ready="captureReady = $event" />
          <div v-if="!review?.capture" class="transport">
            <div class="transport-buttons">
              <HoverInfo v-for="control in transport" :key="control.key" :text="control.label" v-slot="{ triggerProps }">
                <button v-bind="triggerProps" type="button" :aria-label="control.label" :disabled="locked || control.disabled" @click="control.run"><span :class="control.icon" aria-hidden="true" /></button>
              </HoverInfo>
              <HoverInfo v-if="medium?.kind === 'video'" :text="muted ? t('Unmute clip audio') : t('Mute clip audio')" v-slot="{ triggerProps }">
                <button v-bind="triggerProps" type="button" :aria-label="t('Clip audio')" :aria-pressed="!muted" :disabled="locked" @click="muted = !muted"><span :class="muted ? 'i-lucide-volume-x' : 'i-lucide-volume-2'" aria-hidden="true" /></button>
              </HoverInfo>
            </div>
            <span class="readout">{{ t('Frame {frame}', { frame: format(frame) }) }}</span><span class="rate">{{ t('{rate} fps', { rate: formatNumber(model.rate, { maximumFractionDigits: 3 }) }) }}</span>
          </div>
          <p v-if="picture" class="picture-caption selectable-text">{{ t('Picture: {name}', { name: [picture.name, medium?.path].filter(Boolean).join(' · ') || picture.id }) }}</p>
        </template>
      </section>
      <section class="inspector" :aria-label="t('Selection')">
        <header class="panel-bar"><h3>{{ t('Selection') }}</h3></header>
        <div class="inspector-body">
          <span class="schema">{{ selected.schema }}</span>
          <h4 class="selectable-text">{{ selected.name || t('Unnamed element') }}</h4>
          <dl><dt>{{ t('Timeline range') }}</dt><dd class="numeric">{{ rangeLabel }}</dd>
            <template v-if="selected.authoredRange"><dt>{{ t('Source in / duration') }}</dt><dd class="numeric">{{ displayTime(selected.authoredRange.start) }} / {{ displayTime(selected.authoredRange.duration) }}</dd></template>
            <dt>{{ t('Element path') }}</dt><dd class="pointer">{{ selected.id || t('Document root') }}</dd>
          </dl>
          <p v-if="selected.kind === 'Transition'" class="destination cut-notice">{{ t('Transitions are shown as cuts, not rendered blends.') }}</p>
          <template v-if="review">
            <p v-if="!destination || destination.key !== review.target" class="warning" role="status">{{ t('The original conversation is not available. This review has not been added elsewhere.') }}</p>
            <p v-else class="destination">{{ t('Draft: {name}', { name: destination.label }) }}</p>
            <div class="review-actions"><button class="btn btn-sm btn-primary" type="button" :disabled="!canAdd" @click="add">{{ t('Add reference') }}</button>
              <button class="btn btn-sm" type="button" @click="cancelReview">{{ t('Cancel') }}</button></div>
          </template>
          <template v-else>
            <p v-if="!destination" class="destination">{{ t('Open an editable conversation to add a review.') }}</p>
            <details v-if="model.warnings.length" class="limits"><summary>{{ t('Preview limits') }}</summary><ul><li v-for="warning in model.warnings" :key="warning">{{ t(warnings[warning]) }}</li></ul></details>
            <div class="reference-actions" role="group" :aria-label="t('Reference actions')">
              <button type="button" class="reference-action" :disabled="!destination || locked" @click="begin(false)"><span class="i-lucide-message-square-plus" aria-hidden="true" />{{ t('Reference selection') }}</button>
              <HoverInfo :text="captureHint" v-slot="{ triggerProps }">
                <button v-bind="triggerProps" type="button" class="mark-action" :disabled="board || !destination || !captureReady || locked || playing" @click="begin(true)"><span class="i-lucide-pencil" aria-hidden="true" />{{ t('Draw on frame') }}</button>
              </HoverInfo>
            </div>
          </template>
        </div>
      </section>
      <OtioTracks v-if="!review" class="tracks-pane" :model="model" :selected-id="selected.id" :frame="frame" @select="select" @seek="seek" />
    </div>
    <p v-if="error" class="review-error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { formatNumber, t } from '../../i18n.ts'
import type { ImageContextBusy, ImageContextUpdate } from '../../image-context.ts'
import { OtioDraftKey } from '../../otio-draft.ts'
import { otioPictureAt, type OtioModel, type OtioNode, type OtioTime } from '../../otio-model.ts'
import { lastOtioFrame } from '../../otio-navigation.ts'
import { firstOtioFrame, mediaPosition, otioReviewAnchor, otioReviewText, type OtioAnchor, type OtioDocument, type OtioMedium } from '../../otio-review.ts'
import HoverInfo from '../HoverInfo.vue'
import ImageAnnotationPreview from './ImageAnnotationPreview.vue'
import OtioMonitor from './OtioMonitor.vue'
import OtioOutline from './OtioOutline.vue'
import OtioStoryboard from './OtioStoryboard.vue'
import OtioTracks from './OtioTracks.vue'

const props = defineProps<{ model: OtioModel; source: OtioDocument; apiBase: string; active: boolean; canReview: boolean;
  mediaFor: (node: OtioNode) => (OtioMedium & { url: string }) | null; unlinked: string }>()
const emit = defineEmits<{ added: [] }>()
const warnings = { 'transition-cut': 'Transitions are shown as cuts, not rendered blends.', 'clip-effects': 'Clips with effects have no picture preview.',
  'unsupported-track': 'Some track kinds cannot be previewed.', 'unsupported-item': 'Some timed elements have no picture preview.' } as const
const panels = [{ id: 'monitor', label: 'Picture monitor' }, { id: 'outline', label: 'Outline' }, { id: 'selection', label: 'Selection' }] as const
const compact = ref<typeof panels[number]['id']>('monitor')
const draft = inject(OtioDraftKey, null)
const destination = computed(() => props.active && props.canReview ? draft?.target(props.apiBase) : null)
const byId = computed(() => new Map(props.model.nodes.map(node => [node.id, node])))
const selection = ref(props.model.root.id), frame = ref(0), mode = ref<'timeline' | 'clip' | 'track'>('timeline')
const board = ref(false), boardOpened = ref(false), trackId = ref<string>()
const videoTrack = computed(() => trackId.value === undefined ? undefined : byId.value.get(trackId.value))
const selected = computed(() => byId.value.get(selection.value) ?? props.model.root)
const last = computed(() => lastOtioFrame(props.model.duration, props.model.rate))
const firstSelected = computed(() => firstOtioFrame(selected.value.start, props.model.rate))
const afterSelected = computed(() => firstOtioFrame(selected.value.end, props.model.rate))
const canSolo = computed(() => selected.value.kind === 'Clip' && selected.value.trackKind !== 'Audio' && afterSelected.value > firstSelected.value)
const seconds = computed(() => frame.value / props.model.rate)
const picture = computed(() => mode.value === 'clip' ? selected.value : otioPictureAt(props.model, seconds.value, mode.value === 'track' ? videoTrack.value : undefined))
const medium = computed(() => picture.value?.sourceStart ? props.mediaFor(picture.value) : null)
const position = computed(() => picture.value ? mediaPosition(picture.value, seconds.value) : null)
const unavailable = computed(() => !props.model.duration ? t('This timeline is empty.') : props.unlinked || (!picture.value ? t('No picture at this position.')
  : !picture.value.sourceStart ? t('Source timing is unavailable for this element.') : t('No supported media in this workspace for this clip.')))
const format = (n: number) => formatNumber(n, { maximumFractionDigits: 3, useGrouping: false })
const displayTime = (time: OtioTime) => `${format(time.value)} @ ${format(time.rate)}`
const rangeLabel = computed(() => t('{start} – {end} s (end exclusive)', { start: format(selected.value.start), end: format(selected.value.end) }))
const monitor = ref<InstanceType<typeof OtioMonitor>>()
const muted = ref(true)
const playing = ref(false), captureReady = ref(false), capturing = ref(false), exporting = ref(false), error = ref('')
const captureHint = computed(() => !destination.value ? t('Open an editable conversation to add a review.')
  : playing.value ? t('Pause playback to mark the displayed frame.') : board.value ? t('Open the Monitor to draw on a frame.') : !captureReady.value ? t('No picture is ready to capture.') : t('Freeze this picture and draw on a copy.'))
interface Review { id: string; target: string; anchor: OtioAnchor; capture: { file: File; mediaSeconds: number | null } }
const review = shallowRef<Review>(), markedFile = shallowRef<File>()
const locked = computed(() => !!review.value || capturing.value || !props.active)
const canAdd = computed(() => !!review.value && review.value.target === destination.value?.key && !exporting.value && !!markedFile.value)
let raf = 0, generation = 0
function pause() { playing.value = false; cancelAnimationFrame(raf) }
function setMode(next: typeof mode.value) {
  if (locked.value) return
  pause(); mode.value = next
  if (next === 'clip' && (frame.value < firstSelected.value || frame.value >= afterSelected.value)) frame.value = firstSelected.value
}
function seek(n: number) {
  if (locked.value) return
  pause(); error.value = ''; frame.value = Math.max(0, Math.min(last.value, Math.round(n)))
  if (mode.value === 'clip' && (frame.value < firstSelected.value || frame.value >= afterSelected.value)) mode.value = 'timeline'
}
function pickTrack(node: OtioNode | null) {
  let parent = node ?? undefined
  while (parent && parent.kind !== 'Track') parent = parent.parentId === null ? undefined : byId.value.get(parent.parentId)
  trackId.value = parent?.trackKind === 'Video' ? parent.id : undefined
}
function select(id: string) {
  if (locked.value || !byId.value.has(id)) return
  pause(); error.value = ''; selection.value = id
  pickTrack(selected.value)
  if ((frame.value < firstSelected.value || frame.value >= afterSelected.value) && firstSelected.value < afterSelected.value) frame.value = firstSelected.value
  mode.value = canSolo.value ? 'clip' : 'timeline'
  if (compact.value === 'outline') compact.value = 'selection'
}
function showBoard(next: boolean) {
  if (locked.value) return
  if (board.value === next) return
  pause(); if (next) boardOpened.value = true
  board.value = next; compact.value = 'monitor'; captureReady.value = false
}
function boardPosition(seconds: number, node: OtioNode | null, solo: boolean, monitorView: boolean) {
  if (locked.value) return
  pause(); error.value = ''; selection.value = node?.id ?? props.model.root.id
  if (!solo) pickTrack(node)
  frame.value = seconds * props.model.rate
  mode.value = solo && videoTrack.value ? 'track' : 'timeline'
  if (monitorView) showBoard(false)
}
const firstPlayable = computed(() => mode.value === 'clip' ? firstSelected.value : 0)
const lastPlayable = computed(() => mode.value === 'clip' ? afterSelected.value - 1 : last.value)
function play() {
  if (locked.value || !props.model.duration) return
  if (playing.value) { pause(); return }
  if (frame.value >= lastPlayable.value) frame.value = firstPlayable.value
  const from = Math.floor(frame.value), start = performance.now()
  playing.value = true
  function tick(now: number) {
    if (!playing.value) return
    const next = from + Math.floor((now - start) * props.model.rate / 1000)
    frame.value = Math.min(next, lastPlayable.value)
    if (next > lastPlayable.value) pause(); else raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}
const transport = computed(() => [
  { key: 'previous', icon: 'i-lucide-step-back', label: t('Previous frame'), disabled: frame.value <= firstPlayable.value, run: () => seek(frame.value - 1) },
  { key: 'play', icon: playing.value ? 'i-lucide-pause' : 'i-lucide-play', label: playing.value ? t('Pause playback') : t('Play preview'), disabled: !props.model.duration, run: play },
  { key: 'next', icon: 'i-lucide-step-forward', label: t('Next frame'), disabled: frame.value >= lastPlayable.value, run: () => seek(frame.value + 1) },
])
async function begin(withFrame: boolean) {
  const target = destination.value?.key
  if (!target || locked.value || (withFrame && (playing.value || !captureReady.value || !monitor.value))) return
  pause(); error.value = ''; markedFile.value = undefined; exporting.value = false
  const anchor = otioReviewAnchor(props.source, props.model, selected.value, frame.value, picture.value, mode.value, medium.value, mode.value === 'track' ? videoTrack.value : undefined)
  if (!withFrame) {
    const name = selected.value.name || selected.value.schema
    const selectionFrame = anchor.element.referenceFrame?.relative.value
    const label = selectionFrame === undefined ? t('OTIO selection: {name}', { name }) : t('OTIO selection: {name} · Frame {frame}', { name, frame: selectionFrame })
    stage(target, label, otioReviewText(anchor))
    return
  }
  const version = ++generation, id = String(version)
  capturing.value = true
  try {
    const capture = await monitor.value!.capture()
    if (version !== generation || target !== destination.value?.key) return
    const stem = props.source.path.split(/[\\/]/).at(-1)?.replace(/\.otio(?:\.json)?$/i, '') || 'otio'
    const file = new File([capture.file], `${stem}-f${anchor.playhead.relative.value}.png`, { type: 'image/png' })
    review.value = { id, target, anchor, capture: { file, mediaSeconds: capture.mediaSeconds } }
    captureReady.value = false
  } catch (cause) { if (version === generation) error.value = cause instanceof Error ? cause.message : t('The current picture could not be captured.') }
  finally { if (version === generation) capturing.value = false }
}
function marked(update: ImageContextUpdate) {
  if (update.sourceKey === review.value?.id && update.contextKey === review.value.target) markedFile.value = update.file ?? undefined
}
function busy(update: ImageContextBusy) {
  if (update.sourceKey === review.value?.id && update.contextKey === review.value.target) exporting.value = update.busy
}
function cancelReview() {
  generation++; review.value = undefined; markedFile.value = undefined; capturing.value = false; exporting.value = false; error.value = ''
}
function add() {
  const r = review.value
  if (!r || !canAdd.value || !markedFile.value) return
  const name = r.anchor.monitor.clip?.name || r.anchor.monitor.clip?.pointer || t('Picture monitor')
  const label = t('OTIO marked picture: {name} · Frame {frame}', { name, frame: r.anchor.playhead.relative.value })
  stage(r.target, label, otioReviewText(r.anchor, { presentedMediaSeconds: r.capture.mediaSeconds }), markedFile.value)
}
function stage(target: string, label: string, text: string, file?: File) {
  if (draft?.add(props.apiBase, target, { label, text, file })) { cancelReview(); emit('added') }
  else error.value = t('This review could not be added. Check the target conversation and try again.')
}
watch(() => props.active, active => { if (!active) { pause(); ++generation; capturing.value = false } })
function visibility() { if (document.hidden) pause() }
onMounted(() => document.addEventListener('visibilitychange', visibility))
onBeforeUnmount(() => { pause(); generation++; document.removeEventListener('visibilitychange', visibility) })
</script>

<style scoped>
.otio { container: otio / inline-size; display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto; color: var(--c-text); font-size: 13px; }
.bench { display: grid; flex: 1 0 0; min-height: 330px; grid-template-columns: minmax(150px, 20%) minmax(0, 1fr) minmax(176px, 22%); grid-template-rows: minmax(0, 1fr) minmax(118px, 30%); grid-template-areas: 'outline monitor selection' 'tracks tracks tracks'; }
.bench > .storyboard-pane { grid-area: outline-start / outline-start / monitor-end / monitor-end; }
.storyboard-content { flex: 1; }
.viewer-modes { margin-inline-end: auto; }
.otio .viewer-modes button[aria-pressed='true'] { background: var(--c-selection-bg); color: var(--c-text); }
.outline-pane { grid-area: outline; border-right: 1px solid var(--c-border); }
.monitor-pane { grid-area: monitor; display: flex; flex-direction: column; overflow: hidden; min-height: 0; min-width: 0; }
.picture { flex: 1; min-height: 0; }
.tracks-pane { grid-area: tracks; border-top: 1px solid var(--c-border); }
.inspector { grid-area: selection; min-height: 0; min-width: 0; overflow-y: auto; border-left: 1px solid var(--c-border); }
.panel-bar { min-height: 36px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; padding: 2px 12px; background: var(--c-bg-soft); border-bottom: 1px solid var(--c-border); }
.panel-bar h3 { margin: 0; font-size: 12px; font-weight: 600; }
.modes, .transport-buttons, .review-actions { display: flex; align-items: center; gap: 2px; }
.otio button:not(.btn) { border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); font: inherit; cursor: pointer; }
.otio button:hover:not(:disabled) { background: var(--c-bg-muted); color: var(--c-text); }
.otio button:not(.btn)[aria-pressed='true'] { background: var(--c-selection-bg); color: var(--c-primary); }
.otio button:disabled { opacity: .48; cursor: not-allowed; }
.otio button:focus-visible, .otio textarea:focus-visible, .limits summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.modes button { min-height: 30px; padding: 2px 7px; }
.transport { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; padding: 3px 8px; border-top: 1px solid var(--c-border); }
.transport-buttons button, .reference-actions button { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; min-height: 32px; }
.transport button span, .reference-actions button span { width: 16px; height: 16px; }
.reference-actions { display: flex; flex-wrap: wrap; gap: 2px; margin-top: 10px; }
.reference-actions button { gap: 6px; min-width: 0; max-width: 100%; padding-inline: 8px; text-align: start; }
.reference-actions button span { flex: 0 0 16px; }
.readout, .numeric, .pointer, .schema, .rate { font-family: var(--font-mono, 'IBM Plex Mono', ui-monospace, monospace); font-variant-numeric: tabular-nums; }
.rate, .picture-caption, .schema, .destination, .limits { color: var(--c-text-muted); font-size: 12px; }
.picture-caption { margin: 0; padding: 0 12px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inspector-body { padding: 12px; overflow-wrap: anywhere; }
.inspector h4 { margin: 3px 0 12px; color: var(--c-text); font-weight: 600; font-size: 15px; line-height: 1.4; }
.inspector dl { margin: 0 0 14px; }
.inspector dt { margin-top: 10px; font-size: 12px; color: var(--c-text-muted); }
.inspector dd { margin: 3px 0 0; font-size: 12px; line-height: 1.45; color: var(--c-text-body); }
.destination, .limits { margin: 10px 0 0; line-height: 1.45; }
.limits { border-top: 1px solid var(--c-border-soft); padding-top: 8px; }
.limits summary { cursor: pointer; }
.limits ul { padding-inline-start: 16px; list-style: disc; }
.reviewing { grid-template-columns: minmax(0, 1fr) minmax(196px, 28%); grid-template-rows: minmax(0, 1fr); grid-template-areas: 'monitor selection'; }
.frame-editor { flex: 1; padding: 10px 12px; overflow: auto; }
.frame-editor :deep(.image-annotation-stage) { flex: 1; min-height: 80px; max-height: none; background: var(--c-bg-muted); }
.frame-editor :deep(.image-annotation-canvas) { max-height: 100%; }
.review-actions { margin-top: 10px; gap: 6px; flex-wrap: wrap; }
.warning { color: var(--c-warn); }
.review-error { margin: 0; padding: 8px 12px; color: var(--c-error); border-top: 1px solid var(--c-border); }
.compact-tabs { display: none; }
@container otio (max-width: 740px) {
  .compact-tabs { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--c-border); }
  .compact-tabs button { padding: 4px 12px; min-height: 38px; }
  .bench { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'panel' 'tracks'; grid-template-rows: minmax(160px, 1fr) minmax(116px, 30%); }
  .bench:not(.reviewing) > :is(.outline-pane, .monitor-pane, .inspector) { display: none; grid-area: panel; border-inline: 0; }
  .bench:not(.reviewing)[data-panel='outline'] > .outline-pane, .bench:not(.reviewing)[data-panel='monitor'] > .monitor-pane { display: flex; }
  .bench:not(.reviewing)[data-panel='selection'] > .inspector { display: block; }
  .reviewing { flex-basis: auto; min-height: 0; grid-template-areas: 'monitor' 'selection'; grid-template-rows: minmax(220px, 1fr) auto; overflow: auto; }
  .reviewing .inspector { border: 0; border-top: 1px solid var(--c-border); overflow: visible; }
  .reviewing .inspector-body dl { display: none; }
  .reviewing .inspector h4 { display: inline; margin-inline-start: 6px; }
  .reviewing .frame-editor { min-height: 200px; }
}
@media (pointer: coarse), (max-width:700px) { .otio button:not(.btn) { min-height: 44px; } .transport-buttons button { min-width: 44px; } }
</style>
