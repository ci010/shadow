import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { discoverModels, knownModelRoots, matchesComponent } from './discovery.ts'

test('bounded discovery recognizes components in provider caches without reading whole models', async () => {
  await withTempWorkspace(async root => {
    const snapshot = join(root, 'models--leejet--Qwen-Image-2.1-GGUF', 'snapshots', 'pinned')
    const vae = join(root, 'ComfyUI', 'models', 'vae')
    await mkdir(snapshot, { recursive: true })
    await mkdir(vae, { recursive: true })
    const model = join(snapshot, 'qwen_image_2.1-Q4_K.gguf')
    await writeFile(model, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(32)]))
    await writeFile(join(vae, 'qwen_image_2.1_vae_bf16.safetensors'), Buffer.alloc(32))
    await writeFile(join(root, 'token'), 'do not inspect unrelated files')
    const found = await discoverModels([root])
    assert.equal(found.truncated, false)
    assert.deepEqual(found.warnings, [])
    assert.deepEqual(found.candidates.map(({ preset, component }) => [preset, component]), [
      ['qwen_image_2_1', 'diffusion'], ['qwen_image_2_1', 'vae'],
    ])
    assert.equal(found.candidates[0].verification, 'filename_and_size_only')
    assert.equal(found.candidates[0].path, model)
    assert.equal(found.candidates.some(candidate => candidate.path.includes('token')), false)
    await assert.rejects(() => discoverModels([parse(root).root]), /volume root/)
  })
})

test('provider overrides and H3-specific file names avoid generic Qwen encoder matches', async () => {
  await withTempWorkspace(async root => {
    const hf = join(root, 'hf')
    const ms = join(root, 'ms')
    const comfy = join(root, 'comfy')
    const env = { HF_HUB_CACHE: hf, MODELSCOPE_CACHE: ms, COMFYUI_ROOT: comfy, SHADOW_MODELS_DIR: join(root, 'models') }
    const roots = knownModelRoots(env, root)
    for (const path of [hf, ms, join(comfy, 'models'), env.SHADOW_MODELS_DIR]) assert.ok(roots.includes(path))
    assert.equal(matchesComponent('minimax_h3', 'llm', 'Qwen3-VL-32B-Q4_K_M.gguf'), false)
    assert.equal(matchesComponent('minimax_h3', 'llm', 'qwen3vl_32b_minimax_h3-Q4_K_M.gguf'), true)
    assert.equal(matchesComponent('minimax_h3', 'vision', 'mmproj-Qwen3VL-32B-Instruct-F16.gguf'), true)
    assert.equal(matchesComponent('minimax_h3', 'refDiffusion', 'minimax_h3_ref2va_pruned-Q4_K_M.gguf'), true)
    assert.equal(matchesComponent('z_image_turbo', 'vae', 'ae.safetensors'), true)
    assert.equal(matchesComponent('anima', 'diffusion', 'anima-turbo-v1.1.safetensors'), true)
    assert.equal(matchesComponent('anima', 'llm', 'qwen_3_06b_base.safetensors'), true)
    assert.equal(matchesComponent('anima', 'llm', 'Qwen2.5-VL-7B-Instruct.gguf'), false)
    assert.equal(matchesComponent('anima', 'vae', 'qwen_image_vae.safetensors'), true)
    await mkdir(hf)
    await writeFile(join(hf, 'qwen3vl_32b_minimax_h3-Q4_K_M.gguf'), Buffer.alloc(64))
    assert.equal((await discoverModels([hf])).candidates[0]?.component, 'llm')
  })
})

test('legacy Qwen Diffusers discovery reports complete indexed components, not individual shards', async () => {
  await withTempWorkspace(async root => {
    const cache = join(root, 'Qwen', 'Qwen-Image-Edit')
    for (const dir of ['transformer', 'text_encoder', 'vae']) await mkdir(join(cache, dir), { recursive: true })
    const header = Buffer.concat([Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 123, 125]), Buffer.alloc(32)])
    await writeFile(join(cache, 'model_index.json'), '{"_class_name":"QwenImageEditPipeline"}')
    await writeFile(join(cache, 'text_encoder', 'config.json'), '{"model_type":"qwen2_5_vl"}')
    const shards = [
      ['transformer', 'diffusion_pytorch_model-00001-of-00001.safetensors', 'diffusion_pytorch_model.safetensors.index.json'],
      ['text_encoder', 'model-00001-of-00001.safetensors', 'model.safetensors.index.json'],
    ]
    for (const [dir, name, index] of shards) {
      await writeFile(join(cache, dir, name), header)
      await writeFile(join(cache, dir, index), JSON.stringify({ weight_map: { 'tensor.weight': name } }))
    }
    await writeFile(join(cache, 'vae', 'diffusion_pytorch_model.safetensors'), header)
    const result = await discoverModels([root])
    assert.deepEqual(result.candidates.map(c => [c.preset, c.component]), [
      ['qwen_image_edit', 'diffusion'], ['qwen_image_edit', 'vae'], ['qwen_image_edit', 'llm'],
    ])
    assert.ok(result.candidates.every(c => c.verification === 'index_and_shard_headers_only'))
    await writeFile(join(cache, 'transformer', shards[0][1]), 'truncated')
    const incomplete = await discoverModels([root])
    assert.equal(incomplete.candidates.length, 0)
    assert.match(incomplete.warnings[0]?.error ?? '', /Invalid model/)
  })
})
