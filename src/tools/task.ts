import type { SessionManager } from '../sessions/session-manager.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

/** Review authority comes exclusively from the authenticated session identity. */
export class TaskTool implements Tool {
  readonly name = 'task'
  readonly description = 'Submit a structured verdict for a fixed local task revision, or inspect its review record. Only the designated reviewer (parent by default) may review; worker finals never accept themselves. Changes automatically rerun the original worker; PASS delivers once; blocked escalates. Agent reviewers are created by the workflow. Calls and A2A are unsupported; Work is unchanged.'
  readonly supportsRemoteWorkdir = true
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: ['read', 'review'] },
      sessionId: { type: 'string', description: 'Original worker session ID.' },
      outcome: { type: 'string', enum: ['pass', 'changes_requested', 'blocked'], description: 'review only: structured verdict for the exact submission. Changes automatically rerun the worker; blocked escalates.' },
      revision: { type: 'integer', description: 'Exact submission revision from the review request.' },
      content: { type: 'string', description: 'Review explanation; required actionable instructions for changes_requested or reason for blocked.' },
    }, required: ['action', 'sessionId'], additionalProperties: false,
  }
  constructor(private readonly manager: SessionManager) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    if (typeof args.sessionId !== 'string' || typeof args.action !== 'string') throw new TypeError('Task action and sessionId are required')
    if (args.expectedVersion !== undefined && !Number.isSafeInteger(args.expectedVersion)) throw new TypeError('expectedVersion must be an integer')
    if (args.revision !== undefined && !Number.isSafeInteger(args.revision)) throw new TypeError('revision must be an integer')
    if (args.content !== undefined && typeof args.content !== 'string') throw new TypeError('content must be text')
    if (args.reviewerSessionId !== undefined && args.reviewerSessionId !== null && typeof args.reviewerSessionId !== 'string') throw new TypeError('reviewerSessionId must be text or null')
    if (args.action === 'review') {
      if (!Number.isSafeInteger(args.revision) || !['pass', 'changes_requested', 'blocked'].includes(String(args.outcome))) throw new TypeError('Review requires exact revision and structured outcome')
      return JSON.stringify(await this.manager.reviewTask(context.sessionId, args.sessionId, args.revision as number, args.outcome as 'pass' | 'changes_requested' | 'blocked', String(args.content ?? '')))
    }
    if (args.action !== 'read') throw new TypeError('Use review with a structured outcome; manual task orchestration is internal only')
    return JSON.stringify(await this.manager.taskAction(context.sessionId, args.sessionId, args.action, args.expectedVersion as number | undefined, { ...args, reviewerSessionId: args.reviewerSessionId === '' ? null : args.reviewerSessionId } as { reviewerSessionId?: string | null; revision?: number; content?: string }))
  }
}
