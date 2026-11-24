import { parseSessionFollowUpState } from './session-store.ts'
import type { SessionFollowUp, SessionState } from './session-store.ts'

/** Canonical topic with read-only fallbacks for ordinary historical titles. */
export function sessionTopic(state: Pick<SessionState, 'name' | 'topic' | 'generatedTitle' | 'chatName'>): string {
  return state.topic ?? state.name ?? state.generatedTitle ?? state.chatName ?? ''
}

export function parseSessionFocus(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4000) throw new TypeError('Focus must be text of at most 4000 characters')
  return value.trim()
}

export function parseSessionFollowUp(value: unknown): SessionFollowUp | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'next' && key !== 'after')) {
    throw new TypeError('Follow-up must be null or an object with next and after')
  }
  const { next, after } = value as Record<string, unknown>
  const text = typeof next === 'string' ? next.trim() : ''
  if (!text || text.length > 2000) throw new TypeError('Follow-up next must be nonempty text of at most 2000 characters')
  if (typeof after !== 'number' || !Number.isInteger(after) || after < 5 || after > 86400) {
    throw new TypeError('Follow-up after must be an integer from 5 to 86400 seconds')
  }
  return { next: text, after }
}

/** Normalize the follow-up fields shared by both durable stores. */
export function parseStoredSessionFollowUp(state: { followUp?: unknown; sessionFollowUp?: unknown }): Pick<SessionState, 'followUp' | 'sessionFollowUp'> {
  return {
    ...(state.followUp === undefined ? {} : { followUp: parseSessionFollowUp(state.followUp) }),
    ...(state.sessionFollowUp === undefined ? {} : { sessionFollowUp: parseSessionFollowUpState(state.sessionFollowUp) }),
  }
}

/** Empty focus is intentional: display consumers fall back to the topic. */
export function selfSessionMetadata(state: SessionState) {
  return {
    topic: sessionTopic(state),
    focus: state.focus ?? '',
    completed: state.completed ?? false,
    ...(state.followUp === undefined ? {} : { followUp: state.followUp }),
  }
}
