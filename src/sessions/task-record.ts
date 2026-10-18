import type { TaskLifecycle } from './task-lifecycle.ts'

/** Durable acceptance record; version is a CAS token for every mutation, not just submissions. */
export interface TaskRecord extends TaskLifecycle {
  version: number
  reportedRunIds: string[]
  workflow?: {
    mode: 'parent' | 'agent'
    agentType?: string
    maxRounds: number
    assignment: string
    criteria: string
    reviewerSessionId?: string
    submission?: { revision: number; content: string; artifactRef: string }
    decision?: { revision: number; outcome: 'pass' | 'changes_requested' | 'blocked'; content: string }
    terminal?: 'passed' | 'failed'
    failure?: string
    delivered?: boolean
  }
  reviewReceipt?: { actorSessionId: string; revision: number; runId: string; at: string }
}

export class TaskRecordError extends TypeError {}

export function parseTaskRecord(value: unknown): TaskRecord {
  if (!value || typeof value !== 'object') throw new TaskRecordError('Invalid task record')
  const t = value as TaskRecord
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
  if (!text(t.creatorSessionId) || !text(t.workerSessionId)
    || (t.reviewerSessionId !== undefined && !text(t.reviewerSessionId))
    || !['working', 'in_review', 'changes_requested', 'closed', 'cancelled'].includes(t.status)
    || !integer(t.version) || !integer(t.revision)
    || (t.activeRunId !== undefined && !text(t.activeRunId))
    || !Array.isArray(t.reportedRunIds) || !t.reportedRunIds.every(text)
    || !Array.isArray(t.submissions) || !t.submissions.every(s => s && integer(s.revision) && s.revision > 0 && text(s.runId) && text(s.artifactRef))
    || (t.reviewReceipt !== undefined && (!text(t.reviewReceipt.actorSessionId) || !integer(t.reviewReceipt.revision)
      || !text(t.reviewReceipt.runId) || !text(t.reviewReceipt.at)))) throw new TaskRecordError('Invalid task record')
  if (t.workflow) {
    const w = t.workflow
    if (!['parent', 'agent'].includes(w.mode) || !Number.isSafeInteger(w.maxRounds) || w.maxRounds < 1 || w.maxRounds > 10
      || !text(w.assignment) || typeof w.criteria !== 'string'
      || (w.mode === 'agent' && !text(w.agentType))
      || (w.reviewerSessionId !== undefined && !text(w.reviewerSessionId))
      || (w.terminal !== undefined && !['passed', 'failed'].includes(w.terminal))
      || (w.delivered !== undefined && typeof w.delivered !== 'boolean')
      || (w.submission && (!integer(w.submission.revision) || !text(w.submission.artifactRef) || typeof w.submission.content !== 'string'))
      || (w.decision && (!integer(w.decision.revision) || !['pass', 'changes_requested', 'blocked'].includes(w.decision.outcome) || typeof w.decision.content !== 'string'))) throw new TaskRecordError('Invalid review workflow')
  }
  return structuredClone(t)
}
