import { z } from 'zod'
import { t } from './i18n.ts'
import { inputTextSchema, type InputRequest, type InputAnswer } from '../../src/sessions/input-request.ts'
import { answerMediaSchema } from '../../src/sessions/answer-media.ts'
import { pairToolResults, resolveToolCall, type ToolActivityMessage } from './tool-activity.ts'

const answerSchema = z.object({
  requestId: z.string().min(1), text: inputTextSchema,
  answeredBy: z.enum(['user', 'parent', 'caller']), answeredAt: z.string().datetime(),
  media: answerMediaSchema.optional(),
}).strict()

export interface InputQuestion {
  question: string
  requestId?: string
  status: 'waiting-user' | 'waiting-parent' | 'waiting-caller' | 'user' | 'parent' | 'caller' | 'unknown' | 'failed' | 'cancelled'
  answer?: InputAnswer
  timestamp?: string
  arguments?: string
  result?: string
  workContext?: InputRequest['workContext']
}

export function inputStatusLabel(status: InputQuestion['status']): string {
  return {
    'waiting-user': t('Needs your reply'), 'waiting-parent': t('Waiting for parent'), 'waiting-caller': t('Waiting for caller'),
    user: t('Answered by user'), parent: t('Answered by parent'), caller: t('Answered by caller'),
    unknown: t('No confirmed answer'), failed: t('Question did not complete'), cancelled: t('Question cancelled'),
  }[status]
}

/** Input is information, never a decision/default/approval. Only a live endpoint establishes waiting. */
export function inlineInputQuestions(
  messages: readonly (ToolActivityMessage & { timestamp?: string; isError?: boolean })[],
  pending?: InputRequest | null,
) {
  const entries = new Map<number, InputQuestion>()
  const excluded = new Set<number>()
  const pairs = pairToolResults(messages)
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.event !== 'tool_call') continue
    const call = resolveToolCall(message)
    if (call.name !== 'ask' || call.args.kind !== 'input' || (call.args.action !== undefined && call.args.action !== 'ask')) continue
    const question = inputTextSchema.safeParse(call.args.question)
    if (!question.success) continue // Preserve malformed calls in the tool inspector.
    const resultIndex = pairs.get(index)
    const result = resultIndex === undefined ? undefined : messages[resultIndex]
    let answer: InputAnswer | undefined
    if (result && !result.isError) {
      try {
        const parsed = answerSchema.safeParse(JSON.parse(result.content.split('\n', 1)[0]!))
        if (parsed.success) answer = parsed.data
      } catch { /* Unknown/legacy receipts remain unconfirmed and inspectable. */ }
    }
    const failed = result?.isError || /^(?:Error:|ERROR\b|Failed\b)/i.test(result?.content.trimStart() ?? '')
    const cancelled = /^(?:Error:\s*)?(?:AbortError:|Input cancelled by user\.$|Cancelled(?:\.|$)|Canceled(?:\.|$))/i.test(result?.content.trim() ?? '')
    entries.set(index, {
      question: question.data, requestId: answer?.requestId, answer,
      status: answer?.answeredBy ?? (cancelled ? 'cancelled' : failed ? 'failed' : 'unknown'),
      timestamp: message.timestamp, arguments: call.raw, result: result?.content,
    })
    excluded.add(index)
    if (resultIndex !== undefined) excluded.add(resultIndex)
  }
  let unlinked: InputQuestion | undefined
  if (pending && ![...entries.values()].some(entry => entry.requestId === pending.id && entry.answer)) {
    // An explicit origin must never fall back to matching another question's text.
    const match = pending.origin.toolCallId
      ? [...entries].find(([index]) => messages[index]?.toolCallId === pending.origin.toolCallId)
      : [...entries].findLast(([, entry]) => entry.question === pending.question && entry.result === undefined)
    const live: InputQuestion = {
      question: pending.question, requestId: pending.id, timestamp: pending.createdAt,
      workContext: pending.workContext, status: `waiting-${pending.recipient.kind}`,
    }
    if (match && match[1].result === undefined) entries.set(match[0], { ...match[1], ...live })
    else if (!match) unlinked = live
  }
  return { entries, excluded, unlinked }
}
