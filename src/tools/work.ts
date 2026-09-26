import { z } from 'zod'
import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { WorkAlignment } from '../sessions/work-alignment.ts'

const request = z.object({
  action: z.enum(['context', 'list', 'tree', 'create', 'update', 'propose', 'assign', 'manage', 'progress', 'dependencies', 'adopt', 'checkpoint', 'transition', 'settle', 'select']),
  key: z.string().min(1).max(600).optional(), revision: z.number().int().positive().optional(),
  data: z.unknown().optional(),
}).strict()

export class WorkTool implements Tool {
  readonly name = 'work'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Manage work items: definitions, assignments, dependencies, progress and versioned adoption in one place. Read context for schemas; list finds Project work and tree derives an Initiative view. Create work only when executing or tracking it, not for ordinary conversation. Propose material changes for one human review via ask or the Work panel. Session creation is independent. Only the assigned executor adopts and reports progress; execution completion is not acceptance.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: request.shape.action.options },
      key: { type: 'string', description: 'Work key returned by context.' },
      revision: { type: 'integer', description: 'Exact current semantic revision for mutations and selection.' },
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
