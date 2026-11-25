import { projectHistoryMessages, recentHistoryWindow } from '../shared/history-wire.ts'
import { physicalSessionId } from './session-identity.ts'
import type { SessionManager } from './session-manager.ts'

/** Shared conversation display read model; the caller owns transport authorization. */
export async function readConversationHistory(
  sessions: SessionManager, channel: string, chatId: string, query: URLSearchParams,
) {
  const sessionId = `${channel}:${chatId}`
  // A draft has no session until prepare/send. Never preview a missing,
  // deleted or other-Project ID as though it were a real conversation.
  const initialState = sessions.getSessionState(sessionId)
  if (!initialState) {
    return { error: 'session_not_found', status: 404 } as const
  }
  const initialPhysicalId = physicalSessionId(initialState)
  const recent = query.get('historyWindow') === 'recent'
  // Legacy readers retain the full context contract; the conversation tab
  // requests context separately only when opening Diagnosis.
  const { systemPrompt, tools } = recent ? { systemPrompt: '', tools: [] }
    : await sessions.getContext({ sessionId, channel })
  // Keep offsets stable within a physical segment even when its logical
  // history grows beyond the legacy endpoint's rolling message cap.
  const { messages: history } = await sessions.getHistory(
    sessionId, recent ? { maxMessages: Number.MAX_SAFE_INTEGER } : undefined,
  )
  const commandResults = await sessions.getCommandResults(sessionId)
  const decisionRecords = sessions.getSessionState(sessionId)
    ? await sessions.getYieldRecords(sessionId) : []
  const state = sessions.getSessionState(sessionId)
  if (!state) return { error: 'session_not_found', status: 404 } as const
  const { segmentIndex } = state
  // Do not label context read before an awaited rollover with the new segment.
  if (physicalSessionId(state) !== initialPhysicalId) return { error: 'session_segment_changed', status: 409 } as const
  const window = recent ? recentHistoryWindow(history || [], query, initialPhysicalId) : undefined
  const data = { chatId, systemPrompt, history: window?.messages ?? projectHistoryMessages(history || []), commandResults, decisionRecords, tools,
    ...(window ? { historyStart: window.start } : {}),
    segmentIndex, currentPhysicalId: physicalSessionId(state),
    previousPhysicalId: segmentIndex > 0 ? physicalSessionId(state, segmentIndex - 1) : null,
  }
  return { data, historyStart: window?.start }
}

/** Shared logical history projection; physical IDs stay on the cold HTTP route. */
export async function readLogicalConversationHistory(sessions: SessionManager, key: string, query: URLSearchParams,
  { offset, pageSize, shallow }: { offset?: number; pageSize?: number; shallow: boolean },
) {
  const beforeState = await sessions.readSessionState(key)
  const { messages, total } = await sessions.getHistory(
    key,
    { offset, pageSize, shallow },
  )
  // Include segment info so the UI can navigate to previous segments
  const state = await sessions.readSessionState(key)
  const segmentIndex = state?.segmentIndex ?? 0
  const currentPhysicalId = physicalSessionId(state ?? { sessionId: key, segmentIndex })
  let previousPhysicalId: string | null = null
  if (segmentIndex > 0) {
    previousPhysicalId = physicalSessionId(state ?? { sessionId: key, segmentIndex }, segmentIndex - 1)
  }
  const window = shallow && pageSize === undefined && query.get('historyWindow') === 'recent'
    ? recentHistoryWindow(messages, query, currentPhysicalId) : undefined
  const data = {
    key,
    total,
    offset,
    pageSize,
    ...(window ? { historyStart: window.start } : {}),
    messages: window?.messages ?? projectHistoryMessages(messages, query.get('display') === 'true'),
    commandResults: await sessions.getCommandResults(key),
    decisionRecords: await sessions.getYieldRecords(key),
    segmentIndex,
    currentPhysicalId,
    previousPhysicalId,
  }
  if (shallow && pageSize === undefined && (window || query.has('snapshot'))) {
    const afterState = await sessions.readSessionState(key)
    if (!beforeState || !afterState || physicalSessionId(beforeState) !== currentPhysicalId || physicalSessionId(afterState) !== currentPhysicalId) {
      return { error: 'history_conflict' } as const
    }
  }
  return { data }
}
