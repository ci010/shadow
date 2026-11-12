import { WORK_DISPATCH_ID } from '../cron/work-dispatch-contract.ts'
import type { SessionState } from './session-store.ts'

/** Read compatibility for workers incorrectly stamped as dispatcher runs.
 * Require the host-authored Work identity, not a title or a general agent role.
 * This changes classification only: ownership, locality, Work and recovery survive.
 * Stores apply it on read so existing data needs no out-of-band rewrite.
 */
export function normalizeWorkExecutorMetadata<T extends SessionState>(state: T): T {
  if (state.mode === 'session' && state.sessionId.startsWith('work-executor:')
    && state.automaticWork?.jobId === WORK_DISPATCH_ID
    && state.automation?.jobId === WORK_DISPATCH_ID
    && state.automation.runId === state.sessionId) {
    delete state.automation
    state.automationVersion = 1
  }
  return state
}
