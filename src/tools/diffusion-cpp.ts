import { randomUUID } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { DiffusionCppService, configureSchema, imageSchema, videoSchema } from '../diffusion-cpp/service.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('discover'), roots: z.array(z.string().min(1)).max(6).optional() }).strict(),
  z.object({ action: z.literal('inspect'), which: z.enum(['help', 'devices']).default('help') }).strict(),
  configureSchema.extend({ action: z.literal('configure') }),
  imageSchema.extend({ action: z.literal('image') }),
  videoSchema.extend({ action: z.literal('video') }),
])

export class DiffusionCppTool implements Tool {
  readonly name = 'diffusion_cpp'
  readonly description =
    'Optional local stable-diffusion.cpp image/video generation. Discover and reuse existing model weights; configure ' +
    'Qwen Image 2.1, legacy Qwen-Image-Edit, Z-Image-Turbo, Anima or MiniMax-H3 explicitly. No implicit downloads. Read v:skills/diffusion-cpp.'
  readonly readonly = (args: Record<string, unknown>) =>
    args.action === 'status' || args.action === 'discover' || args.action === 'inspect'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'discover', 'inspect', 'configure', 'image', 'video'] },
      roots: { type: 'array', items: { type: 'string' }, description: 'discover: up to six additional, approved, absolute model directories' },
      which: { type: 'string', enum: ['help', 'devices'], description: 'inspect: CLI help or backend devices' },
      binary: { type: 'string', description: 'configure: absolute sd-cli path; PATH and SDCPP_CLI_PATH also supported' },
      preset: { type: 'string', enum: ['qwen_image_2_1', 'qwen_image_edit', 'z_image_turbo', 'anima', 'minimax_h3'], description: 'configure or image; omitted for image means Qwen Image 2.1' },
      diffusion: { type: 'string', description: 'configure: absolute diffusion GGUF, safetensors or legacy Qwen Diffusers index path' },
      vae: { type: 'string', description: 'configure: absolute dedicated VAE path' },
      llm: { type: 'string', description: 'configure: absolute compatible encoder path (legacy Qwen uses its Diffusers index); H3 requires its specialized Qwen3-VL-32B variant' },
      vision: { type: 'string', description: 'configure: optional GGUF vision projection; required for Qwen 2.1 editing; empty string clears it' },
      audioVae: { type: 'string', description: 'configure: MiniMax-H3 audio VAE, required for synchronized audio/video' },
      refDiffusion: { type: 'string', description: 'configure: separate MiniMax-H3 Ref2VA diffusion model; empty string clears it' },
      options: { type: 'array', items: { type: 'string' }, description: 'configure: additional sd-cli argv tokens; input/output/model selectors are reserved' },
      licenseAcknowledged: { type: 'boolean', description: 'configure: true only after the user has reviewed and accepted the selected model license' },
      prompt: { type: 'string', description: 'image or video generation prompt' },
      width: { type: 'integer', description: 'pixels, 64..2048, multiple of 32' },
      height: { type: 'integer', description: 'pixels, 64..2048, multiple of 32' },
      steps: { type: 'integer', description: 'optional inference steps; Z-Image-Turbo defaults to eight' },
      cfgScale: { type: 'number', description: 'image: classifier-free guidance; model-specific defaults apply' },
      seed: { type: 'integer', description: 'optional reproducible seed' },
      reference: { type: 'string', description: 'image: Qwen 2.1 editing reference; required for legacy Qwen-Image-Edit, unsupported for Z or Anima' },
      mode: { type: 'string', enum: ['fl2va', 'ref2va'], description: 'video: text/first-last-frame or reference-conditioned generation' },
      frames: { type: 'integer', description: 'video: 17k+5 frames, 5..226; default 56 at 24 fps' },
      initImage: { type: 'string', description: 'video fl2va: optional first frame' },
      endImage: { type: 'string', description: 'video fl2va: optional last frame; requires first frame' },
      referenceImages: { type: 'array', items: { type: 'string' }, description: 'video ref2va: up to four reference image paths' },
    },
    required: ['action'], additionalProperties: false,
  }

  constructor(
    private readonly service: DiffusionCppService,
    private readonly projectId: string,
    private readonly workspace: string,
    private readonly sessionDataDir: (sessionId: string) => string,
  ) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.projectId) throw new Error('sd-cli requires the owning Project context')
    if (context.remoteWorkdir) throw new Error('sd-cli requires a local workdir; remote devices need their own execution capability')
    context.signal.throwIfAborted()
    const input = argsSchema.parse(args)
    if (input.action === 'status') return JSON.stringify(await this.service.status())
    if (input.action === 'discover') {
      for (const root of input.roots ?? []) if (!isAbsolute(root)) throw new TypeError(`Expected an absolute model directory: ${root}`)
      return JSON.stringify(await this.service.discover(input.roots, context.signal))
    }
    if (input.action === 'inspect') return this.service.inspect(input.which, context.signal)
    if (input.action === 'configure') {
      const { action: _action, ...configuration } = input
      return JSON.stringify(await this.service.configure(configuration, context.signal))
    }
    if (!context.cwd) throw new Error('sd-cli requires a local session workdir')
    const sessionRoot = this.sessionDataDir(context.sessionId)
    const sessionInfo = await lstat(sessionRoot)
    if (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink()) throw new Error('Invalid session data directory')
    const mediaRoot = join(sessionRoot, 'media')
    await mkdir(mediaRoot, { recursive: true })
    const mediaInfo = await lstat(mediaRoot)
    if (!mediaInfo.isDirectory() || mediaInfo.isSymbolicLink()) throw new Error('Invalid session media directory')
    const isImage = input.action === 'image'
    const filename = `sd-cpp-${randomUUID()}.${isImage ? 'png' : 'webm'}`
    const path = join(mediaRoot, filename)
    if (isImage) {
      const { action: _action, ...request } = input
      const reference = request.reference && resolveAgentPath(this.workspace, context.cwd, request.reference)
      await this.service.image({ ...request, ...(reference ? { reference } : {}) }, path, context.signal)
    } else {
      const { action: _action, ...request } = input
      const resolveImage = (value: string) => resolveAgentPath(this.workspace, context.cwd!, value)
      await this.service.video({
        ...request,
        ...(request.initImage ? { initImage: resolveImage(request.initImage) } : {}),
        ...(request.endImage ? { endImage: resolveImage(request.endImage) } : {}),
        ...(request.referenceImages ? { referenceImages: request.referenceImages.map(resolveImage) } : {}),
      }, path, context.signal)
    }
    return JSON.stringify({ path, media: `media/${basename(path)}` })
  }
}
