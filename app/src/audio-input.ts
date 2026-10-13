import { desktopMediaBridge } from './io/desktop.ts'
import { createUuid } from './uuid.ts'
import { AudioSignalMeter, resampleMono } from './audio-signal.ts'

export interface AudioStatus { asr: { ready: boolean; route: 'local' | 'remote' }; tts: { ready: boolean; route: 'local' | 'remote' } }
export function audioEntry(status: AudioStatus): 'local-ready' | 'remote-ready' | 'setup' {
  return status.asr.ready ? status.asr.route === 'local' ? 'local-ready' : 'remote-ready' : 'setup'
}
/** Suppress empty/punctuation-only ASR artifacts, not a voice-activity detector.
 * Unicode punctuation covers fullwidth/CJK marks; symbols and all scripts remain valid.
 */
export function recognizedTranscript(value: string): string {
  const text = value.trim()
  return /[^\p{P}\s]/u.test(text) ? text : ''
}
export function pcmWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, i) => { const n = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, n < 0 ? n * 32768 : n * 32767, true) })
  return new Blob([buffer], { type: 'audio/wav' })
}

export interface CaptureOptions {
  onLevel?: (level: number) => void
  /** Actual-rate mono Float32 blocks. Consumer must resample before PCM16 ingress. */
  onSamples?: (samples: Float32Array, sampleRate: number) => void
}
export class NoAudioSignalError extends Error { constructor() { super('No speech recognized. Try again.'); this.name = 'NoAudioSignalError' } }
/** A gesture-time reservation opens no microphone. Hold timers only consume it.
 * Resuming WebAudio and asking preload for trust must happen before delays/awaits.
 */
export interface MicrophonePreparation {
  readonly context: AudioContext
  claim(): Promise<void>
  cancel(): void
}
export function prepareMicrophone(): MicrophonePreparation {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error('Microphone requires a supported browser and secure context.')
  const bridge = desktopMediaBridge()
  if (window.shadowDesktop && !bridge) throw new Error('This desktop build lacks trusted microphone grants. Update the desktop app.')
  const runId = `composer-audio-${createUuid()}`
  // Composer-specific host approval covers touch pointerdown and modifier keys,
  // which Chromium does not count as transient userActivation. Old hosts retain
  // the strict Start path (and reject unsupported gestures rather than bypass it).
  const grant = bridge ? (bridge.armComposerMicrophone ?? bridge.arm)({ runId, capabilities: ['microphone'], durationMs: 65_000 }) : Promise.resolve(undefined)
  let context: AudioContext
  try { context = new AudioContext() }
  catch (error) { void grant.then(() => bridge?.revoke({ runId })).catch(() => {}); throw error }
  let cancelled = false, claimed = false, expiresAt = Infinity
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    void context.close().catch(() => {})
    // Also revoke after a late IPC acknowledgement; cancellation cannot leave a
    // grant behind if arm was queued when the component was hidden or unmounted.
    void bridge?.revoke({ runId }).catch(() => {})
    void grant.then(() => bridge?.revoke({ runId })).catch(() => {})
  }
  const ready = Promise.all([grant.then(value => { expiresAt = value?.expiresAt ?? Infinity }), context.resume()]).then(() => {
    if (cancelled || expiresAt <= Date.now()) throw new Error('Microphone reservation expired or cancelled')
  }).catch(error => { cancel(); throw error })
  void ready.catch(() => {}) // a short hold may cancel without ever claiming
  return { context, cancel, claim: async () => {
    if (claimed || cancelled) throw new Error('Microphone reservation expired or cancelled')
    claimed = true
    await ready
    if (cancelled || expiresAt <= Date.now()) throw new Error('Microphone reservation expired or cancelled')
  } }
}
/** Explicit action only. Worklet preferred; ScriptProcessor fallback for older hosts. */
export async function recordMicrophone(signal?: AbortSignal, options: CaptureOptions = {}, preparation?: MicrophonePreparation): Promise<{ stop: () => Promise<Blob>; cancel: () => void }> {
  if (signal?.aborted) { preparation?.cancel(); signal.throwIfAborted() }
  const prepared = preparation ?? prepareMicrophone()
  const context = prepared.context
  let stream: MediaStream | undefined, source: MediaStreamAudioSourceNode | undefined
  let processor: AudioWorkletNode | ScriptProcessorNode | undefined, sink: GainNode | undefined
  let closed = false, length = 0, flush: (() => void) | undefined
  const chunks: Float32Array[] = [], meter = new AudioSignalMeter(context.sampleRate)
  const cleanup = () => {
    if (closed) return
    closed = true; flush?.(); flush = undefined
    processor?.disconnect(); source?.disconnect(); sink?.disconnect()
    if (typeof AudioWorkletNode !== 'undefined' && processor instanceof AudioWorkletNode) { processor.port.onmessage = null; processor.port.close() }
    else if (processor) (processor as ScriptProcessorNode).onaudioprocess = null
    stream?.getTracks().forEach(track => track.stop())
    prepared.cancel()
    signal?.removeEventListener('abort', cleanup); options.onLevel?.(0)
  }
  signal?.addEventListener('abort', cleanup, { once: true })
  const collect = (samples: Float32Array) => {
    if (closed || length >= context.sampleRate * 60) return
    const data = samples.slice(0, context.sampleRate * 60 - length)
    chunks.push(data); length += data.length
    const level = meter.push(data)
    options.onLevel?.(level); options.onSamples?.(data, context.sampleRate)
  }
  try {
    await prepared.claim()
    if (closed || signal?.aborted) { signal?.throwIfAborted(); throw new Error('Recording cancelled') }
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
    // Cancellation while the permission dialog is pending must stop late tracks.
    if (closed || signal?.aborted) { stream.getTracks().forEach(track => track.stop()); signal?.throwIfAborted(); throw new Error('Recording cancelled') }
    source = context.createMediaStreamSource(stream)
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await context.audioWorklet.addModule(new URL('./audio-capture-worklet.js?no-inline', import.meta.url).href)
        signal?.throwIfAborted()
        processor = new AudioWorkletNode(context, 'shadow-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
        processor.port.onmessage = event => { if (event.data.stopped) flush?.(); else if (event.data.samples instanceof Float32Array) collect(event.data.samples) }
      } catch (error) { signal?.throwIfAborted(); if (closed) throw error /* unsupported worklet: use fallback below */ }
    }
    if (!processor) {
      const legacy = context.createScriptProcessor(2048, 1, 1)
      legacy.onaudioprocess = event => collect(event.inputBuffer.getChannelData(0))
      processor = legacy
    }
    // A connected muted output keeps processing active without microphone playback.
    sink = context.createGain(); sink.gain.value = 0
    source.connect(processor); processor.connect(sink); sink.connect(context.destination)
    return { cancel: cleanup, stop: async () => {
      if (closed) throw new Error('Recording cancelled')
      if (typeof AudioWorkletNode !== 'undefined' && processor instanceof AudioWorkletNode) {
        const node = processor
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { flush = undefined; resolve() }, 250)
          flush = () => { clearTimeout(timer); flush = undefined; resolve() }
          node.port.postMessage('stop')
        })
      }
      if (closed || signal?.aborted) throw new Error('Recording cancelled')
      const valid = meter.hasSignal
      cleanup()
      if (!valid) throw new NoAudioSignalError()
      const samples = new Float32Array(length); let offset = 0
      for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length }
      return pcmWav(resampleMono(samples, context.sampleRate), 16000)
    } }
  } catch (error) { cleanup(); stream?.getTracks().forEach(track => track.stop()); throw error }
}
