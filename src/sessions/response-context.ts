import type { ExecutionMode } from './execution-mode.ts'
import type { InputSource } from './input.ts'
import type { ChatMessage } from '../providers/provider.ts'
import { isRuntimeContextEvent } from './runtime-context-contract.ts'

/** Display provenance for conversational responses, never routing or authority. */
export interface ResponseContext {
  version: 1
  turnId: string
  responseId: string
  source:
    | { kind: 'user' }
    | { kind: 'session'; sessionId: string }
    | { kind: 'event'; eventId: string; type: string; source: string; status?: 'failed' | 'cancelled' }
  /** Admitted user participation/continuity, not the recipient or a visibility flag. */
  userInvolved: boolean
}

export function createResponseContext(
  turnId: string, source: InputSource, mode: ExecutionMode | undefined, channel: string,
): ResponseContext | undefined {
  if (mode !== 'session' || channel === 'a2a'
    || source.kind === 'user' && source.sender.channel === 'a2a') return undefined
  const status = source.kind === 'event'
    ? source.type === 'subagent-failed' ? 'failed'
      : source.type === 'subagent-cancelled' ? 'cancelled' : source.attributes?.status
    : undefined
  const origin: ResponseContext['source'] = source.kind === 'user' ? { kind: 'user' }
    : source.kind === 'session' ? { kind: 'session', sessionId: source.sessionId }
    : {
      kind: 'event', eventId: source.eventId, type: source.type, source: source.source,
      ...(status === 'failed' || status === 'cancelled' ? { status } : {}),
    }
  return { version: 1, turnId, responseId: `${turnId}:0`, source: origin, userInvolved: source.kind === 'user' }
}

/** Display participation only: an event-triggered response still addresses the conversation reader.
 * Never use this predicate to classify the recipient or fold assistant output. */
export function hasNoAdmittedUserInput(context: ResponseContext | undefined): boolean {
  return !!context && !context.userInvolved && context.source.kind !== 'user'
}

/** Restore user participation across interrupted tool loops without rewriting stored records. */
export function reconcileResponseContinuity(messages: ChatMessage[]): {
  messages: ChatMessage[]
  unfinishedUserResponse: boolean
} {
  let unfinishedUserResponse = false
  const normalized = messages.map(message => {
    if (message.role !== 'assistant') return message
    const context = message.responseContext
    const responseContext = context && unfinishedUserResponse && !context.userInvolved
      ? { ...context, userInvolved: true }
      : context
    unfinishedUserResponse = !!responseContext?.userInvolved && !!message.tool_calls?.length
    return responseContext === context ? message : { ...message, responseContext }
  })
  return { messages: normalized, unfinishedUserResponse }
}

/** Recover user participation in an unfinished turn from its persisted input or response. */
export function continuedUserInvolvement(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'assistant' && message.responseContext) return message.responseContext.userInvolved
    if (message.role !== 'user') continue
    if (message.name === '__work_realignment__' || isRuntimeContextEvent(message)) continue
    const tag = Array.isArray(message.content) ? message.content[0] : undefined
    return tag?.type === 'text' && /^<sender id="[^"]*" name="[^"]*" chat="(?:direct|group)"(?: platform-[a-z-]+="[^"]*")*\s*\/>$/.test(tag.text)
  }
  return false
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Unknown/invalid display metadata cannot make otherwise readable history disappear. */
export function parseResponseContext(value: unknown): ResponseContext | undefined {
  if (value === undefined) return undefined
  if (record(value) && value.version === 1 && identifier(value.turnId) && identifier(value.responseId)
    && typeof value.userInvolved === 'boolean' && record(value.source)) {
    const raw = value.source
    let source: ResponseContext['source'] | undefined
    if (raw.kind === 'user' && value.userInvolved) source = { kind: 'user' }
    else if (raw.kind === 'session' && identifier(raw.sessionId)) source = { kind: 'session', sessionId: raw.sessionId }
    else if (raw.kind === 'event' && identifier(raw.eventId) && identifier(raw.type) && identifier(raw.source)
      && (raw.status === undefined || raw.status === 'failed' || raw.status === 'cancelled')) {
      source = { kind: 'event', eventId: raw.eventId, type: raw.type, source: raw.source,
        ...(raw.status ? { status: raw.status } : {}) }
    }
    if (source) return { version: 1, turnId: value.turnId, responseId: value.responseId, userInvolved: value.userInvolved, source }
  }
  console.warn('Invalid or unsupported response context; displaying the response normally.')
  return undefined
}
