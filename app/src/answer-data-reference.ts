import { decodeAnswerData, type AnswerData } from '../../src/shared/answer-data.ts'
import { createMarkdown } from './markdown.ts'

interface Message {
  role?: string
  event?: string
  toolName?: string
  toolCallId?: string
  content: string
  responseContext?: { turnId: string }
}

/** Resolve only preceding, completed results in the exact response turn. */
export function latestAnswerData(messages: readonly Message[], before: number, turnId: string | undefined): AnswerData | undefined {
  if (!turnId) return
  // One bounded, message-local projection; never look up arbitrary IDs or paths.
  for (let i = before - 1; i >= Math.max(0, before - 256); i--) {
    const message = messages[i]!
    if (message.responseContext && message.responseContext.turnId !== turnId) break
    if (message.role !== 'assistant' || message.event !== 'tool_result' || message.toolName !== 'exec' || !message.toolCallId || message.responseContext?.turnId !== turnId) continue
    const data = decodeAnswerData(message.content)
    if (data) return data
  }
}

const markdown = createMarkdown({ math: false })
const reference = /(?:^|\n)(```answer-data\nlatest\n```)[ \t]*\n?$/

/** A complete, top-level trailing fence, not a quotation or part of another code block. */
export function splitAnswerDataReference(text: string): string | undefined {
  const normalized = text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
  const match = reference.exec(normalized)
  if (!match) return
  const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
  const line = normalized.slice(0, start).split('\n').length - 1
  const last = markdown.parse(normalized, {}).at(-1)
  if (last?.type !== 'fence' || last.level !== 0 || last.info !== 'answer-data' || last.markup !== '```' ||
    last.map?.[0] !== line || last.map?.[1] !== line + 3 || last.content !== 'latest\n') return
  return normalized.slice(0, start).trimEnd()
}
