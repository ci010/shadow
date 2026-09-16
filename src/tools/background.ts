import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

export class BackgroundTaskTool implements Tool {
  readonly name = 'kill'
  readonly readonly = false
  readonly description =
    'Kill a background task by ID.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to kill.',
      },
    },
    required: ['task_id'],
  }

  constructor(private tasks: BackgroundTaskManager) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `💥 ${String(args.task_id ?? '')}`
  }

  async execute(
    args: Record<string, unknown>,
    _context: ExecutionContext,
  ): Promise<string> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
    if (!taskId) return 'Error: `task_id` is required'
    return this.tasks.killTask(taskId)
  }
}

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
      task_id: {
        type: 'string',
        description: 'Background task ID.',
      },
      continuation: {
        type: 'string',
        description: 'Continuation text to carry with the task completion event.',
      },
    },
    required: ['task_id', 'continuation'],
  }

  constructor(private tasks: BackgroundTaskManager) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    const preview = String(args.continuation ?? '')
    const short = preview.length > 40 ? preview.slice(0, 40) + '…' : preview
    return `🔗 ${String(args.task_id ?? '')} → ${short}`
  }

  async execute(
    args: Record<string, unknown>,
    _context: ExecutionContext,
  ): Promise<string> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
    if (!taskId) return 'Error: `task_id` is required'
    const continuation = typeof args.continuation === 'string' ? args.continuation : ''
    if (!continuation) return 'Error: `continuation` is required'
    return this.tasks.setContinuation(taskId, continuation)
  }
}
