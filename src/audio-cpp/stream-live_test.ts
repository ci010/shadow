import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerAudioRoutes } from './routes.ts'
import { AudioCppService } from './service.ts'
import { pcm16Wav } from './pcm.ts'

/** Opt-in; existing approved public WAV and existing local configuration only. Downloads nothing. */
test('live SenseVoice stdin buffered partials plus whole-clip correction', {
  skip: !process.env.SHADOW_AUDIO_LIVE_PROJECT || !process.env.SHADOW_AUDIO_LIVE_SAMPLE,
  timeout: 120_000,
}, async () => {
  const wav = await readFile(process.env.SHADOW_AUDIO_LIVE_SAMPLE!)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  let offset = 12; let pcm: Buffer | undefined
  while (offset + 8 <= wav.length) {
    const length = wav.readUInt32LE(offset + 4); const name = wav.toString('ascii', offset, offset + 4)
    if (name === 'fmt ') {
      assert.equal(wav.readUInt16LE(offset + 8), 1); assert.equal(wav.readUInt16LE(offset + 10), 1)
      assert.equal(wav.readUInt32LE(offset + 12), 16000); assert.equal(wav.readUInt16LE(offset + 22), 16)
    }
    if (name === 'data') pcm = wav.subarray(offset + 8, offset + 8 + length)
    offset += 8 + length + (length % 2)
  }
  assert.ok(pcm && pcm.length > 96000)
  pcm = pcm.subarray(0, 12 * 32000)
  const service = new AudioCppService(process.env.SHADOW_AUDIO_LIVE_PROJECT!)
  const controller = new AbortController(); const start = performance.now(); let finishedInput = false
  const partials: { ms: number; beforeFinish: boolean; delta: string }[] = []
  const opened = await service.openTranscriptionStream(controller.signal, delta => {
    const item = { ms: Math.round(performance.now() - start), beforeFinish: !finishedInput, delta }
    partials.push(item); console.log('live.partial', JSON.stringify(item))
  })
  await assert.rejects(service.transcribe(process.env.SHADOW_AUDIO_LIVE_SAMPLE!), /busy/)
  const directory = await mkdtemp(join(process.env.SHADOW_AUDIO_LIVE_PROJECT!, 'tmp', 'stream-live-'))
  try {
    for (let offset = 0; offset < pcm.length; offset += 32000) {
      await opened.stream.write(pcm.subarray(offset, offset + 32000))
      // Simulate live one-second chunks; no microphone and no remote upload.
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    // Keep stdin open briefly to prove the decoder is not merely EOF transcription.
    await new Promise(resolve => setTimeout(resolve, 3000))
    finishedInput = true; await opened.stream.finish()
    const input = join(directory, 'input.wav'); await writeFile(input, pcm16Wav(pcm))
    const final = await opened.correct(input)
    console.log('live.final', JSON.stringify({ elapsedMs: Math.round(performance.now() - start), audioSeconds: pcm.length / 32000, text: final }))
    assert.ok(partials.some(item => item.beforeFinish), 'No partial before stdin EOF')
    assert.ok(final.trim())
  } finally { controller.abort(); await opened.stream.closed.catch(() => {}); await opened.release(); await rm(directory, { recursive: true, force: true }) }
})

test('live digital silence CLI ingress finishes cleanly', { skip: !process.env.SHADOW_AUDIO_LIVE_PROJECT, timeout: 30_000 }, async () => {
  const service = new AudioCppService(process.env.SHADOW_AUDIO_LIVE_PROJECT!)
  const controller = new AbortController()
  const opened = await service.openTranscriptionStream(controller.signal, () => {})
  try { await opened.stream.write(Buffer.alloc(32000)); await opened.stream.finish() }
  finally { controller.abort(); await opened.stream.closed.catch(() => {}); await opened.release() }
})

test('live backend HTTP/SSE route contract with existing public clip', {
  skip: !process.env.SHADOW_AUDIO_LIVE_PROJECT || !process.env.SHADOW_AUDIO_LIVE_SAMPLE, timeout: 120_000,
}, async () => {
  const project = process.env.SHADOW_AUDIO_LIVE_PROJECT!
  const wav = await readFile(process.env.SHADOW_AUDIO_LIVE_SAMPLE!)
  let pcm: Buffer | undefined
  for (let offset = 12; offset + 8 <= wav.length;) {
    const length = wav.readUInt32LE(offset + 4)
    if (wav.toString('ascii', offset, offset + 4) === 'data') pcm = wav.subarray(offset + 8, offset + 8 + length)
    offset += 8 + length + (length % 2)
  }
  assert.ok(pcm && pcm.length <= 12 * 32000)
  const app = new Hono(); const service = new AudioCppService(project)
  const routes = registerAudioRoutes(app, service, join(project, 'tmp'), () => true, { sessionExists: id => id === 'live-public-fixture' })
  const start = performance.now(); let beforeFinish = true; let firstPartialBeforeFinish = false
  try {
    const created = await app.request('/api/audio/streams', { method: 'POST', body: '{"sessionId":"live-public-fixture"}' })
    assert.equal(created.status, 201); const { id } = await created.json() as { id: string }
    const base = `/api/audio/streams/${id}`
    const response = await app.request(`${base}/events`); const reader = response.body!.getReader()
    const ready = new TextDecoder().decode((await reader.read()).value); assert.match(ready, /"type":"ready"/)
    let result = ''
    const collect = (async () => {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break
        const text = new TextDecoder().decode(chunk.value); result += text
        if (text.includes('"type":"partial"') && beforeFinish) firstPartialBeforeFinish = true
        console.log('live.http.event', JSON.stringify({ ms: Math.round(performance.now() - start), beforeFinish, sse: text }))
      }
    })()
    let sequence = 0
    for (let offset = 0; offset < pcm.length; offset += 32000) {
      const upload = await app.request(`${base}/audio?sequence=${sequence++}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(pcm.subarray(offset, offset + 32000)) })
      assert.equal(upload.status, 200); await new Promise(resolve => setTimeout(resolve, 1000))
    }
    beforeFinish = false
    assert.equal((await app.request(`${base}/finish`, { method: 'POST' })).status, 202)
    await collect
    assert.equal(firstPartialBeforeFinish, true)
    assert.match(result, /"type":"final"/)
    assert.match(result, /Concord returned to its place amidst the tents\.\\r\\n/)
  } finally { await routes.close() }
})
