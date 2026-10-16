import { createHash } from 'node:crypto'
import type { SessionState } from './session-store.ts'

/** Ordinary conversations are topics by identity, never inferred from similar titles. */
export function isLightweightTopic(state: SessionState): boolean {
  return (state.mode ?? 'session') === 'session' && !state.automation &&
    state.sessionKind !== 'orchestrator' && state.sessionId !== 'web:orchestrator' &&
    !['work-organizer', 'work-observer', 'reflector', 'soul-reflector', 'encapsulator'].includes(state.agentType ?? '')
}
export const sessionTopicKey = (id: string) => `session:${id}`
/** Stable positive safe integer: metadata edits and completion invalidate delta organization too. */
export function sessionTopicSequence(state: SessionState): number {
  return Number.parseInt(createHash('sha256').update(JSON.stringify([
    state.sessionId, state.name, state.description, state.topic, state.generatedTitle,
    state.completed, state.lastActivityAt, state.segmentIndex,
  ])).digest('hex').slice(0, 12), 16) + 1
}
export function sessionTopicDescription(state: SessionState): string {
  return state.description || (state.topic ? [state.topic.goal, state.topic.scope, state.topic.nonGoals].filter(Boolean).join('\n') : '')
}
export function sessionTopicTitle(state: SessionState): string {
  return state.name || state.topic?.title || state.generatedTitle || state.chatName || state.description || state.sessionId
}
