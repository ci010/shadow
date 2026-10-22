import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { DiffusionCppService } from '../diffusion-cpp/service.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { DiffusionCppTool } from './diffusion-cpp.ts'
import { SessionTools, Tools } from './registry.ts'
import type { ExecutionContext } from './context.ts'

test('diffusion_cpp tool restricts Project, resolves references and returns private MEDIA paths', async () => {
  await withTempWorkspace(async workspace => {
    const cwd = join(workspace, 'session')
    await mkdir(cwd)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/o38AAAAASUVORK5CYII=', 'base64')
    const reference = join(cwd, 'input.png')
    await writeFile(reference, png)
    const gguf = (name: string) => join(workspace, name)
    const diffusion = gguf('qwen_image_2.1-Q4_K.gguf')
    const llm = gguf('Qwen3VL-8B-Instruct-Q4_K_M.gguf')
    const vae = gguf('qwen_image_2.1_vae_bf16.safetensors')
    await writeFile(diffusion, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(24)]))
    await writeFile(llm, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(24)]))
    await writeFile(vae, Buffer.concat([Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 123, 125]), Buffer.alloc(24)]))
    const calls: string[][] = []
    const service = new DiffusionCppService(workspace, async (_binary, args) => {
      calls.push(args)
      if (args[0] === '--help') return '--diffusion-model --video-frames'
      if (args.includes('-o')) await writeFile(args[args.indexOf('-o') + 1], png)
      return ''
    })
    const tool = new DiffusionCppTool(service, 'owner', workspace, () => cwd)
    const context: ExecutionContext = {
      channel: 'system', messageId: 'test', senderId: 'test', chatId: 'test',
      sessionId: 'session', physicalSessionId: 'session', cwd, projectId: 'owner',
      signal: new AbortController().signal, tools: new SessionTools(new Tools(workspace), workspace),
    }
    await assert.rejects(() => tool.execute({ action: 'status' }, { ...context, projectId: 'other' }), /owning Project/)
    await assert.rejects(() => tool.execute({ action: 'status', unexpected: true }, context))
    await assert.rejects(() => tool.execute({ action: 'image', prompt: 'cat' }, { ...context, cwd: undefined }), /local session workdir/)
    await assert.rejects(() => tool.execute({ action: 'configure', preset: 'qwen_image_2_1', diffusion, llm, vae }, context), /acknowledge/)
    await tool.execute({ action: 'configure', binary: process.execPath }, context)
    await tool.execute({ action: 'configure', preset: 'qwen_image_2_1', diffusion, llm, vae, licenseAcknowledged: true }, context)
    const result = JSON.parse(await tool.execute({ action: 'image', prompt: 'cat' }, context))
    assert.match(result.media, /^media\/sd-cpp-[0-9a-f-]+\.png$/)
    assert.equal(result.path, join(cwd, result.media))
    await access(result.path)
    assert.ok(calls.some(args => args.includes('--diffusion-model') && args.includes(diffusion)))
    const fork = JSON.parse(await tool.execute({ action: 'image', prompt: 'fork' }, { ...context, sessionId: 'child' }))
    assert.equal(fork.path, join(cwd, fork.media))
    await assert.rejects(() => tool.execute({ action: 'image', prompt: 'cat', reference: 'input.png' }, context), /requires --llm_vision/)
  })
})
