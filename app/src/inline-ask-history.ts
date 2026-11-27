import { type InlineAskReceipt, type InlineAskRequest, type InlineAskQuestion, parseInlineAskCall, parseInlineAskReceipt } from './inline-ask.ts'
import { pairToolResults, resolveToolCall, type ToolActivityMessage } from './tool-activity.ts'
import type { InputQuestion } from './input-history.ts'

export interface InlineAskRound {
  questions: readonly InlineAskQuestion[]
  requestId?: string
  status: InputQuestion['status']
  receipt?: InlineAskReceipt
  timestamp?: string
}
export interface InlineAskConfirmation { request: InlineAskRequest; receipt: InlineAskReceipt }

export function inlineAskRounds(
  messages: readonly ToolActivityMessage[], pending: InlineAskRequest | null,
  confirmed: InlineAskConfirmation | null = null, physicalIdAt?: (index: number) => string | undefined,
) {
  const entries = new Map<number, InlineAskRound>()
  const excluded = new Set<number>()
  const pairs = new Map<number, number>()
  // Providers' call IDs are not necessarily unique across physical segments.
  for (let start = 0, end = 0; start < messages.length; start = end) {
    const physical = physicalIdAt?.(start)
    for (end = start + 1; end < messages.length && physicalIdAt?.(end) === physical; end++);
    for (const [call, result] of pairToolResults(messages.slice(start, end))) pairs.set(start + call, start + result)
  }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.event !== 'tool_call') continue
    const call = resolveToolCall(message)
    const questions = call.name === 'ask' ? parseInlineAskCall(call.args) : undefined
    if (!questions) continue
    const resultIndex = pairs.get(index)
    const result = resultIndex === undefined ? undefined : messages[resultIndex]
    let receipt: InlineAskReceipt | undefined
    if (result && !result.isError) {
      try { receipt = parseInlineAskReceipt(questions, JSON.parse(result.content.split('\n', 1)[0]!)) }
      catch { /* An unrecognized result cannot confirm an answer. */ }
    }
    const cancelled = /^(?:Error:\s*)?(?:AbortError:|Input cancelled by user\.$|Cancelled(?:\.|$)|Canceled(?:\.|$))/i.test(result?.content.trim() ?? '')
    const failed = result?.isError || /^(?:Error:|ERROR\b|Failed\b)/i.test(result?.content.trimStart() ?? '')
    entries.set(index, { questions, requestId: receipt?.requestId, receipt, timestamp: message.timestamp,
      status: receipt ? 'user' : cancelled ? 'cancelled' : failed ? 'failed' : 'unknown' })
    excluded.add(index)
    if (resultIndex !== undefined) excluded.add(resultIndex)
  }
  const unlinked: InlineAskRound[] = []
  function link(request: InlineAskRequest, receipt?: InlineAskReceipt) {
    if ([...entries.values()].some(entry => entry.receipt?.requestId === request.id)) return
    const match = request.origin.toolCallId && [...entries].reverse().find(([index]) =>
      messages[index]?.toolCallId === request.origin.toolCallId
      && (physicalIdAt?.(index) ?? request.origin.physicalId) === request.origin.physicalId)
    if (match && pairs.has(match[0])) return // Persisted or streamed terminal tool result wins.
    const round: InlineAskRound = {
      questions: request.questions, requestId: request.id, receipt, timestamp: request.createdAt,
      status: receipt ? 'user' : `waiting-${request.recipient.kind}`,
    }
    if (match) entries.set(match[0], { ...round, timestamp: match[1].timestamp ?? round.timestamp })
    else unlinked.push(round)
  }
  if (confirmed) link(confirmed.request, confirmed.receipt)
  if (pending && pending.id !== confirmed?.request.id) link(pending)
  return { entries, excluded, unlinked }
}
