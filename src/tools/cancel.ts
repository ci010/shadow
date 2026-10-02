import type { A2aSessions } from '../a2a/sessions.ts'
import { backgroundTaskId, type BackgroundTaskManager } from '../agent/background-task.ts'
import { assertExecutionActor, assertOwnedExecution } from '../sessions/execution-scope.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

export class CancelTool implements Tool {
  readonly name = 'cancel'
  readonly workAdmission = () => 'cleanup' as const
  readonly description = 'Cancel one owned execution from v:bg, exec, or subagent. Waits for local work to stop; remote cancellation reports the remote state. Does not delete conversations or roll back side effects.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: { executionId: { type: 'string', description: 'Execution ID from v:bg: bg:... background work, local task/call ID, or remote:.../executions/...; not a conversation ID.' } },
    required: ['executionId'],
    additionalProperties: false,
  }

  constructor(
    private readonly sessions: Pick<SessionManager, 'getSessionState' | 'getDelegationOwner' | 'assertFolderAccess' | 'getActiveSession'>,
    private readonly remote?: Pick<A2aSessions, 'cancel'>,
    private readonly background?: Pick<BackgroundTaskManager, 'cancelTask'>,
  ) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    const denied = context.tools.executionDenial(this.name, args)
    if (denied) return denied
    if (typeof args.executionId !== 'string' || Object.keys(args).some(key => key !== 'executionId')) {
      throw new Error('Cancel requires only executionId.')
    }
    if (args.executionId.startsWith('remote:')) {
      if (!this.remote) throw new Error('A2A is not configured in this Project.')
      return this.remote.cancel(args.executionId, context)
    }
    const executionId = args.executionId
    if (executionId.startsWith('bg:')) {
      assertExecutionActor(this.sessions, context)
      if (!this.background) throw new Error('Background executions are unavailable.')
      const status = await this.background.cancelTask(backgroundTaskId(executionId), context)
      return JSON.stringify({ executionId, status })
    }
    const state = assertOwnedExecution(this.sessions, executionId, context)
    if (state.executionStatus && ['completed', 'failed', 'cancelled'].includes(state.executionStatus)) {
      return JSON.stringify({ executionId, status: state.executionStatus })
    }
    const active = this.sessions.getActiveSession(executionId)
    if (!active) throw new Error('Execution is not active; inspect its recorded state before retrying cancellation.')
    active.cancel()
    await active.completion
    const status = this.sessions.getSessionState(executionId)?.executionStatus
    if (!status || !['completed', 'failed', 'cancelled'].includes(status)) {
      throw new Error('Execution stopped without a terminal receipt; inspect its history.')
    }
    return JSON.stringify({ executionId, status })
  }
}
