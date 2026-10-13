import { crc32 } from 'node:zlib'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { AudioCppService } from './service.ts'
import { extractZip, type SetupRequest } from './install.ts'
import { RemoteAudio } from './remote.ts'
import { assessCandidate, type Hardware } from './assessment.ts'
import { AudioCppTool } from '../tools/audio-cpp.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'

function zip(name: string, data: Buffer): Buffer {
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22), nameBytes = Buffer.from(name)
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26)
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(local.length + nameBytes.length + data.length, 16)
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end])
}
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const entry = process.platform === 'win32' ? 'bin/audiocpp_cli.exe' : 'bin/audiocpp_cli'
const binary = zip(entry, Buffer.from('fixture executable, never actually executed'))
const model = Buffer.from('GGUFfixture weights, not a real model')
function request(): SetupRequest {
  return { approved: true, task: 'asr', binary: { url: 'https://example.com/pinned.zip', sha256: sha(binary), bytes: binary.length, entry, platform: process.platform as 'win32', arch: process.arch as 'x64' }, model: { url: 'https://example.com/pinned.gguf', sha256: sha(model), bytes: model.length, family: 'sense_asr' } }
}
function context(workspace: string): ExecutionContext {
  return { channel: 'system', messageId: 'test', senderId: 'test', chatId: 'test', sessionId: 'session', physicalSessionId: 'session', cwd: workspace, projectId: 'p', signal: new AbortController().signal, tools: new SessionTools(new Tools(workspace), workspace) }
}

test('Agent tool setup verifies artifacts, probes, registers and routes inference; rerun uses the same managed paths', async () => {
  await withTempWorkspace(async workspace => {
    let inference = 0, probes = 0, transfers = 0
    const service = new AudioCppService(workspace, async (path, args) => {
      assert.equal((await readFile(path)).toString(), 'fixture executable, never actually executed')
      if (args[0] === '--list-loaders') { probes++; return '{"schema_version":1,"loaders":{"sense_asr":{"tasks":{"asr":["sensevoice_small"]}}}}' }
      if (args.includes('--text-out')) { inference++; assert.equal((await readFile(args[args.indexOf('--model') + 1])).toString(), model.toString()); await writeFile(args[args.indexOf('--text-out') + 1], 'fixture transcript') }
      return ''
    }, { download: async input => {
      const path = join(input.directory, input.filename)
      let reused = false
      try { reused = sha(await readFile(path)) === input.sha256 } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      if (!reused) { transfers++; await writeFile(path, input.url.endsWith('.zip') ? binary : model) }
      return { path, sha256: input.sha256, bytes: input.bytes!, reused }
    } })
    const tool = new AudioCppTool(service, 'p', workspace, 'audio'), ctx = context(workspace)
    const assessment = JSON.parse(await tool.execute({ action: 'assess', candidate: { family: 'sense_asr', downloadBytes: model.length + binary.length, platform: process.platform, arch: process.arch } }, ctx))
    assert.equal(assessment.hardware.platform, process.platform)
    assert.ok(assessment.hardware.totalMemoryBytes > 0)
    assert.ok(assessment.hardware.freeDiskBytes > 0)
    assert.equal(assessment.suitability, 'unknown')
    await tool.execute({ action: 'setup', setup: request() }, ctx)
    const first = await service.read()
    assert.equal(first.routes?.asr, 'local')
    assert.equal(first.asr?.family, 'sense_asr')
    await writeFile(join(workspace, 'input.wav'), 'RIFFfixture')
    assert.deepEqual(JSON.parse(await tool.execute({ action: 'transcribe', input: 'input.wav' }, ctx)), { text: 'fixture transcript' })
    await tool.execute({ action: 'setup', setup: request() }, ctx)
    assert.deepEqual(await service.read(), first)
    assert.equal(inference, 1); assert.ok(probes >= 4); assert.equal(transfers, 2)
    assert.equal((await service.status()).inferenceVerified, false)
    await assert.rejects(() => tool.execute({ action: 'setup', setup: request() }, { ...ctx, remoteWorkdir: {} as ExecutionContext['remoteWorkdir'] }), /local owning Project/)
  })
})

test('hash mismatch, malformed ZIP, unsupported loader and failed probe do not register a model', async () => {
  await withTempWorkspace(async workspace => {
    for (const kind of ['hash', 'loader', 'probe']) {
      const service = new AudioCppService(workspace, async () => { if (kind === 'probe') throw new Error('probe failed'); return '[{"family":"other"}]' }, { download: async input => {
        await writeFile(join(input.directory, input.filename), kind === 'hash' ? Buffer.from('corrupt') : input.url.endsWith('.zip') ? binary : model)
        return { path: join(input.directory, input.filename), sha256: input.sha256, bytes: input.bytes!, reused: false }
      } })
      await assert.rejects(() => service.setup(request()))
      assert.deepEqual(await service.read(), { version: 1 })
      assert.equal((await service.status()).models.asr.status, 'not_configured')
    }
    await assert.rejects(() => extractZip(zip('../escape', Buffer.from('bad')), workspace), /Unsafe/)
    await assert.rejects(() => extractZip(Buffer.from('bad'), workspace), /Unsupported/)
  })
})

test('remote API configuration selects explicit unified routes, redacts errors and never falls back locally', async () => {
  await withTempWorkspace(async workspace => {
    let requests = 0, local = 0
    const remote = new RemoteAudio(async (url, init) => {
      requests++
      assert.equal(url, 'https://audio.example/v1/audio/transcriptions')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-secret')
      assert.equal((init?.body as FormData).get('model'), 'whisper-1')
      return new Response(JSON.stringify({ text: 'remote fixture' }), { headers: { 'Content-Type': 'application/json' } })
    }, { AUDIO_TEST_KEY: 'fixture-secret' })
    const service = new AudioCppService(workspace, async () => { local++; throw new Error('should not run') }, undefined, remote)
    const tool = new AudioCppTool(service, 'p', workspace), ctx = context(workspace)
    await tool.execute({ action: 'configure_remote', task: 'asr', remote: { baseUrl: 'https://audio.example/v1', model: 'whisper-1', apiKeyEnv: 'AUDIO_TEST_KEY' } }, ctx)
    assert.equal(requests, 0)
    await writeFile(join(workspace, 'input.wav'), 'fixture')
    assert.deepEqual(JSON.parse(await tool.execute({ action: 'transcribe', input: 'input.wav' }, ctx)), { text: 'remote fixture' })
    assert.equal(local, 0)
    assert.ok(!JSON.stringify(await service.status()).includes('fixture-secret'))
    const failed = new RemoteAudio(async () => { throw new Error('fixture-secret https://credential-url') })
    const config = { baseUrl: 'https://audio.example/v1', model: 'whisper-1' }
    await assert.rejects(() => failed.transcribe(config, join(workspace, 'input.wav')), error => error instanceof Error && !error.message.includes('fixture-secret') && /withheld/.test(error.message))
    await assert.rejects(() => service.configureRemote('asr', { ...config, baseUrl: 'http://untrusted.example/v1' }))
  })
})

const hardware: Hardware = { platform: 'win32', arch: 'x64', cpuCount: 8, totalMemoryBytes: 16000, availableMemoryBytes: 8000, freeDiskBytes: 100000 }
const candidate = { family: 'sense_asr', backend: 'cpu' as const, downloadBytes: 20000, platform: 'win32' as const, arch: 'x64' as const }
test('model assessment reports evidenced capacity, unknown GPU/memory and remote recommendation on unsuitable hosts', () => {
  assert.equal(assessCandidate(candidate, hardware).suitability, 'unknown')
  assert.equal(assessCandidate({ ...candidate, minimumMemoryBytes: 4000, memoryEvidence: 'https://example.com/model-requirements' }, hardware).suitability, 'suitable')
  assert.equal(assessCandidate({ ...candidate, backend: 'cuda' }, hardware).suitability, 'unknown')
  const bad = assessCandidate({ ...candidate, minimumMemoryBytes: 9000, memoryEvidence: 'https://example.com/model-requirements' }, hardware)
  assert.equal(bad.suitability, 'unsuitable'); assert.equal(bad.recommendRemote, true); assert.equal(bad.inferenceVerified, false)
  assert.equal(assessCandidate({ ...candidate, arch: 'arm64' }, hardware).suitability, 'unsuitable')
  assert.throws(() => assessCandidate({ ...candidate, minimumMemoryBytes: 4000 }, hardware), /published evidence/)
})

test('unified remote speech validates WAV and remote errors never invoke local CLI', async () => {
  await withTempWorkspace(async workspace => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(33)])
    let mode = 'wav', local = 0
    const service = new AudioCppService(workspace, async () => { local++; throw new Error('unexpected local CLI') }, undefined, new RemoteAudio(async (_url, init) => {
      assert.equal(JSON.parse(init!.body as string).voice, 'custom-voice')
      if (mode === 'failure') return new Response('sensitive-provider-diagnostic', { status: 503 })
      return new Response(mode === 'wav' ? new Uint8Array(wav) : 'not WAV')
    }))
    await service.configureRemote('tts', { baseUrl: 'https://audio.example/v1', model: 'tts-1', voice: 'custom-voice' })
    const path = join(workspace, 'speech.wav')
    assert.equal(await service.speak('hello', path), path)
    assert.deepEqual(await readFile(path), wav)
    mode = 'invalid'
    await assert.rejects(() => service.speak('hello', join(workspace, 'invalid.wav')), /valid WAV/)
    await assert.rejects(() => readFile(join(workspace, 'invalid.wav')), /ENOENT/)
    mode = 'failure'
    await assert.rejects(() => service.speak('hello', join(workspace, 'failed.wav')), /HTTP 503/)
    assert.equal(local, 0)
  })
})

test('verified ZIP extraction rejects symlink entries and damaged entry CRC before CLI probing', async () => {
  await withTempWorkspace(async workspace => {
    const linked = zip('link', Buffer.from('target'))
    const central = linked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    linked.writeUInt32LE(0xa1ff0000, central + 38)
    await assert.rejects(() => extractZip(linked, workspace), /entry type/)
    const corrupt = zip('file', Buffer.from('data'))
    corrupt[34] ^= 0xff
    await assert.rejects(() => extractZip(corrupt, workspace), /ZIP size mismatch/)
  })
})
