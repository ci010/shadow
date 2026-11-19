import { z } from 'zod'
import { SubOverrideStore } from '../agent/context/sub-override.ts'
import { isDirectOwnerTurn } from '../sessions/owner-policy.ts'
import type { ExecutionContext } from './context.ts'
import { ToolNoEffectError, type Tool, type ToolParameters } from './tool.ts'

const input = z.object({ markdown: z.string() }).strict()

export class SubOverrideSaveTool implements Tool {
  readonly name = 'sub_override_save'
  readonly description = 'Save Markdown behavior for the built-in sub role as an immutable Project draft. Use for role behavior and selection among already permitted tools only. Does not enable the draft or change permissions or execution contracts. A direct Project owner Web user turn is required.'
  readonly readonly = false
  readonly parameters: ToolParameters = { type: 'object', additionalProperties: false, required: ['markdown'], properties: {
    markdown: { type: 'string', description: 'Role behavior Markdown (at most 16 KiB).' },
  } }

  constructor(private store: SubOverrideStore, private projectId: string, private authorized: (context: ExecutionContext) => boolean) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext) {
    if (context.projectId !== this.projectId || !isDirectOwnerTurn(context) ||
      context.remoteWorkdir || context.layerfsWorkdir || context.scriptInvocation || context.javascriptInvocation ||
      context.recoveringToolCall || !context.soleDirectToolCall || context.tools.dynamicOwner !== context.tools || !this.authorized(context)) {
      throw new ToolNoEffectError('Saving sub drafts requires a direct authorized Project owner Web turn.')
    }
    const { markdown } = input.parse(args)
    context.signal.throwIfAborted()
    return JSON.stringify({ revision: await this.store.save(markdown), enabled: false })
  }
}
