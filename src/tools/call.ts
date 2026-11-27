import type { ExecutionContext } from './context.ts'
import type { SubagentTool } from './subagent.ts'
import type { Tool, ToolParameters } from './tool.ts'

/** Separate native entry point; admission and the child lifecycle stay shared. */
export class CallTool implements Tool {
  readonly name = 'call'
  readonly supportsLayerFSWorkdir = true
  readonly preserveOutput = true
  readonly description = 'Run a blocking leaf in a snapshot of your context and return its result here. Inherits your role and inference settings. Invoke directly, not via a script. The child cannot ask, message, or delegate. Remote device workdirs are not supported.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Bounded assignment for the child, including the expected result.' },
      description: { type: 'string', description: 'Optional short label for the call trace.' },
    },
    required: ['task'],
    additionalProperties: false,
  }

  constructor(private readonly delegation: SubagentTool) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (Object.keys(args).some(key => key !== 'task' && key !== 'description')) {
      return 'Error: call accepts only task and optional description.'
    }
    if (typeof args.task !== 'string' || !args.task.trim()) return 'Error: task is required.'
    if (args.description !== undefined && typeof args.description !== 'string') return 'Error: description must be a string.'
    return this.delegation.execute({
      mode: 'call', task: args.task, description: args.description ?? args.task.trim().replace(/\s+/g, ' ').slice(0, 120),
    }, context)
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return String(args.description ?? args.task ?? '').trim().replace(/\s+/g, ' ').slice(0, 100)
  }
}
