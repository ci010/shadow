import { open, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

const MAX_INDEX_BYTES = 4 * 1024 * 1024

async function jsonFile(path: string): Promise<Record<string, unknown>> {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_INDEX_BYTES) throw new TypeError(`Invalid model index: ${path}`)
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid model index: ${path}`)
  return value as Record<string, unknown>
}

async function safetensors(path: string): Promise<number> {
  const info = await stat(path)
  if (!info.isFile() || info.size <= 16) throw new TypeError(`Invalid model file: ${path}`)
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(12)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (bytesRead !== header.length || header.readBigUInt64LE(0) > BigInt(Math.min(info.size - 8, 100 * 1024 * 1024))
      || header[8] !== 123) throw new TypeError(`Invalid model file header: ${path}`)
  } finally {
    await file.close()
  }
  return info.size
}

async function indexedComponent(path: string): Promise<number> {
  const index = await jsonFile(path)
  const map = index.weight_map
  if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.keys(map).length) {
    throw new TypeError(`Empty or invalid shard index: ${path}`)
  }
  const files = new Set<string>()
  for (const name of Object.values(map)) {
    if (typeof name !== 'string' || basename(name) !== name || !/^[\w.-]+\.safetensors$/.test(name)) {
      throw new TypeError(`Unsafe shard path in index: ${path}`)
    }
    files.add(name)
  }
  let bytes = 0
  for (const name of files) bytes += await safetensors(join(path, '..', name))
  return bytes
}

export async function validateQwenEditCache(root: string) {
  const manifest = await jsonFile(join(root, 'model_index.json'))
  if (manifest._class_name !== 'QwenImageEditPipeline') {
    throw new TypeError(`Not a Qwen-Image-Edit Diffusers repository: ${root}`)
  }
  const encoder = await jsonFile(join(root, 'text_encoder', 'config.json'))
  if (encoder.model_type !== 'qwen2_5_vl') throw new TypeError(`Not a Qwen2.5-VL encoder: ${root}`)
  const diffusion = join(root, 'transformer', 'diffusion_pytorch_model.safetensors.index.json')
  const llm = join(root, 'text_encoder', 'model.safetensors.index.json')
  const vae = join(root, 'vae', 'diffusion_pytorch_model.safetensors')
  const diffusionBytes = await indexedComponent(diffusion)
  const llmBytes = await indexedComponent(llm)
  const vaeBytes = await safetensors(vae)
  return {
    diffusion: { path: diffusion, bytes: diffusionBytes },
    llm: { path: llm, bytes: llmBytes },
    vae: { path: vae, bytes: vaeBytes },
  }
}
