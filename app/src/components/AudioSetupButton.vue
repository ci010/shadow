<template>
  <div ref="root" class="audio-input" @pointerenter="hoverEnter" @pointerleave="hoverLeave" @focusin="focusIn" @focusout="focusOut" @keydown.esc.stop="closePopup">
    <button type="button" data-composer-microphone :data-keyboard-active="visible && keyboardActive && !disabled && !loading && phase === 'idle' && entry === 'local-ready'" :disabled="disabled || loading || phase === 'processing'" :aria-label="t(phase === 'idle' ? 'Audio input' : 'Stop and transcribe')" :aria-expanded="panel || popup" aria-haspopup="dialog" :aria-controls="popupId" aria-keyshortcuts="Control+Shift" @click="click" @pointerdown="pointerDown" @pointercancel="cancel">
      <span class="audio-mic-indicator" :class="`audio-mic-${phase}`" :data-audio-phase="phase" :style="{ '--audio-level': level }" aria-hidden="true"><span class="i-lucide-mic w-5 h-5" /></span>
    </button>
    <button v-if="entry !== 'setup' && phase === 'idle'" class="audio-touch-settings" type="button" :disabled="disabled || setupDisabled" :aria-label="t('Change audio setup')" @click="openSettings"><span class="i-lucide-settings-2 w-3 h-3" aria-hidden="true" /></button>
    <span v-if="loading" role="status">{{ t('Checking Project audio status…') }}</span>
    <span v-if="phase !== 'idle'" class="audio-state-sr" role="status" aria-live="polite">{{ t(phase === 'acquiring' ? 'Waiting for microphone…' : phase === 'recording' ? 'Recording…' : 'Processing audio…') }}</span>
    <button v-if="phase !== 'idle'" type="button" @click="cancel">{{ t('Cancel') }}</button>
    <span v-if="error" role="alert">{{ error }}</span>
    <span v-if="notice" role="status">{{ notice }}</span>
    <div v-if="provisional" class="audio-provisional" role="status"><small>{{ t('Provisional · buffered local transcription') }}</small><p>{{ provisional }}</p></div>
    <div v-if="panel || popup" :id="popupId" class="audio-setup" role="dialog" :aria-label="t('Audio input')">
      <template v-if="!panel">
        <p>{{ t('Click to record; click again to transcribe. Hold microphone or Ctrl+Shift to talk.') }}</p>
        <button type="button" :disabled="disabled || setupDisabled" @click="openSettings">{{ t('Change audio setup') }}</button>
      </template>
      <template v-else>
      <p v-if="entry === 'remote-ready'">{{ t('Remote transcription is configured. Composer microphone input currently supports local ASR only; use the configured audio tool for remote transcription.') }}</p>
      <p v-if="status?.tts.ready && !status.asr.ready">{{ t('Speech output is configured, but transcription still needs setup.') }}</p>
      <template v-if="status">
        <p>{{ t('Choose where audio is processed. Setup does not record or upload audio.') }}</p>
        <button type="button" :disabled="disabled || setupDisabled" @click="request('local')">{{ t('Local · assess this computer with Agent') }}</button>
        <button type="button" :disabled="disabled || setupDisabled" @click="request('remote')">{{ t('Remote · configure API with Agent') }}</button>
      </template>
      <button type="button" @click="refresh(true, true)">{{ t('Refresh audio status') }}</button>
      </template>
    </div>
  </div>
</template>
<script setup lang="ts">
import { audioStatusResource } from '../audio-status-resource.ts'
import { useLiveClientPool } from '../composables/useLiveClient.ts'
import { computed, onMounted, onActivated, onDeactivated, onUnmounted, ref, watch, useId } from 'vue'
import { audioSetupRequest } from '../audio-setup'
import { audioEntry, recognizedTranscript, recordMicrophone, prepareMicrophone, type MicrophonePreparation, type AudioStatus, NoAudioSignalError } from '../audio-input'
import { AudioSignalMeter } from '../audio-signal.ts'
import { openAudioStream } from '../audio-stream.ts'
import { apiUrl } from '../api-url'
import { t } from '../i18n.ts'
const props = withDefaults(defineProps<{ disabled: boolean; setupDisabled?: boolean; visible?: boolean; keyboardActive?: boolean; apiBase: string; draftKey: string; sessionId?: string }>(), { visible: true, keyboardActive: true })
const livePool = useLiveClientPool()
const emit = defineEmits<{ request: [text: string]; transcript: [text: string] }>()
const status = ref<AudioStatus>(), loading = ref(false), error = ref(''), notice = ref(''), panel = ref(false)
const root = ref<HTMLElement>(), popup = ref(false), popupId = useId()
let hoverTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined
function closePopup() { clearTimeout(hoverTimer); clearTimeout(closeTimer); hoverTimer = closeTimer = undefined; popup.value = false; panel.value = false }
function canPopup() { return active && props.visible && !props.disabled && !loading.value && phase.value === 'idle' && !arm && !hold }
function hoverEnter(e: PointerEvent) {
  clearTimeout(closeTimer)
  if (e.pointerType === 'touch' || !canPopup()) return
  clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => { hoverTimer = undefined; if (canPopup()) { popup.value = true; if (entry.value !== 'local-ready') panel.value = true } }, 200)
}
function hoverLeave() {
  clearTimeout(hoverTimer); hoverTimer = undefined
  closeTimer = setTimeout(() => { if (!root.value?.contains(document.activeElement)) closePopup() }, 200)
}
function focusIn() { clearTimeout(closeTimer); if (canPopup()) { popup.value = true; if (entry.value !== 'local-ready') panel.value = true } }
function focusOut(e: FocusEvent) { if (!root.value?.contains(e.relatedTarget as Node)) closePopup() }
function openSettings() { if (!canPopup() || props.setupDisabled) return; clearTimeout(hoverTimer); popup.value = false; panel.value = true; void refresh(true, true) }
const level = ref(0), provisional = ref('')
let stream: Awaited<ReturnType<typeof openAudioStream>> | undefined
let streaming: Promise<void> | undefined
const phase = ref<'idle' | 'acquiring' | 'recording' | 'processing'>('idle')
const entry = computed(() => status.value ? audioEntry(status.value) : 'setup')
let capture: Awaited<ReturnType<typeof recordMicrophone>> | undefined
let generation = 0, controller: AbortController | undefined, limit: ReturnType<typeof setTimeout> | undefined
let arm: ReturnType<typeof setTimeout> | undefined, hold: ReturnType<typeof setTimeout> | undefined
let preparation: MicrophonePreparation | undefined
let owner: 'click' | 'pointer' | 'keyboard' | undefined, pendingStop = false, suppressClick = false, active = true, blockedChord = false
let pointerId: number | undefined, clickReset: ReturnType<typeof setTimeout> | undefined
function cancel() {
  closePopup(); clearTimeout(clickReset); clickReset = undefined
  preparation?.cancel(); preparation = undefined
  generation++; stream?.cancel(); stream = undefined; streaming = undefined; provisional.value = ''; level.value = 0; controller?.abort(); controller = undefined; capture?.cancel(); capture = undefined
  clearTimeout(limit); clearTimeout(arm); clearTimeout(hold); arm = hold = undefined
  owner = undefined; pendingStop = false; pointerId = undefined; suppressClick = false; blockedChord = false; phase.value = 'idle'; loading.value = false
}
async function refresh(fresh = false, preservePopup = false) {
  const previousPopup = popup.value, previousPanel = panel.value
  cancel()
  if (preservePopup) { popup.value = previousPopup; panel.value = previousPanel }
  status.value = undefined; error.value = ''; loading.value = true
  const own = generation; controller = new AbortController()
  try {
    const value = await audioStatusResource(livePool, props.apiBase).read(controller.signal, fresh)
    if (own === generation) status.value = value
  } catch (e) { if (own === generation) error.value = e instanceof Error ? e.message : String(e) }
  finally { if (own === generation) loading.value = false }
}
function request(route: 'local' | 'remote') { if (props.disabled || props.setupDisabled) return; closePopup(); emit('request', audioSetupRequest(route)) }
async function start(kind: typeof owner) {
  if (!active || props.disabled || phase.value !== 'idle' || entry.value !== 'local-ready') return
  closePopup(); owner = kind; pendingStop = false; error.value = ''; notice.value = ''; phase.value = 'acquiring'; const own = generation
  controller = new AbortController()
  try {
    let meter: AudioSignalMeter | undefined
    let queued: Float32Array[] = []
    let rate = 0
    const drain = () => { if (!stream || !meter?.hasSignal) return; for (const samples of queued) stream.push(samples, rate); queued = [] }
    const prepared = preparation; preparation = undefined
    const recording = await recordMicrophone(controller.signal, {
      onLevel: value => { if (own === generation) level.value = value },
      onSamples: (samples, sampleRate) => {
        if (own !== generation) return
        rate = sampleRate; meter ??= new AudioSignalMeter(rate); meter.push(samples)
        queued.push(samples); drain()
      },
    }, prepared)
    if (own !== generation) { recording.cancel(); return }
    capture = recording; phase.value = 'recording'
    if (props.sessionId) {
      const signal = controller.signal
      streaming = (async () => {
        const opened = await openAudioStream(props.apiBase, props.sessionId!, signal, text => { if (own === generation) provisional.value = recognizedTranscript(text) })
        if (own !== generation) { opened?.cancel(); return }
        stream = opened; drain()
        if (!opened) notice.value = t('Streaming unavailable; transcribing locally when stopped.')
      })()
      // Mark rejection handled while the user is still recording; stop surfaces it.
      void streaming.catch(e => { if (own === generation) { cancel(); error.value = e instanceof Error ? e.message : String(e) } })
    }
    limit = setTimeout(() => { cancel(); error.value = t('Recording limit reached. Record again and stop within 60 seconds.') }, 60_000)
    if (pendingStop) void stop()
  } catch (e) { if (own === generation) { phase.value = 'idle'; owner = undefined; error.value = e instanceof Error ? e.message : String(e) } }
}
async function stop() {
  if (phase.value === 'acquiring') { pendingStop = true; return }
  const recording = capture; if (!recording || phase.value !== 'recording') return
  capture = undefined; clearTimeout(limit); owner = undefined; phase.value = 'processing'; const own = generation
  try {
    const wav = await recording.stop()
    if (own !== generation) return
    await streaming
    if (own !== generation) return
    if (stream) {
      const text = recognizedTranscript(await stream.finish())
      if (own === generation) { if (text) emit('transcript', text); else notice.value = t('No speech recognized. Try again.') }
      return
    }
    const response = await fetch(apiUrl(props.apiBase, '/api/audio/transcribe'), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav, signal: controller?.signal })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error || t('Transcription failed.'))
    if (typeof value.text !== 'string') throw new Error(t('Invalid transcription response.'))
    if (own === generation) { const text = recognizedTranscript(value.text); if (text) emit('transcript', text); else notice.value = t('No speech recognized. Try again.') }
  } catch (e) { if (own === generation) { if (e instanceof NoAudioSignalError) notice.value = t('No speech recognized. Try again.'); else error.value = e instanceof Error ? e.message : String(e) } }
  finally { if (own === generation) { stream?.cancel(); stream = undefined; controller?.abort(); controller = undefined; streaming = undefined; provisional.value = ''; level.value = 0; phase.value = 'idle' } }
}
function click() {
  if (suppressClick) { suppressClick = false; return }
  if (props.disabled || loading.value) return
  if (phase.value === 'acquiring' || phase.value === 'recording') { void stop(); return }
  if (entry.value === 'local-ready') void start('click'); else { popup.value = false; panel.value = !panel.value; if (panel.value) void refresh(true, true) }
}
function reserve() {
  try { preparation?.cancel(); preparation = prepareMicrophone(); return true }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); return false }
}
function pointerDown(e: PointerEvent) {
  if (e.button !== 0 || !active || !props.visible || props.disabled || loading.value || phase.value !== 'idle' || entry.value !== 'local-ready' || hold || arm) return
  if (!reserve()) return
  closePopup(); pointerId = e.pointerId; suppressClick = false
  hold = setTimeout(() => { hold = undefined; suppressClick = true; void start('pointer') }, 300)
}
function pointerUp(e: PointerEvent) {
  if (e.pointerId !== pointerId) return
  clearTimeout(hold); hold = undefined; pointerId = undefined
  // A short press opens no tracks; click gets a fresh trusted approval.
  preparation?.cancel(); preparation = undefined
  if (owner === 'pointer') void stop()
  // The synthetic click follows pointerup in the same task. An outside release
  // has no click, so do not swallow the user's next independent activation.
  clearTimeout(clickReset); clickReset = setTimeout(() => { clickReset = undefined; suppressClick = false }, 0)
}
function keyDown(e: KeyboardEvent) {
  if (!active || props.visible === false || props.keyboardActive === false || typeof document === 'undefined' || !document.hasFocus() || document.hidden) return
  if (e.key === 'Escape') { cancel(); return }
  if (e.isComposing || e.keyCode === 229) { blockedChord = true; clearTimeout(arm); arm = undefined; preparation?.cancel(); preparation = undefined; return }
  if (e.key !== 'Control' && e.key !== 'Shift') { blockedChord = true; clearTimeout(arm); arm = undefined; preparation?.cancel(); preparation = undefined; return }
  if (e.repeat || blockedChord || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || props.disabled || phase.value !== 'idle' || arm || hold || loading.value || entry.value !== 'local-ready') return
  if (!reserve()) return
  closePopup()
  arm = setTimeout(() => { arm = undefined; void start('keyboard') }, 300)
}
function keyUp(e: KeyboardEvent) {
  if (e.key !== 'Control' && e.key !== 'Shift') return
  clearTimeout(arm); arm = undefined; blockedChord = false
  preparation?.cancel(); preparation = undefined
  if (owner === 'keyboard') void stop()
}
function visibility() { if (document.hidden) cancel() }
function attach() { active = true; window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('pointerup', pointerUp); window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel); document.addEventListener('visibilitychange', visibility) }
function detach() { active = false; cancel(); window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('pointerup', pointerUp); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', visibility) }
onMounted(() => { attach(); void refresh() }); onActivated(() => { attach(); void refresh() }); onDeactivated(detach); onUnmounted(detach)
watch(() => props.apiBase, () => { panel.value = false; void refresh() })
watch(() => [props.draftKey, props.sessionId], () => { panel.value = false; cancel() })
watch(() => props.disabled, value => { if (value) cancel() })
watch(() => props.visible, value => { if (value === false) cancel(); else void refresh() })
watch(() => props.keyboardActive, value => { if (value === false && (owner === 'keyboard' || arm)) cancel() })
</script>
<style scoped>
.audio-input { display: flex; align-items: center; gap: 4px; position: relative; font-size: 12px; }
.audio-input > button { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 5px 9px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); font: inherit; cursor: pointer; touch-action: none; }
.audio-state-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.audio-mic-indicator { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; }
.audio-mic-recording { color: var(--c-primary); background: color-mix(in srgb, var(--c-primary) 8%, transparent); box-shadow: 0 0 0 calc(1px + var(--audio-level, 0) * 6px) color-mix(in srgb, var(--c-primary) 22%, transparent); transition: box-shadow 90ms linear; animation: input-breathe 9s ease-in-out infinite; }
.audio-mic-recording::before { content: ''; position: absolute; inset: -3px; border: 1px solid var(--c-primary); border-radius: 50%; opacity: calc(.15 + var(--audio-level, 0) * .6); transform: scale(calc(1 + var(--audio-level, 0) * .3)); transition: transform 90ms linear, opacity 90ms linear; }
.audio-mic-acquiring { opacity: .55; }
.audio-mic-processing::after { content: ''; position: absolute; inset: -3px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: audio-processing-spin 1s linear infinite; }
@keyframes audio-processing-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .audio-mic-recording, .audio-mic-processing::after { animation: none; } }
.audio-input > button:hover { background: var(--c-bg-muted); color: var(--c-text); }
.audio-input > span { max-width: 180px; overflow-wrap: anywhere; color: var(--c-text-secondary); }
.audio-input button:disabled { cursor: default; opacity: .5; }
.audio-provisional { position: absolute; bottom: calc(100% + 8px); right: 0; width: min(360px, calc(100vw - 48px)); padding: 10px; border: 1px dashed var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text-secondary); z-index: 10; max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.audio-provisional p { margin: 4px 0 0; }
.audio-setup { position: absolute; bottom: 100%; right: 0; width: min(300px, calc(100vw - 48px)); box-sizing: border-box; padding: 12px; background: var(--c-bg-input); border: 1px solid var(--c-control-border); border-radius: var(--radius-control); z-index: 10; }
.audio-setup button { display: block; margin: 6px 0; padding: 8px; text-align: left; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }

.audio-input { flex-shrink: 0; }
.audio-input > button:first-child { width: 32px; height: 32px; padding: 0; justify-content: center; }
.audio-touch-settings { display: none !important; order: -1; }
@media (hover: none), (pointer: coarse) { .audio-touch-settings { display: inline-flex !important; } }
.audio-setup p { margin: 0 0 8px; line-height: 1.5; color: var(--c-text-secondary); }
.audio-setup button { border: 0; border-radius: var(--radius-control); background: var(--c-bg-muted); color: var(--c-text); font: inherit; cursor: pointer; }
</style>
