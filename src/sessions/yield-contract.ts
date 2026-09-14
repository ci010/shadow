export const MAX_YIELD_TIMEOUT_MS = 2_147_483_647

export interface YieldPolicy {
  timeoutMs: number | null
}

export interface YieldQuestion {
  question: string
  options: [string, string, string]
  defaultOption: string
}

export interface YieldRequest extends YieldQuestion {
  id: string
  sessionId: string
  recipient: { kind: 'user' | 'parent'; sessionId: string }
  createdAt: string
  deadline: string | null
}

export interface YieldAnswer {
  requestId: string
  option: string
  answeredBy: 'user' | 'parent' | 'timeout'
  answeredAt: string
}

export function parseYieldPolicy(value: unknown): YieldPolicy {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !('timeoutMs' in value)
    || (value.timeoutMs !== null && (typeof value.timeoutMs !== 'number'
      || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > MAX_YIELD_TIMEOUT_MS))) {
    throw new TypeError(`Yield timeoutMs must be null (wait indefinitely) or an integer from 1 to ${MAX_YIELD_TIMEOUT_MS}.`)
  }
  return { timeoutMs: value.timeoutMs }
}

export function parseYieldQuestion(value: unknown): YieldQuestion {
  if (!isRecord(value) || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 4000
    || !Array.isArray(value.options) || value.options.length !== 3
    || !Array.from(value.options).every((item): item is string => typeof item === 'string' && !!item.trim() && item.length <= 500)
    || new Set(value.options.map(item => item.trim())).size !== 3
    || typeof value.defaultOption !== 'string' || !value.options.includes(value.defaultOption)) {
    throw new TypeError('Yield requires a question, exactly three distinct non-empty options, and a defaultOption matching one option.')
  }
  return { question: value.question, options: [value.options[0], value.options[1], value.options[2]], defaultOption: value.defaultOption }
}

export function parseYieldRequest(value: unknown, sessionId: string): YieldRequest {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.sessionId !== sessionId
    || !isRecord(value.recipient) || (value.recipient.kind !== 'user' && value.recipient.kind !== 'parent')
    || typeof value.recipient.sessionId !== 'string' || !value.recipient.sessionId
    || (value.recipient.kind === 'user' && value.recipient.sessionId !== sessionId)
    || (value.recipient.kind === 'parent' && value.recipient.sessionId === sessionId)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || (value.deadline !== null && (typeof value.deadline !== 'string' || !Number.isFinite(Date.parse(value.deadline))))) {
    throw new TypeError('Invalid yield request received.')
  }
  return {
    ...parseYieldQuestion(value), id: value.id, sessionId,
    recipient: { kind: value.recipient.kind, sessionId: value.recipient.sessionId },
    createdAt: value.createdAt, deadline: value.deadline,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
