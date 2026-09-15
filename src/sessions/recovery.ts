import { newPhysicalSessionId } from '../utils/paths.ts'
import { parseSessionRecovery, type SessionState, type SessionStore, type StoredMessage } from './session-store.ts'

export class SessionResumeError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionResumeError' }
}

/** Repair missing results as unknown outcomes, without executing any tool or model. */
export async function prepareSessionRecovery(store: SessionStore, state: SessionState): Promise<void> {
  if (state.mode !== 'session') return
  const prior = parseSessionRecovery(state.recovery)
  const physicalId = newPhysicalSessionId(state.sessionId, state.segmentIndex)
  const pending = new Map<string, string>()
  let lastRole: string | undefined
  let finalResponse = false
  for await (const record of store.readSessionLog(physicalId)) {
    if (!['user', 'assistant', 'tool'].includes(String(record.role))) continue
    lastRole = String(record.role)
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : []
    finalResponse = lastRole === 'assistant' && calls.length === 0
    if (lastRole === 'assistant') {
      for (const call of calls) {
        if (call && typeof call === 'object' && typeof call.id === 'string'
          && call.function && typeof call.function.name === 'string') pending.set(call.id, call.function.name)
      }
    } else if (lastRole === 'tool' && typeof record.tool_call_id === 'string') pending.delete(record.tool_call_id)
  }
  if (!lastRole || finalResponse || state.executionStatus === 'completed') {
    if (prior || (finalResponse && state.executionStatus !== 'completed')) {
      delete state.recovery
      if (finalResponse) state.executionStatus = 'completed'
      await store.saveState(state.sessionId, state)
    }
    return
  }
  const missing: StoredMessage[] = Array.from(pending, ([id, name]) => ({
    role: 'tool', tool_call_id: id, name, timestamp: new Date().toISOString(),
    content: 'Execution was interrupted before its result was saved. Outcome unknown: side effects may already have occurred. Do not replay this operation blindly; inspect its actual state and ask before repeating irreversible actions.',
  }))
  if (missing.length) await store.appendMessages(physicalId, missing)
  if (!prior) {
    state.recovery = {
      id: crypto.randomUUID(),
      reason: state.executionStatus === 'cancelled' ? 'stopped' : state.executionStatus === 'failed' ? 'failed' : 'interrupted',
    }
    if (state.executionStatus !== 'failed') state.executionStatus = 'cancelled'
    await store.saveState(state.sessionId, state)
  }
}
