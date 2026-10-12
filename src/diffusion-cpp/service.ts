import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../config/store.ts'
import { workspacePath } from '../utils/paths.ts'
import { discoverModels, knownModelRoots, matchesComponent, type Component, type Preset } from './discovery.ts'
import { validateQwenEditCache } from './qwen-edit-cache.ts'

const presetName = z.enum(['qwen_image_2_1', 'qwen_image_edit', 'z_image_turbo', 'anima', 'minimax_h3'])
const modelPaths = z.object({
  diffusion: z.string().min(1),
  vae: z.string().min(1),
  llm: z.string().min(1),
  vision: z.string().min(1).optional(),
  audioVae: z.string().min(1).optional(),
  refDiffusion: z.string().min(1).optional(),
  options: z.array(z.string()).default([]),
  licenseAcknowledged: z.literal(true),
}).strict()
const configSchema = z.object({
  version: z.literal(1),
  binary: z.string().min(1).optional(),
  presets: z.object({
    qwen_image_2_1: modelPaths.optional(),
    qwen_image_edit: modelPaths.optional(),
    z_image_turbo: modelPaths.optional(),
    anima: modelPaths.optional(),
    minimax_h3: modelPaths.optional(),
  }).strict().default({}),
}).strict()
export const configureSchema = z.object({
  binary: z.string().min(1).optional(),
  preset: presetName.optional(),
  diffusion: z.string().min(1).optional(),
  vae: z.string().min(1).optional(),
  llm: z.string().min(1).optional(),
  vision: z.string().optional(),
  audioVae: z.string().min(1).optional(),
  refDiffusion: z.string().optional(),
  options: z.array(z.string()).optional(),
  licenseAcknowledged: z.literal(true).optional(),
}).strict()
export const imageSchema = z.object({
  preset: z.enum(['qwen_image_2_1', 'qwen_image_edit', 'z_image_turbo', 'anima']).default('qwen_image_2_1'),
  prompt: z.string().trim().min(1).max(8000),
  width: z.number().int().min(64).max(2048).default(512),
  height: z.number().int().min(64).max(2048).default(512),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().finite().min(0).max(30).optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
  reference: z.string().optional(),
}).strict()
export const videoSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  mode: z.enum(['fl2va', 'ref2va']).default('fl2va'),
  width: z.number().int().min(64).max(2048).default(864),
  height: z.number().int().min(64).max(2048).default(480),
  frames: z.number().int().min(5).max(226).default(56),
  steps: z.number().int().min(1).max(150).optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
  initImage: z.string().optional(),
  endImage: z.string().optional(),
  referenceImages: z.array(z.string()).max(4).optional(),
}).strict()
export type ConfigureDiffusion = z.input<typeof configureSchema>
export type ImageRequest = z.input<typeof imageSchema>
export type VideoRequest = z.input<typeof videoSchema>
type ModelPaths = z.infer<typeof modelPaths>
type Config = z.infer<typeof configSchema>
const COMPONENTS = ['diffusion', 'vae', 'llm', 'vision', 'audioVae', 'refDiffusion'] as const
const OWNED_FLAGS = new Set([
  '-M', '--mode', '-m', '--model', '--diffusion-model', '--vae', '--audio-vae',
  '--llm', '--llm_vision', '--llm-vision', '--init-img', '-i', '--end-img',
  '-r', '--ref-image', '--ref-video', '--ref-video-audio', '--ref-audio',
  '-p', '--prompt', '-o', '--output', '-W', '--width', '-H', '--height',
  '--fps', '--video-frames', '--cfg-scale', '--flow-shift', '--steps', '--seed', '--batch-count',
  '-b', '--log-file', '--convert',
])
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const PROBE_MS = 30_000
const IMAGE_MS = 90 * 60_000
const VIDEO_MS = 4 * 60 * 60_000

function validateOptions(options: string[]): void {
  for (const arg of options) {
    if (!arg || /[\0\r\n]/.test(arg)) throw new TypeError('Invalid sd-cli option')
    if (OWNED_FLAGS.has(arg.split('=')[0])) throw new TypeError(`sd-cli option ${arg} is owned by Shadow`)
  }
}

export async function runSdCpp(binary: string, args: string[], signal?: AbortSignal, timeoutMs = IMAGE_MS): Promise<string> {
  signal?.throwIfAborted()
  return new Promise((resolveRun, reject) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const child = spawn(binary, args, {
      shell: false, windowsHide: true,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let size = 0
    let exceeded = false
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) { exceeded = true; child.kill(); return }
      if (stream === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
    }
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk))
    child.once('error', error => reject(timeout.aborted && !signal?.aborted
      ? new Error(`sd-cli timed out after ${timeoutMs} ms`, { cause: error }) : error))
    child.once('close', code => {
      if (exceeded) reject(new Error('sd-cli output exceeded 2 MiB'))
      else if (code !== 0) reject(new Error(`sd-cli exited ${code}: ${(stderr || stdout).slice(-4000)}`))
      else resolveRun(stdout)
    })
  })
}

async function existingFile(path: string, preset?: Preset, component?: Component): Promise<string> {
  if (!isAbsolute(path)) throw new TypeError(`Expected an absolute path: ${path}`)
  if (preset === 'qwen_image_edit' && component) {
    if (!['diffusion', 'llm', 'vae'].includes(component)) throw new TypeError(`Unexpected ${preset} ${component}`)
    const root = dirname(dirname(path))
    const parts = await validateQwenEditCache(root)
    if (resolve(path) !== parts[component as 'diffusion' | 'llm' | 'vae'].path) {
      throw new TypeError(`The ${preset} ${component} path must point to its Diffusers cache component`)
    }
    return path
  }
  const info = await stat(path)
  if (!info.isFile()) throw new TypeError(`Not a file: ${path}`)
  if (preset && component) {
    if (!matchesComponent(preset, component, basename(path))) {
      throw new TypeError(`The ${preset} ${component} file has an unexpected model name: ${basename(path)}`)
    }
    const file = await open(path, 'r')
    try {
      const header = Buffer.alloc(12)
      const { bytesRead } = await file.read(header, 0, header.length, 0)
      if (bytesRead < header.length || (extname(path).toLowerCase() === '.gguf'
        ? header.toString('ascii', 0, 4) !== 'GGUF'
        : header.readBigUInt64LE(0) > BigInt(Math.min(info.size - 8, 100 * 1024 * 1024)) || header[8] !== 123)) {
        throw new TypeError(`Invalid model file header: ${path}`)
      }
    } finally {
      await file.close()
    }
  }
  return path
}

async function imageFile(path: string): Promise<string> {
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path).toLowerCase())) {
    throw new TypeError('Reference image must be PNG, JPEG or WebP')
  }
  return existingFile(path)
}

async function outputAvailable(path: string, extension: string): Promise<void> {
  if (extname(path).toLowerCase() !== extension) throw new TypeError(`Output must be ${extension}`)
  try {
    await access(path, constants.F_OK)
    throw new Error(`Output already exists: ${path}`)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

async function checkOutput(path: string, kind: 'image' | 'video'): Promise<void> {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(1024)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    const valid = kind === 'image'
      ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && header.readUInt32BE(8) === 13 && header.toString('ascii', 12, 16) === 'IHDR'
        && header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0
      : header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
        && header.toString('ascii', 0, bytesRead).includes('webm')
    if (bytesRead < 24 || !valid || (await file.stat()).size <= (kind === 'image' ? 32 : 128)) {
      throw new Error(`sd-cli exited without producing a valid ${kind === 'image' ? 'PNG' : 'WebM'}`)
    }
  } finally {
    await file.close()
  }
}

function requiredComponents(preset: Preset): Component[] {
  return preset === 'minimax_h3' ? ['diffusion', 'vae', 'audioVae', 'llm'] : ['diffusion', 'vae', 'llm']
}

async function validateQwenEditComponents(entry: ModelPaths): Promise<void> {
  const parts = await validateQwenEditCache(dirname(dirname(entry.diffusion)))
  if (resolve(entry.llm) !== parts.llm.path || resolve(entry.vae) !== parts.vae.path) {
    throw new TypeError('Qwen-Image-Edit Diffusers components must come from the same cache')
  }
}

export class DiffusionCppService {
  private readonly configPath: string
  private pending: Promise<unknown> = Promise.resolve()
  private active = false

  constructor(workspace: string, private readonly run: typeof runSdCpp = runSdCpp) {
    this.configPath = workspacePath(workspace, '.diffusion-cpp.json')
  }

  async read(): Promise<Config> {
    let data: string
    try { data = await readFile(this.configPath, 'utf8') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1, presets: {} }
      throw error
    }
    return configSchema.parse(JSON.parse(data))
  }

  async binary(config?: Config): Promise<string | undefined> {
    config ??= await this.read()
    const requested = config.binary ?? process.env.SDCPP_CLI_PATH
    if (requested) return existingFile(requested)
    const executable = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (!directory) continue
      try { return await existingFile(join(directory, executable)) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    return undefined
  }

  async status() {
    const config = await this.read()
    const requested = config.binary ?? process.env.SDCPP_CLI_PATH
    let binary: string | undefined
    let binaryError: string | undefined
    try { binary = await this.binary(config) } catch (error) {
      binaryError = error instanceof Error ? error.message : String(error)
    }
    const presetStatus = async (preset: Preset) => {
      const entry = config.presets[preset]
      if (!entry) return {
        status: 'not_configured', components: {}, missing: requiredComponents(preset),
        options: [], licenseAcknowledged: false, imageEdit: false, referenceVideo: false,
      }
      const components: Record<string, { path: string; status: string; error?: string }> = {}
      for (const component of COMPONENTS) {
        const path = entry[component]
        if (!path) continue
        try { await existingFile(path, preset, component); components[component] = { path, status: 'path_accessible' } }
        catch (error) { components[component] = { path, status: 'invalid', error: error instanceof Error ? error.message : String(error) } }
      }
      if (preset === 'qwen_image_edit' && Object.values(components).every(value => value.status !== 'invalid')) {
        try { await validateQwenEditComponents(entry) } catch (error) {
          components.llm = {
            path: entry.llm, status: 'invalid', error: error instanceof Error ? error.message : String(error),
          }
        }
      }
      const missing = requiredComponents(preset).filter(component => !entry[component])
      const invalid = Object.values(components).some(value => value.status === 'invalid')
      return {
        status: invalid ? 'invalid' : missing.length ? 'incomplete' : 'path_accessible',
        components, missing, options: entry.options, licenseAcknowledged: entry.licenseAcknowledged,
        ...(preset === 'qwen_image_2_1' ? { imageEdit: !!entry.vision && components.vision?.status === 'path_accessible' } : {}),
        ...(preset === 'qwen_image_edit' ? { imageEdit: !invalid && !missing.length } : {}),
        ...(preset === 'minimax_h3' ? { referenceVideo: !!entry.refDiffusion && components.refDiffusion?.status === 'path_accessible' } : {}),
      }
    }
    return {
      status: binary ? 'available' : requested ? 'binary_error' : 'not_installed',
      binary: binary ?? requested ?? null,
      ...(binaryError ? { error: binaryError } : {}),
      configPath: this.configPath,
      presets: {
        qwen_image_2_1: await presetStatus('qwen_image_2_1'),
        qwen_image_edit: await presetStatus('qwen_image_edit'),
        z_image_turbo: await presetStatus('z_image_turbo'),
        anima: await presetStatus('anima'),
        minimax_h3: await presetStatus('minimax_h3'),
      },
      guide: 'v:skills/diffusion-cpp',
    }
  }

  discover(roots: string[] = [], signal?: AbortSignal) {
    return discoverModels([...knownModelRoots(), ...roots], signal)
  }

  configure(input: ConfigureDiffusion, signal?: AbortSignal): Promise<object> {
    const operation = this.pending.catch(() => {}).then(async () => {
      signal?.throwIfAborted()
      const update = configureSchema.parse(input)
      if (!update.binary && !update.preset) throw new TypeError('Provide binary and/or preset')
      if (!update.preset && Object.keys(update).some(key => key !== 'binary')) {
        throw new TypeError('Model fields require preset')
      }
      const current = await this.read()
      const next: Config = { ...current, presets: { ...current.presets } }
      if (update.binary) {
        const binary = await existingFile(update.binary)
        const help = await this.run(binary, ['--help'], signal, PROBE_MS)
        if (!help.includes('--diffusion-model') || !help.includes('--video-frames')) {
          throw new Error('Binary does not expose the expected stable-diffusion.cpp CLI options')
        }
        next.binary = binary
      }
      if (update.preset) {
        const preset = update.preset
        const old = current.presets[preset]
        const modelChanged = !old || COMPONENTS.some(component =>
          update[component] !== undefined && update[component] !== old[component])
        if (modelChanged && update.licenseAcknowledged !== true) {
          throw new TypeError(`Review the ${preset} model license and explicitly acknowledge it before configuring`)
        }
        const selected = modelPaths.parse({
          diffusion: update.diffusion ?? old?.diffusion,
          vae: update.vae ?? old?.vae,
          llm: update.llm ?? old?.llm,
          vision: update.vision === '' ? undefined : update.vision ?? old?.vision,
          audioVae: update.audioVae ?? old?.audioVae,
          refDiffusion: update.refDiffusion === '' ? undefined : update.refDiffusion ?? old?.refDiffusion,
          options: update.options ?? old?.options ?? [],
          licenseAcknowledged: update.licenseAcknowledged ?? old?.licenseAcknowledged,
        })
        if (['z_image_turbo', 'qwen_image_edit', 'anima'].includes(preset)
          && (selected.vision || selected.audioVae || selected.refDiffusion)
          || preset === 'qwen_image_2_1' && (selected.audioVae || selected.refDiffusion)) {
          throw new TypeError(`Unexpected components for ${preset}`)
        }
        for (const required of requiredComponents(preset)) {
          if (!selected[required]) throw new TypeError(`Missing ${preset} ${required}`)
        }
        validateOptions(selected.options)
        for (const component of COMPONENTS) {
          const path = selected[component]
          if (path) await existingFile(path, preset, component)
        }
        if (preset === 'qwen_image_edit') await validateQwenEditComponents(selected)
        next.presets[preset] = selected
      }
      signal?.throwIfAborted()
      await mkdir(dirname(this.configPath), { recursive: true })
      signal?.throwIfAborted()
      writePrivateFile(this.configPath, JSON.stringify(configSchema.parse(next), null, 2) + '\n')
      return this.status()
    })
    this.pending = operation
    return operation
  }

  async inspect(which: 'help' | 'devices', signal?: AbortSignal): Promise<string> {
    const binary = await this.binary()
    if (!binary) throw new Error('sd-cli not installed; read v:skills/diffusion-cpp')
    return (await this.run(binary, [which === 'help' ? '--help' : '--list-devices'], signal, PROBE_MS)).slice(0, 30000)
  }

  private async ready(preset: Preset): Promise<{ binary: string; entry: ModelPaths }> {
    const config = await this.read()
    const binary = await this.binary(config)
    if (!binary) throw new Error('sd-cli not installed; read v:skills/diffusion-cpp')
    const entry = config.presets[preset]
    if (!entry) throw new Error(`${preset} is not configured; read v:skills/diffusion-cpp`)
    for (const component of COMPONENTS) {
      const path = entry[component]
      if (path) await existingFile(path, preset, component)
    }
    if (preset === 'qwen_image_edit') await validateQwenEditComponents(entry)
    if (preset === 'minimax_h3' && !entry.audioVae) throw new Error('MiniMax-H3 audio VAE is not configured')
    return { binary, entry }
  }

  private async invoke(binary: string, args: string[], output: string, kind: 'image' | 'video', signal?: AbortSignal): Promise<string> {
    if (this.active) throw new Error('An sd-cli generation is already running in this Project')
    this.active = true
    try {
      await outputAvailable(output, kind === 'image' ? '.png' : '.webm')
      try {
        await this.run(binary, args, signal, kind === 'image' ? IMAGE_MS : VIDEO_MS)
        await checkOutput(output, kind)
        return output
      } catch (error) {
        try { await rm(output, { force: true }) } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'sd-cli failed and partial media could not be removed')
        }
        throw error
      }
    } finally {
      this.active = false
    }
  }

  async image(request: ImageRequest, output: string, signal?: AbortSignal): Promise<string> {
    const input = imageSchema.parse(request)
    if (input.width % 32 || input.height % 32) throw new TypeError('Image dimensions must be multiples of 32')
    if (input.preset === 'z_image_turbo' && input.reference) {
      throw new TypeError('Z-Image-Turbo is not configured as a Qwen Image 2.1 editing replacement')
    }
    if (input.preset === 'qwen_image_edit' && !input.reference) {
      throw new TypeError('Qwen-Image-Edit requires a reference image')
    }
    if (input.preset === 'anima' && input.reference) {
      throw new TypeError('The Anima preset supports text-to-image, not reference editing')
    }
    const { binary, entry } = await this.ready(input.preset)
    if (input.preset === 'qwen_image_2_1' && input.reference && !entry.vision) {
      throw new Error('Qwen Image 2.1 editing requires --llm_vision; configure its mmproj file')
    }
    const reference = input.reference ? await imageFile(input.reference) : undefined
    const args = ['--diffusion-model', entry.diffusion, '--vae', entry.vae, '--llm', entry.llm]
    if (entry.vision) args.push('--llm_vision', entry.vision)
    const animaTurbo = input.preset === 'anima' && /anima-turbo/i.test(basename(entry.diffusion))
    args.push('-p', input.prompt, '-W', String(input.width), '-H', String(input.height),
      '--cfg-scale', String(input.cfgScale ?? (input.preset === 'z_image_turbo' || animaTurbo ? 1
        : input.preset === 'qwen_image_edit' ? 2.5 : input.preset === 'anima' ? 4.5 : 6)),
      ...(input.preset === 'z_image_turbo'
        ? ['--steps', String(input.steps ?? 8), '--diffusion-fa']
        : input.preset === 'qwen_image_edit'
          ? ['--sampling-method', 'euler', '--diffusion-fa', '--flow-shift', '3', ...(input.steps ? ['--steps', String(input.steps)] : [])]
          : input.preset === 'anima'
            ? ['--sampling-method', 'euler', '--diffusion-fa', '--steps', String(input.steps ?? (animaTurbo ? 10 : 35))]
            : ['--sampling-method', 'euler', '--fa', ...(input.steps ? ['--steps', String(input.steps)] : [])]),
      '--offload-to-cpu')
    if (input.seed !== undefined) args.push('--seed', String(input.seed))
    if (reference) args.push('-r', reference)
    args.push(...entry.options, '-o', output)
    return this.invoke(binary, args, output, 'image', signal)
  }

  async video(request: VideoRequest, output: string, signal?: AbortSignal): Promise<string> {
    const input = videoSchema.parse(request)
    if (input.width % 32 || input.height % 32) throw new TypeError('Video dimensions must be multiples of 32')
    if ((input.frames - 5) % 17) throw new TypeError('MiniMax-H3 frames must be 17k + 5 (minimum 5)')
    if (input.endImage && !input.initImage) throw new TypeError('An end image requires an initial image')
    if (input.mode === 'fl2va' && input.referenceImages?.length) throw new TypeError('Reference images require ref2va mode')
    if (input.mode === 'ref2va' && (input.initImage || input.endImage)) throw new TypeError('Ref2VA cannot combine with initial or end images')
    const { binary, entry } = await this.ready('minimax_h3')
    if (input.mode === 'ref2va' && !entry.refDiffusion) {
      throw new Error('Ref2VA requires a separately configured MiniMax-H3 reference diffusion model')
    }
    const init = input.initImage ? await imageFile(input.initImage) : undefined
    const end = input.endImage ? await imageFile(input.endImage) : undefined
    const refs = await Promise.all((input.referenceImages ?? []).map(imageFile))
    const args = ['-M', 'vid_gen',
      '--diffusion-model', input.mode === 'ref2va' ? entry.refDiffusion! : entry.diffusion,
      '--vae', entry.vae, '--audio-vae', entry.audioVae!, '--llm', entry.llm]
    if (entry.vision) args.push('--llm_vision', entry.vision)
    args.push('-p', input.prompt, '-W', String(input.width), '-H', String(input.height),
      '--cfg-scale', '1', '--diffusion-fa', '--offload-to-cpu', '--rng', 'cpu',
      '--fps', '24', '--video-frames', String(input.frames))
    if (input.steps !== undefined) args.push('--steps', String(input.steps))
    if (input.seed !== undefined) args.push('--seed', String(input.seed))
    if (init) args.push('--init-img', init)
    if (end) args.push('--end-img', end)
    for (const ref of refs) args.push('--ref-image', ref)
    args.push(...entry.options, '-o', output)
    return this.invoke(binary, args, output, 'video', signal)
  }
}
