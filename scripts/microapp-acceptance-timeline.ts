import type { ChatMessage } from '../src/providers/provider.ts'
import { withExecutionBudget } from '../src/agent/context/execution-budget.ts'

export const ACCEPTANCE_PHASE_MS = {
  creation: 30 * 60_000,
  review: 5 * 60_000,
  testing: 10 * 60_000,
} as const
type AcceptancePhase = keyof typeof ACCEPTANCE_PHASE_MS

export class AcceptanceTimeline {
  readonly creationDeadline: number
  readonly hardDeadline: number
  private phase: AcceptancePhase = 'creation'
  private startedAt: number
  private deadline: number
  private controller = new AbortController()
  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now()
    this.creationDeadline = this.deadline = this.startedAt + ACCEPTANCE_PHASE_MS.creation
    this.hardDeadline = this.creationDeadline + ACCEPTANCE_PHASE_MS.review + ACCEPTANCE_PHASE_MS.testing
  }
  snapshot() {
    return {
      phase: this.phase, phaseStartedAt: new Date(this.startedAt).toISOString(),
      deadlineAt: new Date(this.deadline).toISOString(),
      creationDeadlineAt: new Date(this.creationDeadline).toISOString(),
      hardDeadlineAt: new Date(this.hardDeadline).toISOString(),
      remainingMs: Math.max(0, this.deadline - this.now()),
      limitsMs: ACCEPTANCE_PHASE_MS,
    }
  }
  modelError() {
    if (this.now() >= this.deadline) return `live_test_${this.phase}_deadline_exhausted`
    if (this.phase === 'review') return 'live_test_review_in_progress'
    return undefined
  }
  review() {
    if (this.phase === 'testing') throw new Error('Testing has already started; review new revisions within its existing deadline')
    if (this.phase === 'creation') {
      // A slow poll/cancellation must not shift the fixed creation cutoff forward.
      this.change('review', Math.min(this.now(), this.creationDeadline))
    }
    if (this.now() >= this.deadline) throw new Error('Review deadline exhausted')
  }
  approved(approvedAt: string) {
    if (this.phase === 'testing') {
      if (this.now() >= this.deadline) throw new Error('Author testing deadline exhausted')
      return
    }
    const at = Date.parse(approvedAt)
    if (this.phase !== 'review' || !Number.isFinite(at) || at < this.startedAt || at >= this.deadline || at > this.now()) {
      throw new Error('Approval was not recorded within the active review window')
    }
    this.change('testing', at)
    if (this.now() >= this.deadline) throw new Error('Author testing deadline exhausted')
  }
  private change(phase: AcceptancePhase, startedAt: number) {
    this.controller.abort(new Error('Acceptance phase changed; previous model request cancelled'))
    this.controller = new AbortController()
    this.phase = phase
    this.startedAt = startedAt
    this.deadline = Math.min(startedAt + ACCEPTANCE_PHASE_MS[phase], this.hardDeadline)
  }
  async model<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const error = this.modelError()
    if (error) throw new Error(error)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error(`Acceptance ${this.phase} deadline reached`)), this.deadline - this.now())
    const combined = AbortSignal.any([this.controller.signal, timeout.signal, ...(signal ? [signal] : [])])
    try { combined.throwIfAborted(); return await run(combined) }
    finally { clearTimeout(timer) }
  }
  prompt(messages: ChatMessage[], remaining: number) {
    const { remainingMs } = this.snapshot()
    const result = withExecutionBudget(messages, remaining, 'evaluation', remainingMs)
    const guidance = this.phase === 'creation'
      ? 'The deadline above ends CREATION (including feedback and clarification), not the protected review/testing windows. Publish a reviewable exact revision before it; stop optional implementation early enough to publish and explain unverified checks. After creation, the operator has up to 5 separate minutes for source review. No model requests run during review. Only exact-version owner approval starts up to 10 separate minutes for author testing, including the existing 60-second testing question. All phases share the same request cap; keep calls for testing. Time reservation never grants approval or guarantees a pass.'
      : 'The deadline above ends AUTHOR TESTING, including confirmation waiting, dependency preparation and reporting. Exercise the approved version and save honest version-bound results before it. Prioritize startup, persistence, recovery and reopen over new features or polish. Revisions, repeat approvals, follow-ups and runtime restarts do not reset this deadline or the shared request cap. A new revision still needs its own owner review; record blocked/not_tested rather than bypassing it.'
    const first = result[0]
    return [{ ...first, content: `${first.content}\n${guidance}` }, ...result.slice(1)]
  }
}

export function acceptanceTaskTerminal(task: { status: { state: string } }) {
  return ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(task.status.state)
}

export async function stopAcceptanceCreation<T extends { id: string; status: { state: string } }>(
  task: T, cancel: () => Promise<T>, refresh: () => Promise<T>,
): Promise<T> {
  if (acceptanceTaskTerminal(task)) return task
  try {
    const stopped = await cancel()
    if (!acceptanceTaskTerminal(stopped)) throw new Error('Creation cancellation has not reached a terminal task')
    return stopped
  } catch (error) {
    const current = await refresh()
    if (!acceptanceTaskTerminal(current)) throw error
    console.warn('[microapp-acceptance] Creation cancellation failed, but a fresh task read confirms a terminal outcome.')
    return current
  }
}
