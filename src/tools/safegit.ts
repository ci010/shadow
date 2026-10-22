import { z } from 'zod'
import { SafegitRunner } from '../execution/git/safegit.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('run'), args: z.array(z.string().max(32768)).min(1).max(1024) }).strict(),
])

/** Local capability, not a global Git policy or shell sandbox. */
export class SafegitTool implements Tool {
  readonly name = 'safegit'
  readonly description = 'Inspect or run the pinned safegit binary in the current local workdir. Use for commits and pushes; no git fallback, shell interpolation or automatic approval. Pinned fork supports native Windows x64 and macOS/Linux x64/arm64. Git must be installed; gh is optional and is not bundled.'
  readonly readonly = (args: Record<string, unknown>) => args.action === 'status'
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'run'] },
      args: { type: 'array', items: { type: 'string' }, description: 'run: literal CLI arguments, e.g. ["commit", "-m", "message", "--", "file"] or ["push", "--refs", "head"]. Does not grant authorization.' },
    }, required: ['action'], additionalProperties: false,
  }
  constructor(private readonly runner: SafegitRunner, private readonly projectId: string) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.projectId) throw new Error('safegit requires the owning Project context')
    if (context.remoteWorkdir) throw new Error('safegit requires a local workdir; remote execution is not implemented')
    context.signal.throwIfAborted()
    const input = schema.parse(args)
    if (input.action === 'status') return JSON.stringify(await this.runner.status())
    if (!context.cwd) throw new Error('safegit requires a resolved local workdir')
    return JSON.stringify(await this.runner.run(input.args, context.cwd, context.signal))
  }
}
