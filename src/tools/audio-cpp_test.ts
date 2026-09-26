import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { AudioCppService } from '../audio-cpp/service.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { AudioCppTool } from './audio-cpp.ts'
import type { ExecutionContext } from './context.ts'
import { SessionTools, Tools } from './registry.ts'

test('audio_cpp tool uses the owning Project and the current session paths', async () => {
  await withTempWorkspace(async workspace => {
    const cwd = join(workspace, 'session')
    await mkdir(cwd)
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32), Buffer.from([1])])
    await writeFile(join(cwd, 'input.wav'), wav)
    const model = join(workspace, 'model.gguf')
    await writeFile(model, 'synthetic')
    const service = new AudioCppService(workspace, async (_binary, args) => {
      if (args[0] === '--list-loaders') return '[{"family":"qwen3_asr"},{"family":"kokoro_tts"}]'
      if (args.includes('--text-out')) await writeFile(args[args.indexOf('--text-out') + 1], 'hello')
      if (args.includes('--out')) await writeFile(args[args.indexOf('--out') + 1], wav)
      return ''
    })
    const tool = new AudioCppTool(service, 'my-project', workspace)
    const context: ExecutionContext = {
      channel: 'system', messageId: 'test', senderId: 'test', chatId: 'test',
      sessionId: 'session', physicalSessionId: 'session', cwd, projectId: 'my-project',
      signal: new AbortController().signal, tools: new SessionTools(new Tools(workspace), workspace),
    }
    const status = JSON.parse(await tool.execute({ action: 'status' }, context))
    assert.equal(status.models.asr.status, 'not_configured')
    await assert.rejects(() => tool.execute({ action: 'configure', binary: process.execPath }, { ...context, projectId: 'other' }), /owning Project/)
    await assert.rejects(() => tool.execute({ action: 'configure', unexpected: true }, context))
    await tool.execute({ action: 'configure', binary: process.execPath }, context)
    await tool.execute({ action: 'configure', task: 'asr', family: 'qwen3_asr', path: model }, context)
    await tool.execute({ action: 'configure', task: 'tts', family: 'kokoro_tts', path: model }, context)
    assert.deepEqual(JSON.parse(await tool.execute({ action: 'transcribe', input: 'input.wav' }, context)), { text: 'hello' })
    assert.deepEqual(JSON.parse(await tool.execute({ action: 'speak', text: 'hello', output: 'output.wav' }, context)), {
      path: join(cwd, 'output.wav'),
    })
  })
})
