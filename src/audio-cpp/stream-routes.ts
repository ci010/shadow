import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AudioCppService } from './service.ts'
import { isDigitalSilence, pcm16Wav, PCM_BYTES_PER_SECOND } from './pcm.ts'

type Event = { type: 'ready' | 'partial' | 'final' | 'error' | 'cancelled'; revision: number; text?: string; code?: string; noSpeech?: boolean }
type Opened = Awaited<ReturnType<AudioCppService['openTranscriptionStream']>>
type Capture = {
  id: string; sessionId: string; controller: AbortController; opened?: Opened
  pcm: Buffer[]; bytes: number; sequence: number; uploading: boolean; finishing: boolean
  terminal: boolean; subscribed: boolean; event: Event; emit?: (event: Event) => void
  timer: ReturnType<typeof setTimeout>; job?: Promise<void>
}
export type AudioStreamLifecycle = {
  localInferenceAllowed?: boolean
  sessionExists?: (id: string) => boolean
  subscribeSessionClosed?: (cancel: (sessionId: string) => void) => () => void
}

/** Project-scoped bounded local PCM transport. Caller paths and remote routes are never accepted. */
export function registerAudioStreamRoutes(app: Hono, service: AudioCppService, temp: string,
  busy: () => boolean, lifecycle: AudioStreamLifecycle = {}) {
  let capture: Capture | undefined; let disposed = false; let creating = false
  const publish = (s: Capture, event: Event) => {
    if (s.terminal) return
    s.event = event
    if (['final', 'error', 'cancelled'].includes(event.type)) { s.terminal = true; clearTimeout(s.timer); s.pcm = [] }
    s.emit?.(event)
  }
  const cancel = async (s: Capture, code = 'cancelled') => {
    s.controller.abort(new Error(code))
    publish(s, { type: 'cancelled', revision: s.event.revision + 1, code })
    await s.opened?.stream.closed.catch(() => {})
    await s.job?.catch(() => {})
    await s.opened?.release?.()
  }
  const off = lifecycle.subscribeSessionClosed?.(id => { if (capture?.sessionId === id) void cancel(capture, 'session_closed') })
  const find = (id: string) => capture?.id === id ? capture : undefined
  app.post('/api/audio/streams', async c => {
    if (disposed) return c.json({ error: 'Project is closing.' }, 503)
    if (lifecycle.localInferenceAllowed === false) return c.json({ error: 'Local audio execution is disabled on this host.' }, 409)
    if (creating || busy() || (capture && !capture.terminal)) return c.json({ error: 'Audio transcription is busy.' }, 429)
    const length = c.req.header('Content-Length')
    if (length && Number(length) > 1024) return c.json({ error: 'Request too large.' }, 413)
    let body: unknown
    try { body = JSON.parse((await boundedBody(c.req.raw, 1024)).toString('utf8')) } catch { return c.json({ error: 'Invalid stream request.' }, 400) }
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => key !== 'sessionId') || !('sessionId' in body)
      || typeof body.sessionId !== 'string' || body.sessionId.length > 200 || !body.sessionId
      || (lifecycle.sessionExists && !lifecycle.sessionExists(body.sessionId))) return c.json({ error: 'Unknown session.' }, 400)
    if (creating || busy() || (capture && !capture.terminal)) return c.json({ error: 'Audio transcription is busy.' }, 429)
    creating = true
    if (capture) await cancel(capture)
    if (disposed || (capture && !capture.terminal)) { creating = false; return c.json({ error: 'Audio transcription is busy.' }, 429) }
    const controller = new AbortController()
    const s: Capture = { id: randomUUID(), sessionId: body.sessionId, controller, pcm: [], bytes: 0, sequence: 0,
      uploading: false, finishing: false, terminal: false, subscribed: false, event: { type: 'ready', revision: 0 },
      timer: setTimeout(() => { void cancel(s, 'capture_timeout') }, 120_000) }
    s.timer.unref(); capture = s
    const requestAborted = () => { void cancel(s, 'ingress_failed') }
    c.req.raw.signal.addEventListener('abort', requestAborted, { once: true })
    try {
      c.req.raw.signal.throwIfAborted()
      s.opened = await service.openTranscriptionStream(controller.signal, delta => {
        const text = (s.event.text ?? '') + delta
        if (text.length > 65536) { void cancel(s, 'text_limit'); return }
        publish(s, { type: 'partial', revision: s.event.revision + 1, text })
      })
      void s.opened.stream.closed.catch(() => {
        if (!s.controller.signal.aborted) { s.controller.abort(); publish(s, { type: 'error', revision: s.event.revision + 1, code: 'stream_failed' }); void s.opened?.release?.() }
      })
      if (s.controller.signal.aborted) { await cancel(s); return c.json({ error: 'Stream cancelled.' }, 409) }
      return c.json({ id: s.id, mode: 'buffered-window', windowSeconds: 3, format: 's16le', sampleRate: 16000, channels: 1,
        maxChunkBytes: 65536, maxAudioSeconds: 60, vad: 'unavailable', silenceGate: 'digital-zero-only' }, 201)
    } catch {
      publish(s, { type: 'error', revision: 1, code: 'unsupported_or_unavailable' })
      return c.json({ error: 'Streaming requires installed local SenseVoice and compatible options.', code: 'unsupported_or_unavailable' }, 409)
    } finally { c.req.raw.signal.removeEventListener('abort', requestAborted); creating = false }
  })
  app.get('/api/audio/streams/:id/events', c => {
    const s = find(c.req.param('id'))
    if (!s) return c.json({ error: 'Unknown stream.' }, 404)
    if (s.subscribed) return c.json({ error: 'Stream already subscribed.' }, 409)
    s.subscribed = true
    return streamSSE(c, async stream => {
      let chain = Promise.resolve(); let end!: () => void
      const ended = new Promise<void>(resolve => { end = resolve })
      const emit = (event: Event) => {
        chain = chain.then(() => stream.writeSSE({ event: 'transcript', id: String(event.revision), data: JSON.stringify(event) }))
        void chain.catch(() => { end(); void cancel(s, 'subscriber_disconnected') })
        if (['final', 'error', 'cancelled'].includes(event.type)) void chain.finally(end).catch(() => {})
      }
      s.emit = emit
      stream.onAbort(() => { end(); void cancel(s, 'subscriber_disconnected') })
      emit(s.event) // Ready is subscription acknowledgement; partials are cumulative snapshots.
      await ended
      s.emit = undefined
      await chain.catch(() => {})
    })
  })
  app.put('/api/audio/streams/:id/audio', async c => {
    const s = find(c.req.param('id'))
    if (!s) return c.json({ error: 'Unknown stream.' }, 404)
    if (s.terminal || s.finishing || !s.opened || !s.subscribed) return c.json({ error: 'Stream is not accepting audio.' }, 409)
    if (s.uploading) return c.json({ error: 'Chunk upload is busy.' }, 429)
    if (c.req.header('Content-Type') !== 'application/octet-stream') return c.json({ error: 'Expected raw s16le PCM.' }, 415)
    if (c.req.query('sequence') !== String(s.sequence)) return c.json({ error: 'Unexpected chunk sequence.' }, 409)
    s.uploading = true
    try {
      const pcm = Buffer.from(await boundedBody(c.req.raw, 65536, s.controller.signal))
      if (!pcm.length || pcm.length % 2) return c.json({ error: 'Expected complete nonempty PCM16 samples.' }, 400)
      if (s.bytes + pcm.length > 60 * PCM_BYTES_PER_SECOND) { await cancel(s, 'audio_limit'); return c.json({ error: 'Audio exceeds 60 seconds.' }, 413) }
      await s.opened.stream.write(pcm)
      s.controller.signal.throwIfAborted()
      s.pcm.push(pcm); s.bytes += pcm.length; s.sequence++
      return c.json({ sequence: s.sequence, receivedBytes: s.bytes })
    } catch { await cancel(s, 'ingress_failed'); return c.json({ error: 'PCM ingress failed or exceeded limit.' }, 413) }
    finally { s.uploading = false }
  })
  app.post('/api/audio/streams/:id/finish', c => {
    const s = find(c.req.param('id'))
    if (!s) return c.json({ error: 'Unknown stream.' }, 404)
    if (s.terminal || s.finishing || s.uploading || !s.opened || !s.subscribed) return c.json({ error: 'Stream cannot finish.' }, 409)
    s.finishing = true; clearTimeout(s.timer)
    s.timer = setTimeout(() => { void cancel(s, 'inference_timeout') }, 120_000); s.timer.unref()
    s.job = (async () => {
      let directory: string | undefined
      try {
        await s.opened!.stream.finish()
        s.controller.signal.throwIfAborted()
        const pcm = Buffer.concat(s.pcm)
        const noSpeech = isDigitalSilence(pcm)
        let text = ''
        if (!noSpeech) {
          await mkdir(temp, { recursive: true }); directory = await mkdtemp(join(temp, 'stream-audio-'))
          const input = join(directory, 'input.wav')
          await writeFile(input, pcm16Wav(pcm), { mode: 0o600 })
          text = await s.opened!.correct(input)
          if (text.length > 65536) throw new Error('Final transcript exceeds limit')
        }
        s.controller.signal.throwIfAborted()
        publish(s, { type: 'final', revision: s.event.revision + 1, text, ...(noSpeech ? { noSpeech: true } : {}) })
      } catch {
        if (!s.controller.signal.aborted) publish(s, { type: 'error', revision: s.event.revision + 1, code: 'final_failed' })
      } finally {
        try { if (directory) await rm(directory, { recursive: true, force: true }) }
        finally { await s.opened?.release?.() }
      }
    })()
    void s.job.catch(() => { console.error('[audio] Stream cleanup failed') })
    return c.json({ accepted: true }, 202)
  })
  app.delete('/api/audio/streams/:id', async c => {
    const s = find(c.req.param('id'))
    if (!s) return c.json({ error: 'Unknown stream.' }, 404)
    await cancel(s)
    return c.json({ cancelled: true })
  })
  return {
    busy: () => creating || (!!capture && !capture.terminal),
    close: async () => { disposed = true; off?.(); if (capture) await cancel(capture, 'project_closed'); capture = undefined },
  }
}

async function boundedBody(request: Request, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing body')
  const abort = AbortSignal.any([request.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])])
  const cancelled = () => { void reader.cancel(abort.reason).catch(() => {}) }
  abort.addEventListener('abort', cancelled, { once: true })
  const chunks: Uint8Array[] = []; let bytes = 0
  try {
    abort.throwIfAborted()
    while (true) {
      const chunk = await reader.read(); abort.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > limit) throw new Error('Body exceeds limit')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks)
  } finally { abort.removeEventListener('abort', cancelled); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
