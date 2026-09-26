import { backgroundTaskId, type BackgroundTaskManager } from '../agent/background-task.ts'
import { assertExecutionActor } from '../sessions/execution-scope.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

export class ContinuationTool implements Tool {
  readonly name = 'continuation'
  readonly readonly = false
  readonly description =
    'Set a continuation string on a background task. ' +
    'When the task completes and its event fires back to the session, ' +
    'the continuation text will be carried as a prefix in the callback message.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      executionId: {
        type: 'string',
        description: 'Owned bg:... executionId from v:bg or exec. Not a local task/call or remote execution.',
      },
      continuation: {
        type: 'string',
        description: 'Continuation text to carry with the task completion event.',
      },
    },
    required: ['executionId', 'continuation'],
    additionalProperties: false,
  }

  constructor(
    private tasks: BackgroundTaskManager,
    private sessions: Pick<SessionManager, 'getSessionState' | 'assertFolderAccess'>,
  ) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    const preview = String(args.continuation ?? '')
    const short = preview.length > 40 ? preview.slice(0, 40) + '…' : preview
    return `🔗 ${String(args.executionId ?? '')} → ${short}`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    assertExecutionActor(this.sessions, context)
    const denied = context.tools.executionDenial(this.name, args)
    if (denied) return denied
    if (typeof args.executionId !== 'string' || Object.keys(args).some(key => !['executionId', 'continuation'].includes(key))) {
      throw new Error('Continuation requires executionId and continuation.')
    }
    const taskId = backgroundTaskId(args.executionId)
    this.tasks.assertOwner(context, taskId)
    const continuation = typeof args.continuation === 'string' ? args.continuation : ''
    if (!continuation) return 'Error: `continuation` is required'
    return this.tasks.setContinuation(taskId, continuation)
  }
}
