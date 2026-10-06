import { physicalSessionId } from './session-identity.ts'
import type { ChatMessage } from '../providers/provider.ts'
import { parseSessionRecovery, type SessionState, type SessionStore } from './session-store.ts'
import { continuedUserInvolvement, parseResponseContext } from './response-context.ts'

export class SessionResumeError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionResumeError' }
}

/** Only the unfinished trailing batch belongs to the interrupted execution. */
export function pendingToolCalls(messages: ChatMessage[]): NonNullable<ChatMessage['tool_calls']> {
  const results = new Set<string>()
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'tool') {
      if (message.tool_call_id) results.add(message.tool_call_id)
    } else {
      return message.role === 'assistant'
        ? (message.tool_calls ?? []).filter(call => !results.has(call.id))
        : []
    }
  }
  return []
}

/** Mark interrupted work without changing its transcript or executing anything. */
export async function prepareSessionRecovery(store: SessionStore, state: SessionState): Promise<void> {
  if (state.mode !== 'session') return
  const prior = parseSessionRecovery(state.recovery)
  const physicalId = physicalSessionId(state)
  let lastRole: string | undefined
  let finalResponse = false
  let userInvolved = false
  const pending = new Set<string>()
  for await (const record of store.readSessionLog(physicalId)) {
    if (!['user', 'assistant', 'tool'].includes(String(record.role))) continue
    lastRole = String(record.role)
    if (lastRole === 'user') {
      if (record.name !== '__work_realignment__') {
        userInvolved = continuedUserInvolvement([{
          role: 'user', content: record.content as ChatMessage['content'],
        }])
      }
    } else if (lastRole === 'assistant' && record.responseContext !== undefined) {
      userInvolved = parseResponseContext(record.responseContext)?.userInvolved ?? false
    }
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : []
    if (lastRole === 'assistant' || lastRole === 'user') pending.clear()
    if (lastRole === 'assistant') {
      for (const call of calls) if (call && typeof call === 'object' && 'id' in call && typeof call.id === 'string') pending.add(call.id)
    } else if (lastRole === 'tool' && typeof record.tool_call_id === 'string') pending.delete(record.tool_call_id)
    finalResponse = lastRole === 'assistant' && calls.length === 0
  }
  if (!lastRole || finalResponse || state.executionStatus === 'completed') {
    if (prior || (finalResponse && state.executionStatus !== 'completed')) {
      delete state.recovery
      if (finalResponse) state.executionStatus = 'completed'
      await store.saveState(state.sessionId, state)
    }
    return
  }
  if (!prior) {
    state.recovery = {
      id: crypto.randomUUID(),
      reason: state.executionStatus === 'cancelled' ? 'stopped' : state.executionStatus === 'failed' ? 'failed' : 'interrupted',
      userInvolved,
      pendingToolCalls: pending.size,
    }
    if (state.executionStatus !== 'failed') state.executionStatus = 'cancelled'
    await store.saveState(state.sessionId, state)
  } else if (prior.pendingToolCalls !== pending.size) {
    state.recovery = { ...prior, pendingToolCalls: pending.size }
    await store.saveState(state.sessionId, state)
  }
}
