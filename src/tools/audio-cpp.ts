import { setupSchema } from '../audio-cpp/install.ts'
import { candidateSchema } from '../audio-cpp/assessment.ts'
import { remoteSchema } from '../audio-cpp/remote.ts'
import { z } from 'zod'
import { AudioCppService } from '../audio-cpp/service.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('assess'), candidate: candidateSchema }).strict(),
  z.object({ action: z.literal('setup'), setup: setupSchema }).strict(),
  z.object({ action: z.literal('configure_remote'), task: z.enum(['asr', 'tts']), remote: remoteSchema }).strict(),
  z.object({ action: z.literal('inspect'), task: z.enum(['asr', 'tts']).optional() }).strict(),
  z.object({
    action: z.literal('configure'), binary: z.string().optional(), task: z.enum(['asr', 'tts']).optional(),
    family: z.string().optional(), path: z.string().optional(), backend: z.string().optional(),
    options: z.array(z.string()).optional(),
  }).strict(),
  z.object({ action: z.literal('transcribe'), input: z.string().min(1) }).strict(),
  z.object({ action: z.literal('speak'), text: z.string().min(1), output: z.string().min(1) }).strict(),
])

const artifactProperties = {
  url: { type: 'string', description: 'Pinned approved HTTPS source URL' },
  sha256: { type: 'string', description: 'Published trusted lowercase SHA-256; never invent a digest' },
  bytes: { type: 'integer', description: 'Exact published artifact size in bytes' },
}
const setupParameter = {
  type: 'object', additionalProperties: false,
  description: 'Explicit approved verified ZIP CLI + single GGUF installation with automatic configuration. Read v:skills/audio-cpp.',
  properties: {
    approved: { type: 'boolean', description: 'True only after source/license/disk-use approval' },
    binary: { type: 'object', additionalProperties: false, properties: { ...artifactProperties, entry: { type: 'string' }, platform: { type: 'string', enum: ['win32', 'linux', 'darwin'] }, arch: { type: 'string', enum: ['x64', 'arm64'] } }, required: ['url', 'sha256', 'bytes', 'entry', 'platform', 'arch'] },
    model: { type: 'object', additionalProperties: false, properties: { ...artifactProperties, family: { type: 'string' } }, required: ['url', 'sha256', 'bytes', 'family'] },
    task: { type: 'string', enum: ['asr', 'tts'] }, backend: { type: 'string', enum: ['cpu', 'cuda', 'vulkan', 'metal', 'hip', 'best'] }, options: { type: 'array', items: { type: 'string' } },
  }, required: ['approved', 'binary', 'model', 'task'],
}
const candidateParameter = {
  type: 'object', additionalProperties: false, description: 'Specific model/backend capacity assessment. Memory requirements require a published evidence URL; suitable does not prove inference.',
  properties: { family: { type: 'string' }, backend: { type: 'string', enum: ['cpu', 'cuda', 'vulkan', 'metal', 'hip', 'best'] }, downloadBytes: { type: 'integer' }, platform: { type: 'string', enum: ['win32', 'linux', 'darwin'] }, arch: { type: 'string', enum: ['x64', 'arm64'] }, minimumMemoryBytes: { type: 'integer' }, memoryEvidence: { type: 'string' } }, required: ['family', 'downloadBytes', 'platform', 'arch'],
}
const remoteParameter = {
  type: 'object', additionalProperties: false, description: 'Explicit OpenAI-compatible /v1 API configuration. No upload/probe on configuration. Never put secret keys in arguments.',
  properties: { baseUrl: { type: 'string' }, model: { type: 'string' }, voice: { type: 'string', description: 'Optional TTS voice, default alloy' }, apiKeyEnv: { type: 'string', description: 'Existing host environment secret reference, not its value' } }, required: ['baseUrl', 'model'],
}

export class AudioCppTool implements Tool {
  readonly name: string
  readonly description = 'Unified audio ASR/TTS: assess host/model suitability, explicitly setup verified local audio.cpp ZIP + GGUF and auto-register, or configure an OpenAI-compatible remote API. transcribe/speak use the selected task route; never silently fall back. Downloads require prior source/license/disk approval. Read v:skills/audio-cpp for setup and troubleshooting.'
  readonly readonly = (args: Record<string, unknown>) => args.action === 'status' || args.action === 'inspect' || args.action === 'assess'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'assess', 'setup', 'configure_remote', 'inspect', 'configure', 'transcribe', 'speak'] },
      setup: setupParameter,
      candidate: candidateParameter,
      remote: remoteParameter,
      binary: { type: 'string', description: 'configure: absolute installed audiocpp_cli path' },
      task: { type: 'string', enum: ['asr', 'tts'] },
      family: { type: 'string', description: 'configure: upstream loader family name' },
      path: { type: 'string', description: 'configure: absolute downloaded model GGUF file or directory' },
      backend: { type: 'string', enum: ['cpu', 'cuda', 'vulkan', 'metal', 'hip', 'best'] },
      options: { type: 'array', items: { type: 'string' }, description: 'configure: CLI option tokens, e.g. ["--language","zh","--voice-id","zf_xiaobei"]; cannot override Shadow-owned paths/selectors' },
      input: { type: 'string', description: 'transcribe: WAV file path relative to the current session or absolute' },
      text: { type: 'string', description: 'speak: text to synthesize' },
      output: { type: 'string', description: 'speak: new WAV file path relative to the current session or absolute' },
    },
    required: ['action'], additionalProperties: false,
  }
  constructor(private readonly service: AudioCppService, private readonly projectId: string, private readonly workspace: string, name = 'audio_cpp') { this.name = name }
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.projectId) throw new Error('audio.cpp requires the owning Project context')
    if (context.remoteWorkdir) throw new Error('Audio requires a local owning Project capability; remote workdirs are not supported')
    context.signal.throwIfAborted()
    const input = argsSchema.parse(args)
    if (input.action === 'assess') return JSON.stringify(await this.service.assess(input.candidate))
    if (input.action === 'setup') return JSON.stringify(await this.service.setup(input.setup, context.signal))
    if (input.action === 'configure_remote') return JSON.stringify(await this.service.configureRemote(input.task, input.remote, context.signal))
    if (input.action === 'status') return JSON.stringify(await this.service.status())
    if (input.action === 'inspect') return this.service.inspect(input.task, context.signal)
    if (input.action === 'configure') return JSON.stringify(await this.service.configure(input, context.signal))
    if (!context.cwd) throw new Error('audio.cpp requires a local session workdir')
    if (input.action === 'transcribe') {
      return JSON.stringify({ text: await this.service.transcribe(
        resolveAgentPath(this.workspace, context.cwd, input.input), context.signal,
      ) })
    }
    const output = resolveAgentPath(this.workspace, context.cwd, input.output)
    return JSON.stringify({ path: await this.service.speak(input.text, output, context.signal) })
  }
}
