import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { withTempWorkspace } from '../testing/workspace.ts'
import { runProjectAudioCli } from './host-cli.ts'
import { RemoteAudio } from './remote.ts'
import { registerAudioRoutes } from './routes.ts'
import { AudioCppService } from './service.ts'

test('host configuration is visible to the existing Composer status API without recording or uploading', async () => {
  await withTempWorkspace(async home => {
    let requests = 0
    const remote = new RemoteAudio(async () => {
      requests++
      return Response.json({ text: 'fixture remote speech' })
    })
    const audio = new AudioCppService(home, async (_binary, args) => {
      assert.deepEqual(args, ['--list-loaders', '--json'])
      return '[{"family":"sense_asr"}]'
    }, undefined, remote)
    const run = (command: string, ...args: string[]) => runProjectAudioCli([command, home, ...args], () => audio)
    const settings = join(home, 'remote.json')
    await writeFile(settings, JSON.stringify({ task: 'asr', remote: { baseUrl: 'https://audio.example/v1', model: 'fixture' } }))
    const app = new Hono()
    const routes = registerAudioRoutes(app, new AudioCppService(home), join(home, 'tmp'), () => true)
    try {
      await assert.rejects(runProjectAudioCli(['status', '.']), /absolute path/)
      await run('configure-remote', settings)
      assert.deepEqual((await (await app.request('/api/audio/status')).json()).asr, { route: 'remote', ready: true })
      assert.equal((await app.request('/api/audio/transcribe', { method: 'POST' })).status, 409)
      assert.equal(requests, 0)
      const input = join(home, 'fixture.wav')
      await writeFile(input, 'fixture')
      assert.deepEqual(await run('transcribe', input), { text: 'fixture remote speech' })
      assert.equal(requests, 1)
      const model = join(home, 'fixture.gguf')
      await writeFile(model, 'fixture model')
      await writeFile(settings, JSON.stringify({ task: 'asr', family: 'sense_asr', binary: process.execPath, path: model }))
      await run('configure', settings)
      assert.deepEqual((await (await app.request('/api/audio/status')).json()).asr, { route: 'local', ready: true })
      assert.equal(requests, 1)
    } finally { routes.close() }
  })
})
