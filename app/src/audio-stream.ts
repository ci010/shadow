import { apiUrl } from './api-url.ts'
import { Pcm16StreamConverter } from './audio-signal.ts'

export interface TranscriptEvent { type: 'ready' | 'partial' | 'final' | 'error' | 'cancelled'; text?: string; revision?: number }
/** Local buffered-window stream. Preview is never a draft mutation. */
export async function openAudioStream(base: string, sessionId: string, signal: AbortSignal, partial: (text: string) => void) {
  const response = await fetch(apiUrl(base, '/api/audio/streams'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }), signal })
  if (response.status === 404 || response.status === 501) return undefined // older backend: existing final WAV path
  if (!response.ok) throw new Error('Unable to start local transcription stream.')
  const value = await response.json()
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id)) throw new Error('Invalid transcription stream response.')
  const path = `/api/audio/streams/${value.id}`
  if (value.mode !== 'buffered-window' || value.format !== 's16le' || value.sampleRate !== 16000 || value.channels !== 1 || value.windowSeconds !== 3) {
    void fetch(apiUrl(base, path), { method: 'DELETE', keepalive: true }).catch(() => {})
    throw new Error('Invalid transcription stream response.')
  }
  let converter: Pcm16StreamConverter | undefined, sequence = 0, revision = -1, sent = 0
  let failed: Error | undefined, done = false, result: string | undefined
  let chain = Promise.resolve(), wake: (() => void) | undefined
  let ready = false, wakeReady: (() => void) | undefined
  const child = new AbortController()
  let cancelled = false, eventReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancel = () => {
    if (cancelled) return
    cancelled = true; signal.removeEventListener('abort', cancel)
    void eventReader?.cancel().catch(() => {})
    child.abort(); void fetch(apiUrl(base, path), { method: 'DELETE', keepalive: true }).catch(() => {})
    if (!done) { failed = new Error('Recording cancelled'); wake?.(); wakeReady?.() }
  }
  signal.addEventListener('abort', cancel, { once: true })
  const fail = (error: unknown) => { failed ??= error instanceof Error ? error : new Error('Transcription stream failed.'); wake?.(); wakeReady?.() }
  try {
    signal.throwIfAborted()
    const events = await fetch(apiUrl(base, `${path}/events`), { signal: child.signal, headers: { Accept: 'text/event-stream' } })
    if (!events.ok || !events.body) throw new Error('Unable to subscribe to transcription stream.')
    const reader = events.body.getReader(); eventReader = reader
    void (async () => {
      const decoder = new TextDecoder(); let buffer = ''
      try {
        while (!done) {
          const next = await reader.read()
          if (next.done) { if (!done) throw new Error('Transcription stream disconnected.'); break }
          buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, '\n')
          if (buffer.length > 512 * 1024) throw new Error('Transcription event exceeds limit.')
          let end: number
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
            if (!block.split('\n').some(line => line === 'event: transcript')) continue
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
            const event = JSON.parse(data) as TranscriptEvent & { type: string }
            if (event.type === 'ready') {
              if (ready || event.revision !== 0) throw new Error('Invalid transcription ready event.')
              ready = true; wakeReady?.(); continue
            }
            if (!ready) throw new Error('Transcription event arrived before readiness.')
            if (event.type === 'error' || event.type === 'cancelled') throw new Error(event.type === 'cancelled' ? 'Recording cancelled' : 'Local transcription failed.')
            if ((event.type !== 'partial' && event.type !== 'final') || typeof event.text !== 'string' || event.text.length > 65536 || !Number.isInteger(event.revision)) throw new Error('Invalid transcription event.')
            if (event.revision! <= revision) continue
            revision = event.revision!
            if (event.type === 'partial') partial(event.text)
            else { result = event.text; done = true; wake?.(); wakeReady?.(); break }
          }
        }
      } catch (error) { if (!done) fail(error) }
      finally { void reader.cancel().catch(() => {}) }
    })()
    if (!ready && !failed) await new Promise<void>(resolve => {
      const timer = setTimeout(() => fail(new Error('Transcription stream readiness timed out.')), 10000)
      wakeReady = () => { clearTimeout(timer); resolve() }
      if (ready || failed) wakeReady()
    })
    if (failed) throw failed
    const send = (bytes: Uint8Array) => {
      for (let offset = 0; offset < bytes.length; offset += 64000) {
        const chunk = bytes.slice(offset, offset + 64000)
        sent += chunk.length
        if (sent > 16000 * 2 * 60) { fail(new Error('Recording limit reached.')); return }
        const ownSequence = sequence++, expectedBytes = sent
        chain = chain.then(async () => {
          if (failed) return
          const reply = await fetch(apiUrl(base, `${path}/audio`, { sequence: String(ownSequence) }), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk, signal: child.signal })
          if (!reply.ok) throw new Error('Audio stream upload failed.')
          const ack = await reply.json()
          if (ack.sequence !== ownSequence + 1 || ack.receivedBytes !== expectedBytes) throw new Error('Invalid audio stream acknowledgement.')
        }).catch(fail)
      }
    }
    return {
      push(samples: Float32Array, rate: number) {
        converter ??= new Pcm16StreamConverter(rate)
        if (converter.sampleRate !== rate) { fail(new Error('Microphone sample rate changed.')); return }
        send(converter.push(samples))
      },
      cancel,
      async finish(): Promise<string> {
        if (converter) send(converter.push(new Float32Array(0), true))
        await chain
        if (failed) throw failed
        const reply = await fetch(apiUrl(base, `${path}/finish`), { method: 'POST', signal: child.signal })
        if (!reply.ok) throw new Error('Unable to finish transcription stream.')
        if (!done && !failed) await new Promise<void>(resolve => {
          const timer = setTimeout(() => { fail(new Error('Local transcription timed out.')) }, 180000)
          wake = () => { clearTimeout(timer); resolve() }
          if (done || failed) wake()
        })
        signal.removeEventListener('abort', cancel)
        if (failed) throw failed
        return result ?? ''
      },
    }
  } catch (error) { cancel(); signal.removeEventListener('abort', cancel); throw error }
}
