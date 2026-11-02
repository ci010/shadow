import { sessionTopic } from './session-metadata.ts'
import { createHash } from 'node:crypto'
import type { SessionState } from './session-store.ts'

/** Ordinary conversations are topics by identity, never inferred from similar titles. */
export function isLightweightTopic(state: SessionState): boolean {
  return (state.mode ?? 'session') === 'session' && !state.automation &&
    !['work-organizer', 'work-observer', 'reflector', 'soul-reflector', 'encapsulator'].includes(state.agentType ?? '')
}
export const sessionTopicKey = (id: string) => `session:${id}`
/** Stable positive safe integer: metadata edits and completion invalidate delta organization too. */
export function sessionTopicSequence(state: SessionState): number {
  return Number.parseInt(createHash('sha256').update(JSON.stringify([
    state.sessionId, state.name, state.focus, state.topic, state.generatedTitle,
    state.completed, state.lastActivityAt, state.segmentIndex,
  ])).digest('hex').slice(0, 12), 16) + 1
}
export function sessionTopicFocus(state: SessionState): string {
  return state.focus || sessionTopic(state)
}
export function sessionTopicTitle(state: SessionState): string {
  return sessionTopic(state) || state.sessionId
}
