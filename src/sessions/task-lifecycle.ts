/** Task acceptance is independent of executionStatus and Work lifecycle state.
 * Actor IDs must come from the authenticated caller, never from action payloads.
 */
export type TaskStatus = 'working' | 'in_review' | 'changes_requested' | 'closed' | 'cancelled'

export interface TaskSubmission {
  readonly revision: number
  readonly runId: string
  readonly artifactRef: string
}

export interface TaskLifecycle {
  readonly creatorSessionId: string
  readonly workerSessionId: string
  /** Explicitly granted by the creator; absent means no delegated reviewer. */
  readonly reviewerSessionId?: string
  readonly status: TaskStatus
  readonly revision: number
  readonly activeRunId?: string
  readonly submissions: readonly TaskSubmission[]
}

export type TaskLifecycleAction =
  | { type: 'set_reviewer'; reviewerSessionId: string | null }
  | { type: 'start_run'; runId: string }
  | { type: 'submit'; runId: string; artifactRef: string }
  | { type: 'request_changes'; revision: number }
  | { type: 'close'; revision: number }
  | { type: 'cancel' }

export class TaskLifecycleError extends Error {}

function requireTask(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TaskLifecycleError(message)
}

function requireText(value: string, name: string): void {
  requireTask(typeof value === 'string' && value.trim().length > 0, `${name} must be non-empty text`)
}

/** Creation is a creator-owned operation; any reviewer here is an explicit grant. */
export function createTaskLifecycle(input: {
  creatorSessionId: string
  workerSessionId: string
  reviewerSessionId?: string
}): TaskLifecycle {
  requireText(input.creatorSessionId, 'creatorSessionId')
  requireText(input.workerSessionId, 'workerSessionId')
  if (input.reviewerSessionId !== undefined) requireText(input.reviewerSessionId, 'reviewerSessionId')
  return {
    creatorSessionId: input.creatorSessionId,
    workerSessionId: input.workerSessionId,
    ...(input.reviewerSessionId === undefined ? {} : { reviewerSessionId: input.reviewerSessionId }),
    status: 'working', revision: 0, submissions: [],
  }
}

/** Pure transition: throws on denied/invalid operations, including terminal no-ops.
 * Creator authority takes precedence when creator and worker are the same session.
 * A worker who is only a delegated reviewer cannot accept their own work.
 * State is JSON data; persist/restore it independently of execution status.
 */
export function transitionTaskLifecycle(
  state: TaskLifecycle,
  actorSessionId: string,
  action: TaskLifecycleAction,
): TaskLifecycle {
  requireText(actorSessionId, 'actorSessionId')
  requireTask(state.status !== 'closed' && state.status !== 'cancelled', 'Task is terminal')
  const creator = actorSessionId === state.creatorSessionId
  const worker = actorSessionId === state.workerSessionId
  // Copy nested data too, so the result shares no mutable submission objects.
  const next = { ...state, submissions: state.submissions.map(submission => ({ ...submission })) }
  switch (action.type) {
    case 'set_reviewer': {
      requireTask(creator, 'Only the creator may configure the reviewer')
      if (action.reviewerSessionId === null) delete next.reviewerSessionId
      else {
        requireText(action.reviewerSessionId, 'reviewerSessionId')
        next.reviewerSessionId = action.reviewerSessionId
      }
      return next
    }
    case 'cancel':
      requireTask(creator, 'Only the creator may cancel')
      return { ...next, status: 'cancelled' }
    case 'start_run':
      requireTask(worker, 'Only the worker may start a run')
      requireTask(state.status === 'changes_requested'
        || (state.status === 'working' && state.activeRunId === undefined), 'Cannot start a run in this state')
      requireText(action.runId, 'runId')
      requireTask(!state.submissions.some(submission => submission.runId === action.runId), 'A new runId is required')
      return { ...next, status: 'working', activeRunId: action.runId }
    case 'submit': {
      requireTask(worker, 'Only the worker may submit')
      requireTask(state.status === 'working', 'Only working tasks may be submitted')
      requireText(action.runId, 'runId')
      requireText(action.artifactRef, 'artifactRef')
      requireTask(state.activeRunId === action.runId, 'Submission must reference the active run')
      requireTask(Number.isSafeInteger(state.revision + 1), 'Submission revision exhausted')
      const revision = state.revision + 1
      return {
        ...next, status: 'in_review', revision,
        submissions: [...next.submissions, { revision, runId: action.runId, artifactRef: action.artifactRef }],
      }
    }
    case 'request_changes':
    case 'close':
      requireTask(creator || (!worker && actorSessionId === state.reviewerSessionId),
        'Only the creator or a non-worker authorized reviewer may review')
      requireTask(state.status === 'in_review', 'Task must be in review')
      requireTask(Number.isSafeInteger(action.revision) && action.revision === state.revision,
        'Review must target the exact current submission revision')
      return { ...next, status: action.type === 'close' ? 'closed' : 'changes_requested' }
    default:
      throw new TaskLifecycleError('Unknown task lifecycle action')
  }
}
