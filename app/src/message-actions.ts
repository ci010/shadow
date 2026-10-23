import { t } from './i18n.ts'
import type { SidebarSession } from './folders-sidebar.ts'
import { pairToolResults, resolveToolCall, type ToolActivityMessage } from './tool-activity.ts'

export interface MessageAction {
  sessionId?: string
  recipient: string
  content: string
  status: 'pending' | 'queued' | 'recorded' | 'failed' | 'unknown'
  arguments: string
  result?: string
  usage?: ToolActivityMessage['usage']
}

export function inlineMessageActions(
  messages: readonly ToolActivityMessage[], sessions: readonly SidebarSession[],
): { entries: Map<number, MessageAction>; excluded: Set<number> } {
  const entries = new Map<number, MessageAction>()
  const excluded = new Set<number>()
  const pairs = pairToolResults(messages)
  const labels = new Map(sessions.map(session => [session.sessionId, session.label]))
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.event !== 'tool_call') continue
    const call = resolveToolCall(message)
    if (call.name !== 'message') continue
    const target = typeof call.args.sessionId === 'string' ? call.args.sessionId.trim() : ''
    const sessionId = /^[^:\s]+:.+/.test(target) ? target : undefined
    const resultIndex = pairs.get(index)
    const result = resultIndex === undefined ? undefined : messages[resultIndex]
    const text = result?.content
    const sent = !!sessionId && text?.startsWith(`Message sent to ${sessionId}.`)
    const recorded = !!sessionId && text?.startsWith(`Message sent to ${sessionId} (silent).`)
    entries.set(index, {
      sessionId,
      recipient: (sessionId && labels.get(sessionId)) || target || t('Unknown recipient'),
      content: typeof call.args.content === 'string' ? call.args.content : '',
      status: text === undefined ? 'pending'
        : /^(?:Error:|ERROR\b|Failed\b)/i.test(text.trimStart()) ? 'failed'
        : recorded ? 'recorded' : sent ? 'queued' : 'unknown',
      arguments: call.raw,
      result: text,
      usage: result?.usage,
    })
    excluded.add(index)
    if (resultIndex !== undefined) excluded.add(resultIndex)
  }
  return { entries, excluded }
}
