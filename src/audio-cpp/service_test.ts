import assert from 'node:assert/strict'
import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { AudioCppService, runAudioCpp } from './service.ts'

test('audio.cpp remains optional and reports broken explicit configuration', async () => {
  await withTempWorkspace(async workspace => {
    const service = new AudioCppService(workspace, async () => '{}')
    const absent = await service.status()
    assert.equal(absent.configPath, join(workspace, '.audio-cpp.json'))
    assert.equal(absent.models.asr.status, 'not_configured')
    await assert.rejects(() => service.transcribe(join(workspace, 'input.wav')), /not installed/)
    await assert.rejects(() => service.configure({ task: 'asr', family: 'qwen3_asr', path: join(workspace, 'missing.gguf') }), { code: 'ENOENT' })
    await writeFile(join(workspace, '.audio-cpp.json'), JSON.stringify({ version: 1, binary: join(workspace, 'missing-cli') }))
    const broken = await service.status()
    assert.equal(broken.status, 'binary_error')
    assert.match(broken.error ?? '', /missing-cli/)
    await assert.rejects(() => service.inspect(undefined), { code: 'ENOENT' })
  })
})

test('configure validates binary, model and reserved flags; ASR and TTS use the configured CLI', async () => {
  await withTempWorkspace(async workspace => {
    const model = join(workspace, 'model.gguf')
    const input = join(workspace, 'input.wav')
    const output = join(workspace, 'speech.wav')
    await writeFile(model, 'synthetic model')
    await writeFile(input, 'synthetic wav')
    const calls: string[][] = []
    let failAsr = false
    let failTts = false
    let invalidLoader = true
    const service = new AudioCppService(workspace, async (_binary, args) => {
      calls.push(args)
      if (args[0] === '--list-loaders') return invalidLoader
        ? '{}' : '[{"family":"qwen3_asr"},{"family":"kokoro_tts"}]'
      if (args[0] === '--help') return 'loader help'
      if (args.includes('--audio')) {
        if (failAsr) throw new Error('bad model')
        await writeFile(args[args.indexOf('--text-out') + 1], 'transcribed')
      }
      if (args.includes('--text')) {
        await writeFile(args[args.indexOf('--out') + 1], Buffer.concat([
          Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32), Buffer.from([1]),
        ]))
        if (failTts) throw new Error('synthesis failed')
      }
      return ''
    })
    await assert.rejects(() => service.configure({ binary: join(workspace, 'missing-cli') }), { code: 'ENOENT' })
    await assert.rejects(() => service.configure({ task: 'tts', family: 'kokoro_tts', path: model, options: ['--out', 'override.wav'] }), /owned by Shadow/)
    await assert.rejects(() => service.configure({ binary: process.execPath }), /array/)
    invalidLoader = false
    await service.configure({ binary: process.execPath })
    await service.configure({ task: 'asr', family: 'qwen3_asr', path: model, options: ['--language', 'en'] })
    await service.configure({ task: 'tts', family: 'kokoro_tts', path: model })
    assert.equal((await service.status()).models.asr.status, 'path_accessible')
    assert.equal(await service.inspect('asr'), 'loader help')
    assert.equal(await service.transcribe(input), 'transcribed')
    assert.equal(await service.speak('hello', output), output)
    assert.equal((await readFile(output)).toString('ascii', 0, 4), 'RIFF')
    assert.ok(calls.some(args => args.includes('--audio') && args.includes(input) && args.includes('--language')))
    assert.ok(calls.some(args => args.includes('--text') && args.includes('hello') && args.includes('--out')))
    await assert.rejects(() => service.speak('hello', output), /already exists/)
    await assert.rejects(() => service.transcribe(model), /requires WAV/)
    failAsr = true
    await assert.rejects(() => service.transcribe(input), /bad model/)
    assert.deepEqual(await readdir(join(workspace, '.tmp')), [])
    failTts = true
    const partial = join(workspace, 'partial.wav')
    await assert.rejects(() => service.speak('hello', partial), /synthesis failed/)
    await assert.rejects(() => access(partial), { code: 'ENOENT' })
    failTts = false
    const corrupt = new AudioCppService(workspace, async (_binary, args) => {
      if (args.includes('--out')) await writeFile(args[args.indexOf('--out') + 1], 'not a wave')
      return ''
    })
    await assert.rejects(() => corrupt.speak('hello', partial), /valid WAV/)
    await assert.rejects(() => access(partial), { code: 'ENOENT' })
    await access(join(workspace, '.audio-cpp.json'))
  })
})

test('CLI process rejects nonzero exits and can be aborted', async () => {
  await assert.rejects(() => runAudioCpp(process.execPath, ['-e', 'process.stderr.write("failure");process.exit(7)']), /exited 7.*failure/)
  await assert.rejects(() => runAudioCpp(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], undefined, 100), /timed out after 100 ms/)
  const controller = new AbortController()
  const running = runAudioCpp(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], controller.signal)
  controller.abort()
  await assert.rejects(running, { name: 'AbortError' })
})

test('malformed stored settings are rejected instead of silently resetting configuration', async () => {
  await withTempWorkspace(async workspace => {
    await writeFile(join(workspace, '.audio-cpp.json'), JSON.stringify({ version: 2, asr: { family: 'x', path: 'x' } }))
    await assert.rejects(() => new AudioCppService(workspace).status())
  })
})
