import { z } from 'zod'
import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { WorkAlignment } from '../sessions/work-alignment.ts'

const request = z.object({
  action: z.enum(['context', 'update', 'propose', 'adopt', 'checkpoint', 'transition', 'settle', 'release', 'select']),
  key: z.string().min(1).max(600).optional(), revision: z.number().int().positive().optional(),
  data: z.unknown().optional(),
}).strict()

export class WorkTool implements Tool {
  readonly name = 'work'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Versioned work alignment. Start with context for current contracts and schemas. Separate outcomes, existing boundaries and agent-chosen phases. Propose material changes; only the work controller/human applies them. Only the executor adopts a revision with stop/retain/next. Checkpoint before fresh-context/successor transitions. Neither reporting ownership nor a message receipt grants control, permissions or assignments.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: request.shape.action.options },
      key: { type: 'string', description: 'Work key returned by context.' },
      revision: { type: 'integer', description: 'Exact current semantic revision for adopt/checkpoint/transition/settle/release.' },
      data: { type: 'object', description: 'Action-specific bounded payload; obtain its schema with context.' },
    }, required: ['action'], additionalProperties: false,
  }
  constructor(private readonly alignment: WorkAlignment) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    const denied = context.tools.executionDenial('work', args)
    if (denied) return denied
    const parsed = request.parse(args)
    return JSON.stringify(await this.alignment.execute({ kind: 'session', sessionId: context.sessionId },
      parsed.action, parsed.key, parsed.revision, parsed.data, context.signal))
  }
}
