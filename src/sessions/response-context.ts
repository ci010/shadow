import type { ExecutionMode } from './execution-mode.ts'
import type { InputSource } from './input.ts'

/** Display provenance for conversational responses, never routing or authority. */
export interface ResponseContext {
  version: 1
  turnId: string
  responseId: string
  source:
    | { kind: 'user' }
    | { kind: 'session'; sessionId: string }
    | { kind: 'event'; eventId: string; type: string; source: string; status?: 'failed' | 'cancelled' }
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

export function isBackgroundResponse(context: ResponseContext | undefined): boolean {
  return !!context && !context.userInvolved && context.source.kind !== 'user'
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
