import { runBoundedSession, type BoundedSessionOptions, type BoundedSessionResult } from './bounded-session.ts'

export interface AuthoringEvaluationResult extends BoundedSessionResult {
  syntheticTools: true
}

export interface AuthoringEvaluationOptions extends Omit<BoundedSessionOptions, 'state' | 'onSession'> {
  /** Must be a fresh, fixture-only registry; never pass runtime session tools. */
  tools: BoundedSessionOptions['tools']
}

export async function evaluateAuthoringScenario(options: AuthoringEvaluationOptions): Promise<AuthoringEvaluationResult> {
  return { ...await runBoundedSession(options), syntheticTools: true }
}
