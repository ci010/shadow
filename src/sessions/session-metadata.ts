import type { SessionState } from './session-store.ts'

/** Canonical topic with read-only fallbacks for ordinary historical titles. */
export function sessionTopic(state: Pick<SessionState, 'name' | 'topic' | 'generatedTitle' | 'chatName'>): string {
  return state.topic ?? state.name ?? state.generatedTitle ?? state.chatName ?? ''
}

export function parseSessionFocus(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4000) throw new TypeError('Focus must be text of at most 4000 characters')
  return value.trim()
}

/** Empty focus is intentional: display consumers fall back to the topic. */
export function selfSessionMetadata(state: SessionState) {
  return { topic: sessionTopic(state), focus: state.focus ?? '', completed: state.completed ?? false }
}
