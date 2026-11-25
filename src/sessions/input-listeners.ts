import { deriveSessionId } from '../bus/events.ts'
import type { InputEnvelope, InputListener } from '../input/router.ts'
import { matchesInput } from '../input/router.ts'
import type { BotInstanceStore } from '../channels/bot-store.ts'
import { assertChannelMessage, channelMessageEnvelope, type ChannelInputPayload, type ChannelInputResult } from '../channels/input.ts'
import { ChannelAdmissionError } from '../channels/base.ts'
import type { ReceiveChannelMessage } from './input.ts'
import type { SessionManager } from './session-manager.ts'

export type InputSessions = Pick<SessionManager, 'listSessions' | 'listRetiredSessions' | 'getSessionState' | 'assertFolderAccess'>

/** A live projection of host identities, not a per-input registration. New Web
 * identities must be prepared by an authenticated host request BEFORE routing.
 * Retired human conversations retain their existing restore-on-input behavior. */
export function sessionInputListeners(projectId: string, sessions: InputSessions, bots: BotInstanceStore): InputListener[] {
  if (bots.projectId !== projectId) throw new Error('Input listener Project mismatch')
  return [...sessions.listSessions(), ...sessions.listRetiredSessions()]
    .filter(state => state.sessionId.startsWith('web:') && (!state.projectId || state.projectId === projectId))
    .map(state => ({ source: { type: 'web', id: 'web' }, kind: 'message', topic: state.sessionId.slice(4), target: { kind: 'session', id: state.sessionId } }))
}

/** Selected ordinary Session handler. Matching a listener does not replace live
 * receipt/folder/Session execution checks (AgentApp and SessionManager retain those). */
export async function handleSessionInput(id: string, input: InputEnvelope<ChannelInputPayload>, options: {
  sessions: InputSessions; bots: BotInstanceStore; receive: ReceiveChannelMessage
}): Promise<ChannelInputResult> {
  const { sessions, bots } = options
  if (input.projectId !== bots.projectId || input.payload.kind !== 'message') throw new ChannelAdmissionError('Session input mismatch', 403)
  const message = input.payload.message
  const bot = assertChannelMessage(bots, message)
  if (bot) throw new ChannelAdmissionError('External input requires a BOT handler', 403)
  const expected = channelMessageEnvelope(bots, message)
  if (deriveSessionId(message) !== id || !matchesInput({ ...expected, target: { kind: 'session', id } }, input) ||
    !sessionInputListeners(bots.projectId, sessions, bots).some(listener => listener.target.id === id && matchesInput(listener, input)))
    throw new ChannelAdmissionError('Session input listener no longer available', 403)
  sessions.assertFolderAccess(id)
  return options.receive({ ...message, senderId: 'web-user', senderName: 'web-user', admin: true })
}
