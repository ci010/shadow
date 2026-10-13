import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { registerAudioRoutes } from './routes.ts'
import type { AudioCppService } from './service.ts'
import { pcm16Wav, isDigitalSilence } from './pcm.ts'

test('PCM WAV and silence gate do not pretend to be VAD', () => {
  assert.equal(isDigitalSilence(Buffer.alloc(20)), true)
  assert.equal(isDigitalSilence(Buffer.from([1, 0])), false)
  const wav = pcm16Wav(Buffer.from([1, 0]))
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(40), 2)
  assert.throws(() => pcm16Wav(Buffer.alloc(1)))
})

test('authenticated stream: ready, cumulative partial snapshots, exact whole-clip correction and cleanup', async () => {
  const root = await mkdtemp(join(process.cwd(), '.audio-stream-test-'))
  let partial!: (text: string) => void; let close!: () => void; let correctCount = 0
  const closed = new Promise<void>(resolve => { close = resolve })
  const service = {
    openTranscriptionStream: async (_signal: AbortSignal, callback: typeof partial) => {
      partial = callback
      return { stream: { closed, write: async () => { partial('word'); partial(' two') }, finish: async () => { close() } },
        correct: async (input: string) => { correctCount++; assert.equal((await readFile(input)).readUInt32LE(40), 2); return ' Whole clip.\n' } }
    },
  } as unknown as AudioCppService
  const app = new Hono(); const headers = { Authorization: 'Bearer test' }
  const routes = registerAudioRoutes(app, service, root, req => req.headers.get('Authorization') === 'Bearer test', { sessionExists: id => id === 'test' })
  try {
    assert.equal((await app.request('/api/audio/streams', { method: 'POST', body: '{}' })).status, 401)
    assert.equal((await app.request('/api/audio/streams', { method: 'POST', headers, body: '{"sessionId":"missing"}' })).status, 400)
    const created = await app.request('/api/audio/streams', { method: 'POST', headers, body: '{"sessionId":"test"}' })
    assert.equal(created.status, 201)
    const { id } = await created.json() as { id: string }
    const base = `/api/audio/streams/${id}`
    assert.equal((await app.request('/api/audio/streams', { method: 'POST', headers, body: '{"sessionId":"test"}' })).status, 429)
    assert.equal((await app.request(`${base}/audio?sequence=0`, { method: 'PUT', headers, body: Buffer.from([1, 0]) })).status, 409)
    const events = await app.request(`${base}/events`, { headers })
    const reader = events.body!.getReader(); const decoder = new TextDecoder()
    assert.match(decoder.decode((await reader.read()).value), /"type":"ready"/)
    assert.equal((await app.request(`${base}/events`, { headers })).status, 409)
    const pcmHeaders = { ...headers, 'Content-Type': 'application/octet-stream' }
    assert.equal((await app.request(`${base}/audio?sequence=1`, { method: 'PUT', headers: pcmHeaders, body: Buffer.from([1, 0]) })).status, 409)
    assert.equal((await app.request(`${base}/audio?sequence=0`, { method: 'PUT', headers: pcmHeaders, body: Buffer.from([1]) })).status, 400)
    assert.equal((await app.request(`${base}/audio?sequence=0`, { method: 'PUT', headers: pcmHeaders, body: Buffer.from([1, 0]) })).status, 200)
    assert.equal((await app.request(`${base}/finish`, { method: 'POST', headers })).status, 202)
    let text = ''
    while (true) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value) }
    assert.match(text, /"type":"partial","revision":1,"text":"word"/)
    assert.match(text, /"type":"partial","revision":2,"text":"word two"/)
    assert.match(text, /"type":"final","revision":3,"text":" Whole clip.\\n"/)
    assert.equal(correctCount, 1)
    // close awaits any pending temp-file cleanup, not merely a terminal event.
    await routes.close(); assert.deepEqual(await readdir(root), [])
  } finally { close(); await routes.close(); await rm(root, { recursive: true, force: true }) }
})

test('unsupported local model does not fall back; cancellation aborts CLI and session lifecycle', async () => {
  const app = new Hono(); const headers = { Authorization: 'ok' }
  let signal!: AbortSignal; let sessionClosed!: (id: string) => void
  let rejectOpen = true
  const service = { openTranscriptionStream: async (s: AbortSignal) => {
    if (rejectOpen) throw new Error('remote route')
    signal = s
    const closed = new Promise<void>(resolve => s.addEventListener('abort', () => resolve(), { once: true }))
    return { stream: { closed, write: async () => {}, finish: async () => {} }, correct: async () => '' }
  } } as unknown as AudioCppService
  const routes = registerAudioRoutes(app, service, '.', req => req.headers.get('Authorization') === 'ok', {
    sessionExists: () => true, subscribeSessionClosed: callback => { sessionClosed = callback; return () => {} },
  })
  try {
    assert.equal((await app.request('/api/audio/streams', { method: 'POST', headers, body: '{"sessionId":"test"}' })).status, 409)
    rejectOpen = false
    const { id } = await (await app.request('/api/audio/streams', { method: 'POST', headers, body: '{"sessionId":"test"}' })).json() as { id: string }
    sessionClosed('test'); assert.equal(signal.aborted, true)
    assert.equal((await app.request(`/api/audio/streams/${id}/finish`, { method: 'POST', headers })).status, 409)
  } finally { await routes.close() }
})

test('bounds reject oversized ingress; digital zero returns empty final without ASR correction; SSE disconnect aborts', async () => {
  const app = new Hono(); let corrected = 0; let signal!: AbortSignal
  const service = { openTranscriptionStream: async (s: AbortSignal) => {
    signal = s
    let close!: () => void; const closed = new Promise<void>(resolve => { close = resolve })
    s.addEventListener('abort', close, { once: true })
    return { stream: { closed, write: async () => {}, finish: async () => close() }, correct: async () => { corrected++; return 'incorrect' } }
  } } as unknown as AudioCppService
  const routes = registerAudioRoutes(app, service, '.', () => true, { sessionExists: () => true })
  const create = async () => {
    const result = await app.request('/api/audio/streams', { method: 'POST', body: '{"sessionId":"test"}' })
    assert.equal(result.status, 201); const { id } = await result.json() as { id: string }; return `/api/audio/streams/${id}`
  }
  try {
    assert.equal((await app.request('/api/audio/streams', { method: 'POST', body: 'a'.repeat(1025) })).status, 400)
    let base = await create()
    let response = await app.request(`${base}/events`); let reader = response.body!.getReader(); await reader.read()
    assert.equal((await app.request(`${base}/audio?sequence=0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(65538) })).status, 413)
    assert.equal(signal.aborted, true); await reader.cancel()
    base = await create()
    response = await app.request(`${base}/events`); reader = response.body!.getReader(); await reader.read()
    assert.equal((await app.request(`${base}/audio?sequence=0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(3200) })).status, 200)
    assert.equal((await app.request(`${base}/finish`, { method: 'POST' })).status, 202)
    let result = ''; while (true) { const chunk = await reader.read(); if (chunk.done) break; result += new TextDecoder().decode(chunk.value) }
    assert.match(result, /"type":"final","revision":1,"text":"","noSpeech":true/); assert.equal(corrected, 0)
    base = await create()
    response = await app.request(`${base}/events`); reader = response.body!.getReader(); await reader.read()
    await reader.cancel(); assert.equal(signal.aborted, true)
  } finally { await routes.close() }
})
