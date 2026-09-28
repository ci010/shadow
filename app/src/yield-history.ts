import { parseYieldQuestion, parseYieldAnswer, parseYieldContinuation, parseYieldDecisionRecord, type YieldAnswer, type YieldRequest, type YieldDecisionRecord, type YieldReference, type YieldContinuation } from '../../src/sessions/yield-contract.ts'
import { pairToolResults, resolveToolCall, type ToolActivityMessage } from './tool-activity.ts'

export interface YieldDecision {
  action: 'ask' | 'answer'
  question: string
  options: readonly string[]
  defaultOption?: string
  requestId?: string
  status: 'waiting-user' | 'waiting-parent' | 'user' | 'parent' | 'timeout' | 'failed' | 'unknown' | 'cancelled' | 'superseded' | 'investigation' | 'deferred' | 'invalidated'
  answer?: YieldAnswer
  timestamp?: string
  arguments?: string
  result?: string
  sources?: YieldReference[]
  origin?: YieldRequest['origin']
  reference?: YieldReference
  brief?: YieldRequest['brief']
  reportingSessionId?: string
  invalidated?: YieldDecisionRecord['invalidated']
}

export interface InlineYieldDecisions {
  entries: Map<number, YieldDecision>
  excluded: Set<number>
  after: Map<number, [number, YieldDecision][]>
  unlinked: [number, YieldDecision][]
}

export function decisionStatusLabel(status: YieldDecision['status']): string {
  return {
    'waiting-user': 'Needs your reply',
    'waiting-parent': 'Waiting for parent',
    user: 'Answered by user',
    parent: 'Answered by parent',
    timeout: 'Default selected by timeout',
    failed: 'Decision did not complete',
    unknown: 'No confirmed answer',
    cancelled: 'Decision cancelled',
    superseded: 'Replaced by a revised question',
    investigation: 'Returned for investigation · not approved',
    deferred: 'Deferred · not approved',
    invalidated: 'Premise changed · revalidation required',
  }[status]
}

function readAnswer(text: string | undefined): YieldAnswer | undefined {
  if (!text) return
  try { return parseYieldAnswer(JSON.parse(text)) }
  catch (error) { if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error }
}

function readContinuation(text: string | undefined): YieldContinuation | undefined {
  if (!text) return
  try { return parseYieldContinuation(JSON.parse(text)) }
  catch (error) { if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error }
}

export function parseDecisionRecords(value: unknown): YieldDecisionRecord[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid decision history received.')
  return value.map(parseYieldDecisionRecord)
}

export function recordedDecision(record: YieldDecisionRecord): YieldDecision {
  const { request, answer, closed } = record
  return { action: 'ask', question: request.question, options: request.options, defaultOption: request.defaultOption,
    requestId: request.id, timestamp: request.createdAt, sources: request.sources, origin: request.origin,
    brief: request.brief, reportingSessionId: request.reportingSessionId, invalidated: record.invalidated,
    reference: request.origin ? { sessionId: request.sessionId, physicalId: request.origin.physicalId, requestId: request.id } : undefined,
    answer, status: record.invalidated ? 'invalidated' : answer?.answeredBy ?? closed?.reason ?? 'unknown', result: closed?.message }
}

/** Missing historical receipts never imply a live waiter; only the yield endpoint does. */
export function inlineYieldDecisions(
  messages: readonly (ToolActivityMessage & { timestamp?: string })[],
  pending?: YieldRequest | null,
  records: readonly YieldDecisionRecord[] = [],
): InlineYieldDecisions {
  const entries = new Map<number, YieldDecision>()
  const excluded = new Set<number>()
  const pairs = pairToolResults(messages)
  const askIndices = messages.flatMap((message, index) => {
    if (message.event !== 'tool_call') return []
    const call = resolveToolCall(message)
    return call.name === 'ask' && (call.args.action === undefined || call.args.action === 'ask') ? [index] : []
  })
  const originIndex = (requestId?: string, origin?: YieldRequest['origin']): number | undefined => {
    const candidates = askIndices.filter(index => !origin?.toolCallId || messages[index].toolCallId === origin.toolCallId)
    const receiptMatch = candidates.find(index => {
      const text = messages[pairs.get(index) ?? -1]?.content
      return !!requestId && (readAnswer(text)?.requestId === requestId || readContinuation(text)?.requestId === requestId)
    })
    return receiptMatch ?? (origin?.toolCallId && candidates.length === 1 ? candidates[0] : undefined)
  }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.event !== 'tool_call') continue
    const call = resolveToolCall(message)
    if (call.name !== 'ask' && call.name !== 'reply') continue
    const action = call.name === 'reply' ? 'answer' : call.args.action === undefined ? 'ask' : call.args.action
    let decision: YieldDecision
    if (action === 'ask') {
      const saved = records.findLast(record => originIndex(record.request.id, record.request.origin) === index)
      const live = pending && originIndex(pending.id, pending.origin) === index ? pending : undefined
      if (saved) {
        // Proposal asks omit question/options; the persisted request is the display contract.
        decision = recordedDecision(saved)
      } else if (live) {
        decision = recordedDecision({ request: live })
      } else {
        try {
          const question = parseYieldQuestion({
            question: call.args.question, options: call.args.options, defaultOption: call.args.default_option, brief: call.args.brief,
          })
          decision = { ...question, action, status: 'unknown' }
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          // Invalid/legacy payloads stay visible in the ordinary tool inspector.
          continue
        }
      }
    } else if (call.name === 'reply' && typeof call.args.request_id === 'string'
      && typeof call.args.text === 'string' && readAnswer(messages[pairs.get(index) ?? -1]?.content)) {
      decision = { action: 'answer', question: 'Response to child decision', options: [],
        requestId: call.args.request_id, status: 'unknown' }
    } else continue
    const resultIndex = pairs.get(index)
    const result = resultIndex === undefined ? undefined : messages[resultIndex]
    let answer = readAnswer(result?.content)
    const continuation = action === 'ask' ? readContinuation(result?.content) : undefined
    if (action === 'ask' && answer?.revisedQuestion) {
      decision = { ...decision, ...answer.revisedQuestion }
    }
    if (answer && (action === 'answer'
      ? answer.requestId !== call.args.request_id || answer.option !== call.args.text || answer.answeredBy !== 'parent'
      : (!answer.custom && !decision.options.includes(answer.option))
        || (answer.answeredBy === 'timeout' && answer.option !== decision.defaultOption))) answer = undefined
    entries.set(index, {
      ...decision, answer, requestId: answer?.requestId ?? continuation?.requestId ?? decision.requestId,
      timestamp: message.timestamp, arguments: call.raw, result: result?.content,
      ...(action === 'answer' && answer?.reference ? { sources: [answer.reference] } : {}),
      reference: answer?.reference ?? continuation?.reference,
      status: answer?.answeredBy ?? continuation?.disposition ?? (/^(?:Error:|ERROR\b|Failed\b)/i.test(result?.content.trimStart() ?? '') ? 'failed' : 'unknown'),
    })
    excluded.add(index)
    if (resultIndex !== undefined) excluded.add(resultIndex)
  }
  const attached = new Set<string>()
  for (const [index, entry] of entries) {
    if (entry.action !== 'ask') continue
    const record = records.findLast(record => entry.requestId
      ? record.request.id === entry.requestId
      : originIndex(record.request.id, record.request.origin) === index)
    if (!record || attached.has(record.request.id)) continue
    attached.add(record.request.id)
    const saved = recordedDecision(record)
    entries.set(index, { ...entry, ...saved,
      answer: saved.answer ?? entry.answer, status: saved.answer || record.closed || record.invalidated ? saved.status : entry.status,
      result: saved.result ?? entry.result })
  }
  for (const record of records) {
    if (!attached.has(record.request.id)) {
      entries.set(messages.length + [...entries.keys()].filter(index => index >= messages.length).length, recordedDecision(record))
    }
  }
  if (pending && !records.some(record => record.request.id === pending.id && (record.closed || record.invalidated))
    && ![...entries.values()].some(entry => entry.requestId === pending.id
      && (entry.answer || ['investigation', 'deferred', 'invalidated'].includes(entry.status)))) {
    const recorded = [...entries].find(([, entry]) => entry.action === 'ask' && entry.requestId === pending.id)
    const latest = [...entries].findLast(([, entry]) => entry.action === 'ask')
    const entry = recorded?.[1] ?? latest?.[1]
    const matches = entry && (!entry.requestId || entry.requestId === pending.id) && entry.result === undefined && entry.question === pending.question
      && entry.defaultOption === pending.defaultOption
      && entry.options.length === pending.options.length && entry.options.every((option, i) => option === pending.options[i])
    const index = recorded?.[0] ?? (matches && latest ? latest[0] : messages.length + [...entries.keys()].filter(index => index >= messages.length).length)
    entries.set(index, {
      ...(matches ? entry : undefined),
      action: 'ask', question: pending.question, options: pending.options, defaultOption: pending.defaultOption,
      requestId: pending.id, timestamp: pending.createdAt,
      sources: pending.sources, origin: pending.origin,
      brief: pending.brief, reportingSessionId: pending.reportingSessionId,
      reference: pending.origin ? { sessionId: pending.sessionId, physicalId: pending.origin.physicalId, requestId: pending.id } : undefined,
      status: pending.recipient.kind === 'user' ? 'waiting-user' : 'waiting-parent',
    })
  }
  const after: InlineYieldDecisions['after'] = new Map()
  const unlinked: InlineYieldDecisions['unlinked'] = []
  for (const [index, decision] of entries) {
    if (index < messages.length) continue
    const anchor = originIndex(decision.requestId, decision.origin)
    if (anchor === undefined) unlinked.push([index, decision])
    else after.set(anchor, [...(after.get(anchor) ?? []), [index, decision]])
  }
  return { entries, excluded, after, unlinked }
}
