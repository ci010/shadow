import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { readdir, realpath, stat } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { validateQwenEditCache } from './qwen-edit-cache.ts'

export const presets = ['qwen_image_2_1', 'qwen_image_edit', 'z_image_turbo', 'anima', 'minimax_h3'] as const
export type Preset = typeof presets[number]
export type Component = 'diffusion' | 'vae' | 'llm' | 'vision' | 'audioVae' | 'refDiffusion'

const names: Array<{ preset: Preset; component: Component; pattern: RegExp }> = [
  { preset: 'qwen_image_2_1', component: 'diffusion', pattern: /^qwen_image_2\.1-.*\.gguf$|^qwen_image_2\.1_(?:int8_convrot|bf16)\.safetensors$/i },
  { preset: 'qwen_image_2_1', component: 'vae', pattern: /^qwen_image_2\.1_vae_bf16\.safetensors$/i },
  { preset: 'qwen_image_2_1', component: 'llm', pattern: /^Qwen3VL-8B-Instruct-.*\.gguf$/i },
  { preset: 'qwen_image_2_1', component: 'vision', pattern: /^mmproj-Qwen3VL-8B-Instruct-.*\.gguf$/i },
  { preset: 'anima', component: 'diffusion', pattern: /^anima-(?:preview(?:2|3-base)?|base-v1\.0|aesthetic-v1\.(?:0b?|1)|turbo-v1\.[01])\.safetensors$|^anima-(?:preview|base|aesthetic|turbo)[-\w.]*\.gguf$/i },
  { preset: 'anima', component: 'vae', pattern: /^qwen_image_vae\.safetensors$/i },
  { preset: 'anima', component: 'llm', pattern: /^qwen_3_06b_base\.safetensors$|^Qwen3-0\.6B-Base[-_].*\.gguf$/i },
  { preset: 'z_image_turbo', component: 'diffusion', pattern: /^z_image_turbo[-_].*\.(?:gguf|safetensors)$/i },
  { preset: 'z_image_turbo', component: 'vae', pattern: /^ae\.safetensors$/i },
  { preset: 'z_image_turbo', component: 'llm', pattern: /^Qwen3-4B-Instruct-2507-.*\.gguf$/i },
  { preset: 'minimax_h3', component: 'diffusion', pattern: /^minimax[-_]h3[-_]fl2va(?:[-_].*)?\.(?:gguf|safetensors)$/i },
  { preset: 'minimax_h3', component: 'refDiffusion', pattern: /^minimax[-_]h3[-_]ref2va(?:[-_].*)?\.(?:gguf|safetensors)$/i },
  { preset: 'minimax_h3', component: 'vae', pattern: /^minimax_h3_video_vae_(?:fp16|int8_convrot)\.safetensors$/i },
  { preset: 'minimax_h3', component: 'audioVae', pattern: /^minimax_h3_audio_vae_fp32\.safetensors$/i },
  { preset: 'minimax_h3', component: 'llm', pattern: /^qwen3vl_32b_minimax_h3[-_].*\.(?:gguf|safetensors)$/i },
  { preset: 'minimax_h3', component: 'vision', pattern: /^(?:mmproj[-_]qwen3[-_]?vl[-_]?32b|qwen3vl_32b_minimax_h3_(?:vision|vit))[-_].*\.(?:gguf|safetensors)$/i },
]

export function matchesComponent(preset: Preset, component: Component, filename: string): boolean {
  return names.some(entry => entry.preset === preset && entry.component === component && entry.pattern.test(filename))
}

export function knownModelRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const hfHome = env.HF_HOME || join(home, '.cache', 'huggingface')
  const msHome = env.MODELSCOPE_CACHE || join(home, '.cache', 'modelscope', 'hub')
  const comfy = env.COMFYUI_ROOT
  return [
    env.SHADOW_MODELS_DIR,
    env.HF_HUB_CACHE || join(hfHome, 'hub'),
    msHome,
    join(home, 'ComfyUI', 'models'),
    join(home, 'ComfyUI_windows_portable', 'ComfyUI', 'models'),
    comfy && join(comfy, 'models'),
  ].filter((path): path is string => !!path).map(path => resolve(path))
}

export interface Candidate {
  preset: Preset
  component: Component
  path: string
  bytes: number
  verification: 'filename_and_size_only' | 'index_and_shard_headers_only'
}

export async function discoverModels(roots: string[], signal?: AbortSignal): Promise<{
  searched: string[]
  candidates: Candidate[]
  truncated: boolean
  warnings: Array<{ path: string; error: string }>
}> {
  const searched: string[] = []
  const candidates: Candidate[] = []
  const warnings: Array<{ path: string; error: string }> = []
  const visited = new Set<string>()
  let examined = 0
  let truncated = false
  const warn = (path: string, error: unknown) => {
    if (warnings.length < 20) warnings.push({ path, error: error instanceof Error ? error.message : String(error) })
    else truncated = true
  }
  for (const input of new Set(roots.map(path => resolve(path)))) {
    signal?.throwIfAborted()
    if (!isAbsolute(input) || parse(input).root === input) throw new TypeError('Model discovery requires a bounded directory, not a volume root')
    let root: string
    try { root = await realpath(input) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      warn(input, error)
      continue
    }
    if (parse(root).root === root) throw new TypeError('Model discovery cannot scan a volume root')
    searched.push(input)
    const queue: Array<{ path: string; depth: number }> = [{ path: input, depth: 0 }]
    while (queue.length) {
      signal?.throwIfAborted()
      const current = queue.shift()!
      let canonical: string
      try { canonical = await realpath(current.path) } catch (error) {
        warn(current.path, error)
        continue
      }
      if (visited.has(canonical)) continue
      visited.add(canonical)
      let info: Stats
      try { info = await stat(current.path) } catch (error) {
        warn(current.path, error)
        continue
      }
      if (info.isFile()) {
        const filename = current.path.split(/[\\/]/).at(-1)!
        for (const match of names) {
          if (info.size > 16 && matchesComponent(match.preset, match.component, filename)) {
            candidates.push({
              preset: match.preset, component: match.component, path: current.path,
              bytes: info.size, verification: 'filename_and_size_only',
            })
          }
        }
        continue
      }
      if (!info.isDirectory()) continue
      if (current.depth >= 7) { truncated = true; continue }
      let entries: Dirent[]
      try { entries = await readdir(current.path, { withFileTypes: true }) } catch (error) {
        warn(current.path, error)
        continue
      }
      if (entries.some(entry => entry.name === 'model_index.json')) {
        try {
          const parts = await validateQwenEditCache(current.path)
          for (const component of ['diffusion', 'vae', 'llm'] as const) {
            candidates.push({
              preset: 'qwen_image_edit', component, ...parts[component],
              verification: 'index_and_shard_headers_only',
            })
          }
        } catch (error) {
          warn(current.path, error)
        }
      }
      for (const entry of entries) {
        if (++examined > 4000 || candidates.length >= 200) { truncated = true; break }
        if (entry.name === 'blobs' || entry.name === '.git' || entry.name === 'node_modules') continue
        const path = join(current.path, entry.name)
        if (entry.isDirectory()) queue.push({ path, depth: current.depth + 1 })
        else if (entry.isFile() || entry.isSymbolicLink()) {
          const matched = names.filter(match => match.pattern.test(entry.name))
          if (!matched.length) continue
          let file
          try { file = await stat(path) } catch (error) {
            warn(path, error)
            continue
          }
          if (!file.isFile() || file.size <= 16) continue
          for (const match of matched) {
            candidates.push({
              preset: match.preset, component: match.component, path,
              bytes: file.size, verification: 'filename_and_size_only',
            })
          }
        }
      }
      if (truncated && examined > 4000) break
    }
    if (examined > 4000 || candidates.length >= 200) break
  }
  const order: Component[] = ['diffusion', 'vae', 'audioVae', 'llm', 'vision', 'refDiffusion']
  candidates.sort((a, b) => a.preset.localeCompare(b.preset)
    || order.indexOf(a.component) - order.indexOf(b.component)
    || a.path.localeCompare(b.path))
  return { searched, candidates, truncated, warnings }
}
