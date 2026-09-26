import { parseDecisionBrief, type DecisionBrief } from './decision-brief.ts'
import { z } from 'zod'
import { workDecisionSchema, type WorkDecision } from '../initiatives/work-contract.ts'
export const workStampsSchema = z.array(z.object({
  key: z.string().min(1).max(600), revision: z.number().int().positive(), adoptionId: z.string().uuid().optional(),
  assignmentRevision: z.number().int().positive().optional(),
}).strict()).max(100)

export const MAX_YIELD_TIMEOUT_MS = 2_147_483_647
export const MAX_YIELD_CUSTOM_TEXT_LENGTH = 4000

export interface YieldPolicy {
  timeoutMs: number | null
}

export interface YieldQuestion {
  workProposal?: WorkDecision
  question: string
  options: [string, string] | [string, string, string]
  defaultOption: string
  sources?: YieldReference[]
  brief?: DecisionBrief
  reconsiders?: YieldReference
}

export interface YieldReference {
  sessionId: string
  physicalId: string
  requestId: string
}

export interface YieldRequest extends YieldQuestion {
  workStamps?: import('../initiatives/work-contract.ts').WorkStamp[]
  id: string
  sessionId: string
  recipient: { kind: 'user' | 'parent'; sessionId: string }
  createdAt: string
  deadline: string | null
  origin?: { physicalId: string; toolCallId?: string }
  decisionId?: string
  supersedes?: YieldReference
  revisionReason?: string
  revisionSessionId?: string
  timeoutPaused?: true
  reportingSessionId?: string
}

export interface YieldAnswer {
  requestId: string
  option: string
  answeredBy: 'user' | 'parent' | 'timeout'
  answeredAt: string
  custom?: true
  reference?: YieldReference
  revisedQuestion?: YieldQuestion
  approved?: never
  disposition?: never
}

export interface YieldDecisionRecord {
  request: YieldRequest
  answer?: YieldAnswer
  closed?: { at: string; reason: 'cancelled' | 'failed' | 'superseded' | 'investigation' | 'deferred' | 'invalidated'; message: string; replacement?: YieldReference }
  invalidated?: DecisionInvalidation
}

export interface DecisionInvalidation {
  reference: YieldReference
  at: string
  reason: string
}

export interface YieldContinuation {
  requestId: string
  disposition: 'investigation' | 'deferred' | 'invalidated'
  approved: false
  reason: string
  reference?: YieldReference
  blocked: string[]
  unaffected: string[]
  option?: never
  answeredBy?: never
  custom?: never
  revisedQuestion?: never
}
export type YieldOutcome = YieldAnswer | YieldContinuation

export function parseYieldContinuation(value: unknown): YieldContinuation {
  if (!isRecord(value) || !nonEmptyId(value.requestId) || value.approved !== false
    || (value.disposition !== 'investigation' && value.disposition !== 'deferred' && value.disposition !== 'invalidated')
    || value.option !== undefined || value.answeredBy !== undefined || value.custom !== undefined) {
    throw new TypeError('Invalid non-approval decision outcome.')
  }
  const scope = (items: unknown, min: number): string[] => {
    if (!Array.isArray(items) || items.length < min || items.length > 6
      || !items.every(item => typeof item === 'string' && !!item.trim() && item.length <= 500)) {
      throw new TypeError('Invalid decision continuation scope.')
    }
    return items
  }
  const reference = value.reference === undefined ? undefined : parseYieldReference(value.reference)
  if (reference && reference.requestId !== value.requestId) throw new TypeError('Continuation origin does not match.')
  return { requestId: value.requestId, disposition: value.disposition, approved: false,
    reason: parseYieldCustomText(value.reason), blocked: scope(value.blocked, 1), unaffected: scope(value.unaffected, 0),
    ...(reference ? { reference } : {}) }
}

export interface YieldReview {
  id: string
  reference: YieldReference
  kind: 'clarify' | 'revise'
  question: string
  sessionId: string
  createdAt: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  response?: string
  replacement?: YieldReference
}

export function parseYieldReview(value: unknown): YieldReview {
  if (!isRecord(value) || !nonEmptyId(value.id) || !nonEmptyId(value.sessionId)
    || (value.kind !== 'clarify' && value.kind !== 'revise')
    || !['running', 'completed', 'failed', 'interrupted'].includes(String(value.status))
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || (value.response !== undefined && (typeof value.response !== 'string' || value.response.length > 16000))) {
    throw new TypeError('Invalid decision discussion record.')
  }
  const reference = parseYieldReference(value.reference)
  const replacement = value.replacement === undefined ? undefined : parseYieldReference(value.replacement)
  const terminal = value.status === 'completed' || value.status === 'failed'
  if (terminal !== (typeof value.response === 'string' && !!value.response.trim())
    || ((value.status === 'completed' && value.kind === 'revise') !== !!replacement)
    || (replacement && (replacement.sessionId !== reference.sessionId || replacement.physicalId !== reference.physicalId
      || replacement.requestId === reference.requestId))) throw new TypeError('Invalid decision discussion outcome.')
  return { id: value.id, reference, kind: value.kind,
    question: parseYieldCustomText(value.question), sessionId: value.sessionId, createdAt: value.createdAt,
    status: value.status as YieldReview['status'],
    ...(value.response !== undefined ? { response: value.response as string } : {}),
    ...(replacement ? { replacement } : {}) }
}

export function parseYieldReference(value: unknown): YieldReference {
  if (!isRecord(value) || Object.keys(value).some(key => !['sessionId', 'physicalId', 'requestId'].includes(key))
    || !nonEmptyId(value.sessionId) || !nonEmptyId(value.physicalId) || !nonEmptyId(value.requestId)) {
    throw new TypeError('A decision source requires sessionId, physicalId and requestId.')
  }
  return { sessionId: value.sessionId, physicalId: value.physicalId, requestId: value.requestId }
}

export function parseYieldCustomText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_YIELD_CUSTOM_TEXT_LENGTH) {
    throw new TypeError(`Enter a response of 1 to ${MAX_YIELD_CUSTOM_TEXT_LENGTH} characters.`)
  }
  return value.trim()
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
    || !Array.isArray(value.options) || (value.options.length !== 2 && value.options.length !== 3)
    || !Array.from(value.options).every((item): item is string => typeof item === 'string' && !!item.trim() && item.length <= 500)
    || new Set(value.options.map(item => item.trim())).size !== value.options.length
    || typeof value.defaultOption !== 'string' || !value.options.includes(value.defaultOption)) {
    throw new TypeError('Yield requires a question, two or three distinct non-empty options, and a defaultOption matching one option.')
  }
  let sources: YieldReference[] | undefined
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 3) {
      throw new TypeError('A decision can cite one to three existing decision records.')
    }
    sources = Array.from(value.sources, parseYieldReference)
    if (new Set(sources.map(source => JSON.stringify(source))).size !== sources.length) throw new TypeError('Duplicate decision sources.')
  }
  return { question: value.question, options: value.options.length === 2
    ? [value.options[0], value.options[1]] : [value.options[0], value.options[1], value.options[2]], defaultOption: value.defaultOption,
    ...(sources ? { sources } : {}),
    ...(value.workProposal === undefined ? {} : { workProposal: workDecisionSchema.parse(value.workProposal) }),
    ...(value.brief !== undefined ? { brief: parseDecisionBrief(value.brief) } : {}),
    ...(value.reconsiders !== undefined ? { reconsiders: parseYieldReference(value.reconsiders) } : {}) }
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
  let origin: YieldRequest['origin']
  if (value.origin !== undefined) {
    if (!isRecord(value.origin) || !nonEmptyId(value.origin.physicalId)
      || (value.origin.toolCallId !== undefined && !nonEmptyId(value.origin.toolCallId))) {
      throw new TypeError('Invalid decision origin.')
    }
    origin = { physicalId: value.origin.physicalId,
      ...(value.origin.toolCallId !== undefined ? { toolCallId: value.origin.toolCallId } : {}) }
  }
  if ((value.decisionId !== undefined && !nonEmptyId(value.decisionId))
    || (value.reportingSessionId !== undefined && !nonEmptyId(value.reportingSessionId))
    || (value.timeoutPaused !== undefined && value.timeoutPaused !== true)
    || (value.revisionSessionId !== undefined && !nonEmptyId(value.revisionSessionId))) throw new TypeError('Invalid decision revision metadata.')
  const supersedes = value.supersedes === undefined ? undefined : parseYieldReference(value.supersedes)
  if (supersedes && (supersedes.sessionId !== sessionId || supersedes.requestId === value.id || supersedes.physicalId !== origin?.physicalId
    || !value.decisionId || !nonEmptyId(value.revisionSessionId))) throw new TypeError('Invalid decision revision origin.')
  return {
    ...parseYieldQuestion(value), id: value.id, sessionId,
    ...(value.workStamps === undefined ? {} : { workStamps: workStampsSchema.parse(value.workStamps) }),
    recipient: { kind: value.recipient.kind, sessionId: value.recipient.sessionId },
    createdAt: value.createdAt, deadline: value.deadline,
    ...(origin ? { origin } : {}),
    ...(value.reportingSessionId !== undefined ? { reportingSessionId: value.reportingSessionId as string } : {}),
    ...(value.decisionId !== undefined ? { decisionId: value.decisionId } : {}),
    ...(supersedes ? { supersedes, revisionReason: parseYieldCustomText(value.revisionReason), revisionSessionId: value.revisionSessionId as string } : {}),
    ...(value.timeoutPaused === true ? { timeoutPaused: true } : {}),
  }
}

export function parseYieldAnswer(value: unknown, request?: YieldRequest): YieldAnswer {
  if (!isRecord(value) || !nonEmptyId(value.requestId)
    || value.approved !== undefined || value.disposition !== undefined
    || typeof value.option !== 'string' || !value.option.trim() || value.option.length > MAX_YIELD_CUSTOM_TEXT_LENGTH
    || (value.answeredBy !== 'user' && value.answeredBy !== 'parent' && value.answeredBy !== 'timeout')
    || typeof value.answeredAt !== 'string' || !Number.isFinite(Date.parse(value.answeredAt))
    || (value.custom !== undefined && (value.custom !== true || value.answeredBy !== 'user'))) {
    throw new TypeError('Invalid decision answer.')
  }
  if (request && (value.requestId !== request.id
    || (!value.custom && !request.options.includes(value.option))
    || (value.answeredBy === 'timeout' ? value.option !== request.defaultOption : value.answeredBy !== request.recipient.kind))) {
    throw new TypeError('Answer does not match the decision request.')
  }
  const reference = value.reference === undefined ? undefined : parseYieldReference(value.reference)
  const revisedQuestion = value.revisedQuestion === undefined ? undefined : parseYieldQuestion(value.revisedQuestion)
  if (request && revisedQuestion && JSON.stringify(revisedQuestion) !== JSON.stringify(parseYieldQuestion(request))) {
    throw new TypeError('Revised question does not match the answered request.')
  }
  if (reference && (reference.requestId !== value.requestId || (request &&
    (reference.sessionId !== request.sessionId || reference.physicalId !== request.origin?.physicalId)))) {
    throw new TypeError('Answer reference does not match the decision origin.')
  }
  return { requestId: value.requestId, option: value.option, answeredBy: value.answeredBy,
    answeredAt: value.answeredAt, ...(value.custom ? { custom: true } : {}), ...(reference ? { reference } : {}),
    ...(revisedQuestion ? { revisedQuestion } : {}) }
}

export function parseYieldDecisionRecord(value: unknown): YieldDecisionRecord {
  if (!isRecord(value) || !isRecord(value.request) || typeof value.request.sessionId !== 'string'
    || (value.answer !== undefined && value.closed !== undefined)) throw new TypeError('Invalid decision record.')
  const request = parseYieldRequest(value.request, value.request.sessionId)
  if (!request.origin) throw new TypeError('Decision record has no origin.')
  const answer = value.answer === undefined ? undefined : parseYieldAnswer(value.answer, request)
  let closed: YieldDecisionRecord['closed']
  if (value.closed !== undefined) {
    const entry = value.closed
    if (!isRecord(entry) || !['cancelled', 'failed', 'superseded', 'investigation', 'deferred', 'invalidated'].includes(String(entry.reason))
      || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))
      || typeof entry.message !== 'string') throw new TypeError('Invalid closed decision record.')
    const replacement = entry.replacement === undefined ? undefined : parseYieldReference(entry.replacement)
    if ((entry.reason === 'superseded') !== !!replacement
      || (replacement && (replacement.sessionId !== request.sessionId || replacement.requestId === request.id
        || replacement.physicalId !== request.origin.physicalId))) {
      throw new TypeError('Invalid replacement decision.')
    }
    closed = { at: entry.at, reason: entry.reason as NonNullable<YieldDecisionRecord['closed']>['reason'], message: entry.message, ...(replacement ? { replacement } : {}) }
  }
  return { request, ...(answer ? { answer } : {}), ...(closed ? { closed } : {}),
    ...(value.invalidated !== undefined ? { invalidated: parseDecisionInvalidation(value.invalidated) } : {}) }
}

export function parseDecisionInvalidation(value: unknown): DecisionInvalidation {
  if (!isRecord(value) || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) throw new TypeError('Invalid decision invalidation.')
  return { reference: parseYieldReference(value.reference), at: value.at, reason: parseYieldCustomText(value.reason) }
}
function nonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 512
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
