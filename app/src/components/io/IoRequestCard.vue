<template>
  <article class="io-request" :data-io-run="run.id" :aria-label="`Capture request: ${run.definition.title}`">
    <header class="request-heading">
      <span class="request-icon" :class="icon" aria-hidden="true" />
      <h3>{{ run.definition.title }}</h3>
      <span class="request-state" :class="{ recording: phase === 'recording' }" role="status">{{ status }}</span>
    </header>
    <p v-if="!terminal" class="request-purpose">{{ run.definition.purpose }}</p>
    <p v-if="!terminal" class="request-scope">{{ sourceNames }} · Up to {{ durationLabel }}</p>
    <p v-if="failure" class="request-error" role="alert">{{ failureSummary }}</p>
    <p v-if="live?.execution.notice" class="request-note" role="status">{{ live.execution.notice }}</p>

    <div v-if="!terminal && microphones.length" class="input-devices">
      <label v-for="source in microphones" :key="source.id" class="input-device">
        <span>{{ microphones.length > 1 ? `Microphone · ${source.id}` : 'Microphone' }}</span>
        <select :value="selectedDevice(source.id)" :aria-label="`Audio input · ${source.id}`"
          :disabled="switching[source.id] || !['ready', 'awaiting_consent', 'recording'].includes(phase) || (phase === 'recording' && !live?.execution.captures?.audioInputs?.has(source.id))"
          @change="selectDevice(source.id, $event)">
          <option value="">System default</option>
          <option v-for="device in devices" :key="device.deviceId" :value="device.deviceId">{{ device.label }}</option>
          <option v-if="selectedDevice(source.id) && !devices.some(device => device.deviceId === selectedDevice(source.id))" :value="selectedDevice(source.id)">Selected microphone</option>
        </select>
        <span v-if="switching[source.id]" role="status">Switching microphone…</span>
      </label>
      <p v-if="deviceError || enumerationError" class="request-error" role="alert">{{ deviceError || enumerationError }}</p>
      <p v-else-if="phase === 'recording' && !live?.execution.captures?.audioInputs?.size" class="request-note">This browser cannot switch inputs during recording.</p>
      <p v-else-if="!devices.length && phase !== 'recording'" class="request-note">Device names may appear after you allow microphone access.</p>
    </div>

    <div v-if="phase === 'recording' || phase === 'starting'" class="capture-preview">
      <div v-for="source in microphones" :key="source.id" class="audio-level">
        <label :for="`${controlId}-${source.id}`">Input level</label>
        <meter :id="`${controlId}-${source.id}`" min="0" max="1" :value="live?.execution.captures?.levels?.get(source.id) || 0" />
      </div>
      <IoMedia v-for="source in videos" :key="source.id" :stream="live?.execution.captures?.streams.get(source.id)" :label="`${source.kind} preview`" />
      <span class="capture-time">{{ elapsedLabel }} / {{ durationLabel }}</span>
    </div>

    <p v-if="phase === 'processing'" class="request-note" role="status">Input collection has stopped. The agent's service is processing your input.</p>
    <p v-if="run.message && !failure && !terminal" class="backend-message">{{ run.message }}</p>
    <div v-if="nodes.length && !terminal" class="backend-controls">
      <IoNodes :nodes="nodes" :streams="live?.execution.captures?.streams" :disabled="phase !== 'recording'" @event="live?.execution.event($event)" />
    </div>
    <form v-for="source in forms" v-show="phase === 'recording'" :key="source.id" class="input-form" @submit.prevent="live?.execution.event({ type: 'ui', sourceId: source.id, id: source.id, value: formValues[source.id] ?? '' })">
      <label :for="`${controlId}-${source.id}`">{{ source.id }}</label>
      <textarea :id="`${controlId}-${source.id}`" v-model="formValues[source.id]" maxlength="4000" rows="2" />
      <button type="submit" class="request-button">Send input</button>
    </form>

    <div v-if="!terminal" class="request-actions">
      <template v-if="phase === 'ready' || phase === 'awaiting_consent'">
        <button v-if="connectionError" type="button" class="request-button primary" :disabled="busy || otherActive" @click="bridge?.actions.value?.prepare(run, base)">Retry connection</button>
        <button v-else type="button" class="request-button primary" :disabled="busy || phase !== 'ready' || otherActive" @click="bridge?.actions.value?.start(run.id, base, { ...inputs })">
          <span v-if="busy" class="i-lucide-loader-circle loading-icon" aria-hidden="true" />{{ busy ? 'Preparing…' : startLabel }}
        </button>
        <button type="button" class="request-button quiet" :disabled="busy" @click="bridge?.actions.value?.cancel(run, base, true)">Not now</button>
      </template>
      <button v-if="phase === 'recording'" type="button" class="request-button primary" @click="bridge?.actions.value?.finish(run.id, base)">{{ recordingMedia ? 'Finish recording' : 'Finish input' }}</button>
      <button v-if="['starting', 'recording', 'draining', 'processing'].includes(phase)" type="button" class="request-button quiet" @click="bridge?.actions.value?.cancel(run, base)">Cancel</button>
      <span v-if="phase === 'starting'" role="status">Waiting for your device…</span>
      <span v-if="phase === 'draining'" role="status">Finishing…</span>
    </div>
    <p v-if="otherActive && !terminal" class="request-note">Finish the current capture before starting this one.</p>
    <p v-if="failure" class="request-note">Ask the agent to open a corrected request. This capture will not restart automatically.</p>

    <IoMedia v-if="live?.execution.preview" :mime="live.execution.preview.mime" :url="live.execution.preview.url" :text="live.execution.preview.text" label="Capture result" />
    <div v-for="artifact in run.artifacts" :key="artifact.id" class="capture-artifact">
      <span class="i-lucide-file-audio" aria-hidden="true" />
      <div><strong>{{ artifact.name }}</strong><small>{{ formatBytes(artifact.size) }}{{ artifact.complete ? '' : ' · Partial recording' }}</small></div>
      <button v-if="playableMime(artifact.mime) && artifact.size <= IO_MAX_BUFFER_BYTES && artifactPreview?.id !== artifact.id" type="button" class="request-button quiet" :disabled="loadingArtifact" @click="previewArtifact(artifact)">Open</button>
      <a :href="artifactUrl(artifact)" :download="artifact.name" class="request-button quiet">Download</a>
    </div>
    <IoMedia v-if="artifactPreview" :mime="artifactPreview.mime" :url="artifactPreview.url" :text="artifactPreview.text" :label="artifactPreview.name" />
    <p v-if="artifactError" class="request-error" role="alert">{{ artifactError }}</p>

    <details class="capture-details">
      <summary>Details</summary>
      <p v-if="terminal">{{ run.definition.purpose }}</p>
      <p v-if="terminal && run.message">Last service update: {{ run.message }}</p>
      <p v-if="failure" class="request-error">{{ failure }}</p>
      <dl>
        <dt>Input</dt><dd>{{ sourceNames }}</dd>
        <dt>Limit</dt><dd>{{ durationLabel }} · {{ formatBytes(run.definition.limits.maxBytes) }}</dd>
        <dt>Service</dt><dd>{{ run.definition.endpoint }} · {{ run.backendStatus || 'Not connected' }}</dd>
        <dt>Revision</dt><dd>{{ run.revision }}</dd>
      </dl>
      <p>Start requests device permission. Input goes to this task's local service, whose code controls processing, storage and onward transfers. Cancel stops capture and disconnects, but does not stop that service or recall data already sent.</p>
      <p>Devices stop when the time limit is reached. Recordings and files use bounded chunks; inline playback is limited to 8 MiB.</p>
      <details v-if="terminal && nodes.length"><summary>Service output</summary><IoNodes :nodes="nodes" disabled /></details>
    </details>
  </article>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { IO_MAX_BUFFER_BYTES, IO_TERMINAL, type IoArtifact, type IoRun } from '../../../../src/io/contracts.ts'
import { ioBridgeKey, ioRunKey } from '../../io/bridge.ts'
import { listAudioInputs, sourceCaptureLabel } from '../../io/adapters.ts'
import { playableMime } from '../../io/execution.ts'
import { apiUrl } from '../../api-url.ts'
import IoMedia from './IoMedia.vue'
import IoNodes from './IoNodes.vue'

const props = defineProps<{ run: IoRun; base: string }>()
const bridge = inject(ioBridgeKey)
const controlId = useId()
const live = computed(() => {
  const execution = bridge?.execution.value
  const now = bridge?.clock.value ?? Date.now()
  return execution?.run.id === props.run.id && bridge?.executionBase.value === props.base ? { execution, now } : undefined
})
const run = computed(() => live.value ? { ...live.value.execution.run } : props.run)
const phase = computed(() => live.value?.execution.phase === 'closed' ? run.value.status : live.value?.execution.phase ?? run.value.status)
const terminal = computed(() => IO_TERMINAL.has(run.value.status))
const busy = computed(() => bridge?.busy.value === ioRunKey(props.base, run.value.id))
const otherActive = computed(() => !!bridge?.execution.value && bridge.execution.value.phase !== 'closed' && !live.value)
const connectionError = computed(() => bridge?.errors.value.get(ioRunKey(props.base, run.value.id)) ?? '')
const failure = computed(() => live.value?.execution.error || run.value.error || connectionError.value)
const failureSummary = computed(() => /NotAllowedError/.test(failure.value) ? 'Microphone or camera access was not allowed. Check device permissions before trying again.'
  : /NotReadableError/.test(failure.value) ? 'The device could not be opened. It may be busy or disconnected.'
  : /undeclared source/.test(failure.value) ? 'The capture service sent an invalid control. The agent needs to correct its request.'
  : failure.value.split('\n')[0]?.slice(0, 240))
const microphones = computed(() => run.value.definition.sources.filter(source => source.kind === 'microphone'))
const videos = computed(() => run.value.definition.sources.filter(source => source.kind === 'camera' || source.kind === 'screen'))
const forms = computed(() => run.value.definition.sources.filter(source => source.kind === 'form'))
const recordingMedia = computed(() => microphones.value.length > 0 || videos.value.length > 0)
const nodes = computed(() => live.value?.execution.nodes ?? run.value.ui ?? run.value.definition.ui)
const sourceNames = computed(() => run.value.definition.sources.map(sourceCaptureLabel).join(', '))
const icon = computed(() => microphones.value.length ? 'i-lucide-mic' : videos.value.length ? 'i-lucide-video' : 'i-lucide-paperclip')
const startLabel = computed(() => microphones.value.length ? 'Record audio' : videos.value.some(source => source.kind === 'screen') ? 'Share screen' : videos.value.length ? 'Start camera' : run.value.definition.sources.some(source => source.kind === 'file') ? 'Choose file' : 'Provide input')
const status = computed(() => terminal.value ? run.value.status === 'completed' ? 'Complete' : run.value.status === 'denied' ? 'Not shared' : run.value.status === 'cancelled' ? 'Cancelled' : 'Could not finish'
  : busy.value ? 'Connecting' : phase.value === 'ready' ? 'Your turn' : phase.value === 'recording' ? recordingMedia.value ? 'Recording' : 'Collecting input' : phase.value === 'processing' ? 'Processing' : phase.value === 'starting' ? 'Starting' : phase.value === 'draining' ? 'Finishing' : 'Waiting')
const time = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const durationLabel = computed(() => time(run.value.definition.limits.durationMs))
const elapsedLabel = computed(() => time(Math.max(0, (live.value?.now ?? Date.now()) - Date.parse(run.value.startedAt ?? new Date().toISOString()))))
const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
const inputs = ref<Record<string, string>>({})
const switching = ref<Record<string, boolean>>({})
const devices = ref<Array<{ deviceId: string; label: string }>>([])
const deviceError = ref('')
const enumerationError = ref('')
const formValues = ref<Record<string, string>>({})
let disposed = false
let listing = 0
function selectedDevice(id: string) { return inputs.value[id] ?? live.value?.execution.captures?.audioInputs?.get(id) ?? '' }
async function refreshDevices() {
  if (!microphones.value.length) return
  const request = ++listing
  try {
    const available = await listAudioInputs()
    if (!disposed && request === listing) { devices.value = available; enumerationError.value = '' }
  } catch (cause) { if (!disposed && request === listing) enumerationError.value = `Could not list microphones: ${cause instanceof Error ? cause.message : String(cause)}` }
}
async function selectDevice(id: string, event: Event) {
  const previous = selectedDevice(id)
  const deviceId = (event.target as HTMLSelectElement).value
  inputs.value[id] = deviceId
  if (phase.value !== 'recording' || !live.value) return
  switching.value[id] = true; deviceError.value = ''
  try { await live.value.execution.switchAudioInput(id, deviceId) }
  catch (cause) {
    inputs.value[id] = previous
    deviceError.value = `${cause instanceof Error ? cause.message : String(cause)}${phase.value === 'recording' ? ' The previous input is still selected.' : ''}`
  } finally { switching.value[id] = false; if (!disposed) void refreshDevices() }
}
watch(phase, value => { if (value === 'recording') void refreshDevices() })
onMounted(() => { void refreshDevices(); navigator.mediaDevices?.addEventListener('devicechange', refreshDevices) })

const loadingArtifact = ref(false)
const artifactError = ref('')
const artifactPreview = ref<{ id: string; name: string; mime: string; url?: string; text?: string }>()
let artifactRequest: AbortController | undefined
const artifactUrl = (artifact: IoArtifact) => apiUrl(props.base, `/api/io/runs/${encodeURIComponent(run.value.id)}/artifacts/${encodeURIComponent(artifact.id)}`).toString()
async function previewArtifact(artifact: IoArtifact) {
  artifactRequest?.abort()
  if (artifactPreview.value?.url) URL.revokeObjectURL(artifactPreview.value.url)
  artifactPreview.value = undefined
  const request = artifactRequest = new AbortController()
  loadingArtifact.value = true; artifactError.value = ''
  try {
    const response = await fetch(artifactUrl(artifact), { signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) })
    if (!response.ok || !response.body) throw new Error('Could not open the recording. Try downloading it.')
    const reader = response.body.getReader()
    const chunks: BlobPart[] = []
    let bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > IO_MAX_BUFFER_BYTES) { await reader.cancel(); throw new Error('This file is too large for inline playback. Download it instead.') }
        chunks.push(part.value as BlobPart)
      }
    } finally { reader.releaseLock() }
    if (request.signal.aborted || disposed) return
    const blob = new Blob(chunks, { type: artifact.mime })
    artifactPreview.value = { id: artifact.id, name: artifact.name, mime: artifact.mime,
      ...(playableMime(artifact.mime) === 'text' ? { text: (await blob.text()).slice(-16_000) } : { url: URL.createObjectURL(blob) }) }
  } catch (cause) { if (!request.signal.aborted) artifactError.value = cause instanceof Error ? cause.message : 'Could not open the result.' }
  finally { if (artifactRequest === request) loadingArtifact.value = false }
}
watch(() => [run.value.status, run.value.artifacts[0]?.id], () => {
  const artifact = run.value.artifacts[0]
  if (live.value && run.value.status === 'completed' && artifact && playableMime(artifact.mime) && artifact.size <= IO_MAX_BUFFER_BYTES && artifactPreview.value?.id !== artifact.id && !loadingArtifact.value) void previewArtifact(artifact)
}, { immediate: true })
onBeforeUnmount(() => {
  disposed = true; listing++
  navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices)
  artifactRequest?.abort()
  if (artifactPreview.value?.url) URL.revokeObjectURL(artifactPreview.value.url)
})
</script>

<style scoped>
.io-request { max-width: 680px; min-width: 0; margin: 14px 0 22px; padding: 16px 18px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); color: var(--c-text); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.request-heading { display: flex; align-items: center; gap: 10px; }
.request-icon { flex: 0 0 18px; width: 18px; height: 18px; color: var(--c-text-secondary); }
.request-heading h3 { flex: 1; min-width: 0; margin: 0; font-size: 14px; font-weight: 600; }
.request-state { flex: 0 0 auto; font-size: 12px; color: var(--c-text-secondary); }
.request-state.recording { color: var(--c-error); }
.request-purpose { margin: 12px 0 4px; }
.request-scope, .request-note { margin: 6px 0; color: var(--c-text-secondary); font-size: 12px; }
.request-error { margin: 10px 0; color: var(--c-error); }
.request-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.request-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 6px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
.request-button.primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); border-color: transparent; }
.request-button.quiet { background: transparent; border-color: transparent; color: var(--c-text-secondary); }
.request-button:hover:not(:disabled) { filter: brightness(1.12); }
.request-button.quiet:hover { color: var(--c-text); background: var(--c-bg-muted); }
.request-button:disabled { opacity: 0.5; cursor: not-allowed; }
.input-devices { margin-top: 14px; }
.input-device { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--c-text-secondary); }
.input-device select { max-width: 100%; min-width: 0; flex: 1; padding: 7px 28px 7px 9px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; }
.capture-preview { display: flex; flex-direction: column; gap: 8px; margin: 16px 0; }
.audio-level { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--c-text-secondary); }
.audio-level meter { flex: 1; min-width: 0; height: 12px; accent-color: var(--c-blue); }
.capture-time { align-self: flex-end; color: var(--c-text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.backend-controls { margin: 14px 0; }
.backend-message { margin: 10px 0; }
.input-form { display: grid; gap: 8px; margin: 12px 0; }
.input-form textarea { width: 100%; padding: 8px; background: var(--c-bg-input); color: var(--c-text); border: 1px solid var(--c-border); border-radius: var(--radius-control); resize: vertical; font: inherit; }
.input-form button { justify-self: start; }
.capture-artifact { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.capture-artifact > div { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.capture-artifact strong { font-size: 13px; font-weight: 500; }
.capture-artifact small { color: var(--c-text-secondary); }
.capture-details { margin-top: 12px; color: var(--c-text-secondary); font-size: 12px; }
.capture-details summary { width: fit-content; padding: 4px 0; cursor: pointer; }
.capture-details dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 10px 0; }
.capture-details dd { margin: 0; overflow-wrap: anywhere; }
.capture-details p { margin: 10px 0; }
.io-request :is(button, a, select, textarea, summary):focus-visible { outline: 2px solid var(--c-blue); outline-offset: 3px; }
.loading-icon { display: inline-block; width: 14px; height: 14px; animation: input-spin 1s linear infinite; }
@keyframes input-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .loading-icon { animation: none; } }
@media (max-width: 480px) { .io-request { padding: 14px 12px; } .request-heading { align-items: flex-start; flex-wrap: wrap; } .request-heading h3 { flex-basis: calc(100% - 30px); } .request-state { margin-left: 28px; } .request-button { min-height: 40px; } .input-device select { font-size: 16px; } .capture-artifact { flex-wrap: wrap; } }
</style>
