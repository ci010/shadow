import { z } from 'zod'
import { AudioCppService } from '../audio-cpp/service.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('inspect'), task: z.enum(['asr', 'tts']).optional() }).strict(),
  z.object({
    action: z.literal('configure'), binary: z.string().optional(), task: z.enum(['asr', 'tts']).optional(),
    family: z.string().optional(), path: z.string().optional(), backend: z.string().optional(),
    options: z.array(z.string()).optional(),
  }).strict(),
  z.object({ action: z.literal('transcribe'), input: z.string().min(1) }).strict(),
  z.object({ action: z.literal('speak'), text: z.string().min(1), output: z.string().min(1) }).strict(),
])

export class AudioCppTool implements Tool {
  readonly name = 'audio_cpp'
  readonly description = 'Optional local audio.cpp ASR/TTS: inspect installation and model settings, configure installed CLI and models, transcribe WAV or synthesize WAV. No download or installation occurs implicitly. Read v:skills/audio-cpp for setup and troubleshooting.'
  readonly readonly = (args: Record<string, unknown>) => args.action === 'status' || args.action === 'inspect'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'inspect', 'configure', 'transcribe', 'speak'] },
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
  constructor(private readonly service: AudioCppService, private readonly projectId: string, private readonly workspace: string) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.projectId) throw new Error('audio.cpp requires the owning Project context')
    context.signal.throwIfAborted()
    const input = argsSchema.parse(args)
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
