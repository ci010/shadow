import { Hono } from 'hono'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioCppService } from './service.ts'
import { registerAudioStreamRoutes, type AudioStreamLifecycle } from './stream-routes.ts'

/** Project-owned ephemeral audio input. Never accepts caller-supplied filesystem paths. */
export function registerAudioRoutes(app: Hono, service: AudioCppService, temp: string, authorize: (request: Request) => boolean | Promise<boolean>, lifecycle: AudioStreamLifecycle = {}) {
  let pending = false
  app.use('/api/audio/*', async (c, next) => {
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
    c.header('Cache-Control', 'no-store')
    return next()
  })
  const streams = registerAudioStreamRoutes(app, service, temp, () => pending, lifecycle)
  app.get('/api/audio/status', async c => {
    try {
      const status = await service.status()
      const route = status.routes.asr ?? 'local'
      return c.json({ asr: { route, ready: route === 'remote' ? !!status.remote.asr : lifecycle.localInferenceAllowed !== false && status.status === 'available' && status.models.asr.status === 'path_accessible' }, tts: { route: status.routes.tts ?? 'local', ready: status.routes.tts === 'remote' ? !!status.remote.tts : lifecycle.localInferenceAllowed !== false && status.status === 'available' && status.models.tts.status === 'path_accessible' } })
    } catch { return c.json({ error: 'Unable to read Project audio configuration.' }, 503) }
  })
  app.post('/api/audio/transcribe', async c => {
    if (lifecycle.localInferenceAllowed === false) return c.json({ error: 'Local audio execution is disabled on this host.' }, 409)
    if (pending || streams.busy()) return c.json({ error: 'Audio transcription is busy.' }, 429)
    // This composer entry is intentionally local-only; never silently uploads to an API.
    pending = true
    let directory: string | undefined
    try {
      const config = await service.read()
      if (config.routes?.asr === 'remote') return c.json({ error: 'Composer microphone transcription currently requires local ASR.' }, 409)
      if (c.req.header('Content-Type') !== 'audio/wav') return c.json({ error: 'Expected WAV audio.' }, 415)
      const reader = c.req.raw.body?.getReader()
      if (!reader) return c.json({ error: 'Missing audio.' }, 400)
      const chunks: Uint8Array[] = []; let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 10 * 1024 * 1024) { await reader.cancel(); return c.json({ error: 'Audio exceeds 10 MiB.' }, 413) }
          chunks.push(chunk.value)
        }
      } finally { reader.releaseLock() }
      const wav = Buffer.concat(chunks)
      if (wav.length <= 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return c.json({ error: 'Invalid WAV audio.' }, 400)
      await mkdir(temp, { recursive: true })
      directory = await mkdtemp(join(temp, 'composer-audio-'))
      const input = join(directory, 'input.wav')
      await writeFile(input, wav, { mode: 0o600 })
      const text = await service.transcribe(input, c.req.raw.signal, 'local')
      return c.json({ text })
    } catch { return c.json({ error: 'Local transcription failed. Check Project audio settings.' }, 503) }
    finally { pending = false; if (directory) await rm(directory, { recursive: true, force: true }) }
  })
  return streams
}
