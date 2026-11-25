import { readConversationHistory, readLogicalConversationHistory } from './conversation-history.ts'
import { Session } from './session.ts'
import { physicalSessionId } from './session-identity.ts'
import type { SessionManager } from './session-manager.ts'

/** Read the display snapshot after the transport has authorized the chat topic.
 * The transport must fence the read against its event journal before publishing.
 */
export async function readConversationSnapshot(sessions: SessionManager, sessionId: string) {
  const initial = await sessions.readSessionState(sessionId)
  if (!initial) return { error: 'session_not_found', status: 404 } as const
  await sessions.assertHistoricalFolderAccess(sessionId)
  const query = new URLSearchParams({ historyWindow: 'recent' })
  const chatId = sessionId.startsWith('web:') ? sessionId.slice(4) : sessionId
  let chat
  if (sessionId.startsWith('web:') && (initial.mode ?? 'session') === 'session' && sessions.getSessionState(sessionId)) {
    const result = await readConversationHistory(sessions, 'web', chatId, query)
    if (!result.data) return result
    const { history, commandResults, decisionRecords, segmentIndex, currentPhysicalId, previousPhysicalId, historyStart } = result.data
    chat = { chatId, history, commandResults, decisionRecords, segmentIndex, currentPhysicalId, previousPhysicalId, historyStart }
  } else {
    const result = await readLogicalConversationHistory(sessions, sessionId, query, { shallow: true })
    if (!result.data) return { error: 'session_segment_changed', status: 409 } as const
    const { messages: history, commandResults, decisionRecords, segmentIndex, currentPhysicalId, previousPhysicalId, historyStart } = result.data
    chat = { chatId, history, commandResults, decisionRecords, segmentIndex, currentPhysicalId, previousPhysicalId, historyStart }
  }
  const details = await sessions.getSessionDetails(sessionId)
  const state = await sessions.readSessionState(sessionId)
  if (!details || !state) return { error: 'session_not_found', status: 404 } as const
  if (physicalSessionId(initial) !== chat.currentPhysicalId || physicalSessionId(state) !== chat.currentPhysicalId) {
    return { error: 'session_segment_changed', status: 409 } as const
  }
  const active = sessions.getActiveSession(sessionId)
  return { data: { chat, details, inputDelivery: sessionId.startsWith('web:') && active instanceof Session ? active.webInputDelivery : [] } }
}
