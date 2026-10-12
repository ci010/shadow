import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { projectStoragePath } from '../utils/data-paths.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { DiffusionCppService, runSdCpp } from './service.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/o38AAAAASUVORK5CYII=', 'base64')
const webm = Buffer.concat([Buffer.from([26, 69, 223, 163, 66, 130, 132]), Buffer.from('webm'), Buffer.alloc(144)])

async function model(path: string): Promise<string> {
  await writeFile(path, path.endsWith('.gguf')
    ? Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(32)])
    : Buffer.concat([Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 123, 125]), Buffer.alloc(32)]))
  return path
}

test('optional sd-cli reports errors, requires license acknowledgment and rejects mismatched models', async () => {
  await withTempWorkspace(async workspace => {
    const service = new DiffusionCppService(workspace, async (_binary, args) => args[0] === '--help'
      ? 'sd-cli --diffusion-model --video-frames' : '')
    assert.equal((await service.status()).presets.qwen_image_2_1.status, 'not_configured')
    await assert.rejects(() => service.image({ prompt: 'hello' }, join(workspace, 'image.png')), /not installed/)
    const diffusion = await model(join(workspace, 'qwen_image_2.1-Q4_K.gguf'))
    const vae = await model(join(workspace, 'qwen_image_2.1_vae_bf16.safetensors'))
    const generic = await model(join(workspace, 'Qwen3-VL-32B-Q4_K_M.gguf'))
    await assert.rejects(() => service.configure({
      preset: 'qwen_image_2_1', diffusion, vae, llm: generic,
    }), /acknowledge/)
    await assert.rejects(() => service.configure({
      preset: 'qwen_image_2_1', diffusion, vae, llm: generic, licenseAcknowledged: true,
    }), /unexpected model name/)
    const llm = await model(join(workspace, 'Qwen3VL-8B-Instruct-Q4_K_M.gguf'))
    await assert.rejects(() => service.configure({
      preset: 'qwen_image_2_1', diffusion, vae, llm, options: ['--output', join(workspace, 'stolen.png')],
      licenseAcknowledged: true,
    }), /owned by Shadow/)
    await assert.rejects(() => service.configure({ binary: join(workspace, 'missing-cli') }), { code: 'ENOENT' })
    await assert.rejects(access(join(workspace, 'config')), { code: 'ENOENT' })
    await service.configure({ binary: process.execPath })
    assert.equal((await service.status()).configPath, join(workspace, 'config', 'diffusion-cpp.json'))
    assert.equal((await new DiffusionCppService(workspace).read()).binary, (await service.read()).binary)
    await assert.rejects(access(join(workspace, '.diffusion-cpp.json')), { code: 'ENOENT' })
    await service.configure({ preset: 'qwen_image_2_1', diffusion, vae, llm, licenseAcknowledged: true })
    assert.equal((await service.status()).presets.qwen_image_2_1.status, 'path_accessible')
    assert.match(await readFile(projectStoragePath(workspace, '.diffusion-cpp.json'), 'utf8'), /licenseAcknowledged/)
    assert.equal((await service.status()).presets.qwen_image_2_1.imageEdit, false)
    await assert.rejects(() => service.image({ prompt: 'edit', reference: diffusion }, join(workspace, 'edit.png')), /requires --llm_vision/)
    await writeFile(vae, 'truncated')
    assert.equal((await service.status()).presets.qwen_image_2_1.status, 'invalid')
    await assert.rejects(() => service.image({ prompt: 'hello' }, join(workspace, 'image.png')), /Invalid model file header/)
    await writeFile(projectStoragePath(workspace, '.diffusion-cpp.json'), JSON.stringify({ version: 2, presets: {} }))
    await assert.rejects(() => service.status(), /Invalid literal/)
  })
})

test('model-specific image and audio/video arguments produce validated session media', async () => {
  await withTempWorkspace(async workspace => {
    const calls: string[][] = []
    let invalidOutput = false
    const service = new DiffusionCppService(workspace, async (_binary, args) => {
      calls.push(args)
      if (args[0] === '--help') return 'sd-cli --diffusion-model --video-frames'
      if (args.includes('-o')) {
        const output = args[args.indexOf('-o') + 1]
        await writeFile(output, invalidOutput ? Buffer.from('wrong') : args.includes('vid_gen') ? webm : png)
      }
      return args[0] === '--list-devices' ? 'cpu\tCPU' : ''
    })
    const qwen = await model(join(workspace, 'qwen_image_2.1-Q4_K.gguf'))
    const qvae = await model(join(workspace, 'qwen_image_2.1_vae_bf16.safetensors'))
    const qllm = await model(join(workspace, 'Qwen3VL-8B-Instruct-Q4_K_M.gguf'))
    const vision = await model(join(workspace, 'mmproj-Qwen3VL-8B-Instruct-F16.gguf'))
    const z = await model(join(workspace, 'z_image_turbo-Q3_K.gguf'))
    const zvae = await model(join(workspace, 'ae.safetensors'))
    const zllm = await model(join(workspace, 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'))
    const h3 = await model(join(workspace, 'minimax_h3_fl2va-Q4_K_M.gguf'))
    const refH3 = await model(join(workspace, 'minimax_h3_ref2va_pruned-Q4_K_M.gguf'))
    const hvae = await model(join(workspace, 'minimax_h3_video_vae_fp16.safetensors'))
    const audioVae = await model(join(workspace, 'minimax_h3_audio_vae_fp32.safetensors'))
    const hllm = await model(join(workspace, 'qwen3vl_32b_minimax_h3-Q4_K_M.gguf'))
    const reference = join(workspace, 'reference.png')
    await writeFile(reference, png)
    await mkdir(join(workspace, 'session'))
    await service.configure({ binary: process.execPath })
    await service.configure({
      preset: 'qwen_image_2_1', diffusion: qwen, vae: qvae, llm: qllm, vision, licenseAcknowledged: true,
    })
    await service.configure({
      preset: 'z_image_turbo', diffusion: z, vae: zvae, llm: zllm, licenseAcknowledged: true,
    })
    await service.configure({
      preset: 'minimax_h3', diffusion: h3, vae: hvae, llm: hllm, audioVae, licenseAcknowledged: true,
    })
    assert.equal(await service.inspect('devices'), 'cpu\tCPU')
    const qout = join(workspace, 'session', 'image.png')
    assert.equal(await service.image({ prompt: 'cat', reference }, qout), qout)
    assert.ok(calls.some(args => args.includes('--llm_vision') && args.includes('-r') && args.includes('--fa')))
    await assert.rejects(() => service.image({ prompt: 'again' }, qout), /already exists/)
    assert.deepEqual(await readFile(qout), png)
    await service.configure({ preset: 'qwen_image_2_1', vision: '', licenseAcknowledged: true })
    assert.equal((await service.status()).presets.qwen_image_2_1.imageEdit, false)
    assert.match(await readFile(qout).then(data => data.subarray(1, 4).toString()), /PNG/)
    const zout = join(workspace, 'session', 'turbo.png')
    await service.image({ prompt: 'dog', preset: 'z_image_turbo' }, zout)
    assert.ok(calls.some(args => args.includes(z) && args.includes('--steps') && args.includes('8')
      && args.includes('--diffusion-fa') && args.includes('--cfg-scale') && args.includes('1')))
    await assert.rejects(() => service.image({ prompt: 'edit', preset: 'z_image_turbo', reference }, join(workspace, 'zedit.png')), /not configured as/)
    await assert.rejects(() => service.image({ prompt: 'odd', width: 513 }, join(workspace, 'odd.png')), /multiples of 32/)
    await assert.rejects(() => service.video({ prompt: 'cat', frames: 57 }, join(workspace, 'odd.webm')), /17k \+ 5/)
    await assert.rejects(() => service.video({ prompt: 'cat', endImage: reference }, join(workspace, 'end.webm')), /requires an initial image/)
    await assert.rejects(() => service.video({ prompt: 'cat', mode: 'ref2va', referenceImages: [reference] }, join(workspace, 'ref.webm')), /separately configured/)
    await assert.rejects(() => service.configure({ preset: 'minimax_h3', refDiffusion: refH3 }), /acknowledge/)
    await service.configure({ preset: 'minimax_h3', refDiffusion: refH3, licenseAcknowledged: true })
    assert.equal((await service.status()).presets.minimax_h3.referenceVideo, true)
    const vout = join(workspace, 'session', 'video.webm')
    await service.video({ prompt: 'cat', initImage: reference, endImage: reference }, vout)
    assert.equal((await readFile(vout)).subarray(0, 4).toString('hex'), '1a45dfa3')
    assert.ok(calls.some(args => args.includes('vid_gen') && args.includes('--audio-vae') && args.includes(audioVae)
      && args.includes('--video-frames') && args.includes('56') && args.includes('--fps') && args.includes('24')
      && args.includes('--end-img')))
    await service.video({ prompt: 'reference', mode: 'ref2va', referenceImages: [reference] }, join(workspace, 'session', 'ref.webm'))
    assert.ok(calls.some(args => args.includes(refH3) && args.includes('--ref-image')))
    await service.configure({ preset: 'minimax_h3', refDiffusion: '', licenseAcknowledged: true })
    assert.equal((await service.status()).presets.minimax_h3.referenceVideo, false)
    invalidOutput = true
    const corrupt = join(workspace, 'session', 'corrupt.webm')
    await assert.rejects(() => service.video({ prompt: 'cat' }, corrupt), /valid WebM/)
    await assert.rejects(() => access(corrupt), { code: 'ENOENT' })

    const interrupted = new DiffusionCppService(workspace, async (_binary, args) => {
      if (args.includes('-o')) {
        await writeFile(args[args.indexOf('-o') + 1], webm)
        throw new Error('GPU out of memory')
      }
      return ''
    })
    const partial = join(workspace, 'session', 'partial.webm')
    await assert.rejects(() => interrupted.video({ prompt: 'cat' }, partial), /GPU out of memory/)
    await assert.rejects(() => access(partial), { code: 'ENOENT' })

    let start!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const serialized = new DiffusionCppService(workspace, async (_binary, args) => {
      if (args.includes('-o')) {
        start()
        await held
        await writeFile(args[args.indexOf('-o') + 1], png)
      }
      return ''
    })
    const first = serialized.image({ prompt: 'first' }, join(workspace, 'session', 'first.png'))
    await started
    await assert.rejects(() => serialized.image({ prompt: 'second' }, join(workspace, 'session', 'second.png')), /already running/)
    release()
    await first
  })
})

test('sd-cli process surfaces failures, timeout and cancellation', async () => {
  await assert.rejects(() => runSdCpp(process.execPath, ['-e', 'process.stderr.write("failure"); process.exit(7)']), /exited 7.*failure/)
  await assert.rejects(() => runSdCpp(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], undefined, 100), /timed out after 100 ms/)
  const abort = new AbortController()
  const task = runSdCpp(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], abort.signal)
  abort.abort()
  await assert.rejects(task, { name: 'AbortError' })
})

test('legacy Qwen edit uses complete Diffusers shard indexes and requires a reference', async () => {
  await withTempWorkspace(async workspace => {
    const cache = join(workspace, 'Qwen-Image-Edit')
    for (const dir of ['transformer', 'text_encoder', 'vae']) await mkdir(join(cache, dir), { recursive: true })
    await writeFile(join(cache, 'model_index.json'), '{"_class_name":"QwenImageEditPipeline"}')
    await writeFile(join(cache, 'text_encoder', 'config.json'), '{"model_type":"qwen2_5_vl"}')
    const diffusion = join(cache, 'transformer', 'diffusion_pytorch_model.safetensors.index.json')
    const llm = join(cache, 'text_encoder', 'model.safetensors.index.json')
    const vae = await model(join(cache, 'vae', 'diffusion_pytorch_model.safetensors'))
    const shard = await model(join(cache, 'transformer', 'diffusion_pytorch_model-00001-of-00001.safetensors'))
    await model(join(cache, 'text_encoder', 'model-00001-of-00001.safetensors'))
    await writeFile(diffusion, JSON.stringify({ weight_map: { 'img_in.weight': 'diffusion_pytorch_model-00001-of-00001.safetensors' } }))
    await writeFile(llm, JSON.stringify({ weight_map: { 'model.embed_tokens.weight': 'model-00001-of-00001.safetensors' } }))
    const calls: string[][] = []
    const service = new DiffusionCppService(workspace, async (_binary, args) => {
      calls.push(args)
      if (args[0] === '--help') return '--diffusion-model --video-frames'
      if (args.includes('-o')) await writeFile(args[args.indexOf('-o') + 1], png)
      return ''
    })
    await assert.rejects(() => service.image({ preset: 'qwen_image_edit', prompt: 'change it' }, join(workspace, 'missing.png')), /requires a reference/)
    await assert.rejects(() => service.configure({ preset: 'qwen_image_edit', diffusion, llm, vae }), /acknowledge/)
    await service.configure({ binary: process.execPath })
    await service.configure({ preset: 'qwen_image_edit', diffusion, llm, vae, licenseAcknowledged: true })
    assert.equal((await service.status()).presets.qwen_image_edit.status, 'path_accessible')
    assert.equal((await service.status()).presets.qwen_image_edit.imageEdit, true)
    assert.equal((await service.status()).presets.qwen_image_2_1.status, 'not_configured')
    const reference = join(workspace, 'input.png')
    await writeFile(reference, png)
    await service.image({ preset: 'qwen_image_edit', prompt: 'change it', reference }, join(workspace, 'edit.png'))
    const args = calls.at(-1)!
    assert.deepEqual(args.slice(0, 6), ['--diffusion-model', diffusion, '--vae', vae, '--llm', llm])
    assert.ok(args.includes('--diffusion-fa') && args.includes('--flow-shift') && args.includes('3'))
    assert.equal(args[args.indexOf('--cfg-scale') + 1], '2.5')
    assert.ok(args.includes('-r') && !args.includes('--llm_vision') && !args.includes('--fa'))
    const other = join(workspace, 'other')
    await mkdir(join(other, 'vae'), { recursive: true })
    await assert.rejects(() => service.configure({
      preset: 'qwen_image_edit', diffusion: shard, licenseAcknowledged: true,
    }), /cache component/)
    await assert.rejects(() => service.configure({
      preset: 'qwen_image_edit', vae: join(other, 'vae', 'diffusion_pytorch_model.safetensors'), licenseAcknowledged: true,
    }))
    for (const dir of ['transformer', 'text_encoder']) await mkdir(join(other, dir), { recursive: true })
    await writeFile(join(other, 'model_index.json'), '{"_class_name":"QwenImageEditPipeline"}')
    await writeFile(join(other, 'text_encoder', 'config.json'), '{"model_type":"qwen2_5_vl"}')
    const otherLlm = join(other, 'text_encoder', 'model.safetensors.index.json')
    await writeFile(otherLlm, await readFile(llm))
    await model(join(other, 'text_encoder', 'model-00001-of-00001.safetensors'))
    await writeFile(join(other, 'transformer', 'diffusion_pytorch_model.safetensors.index.json'), await readFile(diffusion))
    await model(join(other, 'transformer', 'diffusion_pytorch_model-00001-of-00001.safetensors'))
    await model(join(other, 'vae', 'diffusion_pytorch_model.safetensors'))
    await assert.rejects(() => service.configure({
      preset: 'qwen_image_edit', llm: otherLlm, licenseAcknowledged: true,
    }), /same cache/)
    const configPath = projectStoragePath(workspace, '.diffusion-cpp.json')
    const configured = JSON.parse(await readFile(configPath, 'utf8'))
    configured.presets.qwen_image_edit.llm = otherLlm
    await writeFile(configPath, JSON.stringify(configured))
    assert.equal((await service.status()).presets.qwen_image_edit.status, 'invalid')
    await assert.rejects(() => service.image({
      preset: 'qwen_image_edit', prompt: 'change it', reference,
    }, join(workspace, 'mismatched.png')), /same cache/)
    configured.presets.qwen_image_edit.llm = llm
    await writeFile(configPath, JSON.stringify(configured))
    await writeFile(shard, 'truncated')
    assert.equal((await service.status()).presets.qwen_image_edit.status, 'invalid')
    await assert.rejects(() => service.image({
      preset: 'qwen_image_edit', prompt: 'change it', reference,
    }, join(workspace, 'incomplete.png')), /Invalid model/)
    await writeFile(shard, Buffer.concat([Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 123, 125]), Buffer.alloc(32)]))
    await writeFile(diffusion, '{"weight_map":{"a":"../escape.safetensors"}}')
    await assert.rejects(() => service.image({
      preset: 'qwen_image_edit', prompt: 'change it', reference,
    }, join(workspace, 'unsafe.png')), /Unsafe shard path/)
  })
})

test('Anima requires matching components and uses separate turbo generation defaults', async () => {
  await withTempWorkspace(async workspace => {
    const diffusion = await model(join(workspace, 'anima-turbo-v1.1.safetensors'))
    const llm = await model(join(workspace, 'qwen_3_06b_base.safetensors'))
    const vae = await model(join(workspace, 'qwen_image_vae.safetensors'))
    const calls: string[][] = []
    const service = new DiffusionCppService(workspace, async (_binary, args) => {
      calls.push(args)
      if (args[0] === '--help') return '--diffusion-model --video-frames'
      if (args.includes('-o')) await writeFile(args[args.indexOf('-o') + 1], png)
      return ''
    })
    await service.configure({ binary: process.execPath })
    const wrongVae = await model(join(workspace, 'ae.safetensors'))
    await assert.rejects(() => service.configure({
      preset: 'anima', diffusion, llm, vae: wrongVae,
      licenseAcknowledged: true,
    }), /unexpected model name/)
    await service.configure({ preset: 'anima', diffusion, llm, vae, licenseAcknowledged: true })
    await assert.rejects(() => service.image({
      preset: 'anima', prompt: 'illustration', reference: vae,
    }, join(workspace, 'reference.png')), /text-to-image/)
    await service.image({ preset: 'anima', prompt: 'illustration' }, join(workspace, 'anima.png'))
    const args = calls.at(-1)!
    assert.equal(args[args.indexOf('--steps') + 1], '10')
    assert.equal(args[args.indexOf('--cfg-scale') + 1], '1')
    assert.ok(args.includes('--diffusion-fa') && args.includes('--sampling-method'))
    await service.configure({
      preset: 'anima', diffusion: await model(join(workspace, 'anima-aesthetic-v1.1.safetensors')),
      licenseAcknowledged: true,
    })
    await service.image({ preset: 'anima', prompt: 'illustration' }, join(workspace, 'aesthetic.png'))
    const aesthetic = calls.at(-1)!
    assert.equal(aesthetic[aesthetic.indexOf('--steps') + 1], '35')
    assert.equal(aesthetic[aesthetic.indexOf('--cfg-scale') + 1], '4.5')
  })
})
