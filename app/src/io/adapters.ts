import { IO_MAX_BUFFER_BYTES, IO_MAX_CHUNK_BYTES, type IoCapability, type IoPacket, type IoSource } from '../../../src/io/contracts.ts'
import { encodeBytes, ResourceScope } from './transport.ts'
import { MOBILE_CAPTURE_UNAVAILABLE, mobileCaptureIssue, mobileCaptureRestricted } from './mobile-policy.ts'

export function sourceCaptureLabel(source: IoSource): string {
  if (source.kind === 'camera' && source.audio) return 'camera + microphone'
  if (source.kind === 'screen' && source.audio) return 'screen + system/screen audio (OS-dependent)'
  return source.kind
}

export function browserIoCapabilities(): IoCapability[] {
  const mobile = mobileCaptureRestricted()
  const secure = globalThis.isSecureContext === true
  const devices = globalThis.navigator?.mediaDevices
  return [
    ...(['microphone', 'camera', 'screen', 'file', 'form'] as const).map(id => ({
      id, kind: 'source' as const, requiresGesture: id !== 'form',
      available: id === 'file' || id === 'form' || (!mobile && secure && !!(id === 'screen' ? devices?.getDisplayMedia : devices?.getUserMedia)),
      reason: id === 'file' || id === 'form' ? undefined : mobile ? MOBILE_CAPTURE_UNAVAILABLE : secure ? undefined : 'A secure local browser context is required.',
    })),
  ]
}

export interface CaptureSet {
  ready: Promise<void>
  start: (emit: (packet: IoPacket, bytes: number) => Promise<void>, fail: (error: Error) => void) => Promise<void>
  finish: () => Promise<void>
  close: () => void
  streams: Map<string, MediaStream>
  levels?: Map<string, number>
  /** Standalone microphones with stable Web Audio routing; camera/screen audio is not switchable. */
  audioInputs?: Map<string, string>
  switchAudioInput?: (sourceId: string, deviceId: string) => Promise<void>
}

export interface CaptureOptions { audioInputDevices?: Readonly<Record<string, string>> }

export async function listAudioInputs(): Promise<Array<{ deviceId: string; label: string }>> {
  if (mobileCaptureRestricted()) throw new Error(MOBILE_CAPTURE_UNAVAILABLE)
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter(device => device.kind === 'audioinput' && device.deviceId !== '')
    .map(device => ({ deviceId: device.deviceId, label: device.label }))
}

function audioConstraints(deviceId = ''): MediaTrackConstraints {
  return { channelCount: 1, ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}) }
}

interface AudioRoute {
  context: AudioContext
  physical?: MediaStream
  input?: MediaStreamAudioSourceNode
  bus?: GainNode
  destination?: MediaStreamAudioDestinationNode
  detach?: () => void
  generation: number
}

function pickFile(source: IoSource, scope: ResourceScope): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = source.accept ?? ''
    input.hidden = true
    document.body.append(input)
    let settled = false
    const cancel = () => { if (!settled) { settled = true; reject(new DOMException('File selection cancelled.', 'AbortError')) } }
    input.onchange = () => {
      if (settled) return
      const file = input.files?.[0]
      if (!file) { cancel(); return }
      settled = true
      resolve(file)
    }
    input.oncancel = cancel
    scope.add(() => { cancel(); input.remove() })
    input.click()
  })
}

/** Must be called directly within the trusted Start click, before any await/RPC. */
export function acquireIoSources(sources: IoSource[], options: CaptureOptions = {}): CaptureSet {
  const issue = mobileCaptureIssue(sources)
  if (issue) throw new Error(issue)
  for (const [id, deviceId] of Object.entries(options.audioInputDevices ?? {})) {
    if (typeof deviceId !== 'string') throw new TypeError('Audio input device IDs must be strings.')
    if (!sources.some(source => source.id === id && source.kind === 'microphone')) throw new Error(`Audio device selection is only supported for standalone microphones (${id}).`)
  }
  const scope = new ResourceScope()
  const streams = new Map<string, MediaStream>()
  const files = new Map<string, File>()
  const audioContexts = new Map<string, AudioContext>()
  const audioRoutes = new Map<string, AudioRoute>()
  const audioInputs = new Map<string, string>()
  const ownedAudio = new Set<MediaStream>()
  const levels = new Map<string, number>()
  const finalizers: Array<() => Promise<void>> = []
  let pending = Promise.resolve()
  let queued = 0
  let stopping = false
  let captureFail: ((error: Error) => void) | undefined
  const cancelled = () => new DOMException('Microphone switch was cancelled or superseded.', 'AbortError')
  const stopStream = (stream: MediaStream) => { for (const track of stream.getTracks()) if (track.readyState !== 'ended') track.stop() }
  const audioTrack = (stream: MediaStream) => stream.getAudioTracks()[0]
  const selectedId = (stream: MediaStream, requested = '') => audioTrack(stream)?.getSettings().deviceId || requested || 'default'
  const bindAudioEnded = (route: AudioRoute, sourceId: string) => {
    const stream = route.physical!
    const ended = () => {
      if (!scope.closed && !stopping && route.physical === stream) captureFail?.(new Error(`microphone ${sourceId} capture ended or permission was revoked.`))
    }
    for (const track of stream.getTracks()) track.addEventListener('ended', ended)
    route.detach = () => { for (const track of stream.getTracks()) track.removeEventListener('ended', ended) }
  }
  scope.add(() => {
    for (const route of audioRoutes.values()) {
      route.detach?.()
      route.input?.disconnect()
      route.bus?.disconnect()
      if (route.destination) stopStream(route.destination.stream)
    }
    for (const stream of ownedAudio) stopStream(stream)
    ownedAudio.clear()
  })
  const requests: Promise<void>[] = []
  const acquire = (source: IoSource): Promise<void> => {
    if (source.kind === 'form') return Promise.resolve()
    if (source.kind === 'file') return pickFile(source, scope).then(file => { files.set(source.id, file) })
    if (source.kind === 'microphone' && typeof AudioContext === 'function') {
      const context = new AudioContext()
      audioContexts.set(source.id, context)
      audioRoutes.set(source.id, { context, generation: 0 })
      scope.add(() => { void context.close() })
      void context.resume().catch(() => {})
    }
    const video = { width: { ideal: source.width ?? 640, max: source.width ?? 640 }, height: { ideal: source.height ?? 360, max: source.height ?? 360 }, frameRate: { max: 15 } }
    const request = source.kind === 'screen'
      ? navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: source.width ?? 640 }, height: { ideal: source.height ?? 360 }, frameRate: { max: 15 } }, audio: !!source.audio })
      : navigator.mediaDevices.getUserMedia(source.kind === 'microphone' ? { audio: audioConstraints(options.audioInputDevices?.[source.id]), video: false } : { video, audio: !!source.audio })
    return request.then(stream => {
      const route = audioRoutes.get(source.id)
      if (route) {
        if (scope.closed || stopping) { stopStream(stream); throw new Error('Capture was cancelled.') }
        ownedAudio.add(stream)
        const track = audioTrack(stream)
        if (!track || track.readyState === 'ended') throw new Error('Microphone did not provide a live audio track.')
        route.physical = stream
        audioInputs.set(source.id, selectedId(stream, options.audioInputDevices?.[source.id]))
        streams.set(source.id, stream)
        return
      }
      scope.add(() => { for (const track of stream.getTracks()) track.stop() })
      if (!scope.closed && source.audio && stream.getAudioTracks().length === 0) throw new Error(`${source.kind} audio was requested but no audio track was shared. Start a new request without audio or choose a supported source.`)
      if (!scope.closed) streams.set(source.id, stream)
    })
  }
  try {
    for (const source of sources) {
      const request = acquire(source)
      void request.catch(() => {})
      requests.push(request)
    }
  } catch (error) { scope.close(); throw error }
  const ready = Promise.all(requests).then(() => {
    if (scope.closed) throw new Error('Capture was cancelled.')
  }).catch(error => { scope.close(); throw error })
  void ready.catch(() => {})
  return {
    ready, streams, levels, audioInputs,
    async switchAudioInput(sourceId, deviceId) {
      if (typeof deviceId !== 'string') throw new TypeError('Audio input device IDs must be strings.')
      const route = audioRoutes.get(sourceId)
      if (!route) throw new Error('Live device switching requires a standalone microphone and Web Audio support. Camera and screen audio cannot be switched.')
      if (scope.closed || stopping) throw cancelled()
      const generation = ++route.generation
      await ready
      if (scope.closed || stopping || generation !== route.generation) throw cancelled()
      let replacement: MediaStream
      try {
        replacement = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId), video: false })
      } catch (error) {
        if (scope.closed || stopping || generation !== route.generation) throw cancelled()
        throw error
      }
      let input: MediaStreamAudioSourceNode | undefined
      let actualId: string
      try {
        if (scope.closed || stopping || generation !== route.generation) throw cancelled()
        const track = audioTrack(replacement)
        if (!track || track.readyState === 'ended') throw new Error('Selected microphone did not provide a live audio track.')
        actualId = selectedId(replacement, deviceId)
        if (route.bus) {
          input = route.context.createMediaStreamSource(replacement)
          input.connect(route.bus)
        }
      } catch (error) { input?.disconnect(); stopStream(replacement); throw error }
      const previous = route.physical!
      route.detach?.()
      route.input?.disconnect()
      route.physical = replacement
      route.input = input
      ownedAudio.add(replacement)
      if (route.bus) bindAudioEnded(route, sourceId)
      streams.set(sourceId, replacement)
      audioInputs.set(sourceId, actualId)
      ownedAudio.delete(previous)
      stopStream(previous)
    },
    close: () => { stopping = true; scope.close() },
    async finish() {
      stopping = true
      try {
        const finishing = finalizers.map(finalize => finalize())
        for (const stream of streams.values()) for (const track of stream.getTracks()) track.stop()
        for (const route of audioRoutes.values()) if (route.destination) stopStream(route.destination.stream)
        await Promise.all(finishing)
        await pending
      } finally { scope.close() }
    },
    async start(emit, fail) {
      await ready
      if (scope.closed || stopping) throw new Error('Capture was cancelled.')
      captureFail = fail
      const enqueue = (source: IoSource, blob: Blob, value?: unknown) => {
        if (scope.closed || !blob.size) return
        if (queued + blob.size > IO_MAX_BUFFER_BYTES / 2) { fail(new Error('Capture cannot keep up: its 4 MiB share of the input buffer is full.')); return }
        queued += blob.size
        pending = pending.then(async () => {
          if (scope.closed) return
          // Encoded images are atomic; recording/file streams may be split but never reordered.
          if (blob.type.startsWith('image/') && blob.size > IO_MAX_CHUNK_BYTES) throw new Error('Image exceeds 1 MiB. Reduce the capture dimensions.')
          for (let offset = 0; offset < blob.size && !scope.closed; offset += IO_MAX_CHUNK_BYTES) {
            const bytes = new Uint8Array(await blob.slice(offset, offset + IO_MAX_CHUNK_BYTES).arrayBuffer())
            await emit({ type: 'data', sourceId: source.id, mime: blob.type || 'application/octet-stream', base64: encodeBytes(bytes), timestamp: Date.now(), value }, bytes.byteLength)
          }
        }).finally(() => { queued -= blob.size })
        void pending.catch(error => { fail(error instanceof Error ? error : new Error(String(error))) })
      }
      for (const source of sources) {
        if (stopping || scope.closed) break
        const stream = streams.get(source.id)
        if (source.kind === 'file') {
          const file = files.get(source.id)!
          // Files are sliced lazily, avoiding a whole-file allocation.
          const fileDone = (async () => {
            if (file.size === 0) {
              await emit({ type: 'data', sourceId: source.id, mime: file.type || 'application/octet-stream', base64: '', value: { name: file.name, size: 0, offset: 0 }, timestamp: Date.now() }, 0)
            }
            let offset = 0
            for (; offset < file.size && !scope.closed && !stopping; offset += IO_MAX_CHUNK_BYTES) {
              enqueue(source, file.slice(offset, offset + IO_MAX_CHUNK_BYTES, file.type), { name: file.name, size: file.size, offset })
              await pending
            }
            if (offset < file.size) throw new Error('File input stopped before the complete file was read. The artifact is partial.')
          })()
          void fileDone.catch(error => fail(error instanceof Error ? error : new Error(String(error))))
          finalizers.push(() => fileDone)
          continue
        }
        if (!stream) continue
        if (source.kind === 'microphone' && audioContexts.has(source.id)) {
          const context = audioContexts.get(source.id)!
          const route = audioRoutes.get(source.id)!
          const bus = route.bus = context.createGain()
          bus.channelCount = 1
          bus.channelCountMode = 'explicit'
          const input = context.createMediaStreamSource(stream)
          route.input = input
          input.connect(bus)
          bindAudioEnded(route, source.id)
          const analyser = context.createAnalyser()
          analyser.fftSize = 256
          bus.connect(analyser)
          const samples = new Float32Array(analyser.fftSize)
          const meter = setInterval(() => {
            analyser.getFloatTimeDomainData(samples)
            levels.set(source.id, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length))
          }, 100)
          scope.add(() => { clearInterval(meter); analyser.disconnect(); levels.set(source.id, 0) })
        }
        for (const track of stream.getTracks()) {
          if (audioRoutes.has(source.id)) continue
          const ended = () => { if (!stopping) fail(new Error(`${source.kind} capture ended or permission was revoked.`)) }
          track.addEventListener('ended', ended)
          scope.add(() => track.removeEventListener('ended', ended))
        }
        if (source.kind === 'microphone' && source.mode === 'pcm') {
          const context = audioContexts.get(source.id)
          if (!context) throw new Error('PCM capture requires Web Audio support.')
          const bus = audioRoutes.get(source.id)!.bus!
          // A bounded ScriptProcessor is used for compatibility with packaged/offline contexts.
          const processor = context.createScriptProcessor(4096, 1, 1)
          const mute = context.createGain()
          mute.gain.value = 0
          bus.connect(processor); processor.connect(mute); mute.connect(context.destination)
          processor.onaudioprocess = event => {
            if (stopping) return
            const samples = event.inputBuffer.getChannelData(0)
            const buffer = new ArrayBuffer(samples.length * 2)
            const view = new DataView(buffer)
            for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true)
            enqueue(source, new Blob([buffer], { type: 'audio/pcm' }), { sampleRate: context.sampleRate, channels: 1, format: 's16le' })
          }
          scope.add(() => { processor.onaudioprocess = null; processor.disconnect(); mute.disconnect() })
        } else if (source.mode === 'frames') {
          const video = document.createElement('video')
          video.muted = true; video.playsInline = true; video.srcObject = stream
          await video.play()
          const canvas = document.createElement('canvas')
          canvas.width = source.width ?? 640; canvas.height = source.height ?? 360
          const context = canvas.getContext('2d')!
          let busy = false
          const timer = setInterval(() => {
            if (scope.closed || stopping || busy) return
            busy = true
            context.drawImage(video, 0, 0, canvas.width, canvas.height)
            canvas.toBlob(blob => { if (blob && !stopping) enqueue(source, blob, { width: canvas.width, height: canvas.height }); busy = false }, 'image/jpeg', 0.8)
          }, source.intervalMs ?? 1000)
          scope.add(() => { clearInterval(timer); video.pause(); video.srcObject = null })
        } else {
          if (typeof MediaRecorder !== 'function') throw new Error('Recording is unavailable in this browser.')
          const mimes = source.kind === 'microphone' ? ['audio/webm;codecs=opus', 'audio/mp4'] : ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
          const mimeType = mimes.find(mime => MediaRecorder.isTypeSupported(mime))
          if (!mimeType) throw new Error('No supported recording format is available.')
          const route = audioRoutes.get(source.id)
          let recordingStream = stream
          if (route) {
            const destination = route.destination = route.context.createMediaStreamDestination()
            destination.channelCount = 1
            route.bus!.connect(destination)
            recordingStream = destination.stream
          }
          const recorder = new MediaRecorder(recordingStream, { mimeType, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 })
          recorder.ondataavailable = event => enqueue(source, event.data, { container: true, settings: recordingStream.getTracks().map(track => track.getSettings()) })
          recorder.onerror = () => fail(new Error(`${source.kind} recording failed.`))
          const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve() })
          finalizers.push(async () => { if (recorder.state !== 'inactive') recorder.stop(); await stopped })
          scope.add(() => { if (recorder.state !== 'inactive') recorder.stop() })
          recorder.start(250)
        }
      }
    },
  }
}
