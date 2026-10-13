import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { registerAudioRoutes } from './routes.ts'
import type { AudioCppService } from './service.ts'
import { pcm16Wav } from './pcm.ts'

test('Project audio endpoint authenticates, redacts status, rejects remote route and cleans input', async () => {
  const root = await mkdtemp(join(process.cwd(), '.audio-route-test-'))
  let route: 'local' | 'remote' = 'local', called = false
  const service = {
    status: async () => ({ routes: { asr: route }, status: 'available', models: { asr: { status: 'path_accessible', path: 'private' }, tts: { status: 'not_configured' } }, remote: { asr: null, tts: null } }),
    read: async () => ({ routes: { asr: route } }),
    transcribe: async (path: string, _signal: AbortSignal, expected: string) => { called = true; assert.equal(expected, 'local'); assert.equal((await readFile(path)).toString('ascii', 0, 4), 'RIFF'); return '你好' },
  } as unknown as AudioCppService
  const app = new Hono()
  registerAudioRoutes(app, service, root, request => request.headers.get('Authorization') === 'Bearer test')
  const headers = { Authorization: 'Bearer test', 'Content-Type': 'audio/wav' }
  try {
    assert.equal((await app.request('/api/audio/status')).status, 401)
    const status = await (await app.request('/api/audio/status', { headers })).json()
    assert.deepEqual(status, { asr: { route: 'local', ready: true }, tts: { route: 'local', ready: false } })
    const body = new Uint8Array(pcm16Wav(Buffer.from([0, 0, 0, 64])))
    assert.deepEqual(await (await app.request('/api/audio/transcribe', { method: 'POST', headers, body })).json(), { text: '你好' })
    assert.ok(called); assert.deepEqual(await readdir(root), [])
    called = false; route = 'remote'
    assert.equal((await app.request('/api/audio/transcribe', { method: 'POST', headers, body })).status, 409)
    assert.equal(called, false)
    route = 'local'
    assert.equal((await app.request('/api/audio/transcribe', { method: 'POST', headers, body: 'not wav' })).status, 400)
  } finally { await rm(root, { recursive: true, force: true }) }
})
